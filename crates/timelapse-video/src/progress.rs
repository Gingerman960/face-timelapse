//! Progress reporting and cooperative cancellation.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde::Serialize;

/// Cooperative cancellation flag shared between the UI and the encoder.
///
/// Cloning is cheap; all clones observe the same flag.
#[derive(Debug, Clone, Default)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    /// A fresh, not-cancelled token.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Wraps an existing flag (e.g. one owned by the Tauri layer).
    #[must_use]
    pub fn from_flag(flag: Arc<AtomicBool>) -> Self {
        Self(flag)
    }

    /// Requests cancellation. The encoder stops within about one frame and
    /// removes its partial output.
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }

    /// True once [`CancelToken::cancel`] was called.
    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}

/// A progress snapshot, serialisable for the UI.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    /// Frames encoded so far.
    pub frames_done: u64,
    /// Frames in the finished video.
    pub frames_total: u64,
    /// Seconds of video encoded so far.
    pub encoded_secs: f64,
    /// Duration of the finished video in seconds.
    pub total_secs: f64,
    /// Wall-clock seconds since encoding started.
    pub elapsed_secs: f64,
    /// Estimated seconds remaining (`None` until the first frame is done).
    pub eta_secs: Option<f64>,
    /// Encoding speed in frames per second.
    pub frames_per_sec: f64,
}

impl Progress {
    /// Completion in `[0, 1]`.
    #[must_use]
    pub fn fraction(&self) -> f64 {
        if self.frames_total == 0 {
            0.0
        } else {
            self.frames_done as f64 / self.frames_total as f64
        }
    }
}

/// Minimum time between progress callbacks (the last frame always reports).
pub const PROGRESS_INTERVAL: Duration = Duration::from_millis(50);

/// Turns frame counts into throttled [`Progress`] snapshots.
#[derive(Debug)]
pub(crate) struct ProgressTracker {
    start: Instant,
    last_emit: Option<Instant>,
    frames_total: u64,
    fps: f64,
    interval: Duration,
}

impl ProgressTracker {
    pub(crate) fn new(frames_total: u64, fps: f64, interval: Duration) -> Self {
        Self {
            start: Instant::now(),
            last_emit: None,
            frames_total,
            fps,
            interval,
        }
    }

    /// Snapshot for `frames_done` regardless of throttling.
    pub(crate) fn snapshot(&self, frames_done: u64) -> Progress {
        self.snapshot_after(frames_done, self.start.elapsed().as_secs_f64())
    }

    /// [`ProgressTracker::snapshot`] at `elapsed` seconds since the start.
    fn snapshot_after(&self, frames_done: u64, elapsed: f64) -> Progress {
        let speed = if elapsed > 0.0 {
            frames_done as f64 / elapsed
        } else {
            0.0
        };
        let remaining = self.frames_total.saturating_sub(frames_done);
        let eta = (frames_done > 0 && speed > 0.0).then(|| remaining as f64 / speed);
        Progress {
            frames_done,
            frames_total: self.frames_total,
            encoded_secs: frames_done as f64 / self.fps,
            total_secs: self.frames_total as f64 / self.fps,
            elapsed_secs: elapsed,
            eta_secs: eta,
            frames_per_sec: speed,
        }
    }

    /// A snapshot if enough time passed since the last one, or if this is
    /// the first or final frame.
    pub(crate) fn update(&mut self, frames_done: u64) -> Option<Progress> {
        let now = Instant::now();
        let due = match self.last_emit {
            None => true,
            Some(last) => now.duration_since(last) >= self.interval,
        };
        if due || frames_done >= self.frames_total {
            self.last_emit = Some(now);
            Some(self.snapshot(frames_done))
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancel_token_is_shared_between_clones() {
        let token = CancelToken::new();
        let clone = token.clone();
        assert!(!clone.is_cancelled());
        token.cancel();
        assert!(clone.is_cancelled());
        let flag = Arc::new(AtomicBool::new(true));
        assert!(CancelToken::from_flag(flag).is_cancelled());
    }

    #[test]
    fn tracker_throttles_but_always_reports_first_and_last() {
        let mut t = ProgressTracker::new(10, 5.0, Duration::from_secs(3600));
        let first = t.update(1).unwrap();
        assert_eq!(first.frames_done, 1);
        assert!((first.encoded_secs - 0.2).abs() < 1e-9);
        assert!((first.total_secs - 2.0).abs() < 1e-9);
        assert!(t.update(2).is_none());
        assert!(t.update(9).is_none());
        let last = t.update(10).unwrap();
        assert!((last.fraction() - 1.0).abs() < 1e-12);
        assert_eq!(last.eta_secs.map(|e| e == 0.0), Some(true));
    }

    #[test]
    fn no_speed_or_eta_before_any_time_has_passed() {
        let t = ProgressTracker::new(10, 5.0, Duration::ZERO);
        let p = t.snapshot_after(5, 0.0);
        assert_eq!((p.frames_per_sec, p.eta_secs), (0.0, None));
        let later = t.snapshot_after(5, 2.0);
        assert_eq!((later.frames_per_sec, later.eta_secs), (2.5, Some(2.0)));
    }

    #[test]
    fn eta_is_unknown_before_the_first_frame() {
        let t = ProgressTracker::new(10, 5.0, Duration::ZERO);
        let p = t.snapshot(0);
        assert_eq!(p.eta_secs, None);
        assert_eq!(p.fraction(), 0.0);
        let empty = ProgressTracker::new(0, 5.0, Duration::ZERO).snapshot(0);
        assert_eq!(empty.fraction(), 0.0);
        std::thread::sleep(Duration::from_millis(5));
        let p = t.snapshot(5);
        assert!(p.eta_secs.unwrap() > 0.0);
        assert!(p.frames_per_sec > 0.0);
        let json = serde_json::to_string(&p).unwrap();
        assert!(json.contains("\"framesDone\":5"), "{json}");
    }
}
