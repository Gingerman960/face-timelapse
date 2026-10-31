//! Scan job (ARCHITECTURE.md §4.1): a thin wrapper around
//! `face_engine::scan::scan_folder`, which owns the loop (walk → partition by
//! (relPath, size, mtime) against the analysis cache → misses analyzed on the
//! work pool with the 320 thumbnail written as a by-product → cache flushed
//! every 2 s / 500 entries and at the end; cancel keeps everything analyzed).
//!
//! This module adds the IPC semantics: `started{total}`, one progress event
//! for all cache hits, throttled progress with `recent` mosaic tiles, the
//! summary, and applying the results (library, matching, `lastScan`).

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::mpsc;
use std::time::Instant;

use face_engine as fe;
use face_engine::analysis::PhotoAnalysis;
use face_engine::matching::Calibration;
use face_engine::recognize::Embedding;
use face_engine::scan::{ScanContext, ScanCounts, ScanItem, ScanOptions, ScanReport};

use super::{EventSink, JobCtx, MAX_RECENT, Stop, eta_ms, rate, spawn_job};
use crate::convert;
use crate::error::{AppResult, from_engine, msg};
use crate::ipc::{
    IpcError, JobId, JobKind, PhotoId, ScanEvent, ScanProgress, ScanRecent, ScanRecentStatus,
    ScanStatus, ScanSummary,
};
use crate::session::Library;
use crate::session::model::LastScan;
use crate::state::Core;

/// Thumbnail width written during the scan.
pub const SCAN_THUMB: u32 = fe::thumbs::SCAN_THUMB_WIDTH;

/// Validates and starts a scan.
///
/// # Errors
/// busy, notReady (no folder / no reference), noFaceInReference, modelUnavailable.
pub fn start(core: &Arc<Core>, sink: Arc<dyn EventSink<ScanEvent>>) -> AppResult<JobId> {
    let gate = core.begin_mutation()?;
    let (folder, reference) = {
        let s = core.session.read();
        let folder = s
            .library
            .folder
            .clone()
            .ok_or_else(|| IpcError::not_ready(msg::NO_FOLDER))?;
        let r =
            s.p.reference
                .as_ref()
                .ok_or_else(|| IpcError::not_ready(msg::NO_REFERENCE))?;
        let det = r
            .detection
            .as_ref()
            .ok_or_else(IpcError::no_face_in_reference)?;
        (folder, det.embedding.clone())
    };
    core.require_models()?;
    let job = core.jobs.start(JobKind::Scan)?;
    drop(gate);
    let core2 = Arc::clone(core);
    spawn_job(core.job_finisher(), job, sink, move |ctx| {
        run(&core2, ctx, folder, &reference)
    })
}

fn tile_status(status: fe::matching::MatchStatus) -> Option<ScanRecentStatus> {
    match status {
        fe::matching::MatchStatus::Confirmed => Some(ScanRecentStatus::Confirmed),
        fe::matching::MatchStatus::Uncertain => Some(ScanRecentStatus::Uncertain),
        _ => None,
    }
}

/// Turns engine scan events into throttled IPC progress.
struct Progress<'a> {
    ctx: &'a JobCtx<ScanEvent>,
    /// User day moves at scan start (for `ScanRecent.dayKey`).
    day_moves: BTreeMap<PhotoId, String>,
    counts: ScanCounts,
    recent: Vec<ScanRecent>,
    current: Option<String>,
    /// `done` of the last progress event sent.
    sent_done: usize,
    analyze_started: Instant,
}

impl Progress<'_> {
    fn on_started(&mut self, counts: ScanCounts) {
        self.counts = counts;
        self.ctx
            .send_started(u32::try_from(counts.total).unwrap_or(u32::MAX));
        self.analyze_started = Instant::now();
        // One event covers every cache hit.
        self.emit(true);
    }

    fn on_photo(&mut self, counts: ScanCounts, photo: ScanItem) {
        self.counts = counts;
        if let Some(status) = tile_status(photo.status).filter(|_| self.recent.len() < MAX_RECENT) {
            let day_key = self
                .day_moves
                .get(&photo.id)
                .cloned()
                .unwrap_or_else(|| convert::day_key(photo.taken_at.date()));
            self.recent.push(ScanRecent {
                id: photo.id,
                version: photo.version,
                day_key,
                status,
            });
        }
        self.current = Some(
            photo
                .rel_path
                .rsplit('/')
                .next()
                .unwrap_or(&photo.rel_path)
                .to_owned(),
        );
        self.emit(false);
    }

    fn emit(&mut self, force: bool) {
        if !(force || self.ctx.progress_due()) {
            return;
        }
        let c = self.counts;
        let n = |v: usize| u32::try_from(v).unwrap_or(u32::MAX);
        let elapsed = self.analyze_started.elapsed();
        let remaining = c.total.saturating_sub(c.from_cache + c.analyzed);
        self.sent_done = c.done;
        self.ctx.send(ScanEvent::Progress(ScanProgress {
            job_id: self.ctx.id(),
            done: n(c.done),
            total: n(c.total),
            from_cache: n(c.from_cache),
            analyzed: n(c.analyzed),
            confirmed: n(c.confirmed),
            uncertain: n(c.uncertain),
            rejected: n(c.rejected),
            no_face: n(c.no_face),
            failed: n(c.failed),
            current_file: self.current.clone(),
            photos_per_second: rate(n(c.analyzed), elapsed),
            eta_ms: if remaining == 0 {
                Some(0)
            } else {
                eta_ms(n(c.analyzed), n(remaining), elapsed)
            },
            recent: std::mem::take(&mut self.recent),
        }));
    }

    /// Final progress so the last tiles/counts reach the UI despite the throttle.
    fn finish(&mut self) {
        if self.counts.done != self.sent_done || !self.recent.is_empty() {
            self.emit(true);
        }
    }
}

fn run(
    core: &Arc<Core>,
    ctx: &JobCtx<ScanEvent>,
    folder: PathBuf,
    reference: &Embedding,
) -> Result<ScanEvent, Stop> {
    let analyzer = core.engine.analyzer()?;
    let cancel = fe::CancelToken::from_flag(Arc::clone(&ctx.job.cancel));
    let mut progress = Progress {
        ctx,
        day_moves: core.session.read().decisions().day_moves.clone(),
        counts: ScanCounts::default(),
        recent: Vec::new(),
        current: None,
        sent_done: 0,
        analyze_started: Instant::now(),
    };
    let scan_ctx = ScanContext {
        analyzer,
        cache_dir: &core.paths.cache_dir,
        reference,
        calibration: Calibration::default(),
        options: ScanOptions::default(),
    };
    let (tx, rx) = mpsc::channel::<fe::scan::ScanEvent>();
    let report = std::thread::scope(|scope| {
        let walk_folder = folder.clone();
        let worker = scope.spawn(move || {
            let sink = move |e| {
                let _ = tx.send(e);
            };
            fe::scan::scan_folder(&scan_ctx, &walk_folder, &sink, &cancel)
        });
        for event in rx {
            match event {
                fe::scan::ScanEvent::Started { counts, .. } => progress.on_started(counts),
                fe::scan::ScanEvent::Progress { counts, photo, .. } => {
                    progress.on_photo(counts, photo);
                }
            }
        }
        worker.join()
    })
    .map_err(|_| IpcError::internal("scan worker panicked"))?
    .map_err(|e| from_engine(&e))?;
    progress.finish();
    let n = |v: usize| u32::try_from(v).unwrap_or(u32::MAX);
    let c = report.counts;
    let summary = ScanSummary {
        job_id: ctx.id(),
        total: n(c.total),
        from_cache: n(c.from_cache),
        analyzed: n(c.analyzed),
        confirmed: n(c.confirmed),
        uncertain: n(c.uncertain),
        rejected: n(c.rejected),
        no_face: n(c.no_face),
        failed: n(c.failed),
        duration_ms: u64::try_from(ctx.elapsed().as_millis()).unwrap_or(u64::MAX),
    };
    let cancelled = !report.complete;
    apply(core, &folder, report, &summary);
    if cancelled {
        Err(Stop::Cancelled {
            done: summary.from_cache + summary.analyzed,
        })
    } else {
        Ok(ScanEvent::Finished(summary))
    }
}

/// Applies scan results to the session (if the folder is still current).
fn apply(core: &Core, folder: &Path, report: ScanReport, summary: &ScanSummary) {
    let cancelled = !report.complete;
    let mut analyses: HashMap<String, PhotoAnalysis> = report
        .photos
        .into_iter()
        .map(|p| (p.entry.rel_path, p.analysis))
        .collect();
    let library = Library::from_walk(
        folder.to_path_buf(),
        &report.files,
        crate::session::count_u32(report.unsupported.len()),
        |f| analyses.remove(&f.rel_path),
    );
    {
        let mut s = core.session.write();
        if s.library.folder.as_deref() != Some(folder) {
            return;
        }
        s.library = library;
        s.sync_manual();
        s.rematch();
        s.p.last_scan = Some(LastScan {
            folder: folder.to_string_lossy().into_owned(),
            at: chrono::Local::now()
                .naive_local()
                .format("%Y-%m-%dT%H:%M:%S")
                .to_string(),
            status: if cancelled {
                ScanStatus::Partial
            } else {
                ScanStatus::Complete
            },
            summary: Some(summary.clone()),
        });
    }
    core.mark_dirty();
}

#[cfg(test)]
mod tests;
