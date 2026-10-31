//! Engine-level flows on synthetic images (needs the ONNX models only).

mod common;

use face_engine::align::{FrameAdjust, RenderSettings, RenderTarget, Resolution};
use face_engine::analysis::{FaceRecord, FailureKind, Outcome};
use face_engine::color::{FaceStats, FrameLook, LookSettings, NormalizeMode};
use face_engine::export::{ImageExportSettings, ImageFormat};
use face_engine::geometry::{Point, Rect, Size};
use face_engine::matching::MatchStatus;
use face_engine::recognize::{ARCFACE_TEMPLATE, Embedding};
use face_engine::reference::{AspectPreset, default_crop};
use face_engine::scan::{ScanEvent, ScanOptions};
use face_engine::{AlignItem, AlignJob, AlignSpec, CancelToken, ExportItem, NoProgress};

fn reference() -> Embedding {
    Embedding::normalized(&(0..128).map(|i| (i as f32).sin()).collect::<Vec<_>>()).expect("emb")
}

#[test]
fn scan_caches_no_face_failed_and_unsupported_photos() {
    let Some(_) = common::engine() else { return };
    let cache = tempfile::tempdir().expect("cache");
    let engine = common::fresh_engine(cache.path()).expect("engine");
    let dir = tempfile::tempdir().expect("photos");
    for (i, name) in ["a.jpg", "b.jpg", "sub/c.JPG"].iter().enumerate() {
        let p = dir.path().join(name);
        std::fs::create_dir_all(p.parent().expect("parent")).expect("mkdir");
        common::synthetic_jpeg(&p, 480, 360, i as u32);
    }
    let png = face_engine::encode::png(&face_engine::image::RgbImage::filled(64, 48, [10, 20, 30]))
        .expect("png");
    std::fs::write(dir.path().join("d.png"), png).expect("png");
    std::fs::write(dir.path().join("broken.jpg"), b"\xff\xd8\xff garbage").expect("broken");
    std::fs::write(dir.path().join("phone.HEIC"), b"\0\0\0\x18ftypheic").expect("heic");
    std::fs::write(dir.path().join(".hidden.jpg"), b"x").expect("hidden");

    let started = std::sync::Mutex::new(None);
    let sink = |e: ScanEvent| {
        if let ScanEvent::Started {
            counts,
            unsupported,
        } = e
        {
            *started.lock().expect("lock") = Some((counts.total, unsupported));
        }
    };
    let r = engine
        .scan(
            dir.path(),
            &reference(),
            ScanOptions::default(),
            &sink,
            &CancelToken::new(),
        )
        .expect("scan");
    assert_eq!(*started.lock().expect("lock"), Some((5, 1)));
    assert!(r.complete);
    assert_eq!(
        (
            r.counts.total,
            r.counts.analyzed,
            r.counts.no_face,
            r.counts.failed
        ),
        (5, 5, 4, 1)
    );
    assert_eq!(r.unsupported.len(), 1);
    let broken = r
        .photos
        .iter()
        .find(|p| p.entry.rel_path == "broken.jpg")
        .expect("broken");
    assert_eq!(broken.status, MatchStatus::Failed);
    assert!(matches!(
        broken.analysis.outcome,
        Outcome::Failed {
            kind: FailureKind::DecodeFailed,
            ..
        }
    ));
    let rels: Vec<_> = r.photos.iter().map(|p| p.entry.rel_path.as_str()).collect();
    assert_eq!(rels, ["a.jpg", "b.jpg", "broken.jpg", "d.png", "sub/c.JPG"]);
    let a = &r.photos[0];
    assert_eq!(a.analysis.oriented_size, Size::new(480, 360));
    assert!(face_engine::thumbs::path(cache.path(), &a.id, &a.version, 320).is_file());

    // Everything (including failures) comes from the cache next time.
    let again = engine
        .scan(
            dir.path(),
            &reference(),
            ScanOptions::default(),
            &NoProgress,
            &CancelToken::new(),
        )
        .expect("rescan");
    assert_eq!((again.counts.from_cache, again.counts.analyzed), (5, 0));

    // A changed file is re-analyzed; a vanished one is dropped.
    std::thread::sleep(std::time::Duration::from_millis(20));
    common::synthetic_jpeg(&dir.path().join("a.jpg"), 500, 300, 9);
    std::fs::remove_file(dir.path().join("b.jpg")).expect("rm");
    let changed = engine
        .scan(
            dir.path(),
            &reference(),
            ScanOptions::default(),
            &NoProgress,
            &CancelToken::new(),
        )
        .expect("changed");
    assert_eq!(
        (
            changed.counts.total,
            changed.counts.analyzed,
            changed.counts.from_cache
        ),
        (4, 1, 3)
    );

    // Cancelled before starting: only cache hits, marked incomplete.
    let cancel = CancelToken::new();
    cancel.cancel();
    let opts = ScanOptions {
        rescan_all: true,
        ..ScanOptions::default()
    };
    let cancelled = engine
        .scan(dir.path(), &reference(), opts, &NoProgress, &cancel)
        .expect("cancelled");
    assert!(!cancelled.complete);
    assert!(cancelled.photos.is_empty());

    let (entries, bytes) = engine.clear_scan_cache(dir.path()).expect("clear");
    assert_eq!(entries, 4);
    assert!(bytes > 0);
    let fresh = engine
        .scan(
            dir.path(),
            &reference(),
            ScanOptions::default(),
            &NoProgress,
            &CancelToken::new(),
        )
        .expect("fresh");
    assert_eq!(fresh.counts.analyzed, 4);
    assert!(
        engine
            .scan(
                &dir.path().join("missing"),
                &reference(),
                ScanOptions::default(),
                &NoProgress,
                &CancelToken::new()
            )
            .is_err()
    );
}

#[test]
fn analyze_photo_and_thumbnails() {
    let Some(engine) = common::engine() else {
        return;
    };
    let dir = tempfile::tempdir().expect("tmp");
    let p = dir.path().join("IMG_20140815_142326.jpg");
    common::synthetic_jpeg(&p, 800, 600, 3);
    let out = engine.analyze_photo(&p, Some(160));
    assert_eq!(out.analysis.outcome, Outcome::NoFace);
    assert_eq!(
        out.analysis.date_source,
        face_engine::dates::DateSource::Filename
    );
    assert_eq!(out.analysis.taken_at.to_string(), "2014-08-15 14:23:26");
    assert!(out.thumbnail.is_some());
    let missing = engine.analyze_photo(&dir.path().join("nope.jpg"), None);
    assert!(matches!(
        missing.analysis.outcome,
        Outcome::Failed {
            kind: FailureKind::Io,
            ..
        }
    ));
    std::fs::write(dir.path().join("x.heic"), b"\0\0\0\x18ftypheic").expect("heic");
    let heic = engine.analyze_photo(&dir.path().join("x.heic"), None);
    assert!(matches!(
        heic.analysis.outcome,
        Outcome::Failed {
            kind: FailureKind::UnsupportedFormat,
            ..
        }
    ));

    let thumb = engine
        .thumbnail(&p, "0123456789abcdef", "v1", 300)
        .expect("thumb");
    let d = face_engine::decode::decode(&thumb, &p, 1, face_engine::decode::DecodeTarget::Full)
        .expect("decode");
    assert_eq!(d.image.size(), Size::new(320, 240));
    assert!(
        engine
            .cache_dir()
            .join("thumbs/01/0123456789abcdef-v1-320.jpg")
            .is_file()
    );
    assert!(engine.threads() >= 1);
    assert!(format!("{engine:?}").contains("Engine"));
    assert_eq!(engine.install(|| 2 + 2), 4);
    assert_eq!(engine.fingerprint().len(), 16);
}

#[test]
fn reference_without_a_face() {
    let Some(engine) = common::engine() else {
        return;
    };
    let dir = tempfile::tempdir().expect("tmp");
    let p = dir.path().join("ref.jpg");
    common::synthetic_jpeg(&p, 640, 480, 1);
    let r = engine.load_reference(&p, 10.0).expect("load");
    assert!(
        r.size().width > 640 && r.size().height > 480,
        "canvas expands: {:?}",
        r.size()
    );
    assert!(r.face().is_none() && r.auto_rotation_deg().is_none());
    assert!(r.eye_tilt_deg(engine.analyzer()).expect("tilt").is_none());
    assert!(
        face_engine::reference::level_rotation(engine.analyzer(), r.image())
            .expect("level")
            .is_none()
    );
    assert_eq!(r.rotation_deg(), 10.0);
    assert_eq!(r.path(), p.as_path());
    let crop = default_crop(r.size(), AspectPreset::Square);
    assert!(engine.detect_reference(&r, crop).expect("detect").is_none());
    let frame = r.render_frame(crop, Size::new(200, 200)).expect("frame");
    assert_eq!(frame.size(), Size::new(200, 200));
    assert!(
        r.render_frame(Rect::new(5000.0, 5000.0, 10.0, 10.0), Size::new(10, 10))
            .is_err()
    );
    assert!(engine.load_reference(&p, f64::NAN).is_err());
    assert!(
        engine
            .load_reference(&dir.path().join("none.jpg"), 0.0)
            .is_err()
    );
}

fn synthetic_face() -> FaceRecord {
    FaceRecord {
        bounds: Rect::new(0.35, 0.3, 0.3, 0.4),
        landmarks: [
            Point::new(0.43, 0.45),
            Point::new(0.57, 0.45),
            Point::new(0.5, 0.53),
            Point::new(0.45, 0.62),
            Point::new(0.55, 0.62),
        ],
        score: 0.9,
        embedding: reference(),
    }
}

#[test]
fn align_export_and_video_frames_from_synthetic_sources() {
    let Some(_) = common::engine() else { return };
    let cache = tempfile::tempdir().expect("cache");
    let engine = common::fresh_engine(cache.path()).expect("engine");
    let dir = tempfile::tempdir().expect("photos");
    let mut items = Vec::new();
    for i in 0..4u32 {
        let p = dir.path().join(format!("p{i}.jpg"));
        common::synthetic_jpeg(&p, 1200, 900, i);
        items.push(AlignItem {
            photo_id: format!("{i:016x}"),
            photo_version: "v1".into(),
            source: p,
            face: synthetic_face(),
            day: chrono::NaiveDate::from_ymd_opt(2014, 8, 1 + i).expect("day"),
            adjust: if i == 3 {
                FrameAdjust {
                    dx: 0.05,
                    ..FrameAdjust::default()
                }
            } else {
                FrameAdjust::default()
            },
        });
    }
    let mut missing = items[0].clone();
    missing.photo_id = "ffffffffffffffff".into();
    missing.source = dir.path().join("gone.jpg");
    items.push(missing);
    let anchors = ARCFACE_TEMPLATE.map(|p| Point::new(p.x / 112.0, p.y / 112.0));
    let out = Resolution::P720.output_size(4, 3).expect("size");
    let job = AlignJob {
        items,
        spec: AlignSpec {
            target: RenderTarget::from_crop_anchors(&anchors, out),
            settings: RenderSettings {
                resolution: Resolution::P720,
                ..RenderSettings::default()
            },
            fingerprint: "synthetic".into(),
        },
    };
    let progress = std::sync::Mutex::new(Vec::new());
    let r = engine
        .align(
            &job,
            &|p: face_engine::AlignProgress| progress.lock().expect("lock").push(p.done),
            &CancelToken::new(),
        )
        .expect("align");
    assert_eq!(r.frames.len(), 4);
    assert_eq!(r.failures.len(), 1);
    assert_eq!(r.failures[0].kind, face_engine::ErrorKind::NotFound);
    assert_eq!(progress.lock().expect("lock").len(), 5);
    assert!(r.complete);
    let store = engine.frame_store("synthetic");
    assert_eq!(store.load_manifest().len(), 4);
    let reused = engine
        .align(&job, &NoProgress, &CancelToken::new())
        .expect("again");
    assert_eq!(reused.frames.iter().filter(|f| f.reused).count(), 4);
    let cancel = CancelToken::new();
    cancel.cancel();
    assert!(
        !engine
            .align(&job, &NoProgress, &cancel)
            .expect("cancelled")
            .complete
    );

    let master = face_engine::decode::decode_file(
        &r.frames[0].master,
        face_engine::decode::DecodeTarget::Full,
    )
    .expect("master");
    assert_eq!(master.image.size(), out);

    let stats = FaceStats {
        mean: [0.5, 0.0, 0.0],
        std: [0.1, 0.02, 0.02],
    };
    let target = FaceStats {
        mean: [0.6, 0.01, 0.0],
        std: [0.1, 0.02, 0.02],
    };
    let look = FrameLook {
        frame: stats,
        reference: target,
        settings: LookSettings {
            normalize: NormalizeMode::Exposure,
            strength: 1.0,
        },
    };
    assert!(look.lut().is_some());
    let export: Vec<ExportItem> = r
        .frames
        .iter()
        .map(|f| ExportItem {
            master: f.master.clone(),
            day: f.day,
            look: Some(look),
        })
        .collect();
    let dest = tempfile::tempdir().expect("dest");
    let report = engine
        .export_images(
            &export,
            dest.path(),
            &ImageExportSettings {
                format: ImageFormat::Png,
                jpeg_quality: 95,
                overwrite: false,
            },
            &NoProgress,
            &CancelToken::new(),
        )
        .expect("export");
    let names: Vec<_> = report
        .files
        .iter()
        .filter_map(|f| f.file_name()?.to_str().map(str::to_owned))
        .collect();
    assert_eq!(
        names,
        [
            "20140801.png",
            "20140802.png",
            "20140803.png",
            "20140804.png"
        ]
    );
    assert!(
        engine
            .export_images(
                &export,
                &dest.path().join("nope"),
                &ImageExportSettings::default(),
                &NoProgress,
                &CancelToken::new()
            )
            .is_err()
    );
    let bad_q = ImageExportSettings {
        jpeg_quality: 10,
        ..ImageExportSettings::default()
    };
    assert!(
        engine
            .export_images(
                &export,
                dest.path(),
                &bad_q,
                &NoProgress,
                &CancelToken::new()
            )
            .is_err()
    );
    let mut broken = export.clone();
    broken[0].master = dir.path().join("none.jpg");
    assert!(
        engine
            .export_images(
                &broken,
                dest.path(),
                &ImageExportSettings::default(),
                &NoProgress,
                &CancelToken::new()
            )
            .is_err()
    );

    let frame = engine
        .render_frame(&face_engine::align::FrameRequest {
            source: &job.items[0].source,
            face: &job.items[0].face,
            target: &job.spec.target,
            backdrop: face_engine::warp::BackdropMode::Blurred,
            adjust: FrameAdjust::default(),
            refine_landmarks: false,
        })
        .expect("render");
    assert!(!frame.refined);
    assert!(frame.residual_px.is_finite());
}
