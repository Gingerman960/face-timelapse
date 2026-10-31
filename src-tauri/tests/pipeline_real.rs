//! End-to-end smoke of the command layer on real photos with the real engine:
//! reference → folder → scan → review → days → align → frames/protocol →
//! export images → export video, all into temp dirs.
//!
//! Inputs (read-only; never copied, moved or modified): `FT_PHOTOS_DIR`
//! (default `/Users/gingerman/Projects/everyday photos/photos`) and
//! `FT_REFERENCE_PHOTO` (default `…/reference/IMG_20140815_142326.jpg`);
//! `FT_PIPELINE_PHOTOS` = sample size (default 50, stride-sampled). The
//! sample folder is a temp dir of *symlinks*. Skips (passes) when the photos
//! or the ONNX models are missing.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use facetimelapse_lib::commands::{app, days, folder, frames, reference, review};
use facetimelapse_lib::engine::real::{RealEngine, YUNET_FILE};
use facetimelapse_lib::grants::Access;
use facetimelapse_lib::ipc::{
    AlignEvent, ErrorKind, ExportImagesEvent, ExportVideoEvent, FramesStatus, ImageExportSettings,
    ImageFormat, MatchStatus, PhotoQuery, Rect, Resolution, ReviewDecision, ScanEvent,
};
use facetimelapse_lib::jobs::{self, EventSink, VecSink};
use facetimelapse_lib::paths::AppPaths;
use facetimelapse_lib::state::{AppMeta, Core};

fn input(var: &str, default: &str) -> Option<PathBuf> {
    let p = std::env::var_os(var).map_or_else(|| PathBuf::from(default), PathBuf::from);
    p.exists().then_some(p)
}

fn sample_folder(photos: &Path, n: usize, into: &Path) -> usize {
    let mut all: Vec<PathBuf> = std::fs::read_dir(photos)
        .expect("photos dir")
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| e.eq_ignore_ascii_case("jpg") || e.eq_ignore_ascii_case("jpeg"))
        })
        .collect();
    all.sort();
    let stride = (all.len() / n.max(1)).max(1);
    let picked: Vec<&PathBuf> = all.iter().step_by(stride).take(n).collect();
    std::fs::create_dir_all(into).expect("sample dir");
    for p in &picked {
        #[cfg(unix)]
        std::os::unix::fs::symlink(p, into.join(p.file_name().expect("name"))).expect("symlink");
    }
    picked.len()
}

fn wait<E: Clone + Send>(sink: &VecSink<E>, terminal: impl Fn(&E) -> bool, secs: u64) -> Vec<E> {
    sink.wait_for(Duration::from_secs(secs), |e| {
        e.last().is_some_and(&terminal)
    })
}

fn wait_idle(core: &Core) {
    for _ in 0..4000 {
        if core.jobs.active().is_none() {
            return;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    panic!("job did not release its slot");
}

#[test]
fn real_photos_end_to_end() {
    let Some(photos) = input(
        "FT_PHOTOS_DIR",
        "/Users/gingerman/Projects/everyday photos/photos",
    ) else {
        eprintln!("skipped: FT_PHOTOS_DIR not present");
        return;
    };
    let Some(reference_photo) = input(
        "FT_REFERENCE_PHOTO",
        "/Users/gingerman/Projects/everyday photos/reference/IMG_20140815_142326.jpg",
    ) else {
        eprintln!("skipped: FT_REFERENCE_PHOTO not present");
        return;
    };
    let models = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../models");
    if !models.join(YUNET_FILE).is_file() {
        eprintln!("skipped: models/ not fetched (scripts/fetch-models.sh)");
        return;
    }
    let n: usize = std::env::var("FT_PIPELINE_PHOTOS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(50);
    let tmp = tempfile::tempdir().expect("tempdir");
    let sample = tmp.path().join("sample");
    let count = sample_folder(&photos, n, &sample);
    let paths = AppPaths::under_root(&tmp.path().join("app"), models);
    paths.prepare().expect("prepare");
    let core = Core::new(
        paths,
        Arc::new(RealEngine::new(
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../models"),
        )),
        AppMeta::current("2.0.0"),
    );
    core.restore();
    // As if chosen in the dialogs.
    core.grants.grant(Access::Read, &reference_photo);
    core.grants.grant(Access::Read, &sample);

    let t = Instant::now();
    let r = reference::set_photo(&core, &reference_photo.to_string_lossy()).expect("reference");
    assert!(
        r.detection.is_some(),
        "face in the default crop of the reference"
    );
    eprintln!("reference: {:?} in {:?}", r.image.size, t.elapsed());
    let t = Instant::now();
    let crop = reference::set_crop(&core, r.crop, r.aspect).expect("crop update");
    assert!(crop.detection.is_some());
    eprintln!("crop update (detect + embed + rematch): {:?}", t.elapsed());
    // Level the eyes, then nudge the crop by fractions of a pixel, as the
    // UI's Level and Centre do: the frames must survive a restart (QA N1).
    let auto = r.image.auto_rotation_deg.expect("levelling angle");
    let levelled = reference::set_rotation(&core, auto).expect("level");
    let c = levelled.crop;
    let centred = reference::set_crop(
        &core,
        Rect {
            x: c.x + 0.37,
            y: c.y + 0.61,
            width: c.width - 1.0,
            height: c.height - 1.0,
        },
        levelled.aspect,
    )
    .expect("centre");
    assert!(centred.detection.is_some());
    let info = folder::set_folder(&core, &sample.to_string_lossy()).expect("folder");
    assert_eq!(info.image_count as usize, count);

    // Scan (cold), then rescan (warm cache).
    let t = Instant::now();
    let sink = Arc::new(VecSink::<ScanEvent>::default());
    jobs::scan::start(&core, sink.clone() as Arc<dyn EventSink<ScanEvent>>).expect("scan");
    let events = wait(
        &sink,
        |e| {
            matches!(
                e,
                ScanEvent::Finished(_) | ScanEvent::Failed(_) | ScanEvent::Cancelled(_)
            )
        },
        600,
    );
    wait_idle(&core);
    let Some(ScanEvent::Finished(summary)) = events.last() else {
        panic!("scan ended with {:?}", events.last())
    };
    eprintln!(
        "scan: {summary:?} ({:.1} photos/s)",
        f64::from(summary.analyzed) / t.elapsed().as_secs_f64()
    );
    assert_eq!(summary.total as usize, count);
    assert!(
        summary.confirmed * 2 >= summary.total,
        "most sampled selfies match the reference: {summary:?}"
    );
    let sink = Arc::new(VecSink::<ScanEvent>::default());
    jobs::scan::start(&core, sink.clone() as Arc<dyn EventSink<ScanEvent>>).expect("rescan");
    let events = wait(
        &sink,
        |e| {
            matches!(
                e,
                ScanEvent::Finished(_) | ScanEvent::Failed(_) | ScanEvent::Cancelled(_)
            )
        },
        120,
    );
    wait_idle(&core);
    assert!(
        matches!(events.last(), Some(ScanEvent::Finished(s)) if s.from_cache as usize == count && s.analyzed == 0)
    );

    // Review: confirm every uncertain photo (auto-review).
    let uncertain: Vec<String> = review::photos(
        &core,
        &PhotoQuery {
            statuses: Some(vec![MatchStatus::Uncertain]),
        },
    )
    .expect("photos")
    .into_iter()
    .map(|p| p.id)
    .collect();
    if !uncertain.is_empty() {
        review::review(&core, &uncertain, ReviewDecision::Confirmed).expect("review");
    }
    let all_days = days::days(&core).expect("days");
    assert!(!all_days.is_empty());
    eprintln!("days: {}", all_days.len());

    // Align at 720p.
    core.session.write().p.render.resolution = Resolution::P720;
    let t = Instant::now();
    let sink = Arc::new(VecSink::<AlignEvent>::default());
    let render = core.session.read().p.render;
    jobs::align::start(
        &core,
        render,
        sink.clone() as Arc<dyn EventSink<AlignEvent>>,
    )
    .expect("align");
    let events = wait(
        &sink,
        |e| {
            matches!(
                e,
                AlignEvent::Finished(_) | AlignEvent::Failed(_) | AlignEvent::Cancelled(_)
            )
        },
        600,
    );
    wait_idle(&core);
    let Some(AlignEvent::Finished(aligned)) = events.last() else {
        panic!("align ended with {:?}", events.last())
    };
    eprintln!(
        "align: rendered {} reused {} failed {} in {:?} ({:.1} frames/s)",
        aligned.rendered,
        aligned.reused,
        aligned.failed.len(),
        t.elapsed(),
        f64::from(aligned.rendered) / t.elapsed().as_secs_f64()
    );
    assert!(aligned.rendered > 0);
    let view = frames::view(&core);
    assert!(!view.frames.is_empty());
    let mean_residual =
        view.frames.iter().map(|f| f.residual_px).sum::<f64>() / view.frames.len() as f64;
    eprintln!(
        "mean residual: {mean_residual:.2} px at {:?}",
        view.output_size
    );

    // Protocol serves real thumbnails and frames.
    let f = &view.frames[0];
    let thumb = facetimelapse_lib::protocol::serve_blocking(
        &core,
        "GET",
        &format!("/thumb/{}", f.photo_id),
        Some("w=320"),
    );
    assert_eq!(thumb.status(), 200);
    let frame = facetimelapse_lib::protocol::serve_blocking(
        &core,
        "GET",
        &format!("/aligned/{}", f.photo_id),
        Some(&format!("w=640&v={}", f.version)),
    );
    assert_eq!(frame.status(), 200);

    // Exports.
    let out = tmp.path().join("export");
    std::fs::create_dir_all(&out).expect("out");
    core.grants.grant(Access::ExportDir, &out);
    let sink = Arc::new(VecSink::<ExportImagesEvent>::default());
    let settings = ImageExportSettings {
        format: ImageFormat::Jpeg,
        jpeg_quality: 90,
        overwrite: false,
    };
    jobs::export_images::start(
        &core,
        &out.to_string_lossy(),
        settings,
        sink.clone() as Arc<dyn EventSink<ExportImagesEvent>>,
    )
    .expect("export");
    let events = wait(
        &sink,
        |e| {
            matches!(
                e,
                ExportImagesEvent::Finished(_)
                    | ExportImagesEvent::Failed(_)
                    | ExportImagesEvent::Cancelled(_)
            )
        },
        600,
    );
    wait_idle(&core);
    assert!(
        matches!(events.last(), Some(ExportImagesEvent::Finished(s)) if s.written as usize == view.frames.len()),
        "{:?}",
        events.last()
    );
    let video = out.join("timelapse.mp4");
    core.grants.grant(Access::ExportFile, &video);
    let sink = Arc::new(VecSink::<ExportVideoEvent>::default());
    let t = Instant::now();
    let settings = core.session.read().p.video.clone();
    jobs::export_video::start(
        &core,
        &video.to_string_lossy(),
        settings,
        sink.clone() as Arc<dyn EventSink<ExportVideoEvent>>,
    )
    .expect("video");
    let events = wait(
        &sink,
        |e| {
            matches!(
                e,
                ExportVideoEvent::Finished(_)
                    | ExportVideoEvent::Failed(_)
                    | ExportVideoEvent::Cancelled(_)
            )
        },
        600,
    );
    wait_idle(&core);
    let Some(ExportVideoEvent::Finished(v)) = events.last() else {
        panic!("video ended with {:?}", events.last())
    };
    eprintln!(
        "video: {} frames, {:.1}s, {} bytes in {:?}",
        v.frames,
        v.duration_secs,
        v.bytes,
        t.elapsed()
    );
    assert!(video.is_file() && v.bytes > 0);
    let snap = app::snapshot(&core);
    assert!(snap.active_job.is_none());

    // Restart on the same data: the same frames, nothing to re-align.
    let render_key = |core: &Core| {
        let s = core.session.read();
        core.render_key(&s).map(|(fingerprint, _)| fingerprint)
    };
    let before = (render_key(&core), view.frames.len());
    core.flush();
    drop(core);
    let paths = AppPaths::under_root(&tmp.path().join("app"), models_dir());
    let core = Core::new(
        paths,
        Arc::new(RealEngine::new(models_dir())),
        AppMeta::current("2.0.0"),
    );
    core.restore();
    core.require_models().expect("models");
    reference::refresh_when_idle(&core);
    let again = frames::view(&core);
    assert_eq!(
        (render_key(&core), again.frames.len()),
        before,
        "frames still current after a restart"
    );
    assert_eq!(again.status, FramesStatus::Complete);

    // Restart without the models (QA N5): the same library, days and frames,
    // read-only (from the remembered engine fingerprint); scans need models.
    let restored = |core: &Core| {
        let json = |v: serde_json::Result<String>| v.expect("serialize");
        (
            json(serde_json::to_string(
                &review::photos(core, &PhotoQuery { statuses: None }).expect("photos"),
            )),
            json(serde_json::to_string(&days::days(core).expect("days"))),
            json(serde_json::to_string(&frames::view(core))),
        )
    };
    let with_models = restored(&core);
    core.flush();
    drop(core);
    let no_models = tempfile::tempdir().expect("tempdir");
    let core = Core::new(
        AppPaths::under_root(&tmp.path().join("app"), models_dir()),
        Arc::new(RealEngine::new(no_models.path().to_path_buf())),
        AppMeta::current("2.0.0"),
    );
    core.restore();
    assert!(core.require_models().is_err(), "no models");
    assert!(
        restored(&core) == with_models,
        "same photos, days and frames"
    );
    assert_eq!(frames::view(&core).status, FramesStatus::Complete);
    let sink = Arc::new(VecSink::<ScanEvent>::default());
    let refused = jobs::scan::start(&core, sink as Arc<dyn EventSink<ScanEvent>>)
        .expect_err("a scan needs the models");
    assert_eq!(refused.kind, ErrorKind::ModelUnavailable);
    core.flush();
}

fn models_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../models")
}
