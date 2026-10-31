//! Hardware H.264 encoder using Apple VideoToolbox (macOS). It is the
//! default on macOS via [`super::AutoEncoder`], which falls back to openh264.
//!
//! Frames are copied from I420 into NV12 pixel buffers from the session's
//! pool, encoded asynchronously, and collected from the output callback.
//! Frame reordering (B-frames) is disabled so samples arrive in presentation
//! order, matching what the MP4 writer expects. On an M3 Max it is 2-2.6x
//! faster than openh264 with x264-like efficiency. Virtualised CI runners may
//! lack the media engine; then session creation fails and `Auto` falls back.

use std::ffi::c_void;
use std::ptr::{self, NonNull};
use std::sync::Mutex;

use objc2_core_foundation::{CFBoolean, CFDictionary, CFNumber, CFRetained, CFString, CFType};
use objc2_core_media::{
    CMFormatDescription, CMSampleBuffer, CMTime,
    CMVideoFormatDescriptionGetH264ParameterSetAtIndex, kCMSampleAttachmentKey_NotSync,
    kCMTimeInvalid, kCMVideoCodecType_H264,
};
use objc2_core_video::{
    CVPixelBuffer, CVPixelBufferGetBaseAddressOfPlane, CVPixelBufferGetBytesPerRowOfPlane,
    CVPixelBufferLockBaseAddress, CVPixelBufferLockFlags, CVPixelBufferPool,
    CVPixelBufferUnlockBaseAddress, kCVImageBufferColorPrimaries_ITU_R_709_2,
    kCVImageBufferTransferFunction_ITU_R_709_2, kCVImageBufferYCbCrMatrix_ITU_R_709_2,
    kCVPixelBufferHeightKey, kCVPixelBufferIOSurfacePropertiesKey,
    kCVPixelBufferPixelFormatTypeKey, kCVPixelBufferWidthKey,
    kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
};
use objc2_video_toolbox::{
    VTCompressionSession, VTEncodeInfoFlags, VTSessionSetProperty,
    kVTCompressionPropertyKey_AllowFrameReordering, kVTCompressionPropertyKey_AverageBitRate,
    kVTCompressionPropertyKey_ColorPrimaries, kVTCompressionPropertyKey_ExpectedFrameRate,
    kVTCompressionPropertyKey_MaxKeyFrameInterval, kVTCompressionPropertyKey_ProfileLevel,
    kVTCompressionPropertyKey_Quality, kVTCompressionPropertyKey_RealTime,
    kVTCompressionPropertyKey_TransferFunction, kVTCompressionPropertyKey_YCbCrMatrix,
    kVTProfileLevel_H264_High_AutoLevel,
    kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder,
};

use super::{EncodedSample, EncoderSettings, VideoEncoder};
use crate::error::{Result, VideoError};
use crate::h264::AvcParameterSets;
use crate::options::Quality;
use crate::timing::FrameRate;
use crate::yuv420::YuvFrame;

/// NAL length prefix size we require from VideoToolbox (matches our avcC).
const NAL_LENGTH_SIZE: i32 = 4;

/// VideoToolbox quality (0..1) for each preset, calibrated on two sets of 150
/// real photos at 1440x1080 so each preset lands within ~0.3 dB luma PSNR of
/// the openh264 QP preset (at 4-14 % smaller files; see README).
fn vt_quality(quality: Quality) -> Option<f32> {
    match quality {
        Quality::Low => Some(0.57),
        Quality::Medium => Some(0.67),
        Quality::High => Some(0.76),
        Quality::Max => Some(0.82),
        Quality::Bitrate { .. } => None,
    }
}

/// One finished frame from the output callback.
#[derive(Debug)]
struct Output {
    data: Vec<u8>,
    keyframe: bool,
    parameter_sets: Option<AvcParameterSets>,
}

/// State shared with the output callback (address stays fixed: boxed).
#[derive(Default)]
struct Shared {
    outputs: Mutex<Vec<std::result::Result<Output, String>>>,
}

/// Hardware H.264 encoder.
pub struct VideoToolboxEncoder {
    session: CFRetained<VTCompressionSession>,
    pool: CFRetained<CVPixelBufferPool>,
    shared: Box<Shared>,
    settings: EncoderSettings,
    rate: FrameRate,
    frame_index: i64,
    parameter_sets: Option<AvcParameterSets>,
}

// SAFETY: the session and pool are only used through `&mut self` (never
// concurrently); VideoToolbox objects are not tied to the creating thread.
unsafe impl Send for VideoToolboxEncoder {}

fn os_check(status: i32, what: &str) -> Result<()> {
    if status == 0 {
        Ok(())
    } else {
        Err(VideoError::Encoder(format!(
            "VideoToolbox: {what} failed (OSStatus {status})"
        )))
    }
}

fn number_i32(v: i32) -> CFRetained<CFNumber> {
    CFNumber::new_i32(v)
}

/// Copies the encoded bytes, sync flag and (for keyframes) SPS/PPS.
fn extract(sample: &CMSampleBuffer) -> std::result::Result<Output, String> {
    // SAFETY: `sample` is a valid sample buffer for the duration of the callback.
    let block = unsafe { sample.data_buffer() }.ok_or("sample has no data")?;
    // SAFETY: as above.
    let len = unsafe { block.data_length() };
    let mut data = vec![0u8; len];
    let dest = NonNull::new(data.as_mut_ptr().cast::<c_void>()).ok_or("empty sample")?;
    // SAFETY: `dest` points at `len` writable bytes.
    let status = unsafe { block.copy_data_bytes(0, len, dest) };
    if status != 0 || len == 0 {
        return Err(format!("could not read sample data (OSStatus {status})"));
    }
    // SAFETY: reading an immutable CFString constant exported by CoreMedia.
    let not_sync = unsafe { kCMSampleAttachmentKey_NotSync };
    // SAFETY: valid sample buffer; the array is retained by CFRetained.
    let keyframe = match unsafe { sample.sample_attachments_array(false) } {
        Some(array) if array.count() > 0 => {
            // SAFETY: index 0 exists; entries are CFDictionary attachments.
            let dict = unsafe { array.value_at_index(0) }.cast::<CFDictionary>();
            // SAFETY: `dict` is a valid dictionary owned by `array`; key is a CFString.
            !dict.is_null()
                && !unsafe { (*dict).contains_ptr_key(ptr::from_ref::<CFString>(not_sync).cast()) }
        }
        _ => true,
    };
    let parameter_sets = if keyframe {
        // SAFETY: valid sample buffer.
        let format = unsafe { sample.format_description() }.ok_or("missing format")?;
        Some(parameter_sets(&format)?)
    } else {
        None
    };
    Ok(Output {
        data,
        keyframe,
        parameter_sets,
    })
}

fn parameter_set(
    format: &CMFormatDescription,
    index: usize,
) -> std::result::Result<Vec<u8>, String> {
    let (mut ptr, mut size, mut count, mut nal_len) = (ptr::null::<u8>(), 0usize, 0usize, 0i32);
    // SAFETY: all out-pointers are valid; the returned bytes live as long as `format`.
    let status = unsafe {
        CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
            format,
            index,
            &raw mut ptr,
            &raw mut size,
            &raw mut count,
            &raw mut nal_len,
        )
    };
    if status != 0 || ptr.is_null() || size == 0 {
        return Err(format!(
            "no H.264 parameter set {index} (OSStatus {status})"
        ));
    }
    if nal_len != NAL_LENGTH_SIZE {
        return Err(format!("unsupported NAL length size {nal_len}"));
    }
    // SAFETY: `ptr` points at `size` bytes inside `format`, which we hold.
    Ok(unsafe { std::slice::from_raw_parts(ptr, size) }.to_vec())
}

fn parameter_sets(format: &CMFormatDescription) -> std::result::Result<AvcParameterSets, String> {
    Ok(AvcParameterSets {
        sps: parameter_set(format, 0)?,
        pps: parameter_set(format, 1)?,
    })
}

/// Runs a callback body and records its result; a panic is caught and
/// recorded as an error (the encoder then fails cleanly at the next drain)
/// instead of unwinding into VideoToolbox's thread.
fn record_guarded(shared: &Shared, body: impl FnOnce() -> std::result::Result<Output, String>) {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(body))
        .unwrap_or_else(|_| Err("the encoder output handler panicked".to_owned()));
    // A poisoned lock is impossible (nothing panics while holding it); if it
    // ever were, the drain side reports the encoder as failed.
    if let Ok(mut outputs) = shared.outputs.lock() {
        outputs.push(result);
    }
}

/// VideoToolbox output callback; runs on an internal VideoToolbox thread.
///
/// The ABI is `"C-unwind"` because that is the callback type the
/// `objc2-video-toolbox` binding declares; no panic ever reaches it — the
/// whole body runs inside [`record_guarded`]'s `catch_unwind`.
unsafe extern "C-unwind" fn output_callback(
    refcon: *mut c_void,
    _frame_refcon: *mut c_void,
    status: i32,
    _flags: VTEncodeInfoFlags,
    sample: *mut CMSampleBuffer,
) {
    if refcon.is_null() {
        return;
    }
    // SAFETY: `refcon` is the boxed `Shared` registered at session creation;
    // it outlives the session (dropped only after invalidation).
    let shared = unsafe { &*refcon.cast::<Shared>() };
    record_guarded(shared, || {
        if status != 0 {
            Err(format!("encoding failed (OSStatus {status})"))
        } else if sample.is_null() {
            Err("the hardware encoder dropped a frame".to_owned())
        } else {
            // SAFETY: non-null sample buffer valid for this callback.
            extract(unsafe { &*sample })
        }
    });
}

fn set_property(session: &VTCompressionSession, key: &CFString, value: &CFType) -> Result<()> {
    // SAFETY: valid session, key and value of the type the key expects.
    let status = unsafe { VTSessionSetProperty(session, key, Some(value)) };
    os_check(status, "setting a session property")
}

impl VideoToolboxEncoder {
    /// Creates a hardware-preferred H.264 session.
    ///
    /// # Errors
    /// [`VideoError::Encoder`] if VideoToolbox is unavailable or rejects the settings.
    pub fn new(settings: &EncoderSettings) -> Result<Self> {
        let rate = FrameRate::from_fps(settings.fps)
            .ok_or_else(|| VideoError::Encoder(format!("invalid frame rate {}", settings.fps)))?;
        let (w, h) = (settings.width, settings.height);
        let to_i32 = |v: u32| i32::try_from(v).map_err(|_| VideoError::Encoder("size".into()));
        // SAFETY: reading immutable CFString constants exported by the frameworks.
        let (hw_key, format_key, width_key, height_key, surface_key) = unsafe {
            (
                kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder,
                kCVPixelBufferPixelFormatTypeKey,
                kCVPixelBufferWidthKey,
                kCVPixelBufferHeightKey,
                kCVPixelBufferIOSurfacePropertiesKey,
            )
        };
        let spec =
            CFDictionary::<CFString, CFType>::from_slices(&[hw_key], &[CFBoolean::new(true)]);
        let (fmt, width, height) = (
            number_i32(kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange as i32),
            number_i32(to_i32(w)?),
            number_i32(to_i32(h)?),
        );
        let surface = CFDictionary::<CFString, CFType>::empty();
        let attrs = CFDictionary::<CFString, CFType>::from_slices(
            &[format_key, width_key, height_key, surface_key],
            &[&fmt, &width, &height, &surface],
        );
        let shared = Box::<Shared>::default();
        let mut raw: *mut VTCompressionSession = ptr::null_mut();
        // SAFETY: all dictionaries are valid; `shared` outlives the session;
        // `raw` receives a +1 reference on success.
        let status = unsafe {
            VTCompressionSession::create(
                None,
                to_i32(w)?,
                to_i32(h)?,
                kCMVideoCodecType_H264,
                Some(spec.as_opaque()),
                Some(attrs.as_opaque()),
                None,
                Some(output_callback),
                ptr::from_ref::<Shared>(&shared).cast_mut().cast(),
                NonNull::from(&mut raw),
            )
        };
        os_check(status, "creating the compression session")?;
        let raw = NonNull::new(raw)
            .ok_or_else(|| VideoError::Encoder("VideoToolbox returned no session".into()))?;
        // SAFETY: `raw` is a newly created (+1) session we now own.
        let session = unsafe { CFRetained::from_raw(raw) };
        Self::configure(&session, settings)?;
        // SAFETY: `session` is a valid, configured compression session.
        let status = unsafe { session.prepare_to_encode_frames() };
        os_check(status, "preparing the encoder")?;
        // SAFETY: valid session created with source buffer attributes.
        let pool = unsafe { session.pixel_buffer_pool() }
            .ok_or_else(|| VideoError::Encoder("VideoToolbox has no pixel buffer pool".into()))?;
        Ok(Self {
            session,
            pool,
            shared,
            settings: *settings,
            rate,
            frame_index: 0,
            parameter_sets: None,
        })
    }

    fn configure(session: &VTCompressionSession, s: &EncoderSettings) -> Result<()> {
        // SAFETY: reading immutable CFString constants exported by the frameworks.
        let (keys, profile, primaries, transfer, matrix, quality_key, bitrate_key) = unsafe {
            (
                [
                    kVTCompressionPropertyKey_RealTime,
                    kVTCompressionPropertyKey_AllowFrameReordering,
                    kVTCompressionPropertyKey_ProfileLevel,
                    kVTCompressionPropertyKey_MaxKeyFrameInterval,
                    kVTCompressionPropertyKey_ExpectedFrameRate,
                    kVTCompressionPropertyKey_ColorPrimaries,
                    kVTCompressionPropertyKey_TransferFunction,
                    kVTCompressionPropertyKey_YCbCrMatrix,
                ],
                kVTProfileLevel_H264_High_AutoLevel,
                kCVImageBufferColorPrimaries_ITU_R_709_2,
                kCVImageBufferTransferFunction_ITU_R_709_2,
                kCVImageBufferYCbCrMatrix_ITU_R_709_2,
                kVTCompressionPropertyKey_Quality,
                kVTCompressionPropertyKey_AverageBitRate,
            )
        };
        let no = CFBoolean::new(false);
        let interval = number_i32(i32::try_from(s.keyframe_interval).unwrap_or(i32::MAX));
        let rate = CFNumber::new_f64(s.fps);
        // No B-frames: samples must arrive in presentation order.
        let values: [&CFType; 8] = [
            no, no, profile, &interval, &rate, primaries, transfer, matrix,
        ];
        for (key, value) in keys.iter().zip(values) {
            set_property(session, key, value)?;
        }
        let (key, value) = match (vt_quality(s.quality), s.quality) {
            (Some(q), _) => (quality_key, CFNumber::new_f32(q)),
            (None, Quality::Bitrate { kbps }) => (
                bitrate_key,
                number_i32(i32::try_from(u64::from(kbps) * 1000).unwrap_or(i32::MAX)),
            ),
            (None, _) => return Ok(()),
        };
        set_property(session, key, &value)
    }

    /// Fills a pooled NV12 pixel buffer with `frame`.
    fn pixel_buffer(&self, frame: &YuvFrame) -> Result<CFRetained<CVPixelBuffer>> {
        let mut raw: *mut CVPixelBuffer = ptr::null_mut();
        // SAFETY: valid pool; `raw` receives a +1 reference on success.
        let status = unsafe {
            CVPixelBufferPool::create_pixel_buffer(None, &self.pool, NonNull::from(&mut raw))
        };
        os_check(status, "allocating a pixel buffer")?;
        let raw = NonNull::new(raw)
            .ok_or_else(|| VideoError::Encoder("VideoToolbox returned no pixel buffer".into()))?;
        // SAFETY: newly created (+1) pixel buffer we now own.
        let buffer = unsafe { CFRetained::from_raw(raw) };
        // SAFETY: valid buffer; unlocked again below.
        let status = unsafe { CVPixelBufferLockBaseAddress(&buffer, CVPixelBufferLockFlags(0)) };
        os_check(status, "locking a pixel buffer")?;
        let (w, h) = (frame.width() as usize, frame.height() as usize);
        let luma = CVPixelBufferGetBaseAddressOfPlane(&buffer, 0).cast::<u8>();
        let chroma = CVPixelBufferGetBaseAddressOfPlane(&buffer, 1).cast::<u8>();
        let (luma_stride, chroma_stride) = (
            CVPixelBufferGetBytesPerRowOfPlane(&buffer, 0),
            CVPixelBufferGetBytesPerRowOfPlane(&buffer, 1),
        );
        if !luma.is_null() && !chroma.is_null() && luma_stride >= w && chroma_stride >= w {
            for (y, row) in frame.y().chunks_exact(w).enumerate() {
                // SAFETY: plane 0 has `h` rows of `luma_stride >= w` bytes.
                let dst = unsafe { std::slice::from_raw_parts_mut(luma.add(y * luma_stride), w) };
                dst.copy_from_slice(row);
            }
            let cw = w / 2;
            for (y, (u, v)) in frame
                .u()
                .chunks_exact(cw)
                .zip(frame.v().chunks_exact(cw))
                .enumerate()
            {
                // SAFETY: plane 1 has `h / 2` rows of `chroma_stride >= w` bytes.
                let dst =
                    unsafe { std::slice::from_raw_parts_mut(chroma.add(y * chroma_stride), w) };
                for ((pair, &cb), &cr) in dst.as_chunks_mut::<2>().0.iter_mut().zip(u).zip(v) {
                    pair[0] = cb;
                    pair[1] = cr;
                }
            }
        }
        debug_assert!(h > 0);
        // SAFETY: matches the lock above.
        unsafe { CVPixelBufferUnlockBaseAddress(&buffer, CVPixelBufferLockFlags(0)) };
        if luma.is_null() || chroma.is_null() || luma_stride < w || chroma_stride < w {
            return Err(VideoError::Encoder("unexpected pixel buffer layout".into()));
        }
        Ok(buffer)
    }

    /// Moves finished frames from the callback queue into `out`.
    fn drain(&mut self, out: &mut Vec<EncodedSample>) -> Result<()> {
        let ready: Vec<_> = match self.shared.outputs.lock() {
            Ok(mut outputs) => outputs.drain(..).collect(),
            Err(_) => return Err(VideoError::Encoder("VideoToolbox callback panicked".into())),
        };
        for item in ready {
            let output = item.map_err(|e| VideoError::Encoder(format!("VideoToolbox: {e}")))?;
            if let Some(sets) = output.parameter_sets {
                match &self.parameter_sets {
                    Some(existing) if *existing != sets => {
                        return Err(VideoError::Encoder("SPS/PPS changed mid-stream".into()));
                    }
                    Some(_) => {}
                    None => self.parameter_sets = Some(sets),
                }
            }
            out.push(EncodedSample {
                data: output.data,
                keyframe: output.keyframe,
            });
        }
        Ok(())
    }
}

impl VideoEncoder for VideoToolboxEncoder {
    fn name(&self) -> &'static str {
        "videotoolbox"
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
        let buffer = self.pixel_buffer(frame)?;
        let num = i32::try_from(self.rate.num).unwrap_or(i32::MAX);
        let den = i64::from(self.rate.den);
        // SAFETY: plain value constructors.
        let (pts, duration) = unsafe {
            (
                CMTime::new(self.frame_index * den, num),
                CMTime::new(den, num),
            )
        };
        // SAFETY: valid session and pixel buffer; no per-frame properties.
        let status = unsafe {
            self.session.encode_frame(
                &buffer,
                pts,
                duration,
                None,
                ptr::null_mut(),
                ptr::null_mut(),
            )
        };
        os_check(status, "encoding a frame")?;
        self.frame_index += 1;
        self.drain(out)
    }

    fn finish(&mut self, out: &mut Vec<EncodedSample>) -> Result<()> {
        // SAFETY: valid session; kCMTimeInvalid flushes every pending frame.
        let status = unsafe { self.session.complete_frames(kCMTimeInvalid) };
        os_check(status, "flushing the encoder")?;
        self.drain(out)
    }

    fn parameter_sets(&self) -> Option<&AvcParameterSets> {
        self.parameter_sets.as_ref()
    }
}

impl Drop for VideoToolboxEncoder {
    fn drop(&mut self) {
        // SAFETY: valid session; after invalidation no callback touches `shared`.
        unsafe {
            self.session.complete_frames(kCMTimeInvalid);
            self.session.invalidate();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_panicking_callback_body_is_recorded_as_an_error_instead_of_unwinding() {
        let shared = Shared::default();
        record_guarded(&shared, || panic!("boom in the VT thread"));
        record_guarded(&shared, || Err("plain failure".to_owned()));
        let outputs = shared.outputs.lock().unwrap();
        assert_eq!(outputs.len(), 2);
        let first = outputs[0].as_ref().unwrap_err();
        assert!(first.contains("panicked"), "{first}");
        assert_eq!(outputs[1].as_ref().unwrap_err(), "plain failure");
    }

    fn frame(w: u32, h: u32, t: u32) -> YuvFrame {
        let rgb: Vec<u8> = (0..w * h)
            .flat_map(|i| {
                let (x, y) = (i % w, i / w);
                [
                    ((x + t * 3) % 256) as u8,
                    (y % 256) as u8,
                    ((x ^ y) % 256) as u8,
                ]
            })
            .collect();
        YuvFrame::from_rgb(&rgb, w, h).unwrap()
    }

    fn encoder(settings: &EncoderSettings) -> Option<VideoToolboxEncoder> {
        match VideoToolboxEncoder::new(settings) {
            Ok(enc) => Some(enc),
            Err(e) => {
                println!("skipped: VideoToolbox unavailable ({e})");
                None
            }
        }
    }

    #[test]
    fn encodes_in_order_with_periodic_keyframes() {
        let settings = EncoderSettings {
            keyframe_interval: 10,
            ..EncoderSettings::new(320, 240, 30.0, Quality::High)
        };
        let Some(mut enc) = encoder(&settings) else {
            return;
        };
        assert_eq!(enc.name(), "videotoolbox");
        let mut out = Vec::new();
        for t in 0..25 {
            enc.encode(&frame(320, 240, t), &mut out).unwrap();
        }
        enc.finish(&mut out).unwrap();
        assert_eq!(out.len(), 25);
        // What the session guarantees: a key at frame 0 and never more than
        // `keyframe_interval` frames between keys. VideoToolbox may add extra
        // IDR frames (it does under heavy load), so the count is a minimum.
        let keys: Vec<usize> = (0..out.len()).filter(|&i| out[i].keyframe).collect();
        assert_eq!(keys.first(), Some(&0), "{keys:?}");
        assert!(keys.len() >= 3, "{keys:?}");
        let max_gap = keys.windows(2).map(|w| w[1] - w[0]).max().unwrap_or(0);
        assert!(
            max_gap <= settings.keyframe_interval as usize,
            "gap {max_gap} in {keys:?}"
        );
        let sets = enc.parameter_sets().unwrap();
        assert_eq!(sets.profile_idc(), 100);
        assert!(sets.avcc_record().is_ok());
        for s in &out {
            let first = u32::from_be_bytes(s.data[..4].try_into().unwrap()) as usize;
            assert!(first + 4 <= s.data.len(), "length-prefixed AVCC");
        }
    }

    #[test]
    fn bitrate_mode_and_size_checks() {
        let settings = EncoderSettings::new(640, 360, 25.0, Quality::Bitrate { kbps: 1500 });
        let Some(mut enc) = encoder(&settings) else {
            return;
        };
        let mut out = Vec::new();
        assert!(enc.encode(&frame(320, 240, 0), &mut out).is_err());
        enc.encode(&frame(640, 360, 0), &mut out).unwrap();
        enc.finish(&mut out).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(vt_quality(Quality::Low), Some(0.57));
        assert_eq!(vt_quality(Quality::Bitrate { kbps: 1 }), None);
    }
}
