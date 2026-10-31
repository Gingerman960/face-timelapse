//! Test fixtures: a `Core` on the fake engine in a temp dir, a small photo
//! library whose names drive the fake engine's outcomes, and job runners.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use crate::engine::fake::{FakeEngine, write_jpeg};
use crate::grants::Access;
use crate::ipc::{AlignEvent, ExportImagesEvent, ExportVideoEvent, ScanEvent};
use crate::jobs::{EventSink, VecSink};
use crate::paths::AppPaths;
use crate::state::{AppMeta, Core};

/// Library used by most flow tests (see `engine::fake` for name semantics).
pub const PHOTOS: [&str; 8] = [
    "IMG_20140815_100000.jpg",
    "IMG_20140815_120000.jpg",
    "IMG_20140816_090000_unsure.jpg",
    "IMG_20140817_090000_other.jpg",
    "IMG_20140818_090000_noface.jpg",
    "sub/IMG_20140820_090000_twofaces.jpg",
    "IMG_20140821_090000.jpg",
    "broken_20140819.jpg",
];

pub struct TestCore {
    pub core: Arc<Core>,
    pub engine: Arc<FakeEngine>,
    pub root: tempfile::TempDir,
}

impl Default for TestCore {
    fn default() -> Self {
        Self::new()
    }
}

impl TestCore {
    #[must_use]
    pub fn new() -> Self {
        Self::in_root(tempfile::tempdir().expect("tempdir"))
    }

    /// Core whose app dirs live under `root/app` (reused to test restarts).
    /// The whole temp root is granted for reading, as if the user had
    /// dropped it (exports still need their own grants).
    #[must_use]
    pub fn in_root(root: tempfile::TempDir) -> Self {
        let t = Self::bare(root);
        t.core.grants.grant(Access::Read, t.root.path());
        t
    }

    fn bare(root: tempfile::TempDir) -> Self {
        Self::bare_with(root, FakeEngine::new())
    }

    fn bare_with(root: tempfile::TempDir, engine: FakeEngine) -> Self {
        let paths = AppPaths::under_root(&root.path().join("app"), PathBuf::new());
        paths.prepare().expect("prepare");
        let engine = Arc::new(engine);
        let core = Core::new(paths, engine.clone(), AppMeta::current("2.0.0"));
        core.restore();
        Self { core, engine, root }
    }

    /// Simulates an app restart on the same data dir.
    #[must_use]
    pub fn restart(self) -> Self {
        Self::in_root(self.quit())
    }

    /// Quits the app (saves, drops the core) and hands back its data dir.
    #[must_use]
    pub fn quit(self) -> tempfile::TempDir {
        self.core.flush();
        let root = self.root;
        drop(self.core);
        root
    }

    /// `session.json` of a data dir from [`TestCore::quit`].
    #[must_use]
    pub fn session_file(root: &tempfile::TempDir) -> PathBuf {
        AppPaths::under_root(&root.path().join("app"), PathBuf::new()).session_file()
    }

    /// A restart whose face models are missing from the start (no engine
    /// fingerprint, every load fails), with the same grants as [`TestCore::in_root`].
    #[must_use]
    pub fn restart_without_models(self) -> Self {
        Self::start_without_models(self.quit())
    }

    /// [`TestCore::restart_without_models`] on a data dir from [`TestCore::quit`].
    #[must_use]
    pub fn start_without_models(root: tempfile::TempDir) -> Self {
        let engine = FakeEngine::new();
        engine
            .models_missing
            .store(true, std::sync::atomic::Ordering::Relaxed);
        let t = Self::bare_with(root, engine);
        t.core.grants.grant(Access::Read, t.root.path());
        t
    }

    /// A restart that does not run [`Core::restore`] (tests drive it).
    #[must_use]
    pub fn restart_unrestored(self) -> Self {
        self.core.flush();
        let root = self.root;
        drop(self.core);
        let paths = AppPaths::under_root(&root.path().join("app"), PathBuf::new());
        paths.prepare().expect("prepare");
        let engine = Arc::new(FakeEngine::new());
        let core = Core::new(paths, engine.clone(), AppMeta::current("2.0.0"));
        core.grants.grant(Access::Read, root.path());
        Self { core, engine, root }
    }

    /// A restart with no runtime grants: only the session's own paths.
    #[must_use]
    pub fn restart_without_grants(self) -> Self {
        self.core.flush();
        let root = self.root;
        drop(self.core);
        Self::bare(root)
    }

    #[must_use]
    pub fn photos(&self) -> PathBuf {
        self.root.path().join("photos")
    }

    /// Writes [`PHOTOS`] (+ a HEIC and a text file) and returns the folder.
    #[must_use]
    pub fn write_library(&self) -> PathBuf {
        let dir = self.photos();
        for (i, name) in PHOTOS.iter().enumerate() {
            let p = dir.join(name);
            if name.starts_with("broken") {
                std::fs::create_dir_all(&dir).expect("mkdir");
                std::fs::write(&p, b"not a jpeg").expect("write");
            } else {
                write_jpeg(&p, 48, 36, 40 + 20 * u8::try_from(i).expect("small"));
            }
        }
        std::fs::write(dir.join("clip.heic"), b"x").expect("heic");
        std::fs::write(dir.join("notes.txt"), b"x").expect("txt");
        dir.canonicalize().expect("canonical")
    }

    /// Writes a reference photo outside the library.
    #[must_use]
    pub fn write_reference(&self, name: &str) -> PathBuf {
        let p = self.root.path().join(name);
        write_jpeg(&p, 64, 48, 120);
        p.canonicalize().expect("canonical")
    }

    /// Reference + folder set through the command layer.
    pub fn setup(&self) -> PathBuf {
        let folder = self.write_library();
        let r = self.write_reference("ref.jpg");
        crate::commands::reference::set_photo(&self.core, &r.to_string_lossy()).expect("reference");
        crate::commands::folder::set_folder(&self.core, &folder.to_string_lossy()).expect("folder");
        folder
    }

    /// Runs a scan to its terminal event.
    pub fn scan(&self) -> Vec<ScanEvent> {
        let sink = Arc::new(VecSink::<ScanEvent>::default());
        crate::jobs::scan::start(&self.core, sink.clone() as Arc<dyn EventSink<ScanEvent>>)
            .expect("start scan");
        let events = sink.wait_for(Duration::from_secs(20), |e| {
            e.last().is_some_and(is_scan_terminal)
        });
        self.wait_idle();
        events
    }

    /// Runs an align to its terminal event.
    pub fn align(&self) -> Vec<AlignEvent> {
        let sink = Arc::new(VecSink::<AlignEvent>::default());
        let render = self.core.session.read().p.render;
        crate::jobs::align::start(
            &self.core,
            render,
            sink.clone() as Arc<dyn EventSink<AlignEvent>>,
        )
        .expect("start align");
        let events = sink.wait_for(Duration::from_secs(20), |e| {
            e.last().is_some_and(|l| {
                matches!(
                    l,
                    AlignEvent::Finished(_) | AlignEvent::Failed(_) | AlignEvent::Cancelled(_)
                )
            })
        });
        self.wait_idle();
        events
    }

    /// Waits until the job slot is free (the terminal event is sent right after).
    pub fn wait_idle(&self) {
        for _ in 0..2000 {
            if self.core.jobs.active().is_none() {
                return;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        panic!("job did not finish");
    }

    /// Exports images and waits.
    pub fn export_images(
        &self,
        dir: &std::path::Path,
        settings: crate::ipc::ImageExportSettings,
    ) -> Vec<ExportImagesEvent> {
        self.core.grants.grant(Access::ExportDir, dir);
        let sink = Arc::new(VecSink::<ExportImagesEvent>::default());
        crate::jobs::export_images::start(
            &self.core,
            &dir.to_string_lossy(),
            settings,
            sink.clone() as Arc<dyn EventSink<ExportImagesEvent>>,
        )
        .expect("start export");
        let events = sink.wait_for(Duration::from_secs(20), |e| {
            e.last().is_some_and(|l| {
                matches!(
                    l,
                    ExportImagesEvent::Finished(_)
                        | ExportImagesEvent::Failed(_)
                        | ExportImagesEvent::Cancelled(_)
                )
            })
        });
        self.wait_idle();
        events
    }

    /// Exports a video and waits.
    pub fn export_video(
        &self,
        path: &std::path::Path,
        settings: crate::ipc::VideoSettings,
    ) -> Vec<ExportVideoEvent> {
        crate::commands::export::grant_video_path(&self.core, path);
        let sink = Arc::new(VecSink::<ExportVideoEvent>::default());
        crate::jobs::export_video::start(
            &self.core,
            &path.to_string_lossy(),
            settings,
            sink.clone() as Arc<dyn EventSink<ExportVideoEvent>>,
        )
        .expect("start video");
        let events = sink.wait_for(Duration::from_secs(60), |e| {
            e.last().is_some_and(|l| {
                matches!(
                    l,
                    ExportVideoEvent::Finished(_)
                        | ExportVideoEvent::Failed(_)
                        | ExportVideoEvent::Cancelled(_)
                )
            })
        });
        self.wait_idle();
        events
    }
}

#[must_use]
pub fn is_scan_terminal(e: &ScanEvent) -> bool {
    matches!(
        e,
        ScanEvent::Finished(_) | ScanEvent::Failed(_) | ScanEvent::Cancelled(_)
    )
}

/// An event sink that holds the job on its first event until released, so
/// tests can observe a job mid-run deterministically.
pub struct BlockingSink<E> {
    pub events: VecSink<E>,
    state: parking_lot::Mutex<(bool, bool)>, // (blocked, released)
    cv: parking_lot::Condvar,
}

impl<E> Default for BlockingSink<E> {
    fn default() -> Self {
        Self {
            events: VecSink::default(),
            state: parking_lot::Mutex::new((false, false)),
            cv: parking_lot::Condvar::new(),
        }
    }
}

impl<E> BlockingSink<E> {
    /// Waits until the job is held on its first event.
    pub fn wait_blocked(&self) {
        let mut st = self.state.lock();
        while !st.0 {
            assert!(
                !self
                    .cv
                    .wait_for(&mut st, Duration::from_secs(20))
                    .timed_out(),
                "job never sent an event"
            );
        }
    }

    /// Lets the job continue.
    pub fn release(&self) {
        self.state.lock().1 = true;
        self.cv.notify_all();
    }
}

impl<E: Send> EventSink<E> for BlockingSink<E> {
    fn send(&self, event: E) {
        {
            let mut st = self.state.lock();
            st.0 = true;
            self.cv.notify_all();
            while !st.1 {
                self.cv.wait(&mut st);
            }
        }
        self.events.send(event);
    }
}
