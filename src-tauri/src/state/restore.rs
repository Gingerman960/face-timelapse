//! Startup restore, the bounded waits on it, quitting and the cleanup of
//! unfinished exports (ARCHITECTURE.md §3).

use std::path::Path;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use face_engine as fe;

use super::{Core, MAX_PENDING_OUTPUTS};
use crate::session::reference;

impl Core {
    /// Rebuilds the in-memory library, matching and frame store from the
    /// persisted session (startup step 2). Idempotent. Applies only what no
    /// newer command replaced meanwhile (commands stop waiting for it after
    /// [`RESTORE_WAIT`]); waiters are released even if it panics.
    pub fn restore(&self) {
        self.restore_library();
        // After the library: an offline export folder must not delay it.
        self.clean_pending_outputs();
    }

    fn restore_library(&self) {
        struct Done<'a>(&'a Core);
        impl Drop for Done<'_> {
            fn drop(&mut self) {
                self.0.finish_restore();
            }
        }
        let _done = Done(self);
        let seq = self.folder_seq.load(Ordering::Acquire);
        let (folder, reference) = {
            let s = self.session.read();
            (s.p.folder.clone(), s.p.reference.clone())
        };
        let library = folder.as_deref().map(|f| self.load_library(Path::new(f)));
        let mut s = self.session.write();
        if s.p.reference == reference {
            s.match_embedding = reference.as_ref().and_then(reference::match_embedding);
        }
        // Not if the folder was chosen again meanwhile, even the same one:
        // that library is newer (and may already be scanned).
        if s.p.folder == folder
            && self.is_latest_folder(seq)
            && let Some(lib) = library
        {
            s.library = lib;
        }
        s.sync_manual();
        s.rematch();
        drop(s);
        self.sync_frames();
    }

    fn finish_restore(&self) {
        let announce = {
            let mut st = self.restore.lock();
            st.done = true;
            std::mem::take(&mut st.timed_out)
        };
        self.restored_cv.notify_all();
        if announce {
            self.notify_session_changed();
        }
    }

    /// Waits for [`Core::restore`], at most [`RESTORE_WAIT`]; after that the
    /// caller goes ahead without the library and the restore announces itself.
    /// Once one wait has timed out, later callers do not wait again (each
    /// would otherwise pay the full wait while the restore is stuck).
    pub fn wait_restored(&self) {
        let wait = self.waits.lock().1;
        let deadline = Instant::now() + wait;
        let mut st = self.restore.lock();
        while !st.done && !st.timed_out {
            if self.restored_cv.wait_until(&mut st, deadline).timed_out() && !st.done {
                st.timed_out = true;
                log::warn!("session restore still running after {wait:?}; answering without it");
                return;
            }
        }
    }

    /// Blocks until [`Core::restore`] finished, however long (background
    /// threads only).
    pub fn wait_restored_fully(&self) {
        let mut st = self.restore.lock();
        while !st.done {
            self.restored_cv.wait(&mut st);
        }
    }

    /// Quit: cancels the running job and waits (≤ `timeout`) until it has
    /// stopped — its temporary files are removed by then — then saves.
    /// True if no job was left running. Only the first call waits; later
    /// ones (both quit events arrive on window close) just save again.
    pub fn shutdown(&self, timeout: Duration) -> bool {
        if self.shut_down.swap(true, Ordering::AcqRel) {
            self.flush();
            return self.jobs.active().is_none();
        }
        self.jobs.cancel_active();
        let idle = self.jobs.wait_idle(timeout);
        if !idle {
            log::warn!("a job was still running at quit; its leftovers are removed next start");
        }
        self.flush();
        idle
    }

    /// Deletes the temporary files of exports that never ended (the app
    /// died mid-export): only names this app makes, with the recorded pid,
    /// next to the recorded target.
    pub fn clean_pending_outputs(&self) {
        // Records of this process belong to an export running right now.
        let me = std::process::id();
        let pending: Vec<_> = {
            let mut s = self.session.write();
            let (ours, stale) = std::mem::take(&mut s.p.pending_outputs)
                .into_iter()
                .partition(|p| p.pid == me);
            s.p.pending_outputs = ours;
            stale
        };
        if pending.is_empty() {
            return;
        }
        let mut retry = Vec::new();
        for p in &pending {
            let path = Path::new(&p.path);
            let (dir, target) = if p.video {
                (path.parent(), path.file_name().map(|n| n.to_string_lossy()))
            } else {
                (Some(path), None)
            };
            let entries = match dir.map(std::fs::read_dir) {
                Some(Ok(entries)) => entries,
                // Gone for good: nothing left to clean.
                Some(Err(e)) if e.kind() == std::io::ErrorKind::NotFound => continue,
                None => continue,
                // Unreadable right now (permissions, I/O): try again next start.
                Some(Err(e)) => {
                    log::warn!("cannot clean an unfinished export's folder yet: {e}");
                    retry.push(p.clone());
                    continue;
                }
            };
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                let ours = match &target {
                    Some(t) => timelapse_video::is_partial_name(&name, t, p.pid),
                    None => fe::cache::is_temp_name(&name, p.pid),
                };
                if ours && let Err(e) = std::fs::remove_file(entry.path()) {
                    log::warn!("could not remove a leftover export file: {e}");
                }
            }
        }
        log::info!(
            "removed leftovers of {} unfinished export(s)",
            pending.len() - retry.len()
        );
        if !retry.is_empty() {
            let mut s = self.session.write();
            s.p.pending_outputs.extend(retry);
            // Bounded, however many unreadable folders pile up.
            let excess =
                s.p.pending_outputs
                    .len()
                    .saturating_sub(MAX_PENDING_OUTPUTS);
            s.p.pending_outputs.drain(..excess);
        }
        self.mark_dirty();
    }
}
