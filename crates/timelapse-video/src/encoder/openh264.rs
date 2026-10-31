//! Safe wrapper around Cisco's openh264 encoder (compiled from source by
//! `openh264-sys2`, the sys layer of the `openh264` crate).
//!
//! The high-level `openh264` crate hard-codes single-slice CAVLC encoding;
//! going through the raw API lets us enable CABAC (High profile, ~10% smaller
//! files), multi-slice multithreading, constant-QP "quality" presets and BT.709
//! VUI colour signalling. All `unsafe` is confined to this file.

use std::ffi::CStr;
use std::os::raw::{c_char, c_int, c_void};
use std::ptr;
use std::sync::Mutex;

use openh264_sys2::source::APILoader;
use openh264_sys2::{
    CAMERA_VIDEO_REAL_TIME, CONSTANT_ID, ENCODER_OPTION, ENCODER_OPTION_DATAFORMAT,
    ENCODER_OPTION_TRACE_CALLBACK, ENCODER_OPTION_TRACE_CALLBACK_CONTEXT,
    ENCODER_OPTION_TRACE_LEVEL, HIGH_COMPLEXITY, ISVCEncoder, ISVCEncoderVtbl, PRO_HIGH,
    RC_BITRATE_MODE, RC_OFF_MODE, SEncParamExt, SFrameBSInfo, SM_FIXEDSLCNUM_SLICE,
    SM_SINGLE_SLICE, SSourcePicture, UNSPECIFIED_BIT_RATE, WELS_LOG_ERROR, WelsTraceCallback,
    videoFormatI420, videoFrameTypeSkip,
};

use super::{EncodedSample, EncoderSettings, VideoEncoder};
use crate::error::{Result, VideoError};
use crate::geometry::{MAX_LONG_SIDE, MAX_SHORT_SIDE};
use crate::h264::{AvcParameterSets, annex_b_to_avcc};
use crate::options::Quality;
use crate::yuv420::YuvFrame;

/// Upper bound on encoder threads/slices; more slices cost compression.
const MAX_THREADS: u16 = 8;
/// Each slice should cover at least this many macroblock rows.
const MIN_MB_ROWS_PER_SLICE: u32 = 8;
/// ITU-T H.273 code point for BT.709 primaries/transfer/matrix.
const BT709: u8 = 1;
/// H.264 `video_format` = unspecified.
const VIDEO_FORMAT_UNSPECIFIED: u8 = 5;
/// QP bounds handed to the bitrate rate controller.
const BITRATE_QP_RANGE: (c_int, c_int) = (10, 51);

/// Most recent openh264 error lines kept for error messages.
const TRACE_LINES: usize = 4;

/// Error messages openh264 reports through its trace callback (instead of
/// printing them to stderr), so failures carry a readable reason.
#[derive(Debug, Default)]
struct TraceLog {
    lines: Mutex<Vec<String>>,
}

impl TraceLog {
    fn last(&self) -> Option<String> {
        self.lines
            .lock()
            .ok()
            .and_then(|lines| lines.last().cloned())
    }
}

/// Receives openh264 log lines (error level only).
unsafe extern "C" fn trace_callback(ctx: *mut c_void, _level: c_int, message: *const c_char) {
    if ctx.is_null() || message.is_null() {
        return;
    }
    // SAFETY: `ctx` is the `TraceLog` registered in `OpenH264Encoder::new`,
    // which outlives the encoder handle that calls us.
    let log = unsafe { &*ctx.cast::<TraceLog>() };
    // SAFETY: openh264 passes a NUL-terminated buffer valid for this call.
    let text = unsafe { CStr::from_ptr(message) }.to_string_lossy();
    // Drop the "[OpenH264] this = 0x..., Error:" prefix.
    let text = text
        .split_once("Error:")
        .map_or(&*text, |(_, rest)| rest)
        .trim();
    if let Ok(mut lines) = log.lines.lock() {
        if lines.len() == TRACE_LINES {
            lines.remove(0);
        }
        lines.push(text.to_owned());
    }
}

/// openh264 encoder instance.
pub struct OpenH264Encoder {
    handle: *mut ISVCEncoder,
    vtbl: ISVCEncoderVtbl,
    initialized: bool,
    info: Box<SFrameBSInfo>,
    settings: EncoderSettings,
    frame_index: u64,
    parameter_sets: Option<AvcParameterSets>,
    annex_b: Vec<u8>,
    /// Must outlive `handle` (dropped after it, see `Drop`).
    trace: Box<TraceLog>,
}

// SAFETY: the encoder handle is only ever used through `&mut self`, so it is
// never accessed from two threads at once; openh264 has no thread affinity.
unsafe impl Send for OpenH264Encoder {}

fn missing_vtable() -> VideoError {
    VideoError::Encoder("openh264 vtable is incomplete".into())
}

fn check(rc: c_int, what: &str, trace: &TraceLog) -> Result<()> {
    if rc == 0 {
        return Ok(());
    }
    let reason = trace.last().map(|r| format!(": {r}")).unwrap_or_default();
    Err(VideoError::Encoder(format!(
        "{what} failed (openh264 code {rc}){reason}"
    )))
}

/// Picks the slice/thread count: one slice per thread, capped so every slice
/// keeps enough macroblock rows to stay efficient.
fn auto_threads(height: u32, requested: u16) -> u16 {
    let cores = std::thread::available_parallelism().map_or(1, |n| n.get());
    let wanted = if requested == 0 {
        u16::try_from(cores).unwrap_or(MAX_THREADS)
    } else {
        requested
    };
    let mb_rows = height.div_ceil(16);
    let by_rows = u16::try_from((mb_rows / MIN_MB_ROWS_PER_SLICE).max(1)).unwrap_or(1);
    wanted.clamp(1, MAX_THREADS).min(by_rows)
}

fn validate(settings: &EncoderSettings) -> Result<()> {
    let (w, h) = (settings.width, settings.height);
    if w == 0 || h == 0 || w % 2 != 0 || h % 2 != 0 {
        return Err(VideoError::Encoder(format!(
            "frame size must be even and non-zero, got {w}x{h}"
        )));
    }
    if w.max(h) > MAX_LONG_SIDE || w.min(h) > MAX_SHORT_SIDE {
        return Err(VideoError::Encoder(format!(
            "{w}x{h} exceeds the H.264 encoder limit of {MAX_LONG_SIDE}x{MAX_SHORT_SIDE}"
        )));
    }
    if !(settings.fps.is_finite() && settings.fps > 0.0) {
        return Err(VideoError::Encoder(format!(
            "invalid frame rate {}",
            settings.fps
        )));
    }
    Ok(())
}

impl OpenH264Encoder {
    /// Creates and initialises an encoder.
    ///
    /// # Errors
    /// [`VideoError::Encoder`] if the settings are out of range or openh264
    /// rejects them.
    pub fn new(settings: &EncoderSettings) -> Result<Self> {
        validate(settings)?;
        let mut handle: *mut ISVCEncoder = ptr::null_mut();
        // SAFETY: WelsCreateSVCEncoder writes a valid encoder pointer (or
        // leaves it null) into `handle`, which outlives the call.
        let rc = unsafe { APILoader::WelsCreateSVCEncoder(&raw mut handle) };
        check(rc, "creating the encoder", &TraceLog::default())?;
        if handle.is_null() {
            return Err(VideoError::Encoder(
                "openh264 returned a null encoder".into(),
            ));
        }
        // SAFETY: `handle` is non-null and points at an encoder object whose
        // first field is its vtable pointer, valid until WelsDestroySVCEncoder.
        let vtbl = unsafe { **handle };
        let mut encoder = Self {
            handle,
            vtbl,
            initialized: false,
            info: Box::default(),
            settings: *settings,
            frame_index: 0,
            parameter_sets: None,
            annex_b: Vec::new(),
            trace: Box::default(),
        };
        encoder.initialize()?;
        Ok(encoder)
    }

    fn fill_params(&self, params: &mut SEncParamExt) {
        let s = &self.settings;
        let threads = auto_threads(s.height, s.threads);
        // Encoder limits and frame rates are validated, so these casts are lossless.
        // NON_REAL_TIME is rejected by openh264 2.x; REAL_TIME + HIGH_COMPLEXITY
        // is its highest-quality camera mode.
        params.iUsageType = CAMERA_VIDEO_REAL_TIME;
        params.iPicWidth = s.width as c_int;
        params.iPicHeight = s.height as c_int;
        params.fMaxFrameRate = s.fps as f32;
        params.iTemporalLayerNum = 1;
        params.iSpatialLayerNum = 1;
        params.iComplexityMode = HIGH_COMPLEXITY;
        params.uiIntraPeriod = s.keyframe_interval;
        params.eSpsPpsIdStrategy = CONSTANT_ID;
        params.iEntropyCodingModeFlag = 1; // CABAC
        params.bEnableFrameSkip = false;
        params.bEnableDenoise = false;
        params.bEnableSceneChangeDetect = false;
        params.bEnableBackgroundDetection = true;
        params.bEnableAdaptiveQuant = true;
        params.bEnableLongTermReference = false;
        params.bPrefixNalAddingCtrl = false;
        params.iLoopFilterDisableIdc = 0;
        params.iMultipleThreadIdc = threads;

        let layer = &mut params.sSpatialLayers[0];
        layer.iVideoWidth = s.width as c_int;
        layer.iVideoHeight = s.height as c_int;
        layer.fFrameRate = s.fps as f32;
        layer.uiProfileIdc = PRO_HIGH;
        layer.sSliceArgument.uiSliceMode = if threads > 1 {
            SM_FIXEDSLCNUM_SLICE
        } else {
            SM_SINGLE_SLICE
        };
        layer.sSliceArgument.uiSliceNum = u32::from(threads);
        layer.bVideoSignalTypePresent = true;
        layer.uiVideoFormat = VIDEO_FORMAT_UNSPECIFIED;
        layer.bFullRange = false;
        layer.bColorDescriptionPresent = true;
        layer.uiColorPrimaries = BT709;
        layer.uiTransferCharacteristics = BT709;
        layer.uiColorMatrix = BT709;

        match s.quality.qp() {
            Some(qp) => {
                params.iRCMode = RC_OFF_MODE;
                params.sSpatialLayers[0].iDLayerQp = c_int::from(qp);
            }
            None => {
                let kbps = match s.quality {
                    Quality::Bitrate { kbps } => kbps,
                    _ => 0,
                };
                let bps = c_int::try_from(u64::from(kbps) * 1000).unwrap_or(c_int::MAX);
                params.iRCMode = RC_BITRATE_MODE;
                params.iTargetBitrate = bps;
                params.iMaxBitrate = UNSPECIFIED_BIT_RATE as c_int;
                params.iMinQp = BITRATE_QP_RANGE.0;
                params.iMaxQp = BITRATE_QP_RANGE.1;
                params.sSpatialLayers[0].iSpatialBitrate = bps;
                params.sSpatialLayers[0].iMaxSpatialBitrate = UNSPECIFIED_BIT_RATE as c_int;
            }
        }
    }

    fn set_int_option(&self, option: ENCODER_OPTION, value: c_int, what: &str) -> Result<()> {
        let set_option = self.vtbl.SetOption.ok_or_else(missing_vtable)?;
        let mut value = value;
        // SAFETY: integer options take a pointer to an int valid during the call.
        let rc = unsafe { set_option(self.handle, option, (&raw mut value).cast::<c_void>()) };
        check(rc, what, &self.trace)
    }

    fn install_trace(&self) -> Result<()> {
        let set_option = self.vtbl.SetOption.ok_or_else(missing_vtable)?;
        let mut callback: WelsTraceCallback = Some(trace_callback);
        let mut context: *mut c_void = ptr::from_ref::<TraceLog>(&self.trace).cast_mut().cast();
        // SAFETY: the callback option takes a pointer to a function pointer and
        // the context option a pointer to a `void*`; both are read during the
        // call. The context (a boxed `TraceLog`) outlives the encoder.
        let rc = unsafe {
            set_option(
                self.handle,
                ENCODER_OPTION_TRACE_CALLBACK,
                (&raw mut callback).cast::<c_void>(),
            )
        };
        check(rc, "installing the log callback", &self.trace)?;
        // SAFETY: as above.
        let rc = unsafe {
            set_option(
                self.handle,
                ENCODER_OPTION_TRACE_CALLBACK_CONTEXT,
                (&raw mut context).cast::<c_void>(),
            )
        };
        check(rc, "installing the log callback", &self.trace)?;
        self.set_int_option(
            ENCODER_OPTION_TRACE_LEVEL,
            WELS_LOG_ERROR as c_int,
            "setting the log level",
        )
    }

    fn initialize(&mut self) -> Result<()> {
        self.install_trace()?;
        let get_defaults = self.vtbl.GetDefaultParams.ok_or_else(missing_vtable)?;
        let init = self.vtbl.InitializeExt.ok_or_else(missing_vtable)?;
        let mut params = SEncParamExt::default();
        // SAFETY: `handle` is a live encoder; `params` is a valid, writable struct.
        let rc = unsafe { get_defaults(self.handle, &raw mut params) };
        check(rc, "reading defaults", &self.trace)?;
        self.fill_params(&mut params);
        // SAFETY: `params` is fully initialised and only read during the call.
        let rc = unsafe { init(self.handle, &raw const params) };
        check(rc, "initialising the encoder", &self.trace)?;
        self.initialized = true;
        self.set_int_option(
            ENCODER_OPTION_DATAFORMAT,
            videoFormatI420 as c_int,
            "selecting I420 input",
        )
    }

    /// Effective number of encoder threads (and slices) used.
    #[must_use]
    pub fn threads(&self) -> u16 {
        auto_threads(self.settings.height, self.settings.threads)
    }

    /// Copies the NAL units of the last encoded frame into `self.annex_b`.
    fn collect_bitstream(&mut self) -> Result<()> {
        self.annex_b.clear();
        let layers = usize::try_from(self.info.iLayerNum).unwrap_or(0);
        for layer in self.info.sLayerInfo.iter().take(layers) {
            let nal_count = usize::try_from(layer.iNalCount).unwrap_or(0);
            if nal_count == 0 || layer.pNalLengthInByte.is_null() || layer.pBsBuf.is_null() {
                continue;
            }
            // SAFETY: openh264 guarantees `pNalLengthInByte` has `iNalCount`
            // entries for this layer until the next EncodeFrame call.
            let lengths = unsafe { std::slice::from_raw_parts(layer.pNalLengthInByte, nal_count) };
            let total = lengths.iter().try_fold(0usize, |acc, &len| {
                usize::try_from(len)
                    .ok()
                    .and_then(|len| acc.checked_add(len))
            });
            let total = total.ok_or_else(|| VideoError::Encoder("bad NAL length".into()))?;
            // SAFETY: the layer's NAL units are stored back to back in
            // `pBsBuf`, `total` bytes long, valid until the next EncodeFrame.
            let bytes = unsafe { std::slice::from_raw_parts(layer.pBsBuf, total) };
            self.annex_b.extend_from_slice(bytes);
        }
        Ok(())
    }

    fn timestamp_ms(&self) -> i64 {
        let ms = self.frame_index as f64 * 1000.0 / self.settings.fps;
        ms.round() as i64
    }
}

impl VideoEncoder for OpenH264Encoder {
    fn name(&self) -> &'static str {
        "openh264"
    }

    fn encode(&mut self, frame: &YuvFrame, out: &mut Vec<EncodedSample>) -> Result<()> {
        if (frame.width(), frame.height()) != (self.settings.width, self.settings.height) {
            return Err(VideoError::Encoder(format!(
                "frame is {}x{}, encoder expects {}x{}",
                frame.width(),
                frame.height(),
                self.settings.width,
                self.settings.height
            )));
        }
        let encode = self.vtbl.EncodeFrame.ok_or_else(missing_vtable)?;
        let luma_stride = self.settings.width as c_int;
        let picture = SSourcePicture {
            iColorFormat: videoFormatI420 as c_int,
            iStride: [luma_stride, luma_stride / 2, luma_stride / 2, 0],
            // openh264 only reads the input planes despite the `*mut` type.
            pData: [
                frame.y().as_ptr().cast_mut(),
                frame.u().as_ptr().cast_mut(),
                frame.v().as_ptr().cast_mut(),
                ptr::null_mut(),
            ],
            iPicWidth: self.settings.width as c_int,
            iPicHeight: self.settings.height as c_int,
            uiTimeStamp: self.timestamp_ms(),
            bPsnrY: false,
            bPsnrU: false,
            bPsnrV: false,
        };
        // SAFETY: `picture` points at planes of the size declared above that
        // stay alive for the call; `info` is a valid output struct.
        let rc = unsafe { encode(self.handle, &raw const picture, &raw mut *self.info) };
        check(rc, "encoding a frame", &self.trace)?;
        self.frame_index += 1;
        if self.info.eFrameType == videoFrameTypeSkip {
            return Err(VideoError::Encoder(
                "the encoder unexpectedly skipped a frame".into(),
            ));
        }
        self.collect_bitstream()?;
        let unit = annex_b_to_avcc(&self.annex_b)?;
        if let Some(sets) = unit.parameter_sets {
            match &self.parameter_sets {
                Some(existing) if *existing != sets => {
                    return Err(VideoError::Encoder("SPS/PPS changed mid-stream".into()));
                }
                Some(_) => {}
                None => self.parameter_sets = Some(sets),
            }
        }
        out.push(EncodedSample {
            data: unit.data,
            keyframe: unit.is_idr,
        });
        Ok(())
    }

    fn finish(&mut self, _out: &mut Vec<EncodedSample>) -> Result<()> {
        // openh264 has no lookahead/B-frames: every frame is emitted immediately.
        Ok(())
    }

    fn parameter_sets(&self) -> Option<&AvcParameterSets> {
        self.parameter_sets.as_ref()
    }
}

impl Drop for OpenH264Encoder {
    fn drop(&mut self) {
        if self.initialized
            && let Some(uninit) = self.vtbl.Uninitialize
        {
            // SAFETY: the encoder was successfully initialised and is not used afterwards.
            unsafe { uninit(self.handle) };
        }
        // SAFETY: `handle` came from WelsCreateSVCEncoder and is destroyed exactly once.
        unsafe { APILoader::WelsDestroySVCEncoder(self.handle) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::h264::{NAL_IDR, nal_type};

    fn gradient(w: u32, h: u32, shift: u32) -> YuvFrame {
        let mut rgb = Vec::with_capacity((w * h * 3) as usize);
        for y in 0..h {
            for x in 0..w {
                rgb.extend_from_slice(&[
                    ((x + shift) * 255 / w) as u8,
                    (y * 255 / h) as u8,
                    ((x + y + shift) % 256) as u8,
                ]);
            }
        }
        YuvFrame::from_rgb(&rgb, w, h).unwrap()
    }

    fn first_nal_types(sample: &[u8]) -> Vec<u8> {
        let mut types = Vec::new();
        let mut i = 0;
        while i + 4 <= sample.len() {
            let len = u32::from_be_bytes(sample[i..i + 4].try_into().unwrap()) as usize;
            types.push(nal_type(&sample[i + 4..]));
            i += 4 + len;
        }
        assert_eq!(i, sample.len(), "length prefixes must tile the sample");
        types
    }

    #[test]
    fn encodes_idr_then_p_frames_with_high_profile_sps() {
        let settings = EncoderSettings {
            keyframe_interval: 4,
            ..EncoderSettings::new(320, 240, 30.0, Quality::High)
        };
        let mut enc = OpenH264Encoder::new(&settings).unwrap();
        let mut out = Vec::new();
        for i in 0..6 {
            enc.encode(&gradient(320, 240, i * 4), &mut out).unwrap();
        }
        enc.finish(&mut out).unwrap();
        assert_eq!(out.len(), 6);
        let keys: Vec<bool> = out.iter().map(|s| s.keyframe).collect();
        assert_eq!(keys, [true, false, false, false, true, false]);
        assert!(first_nal_types(&out[0].data).contains(&NAL_IDR));
        let sets = enc.parameter_sets().unwrap();
        assert_eq!(sets.profile_idc(), 100, "CABAC requires High profile");
        assert!(sets.level_idc() > 0);
    }

    #[test]
    fn bitrate_mode_and_multithreading_work() {
        let settings = EncoderSettings {
            threads: 4,
            ..EncoderSettings::new(640, 480, 25.0, Quality::Bitrate { kbps: 2000 })
        };
        let mut enc = OpenH264Encoder::new(&settings).unwrap();
        assert_eq!(enc.threads(), 3, "480 px = 30 MB rows -> at most 3 slices");
        let mut out = Vec::new();
        for i in 0..3 {
            enc.encode(&gradient(640, 480, i), &mut out).unwrap();
        }
        assert_eq!(out.len(), 3);
        assert!(out[0].keyframe);
    }

    #[test]
    fn rejects_bad_settings_and_mismatched_frames() {
        let bad = [
            EncoderSettings::new(0, 240, 30.0, Quality::High),
            EncoderSettings::new(321, 240, 30.0, Quality::High),
            EncoderSettings::new(4096, 2160, 30.0, Quality::High),
            EncoderSettings::new(2400, 2400, 30.0, Quality::High),
            EncoderSettings::new(320, 240, f64::NAN, Quality::High),
        ];
        for s in bad {
            assert!(OpenH264Encoder::new(&s).is_err(), "{s:?}");
        }
        let mut enc =
            OpenH264Encoder::new(&EncoderSettings::new(320, 240, 30.0, Quality::Low)).unwrap();
        let mut out = Vec::new();
        assert!(enc.encode(&gradient(160, 120, 0), &mut out).is_err());
    }

    #[test]
    fn trace_log_keeps_the_latest_error_lines() {
        let log = TraceLog::default();
        assert_eq!(log.last(), None);
        for i in 0..6 {
            let line =
                std::ffi::CString::new(format!("[OpenH264] this = 0x1, Error:bad {i}")).unwrap();
            // SAFETY: valid context and NUL-terminated message for the call.
            unsafe {
                trace_callback(ptr::from_ref(&log).cast_mut().cast(), 1, line.as_ptr());
                trace_callback(ptr::null_mut(), 1, line.as_ptr());
            }
        }
        assert_eq!(log.last().as_deref(), Some("bad 5"));
        assert_eq!(log.lines.lock().unwrap().len(), TRACE_LINES);
        let err = check(3, "doing a thing", &log).unwrap_err().to_string();
        assert!(
            err.ends_with("doing a thing failed (openh264 code 3): bad 5"),
            "{err}"
        );
        assert!(check(0, "fine", &log).is_ok());
    }

    #[test]
    fn auto_threads_respects_rows_and_caps() {
        assert_eq!(auto_threads(240, 16), 1);
        assert_eq!(auto_threads(2160, 16), MAX_THREADS);
        assert_eq!(auto_threads(1080, 2), 2);
        assert!(auto_threads(1080, 0) >= 1);
    }
}
