//! `AppState`: the backend core shared by commands, jobs and the protocol.
//!
//! Locking discipline (ARCHITECTURE.md §3): `session` is a `RwLock`; jobs copy
//! inputs under a read lock, compute without locks, apply under short write
//! locks; the session is never locked across I/O. Mutating commands and job
//! starts are serialized by the `gate` so the busy rule (D4) is race-free.
//!
//! Heavy work (scan analysis, align render, export, look LUTs, warps) runs on
//! ONE rayon pool: the global pool, sized here to cores − 1 at startup
//! ([`init_work_pool`]). The engine's loops use whatever pool they are
//! called on, so nothing else creates a competing pool.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;

use face_engine as fe;
use face_engine::geometry::Size;
use parking_lot::{Condvar, Mutex, MutexGuard, RwLock};

use crate::convert;
use crate::engine::Engine;
use crate::error::{AppResult, msg};
use crate::grants::{Access, Grants};
use crate::ipc::{ErrorKind, IpcError, Platform};
use crate::jobs::JobRegistry;
use crate::paths::AppPaths;
use crate::protocol::ProtocolRuntime;
use crate::session::frames::Frames;
use crate::session::persist::Persister;
use crate::session::{Library, Session, reference};

mod restore;

/// Static facts reported by `get_app_info`.
#[derive(Debug, Clone)]
pub struct AppMeta {
    pub version: String,
    pub platform: Platform,
    pub image_base_url: String,
}

impl AppMeta {
    /// Values for the platform this binary was built for.
    #[must_use]
    pub fn current(version: &str) -> Self {
        let platform = if cfg!(target_os = "macos") {
            Platform::Macos
        } else if cfg!(target_os = "windows") {
            Platform::Windows
        } else {
            Platform::Linux
        };
        let image_base_url = if cfg!(target_os = "windows") {
            "http://ftimg.localhost/".to_owned()
        } else {
            "ftimg://localhost/".to_owned()
        };
        Self {
            version: version.to_owned(),
            platform,
            image_base_url,
        }
    }
}

/// How long a mutation waits for another one to finish before `busy`.
/// Bounded rather than immediate: quick changes (a crop drag, keyboard
/// review) legitimately overlap for a few milliseconds, while a long one must
/// never pin the command threads.
pub const GATE_WAIT: Duration = Duration::from_secs(2);
/// How long a command waits for the startup restore before answering
/// without the library (a stale network folder can take minutes); the UI is
/// told with `session-changed` when the restore lands.
pub const RESTORE_WAIT: Duration = Duration::from_secs(3);

/// Unfinished-export records kept for folders that were unreadable at startup.
const MAX_PENDING_OUTPUTS: usize = 64;
/// [`Core::engine_fingerprint`] with no readable models and none remembered:
/// matches no analysis cache or frame store.
const UNKNOWN_ENGINE: &str = "nomodels";

/// Startup restore progress.
#[derive(Default)]
struct RestoreState {
    done: bool,
    /// A waiter gave up before `done` (⇒ announce the restore when it lands).
    timed_out: bool,
}

/// Callback that tells the UI the session changed (`session-changed`).
pub type SessionNotifier = Box<dyn Fn() + Send + Sync>;

/// Backend core.
pub struct Core {
    pub paths: AppPaths,
    pub engine: Arc<dyn Engine>,
    pub session: RwLock<Session>,
    pub jobs: Arc<JobRegistry>,
    pub meta: AppMeta,
    pub protocol: Arc<ProtocolRuntime>,
    /// Paths the user chose (dialogs, drops); see [`Core::granted`].
    pub grants: Grants,
    gate: Mutex<()>,
    persister: Persister,
    restore: Mutex<RestoreState>,
    restored_cv: Condvar,
    /// (gate wait, restore wait); see [`GATE_WAIT`], [`RESTORE_WAIT`].
    waits: Mutex<(Duration, Duration)>,
    notifier: Mutex<Option<SessionNotifier>>,
    /// Bumped by every folder choice; a slower, older one is discarded.
    folder_seq: AtomicU64,
    /// Held while a hand-added photo is analyzed (one at a time).
    adding: Mutex<()>,
    /// The startup model load's failure (v1.6 `AppInfo.modelsError`).
    models_error: Mutex<Option<String>>,
    /// See [`Core::engine_fingerprint`]; saved as `lastEngineFingerprint`.
    last_engine: Mutex<Option<String>>,
    /// [`Core::shutdown`] already waited for the job once.
    shut_down: std::sync::atomic::AtomicBool,
}

/// Managed Tauri state.
pub type AppState = Arc<Core>;

/// Worker threads for heavy work: `max(1, available_parallelism − 1)`.
#[must_use]
pub fn work_threads() -> usize {
    std::thread::available_parallelism()
        .map_or(2, |n| n.get())
        .saturating_sub(1)
        .max(1)
}

/// Sizes the global rayon pool — the app's only pool for heavy work — to
/// [`work_threads`]. Idempotent: if the pool already exists (a second `Core`
/// in tests), it is kept.
pub fn init_work_pool() {
    let built = rayon::ThreadPoolBuilder::new()
        .num_threads(work_threads())
        .thread_name(|i| format!("ft-work-{i}"))
        .build_global();
    if built.is_err() {
        log::debug!("work pool already initialized");
    }
}

impl Core {
    /// Loads `session.json` and starts the persistence writer. Call
    /// [`Core::restore`] (on a background thread) to rebuild the library.
    #[must_use]
    pub fn new(paths: AppPaths, engine: Arc<dyn Engine>, meta: AppMeta) -> Arc<Self> {
        init_work_pool();
        let (mut persisted, writable) =
            crate::session::persist::load_checked(&paths.session_file());
        let last_engine = persisted.last_engine_fingerprint.take();
        Arc::new_cyclic(|weak: &Weak<Self>| {
            let w = weak.clone();
            let persister = Persister::spawn(
                paths.session_file(),
                writable,
                Box::new(move || w.upgrade().map(|c| c.persisted())),
            );
            Self {
                protocol: Arc::new(ProtocolRuntime::new(weak.clone())),
                paths,
                engine,
                session: RwLock::new(Session {
                    p: persisted,
                    ..Session::default()
                }),
                jobs: Arc::new(JobRegistry::default()),
                meta,
                grants: Grants::default(),
                gate: Mutex::new(()),
                persister,
                restore: Mutex::new(RestoreState::default()),
                restored_cv: Condvar::new(),
                waits: Mutex::new((GATE_WAIT, RESTORE_WAIT)),
                notifier: Mutex::new(None),
                folder_seq: AtomicU64::new(0),
                adding: Mutex::new(()),
                models_error: Mutex::new(None),
                last_engine: Mutex::new(last_engine),
                shut_down: std::sync::atomic::AtomicBool::new(false),
            }
        })
    }

    /// Overrides [`GATE_WAIT`] and [`RESTORE_WAIT`] (tests).
    pub fn set_waits(&self, gate: Duration, restore: Duration) {
        *self.waits.lock() = (gate, restore);
    }

    /// Installs the `session-changed` emitter (the app does this at startup).
    pub fn set_session_notifier(&self, notifier: SessionNotifier) {
        *self.notifier.lock() = Some(notifier);
    }

    /// Tells the UI to re-query the session (no-op without a notifier).
    pub fn notify_session_changed(&self) {
        if let Some(notify) = self.notifier.lock().as_ref() {
            notify();
        }
    }

    /// Starts a folder choice; see [`Core::is_latest_folder`].
    pub fn next_folder_seq(&self) -> u64 {
        self.folder_seq.fetch_add(1, Ordering::AcqRel) + 1
    }

    /// True if no folder choice (or reset) started after `seq`.
    #[must_use]
    pub fn is_latest_folder(&self, seq: u64) -> bool {
        self.folder_seq.load(Ordering::Acquire) == seq
    }

    /// What `session.json` holds: the session plus the remembered engine.
    fn persisted(&self) -> crate::session::model::PersistedSession {
        let mut p = self.session.read().p.clone();
        p.last_engine_fingerprint = self.last_engine.lock().clone();
        p
    }

    /// The engine fingerprint analysis caches and frames are keyed by: the
    /// engine's own while its model files are readable (remembered for the
    /// next start), else the one remembered from the last start that had
    /// them. So a start without the models still reads the caches and frames
    /// that engine made — read-only: whatever needs detection fails with
    /// `modelUnavailable`. With neither, a value no cache matches.
    #[must_use]
    pub fn engine_fingerprint(&self) -> String {
        let Some(live) = self.engine.fingerprint() else {
            return self
                .last_engine
                .lock()
                .clone()
                .unwrap_or_else(|| UNKNOWN_ENGINE.to_owned());
        };
        let mut last = self.last_engine.lock();
        if last.as_deref() != Some(live.as_str()) {
            *last = Some(live.clone());
            drop(last);
            self.mark_dirty();
        }
        live
    }

    /// Walks `folder` and joins it with its analysis cache.
    ///
    /// # Errors
    /// The walk's error (missing/unreadable folder).
    pub fn library_of(&self, folder: &Path) -> AppResult<Library> {
        let walk = fe::walk::walk(folder).map_err(|e| crate::error::from_engine(&e))?;
        let (cache, status) = fe::cache::AnalysisCache::load(
            &self.paths.cache_dir,
            folder,
            &self.engine_fingerprint(),
        );
        log::debug!("analysis cache: {status:?}, {} entries", cache.len());
        Ok(Library::from_walk(
            folder.to_path_buf(),
            &walk.files,
            crate::session::count_u32(walk.unsupported.len()),
            |f| cache.lookup(f).cloned(),
        ))
    }

    /// [`Core::library_of`]; a missing folder gives an empty library (the
    /// folder may be on an unplugged drive).
    #[must_use]
    pub fn load_library(&self, folder: &Path) -> Library {
        self.library_of(folder).unwrap_or_else(|e| {
            log::warn!("folder unavailable ({}); library empty", e.message);
            Library {
                folder: Some(folder.to_path_buf()),
                ..Library::default()
            }
        })
    }

    /// Starts a mutation: waits (bounded) for restore, takes the gate
    /// (waiting at most [`GATE_WAIT`]), enforces the busy rule.
    ///
    /// # Errors
    /// `busy` while a job runs or another change holds the gate too long.
    pub fn begin_mutation(&self) -> AppResult<MutexGuard<'_, ()>> {
        self.wait_restored();
        let wait = self.waits.lock().0;
        let gate = self
            .gate
            .try_lock_for(wait)
            .ok_or_else(|| IpcError::new(ErrorKind::Busy, msg::BUSY_CHANGE))?;
        if self.jobs.active().is_some() {
            return Err(IpcError::busy());
        }
        Ok(gate)
    }

    /// Admits one hand-added photo analysis at a time (bounded wait like
    /// [`Core::begin_mutation`]), so repeated adds cannot pile up analyses.
    ///
    /// # Errors
    /// `busy`.
    pub fn begin_add_analysis(&self) -> AppResult<MutexGuard<'_, ()>> {
        let wait = self.waits.lock().0;
        self.adding
            .try_lock_for(wait)
            .ok_or_else(|| IpcError::new(ErrorKind::Busy, msg::BUSY_CHANGE))
    }

    /// Schedules a debounced `session.json` write.
    pub fn mark_dirty(&self) {
        self.persister.mark_dirty();
    }

    /// Writes `session.json` now, without touching frame manifests.
    pub fn save_session_now(&self) {
        self.persister.flush();
    }

    /// Writes the frame manifest and `session.json` now (app exit, tests).
    pub fn flush(&self) {
        self.save_frames();
        self.persister.flush();
    }

    /// Callback that releases the job slot (handed to job threads).
    #[must_use]
    pub fn job_finisher(&self) -> Arc<dyn Fn(&str) + Send + Sync> {
        let jobs = Arc::clone(&self.jobs);
        Arc::new(move |id: &str| jobs.finish(id))
    }

    /// Render fingerprint and output size of the session (needs a detected
    /// reference), `face_engine::frames::render_fingerprint`.
    #[must_use]
    pub fn render_key(&self, s: &Session) -> Option<(String, Size)> {
        let r = s.p.reference.as_ref()?;
        let det = r.detection.as_ref()?;
        let output = reference::output_size(&r.crop, s.p.render.resolution)?;
        let aspect = serde_json::to_value(r.aspect)
            .ok()
            .and_then(|v| v.as_str().map(str::to_owned))
            .unwrap_or_default();
        let fingerprint = fe::frames::render_fingerprint(&fe::frames::FingerprintInputs {
            engine: &self.engine_fingerprint(),
            reference_path: &r.path,
            reference_version: &r.file_version,
            rotation_deg: r.rotation_deg,
            crop: convert::rect(r.crop),
            aspect: &aspect,
            anchors: det.anchors,
            output,
            settings: convert::render_settings(s.p.render),
        });
        Some((fingerprint, output))
    }

    /// Points the session's frames at its current fingerprint. Saving the
    /// old manifest and opening the new store (manifest read, folder
    /// listing) happen outside the session lock; call it without holding it.
    pub fn sync_frames(&self) {
        for _ in 0..4 {
            let (key, old) = {
                let mut s = self.session.write();
                let key = self.render_key(&s);
                let want = key.as_ref().map_or("", |(fp, _)| fp.as_str());
                if s.frames.fingerprint == want {
                    return;
                }
                (key, s.frames.take_write())
            };
            if let Some(w) = old {
                self.write_frames(w);
            }
            let opened = key.as_ref().map_or_else(Frames::default, |(fp, out)| {
                Frames::open(&self.paths.cache_dir, fp, *out)
            });
            let mut s = self.session.write();
            if self.render_key(&s) == key {
                s.frames = opened;
                return;
            }
        }
        log::warn!("the reference kept changing while its frames were opened");
    }

    /// Saves the frame manifest if it changed (snapshot under the lock, I/O
    /// outside it).
    pub fn save_frames(&self) {
        let pending = self.session.write().frames.take_write();
        if let Some(w) = pending {
            self.write_frames(w);
        }
    }

    /// Writes a manifest snapshot; on failure the frames are marked dirty
    /// again so a later save retries.
    pub fn write_frames(&self, w: crate::session::frames::ManifestWrite) {
        let fingerprint = w.fingerprint.clone();
        if let Err(e) = w.write() {
            log::warn!("frame manifest not saved: {}", e.message);
            let mut s = self.session.write();
            if s.frames.fingerprint == fingerprint {
                s.frames.dirty = true;
            }
        }
    }

    /// Ensures the face models are loaded (startup loads them in the background).
    ///
    /// # Errors
    /// `modelUnavailable` or an engine gap error.
    pub fn require_models(&self) -> AppResult<()> {
        self.engine.load_models()
    }

    /// The startup model load (§3 step 4): loads the models and records a
    /// failure's user-facing message for [`Core::models_error`]. True when ready.
    pub fn load_models_recorded(&self) -> bool {
        let outcome = self.require_models();
        let ready = outcome.is_ok();
        if let Err(e) = &outcome {
            log::warn!("face models not ready: {}", e.message);
        }
        *self.models_error.lock() = outcome.err().map(|e| e.message);
        ready
    }

    /// Why the startup model load failed; `None` while it runs, after it
    /// succeeded, and once the engine reports ready (a later on-demand load by a
    /// command that succeeded wins; it emits no event).
    #[must_use]
    pub fn models_error(&self) -> Option<String> {
        if self.engine.models_ready() {
            return None;
        }
        self.models_error.lock().clone()
    }

    /// Resolves a path the UI named, if the user granted it for `access`
    /// (dialog, drop, or the session's own paths).
    ///
    /// # Errors
    /// `invalidArgument` (relative, `..`), `permissionDenied` (not granted —
    /// also for paths that do not exist), `notFound`/`io` for granted paths.
    pub fn granted(&self, path: &str, access: Access) -> AppResult<PathBuf> {
        let session = crate::grants::of_session(&self.session.read());
        self.grants.resolve(&session, path, access)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TestCore;
    use std::time::Duration;

    #[test]
    fn meta_matches_platform() {
        let m = AppMeta::current("2.0.0");
        #[cfg(target_os = "macos")]
        assert_eq!(
            (m.platform, m.image_base_url.as_str()),
            (Platform::Macos, "ftimg://localhost/")
        );
        assert!(m.image_base_url.ends_with('/'));
        assert!(work_threads() >= 1);
    }

    #[test]
    fn a_second_shutdown_does_not_wait_again_for_a_stuck_job() {
        let t = TestCore::new();
        // A job that never stops (nothing runs it).
        let _job = t.core.jobs.start(crate::ipc::JobKind::Scan).expect("job");
        let wait = Duration::from_millis(300);
        let started = std::time::Instant::now();
        assert!(!t.core.shutdown(wait), "the job was still running");
        assert!(started.elapsed() >= wait);
        let started = std::time::Instant::now();
        t.core.shutdown(wait);
        assert!(
            started.elapsed() < Duration::from_millis(150),
            "{:?}",
            started.elapsed()
        );
    }

    #[test]
    fn mutations_are_refused_while_a_job_runs() {
        let t = TestCore::new();
        assert!(t.core.begin_mutation().is_ok());
        let job = t.core.jobs.start(crate::ipc::JobKind::Scan).expect("start");
        assert_eq!(t.core.begin_mutation().expect_err("busy"), IpcError::busy());
        (t.core.job_finisher())(&job.id);
        assert!(t.core.begin_mutation().is_ok());
    }

    #[test]
    fn session_paths_stay_granted_across_restarts() {
        let t = TestCore::new();
        let folder = t.setup();
        // The session stores canonical paths; the UI passes those back.
        let reference = t
            .root
            .path()
            .join("ref.jpg")
            .canonicalize()
            .expect("canonical");
        let outside = tempfile::tempdir().expect("tempdir");
        let t = t.restart_without_grants();
        let read = |p: &Path| t.core.granted(&p.to_string_lossy(), Access::Read);
        assert!(read(&reference).is_ok(), "recent reference");
        assert!(
            read(&folder.join(crate::testutil::PHOTOS[0])).is_ok(),
            "inside the folder"
        );
        assert_eq!(read(outside.path()), Err(crate::grants::denied()));
    }

    /// A latch tests open to let a paused hook continue.
    #[derive(Clone, Default)]
    struct Latch(Arc<(Mutex<bool>, Condvar)>);

    impl Latch {
        fn wait(&self) {
            let mut open = self.0.0.lock();
            while !*open {
                self.0.1.wait(&mut open);
            }
        }
        fn open(&self) {
            *self.0.0.lock() = true;
            self.0.1.notify_all();
        }
    }

    /// Pauses the next library build (after its walk) until `latch` opens;
    /// reports on `entered` when it pauses. Later builds pass straight through.
    fn pause_next_library_build(t: &TestCore, latch: &Latch) -> std::sync::mpsc::Receiver<()> {
        let (tx, rx) = std::sync::mpsc::channel();
        let (latch, first) = (
            latch.clone(),
            Arc::new(std::sync::atomic::AtomicBool::new(true)),
        );
        let tx = Mutex::new(tx);
        t.engine.set_fingerprint_hook(Some(Arc::new(move || {
            // Only the first build pauses; later ones (on other threads) pass.
            if first.swap(false, std::sync::atomic::Ordering::SeqCst) {
                let _ = tx.lock().send(());
                latch.wait();
            }
        })));
        rx
    }

    const LONG: Duration = Duration::from_secs(10);

    #[test]
    fn folder_walks_happen_outside_the_mutation_gate() {
        let t = TestCore::new();
        let folder = t.write_library().to_string_lossy().into_owned();
        let latch = Latch::default();
        let entered = pause_next_library_build(&t, &latch);
        let core = Arc::clone(&t.core);
        let walk = std::thread::spawn(move || crate::commands::folder::set_folder(&core, &folder));
        entered
            .recv_timeout(LONG)
            .expect("set_folder is building the library");
        drop(
            t.core
                .begin_mutation()
                .expect("other changes are not blocked meanwhile"),
        );
        latch.open();
        walk.join().expect("join").expect("folder set");
        assert!(t.core.session.read().p.folder.is_some());
    }

    #[test]
    fn a_newer_folder_choice_supersedes_a_slower_one() {
        let t = TestCore::new();
        let slow = t.write_library().to_string_lossy().into_owned();
        let fast = t.root.path().join("other");
        std::fs::create_dir_all(&fast).expect("mkdir");
        let latch = Latch::default();
        let entered = pause_next_library_build(&t, &latch);
        let core = Arc::clone(&t.core);
        let first = std::thread::spawn(move || crate::commands::folder::set_folder(&core, &slow));
        entered.recv_timeout(LONG).expect("first walk paused");
        crate::commands::folder::set_folder(&t.core, &fast.to_string_lossy()).expect("second");
        latch.open();
        let err = first.join().expect("join").expect_err("superseded");
        assert_eq!(err.kind, crate::ipc::ErrorKind::Cancelled);
        let fast = fast.canonicalize().expect("canonical");
        assert_eq!(
            t.core.session.read().p.folder.as_deref(),
            Some(&*fast.to_string_lossy())
        );
    }

    #[test]
    fn mutations_wait_briefly_for_the_gate_then_report_busy() {
        let t = TestCore::new();
        t.core.set_waits(Duration::from_millis(50), LONG);
        let held = t.core.begin_mutation().expect("gate");
        let core = Arc::clone(&t.core);
        let started = std::time::Instant::now();
        let err = std::thread::spawn(move || core.begin_mutation().map(drop))
            .join()
            .expect("join")
            .expect_err("busy");
        assert_eq!(err.kind, crate::ipc::ErrorKind::Busy);
        assert!(started.elapsed() < LONG / 2, "bounded wait");
        drop(held);
        assert!(t.core.begin_mutation().is_ok());
    }

    #[test]
    fn a_slow_restore_does_not_hang_the_ui_and_announces_itself_when_done() {
        let t = TestCore::new();
        t.setup();
        let t = t.restart_unrestored();
        t.core.set_waits(LONG, Duration::from_millis(50));
        let notified = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let n = Arc::clone(&notified);
        t.core.set_session_notifier(Box::new(move || {
            n.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }));
        let started = std::time::Instant::now();
        let snap = crate::commands::app::snapshot(&t.core);
        assert!(
            started.elapsed() < LONG / 2,
            "get_session answered without the library"
        );
        assert!(
            snap.folder.map_or(0, |f| f.image_count) == 0,
            "library not loaded yet"
        );
        t.core.restore();
        assert_eq!(
            notified.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "session-changed sent"
        );
        let snap = crate::commands::app::snapshot(&t.core);
        assert!(snap.folder.is_some_and(|f| f.image_count > 0));
    }

    #[test]
    fn a_late_restore_never_overrides_a_newer_folder_choice() {
        let t = TestCore::new();
        t.setup();
        let t = t.restart_unrestored();
        t.core.set_waits(LONG, Duration::from_millis(10));
        let newer = t.root.path().join("newer");
        std::fs::create_dir_all(&newer).expect("mkdir");
        t.core.grants.grant(Access::Read, &newer);
        crate::commands::folder::set_folder(&t.core, &newer.to_string_lossy()).expect("set");
        t.core.restore();
        let s = t.core.session.read();
        let newer = newer.canonicalize().expect("canonical");
        assert_eq!(s.p.folder.as_deref(), Some(&*newer.to_string_lossy()));
        assert_eq!(s.library.folder.as_deref(), Some(newer.as_path()));
        assert!(s.library.entries.is_empty());
    }

    #[test]
    fn after_one_timed_out_wait_later_commands_do_not_wait_again() {
        let t = TestCore::new();
        t.setup();
        let t = t.restart_unrestored();
        t.core.set_waits(LONG, Duration::from_millis(300));
        let started = std::time::Instant::now();
        let _ = crate::commands::app::snapshot(&t.core);
        assert!(
            started.elapsed() >= Duration::from_millis(300),
            "the first one waits"
        );
        for _ in 0..3 {
            let started = std::time::Instant::now();
            let _ = crate::commands::app::snapshot(&t.core);
            drop(t.core.begin_mutation().expect("gate"));
            assert!(
                started.elapsed() < Duration::from_millis(150),
                "{:?}",
                started.elapsed()
            );
        }
        t.core.restore();
    }

    #[test]
    fn export_leftovers_are_cleaned_after_the_library_is_restored() {
        let t = TestCore::new();
        t.setup();
        let out = t.root.path().join("out");
        std::fs::create_dir_all(&out).expect("mkdir");
        let leftover = out.join(".20140815.png.4000000-1.tmp");
        std::fs::write(&leftover, b"x").expect("write");
        t.core.session.write().p.pending_outputs = vec![crate::session::model::PendingOutput {
            path: out.to_string_lossy().into_owned(),
            video: false,
            pid: 4_000_000,
        }];
        let t = t.restart_unrestored();
        let seen = Arc::new(Mutex::new(None));
        let (seen2, leftover2) = (Arc::clone(&seen), leftover.clone());
        t.engine.set_fingerprint_hook(Some(Arc::new(move || {
            seen2.lock().get_or_insert(leftover2.exists());
        })));
        t.core.restore();
        t.engine.set_fingerprint_hook(None);
        assert_eq!(
            *seen.lock(),
            Some(true),
            "library first: an offline export folder can't delay it"
        );
        assert!(!leftover.exists(), "then the leftovers");
    }

    #[test]
    fn a_late_restore_never_swaps_in_an_older_library_of_the_same_folder() {
        let t = TestCore::new();
        let folder = t.setup();
        let t = t.restart_unrestored();
        t.core.set_waits(LONG, Duration::from_millis(10));
        let latch = Latch::default();
        let entered = pause_next_library_build(&t, &latch);
        let core = Arc::clone(&t.core);
        let restore = std::thread::spawn(move || core.restore());
        entered
            .recv_timeout(LONG)
            .expect("restore is loading the library");
        // The user picks the same folder again meanwhile (and works on it).
        crate::commands::folder::set_folder(&t.core, &folder.to_string_lossy()).expect("again");
        t.core.session.write().library.unsupported = 99;
        latch.open();
        restore.join().expect("join");
        assert_eq!(
            t.core.session.read().library.unsupported,
            99,
            "newer library kept"
        );
    }

    #[cfg(unix)]
    #[test]
    fn leftover_records_of_unreadable_folders_are_kept_for_next_time() {
        use std::os::unix::fs::PermissionsExt;
        let t = TestCore::new();
        let locked = t.root.path().join("locked");
        std::fs::create_dir_all(&locked).expect("mkdir");
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).expect("chmod");
        let record = |path: &Path| crate::session::model::PendingOutput {
            path: path.to_string_lossy().into_owned(),
            video: false,
            pid: 4_000_000,
        };
        t.core.session.write().p.pending_outputs =
            vec![record(&locked), record(&t.root.path().join("deleted"))];
        t.core.clean_pending_outputs();
        let kept = t.core.session.read().p.pending_outputs.clone();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o700)).expect("chmod");
        assert_eq!(kept, vec![record(&locked)], "unreadable kept, gone dropped");
    }

    #[test]
    fn a_panicking_restore_still_releases_waiters() {
        let t = TestCore::new();
        t.setup();
        let t = t.restart_unrestored();
        t.core.set_waits(LONG, LONG);
        t.engine
            .set_fingerprint_hook(Some(Arc::new(|| panic!("restore blew up"))));
        let core = Arc::clone(&t.core);
        assert!(std::thread::spawn(move || core.restore()).join().is_err());
        t.engine.set_fingerprint_hook(None);
        let started = std::time::Instant::now();
        t.core.wait_restored();
        assert!(started.elapsed() < LONG / 2, "no waiter blocks forever");
        assert!(t.core.begin_mutation().is_ok());
    }

    #[test]
    fn missing_folder_gives_empty_library() {
        let t = TestCore::new();
        let lib = t.core.load_library(Path::new("/definitely/not/here"));
        assert!(lib.entries.is_empty());
        assert!(lib.folder.is_some());
        t.core.flush();
    }
}
