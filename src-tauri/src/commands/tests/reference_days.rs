//! Reference, matching, adding photos to days, input validation.

use super::*;

#[test]
fn reference_rotation_and_crop() {
    let t = TestCore::new();
    let r = t.write_reference("ref.jpg");
    let state = reference::set_photo(&t.core, &r.to_string_lossy()).expect("set");
    assert_eq!((state.image.size.width, state.image.size.height), (64, 48));
    assert_eq!(
        (state.crop.width, state.crop.height, state.aspect),
        (64.0, 48.0, AspectPreset::Free)
    );
    assert!(state.detection.is_some());
    assert_eq!(state.image.auto_rotation_deg, Some(1.5));
    let rotated = reference::set_rotation(&t.core, 10.0).expect("rotate");
    assert!(rotated.image.size.width > 64, "canvas expands");
    assert_ne!(rotated.image.version, state.image.version);
    assert_eq!(
        reference::set_rotation(&t.core, 50.0)
            .expect_err("range")
            .kind,
        ErrorKind::InvalidArgument
    );
    let sq = reference::set_crop(
        &t.core,
        Rect {
            x: 10.0,
            y: 2.0,
            width: 40.0,
            height: 40.0,
        },
        AspectPreset::Square,
    )
    .expect("crop");
    assert_eq!(sq.aspect, AspectPreset::Square);
    assert!(sq.detection.is_some());
    let off = reference::set_crop(
        &t.core,
        Rect {
            x: 0.0,
            y: 0.0,
            width: 33.0,
            height: 33.0,
        },
        AspectPreset::Free,
    )
    .expect("off face");
    assert!(
        off.detection.is_none(),
        "no face inside the crop is a state, not an error"
    );
    assert!(
        t.core.session.read().match_embedding.is_some(),
        "matching stays stable"
    );
    let bad = reference::set_crop(
        &t.core,
        Rect {
            x: 0.0,
            y: 0.0,
            width: 40.0,
            height: 30.0,
        },
        AspectPreset::Square,
    );
    assert_eq!(bad.expect_err("aspect").kind, ErrorKind::InvalidArgument);
    // New photo keeps the aspect and resets the crop.
    let r2 = t.write_reference("ref2.jpg");
    let s2 = reference::set_photo(&t.core, &r2.to_string_lossy()).expect("second");
    assert_eq!(s2.aspect, AspectPreset::Free);
    let snap = app::snapshot(&t.core);
    assert_eq!(snap.recents.references.len(), 2);
}

/// A rotation serde_json's default float parser reads back one ULP off.
const ROTATION_TRAP: f64 = 9.358_281_489_029_741;

#[test]
fn aligned_frames_survive_a_restart_after_reference_edits() {
    let t = scanned();
    small_render(&t);
    // What the UI does: level (a fractional angle), then a crop with
    // fractional coordinates (Level and Centre write such crops).
    reference::set_rotation(&t.core, ROTATION_TRAP).expect("level");
    let crop = Rect {
        x: 5.37,
        y: 3.62,
        width: 36.6,
        height: 48.8,
    };
    reference::set_crop(&t.core, crop, AspectPreset::Portrait3x4).expect("crop");
    let stored = app::snapshot(&t.core).reference.expect("reference").crop;
    for v in [stored.x, stored.y, stored.width, stored.height] {
        assert_eq!(v, v.round(), "crops are whole pixels: {stored:?}");
    }
    let key = |t: &TestCore| {
        let s = t.core.session.read();
        t.core.render_key(&s).map(|(fingerprint, _)| fingerprint)
    };
    t.align();
    let before = key(&t);
    assert_eq!(frames::view(&t.core).status, FramesStatus::Complete);
    let t = t.restart();
    assert_eq!(key(&t), before, "the same fingerprint after a restart");
    let view = frames::view(&t.core);
    assert_eq!(view.status, FramesStatus::Complete, "frames still usable");
    assert!(!view.frames.is_empty());
}

/// The analysis tag a fresh reference is stored with (fake engine).
fn current_tag() -> String {
    format!(
        "fake-engine-1+reference-v{}",
        face_engine::reference::REFERENCE_VERSION
    )
}

#[test]
fn rotating_keeps_the_same_part_of_the_photo_framed() {
    let t = TestCore::new();
    let r = t.write_reference("ref.jpg");
    reference::set_photo(&t.core, &r.to_string_lossy()).expect("set");
    let crop = Rect {
        x: 4.0,
        y: 2.0,
        width: 33.0,
        height: 44.0,
    };
    reference::set_crop(&t.core, crop, AspectPreset::Portrait3x4).expect("crop");
    let rotated = reference::set_rotation(&t.core, 10.0).expect("rotate");
    let photo_point = face_engine::geometry::Point::new(crop.x + 16.5, crop.y + 22.0);
    let expected =
        face_engine::warp::rotation_transform(face_engine::geometry::Size::new(64, 48), 10.0)
            .apply(photo_point);
    let c = &rotated.crop;
    // Centred on the same point of the photo, to the pixel (crops are whole pixels).
    assert!(
        (c.x + c.width / 2.0 - expected.x).abs() <= 1.0
            && (c.y + c.height / 2.0 - expected.y).abs() <= 1.0,
        "{c:?} is not centred on {expected:?}"
    );
    assert!(
        (c.width - 33.0).abs() <= 1.0 && (c.height - 44.0).abs() <= 1.0,
        "not resized or re-centred: {c:?}"
    );
    assert_eq!(rotated.aspect, AspectPreset::Portrait3x4);
    // And back: the original crop again, to the pixel.
    let back = reference::set_rotation(&t.core, 0.0).expect("back");
    assert!((back.crop.x - crop.x).abs() <= 1.0 && (back.crop.y - crop.y).abs() <= 1.0);
}

#[test]
fn a_reference_analyzed_by_an_older_reference_algorithm_is_redone() {
    let t = TestCore::new();
    let r = t.write_reference("ref.jpg");
    reference::set_photo(&t.core, &r.to_string_lossy()).expect("set");
    // What a build before the reference version tag stored.
    if let Some(p) = t.core.session.write().p.reference.as_mut() {
        p.engine = "fake-engine-1".into();
    }
    assert!(reference::refresh_if_stale(&t.core), "re-analyzed");
    let engine = t
        .core
        .session
        .read()
        .p
        .reference
        .as_ref()
        .map(|p| p.engine.clone());
    assert_eq!(engine, Some(current_tag()));
    assert!(!reference::refresh_if_stale(&t.core), "once");
}

#[test]
fn stale_reference_is_refreshed_once() {
    let t = TestCore::new();
    assert!(!reference::refresh_if_stale(&t.core), "no reference");
    let r = t.write_reference("ref.jpg");
    reference::set_photo(&t.core, &r.to_string_lossy()).expect("set");
    assert!(!reference::refresh_if_stale(&t.core), "fresh");
    if let Some(p) = t.core.session.write().p.reference.as_mut() {
        p.engine = "older-engine".into();
    }
    assert!(reference::refresh_if_stale(&t.core), "engine changed");
    assert_eq!(
        t.core
            .session
            .read()
            .p
            .reference
            .as_ref()
            .map(|p| p.engine.clone()),
        Some(current_tag())
    );
    std::fs::remove_file(&r).expect("rm");
    assert!(!reference::refresh_if_stale(&t.core), "photo gone");
}

#[test]
fn a_stale_reference_is_refreshed_after_a_job_that_was_running() {
    let t = TestCore::new();
    let r = t.write_reference("ref.jpg");
    reference::set_photo(&t.core, &r.to_string_lossy()).expect("set");
    if let Some(p) = t.core.session.write().p.reference.as_mut() {
        p.engine = "older-engine".into();
    }
    let job = t.core.jobs.start(crate::ipc::JobKind::Scan).expect("job");
    let core = Arc::clone(&t.core);
    let refresher = std::thread::spawn(move || reference::refresh_when_idle(&core));
    std::thread::sleep(std::time::Duration::from_millis(50));
    assert!(
        !refresher.is_finished(),
        "waits for the job instead of giving up"
    );
    (t.core.job_finisher())(&job.id);
    assert!(
        refresher.join().expect("join"),
        "refreshed once the job ended"
    );
    let engine = t
        .core
        .session
        .read()
        .p
        .reference
        .as_ref()
        .map(|p| p.engine.clone());
    assert_eq!(engine, Some(current_tag()));
}

#[test]
fn matching_survives_a_restart_with_the_crop_off_the_face() {
    let t = scanned();
    let confirmed = |t: &TestCore| app::snapshot(&t.core).counts.confirmed;
    let before = confirmed(&t);
    assert!(before > 0);
    // A rotated canvas is large enough for a crop that misses the face.
    reference::set_rotation(&t.core, 10.0).expect("rotate");
    let off = reference::set_crop(
        &t.core,
        Rect {
            x: 0.0,
            y: 0.0,
            width: 33.0,
            height: 33.0,
        },
        AspectPreset::Free,
    )
    .expect("off face");
    assert!(off.detection.is_none());
    assert_eq!(confirmed(&t), before, "matching kept within the session");
    let t = t.restart();
    assert!(t.core.session.read().match_embedding.is_some(), "restored");
    assert_eq!(confirmed(&t), before, "and after a restart");
    // A different photo with no face in its crop really has nothing to match.
    let other = t.write_reference("ref2.jpg");
    reference::set_photo(&t.core, &other.to_string_lossy()).expect("second");
    reference::set_rotation(&t.core, 10.0).expect("rotate");
    reference::set_crop(
        &t.core,
        Rect {
            x: 0.0,
            y: 0.0,
            width: 33.0,
            height: 33.0,
        },
        AspectPreset::Free,
    )
    .expect("off face");
    let t = t.restart();
    assert!(
        t.core.session.read().match_embedding.is_some(),
        "same photo as the last detected crop"
    );
}

#[test]
fn folder_photos_without_a_face_cannot_be_added_to_a_day() {
    let t = scanned();
    for name in ["IMG_20140818_090000_noface.jpg", "broken_20140819.jpg"] {
        let path = t.photos().join(name);
        let err =
            days::add_photo(&t.core, "2014-08-15", &path.to_string_lossy()).expect_err("no face");
        assert_eq!(
            err.kind,
            ErrorKind::NoFaceDetected,
            "{name}: {}",
            err.message
        );
    }
    let s = t.core.session.read();
    let d = s.decisions();
    assert!(d.reviews.is_empty() && d.day_moves.is_empty() && d.manual_photos.is_empty());
}

#[test]
fn a_walked_but_unanalyzed_folder_photo_is_analyzed_then_moved() {
    let t = TestCore::new();
    t.setup(); // walked, never scanned
    let path = t.photos().join("IMG_20140821_090000.jpg");
    let id = face_engine::walk::photo_id(&path.canonicalize().expect("canonical"));
    let patch = days::add_photo(&t.core, "2014-08-15", &path.to_string_lossy()).expect("added");
    assert!(
        patch.upserted.iter().any(|d| d.day_key == "2014-08-15"),
        "the day appeared: {patch:?}"
    );
    {
        let s = t.core.session.read();
        assert!(s.library.get(&id).is_some_and(|e| e.is_analyzed()));
        let d = s.decisions();
        assert_eq!(d.reviews.get(&id), Some(&ReviewDecision::Confirmed));
        assert_eq!(d.day_moves.get(&id).map(String::as_str), Some("2014-08-15"));
        assert!(
            d.manual_photos.is_empty(),
            "a folder photo is moved, not added by hand"
        );
    }
    // The analysis was cached like a scan's: still analyzed after a restart.
    let t = t.restart();
    assert!(
        t.core
            .session
            .read()
            .library
            .get(&id)
            .is_some_and(|e| e.is_analyzed())
    );
    // A walked photo without a face is analyzed, cached and refused.
    let noface = t.photos().join("IMG_20140818_090000_noface.jpg");
    let err =
        days::add_photo(&t.core, "2014-08-15", &noface.to_string_lossy()).expect_err("no face");
    assert_eq!(err.kind, ErrorKind::NoFaceDetected);
}

/// Waits until the fake engine has started `n` more analyses.
fn wait_for_analyses(t: &TestCore, before: usize, n: usize) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    while t
        .engine
        .analyze_calls
        .load(std::sync::atomic::Ordering::SeqCst)
        < before + n
    {
        assert!(
            std::time::Instant::now() < deadline,
            "analysis never started"
        );
        std::thread::sleep(std::time::Duration::from_millis(2));
    }
}

#[test]
fn a_folder_change_during_the_analysis_does_not_land_the_photo_elsewhere() {
    let t = TestCore::new();
    t.setup();
    let other = t.root.path().join("other");
    std::fs::create_dir_all(&other).expect("mkdir");
    let outside = t.root.path().join("IMG_20140901_100000.jpg");
    crate::engine::fake::write_jpeg(&outside, 48, 36, 90);
    t.engine
        .analyze_delay_ms
        .store(300, std::sync::atomic::Ordering::Relaxed);
    let before = t
        .engine
        .analyze_calls
        .load(std::sync::atomic::Ordering::SeqCst);
    let core = Arc::clone(&t.core);
    let path = outside.to_string_lossy().into_owned();
    let add = std::thread::spawn(move || days::add_photo(&core, "2014-09-01", &path));
    wait_for_analyses(&t, before, 1);
    folder::set_folder(&t.core, &other.to_string_lossy()).expect("other folder");
    let err = add.join().expect("join").expect_err("folder changed");
    assert_eq!(err.kind, ErrorKind::Cancelled, "{}", err.message);
    assert!(t.core.session.read().decisions().manual_photos.is_empty());
}

#[test]
fn a_job_starting_during_the_analysis_keeps_the_library_untouched() {
    let t = TestCore::new();
    t.setup(); // walked, not scanned
    let photo = t.photos().join("IMG_20140821_090000.jpg");
    let id = face_engine::walk::photo_id(&photo.canonicalize().expect("canonical"));
    t.engine
        .analyze_delay_ms
        .store(300, std::sync::atomic::Ordering::Relaxed);
    let before = t
        .engine
        .analyze_calls
        .load(std::sync::atomic::Ordering::SeqCst);
    let core = Arc::clone(&t.core);
    let path = photo.to_string_lossy().into_owned();
    let add = std::thread::spawn(move || days::add_photo(&core, "2014-08-15", &path));
    wait_for_analyses(&t, before, 1);
    let job = t.core.jobs.start(crate::ipc::JobKind::Scan).expect("job");
    let err = add.join().expect("join").expect_err("busy");
    assert_eq!(err.kind, ErrorKind::Busy);
    assert!(
        t.core
            .session
            .read()
            .library
            .get(&id)
            .is_some_and(|e| !e.is_analyzed()),
        "the running job owns the library"
    );
    (t.core.job_finisher())(&job.id);
}

#[test]
fn adding_a_photo_is_refused_while_a_job_runs_without_analyzing() {
    let t = TestCore::new();
    t.setup();
    let outside = t.root.path().join("IMG_20140901_100000.jpg");
    crate::engine::fake::write_jpeg(&outside, 48, 36, 90);
    let job = t.core.jobs.start(crate::ipc::JobKind::Scan).expect("job");
    let calls = t
        .engine
        .analyze_calls
        .load(std::sync::atomic::Ordering::SeqCst);
    let err = days::add_photo(&t.core, "2014-09-01", &outside.to_string_lossy()).expect_err("busy");
    assert_eq!(err.kind, ErrorKind::Busy);
    assert_eq!(
        t.engine
            .analyze_calls
            .load(std::sync::atomic::Ordering::SeqCst),
        calls
    );
    (t.core.job_finisher())(&job.id);
}

#[test]
fn reference_and_folder_validation() {
    let t = TestCore::new();
    let err = |r: Result<_, crate::ipc::IpcError>| r.map(|_: ()| ()).expect_err("error").kind;
    assert_eq!(
        err(reference::set_photo(&t.core, "/nope/x.jpg").map(|_| ())),
        ErrorKind::PermissionDenied,
        "not chosen by the user"
    );
    assert_eq!(
        err(
            reference::set_photo(&t.core, &t.root.path().join("nope.jpg").to_string_lossy())
                .map(|_| ())
        ),
        ErrorKind::NotFound,
        "granted folder, missing file"
    );
    assert_eq!(
        err(reference::set_photo(&t.core, "relative.jpg").map(|_| ())),
        ErrorKind::InvalidArgument
    );
    let heic = t.root.path().join("x.heic");
    std::fs::write(&heic, b"x").expect("write");
    assert_eq!(
        err(reference::set_photo(&t.core, &heic.to_string_lossy()).map(|_| ())),
        ErrorKind::UnsupportedFormat
    );
    assert_eq!(
        err(reference::set_photo(&t.core, &t.root.path().to_string_lossy()).map(|_| ())),
        ErrorKind::InvalidArgument
    );
    assert_eq!(
        err(reference::set_rotation(&t.core, 1.0).map(|_| ())),
        ErrorKind::NotReady
    );
    assert_eq!(
        err(reference::set_crop(
            &t.core,
            Rect {
                x: 0.0,
                y: 0.0,
                width: 40.0,
                height: 40.0
            },
            AspectPreset::Free
        )
        .map(|_| ())),
        ErrorKind::NotReady
    );
    assert_eq!(
        err(folder::set_folder(&t.core, &heic.to_string_lossy()).map(|_| ())),
        ErrorKind::InvalidArgument
    );
    assert_eq!(
        err(folder::set_folder(&t.core, "/nope/dir").map(|_| ())),
        ErrorKind::PermissionDenied
    );
    assert_eq!(
        err(folder::set_folder(&t.core, &t.root.path().join("nope").to_string_lossy()).map(|_| ())),
        ErrorKind::NotFound
    );
    assert_eq!(
        err(review::photos(&t.core, &PhotoQuery { statuses: None }).map(|_| ())),
        ErrorKind::NotReady
    );
    assert_eq!(err(days::days(&t.core).map(|_| ())), ErrorKind::NotReady);
    assert_eq!(
        err(review::photo(&t.core, "0123456789abcdef").map(|_| ())),
        ErrorKind::NotFound
    );
}
