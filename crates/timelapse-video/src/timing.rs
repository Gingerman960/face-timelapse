//! Frame-rate / duration coupling and the output frame timeline.
//!
//! The legacy export dialog (`renderer/src/components/VideoExportModal.jsx`)
//! couples two sliders: changing FPS sets `duration = count / fps`, changing
//! the duration sets `fps = count / duration`, and both values are sent to the
//! encoder as `Number(value.toFixed(2))`. [`duration_for_fps`] and
//! [`fps_for_duration`] reproduce that math bit-for-bit, including
//! JavaScript's `toFixed` rounding.
//!
//! The new encoder adds crossfades and first/last-frame holds, which change
//! how many frames are shown. [`TimelineSpec`] generalises the coupling to
//! them; with no crossfade and no holds it reduces exactly to the legacy
//! functions.

use serde::{Deserialize, Serialize};

/// Lowest frame rate the encoder accepts (legacy FPS slider minimum).
pub const MIN_FPS: f64 = 1.0;
/// Highest frame rate the encoder accepts (legacy FPS slider maximum).
pub const MAX_FPS: f64 = 60.0;
/// Shortest total duration the UI offers, in seconds (legacy slider minimum).
pub const MIN_DURATION_SECS: f64 = 1.0;
/// Longest total duration the UI offers, in seconds (legacy slider maximum).
pub const MAX_DURATION_SECS: f64 = 120.0;
/// Number of decimals the legacy UI rounds FPS and duration to.
const LEGACY_DECIMALS: usize = 2;
/// Enough fractional digits to print any finite `f64` exactly.
const EXACT_F64_DIGITS: usize = 1100;

/// Reproduces JavaScript's `Number(x.toFixed(digits))`.
///
/// `toFixed` picks the integer `n` minimising `|n / 10^digits - x|` using the
/// *exact* binary value of `x`, choosing the larger `n` on a tie (round half
/// away from zero on the true value). That is why `(1.005).toFixed(2)` is
/// `"1.00"` but `(0.125).toFixed(2)` is `"0.13"`. Rust's own formatting
/// rounds ties to even, so this is implemented on the exact decimal expansion.
///
/// Non-finite inputs are returned unchanged.
#[must_use]
pub fn js_to_fixed(x: f64, digits: usize) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let exact = format!("{:.*}", EXACT_F64_DIGITS, x.abs());
    let dot = exact.find('.').unwrap_or(exact.len());
    let keep = (dot + 1 + digits).min(exact.len());
    let mut kept: Vec<u8> = exact.as_bytes()[..keep].to_vec();
    let round_up = exact.as_bytes().get(keep).is_some_and(|d| *d >= b'5');
    if round_up {
        increment_decimal(&mut kept);
    }
    let magnitude: f64 = String::from_utf8_lossy(&kept)
        .trim_end_matches('.')
        .parse()
        .unwrap_or(f64::NAN);
    if x.is_sign_negative() {
        -magnitude
    } else {
        magnitude
    }
}

/// Adds one unit in the last place to an ASCII decimal number (`"9.99"` -> `"10.00"`).
fn increment_decimal(digits: &mut Vec<u8>) {
    for i in (0..digits.len()).rev() {
        match digits[i] {
            b'.' => {}
            b'9' => digits[i] = b'0',
            d => {
                digits[i] = d + 1;
                return;
            }
        }
    }
    digits.insert(0, b'1');
}

/// True for finite values strictly greater than zero (false for NaN).
fn is_positive(x: f64) -> bool {
    x.is_finite() && x > 0.0
}

fn legacy_round(x: f64) -> f64 {
    js_to_fixed(x, LEGACY_DECIMALS)
}

/// Legacy coupling: the duration shown after the user picks `fps`.
///
/// Equivalent to `Number((count / fps).toFixed(2))`. Returns `None` when the
/// legacy UI would leave the value unchanged (`fps <= 0` or `count == 0`).
#[must_use]
pub fn duration_for_fps(frame_count: usize, fps: f64) -> Option<f64> {
    if frame_count == 0 || !is_positive(fps) {
        return None;
    }
    Some(legacy_round(frame_count as f64 / fps))
}

/// Legacy coupling: the FPS shown after the user picks a total duration.
///
/// Equivalent to `Number((count / duration).toFixed(2))`. Returns `None` when
/// the legacy UI would leave the value unchanged.
#[must_use]
pub fn fps_for_duration(frame_count: usize, duration_secs: f64) -> Option<f64> {
    if frame_count == 0 || !is_positive(duration_secs) {
        return None;
    }
    Some(legacy_round(frame_count as f64 / duration_secs))
}

/// Shape of the output timeline: how many source frames, how many blend
/// frames between neighbours, and how long the first/last frames are held.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineSpec {
    /// Number of source photos.
    pub source_frames: usize,
    /// Blend frames inserted between each pair of consecutive photos.
    pub crossfade_frames: u32,
    /// Extra time the first photo stays on screen, in seconds.
    pub hold_first_secs: f64,
    /// Extra time the last photo stays on screen, in seconds.
    pub hold_last_secs: f64,
}

impl TimelineSpec {
    /// A timeline without crossfades or holds (the legacy behaviour).
    #[must_use]
    pub fn plain(source_frames: usize) -> Self {
        Self {
            source_frames,
            crossfade_frames: 0,
            hold_first_secs: 0.0,
            hold_last_secs: 0.0,
        }
    }

    /// Frames that carry content: every photo once plus all blend frames.
    #[must_use]
    pub fn content_frames(&self) -> u64 {
        let n = self.source_frames as u64;
        n + n.saturating_sub(1) * u64::from(self.crossfade_frames)
    }

    /// Number of repeated frames for the first and last holds at `fps`.
    #[must_use]
    pub fn hold_frames(&self, fps: f64) -> (u64, u64) {
        (
            secs_to_frames(self.hold_first_secs, fps),
            secs_to_frames(self.hold_last_secs, fps),
        )
    }

    /// Total number of encoded frames at `fps`.
    #[must_use]
    pub fn total_frames(&self, fps: f64) -> u64 {
        if self.source_frames == 0 {
            return 0;
        }
        let (first, last) = self.hold_frames(fps);
        self.content_frames() + first + last
    }

    fn holds_secs(&self) -> f64 {
        self.hold_first_secs.max(0.0) + self.hold_last_secs.max(0.0)
    }

    /// Duration (2-decimal, legacy rounding) of the video at `fps`.
    ///
    /// With no crossfade/holds this equals [`duration_for_fps`].
    #[must_use]
    pub fn duration_for_fps(&self, fps: f64) -> Option<f64> {
        if self.source_frames == 0 || !is_positive(fps) {
            return None;
        }
        Some(legacy_round(self.total_frames(fps) as f64 / fps))
    }

    /// FPS (2-decimal, legacy rounding) that makes the video last `duration_secs`.
    ///
    /// Holds are fixed in seconds, so they are subtracted first; returns `None`
    /// when the holds alone are at least as long as the requested duration.
    /// With no crossfade/holds this equals [`fps_for_duration`].
    #[must_use]
    pub fn fps_for_duration(&self, duration_secs: f64) -> Option<f64> {
        if self.source_frames == 0 || !duration_secs.is_finite() {
            return None;
        }
        let content_secs = duration_secs - self.holds_secs();
        if !is_positive(content_secs) {
            return None;
        }
        Some(legacy_round(self.content_frames() as f64 / content_secs))
    }

    /// The range of total durations reachable with an FPS inside
    /// [`MIN_FPS`, `MAX_FPS`], intersected with the UI range
    /// [`MIN_DURATION_SECS`, `MAX_DURATION_SECS`]. `None` if empty.
    ///
    /// The UI uses this to bound its duration slider.
    #[must_use]
    pub fn feasible_duration_range(&self) -> Option<(f64, f64)> {
        if self.source_frames == 0 {
            return None;
        }
        let content = self.content_frames() as f64;
        let lo = (content / MAX_FPS + self.holds_secs()).max(MIN_DURATION_SECS);
        let hi = (content / MIN_FPS + self.holds_secs()).min(MAX_DURATION_SECS);
        (lo <= hi).then_some((lo, hi))
    }
}

fn secs_to_frames(secs: f64, fps: f64) -> u64 {
    if !is_positive(secs) || !is_positive(fps) {
        return 0;
    }
    // Saturating float-to-int conversion; bounded by option validation anyway.
    (secs * fps).round() as u64
}

/// An exact rational frame rate (`num / den` frames per second) plus the MP4
/// track timescale and per-sample duration derived from it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FrameRate {
    /// Numerator of the reduced fraction.
    pub num: u32,
    /// Denominator of the reduced fraction.
    pub den: u32,
}

/// Minimum MP4 media timescale; small timescales confuse some editors.
const MIN_TIMESCALE: u32 = 10_000;

impl FrameRate {
    /// Converts a frame rate with at most two decimals (as produced by the
    /// legacy rounding) into an exact fraction. Returns `None` if `fps` is
    /// not positive and finite or too large.
    #[must_use]
    pub fn from_fps(fps: f64) -> Option<Self> {
        if !is_positive(fps) || fps > 100_000.0 {
            return None;
        }
        let centi = (fps * 100.0).round() as u32;
        if centi == 0 {
            return None;
        }
        let g = gcd(centi, 100);
        Some(Self {
            num: centi / g,
            den: 100 / g,
        })
    }

    /// Frames per second as a float.
    #[must_use]
    pub fn as_f64(self) -> f64 {
        f64::from(self.num) / f64::from(self.den)
    }

    /// `(timescale, sample_delta)` for an MP4 track so that
    /// `timescale / sample_delta == num / den` exactly and the timescale is at
    /// least [`MIN_TIMESCALE`] (for 30 fps this yields ffmpeg's 15360 / 512).
    #[must_use]
    pub fn mp4_timescale(self) -> (u32, u32) {
        let mut mult = 1u32;
        while self.num.saturating_mul(mult) < MIN_TIMESCALE {
            mult *= 2;
        }
        (self.num * mult, self.den * mult)
    }
}

fn gcd(a: u32, b: u32) -> u32 {
    if b == 0 { a } else { gcd(b, a % b) }
}

/// Easing applied to crossfade blend weights.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Easing {
    /// Constant-speed dissolve.
    Linear,
    /// Smoothstep: slow in, slow out. Feels calmer for faces.
    #[default]
    EaseInOut,
}

impl Easing {
    /// Maps linear progress `t` in `[0, 1]` to blend weight in `[0, 1]`.
    #[must_use]
    pub fn apply(self, t: f32) -> f32 {
        let t = t.clamp(0.0, 1.0);
        match self {
            Self::Linear => t,
            Self::EaseInOut => t * t * (3.0 - 2.0 * t),
        }
    }
}

/// What a single output frame shows.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum FrameRef {
    /// Source photo `index` exactly (also used for holds).
    Key(usize),
    /// A dissolve from photo `from` to photo `from + 1`; `weight` is the
    /// share of the later photo (strictly between 0 and 1).
    Blend {
        /// Index of the earlier photo.
        from: usize,
        /// Share of the later photo in `(0, 1)`.
        weight: f32,
    },
}

/// The fully resolved output timeline.
#[derive(Debug, Clone, PartialEq)]
pub struct Timeline {
    /// Number of source photos.
    pub source_frames: usize,
    /// Blend frames between neighbours.
    pub crossfade_frames: u32,
    /// Easing for blend weights.
    pub easing: Easing,
    /// Repeats of the first photo before the content.
    pub hold_first_frames: u64,
    /// Repeats of the last photo after the content.
    pub hold_last_frames: u64,
}

impl Timeline {
    /// Total encoded frames.
    #[must_use]
    pub fn total_frames(&self) -> u64 {
        let spec = TimelineSpec {
            source_frames: self.source_frames,
            crossfade_frames: self.crossfade_frames,
            hold_first_secs: 0.0,
            hold_last_secs: 0.0,
        };
        if self.source_frames == 0 {
            return 0;
        }
        spec.content_frames() + self.hold_first_frames + self.hold_last_frames
    }

    /// Iterates over every output frame in presentation order.
    pub fn frames(&self) -> impl Iterator<Item = FrameRef> + '_ {
        let n = self.source_frames;
        let c = self.crossfade_frames;
        let head = std::iter::repeat_n(FrameRef::Key(0), self.hold_first_frames as usize);
        let body = (0..n).flat_map(move |i| {
            let blends = if i + 1 < n { c } else { 0 };
            std::iter::once(FrameRef::Key(i)).chain((0..blends).map(move |k| FrameRef::Blend {
                from: i,
                weight: self.easing.apply((k + 1) as f32 / (c + 1) as f32),
            }))
        });
        let tail = std::iter::repeat_n(
            FrameRef::Key(n.saturating_sub(1)),
            if n == 0 {
                0
            } else {
                self.hold_last_frames as usize
            },
        );
        head.chain(body).chain(tail)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spec_rates_need_photos_and_a_finite_duration() {
        assert_eq!(TimelineSpec::plain(0).fps_for_duration(10.0), None);
        assert_eq!(TimelineSpec::plain(5).fps_for_duration(f64::NAN), None);
        assert!(TimelineSpec::plain(5).fps_for_duration(1.0).is_some());
    }

    // Vectors generated with node: Number((n / x).toFixed(2)).
    const FPS_TO_DURATION: &[(usize, f64, f64)] = &[
        (3593, 1.0, 3593.0),
        (3593, 7.0, 513.29),
        (3593, 10.0, 359.3),
        (3593, 24.0, 149.71),
        (3593, 29.97, 119.89),
        (3593, 30.0, 119.77),
        (3593, 60.0, 59.88),
        (300, 7.0, 42.86),
        (300, 29.97, 10.01),
        (300, 33.0, 9.09),
        (2, 24.0, 0.08),
        (2, 29.97, 0.07),
        (7, 60.0, 0.12),
        (1000, 24.0, 41.67),
        (1000, 29.97, 33.37),
        (1000, 60.0, 16.67),
    ];
    const DURATION_TO_FPS: &[(usize, f64, f64)] = &[
        (3593, 3.0, 1197.67),
        (3593, 13.0, 276.38),
        (3593, 59.0, 60.9),
        (3593, 60.0, 59.88),
        (3593, 90.0, 39.92),
        (3593, 119.0, 30.19),
        (3593, 120.0, 29.94),
        (300, 13.0, 23.08),
        (300, 59.0, 5.08),
        (300, 90.0, 3.33),
        (300, 119.0, 2.52),
        (2, 3.0, 0.67),
        (2, 90.0, 0.02),
        (7, 13.0, 0.54),
        (1000, 59.0, 16.95),
        (1000, 119.0, 8.4),
        (1000, 120.0, 8.33),
    ];

    #[test]
    fn js_to_fixed_matches_javascript_including_binary_ties() {
        let cases = [
            (1.005, 1.0),
            (1.255, 1.25),
            (0.125, 0.13),
            (2.675, 2.67),
            (1.45, 1.45),
            (8.345, 8.35),
            (0.005, 0.01),
            (123.455, 123.45),
            (9.999, 10.0),
            (99.995, 100.0),
            (0.0, 0.0),
        ];
        for (x, want) in cases {
            assert_eq!(js_to_fixed(x, 2), want, "toFixed({x}, 2)");
        }
        assert_eq!(js_to_fixed(2.5, 0), 3.0);
        assert_eq!(js_to_fixed(-0.125, 2), -0.13);
        assert!(js_to_fixed(f64::NAN, 2).is_nan());
        assert_eq!(js_to_fixed(f64::INFINITY, 2), f64::INFINITY);
    }

    #[test]
    fn legacy_coupling_matches_node_vectors() {
        for &(n, fps, want) in FPS_TO_DURATION {
            assert_eq!(
                duration_for_fps(n, fps),
                Some(want),
                "{n} frames @ {fps} fps"
            );
        }
        for &(n, d, want) in DURATION_TO_FPS {
            assert_eq!(fps_for_duration(n, d), Some(want), "{n} frames in {d}s");
        }
    }

    #[test]
    fn legacy_coupling_rejects_what_the_ui_ignores() {
        assert_eq!(duration_for_fps(0, 10.0), None);
        assert_eq!(duration_for_fps(10, 0.0), None);
        assert_eq!(duration_for_fps(10, -1.0), None);
        assert_eq!(duration_for_fps(10, f64::NAN), None);
        assert_eq!(fps_for_duration(0, 10.0), None);
        assert_eq!(fps_for_duration(10, 0.0), None);
        assert_eq!(fps_for_duration(10, f64::INFINITY), None);
    }

    #[test]
    fn plain_timeline_spec_reduces_to_legacy_functions() {
        for &(n, fps, _) in FPS_TO_DURATION {
            assert_eq!(
                TimelineSpec::plain(n).duration_for_fps(fps),
                duration_for_fps(n, fps)
            );
        }
        for &(n, d, _) in DURATION_TO_FPS {
            assert_eq!(
                TimelineSpec::plain(n).fps_for_duration(d),
                fps_for_duration(n, d)
            );
        }
    }

    #[test]
    fn crossfade_and_holds_extend_the_duration() {
        let spec = TimelineSpec {
            source_frames: 300,
            crossfade_frames: 2,
            hold_first_secs: 0.5,
            hold_last_secs: 1.5,
        };
        // 300 photos + 299 * 2 blends = 898 content frames.
        assert_eq!(spec.content_frames(), 898);
        assert_eq!(spec.hold_frames(30.0), (15, 45));
        assert_eq!(spec.total_frames(30.0), 958);
        assert_eq!(spec.duration_for_fps(30.0), Some(31.93));
        // Inverse: 898 frames must fit in 30 - 2 = 28 seconds.
        assert_eq!(spec.fps_for_duration(30.0), Some(32.07));
        assert_eq!(spec.fps_for_duration(2.0), None);
        assert_eq!(spec.fps_for_duration(1.0), None);
    }

    #[test]
    fn round_trip_through_coupling_is_close() {
        let spec = TimelineSpec {
            source_frames: 3593,
            crossfade_frames: 1,
            hold_first_secs: 0.0,
            hold_last_secs: 2.0,
        };
        let fps = spec.fps_for_duration(120.0).unwrap();
        let back = spec.duration_for_fps(fps).unwrap();
        assert!((back - 120.0).abs() < 0.05, "{fps} fps -> {back}s");
    }

    #[test]
    fn feasible_duration_range_respects_fps_and_ui_limits() {
        let (lo, hi) = TimelineSpec::plain(3593).feasible_duration_range().unwrap();
        assert!((lo - 3593.0 / 60.0).abs() < 1e-9);
        assert_eq!(hi, MAX_DURATION_SECS);
        let (lo, hi) = TimelineSpec::plain(30).feasible_duration_range().unwrap();
        assert_eq!((lo, hi), (MIN_DURATION_SECS, 30.0));
        assert_eq!(TimelineSpec::plain(0).feasible_duration_range(), None);
        let too_many = TimelineSpec::plain(60 * 121);
        assert_eq!(too_many.feasible_duration_range(), None);
        assert_eq!(TimelineSpec::plain(0).total_frames(30.0), 0);
        assert_eq!(TimelineSpec::plain(0).duration_for_fps(30.0), None);
    }

    #[test]
    fn frame_rate_fraction_and_timescale_are_exact() {
        let r = FrameRate::from_fps(30.0).unwrap();
        assert_eq!((r.num, r.den), (30, 1));
        assert_eq!(r.mp4_timescale(), (15360, 512));
        let r = FrameRate::from_fps(29.97).unwrap();
        assert_eq!((r.num, r.den), (2997, 100));
        let (ts, delta) = r.mp4_timescale();
        assert_eq!(u64::from(ts) * 100, u64::from(delta) * 2997);
        assert!(ts >= MIN_TIMESCALE);
        let r = FrameRate::from_fps(12.5).unwrap();
        assert_eq!((r.num, r.den), (25, 2));
        assert!((r.as_f64() - 12.5).abs() < f64::EPSILON);
        assert_eq!(FrameRate::from_fps(0.0), None);
        assert_eq!(FrameRate::from_fps(0.001), None);
        assert_eq!(FrameRate::from_fps(f64::NAN), None);
    }

    #[test]
    fn easing_curves_are_monotonic_and_bounded() {
        for easing in [Easing::Linear, Easing::EaseInOut] {
            assert_eq!(easing.apply(0.0), 0.0);
            assert_eq!(easing.apply(1.0), 1.0);
            assert_eq!(easing.apply(-3.0), 0.0);
            let mut prev = 0.0;
            for i in 1..=100 {
                let w = easing.apply(i as f32 / 100.0);
                assert!(w >= prev);
                prev = w;
            }
        }
        assert!((Easing::EaseInOut.apply(0.5) - 0.5).abs() < 1e-6);
        assert!(Easing::EaseInOut.apply(0.25) < 0.25);
    }

    #[test]
    fn timeline_orders_holds_keys_and_blends() {
        let t = Timeline {
            source_frames: 3,
            crossfade_frames: 1,
            easing: Easing::Linear,
            hold_first_frames: 2,
            hold_last_frames: 1,
        };
        let frames: Vec<FrameRef> = t.frames().collect();
        assert_eq!(
            frames,
            vec![
                FrameRef::Key(0),
                FrameRef::Key(0),
                FrameRef::Key(0),
                FrameRef::Blend {
                    from: 0,
                    weight: 0.5
                },
                FrameRef::Key(1),
                FrameRef::Blend {
                    from: 1,
                    weight: 0.5
                },
                FrameRef::Key(2),
                FrameRef::Key(2),
            ]
        );
        assert_eq!(t.total_frames(), frames.len() as u64);
    }

    #[test]
    fn single_frame_and_empty_timelines() {
        let one = Timeline {
            source_frames: 1,
            crossfade_frames: 5,
            easing: Easing::EaseInOut,
            hold_first_frames: 0,
            hold_last_frames: 0,
        };
        assert_eq!(one.frames().collect::<Vec<_>>(), vec![FrameRef::Key(0)]);
        let empty = Timeline {
            source_frames: 0,
            hold_last_frames: 4,
            ..one
        };
        assert_eq!(empty.frames().count(), 0);
        assert_eq!(empty.total_frames(), 0);
    }
}
