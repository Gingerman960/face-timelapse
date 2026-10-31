//! Real-engine adapter tests: model loading, the pre-load fingerprint and
//! (when the repo's `models/` are present) model-backed analysis on synthetic
//! images and the user's reference photo (read-only, never copied).

use std::path::PathBuf;

use super::*;
use crate::engine::fake::write_jpeg;
use crate::ipc::ErrorKind;

fn models() -> Option<PathBuf> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../models");
    dir.join(YUNET_FILE).is_file().then_some(dir)
}

fn reference_photo() -> Option<PathBuf> {
    let p = std::env::var_os("FT_REFERENCE_PHOTO").map_or_else(
        || {
            PathBuf::from(
                "/Users/gingerman/Projects/everyday photos/reference/IMG_20140815_142326.jpg",
            )
        },
        PathBuf::from,
    );
    p.is_file().then_some(p)
}

#[test]
fn missing_models_are_model_unavailable() {
    let dir = tempfile::tempdir().expect("tempdir");
    let e = RealEngine::new(dir.path().to_path_buf());
    assert!(!e.models_ready());
    assert_eq!(
        e.load_models().expect_err("missing").kind,
        ErrorKind::ModelUnavailable
    );
    assert!(e.analyzer().is_err());
    assert!(e.renderer().is_err());
    let photo = dir.path().join("a.jpg");
    write_jpeg(&photo, 40, 30, 90);
    assert_eq!(
        e.reference(&photo, 0.0).expect_err("models").kind,
        ErrorKind::ModelUnavailable
    );
    assert_eq!(e.fingerprint(), None, "no models, no fingerprint");
    assert_eq!(e.fingerprint(), None, "stable");
    assert_eq!(
        e.reference(&dir.path().join("x.heic"), 0.0)
            .expect_err("heic")
            .kind,
        ErrorKind::UnsupportedFormat
    );
}

#[test]
fn a_missing_fingerprint_is_never_remembered() {
    let Some(repo_models) = models() else {
        return;
    };
    let dir = tempfile::tempdir().expect("tempdir");
    let e = RealEngine::new(dir.path().to_path_buf());
    assert_eq!(e.fingerprint(), None, "models not readable yet");
    // Altered files have none either: they would not load.
    for name in [YUNET_FILE, SFACE_FILE] {
        std::fs::write(dir.path().join(name), b"altered").expect("write");
    }
    assert_eq!(e.fingerprint(), None, "altered models");
    for name in [YUNET_FILE, SFACE_FILE] {
        std::fs::remove_file(dir.path().join(name)).expect("remove");
    }
    // The models appear (e.g. a transient read error is over).
    for name in [YUNET_FILE, SFACE_FILE] {
        let (model, link) = (repo_models.join(name), dir.path().join(name));
        #[cfg(unix)]
        std::os::unix::fs::symlink(model, link).expect("link");
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(model, link).expect("link");
    }
    let real = e.fingerprint().expect("readable now");
    assert_eq!(
        e.fingerprint().as_deref(),
        Some(real.as_str()),
        "remembered once real"
    );
    let loaded = RealEngine::new(repo_models.clone());
    loaded.load_models().expect("models");
    assert_eq!(
        loaded.fingerprint().as_deref(),
        Some(real.as_str()),
        "the loaded models' own fingerprint"
    );
    assert_eq!(
        real,
        fe::analysis::analysis_fingerprint(&repo_models, &DetectorConfig::default())
            .expect("fingerprint")
    );
}

#[test]
fn models_analyze_render_and_reference() {
    let Some(models) = models() else {
        eprintln!("skipped: models/ not fetched (scripts/fetch-models.sh)");
        return;
    };
    let dir = tempfile::tempdir().expect("tempdir");
    let e = RealEngine::new(models);
    let early = e.fingerprint();
    e.load_models().expect("load");
    assert!(e.models_ready());
    assert_eq!(
        e.analyzer.get().map(Analyzer::fingerprint),
        early,
        "pre-load fingerprint matches"
    );
    let photo = dir.path().join("flat.jpg");
    write_jpeg(&photo, 320, 240, 128);
    let out = e
        .analyzer()
        .expect("analyzer")
        .analyze(&photo, 0, Some(160));
    assert_eq!(out.analysis.outcome, fe::analysis::Outcome::NoFace);
    assert_eq!(
        out.analysis.oriented_size,
        fe::geometry::Size::new(320, 240)
    );
    assert!(out.thumbnail.is_some());
    assert!(e.renderer().is_ok());
    let info = e.reference(&photo, 0.0).expect("reference");
    assert_eq!(
        (info.size, info.face.is_none()),
        (fe::geometry::Size::new(320, 240), true)
    );
    assert_eq!(
        e.reference_crop(&photo, 0.0, Rect::new(0.0, 0.0, 100.0, 100.0))
            .expect("crop"),
        None
    );
    let Some(reference) = reference_photo() else {
        eprintln!("skipped: reference photo not present");
        return;
    };
    let info = e.reference(&reference, 0.0).expect("reference photo");
    let face = info.face.expect("face on the reference");
    assert!(
        face.anchors[0].x < face.anchors[1].x,
        "image-left eye first"
    );
    let crop = fe::reference::default_crop(info.size, fe::reference::AspectPreset::Free);
    let det = e
        .reference_crop(&reference, 0.0, crop)
        .expect("crop")
        .expect("face in crop");
    assert_eq!(det.embedding.0.len(), 128);
}

#[test]
fn previews_render_without_models() {
    let dir = tempfile::tempdir().expect("tempdir");
    let e = RealEngine::new(dir.path().to_path_buf());
    let photo = dir.path().join("p.jpg");
    write_jpeg(&photo, 120, 90, 100);
    let face = fe::analysis::FaceRecord {
        bounds: Rect::new(0.3, 0.3, 0.4, 0.4),
        landmarks: [(0.4, 0.4), (0.6, 0.4), (0.5, 0.5), (0.42, 0.6), (0.58, 0.6)]
            .map(|(x, y)| fe::geometry::Point::new(x, y)),
        score: 0.9,
        embedding: fe::recognize::Embedding(vec![1.0]),
    };
    let target = fe::align::RenderTarget::from_crop_anchors(
        &face.landmarks,
        fe::geometry::Size::new(40, 50),
    );
    let request = fe::align::FrameRequest {
        source: &photo,
        face: &face,
        target: &target,
        backdrop: fe::warp::BackdropMode::Extended,
        adjust: fe::align::FrameAdjust::default(),
        refine_landmarks: true,
    };
    let frame = e.render_preview(&request).expect("no models needed");
    assert_eq!(frame.image.size(), fe::geometry::Size::new(40, 50));
    assert!(!frame.refined);
    let missing = dir.path().join("gone.jpg");
    let gone = e
        .render_preview(&fe::align::FrameRequest {
            source: &missing,
            ..request
        })
        .expect_err("no photo");
    assert_eq!(gone.kind, ErrorKind::NotFound);
}

#[test]
fn an_unchanged_set_of_altered_models_is_hashed_once() {
    let dir = tempfile::tempdir().expect("tempdir");
    for name in [YUNET_FILE, SFACE_FILE] {
        std::fs::write(dir.path().join(name), b"altered").expect("write");
    }
    let e = RealEngine::new(dir.path().to_path_buf());
    assert_eq!(e.fingerprint(), None);
    assert_eq!(e.fingerprint(), None);
    assert_eq!(
        e.hashes.load(std::sync::atomic::Ordering::Relaxed),
        1,
        "not hashed again"
    );
    // A changed file is checked again.
    std::fs::write(dir.path().join(SFACE_FILE), b"altered again").expect("write");
    assert_eq!(e.fingerprint(), None);
    assert_eq!(e.hashes.load(std::sync::atomic::Ordering::Relaxed), 2);
}
