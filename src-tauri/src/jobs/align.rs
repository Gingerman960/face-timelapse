//! Align job (ARCHITECTURE.md §4, §9.5): a thin wrapper around
//! `face_engine::frames::align_frames`, which owns the loop (reuse a master
//! whose frame key is current, else render master q95 4:4:4 + previews
//! 640/320 on the work pool). This module adds the IPC semantics: the items
//! of the active days, throttled progress with `recent` tiles, recording each
//! new frame in the session's manifest (flushed every 2 s) and the summary.

use std::sync::Arc;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use face_engine as fe;
use face_engine::frames::{
    AlignItem, AlignProgress as FeProgress, AlignSpec, FrameStore, Manifest,
};

use super::{EventSink, JobCtx, MAX_RECENT, Stop, eta_ms, rate, spawn_job};
use crate::convert;
use crate::error::{AppResult, from_engine, from_engine_kind, msg};
use crate::ipc::{
    AlignEvent, AlignFailure, AlignProgress, AlignRecent, AlignSummary, ErrorKind, IpcError, JobId,
    JobKind, LookSettings, PhotoId, RenderSettings,
};
use crate::session::frames::frame_version;
use crate::session::{Session, derive, reference};
use crate::state::Core;

const FLUSH_EVERY: Duration = Duration::from_secs(2);

/// The align item of one photo of the session; `Err(noFaceDetected)` when
/// the photo has no matched face; `None` for an unknown photo.
#[must_use]
pub fn item_for(s: &Session, id: &str) -> Option<AppResult<AlignItem>> {
    let e = s.library.get(id)?;
    let Some(face) = e.matching.matched_face.and_then(|_| e.matched_face()) else {
        return Some(Err(IpcError::new(
            ErrorKind::NoFaceDetected,
            format!("No face found in {}.", e.file_name),
        )));
    };
    let day = convert::day(&s.day_of(e))?;
    Some(Ok(AlignItem {
        photo_id: e.id.clone(),
        photo_version: e.version.clone(),
        source: e.path.clone(),
        face: face.clone(),
        day,
        adjust: convert::adjust(derive::adjust_of(s, &e.id)),
    }))
}

/// Spec and store of the session's current fingerprint.
///
/// # Errors
/// `notReady` / `noFaceInReference`.
pub fn spec(core: &Core, s: &Session) -> AppResult<(AlignSpec, FrameStore)> {
    let r =
        s.p.reference
            .as_ref()
            .ok_or_else(|| IpcError::not_ready(msg::NO_REFERENCE))?;
    let det = r
        .detection
        .as_ref()
        .ok_or_else(IpcError::no_face_in_reference)?;
    let (fingerprint, out) = core
        .render_key(s)
        .ok_or_else(IpcError::no_face_in_reference)?;
    let store = FrameStore::new(&core.paths.cache_dir, &fingerprint);
    Ok((
        AlignSpec {
            target: reference::target(det, out),
            settings: convert::render_settings(s.p.render),
            fingerprint,
        },
        store,
    ))
}

/// Renders and stores one frame (master + previews) now; returns its manifest entry.
///
/// # Errors
/// `modelUnavailable`; render/encode/I/O errors of that photo.
pub fn render_one(
    core: &Core,
    item: &AlignItem,
    spec: &AlignSpec,
    store: &FrameStore,
) -> AppResult<fe::frames::ManifestEntry> {
    fe::frames::render_item(core.engine.renderer()?, store, spec, item).map_err(|e| from_engine(&e))
}

/// Validates, saves the render settings and starts the job.
///
/// # Errors
/// busy, notReady (no active days), noFaceInReference, modelUnavailable.
pub fn start(
    core: &Arc<Core>,
    render: RenderSettings,
    sink: Arc<dyn EventSink<AlignEvent>>,
) -> AppResult<JobId> {
    let gate = core.begin_mutation()?;
    {
        let mut s = core.session.write();
        if s.p
            .reference
            .as_ref()
            .and_then(|r| r.detection.as_ref())
            .is_none()
        {
            return Err(match s.p.reference {
                None => IpcError::not_ready(msg::NO_REFERENCE),
                Some(_) => IpcError::no_face_in_reference(),
            });
        }
        s.p.render = render;
    }
    // Opens the store of the new settings outside the session lock (the
    // gate keeps other changes out meanwhile).
    core.sync_frames();
    let (spec, store, items, faceless) = {
        let s = core.session.read();
        let (mut items, mut faceless) = (Vec::new(), Vec::new());
        for d in derive::days(&s).iter().filter(|d| !d.excluded) {
            match item_for(&s, &d.selected_id) {
                Some(Ok(item)) => items.push(item),
                Some(Err(error)) => faceless.push(AlignFailure {
                    photo_id: d.selected_id.clone(),
                    error,
                }),
                None => {}
            }
        }
        if items.is_empty() && faceless.is_empty() {
            return Err(IpcError::not_ready(msg::NO_ACTIVE_DAYS));
        }
        let (spec, store) = spec(core, &s)?;
        (spec, store, items, faceless)
    };
    core.mark_dirty();
    core.require_models()?;
    let job = core.jobs.start(JobKind::Align)?;
    drop(gate);
    let core2 = Arc::clone(core);
    spawn_job(core.job_finisher(), job, sink, move |ctx| {
        run(&core2, ctx, &spec, &store, &items, faceless)
    })
}

/// Turns engine align events into throttled IPC progress and records frames.
struct Progress<'a> {
    core: &'a Core,
    ctx: &'a JobCtx<AlignEvent>,
    fingerprint: &'a str,
    look: LookSettings,
    total: u32,
    done: u32,
    reused: u32,
    rendered: u32,
    failed: Vec<AlignFailure>,
    recent: Vec<AlignRecent>,
    sent_done: u32,
    current: Option<PhotoId>,
    started: Instant,
    last_flush: Instant,
}

impl Progress<'_> {
    fn on_item(&mut self, p: FeProgress, day_of: &dyn Fn(&str) -> String) {
        self.done += 1;
        match p.outcome {
            Ok(frame) if frame.reused => {
                self.reused += 1;
                self.current = Some(frame.photo_id);
            }
            Ok(frame) => {
                self.rendered += 1;
                if self.recent.len() < MAX_RECENT {
                    self.recent.push(AlignRecent {
                        id: frame.photo_id.clone(),
                        version: frame_version(&frame.frame_key, &self.look),
                        day_key: day_of(&frame.photo_id),
                    });
                }
                let pending = {
                    let mut s = self.core.session.write();
                    if s.frames.fingerprint == self.fingerprint {
                        s.frames.insert(frame.manifest_entry());
                    }
                    (self.last_flush.elapsed() >= FLUSH_EVERY)
                        .then(|| s.frames.take_write())
                        .flatten()
                };
                if let Some(w) = pending {
                    self.core.write_frames(w);
                    self.last_flush = Instant::now();
                }
                self.current = Some(frame.photo_id);
            }
            Err(f) => {
                self.current = Some(f.photo_id.clone());
                self.failed.push(AlignFailure {
                    photo_id: f.photo_id,
                    error: from_engine_kind(f.kind, &f.message),
                });
            }
        }
        self.emit(false);
    }

    fn emit(&mut self, force: bool) {
        if !(force || self.ctx.progress_due()) {
            return;
        }
        self.sent_done = self.done;
        let failed = u32::try_from(self.failed.len()).unwrap_or(u32::MAX);
        let worked = self.rendered + failed;
        let elapsed = self.started.elapsed();
        self.ctx.send(AlignEvent::Progress(AlignProgress {
            job_id: self.ctx.id(),
            done: self.done,
            total: self.total,
            reused: self.reused,
            failed,
            current_photo_id: self.current.clone(),
            frames_per_second: rate(worked, elapsed),
            eta_ms: if self.done >= self.total {
                Some(0)
            } else {
                eta_ms(worked, self.total - self.done, elapsed)
            },
            recent: std::mem::take(&mut self.recent),
        }));
    }
}

fn run(
    core: &Arc<Core>,
    ctx: &JobCtx<AlignEvent>,
    spec: &AlignSpec,
    store: &FrameStore,
    items: &[AlignItem],
    faceless: Vec<AlignFailure>,
) -> Result<AlignEvent, Stop> {
    let total = u32::try_from(items.len() + faceless.len()).unwrap_or(u32::MAX);
    ctx.send_started(total);
    let renderer = core.engine.renderer()?;
    let (existing, look) = {
        let s = core.session.read();
        let existing = if s.frames.fingerprint == spec.fingerprint {
            s.frames.manifest.clone()
        } else {
            Manifest::default()
        };
        (existing, s.p.look)
    };
    let days: std::collections::HashMap<&str, String> = items
        .iter()
        .map(|i| (i.photo_id.as_str(), convert::day_key(i.day)))
        .collect();
    let day_of = |id: &str| days.get(id).cloned().unwrap_or_default();
    let mut p = Progress {
        core,
        ctx,
        fingerprint: &spec.fingerprint,
        look,
        total,
        done: u32::try_from(faceless.len()).unwrap_or(u32::MAX),
        reused: 0,
        rendered: 0,
        failed: faceless,
        recent: Vec::new(),
        sent_done: 0,
        current: None,
        started: Instant::now(),
        last_flush: Instant::now(),
    };
    p.emit(true);
    let cancel = fe::CancelToken::from_flag(Arc::clone(&ctx.job.cancel));
    let (tx, rx) = mpsc::channel::<FeProgress>();
    std::thread::scope(|scope| {
        let worker = scope.spawn(move || {
            let sink = move |e| {
                let _ = tx.send(e);
            };
            fe::frames::align_frames(renderer, store, spec, items, &existing, &sink, &cancel)
        });
        for event in rx {
            p.on_item(event, &day_of);
        }
        worker.join()
    })
    .map_err(|_| IpcError::internal("align worker panicked"))?;
    if p.done != p.sent_done || !p.recent.is_empty() {
        p.emit(true);
    }
    core.save_frames();
    if ctx.is_cancelled() {
        return Err(Stop::Cancelled { done: p.done });
    }
    Ok(AlignEvent::Finished(AlignSummary {
        job_id: ctx.id(),
        total,
        rendered: p.rendered,
        reused: p.reused,
        failed: p.failed,
        output_size: convert::ipc_size(spec.target.size),
        duration_ms: u64::try_from(ctx.elapsed().as_millis()).unwrap_or(u64::MAX),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::PhotoQuery;

    #[test]
    fn a_photo_without_a_matched_face_is_no_align_item() {
        let t = crate::testutil::TestCore::new();
        t.setup();
        t.scan();
        let noface = crate::commands::review::photos(&t.core, &PhotoQuery { statuses: None })
            .expect("photos")
            .into_iter()
            .find(|p| p.file_name.contains("noface"))
            .expect("a photo without a face");
        let s = t.core.session.read();
        let err = item_for(&s, &noface.id)
            .expect("known")
            .expect_err("no face");
        assert_eq!(err.kind, ErrorKind::NoFaceDetected);
        assert!(item_for(&s, "0000000000000000").is_none(), "unknown photo");
    }
}
