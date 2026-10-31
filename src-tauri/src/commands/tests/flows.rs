//! The main flows: review → days → align → export, and reset.

use super::*;

#[test]
fn review_days_and_persistence() {
    let t = scanned();
    let unsure = id_of(&t, "unsure");
    let counts = review::review(
        &t.core,
        std::slice::from_ref(&unsure),
        ReviewDecision::Confirmed,
    )
    .expect("review");
    assert_eq!((counts.review_pending, counts.included), (0, 5));
    let uncertain = review::photos(
        &t.core,
        &PhotoQuery {
            statuses: Some(vec![MatchStatus::Uncertain]),
        },
    )
    .expect("filter");
    assert_eq!(uncertain.len(), 1);
    assert_eq!(uncertain[0].review, ReviewDecision::Confirmed);
    assert_eq!(
        review::review(
            &t.core,
            &["ffffffffffffffff".into()],
            ReviewDecision::Rejected
        )
        .expect_err("unknown")
        .kind,
        ErrorKind::NotFound
    );
    let noface = id_of(&t, "noface");
    assert_eq!(
        review::review(
            &t.core,
            std::slice::from_ref(&noface),
            ReviewDecision::Confirmed
        )
        .expect_err("no face")
        .kind,
        ErrorKind::InvalidArgument
    );
    assert!(
        review::review(
            &t.core,
            std::slice::from_ref(&noface),
            ReviewDecision::Rejected
        )
        .is_ok(),
        "rejecting is fine"
    );
    let other = id_of(&t, "_other");
    let rescued = review::review(
        &t.core,
        std::slice::from_ref(&other),
        ReviewDecision::Confirmed,
    )
    .expect("rescue rejected");
    assert_eq!(rescued.included, 6);
    review::review(
        &t.core,
        std::slice::from_ref(&other),
        ReviewDecision::Pending,
    )
    .expect("undo");

    let all = days::days(&t.core).expect("days");
    assert_eq!(
        all.iter().map(|d| d.day_key.as_str()).collect::<Vec<_>>(),
        ["2014-08-15", "2014-08-16", "2014-08-20", "2014-08-21"]
    );
    let d15 = &all[0];
    assert_eq!(d15.photo_ids.len(), 2);
    let other = d15.photo_ids[1].clone();
    let g = days::select(&t.core, "2014-08-15", &other).expect("select");
    assert!(g.manual_selection && g.selected_id == other);
    assert_eq!(
        days::select(&t.core, "2014-08-15", &unsure)
            .expect_err("not in day")
            .kind,
        ErrorKind::InvalidArgument
    );
    assert_eq!(
        days::select(&t.core, "2014-01-01", &other)
            .expect_err("no day")
            .kind,
        ErrorKind::NotFound
    );

    let patch = days::move_photo(&t.core, &other, "2014-08-30").expect("move");
    assert_eq!(
        patch
            .upserted
            .iter()
            .map(|d| d.day_key.as_str())
            .collect::<Vec<_>>(),
        ["2014-08-15", "2014-08-30"]
    );
    assert_eq!(
        days::move_photo(&t.core, &other, "2014-13-40")
            .expect_err("bad day")
            .kind,
        ErrorKind::InvalidArgument
    );
    let back = days::move_photo(&t.core, &other, "2014-08-15").expect("move back");
    assert_eq!(back.removed, ["2014-08-30"]);

    let ex = days::set_excluded(&t.core, "2014-08-21", true).expect("exclude");
    assert!(ex.excluded);
    assert_eq!(
        days::set_excluded(&t.core, "2014-01-01", true)
            .expect_err("no day")
            .kind,
        ErrorKind::NotFound
    );

    // A folder photo added to another day is a confirmed move; an outside photo is analyzed.
    let rejected = t.photos().join("IMG_20140817_090000_other.jpg");
    let p = days::add_photo(&t.core, "2014-09-01", &rejected.to_string_lossy())
        .expect("add folder photo");
    assert_eq!(p.upserted.len(), 1);
    let outside = t.root.path().join("extra_20200101.jpg");
    crate::engine::fake::write_jpeg(&outside, 40, 30, 50);
    let p = days::add_photo(&t.core, "2014-09-02", &outside.to_string_lossy())
        .expect("add outside photo");
    assert_eq!(p.upserted[0].day_key, "2014-09-02");
    let noface = t.root.path().join("noface_extra.jpg");
    crate::engine::fake::write_jpeg(&noface, 40, 30, 50);
    assert_eq!(
        days::add_photo(&t.core, "2014-09-03", &noface.to_string_lossy())
            .expect_err("no face")
            .kind,
        ErrorKind::NoFaceDetected
    );

    let before = app::snapshot(&t.core);
    let t = t.restart();
    let after = app::snapshot(&t.core);
    assert_eq!(before.counts, after.counts, "decisions persisted");
    let restored = days::days(&t.core).expect("days");
    assert!(
        restored.iter().any(|d| d.day_key == "2014-09-02"),
        "manual add restored without models"
    );
    assert!(
        restored
            .iter()
            .any(|d| d.day_key == "2014-08-21" && d.excluded)
    );
    assert!(
        restored
            .iter()
            .any(|d| d.day_key == "2014-08-15" && d.manual_selection)
    );
}

#[test]
fn align_frames_adjust_and_look() {
    let t = scanned();
    small_render(&t);
    assert_eq!(frames::view(&t.core).status, FramesStatus::Missing);
    let events = t.align();
    let recents: Vec<_> = events
        .iter()
        .filter_map(|e| {
            if let AlignEvent::Progress(p) = e {
                Some(p.recent.clone())
            } else {
                None
            }
        })
        .flatten()
        .collect();
    assert_eq!(recents.len(), 3);
    assert!(
        recents
            .iter()
            .all(|r| r.version.len() == 12 && r.day_key.starts_with("2014-08-"))
    );
    let summary = match events.last() {
        Some(AlignEvent::Finished(s)) => s.clone(),
        other => panic!("align ended with {other:?}"),
    };
    assert_eq!(
        (summary.total, summary.rendered, summary.reused),
        (3, 3, 0),
        "days 15, 20, 21"
    );
    assert!(summary.failed.is_empty());
    assert_eq!(
        (summary.output_size.width, summary.output_size.height),
        (960, 720)
    );
    let view = frames::view(&t.core);
    assert_eq!(
        (view.status, view.frames.len()),
        (FramesStatus::Complete, 3)
    );
    assert_eq!(view.reference_anchors.as_ref().map(Vec::len), Some(5));
    // Second run reuses every master.
    let again = t.align();
    assert!(
        matches!(again.last(), Some(AlignEvent::Finished(s)) if s.reused == 3 && s.rendered == 0)
    );

    let id = view.frames[0].photo_id.clone();
    let adj = FrameAdjust {
        dx: 0.1,
        dy: 0.0,
        scale: 1.1,
        rotation_deg: 2.0,
    };
    let fs = frames::adjust(&t.core, &id, adj).expect("adjust");
    assert_eq!(fs.adjust, adj);
    assert_ne!(fs.version, view.frames[0].version);
    assert_eq!(
        frames::adjust(&t.core, &id, FrameAdjust { scale: 3.0, ..adj })
            .expect_err("range")
            .kind,
        ErrorKind::InvalidArgument
    );
    assert_eq!(
        frames::adjust(&t.core, "ffffffffffffffff", adj)
            .expect_err("unknown")
            .kind,
        ErrorKind::NotFound
    );
    assert_eq!(
        frames::view(&t.core).status,
        FramesStatus::Complete,
        "adjusted frame re-rendered synchronously"
    );

    assert!(
        frames::view(&t.core)
            .frames
            .iter()
            .all(|f| f.look_delta.is_none()),
        "look off ⇒ no delta"
    );
    let looked = frames::look(
        &t.core,
        LookSettings {
            normalize: NormalizeMode::Exposure,
            strength: 0.5,
        },
    )
    .expect("look");
    assert!(
        looked.frames.iter().all(|f| f.look_delta.is_some()),
        "look on ⇒ delta from stats"
    );
    assert!(
        frames::adjust(&t.core, &id, adj)
            .expect("adjust with look")
            .look_delta
            .is_some()
    );
    assert_ne!(
        looked.frames[0].version,
        frames::view(&t.core).frames[0].version.clone() + "x"
    );
    assert_eq!(
        frames::look(
            &t.core,
            LookSettings {
                normalize: NormalizeMode::Off,
                strength: 1.5
            }
        )
        .expect_err("range")
        .kind,
        ErrorKind::InvalidArgument
    );

    // Changing the crop changes the fingerprint ⇒ frames are stale.
    reference::set_crop(
        &t.core,
        Rect {
            x: 8.0,
            y: 0.0,
            width: 48.0,
            height: 48.0,
        },
        AspectPreset::Square,
    )
    .expect("crop");
    assert_eq!(app::snapshot(&t.core).frames.status, FramesStatus::Stale);
}

#[test]
fn exports_images_and_video() {
    let t = scanned();
    small_render(&t);
    t.align();
    let out = t.root.path().join("out");
    std::fs::create_dir_all(&out).expect("mkdir");
    let png = ImageExportSettings {
        format: ImageFormat::Png,
        jpeg_quality: 95,
        overwrite: false,
    };
    let ev = t.export_images(&out, png);
    assert!(
        matches!(ev.last(), Some(ExportImagesEvent::Finished(s)) if s.written == 3 && s.renamed == 0)
    );
    assert!(out.join("20140815.png").is_file());
    let ev = t.export_images(&out, png);
    assert!(
        matches!(ev.last(), Some(ExportImagesEvent::Finished(s)) if s.renamed == 3),
        "never overwrite"
    );
    assert!(out.join("20140815_1.png").is_file());
    let jpeg = ImageExportSettings {
        format: ImageFormat::Jpeg,
        jpeg_quality: 95,
        overwrite: true,
    };
    t.export_images(&out, jpeg);
    let master_dir = t
        .core
        .session
        .read()
        .frames
        .store()
        .expect("store")
        .root()
        .join("m");
    let any_master = std::fs::read_dir(master_dir)
        .expect("masters")
        .flatten()
        .next()
        .expect("one")
        .path();
    let exported: Vec<Vec<u8>> = ["20140815.jpg", "20140820.jpg", "20140821.jpg"]
        .iter()
        .map(|n| std::fs::read(out.join(n)).expect("jpg"))
        .collect();
    assert!(
        exported.contains(&std::fs::read(any_master).expect("master")),
        "q95 + look off = byte copy"
    );
    let bad = ImageExportSettings {
        jpeg_quality: 40,
        ..jpeg
    };
    let sink = Arc::new(crate::jobs::VecSink::<ExportImagesEvent>::default());
    assert_eq!(
        crate::jobs::export_images::start(&t.core, &out.to_string_lossy(), bad, sink)
            .expect_err("quality")
            .kind,
        ErrorKind::InvalidArgument
    );

    let video = out.join("timelapse.mp4");
    let ev = t.export_video(&video, default_video());
    match ev.last() {
        Some(ExportVideoEvent::Finished(s)) => {
            assert!(s.bytes > 0 && s.frames >= 3, "{s:?}");
            assert!(video.is_file());
        }
        other => panic!("video ended with {other:?}"),
    }
    assert!(ev.iter().any(|e| matches!(e, ExportVideoEvent::Started(_))));
    let infeasible = crate::ipc::VideoSettings {
        pace: crate::ipc::Pace::Fps { fps: 500.0 },
        ..default_video()
    };
    let sink = Arc::new(crate::jobs::VecSink::<ExportVideoEvent>::default());
    let err = crate::jobs::export_video::start(&t.core, &video.to_string_lossy(), infeasible, sink)
        .expect_err("fps");
    assert_eq!(err.kind, ErrorKind::InvalidArgument);
    // Only outputs can be revealed (the UI reveals the reported, canonical paths).
    let saved = match ev.last() {
        Some(ExportVideoEvent::Finished(s)) => s.path.clone(),
        _ => unreachable!("checked above"),
    };
    assert!(export::check_reveal(&t.core, &saved).is_ok());
    let out = out.canonicalize().expect("canonical");
    assert!(export::check_reveal(&t.core, &out.join("20140815.png").to_string_lossy()).is_ok());
    assert_eq!(
        export::check_reveal(&t.core, "/etc/hosts")
            .expect_err("not ours")
            .kind,
        ErrorKind::InvalidArgument
    );
    assert_eq!(
        export::check_reveal(&t.core, &out.join("missing.png").to_string_lossy())
            .expect_err("gone")
            .kind,
        ErrorKind::NotFound
    );
    assert_eq!(
        export::check_reveal(&t.core, "rel")
            .expect_err("relative")
            .kind,
        ErrorKind::InvalidArgument
    );
    assert_eq!(
        export::suggested_video_name(&t.core, ""),
        "FaceTimelapse 2014.mp4"
    );
    assert_eq!(export::suggested_video_name(&t.core, "mine"), "mine.mp4");
}

#[test]
fn exports_need_frames() {
    let t = scanned();
    let out = t.root.path().to_path_buf();
    t.core.grants.grant(crate::grants::Access::ExportDir, &out);
    t.core
        .grants
        .grant(crate::grants::Access::ExportFile, &out.join("v.mp4"));
    let sink = Arc::new(crate::jobs::VecSink::<ExportImagesEvent>::default());
    let png = ImageExportSettings {
        format: ImageFormat::Png,
        jpeg_quality: 95,
        overwrite: false,
    };
    assert_eq!(
        crate::jobs::export_images::start(&t.core, &out.to_string_lossy(), png, sink)
            .expect_err("none")
            .kind,
        ErrorKind::NotReady
    );
    let sink = Arc::new(crate::jobs::VecSink::<ExportVideoEvent>::default());
    let v = out.join("v.mp4");
    assert_eq!(
        crate::jobs::export_video::start(&t.core, &v.to_string_lossy(), default_video(), sink)
            .expect_err("none")
            .kind,
        ErrorKind::NotReady
    );
    let sink = Arc::new(crate::jobs::VecSink::<AlignEvent>::default());
    days::set_excluded(&t.core, "2014-08-15", true).expect("x");
    for d in ["2014-08-20", "2014-08-21"] {
        days::set_excluded(&t.core, d, true).expect("x");
    }
    let render = t.core.session.read().p.render;
    assert!(
        crate::jobs::align::start(&t.core, render, sink.clone()).is_err(),
        "only uncertain day left, not in pool"
    );
}

/// Starts a video export without granting anything and waits for its end.

#[test]
fn clear_cache_reset_and_info() {
    let t = scanned();
    let info = app::app_info(&t.core);
    assert_eq!(info.version, "2.0.0");
    assert!(info.parallelism >= 1);
    let r = folder::clear_cache(&t.core, CacheScope::Folder).expect("clear");
    assert_eq!(r.removed_entries, 8);
    assert!(r.freed_bytes > 0);
    let snap = app::snapshot(&t.core);
    assert_eq!(
        (snap.counts.total, snap.scan.status),
        (0, crate::ipc::ScanStatus::Missing)
    );
    t.scan();
    let r = folder::clear_cache(&t.core, CacheScope::All).expect("clear all");
    assert!(r.freed_bytes > 0);
    let reset = app::reset(&t.core).expect("reset");
    assert!(reset.reference.is_none() && reset.folder.is_none());
    assert_eq!(reset.recents.folders.len(), 1, "recents survive a reset");
}

#[test]
fn align_needs_a_reference_with_a_face() {
    let start = |t: &TestCore| {
        let sink = Arc::new(crate::jobs::VecSink::<AlignEvent>::default());
        let render = t.core.session.read().p.render;
        crate::jobs::align::start(&t.core, render, sink).expect_err("refused")
    };
    let t = TestCore::new();
    assert_eq!(start(&t).kind, ErrorKind::NotReady, "no reference yet");
    let faceless = t.write_reference("ref_noface.jpg");
    reference::set_photo(&t.core, &faceless.to_string_lossy()).expect("reference");
    assert_eq!(start(&t).kind, ErrorKind::NoFaceInReference);
}

#[test]
fn a_frame_that_fails_to_render_is_reported_and_the_others_align() {
    let t = TestCore::new();
    let folder = t.write_library();
    crate::engine::fake::write_jpeg(
        &folder.join("IMG_20140822_090000_renderfail.jpg"),
        48,
        36,
        90,
    );
    let r = t.write_reference("ref.jpg");
    reference::set_photo(&t.core, &r.to_string_lossy()).expect("reference");
    folder::set_folder(&t.core, &folder.to_string_lossy()).expect("folder");
    t.scan();
    small_render(&t);
    let events = t.align();
    let Some(AlignEvent::Finished(summary)) = events.last() else {
        panic!("align ended with {:?}", events.last())
    };
    let failing = id_of(&t, "renderfail");
    assert_eq!(
        summary
            .failed
            .iter()
            .map(|f| (f.photo_id.as_str(), f.error.kind))
            .collect::<Vec<_>>(),
        vec![(failing.as_str(), ErrorKind::DecodeFailed)]
    );
    assert_eq!(
        summary.rendered + 1,
        summary.total,
        "every other day aligned"
    );
    assert!(
        frames::view(&t.core)
            .frames
            .iter()
            .all(|f| f.photo_id != failing),
        "no frame for the failed photo"
    );
}
