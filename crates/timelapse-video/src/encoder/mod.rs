//! H.264 encoder abstraction.
//!
//! [`VideoEncoder`] hides the codec implementation from the pipeline. Two
//! implementations exist: the portable [`OpenH264Encoder`] and, on macOS, the
//! hardware [`VideoToolboxEncoder`]. [`EncoderBackend::Auto`] picks
//! VideoToolbox on macOS through [`AutoEncoder`], which falls back to
//! openh264 if the hardware session cannot be created or fails early.

mod auto;
mod openh264;
#[cfg(target_os = "macos")]
mod videotoolbox;

pub use self::auto::AutoEncoder;
pub use self::openh264::OpenH264Encoder;
#[cfg(target_os = "macos")]
pub use self::videotoolbox::VideoToolboxEncoder;

use crate::error::Result;
#[cfg(not(target_os = "macos"))]
use crate::error::VideoError;
use crate::h264::AvcParameterSets;
use crate::options::{EncoderBackend, Quality};
use crate::yuv420::YuvFrame;

/// Static encoder configuration.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct EncoderSettings {
    /// Frame width (even).
    pub width: u32,
    /// Frame height (even).
    pub height: u32,
    /// Output frame rate (frames per second).
    pub fps: f64,
    /// Quality preset or bitrate.
    pub quality: Quality,
    /// Distance between IDR frames, in frames.
    pub keyframe_interval: u32,
    /// Encoder worker threads (0 = automatic).
    pub threads: u16,
}

/// Seconds between forced keyframes (seek granularity).
pub const KEYFRAME_INTERVAL_SECS: f64 = 2.0;

impl EncoderSettings {
    /// Settings with the default keyframe interval and automatic threading.
    #[must_use]
    pub fn new(width: u32, height: u32, fps: f64, quality: Quality) -> Self {
        let interval = (fps * KEYFRAME_INTERVAL_SECS).round().clamp(1.0, 600.0) as u32;
        Self {
            width,
            height,
            fps,
            quality,
            keyframe_interval: interval,
            threads: 0,
        }
    }
}

/// One encoded frame in MP4 (length-prefixed NAL) form.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncodedSample {
    /// AVCC sample bytes.
    pub data: Vec<u8>,
    /// True for IDR frames (MP4 sync samples).
    pub keyframe: bool,
}

/// An H.264 encoder producing MP4-ready samples in presentation order
/// (implementations must not use B-frames).
pub trait VideoEncoder: Send {
    /// Short identifier, e.g. `"openh264"`.
    fn name(&self) -> &'static str;

    /// Encodes one frame. Zero or more finished samples are appended to `out`.
    ///
    /// # Errors
    /// [`crate::VideoError::Encoder`] if the codec fails.
    fn encode(&mut self, frame: &YuvFrame, out: &mut Vec<EncodedSample>) -> Result<()>;

    /// Flushes frames still buffered inside the encoder.
    ///
    /// # Errors
    /// [`crate::VideoError::Encoder`] if the codec fails.
    fn finish(&mut self, out: &mut Vec<EncodedSample>) -> Result<()>;

    /// SPS/PPS of the stream, available once the first frame was encoded.
    fn parameter_sets(&self) -> Option<&AvcParameterSets>;

    /// Why a preferred encoder was replaced by a fallback, if it was.
    fn fallback_reason(&self) -> Option<&str> {
        None
    }
}

/// Creates the encoder selected by `backend`.
///
/// * `Auto`: VideoToolbox on macOS with transparent openh264 fallback (see
///   [`VideoEncoder::fallback_reason`]); openh264 elsewhere.
/// * `OpenH264`: always openh264.
/// * `VideoToolbox`: the hardware encoder, no fallback (macOS only).
///
/// # Errors
/// [`crate::VideoError::Encoder`] if the encoder cannot be initialised;
/// [`crate::VideoError::InvalidOptions`] for `VideoToolbox` off macOS.
pub fn create_encoder(
    backend: EncoderBackend,
    settings: &EncoderSettings,
) -> Result<Box<dyn VideoEncoder>> {
    match backend {
        EncoderBackend::OpenH264 => Ok(Box::new(OpenH264Encoder::new(settings)?)),
        #[cfg(target_os = "macos")]
        EncoderBackend::Auto => Ok(Box::new(AutoEncoder::new(settings, |s| {
            Ok(Box::new(VideoToolboxEncoder::new(s)?))
        })?)),
        #[cfg(not(target_os = "macos"))]
        EncoderBackend::Auto => Ok(Box::new(OpenH264Encoder::new(settings)?)),
        #[cfg(target_os = "macos")]
        EncoderBackend::VideoToolbox => Ok(Box::new(VideoToolboxEncoder::new(settings)?)),
        #[cfg(not(target_os = "macos"))]
        EncoderBackend::VideoToolbox => Err(VideoError::InvalidOptions(
            "the VideoToolbox encoder is only available on macOS".into(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keyframe_interval_is_two_seconds_and_bounded() {
        assert_eq!(
            EncoderSettings::new(64, 64, 30.0, Quality::High).keyframe_interval,
            60
        );
        assert_eq!(
            EncoderSettings::new(64, 64, 0.1, Quality::High).keyframe_interval,
            1
        );
        assert_eq!(
            EncoderSettings::new(64, 64, 29.97, Quality::High).keyframe_interval,
            60
        );
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn videotoolbox_is_rejected_off_macos() {
        let settings = EncoderSettings::new(64, 48, 10.0, Quality::Medium);
        let err = create_encoder(EncoderBackend::VideoToolbox, &settings)
            .err()
            .unwrap();
        assert!(matches!(err, crate::VideoError::InvalidOptions(_)), "{err}");
    }

    #[test]
    fn factory_picks_the_platform_default_for_auto() {
        let settings = EncoderSettings::new(64, 48, 10.0, Quality::Medium);
        let enc = create_encoder(EncoderBackend::Auto, &settings).unwrap();
        // VideoToolbox on macOS unless the hardware session is unavailable.
        let expected = if cfg!(target_os = "macos") && enc.fallback_reason().is_none() {
            "videotoolbox"
        } else {
            "openh264"
        };
        assert_eq!(enc.name(), expected);
        assert!(enc.parameter_sets().is_none());
        let explicit = create_encoder(EncoderBackend::OpenH264, &settings).unwrap();
        assert_eq!(explicit.name(), "openh264");
        assert_eq!(explicit.fallback_reason(), None);
    }
}
