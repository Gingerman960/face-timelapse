//! Video export job (ARCHITECTURE.md §9.7, D13): the engine's frame sequence
//! (`face_engine::frames::FrameSequence`: masters + look, decoded on the
//! encoder's workers) is fed to `timelapse-video` (which letterboxes/scales
//! to the requested resolution, captions, crossfades and writes
//! unique `{path}.{pid}-{n}.partial` → rename). The job's cancel flag *is* the encoder's
//! `CancelToken`, so cancel is immediate.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use face_engine as fe;
use face_engine::frames::{FrameSequence, FrameSpec};
use face_engine::geometry::Size;
use timelapse_video::{
    CancelToken, Frame, FrameLoader, FrameSource, VideoOptions, encode_timelapse,
};

use super::export_images::{ExportFrame, collect_frames, looks};
use super::{EventSink, JobCtx, Stop, spawn_job};
use crate::error::{AppResult, from_engine, from_video, msg};
use crate::grants::Access;
use crate::ipc::{
    ExportVideoEvent, IpcError, JobId, JobKind, LookSettings, Pace, VideoProgress, VideoQuality,
    VideoSettings, VideoSummary,
};
use crate::session::derive;
use crate::state::{Core, work_threads};

/// Maps contract settings to encoder options (resolution clamped to the
/// masters; frame preparation sized like the work pool, cores − 1).
#[must_use]
pub fn options(settings: &VideoSettings, master: Size) -> VideoOptions {
    use timelapse_video::{CaptionOptions, CaptionPosition as P, Crossfade, Easing, Quality};
    let caption = settings.caption.as_ref().map(|c| CaptionOptions {
        position: match c.position {
            crate::ipc::CaptionPosition::TopLeft => P::TopLeft,
            crate::ipc::CaptionPosition::TopCenter => P::TopCenter,
            crate::ipc::CaptionPosition::TopRight => P::TopRight,
            crate::ipc::CaptionPosition::BottomLeft => P::BottomLeft,
            crate::ipc::CaptionPosition::BottomCenter => P::BottomCenter,
            crate::ipc::CaptionPosition::BottomRight => P::BottomRight,
        },
        size: c.size,
        format: c.format.clone(),
    });
    VideoOptions {
        pace: match settings.pace {
            Pace::Fps { fps } => timelapse_video::Pace::Fps { fps },
            Pace::Duration { seconds } => timelapse_video::Pace::Duration { seconds },
        },
        resolution: derive::clamp_video_resolution(settings.resolution, master),
        quality: match settings.quality {
            VideoQuality::Low => Quality::Low,
            VideoQuality::Medium => Quality::Medium,
            VideoQuality::High => Quality::High,
            VideoQuality::Max => Quality::Max,
            VideoQuality::Bitrate { kbps } => Quality::Bitrate { kbps },
        },
        crossfade: Crossfade {
            frames: settings.crossfade.frames,
            easing: match settings.crossfade.easing {
                crate::ipc::Easing::Linear => Easing::Linear,
                crate::ipc::Easing::EaseInOut => Easing::EaseInOut,
            },
        },
        caption,
        hold_first_secs: settings.hold_first_secs,
        hold_last_secs: settings.hold_last_secs,
        threads: work_threads(),
        ..VideoOptions::default()
    }
}

/// Checks the output path: absolute, `.mp4`, chosen in the save dialog (or
/// an earlier export of ours), existing parent folder. An existing file is
/// replaced only if the save dialog confirmed exactly that name or we wrote
/// it (D13/L7); otherwise the export is refused instead of overwriting.
///
/// # Errors
/// invalidArgument / permissionDenied / notFound.
pub fn video_path(core: &Core, path: &str) -> AppResult<PathBuf> {
    let p = Path::new(path);
    if !p.is_absolute() {
        return Err(IpcError::invalid("Paths must be absolute."));
    }
    if !p.extension().is_some_and(|e| e.eq_ignore_ascii_case("mp4")) {
        return Err(IpcError::invalid("The video file name must end in .mp4."));
    }
    let target = core.granted(path, Access::ExportFile)?;
    if !target.parent().is_some_and(Path::is_dir) {
        return Err(IpcError::invalid("Choose where to save the video."));
    }
    match std::fs::symlink_metadata(&target) {
        Ok(m) if m.is_dir() => Err(IpcError::invalid("Choose a file name, not a folder.")),
        Ok(_) if !replace_confirmed(core, path) => Err(IpcError::invalid(format!(
            "{} already exists. Choose another name, or choose it again to replace it.",
            p.file_name().unwrap_or_default().to_string_lossy()
        ))),
        _ => Ok(target),
    }
}

/// Whether the user confirmed replacing `path` — the save dialog showed
/// exactly that name, or the app wrote it. Only then may the export replace
/// a file there (also one that appears while encoding).
#[must_use]
pub fn replace_confirmed(core: &Core, path: &str) -> bool {
    core.granted(path, Access::ReplaceFile).is_ok()
}

/// The engine's frame loaders as a video frame source. The first loader
/// error is kept with its engine kind, so a missing or corrupt master is
/// reported as `notFound`/`decodeFailed` rather than the encoder's opaque
/// "source" error.
struct MasterFrames<I> {
    loaders: I,
    len: usize,
    first_error: Arc<parking_lot::Mutex<Option<IpcError>>>,
}

impl<I: Iterator<Item = fe::frames::FrameLoader> + Send> FrameSource for MasterFrames<I> {
    fn len(&self) -> usize {
        self.len
    }

    fn next_loader(&mut self) -> Option<FrameLoader> {
        let load = self.loaders.next()?;
        let first_error = Arc::clone(&self.first_error);
        Some(Box::new(move || {
            let f = load().map_err(|e| {
                first_error.lock().get_or_insert_with(|| from_engine(&e));
                timelapse_video::VideoError::Source(e.to_string())
            })?;
            Frame::new(f.width, f.height, f.rgb, Some(f.date))
        }))
    }
}

/// Validates and starts a video export.
///
/// # Errors
/// busy, notReady (< 2 frames), invalidArgument (incl. infeasible pace).
pub fn start(
    core: &Arc<Core>,
    path: &str,
    settings: VideoSettings,
    sink: Arc<dyn EventSink<ExportVideoEvent>>,
) -> AppResult<JobId> {
    let replace = replace_confirmed(core, path);
    let path = video_path(core, path)?;
    let gate = core.begin_mutation()?;
    let (items, look, opts, frames_total) = {
        let mut s = core.session.write();
        let items = collect_frames(&s);
        if items.len() < 2 {
            return Err(IpcError::not_ready(msg::TOO_FEW_FRAMES));
        }
        let opts = VideoOptions {
            replace_existing: replace,
            ..options(&settings, s.frames.output_size)
        };
        let plan = opts.plan(items.len()).map_err(|e| from_video(&e))?;
        s.p.video = settings;
        (items, s.p.look, opts, plan.total_frames())
    };
    core.mark_dirty();
    let job = core.jobs.start(JobKind::ExportVideo)?;
    let record = super::OutputRecord::new(core, &path, true);
    drop(gate);
    let core2 = Arc::clone(core);
    let export = Export {
        path,
        opts,
        look,
        items,
        frames_total,
        record,
    };
    spawn_job(core.job_finisher(), job, sink, move |ctx| {
        run(&core2, ctx, export)
    })
}

/// A video export's inputs (and its pending-output record).
struct Export {
    path: PathBuf,
    opts: VideoOptions,
    look: LookSettings,
    items: Vec<ExportFrame>,
    frames_total: u64,
    record: super::OutputRecord,
}

fn run(
    core: &Arc<Core>,
    ctx: &JobCtx<ExportVideoEvent>,
    export: Export,
) -> Result<ExportVideoEvent, Stop> {
    let Export {
        path,
        opts,
        look,
        items,
        frames_total,
        record,
    } = export;
    let total = u32::try_from(frames_total).unwrap_or(u32::MAX);
    ctx.send_started(total);
    let specs: Vec<FrameSpec> = items
        .iter()
        .zip(looks(core, &items, look)?)
        .map(|(f, look)| FrameSpec {
            master: f.master.clone(),
            date: f.day,
            look,
        })
        .collect();
    let first_error = Arc::default();
    let source = MasterFrames {
        len: specs.len(),
        loaders: FrameSequence::new(specs, None).into_loaders(),
        first_error: Arc::clone(&first_error),
    };
    let cancel = CancelToken::from_flag(Arc::clone(&ctx.job.cancel));
    let mut done = 0u32;
    let mut pending: Option<VideoProgress> = None;
    let result = encode_timelapse(
        source,
        &opts,
        &path,
        |p| {
            done = u32::try_from(p.frames_done).unwrap_or(u32::MAX);
            let ev = VideoProgress {
                job_id: ctx.id(),
                frames_done: done,
                frames_total: u32::try_from(p.frames_total).unwrap_or(u32::MAX),
                encode_fps: (p.frames_per_sec * 10.0).round() / 10.0,
                eta_ms: p.eta_secs.map(|s| (s * 1000.0).round() as u64),
            };
            if ctx.progress_due() {
                ctx.send(ExportVideoEvent::Progress(ev));
                pending = None;
            } else {
                pending = Some(ev);
            }
        },
        &cancel,
    );
    if let (Some(ev), Ok(_)) = (pending, &result) {
        ctx.send(ExportVideoEvent::Progress(ev));
    }
    match result {
        Ok(summary) => {
            // Only a finished video is ours (and may be replaced later): a
            // failed or cancelled one leaves no lasting grant behind.
            let out = summary.output.to_string_lossy().into_owned();
            crate::session::model::push_output(&mut core.session.write().p.outputs, &out);
            core.mark_dirty();
            if summary.leftover_partial.is_some() {
                // Its temporary name could not be removed: the next start does.
                record.keep_for_cleanup();
            }
            finished(ctx, &summary)
        }
        Err(e) if e.is_cancelled() => Err(Stop::Cancelled { done }),
        Err(e @ timelapse_video::VideoError::Source(_)) => Err(Stop::Failed(
            first_error.lock().take().unwrap_or_else(|| from_video(&e)),
        )),
        Err(e) => Err(Stop::Failed(from_video(&e))),
    }
}

/// The terminal event of a finished export.
fn finished(
    ctx: &JobCtx<ExportVideoEvent>,
    summary: &timelapse_video::EncodeSummary,
) -> Result<ExportVideoEvent, Stop> {
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let elapsed_ms = (summary.elapsed_secs * 1000.0).round() as u64;
    Ok(ExportVideoEvent::Finished(VideoSummary {
        job_id: ctx.id(),
        path: summary.output.to_string_lossy().into_owned(),
        frames: u32::try_from(summary.frames).unwrap_or(u32::MAX),
        duration_secs: summary.duration_secs,
        bytes: summary.bytes,
        elapsed_ms,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::model::default_video;

    #[test]
    fn options_map_every_field() {
        let mut s = default_video();
        s.pace = Pace::Duration { seconds: 12.0 };
        s.quality = VideoQuality::Bitrate { kbps: 9000 };
        s.caption = Some(crate::ipc::CaptionOptions {
            position: crate::ipc::CaptionPosition::TopRight,
            size: 0.05,
            format: "%Y".into(),
        });
        s.resolution = crate::ipc::Resolution::P2160;
        let o = options(&s, Size::new(1920, 1080));
        assert_eq!(o.pace, timelapse_video::Pace::Duration { seconds: 12.0 });
        assert_eq!(o.quality, timelapse_video::Quality::Bitrate { kbps: 9000 });
        assert_eq!(
            o.resolution,
            timelapse_video::Resolution::Source,
            "never larger than the masters"
        );
        assert_eq!(
            o.caption.map(|c| c.position),
            Some(timelapse_video::CaptionPosition::TopRight)
        );
        assert_eq!(o.hold_last_secs, 1.0);
        assert_eq!(o.threads, work_threads());
        for (q, want) in [
            (VideoQuality::Low, timelapse_video::Quality::Low),
            (VideoQuality::Medium, timelapse_video::Quality::Medium),
            (VideoQuality::Max, timelapse_video::Quality::Max),
        ] {
            s.quality = q;
            assert_eq!(options(&s, Size::new(100, 100)).quality, want);
        }
    }

    #[test]
    fn video_path_validation() {
        let t = crate::testutil::TestCore::new();
        let dir = t.root.path();
        let path = |p: &Path| video_path(&t.core, &p.to_string_lossy());
        let ok = dir.join("a.MP4");
        t.core.grants.grant(Access::ExportFile, &ok);
        assert!(path(&ok).is_ok());
        assert!(path(&dir.join("a.mov")).is_err());
        assert!(video_path(&t.core, "a.mp4").is_err());
        let missing = dir.join("missing/a.mp4");
        t.core.grants.grant(Access::ExportFile, &missing);
        assert_eq!(
            path(&missing).expect_err("no parent").kind,
            crate::ipc::ErrorKind::NotFound
        );
        let folder = dir.join("folder.mp4");
        std::fs::create_dir_all(&folder).expect("mkdir");
        t.core.grants.grant(Access::ExportFile, &folder);
        t.core.grants.grant(Access::ReplaceFile, &folder);
        assert_eq!(
            path(&folder).expect_err("a folder").kind,
            crate::ipc::ErrorKind::InvalidArgument
        );
    }
}
