//! A start without the face models (QA N5): the session is restored read-only
//! from the caches of the last engine whose models loaded
//! (`session.json` `lastEngineFingerprint`), so the library, days and frames
//! stay as they were; everything that needs detection fails with
//! `modelUnavailable`.

use super::*;

fn json<T: serde::Serialize>(v: &T) -> String {
    serde_json::to_string(v).expect("serialize")
}

/// Everything a restore rebuilds that the UI reads (lists as JSON: the IPC
/// values serialize exactly).
fn restored(t: &TestCore) -> (crate::ipc::SessionSnapshot, String, String, String) {
    let photos = review::photos(&t.core, &PhotoQuery { statuses: None }).expect("photos");
    let days = days::days(&t.core).expect("days");
    let frames = frames::view(&t.core);
    (
        app::snapshot(&t.core),
        json(&photos),
        json(&days),
        json(&frames),
    )
}

/// Scanned and aligned, then restarted once with the models (as the app
/// does on every normal start).
fn aligned_and_restarted() -> TestCore {
    let t = scanned();
    small_render(&t);
    t.align();
    assert_eq!(frames::view(&t.core).status, FramesStatus::Complete);
    t.restart()
}

fn remembered(t: &TestCore) -> serde_json::Value {
    t.core.flush();
    let text = std::fs::read_to_string(t.core.paths.session_file()).expect("session.json");
    let json: serde_json::Value = serde_json::from_str(&text).expect("json");
    json["lastEngineFingerprint"].clone()
}

/// Quits and edits the saved `lastEngineFingerprint` (`None` removes it).
fn quit_remembering(t: TestCore, fingerprint: Option<&str>) -> tempfile::TempDir {
    let root = t.quit();
    let file = TestCore::session_file(&root);
    let mut json: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&file).expect("read")).expect("json");
    let session = json.as_object_mut().expect("object");
    match fingerprint {
        Some(f) => session.insert("lastEngineFingerprint".into(), f.into()),
        None => session.remove("lastEngineFingerprint"),
    };
    std::fs::write(&file, json.to_string()).expect("write");
    root
}

#[test]
fn a_start_without_models_restores_the_same_library_days_and_frames() {
    let t = aligned_and_restarted();
    let with_models = restored(&t);
    assert_eq!(remembered(&t), "fake-engine-1", "the engine is remembered");
    assert!(with_models.0.folder.is_some());

    let t = t.restart_without_models();
    assert!(!t.core.engine.models_ready());
    let without = restored(&t);
    assert_eq!(
        without, with_models,
        "same session, photos, days and frames"
    );
    assert_eq!(without.0.frames.status, FramesStatus::Complete);
    assert_eq!(remembered(&t), "fake-engine-1", "kept for the next start");

    // Decisions and looks need no detection.
    let id = id_of(&t, "IMG_20140815_120000");
    review::review(&t.core, &[id], ReviewDecision::Confirmed).expect("review");
    let look = LookSettings {
        normalize: NormalizeMode::Exposure,
        strength: 0.5,
    };
    let view = frames::look(&t.core, look).expect("look without models");
    assert_eq!(view.status, FramesStatus::Complete);

    // The frames stay exportable.
    let out = t.root.path().join("out");
    std::fs::create_dir_all(&out).expect("mkdir");
    let png = ImageExportSettings {
        format: ImageFormat::Png,
        jpeg_quality: 95,
        overwrite: false,
    };
    let ev = t.export_images(&out, png);
    assert!(
        matches!(ev.last(), Some(ExportImagesEvent::Finished(s)) if s.written == 3),
        "{ev:?}"
    );
}

#[test]
fn without_models_everything_that_needs_detection_is_model_unavailable() {
    let t = aligned_and_restarted().restart_without_models();
    let sink = || {
        Arc::new(crate::jobs::VecSink::<crate::ipc::ScanEvent>::default())
            as Arc<dyn crate::jobs::EventSink<crate::ipc::ScanEvent>>
    };
    let model_unavailable = |r: Result<(), crate::ipc::IpcError>, what: &str| {
        assert_eq!(
            r.expect_err(what).kind,
            ErrorKind::ModelUnavailable,
            "{what}"
        );
    };
    model_unavailable(crate::jobs::scan::start(&t.core, sink()).map(drop), "scan");
    let render = t.core.session.read().p.render;
    let align_sink = Arc::new(crate::jobs::VecSink::<AlignEvent>::default())
        as Arc<dyn crate::jobs::EventSink<AlignEvent>>;
    model_unavailable(
        crate::jobs::align::start(&t.core, render, align_sink).map(drop),
        "align",
    );
    let other = t.write_reference("other_ref.jpg");
    model_unavailable(
        reference::set_photo(&t.core, &other.to_string_lossy()).map(drop),
        "new reference",
    );
    model_unavailable(reference::set_rotation(&t.core, 3.0).map(drop), "rotation");
    let outside = t.write_reference("IMG_20140901_090000.jpg");
    model_unavailable(
        days::add_photo(&t.core, "2014-08-15", &outside.to_string_lossy()).map(drop),
        "add an outside photo",
    );
    let id = id_of(&t, "IMG_20140815_100000");
    model_unavailable(
        frames::adjust(
            &t.core,
            &id,
            FrameAdjust {
                dx: 0.01,
                dy: 0.0,
                scale: 1.0,
                rotation_deg: 0.0,
            },
        )
        .map(drop),
        "frame nudge",
    );
    assert!(t.core.jobs.active().is_none(), "no job left behind");
    assert_eq!(
        frames::view(&t.core).status,
        FramesStatus::Complete,
        "nothing was invalidated"
    );
}

#[test]
fn a_remembered_fingerprint_of_another_engine_validates_nothing() {
    let t = aligned_and_restarted();
    let with_models = restored(&t);
    // The last engine that loaded was another one: these caches are not its.
    let t = TestCore::start_without_models(quit_remembering(t, Some("other-engine")));
    let (snap, photos, days, frames_view) = restored(&t);
    assert_ne!(photos, with_models.1, "no analysis of another engine used");
    assert_ne!(days, with_models.2);
    assert_ne!(frames_view, with_models.3);
    assert_ne!(snap.frames.status, FramesStatus::Complete);
    assert_eq!(remembered(&t), "other-engine", "nothing better to remember");

    // With the models, the live fingerprint wins and is remembered.
    let t = t.restart();
    assert_eq!(restored(&t), with_models);
    assert_eq!(remembered(&t), "fake-engine-1");
}

#[test]
fn without_models_and_nothing_remembered_no_cache_is_used() {
    let t = aligned_and_restarted();
    let with_models = restored(&t);
    // A session saved before engines were remembered.
    let t = TestCore::start_without_models(quit_remembering(t, None));
    let (_, photos, _, _) = restored(&t);
    assert_ne!(photos, with_models.1);
    assert_eq!(remembered(&t), serde_json::Value::Null);
}
