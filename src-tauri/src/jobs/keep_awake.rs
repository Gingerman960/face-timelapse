//! Keeps macOS from napping the app while it works.
//!
//! App Nap lowers an occluded (or screen-locked) app to background priority
//! (`ps` PRI 4, nice 5 — "darwinbg"), which stalled a scan and slowed
//! aligning to ~3 frames/s in QA. While a [`KeepAwake`] lives, the process
//! holds a user-initiated `NSProcessInfo` activity (`NSActivityUserInitiated`,
//! which also keeps the system from idle-sleeping), so long jobs run at full
//! speed in the background. It is held for every job and for add-photo
//! analysis, and ends on every path: the guard is a local of the job thread,
//! dropped on success, failure, cancellation and panic.
//!
//! Without `unsafe` (the shell forbids it): `performActivityWithOptions:
//! reason:usingBlock:` runs a block synchronously between `beginActivity…`
//! and `endActivity:`; a small thread runs it with a block that waits until
//! the guard is dropped. Elsewhere the guard does nothing.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

/// Activities currently held, process-wide.
static HELD: AtomicUsize = AtomicUsize::new(0);

/// Holds a user-initiated activity until dropped (no-op off macOS).
#[derive(Debug)]
#[must_use = "the activity ends when the guard is dropped"]
pub struct KeepAwake {
    inner: imp::Activity,
    /// True from the activity's start to its end.
    held: Arc<AtomicBool>,
}

impl KeepAwake {
    /// Begins the activity; `reason` is shown by `pmset -g assertions`.
    /// Returns once it is held (a failure to start is logged, not fatal).
    pub fn begin(reason: &'static str) -> Self {
        let held = Arc::new(AtomicBool::new(false));
        Self {
            inner: imp::begin(reason, Arc::clone(&held)),
            held,
        }
    }

    /// Whether the activity is held (false only if it could not start).
    #[must_use]
    pub fn is_held(&self) -> bool {
        self.held.load(Ordering::SeqCst)
    }
}

impl Drop for KeepAwake {
    fn drop(&mut self) {
        imp::end(&mut self.inner);
    }
}

/// Number of activities held right now, process-wide.
#[must_use]
pub fn held() -> usize {
    HELD.load(Ordering::SeqCst)
}

/// Marks an activity held or ended (both the flag and the count).
fn set_held(flag: &AtomicBool, on: bool) {
    if flag.swap(on, Ordering::SeqCst) != on {
        if on {
            HELD.fetch_add(1, Ordering::SeqCst);
        } else {
            HELD.fetch_sub(1, Ordering::SeqCst);
        }
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use std::sync::atomic::AtomicBool;
    use std::sync::{Arc, mpsc};
    use std::thread::JoinHandle;

    use block2::RcBlock;
    use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};

    use super::set_held;

    #[derive(Debug)]
    pub struct Activity {
        /// Dropping it lets the activity's block return.
        stop: Option<mpsc::Sender<()>>,
        thread: Option<JoinHandle<()>>,
    }

    /// How long a job waits for the activity to begin before running without it.
    const BEGIN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

    pub fn begin(reason: &'static str, held: Arc<AtomicBool>) -> Activity {
        let (stop, stopped) = mpsc::channel::<()>();
        let (began, wait_began) = mpsc::channel::<()>();
        let spawned = std::thread::Builder::new()
            .name("ft-keep-awake".into())
            .spawn(move || {
                let block = RcBlock::new(move || {
                    set_held(&held, true);
                    let _ = began.send(());
                    // Returns when the guard drops its sender.
                    let _ = stopped.recv();
                    set_held(&held, false);
                });
                // Deliberately `UserInitiated`, not `…AllowingIdleSystemSleep`:
                // every job is started by the user and waited for (an hour-long
                // scan or export), so the Mac must not idle-sleep mid-job any
                // more than the app may be napped. The activity ends with it.
                NSProcessInfo::processInfo().performActivityWithOptions_reason_usingBlock(
                    NSActivityOptions::UserInitiated,
                    &NSString::from_str(reason),
                    &block,
                );
            });
        // Not fatal either way: the job then runs as before, App Nap allowed.
        let thread = spawned
            .inspect_err(|e| log::warn!("no keep-awake activity: {e}"))
            .ok()
            .filter(|_| {
                let began = wait_began.recv_timeout(BEGIN_TIMEOUT);
                began
                    .inspect_err(|e| log::warn!("keep-awake activity did not start: {e}"))
                    .is_ok()
            });
        Activity {
            stop: thread.is_some().then_some(stop),
            thread,
        }
    }

    pub fn end(activity: &mut Activity) {
        drop(activity.stop.take());
        let panicked = activity.thread.take().is_some_and(|t| t.join().is_err());
        if panicked {
            log::warn!("the keep-awake activity thread panicked");
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use std::sync::Arc;
    use std::sync::atomic::AtomicBool;

    use super::set_held;

    #[derive(Debug)]
    pub struct Activity(Arc<AtomicBool>);

    pub fn begin(_reason: &'static str, held: Arc<AtomicBool>) -> Activity {
        set_held(&held, true);
        Activity(held)
    }

    pub fn end(activity: &mut Activity) {
        set_held(&activity.0, false);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_activity_is_held_until_the_guard_drops() {
        let a = KeepAwake::begin("FaceTimelapse test");
        assert!(a.is_held(), "held once begin returns");
        assert!(held() >= 1);
        let b = KeepAwake::begin("FaceTimelapse test");
        assert!(a.is_held() && b.is_held(), "independent activities");
        let flag = Arc::clone(&a.held);
        drop(a);
        assert!(
            !flag.load(Ordering::SeqCst),
            "ended once the guard is dropped"
        );
        assert!(b.is_held());
    }

    #[test]
    fn ending_twice_or_never_starting_changes_nothing() {
        let flag = AtomicBool::new(false);
        set_held(&flag, false);
        assert!(!flag.load(Ordering::SeqCst));
        set_held(&flag, true);
        set_held(&flag, true);
        assert!(flag.load(Ordering::SeqCst));
        set_held(&flag, false);
        set_held(&flag, false);
        assert!(!flag.load(Ordering::SeqCst));
    }

    #[test]
    fn a_panic_still_ends_the_activity() {
        let (tx, rx) = std::sync::mpsc::channel();
        let r = std::panic::catch_unwind(move || {
            let awake = KeepAwake::begin("FaceTimelapse test");
            let _ = tx.send(Arc::clone(&awake.held));
            panic!("job failed");
        });
        assert!(r.is_err());
        let flag = rx.recv().expect("flag");
        assert!(!flag.load(Ordering::SeqCst));
    }
}
