//! User-facing export options (serde-serialisable, camelCase for the UI) and
//! their validation into a concrete timeline.

use serde::{Deserialize, Serialize};

use crate::error::{Result, VideoError};
use crate::geometry::{Resolution, ScaleMode};
use crate::timing::{
    Easing, FrameRate, MAX_DURATION_SECS, MAX_FPS, MIN_DURATION_SECS, MIN_FPS, Timeline,
    TimelineSpec, js_to_fixed,
};

/// Most blend frames allowed between two photos.
pub const MAX_CROSSFADE_FRAMES: u32 = 30;
/// Longest first/last-frame hold, in seconds.
pub const MAX_HOLD_SECS: f64 = 10.0;
/// Default caption date format: `Aug 15, 2014`.
pub const DEFAULT_DATE_FORMAT: &str = "%b %-d, %Y";
/// Bitrate bounds for [`Quality::Bitrate`], in kbit/s.
pub const BITRATE_KBPS_RANGE: (u32, u32) = (100, 200_000);
/// Caption height bounds as a fraction of the output height.
pub const CAPTION_SIZE_RANGE: (f64, f64) = (0.01, 0.2);
const MAX_DATE_FORMAT_LEN: usize = 64;

/// How fast the timelapse plays.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum Pace {
    /// A fixed output frame rate (1-60). The duration follows from the frame count.
    Fps {
        /// Frames per second; rounded to two decimals like the legacy UI.
        fps: f64,
    },
    /// A target total duration (1-120 s). The frame rate follows from the frame count.
    Duration {
        /// Total seconds, including crossfades and holds.
        seconds: f64,
    },
}

impl Default for Pace {
    fn default() -> Self {
        // Legacy dialog default.
        Self::Fps { fps: 10.0 }
    }
}

/// Encoding quality. Presets use constant quantiser (the closest openh264
/// analogue to x264's CRF); [`Quality::Bitrate`] uses openh264's bitrate
/// rate control.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Quality {
    /// Small files for quick sharing (QP 30).
    Low,
    /// Balanced (QP 26).
    Medium,
    /// Visually clean (QP 22). Default.
    #[default]
    High,
    /// Near-transparent, large files (QP 18).
    Max,
    /// Average bitrate target.
    Bitrate {
        /// Kilobits per second.
        kbps: u32,
    },
}

impl Quality {
    /// Constant quantiser for presets, `None` for [`Quality::Bitrate`].
    #[must_use]
    pub fn qp(self) -> Option<u8> {
        match self {
            Self::Low => Some(30),
            Self::Medium => Some(26),
            Self::High => Some(22),
            Self::Max => Some(18),
            Self::Bitrate { .. } => None,
        }
    }
}

/// Dissolve between consecutive photos.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Crossfade {
    /// Blend frames inserted between each pair of photos (0 = hard cuts).
    pub frames: u32,
    /// Blend weight curve.
    pub easing: Easing,
}

/// Where the date caption sits.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(missing_docs)]
pub enum CaptionPosition {
    TopLeft,
    TopCenter,
    TopRight,
    /// Default: left-anchored text does not jitter as the date width changes.
    #[default]
    BottomLeft,
    BottomCenter,
    BottomRight,
}

/// Date caption overlay.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CaptionOptions {
    /// Placement on the frame.
    pub position: CaptionPosition,
    /// Font size (em height) as a fraction of the output height.
    pub size: f64,
    /// `chrono` strftime format. English month names.
    pub format: String,
}

impl Default for CaptionOptions {
    fn default() -> Self {
        Self {
            position: CaptionPosition::default(),
            size: 0.045,
            format: DEFAULT_DATE_FORMAT.to_owned(),
        }
    }
}

/// Which H.264 encoder implementation to use.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EncoderBackend {
    /// The best available encoder: VideoToolbox (hardware) on macOS with an
    /// automatic openh264 fallback, openh264 elsewhere.
    #[default]
    Auto,
    /// Cisco openh264, compiled from source. Available everywhere.
    OpenH264,
    /// Apple VideoToolbox hardware encoder, without fallback. macOS only;
    /// elsewhere encoding fails with [`VideoError::InvalidOptions`].
    VideoToolbox,
}

/// All export settings. Every field has a sensible default, so the UI can
/// send a partial object.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct VideoOptions {
    /// Frame rate or total duration.
    pub pace: Pace,
    /// Output size preset.
    pub resolution: Resolution,
    /// Encoding quality.
    pub quality: Quality,
    /// Crossfade between photos.
    pub crossfade: Crossfade,
    /// Optional date caption; frames without a date get no caption.
    pub caption: Option<CaptionOptions>,
    /// Extra seconds the first photo is shown.
    pub hold_first_secs: f64,
    /// Extra seconds the last photo is shown.
    pub hold_last_secs: f64,
    /// Letterbox or crop frames whose aspect differs from the output.
    pub scale_mode: ScaleMode,
    /// Background colour for letterboxing, RGB.
    pub background: [u8; 3],
    /// Encoder implementation.
    pub encoder: EncoderBackend,
    /// Worker threads for frame preparation (0 = one per CPU core).
    pub threads: usize,
    /// Replace an existing file at the output path (default). When false,
    /// nothing is ever replaced: if a file appears there during the encode,
    /// the video is saved at the first free `{stem}_{n}.{ext}` instead
    /// (reported in [`crate::EncodeSummary::output`]).
    pub replace_existing: bool,
}

impl Default for VideoOptions {
    fn default() -> Self {
        Self {
            pace: Pace::default(),
            resolution: Resolution::default(),
            quality: Quality::default(),
            crossfade: Crossfade::default(),
            caption: None,
            hold_first_secs: 0.0,
            hold_last_secs: 0.0,
            scale_mode: ScaleMode::default(),
            background: [0, 0, 0],
            encoder: EncoderBackend::default(),
            threads: 0,
            replace_existing: true,
        }
    }
}

/// Timing resolved against a concrete frame count.
#[derive(Debug, Clone, PartialEq)]
pub struct TimingPlan {
    /// Exact output frame rate.
    pub frame_rate: FrameRate,
    /// Output timeline (holds, keys, blends).
    pub timeline: Timeline,
}

impl TimingPlan {
    /// Total encoded frames.
    #[must_use]
    pub fn total_frames(&self) -> u64 {
        self.timeline.total_frames()
    }

    /// Exact video duration in seconds.
    #[must_use]
    pub fn duration_secs(&self) -> f64 {
        self.total_frames() as f64 / self.frame_rate.as_f64()
    }
}

fn invalid(msg: impl Into<String>) -> VideoError {
    VideoError::InvalidOptions(msg.into())
}

fn check_range(name: &str, value: f64, lo: f64, hi: f64) -> Result<()> {
    if value.is_finite() && (lo..=hi).contains(&value) {
        Ok(())
    } else {
        Err(invalid(format!(
            "{name} must be between {lo} and {hi}, got {value}"
        )))
    }
}

impl VideoOptions {
    /// The [`TimelineSpec`] these options describe for `source_frames` photos.
    #[must_use]
    pub fn timeline_spec(&self, source_frames: usize) -> TimelineSpec {
        TimelineSpec {
            source_frames,
            crossfade_frames: self.crossfade.frames,
            hold_first_secs: self.hold_first_secs,
            hold_last_secs: self.hold_last_secs,
        }
    }

    /// Checks everything that does not depend on the frame count.
    ///
    /// # Errors
    /// [`VideoError::InvalidOptions`] describing the first problem found.
    pub fn validate(&self) -> Result<()> {
        match self.pace {
            Pace::Fps { fps } => check_range("fps", fps, MIN_FPS, MAX_FPS)?,
            Pace::Duration { seconds } => {
                check_range("duration", seconds, MIN_DURATION_SECS, MAX_DURATION_SECS)?;
            }
        }
        if self.crossfade.frames > MAX_CROSSFADE_FRAMES {
            return Err(invalid(format!(
                "crossfade must be at most {MAX_CROSSFADE_FRAMES} frames, got {}",
                self.crossfade.frames
            )));
        }
        check_range("first-frame hold", self.hold_first_secs, 0.0, MAX_HOLD_SECS)?;
        check_range("last-frame hold", self.hold_last_secs, 0.0, MAX_HOLD_SECS)?;
        if let Quality::Bitrate { kbps } = self.quality {
            let (lo, hi) = BITRATE_KBPS_RANGE;
            if !(lo..=hi).contains(&kbps) {
                return Err(invalid(format!(
                    "bitrate must be {lo}-{hi} kbps, got {kbps}"
                )));
            }
        }
        if let Some(caption) = &self.caption {
            validate_caption(caption)?;
        }
        Ok(())
    }

    /// Validates the options and resolves the frame rate and timeline for
    /// `source_frames` photos.
    ///
    /// # Errors
    /// [`VideoError::EmptySource`] for zero frames, or
    /// [`VideoError::InvalidOptions`] if the options are invalid or the
    /// requested duration needs a frame rate outside 1-60 fps.
    pub fn plan(&self, source_frames: usize) -> Result<TimingPlan> {
        self.validate()?;
        if source_frames == 0 {
            return Err(VideoError::EmptySource);
        }
        let spec = self.timeline_spec(source_frames);
        let fps = match self.pace {
            Pace::Fps { fps } => js_to_fixed(fps, 2),
            Pace::Duration { seconds } => spec.fps_for_duration(seconds).ok_or_else(|| {
                invalid(format!(
                    "a {seconds}s video cannot fit {:.1}s of first/last-frame holds",
                    self.hold_first_secs + self.hold_last_secs
                ))
            })?,
        };
        if !(MIN_FPS..=MAX_FPS).contains(&fps) {
            let range = spec
                .feasible_duration_range()
                .map(|(lo, hi)| format!("; choose a duration between {lo:.1}s and {hi:.1}s"))
                .unwrap_or_default();
            return Err(invalid(format!(
                "{source_frames} photos at this duration need {fps} fps, outside \
                 {MIN_FPS}-{MAX_FPS} fps{range}"
            )));
        }
        let frame_rate = FrameRate::from_fps(fps)
            .ok_or_else(|| invalid(format!("unsupported frame rate {fps}")))?;
        let (hold_first_frames, hold_last_frames) = spec.hold_frames(frame_rate.as_f64());
        Ok(TimingPlan {
            frame_rate,
            timeline: Timeline {
                source_frames,
                crossfade_frames: self.crossfade.frames,
                easing: self.crossfade.easing,
                hold_first_frames,
                hold_last_frames,
            },
        })
    }
}

fn validate_caption(caption: &CaptionOptions) -> Result<()> {
    let (lo, hi) = CAPTION_SIZE_RANGE;
    if !caption.size.is_finite() || !(lo..=hi).contains(&caption.size) {
        return Err(invalid(format!(
            "caption size must be between {lo} and {hi} of the frame height, got {}",
            caption.size
        )));
    }
    if caption.format.trim().is_empty() || caption.format.len() > MAX_DATE_FORMAT_LEN {
        return Err(invalid(format!(
            "caption format must be 1-{MAX_DATE_FORMAT_LEN} characters"
        )));
    }
    let has_error = chrono::format::StrftimeItems::new(&caption.format)
        .any(|item| matches!(item, chrono::format::Item::Error));
    // Syntactically valid specifiers can still be unusable for a date
    // (`%H`, `%z`, `%s`, …): try one.
    let sample = chrono::NaiveDate::from_ymd_opt(2014, 8, 15).unwrap_or_default();
    if has_error || format_date(sample, &caption.format).is_none() {
        return Err(invalid(format!(
            "caption format {:?} is not valid for a date (use date fields like %Y %m %d %b)",
            caption.format
        )));
    }
    Ok(())
}

/// `date` formatted with the strftime `format`; `None` when the pattern
/// cannot format a date (time or time-zone fields) — never panics.
#[must_use]
pub fn format_date(date: chrono::NaiveDate, format: &str) -> Option<String> {
    use std::fmt::Write as _;
    let mut out = String::new();
    write!(out, "{}", date.format(format)).ok()?;
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caption_formats_that_cannot_format_a_date_are_rejected() {
        let with = |format: &str| VideoOptions {
            caption: Some(CaptionOptions {
                format: format.into(),
                ..CaptionOptions::default()
            }),
            ..VideoOptions::default()
        };
        // Time and time-zone specifiers pass chrono's syntax check but cannot
        // format a date (they used to panic the frame workers).
        for bad in ["%b %d, %Y %H:%M", "%z", "%s", "%H", "%T"] {
            assert!(with(bad).validate().is_err(), "{bad} accepted");
        }
        for good in ["%Y", "%b %-d, %Y", "%Y-%m-%d", "Day %j", "%A %e %B"] {
            assert!(with(good).validate().is_ok(), "{good} rejected");
        }
    }

    #[test]
    fn defaults_are_valid_and_match_legacy_pace() {
        let opts = VideoOptions::default();
        opts.validate().unwrap();
        assert_eq!(opts.pace, Pace::Fps { fps: 10.0 });
        let plan = opts.plan(3593).unwrap();
        assert_eq!(plan.total_frames(), 3593);
        assert!((plan.duration_secs() - 359.3).abs() < 1e-9);
    }

    #[test]
    fn serde_uses_camel_case_and_accepts_partial_objects() {
        let json = r#"{
            "pace": {"mode": "duration", "seconds": 60},
            "resolution": "2160p",
            "quality": {"bitrate": {"kbps": 12000}},
            "crossfade": {"frames": 2, "easing": "linear"},
            "caption": {"position": "bottomRight"},
            "holdLastSecs": 1.5
        }"#;
        let opts: VideoOptions = serde_json::from_str(json).unwrap();
        assert_eq!(opts.pace, Pace::Duration { seconds: 60.0 });
        assert_eq!(opts.resolution, Resolution::P2160);
        assert_eq!(opts.quality, Quality::Bitrate { kbps: 12000 });
        assert_eq!(opts.crossfade.frames, 2);
        assert_eq!(opts.crossfade.easing, Easing::Linear);
        let caption = opts.caption.clone().unwrap();
        assert_eq!(caption.position, CaptionPosition::BottomRight);
        assert_eq!(caption.format, DEFAULT_DATE_FORMAT);
        assert_eq!(opts.hold_last_secs, 1.5);
        assert_eq!(opts.scale_mode, ScaleMode::Fit);

        let back = serde_json::to_string(&opts).unwrap();
        assert!(back.contains("\"holdLastSecs\":1.5"), "{back}");
        let again: VideoOptions = serde_json::from_str(&back).unwrap();
        assert_eq!(again, opts);
        let empty: VideoOptions = serde_json::from_str("{}").unwrap();
        assert_eq!(empty, VideoOptions::default());
    }

    #[test]
    fn duration_pace_uses_legacy_rounding() {
        let opts = VideoOptions {
            pace: Pace::Duration { seconds: 120.0 },
            ..VideoOptions::default()
        };
        let plan = opts.plan(3593).unwrap();
        // fps_for_duration(3593, 120) = 29.94 exactly as the legacy UI sends it.
        assert_eq!(plan.frame_rate, FrameRate { num: 1497, den: 50 });
        assert!((plan.duration_secs() - 3593.0 / 29.94).abs() < 1e-9);
    }

    #[test]
    fn plan_accounts_for_crossfade_and_holds() {
        let opts = VideoOptions {
            pace: Pace::Fps { fps: 30.0 },
            crossfade: Crossfade {
                frames: 2,
                easing: Easing::EaseInOut,
            },
            hold_first_secs: 0.5,
            hold_last_secs: 1.5,
            ..VideoOptions::default()
        };
        let plan = opts.plan(300).unwrap();
        assert_eq!(plan.total_frames(), 958);
        assert_eq!(plan.timeline.hold_first_frames, 15);
        assert_eq!(plan.timeline.hold_last_frames, 45);
        let spec = opts.timeline_spec(300);
        assert_eq!(spec.duration_for_fps(30.0), Some(31.93));
    }

    #[test]
    fn rejects_out_of_range_values() {
        let bad = [
            VideoOptions {
                pace: Pace::Fps { fps: 0.5 },
                ..VideoOptions::default()
            },
            VideoOptions {
                pace: Pace::Fps { fps: f64::NAN },
                ..VideoOptions::default()
            },
            VideoOptions {
                pace: Pace::Duration { seconds: 121.0 },
                ..VideoOptions::default()
            },
            VideoOptions {
                crossfade: Crossfade {
                    frames: MAX_CROSSFADE_FRAMES + 1,
                    easing: Easing::Linear,
                },
                ..VideoOptions::default()
            },
            VideoOptions {
                hold_last_secs: -1.0,
                ..VideoOptions::default()
            },
            VideoOptions {
                quality: Quality::Bitrate { kbps: 10 },
                ..VideoOptions::default()
            },
            VideoOptions {
                caption: Some(CaptionOptions {
                    size: 0.5,
                    ..CaptionOptions::default()
                }),
                ..VideoOptions::default()
            },
            VideoOptions {
                caption: Some(CaptionOptions {
                    format: "%Q nonsense".into(),
                    ..CaptionOptions::default()
                }),
                ..VideoOptions::default()
            },
            VideoOptions {
                caption: Some(CaptionOptions {
                    format: "  ".into(),
                    ..CaptionOptions::default()
                }),
                ..VideoOptions::default()
            },
        ];
        for opts in bad {
            let err = opts.validate().unwrap_err();
            assert!(matches!(err, VideoError::InvalidOptions(_)), "{opts:?}");
        }
    }

    #[test]
    fn infeasible_duration_explains_the_valid_range() {
        let opts = VideoOptions {
            pace: Pace::Duration { seconds: 10.0 },
            ..VideoOptions::default()
        };
        let msg = opts.plan(3593).unwrap_err().to_string();
        assert!(msg.contains("359.3 fps"), "{msg}");
        assert!(msg.contains("between 59.9s and 120.0s"), "{msg}");

        let holds = VideoOptions {
            pace: Pace::Duration { seconds: 2.0 },
            hold_first_secs: 1.0,
            hold_last_secs: 1.0,
            ..VideoOptions::default()
        };
        assert!(holds.plan(10).unwrap_err().to_string().contains("holds"));
        assert!(matches!(
            VideoOptions::default().plan(0),
            Err(VideoError::EmptySource)
        ));
    }

    #[test]
    fn quality_presets_map_to_decreasing_qp() {
        let qps: Vec<u8> = [Quality::Low, Quality::Medium, Quality::High, Quality::Max]
            .iter()
            .filter_map(|q| q.qp())
            .collect();
        assert_eq!(qps, vec![30, 26, 22, 18]);
        assert_eq!(Quality::Bitrate { kbps: 5000 }.qp(), None);
    }
}
