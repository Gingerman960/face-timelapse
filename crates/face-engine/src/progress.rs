//! Cooperative cancellation and progress reporting for long jobs.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

/// Shared cancellation flag. Cloning shares the flag.
#[derive(Debug, Clone, Default)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    /// A fresh, un-cancelled token.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Requests cancellation.
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Relaxed);
    }

    /// True once [`CancelToken::cancel`] was called.
    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Relaxed)
    }

    /// The underlying flag (e.g. to share with another crate's token type).
    #[must_use]
    pub fn flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.0)
    }

    /// Wraps an existing flag.
    #[must_use]
    pub fn from_flag(flag: Arc<AtomicBool>) -> Self {
        Self(flag)
    }
}

/// Receives progress events. Implemented for every `Fn(E) + Sync`, so a
/// closure can be passed directly. Called from worker threads; throttling is
/// the receiver's job (events can arrive thousands of times per second).
pub trait ProgressSink<E>: Sync {
    /// Handles one event.
    fn report(&self, event: E);
}

impl<E, F: Fn(E) + Sync> ProgressSink<E> for F {
    fn report(&self, event: E) {
        self(event);
    }
}

/// A sink that drops everything.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoProgress;

impl<E> ProgressSink<E> for NoProgress {
    fn report(&self, _event: E) {}
}

/// Rate/ETA estimator over the work actually performed in this run.
#[derive(Debug, Clone, Copy)]
pub struct Throughput {
    started: Instant,
}

impl Default for Throughput {
    fn default() -> Self {
        Self::start()
    }
}

impl Throughput {
    /// Starts the clock.
    #[must_use]
    pub fn start() -> Self {
        Self {
            started: Instant::now(),
        }
    }

    /// Time since start.
    #[must_use]
    pub fn elapsed(&self) -> Duration {
        self.started.elapsed()
    }

    /// Items per second for `done` items.
    #[must_use]
    pub fn rate(&self, done: usize) -> f64 {
        rate(done, self.elapsed())
    }

    /// Remaining time for `remaining` items at the current rate.
    #[must_use]
    pub fn eta(&self, done: usize, remaining: usize) -> Option<Duration> {
        eta(self.rate(done), remaining)
    }
}

/// Items per second (0 when nothing happened yet).
#[must_use]
pub fn rate(done: usize, elapsed: Duration) -> f64 {
    let secs = elapsed.as_secs_f64();
    if done == 0 || secs <= 0.0 {
        return 0.0;
    }
    #[allow(clippy::cast_precision_loss)]
    let d = done as f64;
    d / secs
}

/// ETA at `rate` items/s (`None` when the rate is unknown).
#[must_use]
pub fn eta(rate: f64, remaining: usize) -> Option<Duration> {
    if remaining == 0 {
        return Some(Duration::ZERO);
    }
    if !(rate > 0.0 && rate.is_finite()) {
        return None;
    }
    #[allow(clippy::cast_precision_loss)]
    let r = remaining as f64;
    Some(Duration::from_secs_f64(r / rate))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[test]
    fn cancel_token_is_shared() {
        let t = CancelToken::new();
        let c = t.clone();
        assert!(!c.is_cancelled());
        t.cancel();
        assert!(c.is_cancelled());
        let from = CancelToken::from_flag(t.flag());
        assert!(from.is_cancelled());
    }

    #[test]
    fn closures_are_sinks() {
        let seen = Mutex::new(Vec::new());
        let sink = |e: u32| seen.lock().expect("lock").push(e);
        sink.report(3);
        ProgressSink::<u32>::report(&NoProgress, 4);
        assert_eq!(*seen.lock().expect("lock"), vec![3]);
    }

    #[test]
    fn rates_and_etas() {
        assert_eq!(rate(0, Duration::from_secs(1)), 0.0);
        assert_eq!(rate(10, Duration::ZERO), 0.0);
        assert!((rate(10, Duration::from_secs(2)) - 5.0).abs() < 1e-12);
        assert_eq!(eta(5.0, 10), Some(Duration::from_secs(2)));
        assert_eq!(eta(0.0, 10), None);
        assert_eq!(eta(0.0, 0), Some(Duration::ZERO));
        let t = Throughput::default();
        assert!(t.elapsed() < Duration::from_secs(5));
        assert!(t.rate(0) == 0.0);
        assert!(t.eta(0, 5).is_none());
    }
}
