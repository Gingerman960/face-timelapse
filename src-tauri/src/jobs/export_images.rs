//! Image export job (ARCHITECTURE.md §9.7, D13): a thin wrapper around
//! `face_engine::export::export_images`, which owns naming (`YYYYMMDD`,
//! `_1`, `_2`, … unless overwrite), `name.tmp` + rename, the q95 byte copy
//! and the parallel loop. This module adds validation, the frames of the
//! active days with their look, throttled IPC progress and the summary.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::mpsc;
use std::time::Instant;

use chrono::NaiveDate;
use face_engine as fe;
use face_engine::color::{FaceStats, FrameLook};
use face_engine::export::ExportItem;

use super::{EventSink, JobCtx, Stop, eta_ms, spawn_job};
use crate::convert;
use crate::error::{AppResult, from_engine, msg};
use crate::grants::Access;
use crate::ipc::{
    ExportImagesEvent, ExportImagesSummary, ExportProgress, ImageExportSettings, IpcError, JobId,
    JobKind, LookSettings, NormalizeMode,
};
use crate::session::frames::frame_key;
use crate::session::{Session, derive};
use crate::state::Core;

/// An aligned frame of an active day.
#[derive(Debug, Clone)]
pub struct ExportFrame {
    pub day: NaiveDate,
    pub master: PathBuf,
    pub stats: Option<FaceStats>,
}

/// Existing frames of the active days, chronological.
#[must_use]
pub fn collect_frames(s: &Session) -> Vec<ExportFrame> {
    let Some(store) = s.frames.store() else {
        return Vec::new();
    };
    let days = derive::days(s);
    derive::frame_summaries(s, &days)
        .into_iter()
        .filter_map(|f| {
            let key = frame_key(
                &s.frames.fingerprint,
                &s.library.get(&f.photo_id)?.version,
                &f.adjust,
            );
            let rec = s.frames.current(&f.photo_id, &key)?;
            Some(ExportFrame {
                day: convert::day(&f.day_key)?,
                master: store.master_path(&f.photo_id, &key),
                stats: rec.stats(),
            })
        })
        .collect()
}

/// The frames' looks (`None` each when the look is off or stats are missing).
///
/// # Errors
/// The reference statistics could not be computed (look on).
pub fn looks(
    core: &Core,
    frames: &[ExportFrame],
    look: LookSettings,
) -> AppResult<Vec<Option<FrameLook>>> {
    if look.normalize == NormalizeMode::Off {
        return Ok(vec![None; frames.len()]);
    }
    let reference = crate::look::reference_stats(core)?;
    let settings = convert::look(look);
    Ok(frames
        .iter()
        .map(|f| {
            f.stats.map(|frame| FrameLook {
                frame,
                reference,
                settings,
            })
        })
        .collect())
}

/// Checks that `dir` is a granted (picked or previously exported-to),
/// existing, writable directory. The write probe is created exclusively
/// (never follows a planted link, never truncates a file) and removed.
///
/// # Errors
/// invalidArgument / notFound / permissionDenied.
pub fn writable_dir(core: &Core, dir: &str) -> AppResult<PathBuf> {
    let dir = core.granted(dir, Access::ExportDir)?;
    if !dir.is_dir() {
        return Err(IpcError::invalid("Choose a folder to export into."));
    }
    let pid = std::process::id();
    let candidates = (0..16).map(|n| dir.join(format!(".facetimelapse-write-test-{pid}-{n}")));
    let (probe, file) = fe::cache::create_exclusive(candidates)
        .map_err(|e| IpcError::io("writing to that folder", &e))?;
    drop(file);
    let _ = std::fs::remove_file(&probe);
    Ok(dir)
}

/// Validates and starts an image export.
///
/// # Errors
/// busy, notReady (no frames), invalidArgument, permissionDenied.
pub fn start(
    core: &Arc<Core>,
    dir: &str,
    settings: ImageExportSettings,
    sink: Arc<dyn EventSink<ExportImagesEvent>>,
) -> AppResult<JobId> {
    if convert::image_export(settings).validate().is_err() {
        return Err(IpcError::invalid(
            "JPEG quality must be between 50 and 100.",
        ));
    }
    let dir = writable_dir(core, dir)?;
    let gate = core.begin_mutation()?;
    let (frames, look) = {
        let mut s = core.session.write();
        let frames = collect_frames(&s);
        if frames.is_empty() {
            return Err(IpcError::not_ready(msg::NO_FRAMES));
        }
        s.p.image_export = settings;
        let dir_str = dir.to_string_lossy().into_owned();
        crate::session::model::push_output(&mut s.p.outputs, &dir_str);
        (frames, s.p.look)
    };
    core.mark_dirty();
    let job = core.jobs.start(JobKind::ExportImages)?;
    let record = super::OutputRecord::new(core, &dir, false);
    drop(gate);
    let core2 = Arc::clone(core);
    spawn_job(core.job_finisher(), job, sink, move |ctx| {
        let _record = record;
        run(&core2, ctx, &dir, settings, look, &frames)
    })
}

fn progress(
    ctx: &JobCtx<ExportImagesEvent>,
    done: u32,
    total: u32,
    current_file: Option<String>,
    started: Instant,
) -> ExportImagesEvent {
    ExportImagesEvent::Progress(ExportProgress {
        job_id: ctx.id(),
        done,
        total,
        current_file,
        eta_ms: eta_ms(done, total.saturating_sub(done), started.elapsed()),
    })
}

fn run(
    core: &Arc<Core>,
    ctx: &JobCtx<ExportImagesEvent>,
    dir: &Path,
    settings: ImageExportSettings,
    look: LookSettings,
    frames: &[ExportFrame],
) -> Result<ExportImagesEvent, Stop> {
    let total = u32::try_from(frames.len()).unwrap_or(u32::MAX);
    ctx.send_started(total);
    let items: Vec<ExportItem> = frames
        .iter()
        .zip(looks(core, frames, look)?)
        .map(|(f, look)| ExportItem {
            master: f.master.clone(),
            day: f.day,
            look,
        })
        .collect();
    let fe_settings = convert::image_export(settings);
    let cancel = fe::CancelToken::from_flag(Arc::clone(&ctx.job.cancel));
    let started = Instant::now();
    let (tx, rx) = mpsc::channel::<fe::export::ExportProgress>();
    let (mut done, mut sent_done, mut last_file) = (0u32, 0u32, None);
    let result = std::thread::scope(|scope| {
        let worker = scope.spawn(|| {
            let sink = move |e| {
                let _ = tx.send(e);
            };
            fe::export::export_images(&items, dir, &fe_settings, &sink, &cancel)
        });
        for p in rx {
            done = u32::try_from(p.done).unwrap_or(u32::MAX);
            last_file = p.current_file;
            if ctx.progress_due() {
                ctx.send(progress(ctx, done, total, last_file.clone(), started));
                sent_done = done;
            }
        }
        worker.join()
    })
    .map_err(|_| IpcError::internal("export worker panicked"))?;
    if sent_done != done {
        ctx.send(progress(ctx, done, total, last_file, started));
    }
    let report = result.map_err(|e| Stop::Failed(from_engine(&e)))?;
    let written = u32::try_from(report.files.len()).unwrap_or(u32::MAX);
    if !report.complete {
        return Err(Stop::Cancelled { done: written });
    }
    Ok(ExportImagesEvent::Finished(ExportImagesSummary {
        job_id: ctx.id(),
        dir: dir.to_string_lossy().into_owned(),
        written,
        renamed: u32::try_from(report.renamed).unwrap_or(u32::MAX),
        duration_ms: u64::try_from(ctx.elapsed().as_millis()).unwrap_or(u64::MAX),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writable_dir_checks() {
        let t = crate::testutil::TestCore::new();
        let dir = t.root.path().join("out");
        std::fs::create_dir_all(&dir).expect("mkdir");
        t.core.grants.grant(Access::ExportDir, &dir);
        assert!(writable_dir(&t.core, &dir.to_string_lossy()).is_ok());
        let file = dir.join("f");
        std::fs::write(&file, b"x").expect("file");
        t.core.grants.grant(Access::ExportDir, &file);
        assert_eq!(
            writable_dir(&t.core, &file.to_string_lossy())
                .expect_err("file")
                .kind,
            crate::ipc::ErrorKind::InvalidArgument
        );
        assert_eq!(
            writable_dir(&t.core, "relative").expect_err("rel").kind,
            crate::ipc::ErrorKind::InvalidArgument
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_write_probe_never_follows_planted_links() {
        let t = crate::testutil::TestCore::new();
        let dir = t.root.path().join("out");
        std::fs::create_dir_all(&dir).expect("mkdir");
        let victim = t.root.path().join("victim.txt");
        std::fs::write(&victim, b"precious").expect("write");
        let pid = std::process::id();
        std::os::unix::fs::symlink(
            &victim,
            dir.join(format!(".facetimelapse-write-test-{pid}-0")),
        )
        .expect("plant");
        t.core.grants.grant(Access::ExportDir, &dir);
        assert!(writable_dir(&t.core, &dir.to_string_lossy()).is_ok());
        assert_eq!(std::fs::read(&victim).expect("victim"), b"precious");
        assert!(
            dir.join(format!(".facetimelapse-write-test-{pid}-0"))
                .is_symlink(),
            "someone else's file is left alone"
        );
    }
}
