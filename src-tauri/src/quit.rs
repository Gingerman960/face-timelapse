//! Quitting (ARCHITECTURE.md §3): a running job is cancelled and given a
//! moment to remove its temporary files before the process exits.
//!
//! Two run-loop events can be the last one: `ExitRequested` (the last
//! window closed, `app.exit`) and `Exit`. On macOS, Cmd+Q, the app menu's
//! Quit, the Dock's Quit and logout go through `NSApp terminate:` and reach
//! only `Exit`, so both stop the job; [`crate::state::Core::shutdown`] is
//! idempotent, so the second call costs nothing.

use std::time::Duration;

use tauri::RunEvent;

use crate::state::Core;

/// How long quitting waits for a cancelled job to stop and clean up.
pub const EXIT_JOB_WAIT: Duration = Duration::from_secs(5);

/// Handles a run-loop event for quitting (no-op for every other event).
pub fn on_run_event(core: Option<&Core>, event: &RunEvent) {
    let last = matches!(event, RunEvent::Exit);
    if !(last || matches!(event, RunEvent::ExitRequested { .. })) {
        return;
    }
    if let Some(core) = core {
        // Cancels the job, waits (bounded) for it to clean up, saves.
        core.shutdown(EXIT_JOB_WAIT);
    }
    if last {
        log::logger().flush();
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::ipc::ScanEvent;
    use crate::jobs::VecSink;
    use crate::testutil::{TestCore, is_scan_terminal};

    #[test]
    fn the_final_exit_alone_stops_a_running_job() {
        let t = TestCore::new();
        t.setup();
        t.engine
            .analyze_delay_ms
            .store(30, std::sync::atomic::Ordering::Relaxed);
        let sink = Arc::new(VecSink::<ScanEvent>::default());
        crate::jobs::scan::start(&t.core, sink.clone()).expect("scan");
        sink.wait_for(Duration::from_secs(20), |e| !e.is_empty());
        // macOS Cmd+Q: no `ExitRequested`, only `Exit`.
        on_run_event(Some(&t.core), &RunEvent::Exit);
        assert!(t.core.jobs.active().is_none(), "cancelled and waited for");
        let events = sink.wait_for(Duration::from_secs(20), |e| {
            e.last().is_some_and(is_scan_terminal)
        });
        assert!(
            matches!(events.last(), Some(ScanEvent::Cancelled(_))),
            "{events:?}"
        );
        // Idempotent, and harmless without a core.
        on_run_event(Some(&t.core), &RunEvent::Exit);
        on_run_event(None, &RunEvent::Exit);
    }

    #[test]
    fn other_run_loop_events_leave_a_running_job_alone() {
        let t = TestCore::new();
        let job = t.core.jobs.start(crate::ipc::JobKind::Scan).expect("job");
        for event in [
            RunEvent::Ready,
            RunEvent::Resumed,
            RunEvent::MainEventsCleared,
        ] {
            on_run_event(Some(&t.core), &event);
        }
        assert!(!job.cancel.load(std::sync::atomic::Ordering::Acquire));
        (t.core.job_finisher())(&job.id);
    }
}
