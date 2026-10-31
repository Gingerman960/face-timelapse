//! Job model (ARCHITECTURE.md §3, D3/D4): at most one running job; jobs
//! return a `JobId` immediately and stream `started → progress* → exactly one
//! of finished | failed | cancelled` over a channel. Progress is throttled to
//! ≤ 20 events/s; `started` and the terminal event are always sent. The
//! registry slot is cleared *before* the terminal event is sent, so a UI that
//! re-queries `get_session` on the terminal event sees `activeJob == null`.

pub mod align;
pub mod export_images;
pub mod export_video;
pub mod keep_awake;
pub mod scan;

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use parking_lot::Mutex;

use crate::error::AppResult;
use crate::ipc::{
    ActiveJob, AlignEvent, ExportImagesEvent, ExportVideoEvent, IpcError, JobCancelled, JobFailed,
    JobId, JobKind, JobStarted, ScanEvent,
};

/// Minimum spacing of progress events (≤ 20/s).
pub const PROGRESS_INTERVAL: Duration = Duration::from_millis(50);
/// Max ids in a progress `recent` list.
pub const MAX_RECENT: usize = 64;

/// Where job events go (a Tauri `Channel` in the app, a `Vec` in tests).
pub trait EventSink<E>: Send + Sync {
    fn send(&self, event: E);
}

impl<E: tauri::ipc::IpcResponse + Send + Sync> EventSink<E> for tauri::ipc::Channel<E> {
    fn send(&self, event: E) {
        if let Err(e) = tauri::ipc::Channel::send(self, event) {
            log::debug!("job event not delivered (webview gone?): {e}");
        }
    }
}

/// Lets generic job plumbing build the shared event variants.
pub trait JobEvent: Send + 'static {
    fn started(s: JobStarted) -> Self;
    fn failed(f: JobFailed) -> Self;
    fn cancelled(c: JobCancelled) -> Self;
}

macro_rules! job_event {
    ($t:ty) => {
        impl JobEvent for $t {
            fn started(s: JobStarted) -> Self {
                Self::Started(s)
            }
            fn failed(f: JobFailed) -> Self {
                Self::Failed(f)
            }
            fn cancelled(c: JobCancelled) -> Self {
                Self::Cancelled(c)
            }
        }
    };
}
job_event!(ScanEvent);
job_event!(AlignEvent);
job_event!(ExportImagesEvent);
job_event!(ExportVideoEvent);

/// The running job.
#[derive(Debug, Clone)]
pub struct RunningJob {
    pub id: JobId,
    pub kind: JobKind,
    pub cancel: Arc<AtomicBool>,
}

/// Holds at most one [`RunningJob`].
#[derive(Debug, Default)]
pub struct JobRegistry {
    current: Mutex<Option<RunningJob>>,
    seq: AtomicU64,
    idle: parking_lot::Condvar,
}

impl JobRegistry {
    #[must_use]
    pub fn active(&self) -> Option<ActiveJob> {
        self.current.lock().as_ref().map(|j| ActiveJob {
            job_id: j.id.clone(),
            kind: j.kind,
        })
    }

    /// Registers a new job.
    ///
    /// # Errors
    /// `busy` while another job runs.
    pub fn start(&self, kind: JobKind) -> AppResult<RunningJob> {
        let mut cur = self.current.lock();
        if cur.is_some() {
            return Err(IpcError::busy());
        }
        let n = self.seq.fetch_add(1, Ordering::Relaxed) + 1;
        let job = RunningJob {
            id: format!("job-{n}"),
            kind,
            cancel: Arc::new(AtomicBool::new(false)),
        };
        *cur = Some(job.clone());
        Ok(job)
    }

    /// Requests cancellation; unknown or finished ids are a no-op.
    pub fn cancel(&self, id: &str) -> bool {
        match self.current.lock().as_ref() {
            Some(j) if j.id == id => {
                j.cancel.store(true, Ordering::Release);
                true
            }
            _ => false,
        }
    }

    /// Clears the slot if it still holds `id`.
    pub fn finish(&self, id: &str) {
        let mut cur = self.current.lock();
        if cur.as_ref().is_some_and(|j| j.id == id) {
            *cur = None;
            self.idle.notify_all();
        }
    }

    /// Cancels the running job, if any.
    pub fn cancel_active(&self) {
        if let Some(j) = self.current.lock().as_ref() {
            j.cancel.store(true, Ordering::Release);
        }
    }

    /// Waits (≤ `timeout`) until no job runs; true if none does.
    pub fn wait_idle(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let mut cur = self.current.lock();
        while cur.is_some() {
            if self.idle.wait_until(&mut cur, deadline).timed_out() {
                return cur.is_none();
            }
        }
        true
    }
}

/// Rate limiter for progress events.
#[derive(Debug)]
pub struct Throttle {
    interval: Duration,
    last: Option<Instant>,
}

impl Throttle {
    #[must_use]
    pub fn new(interval: Duration) -> Self {
        Self {
            interval,
            last: None,
        }
    }

    /// True (and arms the timer) if an event may be sent at `now`.
    pub fn ready(&mut self, now: Instant) -> bool {
        match self.last {
            Some(t) if now.saturating_duration_since(t) < self.interval => false,
            _ => {
                self.last = Some(now);
                true
            }
        }
    }
}

/// How a job body ended without finishing.
#[derive(Debug, Clone, PartialEq)]
pub enum Stop {
    Cancelled { done: u32 },
    Failed(IpcError),
}

impl From<IpcError> for Stop {
    fn from(e: IpcError) -> Self {
        Self::Failed(e)
    }
}

/// Per-job context handed to job bodies.
pub struct JobCtx<E> {
    pub job: RunningJob,
    sink: Arc<dyn EventSink<E>>,
    throttle: Mutex<Throttle>,
    started_at: Instant,
    /// `started` was sent (§7.1: always before the terminal event).
    started: AtomicBool,
}

impl<E: JobEvent> JobCtx<E> {
    #[must_use]
    pub fn new(job: RunningJob, sink: Arc<dyn EventSink<E>>) -> Self {
        Self {
            job,
            sink,
            throttle: Mutex::new(Throttle::new(PROGRESS_INTERVAL)),
            started_at: Instant::now(),
            started: AtomicBool::new(false),
        }
    }

    #[must_use]
    pub fn id(&self) -> JobId {
        self.job.id.clone()
    }

    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.job.cancel.load(Ordering::Acquire)
    }

    #[must_use]
    pub fn elapsed(&self) -> Duration {
        self.started_at.elapsed()
    }

    pub fn send_started(&self, total: u32) {
        self.started.store(true, Ordering::Release);
        self.sink.send(E::started(JobStarted {
            job_id: self.id(),
            total,
        }));
    }

    /// True when a progress event may be sent now (≤ 20/s).
    pub fn progress_due(&self) -> bool {
        self.throttle.lock().ready(Instant::now())
    }

    /// Sends an event unconditionally (callers that throttle themselves).
    pub fn send(&self, event: E) {
        self.sink.send(event);
    }

    /// Sends a progress event built only when due.
    pub fn progress(&self, build: impl FnOnce() -> E) {
        if self.progress_due() {
            self.sink.send(build());
        }
    }
}

/// `etaMs` from items done/remaining and elapsed time (`face_engine::progress`).
#[must_use]
pub fn eta_ms(done: u32, remaining: u32, elapsed: Duration) -> Option<u64> {
    let rate = face_engine::progress::rate(done as usize, elapsed);
    face_engine::progress::eta(rate, remaining as usize)
        .filter(|_| done > 0)
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

/// Items per second, one decimal (`face_engine::progress::rate`).
#[must_use]
pub fn rate(done: u32, elapsed: Duration) -> f64 {
    (face_engine::progress::rate(done as usize, elapsed) * 10.0).round() / 10.0
}

/// Runs `body` on a dedicated job thread (holding a [`keep_awake::KeepAwake`]
/// activity throughout); clears the registry, then sends the terminal event.
/// Panics become `failed{internal}`.
///
/// # Errors
/// `internal` if the thread cannot be spawned (the slot is released).
pub fn spawn_job<E, F>(
    registry: Arc<dyn Fn(&str) + Send + Sync>,
    job: RunningJob,
    sink: Arc<dyn EventSink<E>>,
    body: F,
) -> AppResult<JobId>
where
    E: JobEvent,
    F: FnOnce(&JobCtx<E>) -> Result<E, Stop> + Send + 'static,
{
    let id = job.id.clone();
    let name = format!("ft-job-{:?}", job.kind).to_lowercase();
    let finish = Arc::clone(&registry);
    let job_for_thread = job.clone();
    let spawned = std::thread::Builder::new().name(name).spawn(move || {
        // Full speed while the window is hidden; ends with this thread.
        let _awake = keep_awake::KeepAwake::begin("FaceTimelapse is working on your photos");
        let ctx = JobCtx::new(job_for_thread, Arc::clone(&sink));
        let outcome = catch_unwind(AssertUnwindSafe(|| body(&ctx)));
        let job_id = ctx.id();
        let event = match outcome {
            Ok(Ok(finished)) => finished,
            Ok(Err(Stop::Cancelled { done })) => E::cancelled(JobCancelled {
                job_id: job_id.clone(),
                done,
            }),
            Ok(Err(Stop::Failed(error))) => E::failed(JobFailed {
                job_id: job_id.clone(),
                error,
            }),
            Err(panic) => {
                let what = panic
                    .downcast_ref::<&str>()
                    .map(ToString::to_string)
                    .or_else(|| panic.downcast_ref::<String>().cloned())
                    .unwrap_or_default();
                E::failed(JobFailed {
                    job_id: job_id.clone(),
                    error: IpcError::internal(format!("job panicked: {what}")),
                })
            }
        };
        if !ctx.started.load(Ordering::Acquire) {
            // Failed or cancelled before it could count its work: §7.1
            // still promises `started` first.
            ctx.send_started(0);
        }
        finish(&job_id);
        sink.send(event);
    });
    match spawned {
        Ok(_) => Ok(id),
        Err(e) => {
            registry(&job.id);
            Err(IpcError::internal(format!("cannot spawn job thread: {e}")))
        }
    }
}

/// Records an export in the session — written to disk at once, before any
/// temporary file exists — and removes the record when dropped (job end,
/// failure, cancel or panic). See `Core::clean_pending_outputs`.
pub struct OutputRecord {
    core: Arc<crate::state::Core>,
    path: String,
    keep: std::sync::atomic::AtomicBool,
}

impl OutputRecord {
    #[must_use]
    pub fn new(core: &Arc<crate::state::Core>, path: &std::path::Path, video: bool) -> Self {
        let path = path.to_string_lossy().into_owned();
        core.session
            .write()
            .p
            .pending_outputs
            .push(crate::session::model::PendingOutput {
                path: path.clone(),
                video,
                pid: std::process::id(),
            });
        core.save_session_now();
        Self {
            core: Arc::clone(core),
            path,
            keep: std::sync::atomic::AtomicBool::new(false),
        }
    }

    /// Leaves the record in place for the next start's cleanup (a
    /// temporary file could not be removed).
    pub fn keep_for_cleanup(&self) {
        self.keep.store(true, Ordering::Release);
    }
}

impl Drop for OutputRecord {
    fn drop(&mut self) {
        if self.keep.load(Ordering::Acquire) {
            return;
        }
        self.core
            .session
            .write()
            .p
            .pending_outputs
            .retain(|p| p.path != self.path);
        self.core.mark_dirty();
    }
}

/// Collects events in memory (tests and the dev autoload hook).
pub struct VecSink<E>(pub Mutex<Vec<E>>, pub parking_lot::Condvar);

impl<E> Default for VecSink<E> {
    fn default() -> Self {
        Self(Mutex::new(Vec::new()), parking_lot::Condvar::new())
    }
}

impl<E: Send> EventSink<E> for VecSink<E> {
    fn send(&self, event: E) {
        self.0.lock().push(event);
        self.1.notify_all();
    }
}

impl<E: Clone + Send> VecSink<E> {
    /// Waits (≤ `timeout`) until `pred` holds for the collected events.
    pub fn wait_for(&self, timeout: Duration, pred: impl Fn(&[E]) -> bool) -> Vec<E> {
        let deadline = Instant::now() + timeout;
        let mut events = self.0.lock();
        while !pred(&events) {
            if self.1.wait_until(&mut events, deadline).timed_out() {
                break;
            }
        }
        events.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_enforces_one_job_and_cancels_by_id() {
        let r = JobRegistry::default();
        assert!(r.active().is_none());
        let a = r.start(JobKind::Scan).expect("start");
        assert_eq!(r.start(JobKind::Align).expect_err("busy"), IpcError::busy());
        assert_eq!(r.active().map(|j| j.kind), Some(JobKind::Scan));
        assert!(!r.cancel("job-999"));
        assert!(r.cancel(&a.id));
        assert!(a.cancel.load(Ordering::Acquire));
        r.finish("job-999");
        assert!(r.active().is_some());
        r.finish(&a.id);
        assert!(r.active().is_none());
        assert!(!r.cancel(&a.id), "finished id is a no-op");
        let b = r.start(JobKind::ExportVideo).expect("start again");
        assert_ne!(a.id, b.id);
    }

    #[test]
    fn throttle_limits_rate() {
        let mut t = Throttle::new(Duration::from_millis(50));
        let t0 = Instant::now();
        assert!(t.ready(t0));
        assert!(!t.ready(t0 + Duration::from_millis(49)));
        assert!(t.ready(t0 + Duration::from_millis(50)));
        // 1 s of calls every 1 ms ⇒ ≤ 21 events.
        let mut t = Throttle::new(PROGRESS_INTERVAL);
        let sent = (0..1000)
            .filter(|i| t.ready(t0 + Duration::from_millis(*i)))
            .count();
        assert!(sent <= 21, "{sent}");
    }

    fn run(
        body: impl FnOnce(&JobCtx<ScanEvent>) -> Result<ScanEvent, Stop> + Send + 'static,
    ) -> (Vec<ScanEvent>, Arc<JobRegistry>) {
        let reg = Arc::new(JobRegistry::default());
        let job = reg.start(JobKind::Scan).expect("start");
        let sink = Arc::new(VecSink::<ScanEvent>::default());
        let r2 = Arc::clone(&reg);
        let r3 = Arc::clone(&reg);
        let finish: Arc<dyn Fn(&str) + Send + Sync> = Arc::new(move |id: &str| {
            assert!(r3.active().is_some(), "terminal event after release only");
            r2.finish(id);
        });
        spawn_job(
            finish,
            job,
            sink.clone() as Arc<dyn EventSink<ScanEvent>>,
            body,
        )
        .expect("spawn");
        let events = sink.wait_for(Duration::from_secs(5), |e| {
            e.last().is_some_and(|l| {
                matches!(
                    l,
                    ScanEvent::Finished(_) | ScanEvent::Failed(_) | ScanEvent::Cancelled(_)
                )
            })
        });
        assert!(reg.active().is_none());
        (events, reg)
    }

    #[test]
    fn an_output_record_is_kept_for_cleanup_only_when_asked() {
        let t = crate::testutil::TestCore::new();
        let pending = |t: &crate::testutil::TestCore| t.core.session.read().p.pending_outputs.len();
        drop(OutputRecord::new(
            &t.core,
            &t.root.path().join("a.mp4"),
            true,
        ));
        assert_eq!(pending(&t), 0, "removed when the job ends");
        let kept = OutputRecord::new(&t.core, &t.root.path().join("b.mp4"), true);
        kept.keep_for_cleanup();
        drop(kept);
        assert_eq!(
            pending(&t),
            1,
            "a temporary file is left: the next start cleans it"
        );
    }

    #[test]
    fn a_job_runs_while_an_activity_keeps_the_app_awake() {
        let (ev, _) = run(|ctx| {
            assert!(
                keep_awake::held() >= 1,
                "no App Nap activity during the job"
            );
            Ok(ScanEvent::Cancelled(JobCancelled {
                job_id: ctx.id(),
                done: 0,
            }))
        });
        assert!(matches!(ev.last(), Some(ScanEvent::Cancelled(_))), "{ev:?}");
    }

    #[test]
    fn terminal_event_exactly_once_for_each_outcome() {
        let (ev, _) = run(|ctx| {
            ctx.send_started(1);
            Err(Stop::Cancelled { done: 3 })
        });
        assert!(
            matches!(ev.as_slice(), [ScanEvent::Started(_), ScanEvent::Cancelled(c)] if c.done == 3)
        );
        // Ending before `started` still sends it first (§7.1), with total 0.
        let (ev, _) = run(|_| Err(IpcError::busy().into()));
        assert!(
            matches!(ev.as_slice(), [ScanEvent::Started(s), ScanEvent::Failed(f)]
                if s.total == 0 && f.error.kind == crate::ipc::ErrorKind::Busy)
        );
        let (ev, _) = run(|_| panic!("boom"));
        assert!(
            matches!(ev.as_slice(), [ScanEvent::Started(_), ScanEvent::Failed(f)] if f.error.kind == crate::ipc::ErrorKind::Internal)
        );
        let (ev, _) = run(|ctx| {
            for _ in 0..1000 {
                ctx.progress(|| {
                    ScanEvent::Started(JobStarted {
                        job_id: "x".into(),
                        total: 0,
                    })
                });
            }
            Ok(ScanEvent::Cancelled(JobCancelled {
                job_id: ctx.id(),
                done: 1,
            }))
        });
        assert!(ev.len() <= 4, "progress was throttled: {}", ev.len());
    }

    #[test]
    fn eta_and_rate() {
        assert_eq!(eta_ms(0, 10, Duration::from_secs(1)), None);
        assert_eq!(eta_ms(0, 0, Duration::from_secs(1)), None);
        assert_eq!(eta_ms(10, 0, Duration::from_secs(1)), Some(0));
        assert_eq!(eta_ms(10, 10, Duration::from_secs(1)), Some(1000));
        assert_eq!(rate(10, Duration::from_secs(2)), 5.0);
        assert_eq!(rate(10, Duration::ZERO), 0.0);
    }

    #[test]
    fn job_events_build_variants() {
        let s = JobStarted {
            job_id: "j".into(),
            total: 1,
        };
        assert!(matches!(
            AlignEvent::started(s.clone()),
            AlignEvent::Started(_)
        ));
        assert!(matches!(
            ExportImagesEvent::started(s.clone()),
            ExportImagesEvent::Started(_)
        ));
        assert!(matches!(
            ExportVideoEvent::started(s),
            ExportVideoEvent::Started(_)
        ));
        let c = JobCancelled {
            job_id: "j".into(),
            done: 0,
        };
        assert!(matches!(
            AlignEvent::cancelled(c.clone()),
            AlignEvent::Cancelled(_)
        ));
        let f = JobFailed {
            job_id: "j".into(),
            error: IpcError::busy(),
        };
        assert!(matches!(
            ExportVideoEvent::failed(f),
            ExportVideoEvent::Failed(_)
        ));
        assert!(matches!(
            ExportImagesEvent::cancelled(c),
            ExportImagesEvent::Cancelled(_)
        ));
    }
}
