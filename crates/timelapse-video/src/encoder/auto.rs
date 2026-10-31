//! `EncoderBackend::Auto`: prefer a primary (hardware) encoder and fall back
//! to openh264 transparently.
//!
//! The fallback can happen at creation (no hardware session) or while
//! *probing*: until the primary encoder has produced its first sample, every
//! input frame is kept, so if the primary fails early the frames are replayed
//! into openh264 and nothing reaches the muxer twice. Once the primary has
//! proven itself (first sample out), buffering stops and later errors are
//! reported normally.

use super::{EncodedSample, EncoderSettings, OpenH264Encoder, VideoEncoder};
use crate::error::Result;
use crate::h264::AvcParameterSets;
use crate::yuv420::YuvFrame;

/// Frames kept while probing; a primary that has emitted nothing after this
/// many frames is trusted (it is merely slow), and buffering stops.
const MAX_PROBE_FRAMES: usize = 32;

/// Primary encoder with automatic openh264 fallback.
pub struct AutoEncoder {
    active: Box<dyn VideoEncoder>,
    settings: EncoderSettings,
    probing: bool,
    pending: Vec<YuvFrame>,
    fallback_reason: Option<String>,
}

impl AutoEncoder {
    /// Tries `primary`; uses openh264 (recording why) if it cannot be created.
    ///
    /// # Errors
    /// Only if openh264 itself cannot be created.
    pub fn new(
        settings: &EncoderSettings,
        primary: impl FnOnce(&EncoderSettings) -> Result<Box<dyn VideoEncoder>>,
    ) -> Result<Self> {
        match primary(settings) {
            Ok(active) => Ok(Self {
                active,
                settings: *settings,
                probing: true,
                pending: Vec::new(),
                fallback_reason: None,
            }),
            Err(e) => Ok(Self {
                active: Box::new(OpenH264Encoder::new(settings)?),
                settings: *settings,
                probing: false,
                pending: Vec::new(),
                fallback_reason: Some(e.to_string()),
            }),
        }
    }

    /// Replaces the primary with openh264 and replays the probed frames.
    fn fall_back(&mut self, reason: String, out: &mut Vec<EncodedSample>) -> Result<()> {
        let mut fallback = OpenH264Encoder::new(&self.settings)?;
        for frame in self.pending.drain(..) {
            fallback.encode(&frame, out)?;
        }
        self.active = Box::new(fallback);
        self.probing = false;
        self.fallback_reason = Some(reason);
        Ok(())
    }

    fn settle(&mut self, produced: bool) {
        if produced || self.pending.len() >= MAX_PROBE_FRAMES {
            self.probing = false;
            self.pending.clear();
        }
    }
}

impl VideoEncoder for AutoEncoder {
    fn name(&self) -> &'static str {
        self.active.name()
    }

    fn encode(&mut self, frame: &YuvFrame, out: &mut Vec<EncodedSample>) -> Result<()> {
        if !self.probing {
            return self.active.encode(frame, out);
        }
        self.pending.push(frame.clone());
        let mut produced = Vec::new();
        match self.active.encode(frame, &mut produced) {
            Ok(()) => {
                self.settle(!produced.is_empty());
                out.append(&mut produced);
                Ok(())
            }
            Err(e) => self.fall_back(e.to_string(), out),
        }
    }

    fn finish(&mut self, out: &mut Vec<EncodedSample>) -> Result<()> {
        if !self.probing {
            return self.active.finish(out);
        }
        let mut produced = Vec::new();
        match self.active.finish(&mut produced) {
            Ok(()) if !produced.is_empty() || self.pending.is_empty() => {
                self.settle(true);
                out.append(&mut produced);
                Ok(())
            }
            Ok(()) => {
                let reason = format!("{} produced no output", self.active.name());
                self.fall_back(reason, out)?;
                self.active.finish(out)
            }
            Err(e) => {
                self.fall_back(e.to_string(), out)?;
                self.active.finish(out)
            }
        }
    }

    fn parameter_sets(&self) -> Option<&AvcParameterSets> {
        self.active.parameter_sets()
    }

    fn fallback_reason(&self) -> Option<&str> {
        self.fallback_reason.as_deref()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::VideoError;
    use crate::options::Quality;

    /// Emits nothing for `delay` frames, then fails or passes frames through
    /// a real openh264 encoder (standing in for a hardware encoder).
    struct Flaky {
        inner: OpenH264Encoder,
        fail_at: Option<usize>,
        delay: usize,
        seen: usize,
        held: Vec<YuvFrame>,
    }

    impl Flaky {
        fn new(settings: &EncoderSettings, fail_at: Option<usize>, delay: usize) -> Self {
            Self {
                inner: OpenH264Encoder::new(settings).unwrap(),
                fail_at,
                delay,
                seen: 0,
                held: Vec::new(),
            }
        }
    }

    impl VideoEncoder for Flaky {
        fn name(&self) -> &'static str {
            "flaky"
        }
        fn encode(&mut self, frame: &YuvFrame, out: &mut Vec<EncodedSample>) -> Result<()> {
            self.seen += 1;
            if self.fail_at == Some(self.seen) {
                return Err(VideoError::Encoder("hardware went away".into()));
            }
            self.held.push(frame.clone());
            if self.seen > self.delay {
                for f in self.held.drain(..) {
                    self.inner.encode(&f, out)?;
                }
            }
            Ok(())
        }
        fn finish(&mut self, out: &mut Vec<EncodedSample>) -> Result<()> {
            if self.fail_at == Some(0) {
                return Err(VideoError::Encoder("flush failed".into()));
            }
            for f in self.held.drain(..) {
                self.inner.encode(&f, out)?;
            }
            Ok(())
        }
        fn parameter_sets(&self) -> Option<&AvcParameterSets> {
            self.inner.parameter_sets()
        }
    }

    fn settings() -> EncoderSettings {
        EncoderSettings::new(64, 48, 10.0, Quality::Medium)
    }

    fn frame(v: u8) -> YuvFrame {
        YuvFrame::from_rgb(&[v; 64 * 48 * 3], 64, 48).unwrap()
    }

    fn run(enc: &mut AutoEncoder, frames: usize) -> Result<Vec<EncodedSample>> {
        let mut out = Vec::new();
        for i in 0..frames {
            enc.encode(&frame(i as u8 * 10), &mut out)?;
        }
        enc.finish(&mut out)?;
        Ok(out)
    }

    #[test]
    fn creation_failure_falls_back_with_reason() {
        let mut enc = AutoEncoder::new(&settings(), |_| {
            Err(VideoError::Encoder("no hardware encoder".into()))
        })
        .unwrap();
        assert_eq!(enc.name(), "openh264");
        assert!(
            enc.fallback_reason()
                .unwrap()
                .contains("no hardware encoder")
        );
        assert_eq!(run(&mut enc, 5).unwrap().len(), 5);
        assert!(enc.parameter_sets().is_some());
    }

    #[test]
    fn early_failure_replays_buffered_frames_into_openh264() {
        let s = settings();
        let mut enc = AutoEncoder::new(&s, |s| Ok(Box::new(Flaky::new(s, Some(3), 5)))).unwrap();
        assert_eq!(enc.name(), "flaky");
        let out = run(&mut enc, 6).unwrap();
        assert_eq!(out.len(), 6, "frames 1-3 replayed, 4-6 encoded directly");
        assert!(out[0].keyframe);
        assert_eq!(enc.name(), "openh264");
        assert!(
            enc.fallback_reason()
                .unwrap()
                .contains("hardware went away")
        );
    }

    #[test]
    fn healthy_primary_is_kept_and_later_errors_propagate() {
        let s = settings();
        let mut enc = AutoEncoder::new(&s, |s| Ok(Box::new(Flaky::new(s, None, 2)))).unwrap();
        assert_eq!(run(&mut enc, 7).unwrap().len(), 7);
        assert_eq!(enc.name(), "flaky");
        assert_eq!(enc.fallback_reason(), None);

        let mut enc = AutoEncoder::new(&s, |s| Ok(Box::new(Flaky::new(s, Some(5), 0)))).unwrap();
        let err = run(&mut enc, 6).unwrap_err();
        assert!(err.to_string().contains("hardware went away"), "{err}");
    }

    #[test]
    fn failures_while_flushing_the_probe_fall_back() {
        let s = settings();
        // Holds every frame until finish, then fails to flush.
        let mut enc = AutoEncoder::new(&s, |s| Ok(Box::new(Flaky::new(s, Some(0), 100)))).unwrap();
        let out = run(&mut enc, 4).unwrap();
        assert_eq!(out.len(), 4);
        assert!(enc.fallback_reason().unwrap().contains("flush failed"));

        // A primary that silently emits nothing is replaced as well.
        struct Silent;
        impl VideoEncoder for Silent {
            fn name(&self) -> &'static str {
                "silent"
            }
            fn encode(&mut self, _: &YuvFrame, _: &mut Vec<EncodedSample>) -> Result<()> {
                Ok(())
            }
            fn finish(&mut self, _: &mut Vec<EncodedSample>) -> Result<()> {
                Ok(())
            }
            fn parameter_sets(&self) -> Option<&AvcParameterSets> {
                None
            }
        }
        let mut enc = AutoEncoder::new(&s, |_| Ok(Box::new(Silent))).unwrap();
        assert_eq!(run(&mut enc, 3).unwrap().len(), 3);
        assert!(enc.fallback_reason().unwrap().contains("no output"));
    }

    #[test]
    fn slow_primary_is_trusted_after_the_probe_window() {
        let s = settings();
        let mut enc = AutoEncoder::new(&s, |s| {
            Ok(Box::new(Flaky::new(s, None, MAX_PROBE_FRAMES + 5)))
        })
        .unwrap();
        let mut out = Vec::new();
        for i in 0..MAX_PROBE_FRAMES {
            enc.encode(&frame(i as u8), &mut out).unwrap();
        }
        assert!(!enc.probing && enc.pending.is_empty());
        enc.finish(&mut out).unwrap();
        assert_eq!(out.len(), MAX_PROBE_FRAMES);
    }
}
