//! Where exports may write, and what survives a crash or a quit.

use super::*;

fn run_video(
    t: &TestCore,
    path: &std::path::Path,
) -> Result<Vec<ExportVideoEvent>, crate::ipc::IpcError> {
    let sink = Arc::new(crate::jobs::VecSink::<ExportVideoEvent>::default());
    crate::jobs::export_video::start(
        &t.core,
        &path.to_string_lossy(),
        default_video(),
        sink.clone(),
    )?;
    let events = sink.wait_for(std::time::Duration::from_secs(60), |e| {
        e.last().is_some_and(|l| {
            matches!(
                l,
                ExportVideoEvent::Finished(_)
                    | ExportVideoEvent::Failed(_)
                    | ExportVideoEvent::Cancelled(_)
            )
        })
    });
    t.wait_idle();
    Ok(events)
}

#[test]
fn a_file_that_appears_after_the_dialog_is_never_replaced() {
    let t = scanned();
    small_render(&t);
    t.align();
    // The dialog returned a free name: it never asked about replacing.
    let movie = t.root.path().join("movie.mp4");
    let path = export::grant_video_path(&t.core, &movie);
    assert_eq!(path, movie.to_string_lossy());
    assert!(!crate::jobs::export_video::replace_confirmed(
        &t.core, &path
    ));
    // Something else creates that exact name before the export starts.
    std::fs::write(&movie, b"someone else's file").expect("write");
    let err = run_video(&t, &movie).expect_err("not confirmed");
    assert_eq!(err.kind, ErrorKind::InvalidArgument, "{}", err.message);
    assert_eq!(std::fs::read(&movie).expect("kept"), b"someone else's file");
    // Picking it again now asks to replace it: allowed.
    export::grant_video_path(&t.core, &movie);
    assert!(crate::jobs::export_video::replace_confirmed(&t.core, &path));
}

#[test]
fn video_exports_only_replace_files_the_user_confirmed_or_we_wrote() {
    let t = scanned();
    small_render(&t);
    t.align();
    let out = t.root.path().join("videos");
    std::fs::create_dir_all(&out).expect("mkdir");
    // Never picked: refused, even though the folder is readable.
    assert_eq!(
        run_video(&t, &out.join("a.mp4"))
            .expect_err("not picked")
            .kind,
        ErrorKind::PermissionDenied
    );
    // Picked as "theirs" (the dialog showed no extension): "theirs.mp4"
    // already exists and nobody confirmed replacing it.
    let theirs = out.join("theirs.mp4");
    std::fs::write(&theirs, b"someone's video").expect("write");
    let path = export::grant_video_path(&t.core, &out.join("theirs"));
    assert_eq!(path, theirs.to_string_lossy());
    let err = run_video(&t, &theirs).expect_err("unconfirmed replace");
    assert_eq!(err.kind, ErrorKind::InvalidArgument, "{}", err.message);
    assert_eq!(std::fs::read(&theirs).expect("kept"), b"someone's video");
    // Picked with its name (the dialog asked before replacing): allowed, and
    // an unrelated `.partial` next to it is never touched.
    let keep = out.join("keep.mp4");
    std::fs::write(&keep, b"old").expect("write");
    let foreign_partial = out.join("keep.mp4.partial");
    std::fs::write(&foreign_partial, b"a download").expect("write");
    export::grant_video_path(&t.core, &keep);
    let ev = run_video(&t, &keep).expect("confirmed");
    assert!(
        matches!(ev.last(), Some(ExportVideoEvent::Finished(_))),
        "{ev:?}"
    );
    assert_ne!(std::fs::read(&keep).expect("video"), b"old");
    assert_eq!(
        std::fs::read(&foreign_partial).expect("kept"),
        b"a download"
    );
    // Our own output may be replaced again later, even after a restart.
    let t = t.restart_without_grants();
    let keep = keep.canonicalize().expect("canonical");
    let ev = run_video(&t, &keep).expect("ours");
    assert!(
        matches!(ev.last(), Some(ExportVideoEvent::Finished(_))),
        "{ev:?}"
    );
}

#[test]
fn a_missing_or_corrupt_master_fails_the_video_with_its_real_cause() {
    let t = scanned();
    small_render(&t);
    t.align();
    let masters = t
        .core
        .session
        .read()
        .frames
        .store()
        .expect("store")
        .root()
        .join("m");
    let mut files: Vec<_> = std::fs::read_dir(&masters)
        .expect("masters")
        .flatten()
        .map(|e| e.path())
        .collect();
    files.sort();
    let video = t.root.path().join("v.mp4");
    let failure = |t: &TestCore| match t.export_video(&video, default_video()).last() {
        Some(ExportVideoEvent::Failed(f)) => f.error.kind,
        other => panic!("expected a failure, got {other:?}"),
    };
    let whole = std::fs::read(&files[0]).expect("master");
    // Whole on disk but undecodable: the engine's own kind.
    let mut corrupt = vec![0xFF, 0xD8];
    corrupt.extend_from_slice(b"not a jpeg");
    corrupt.extend_from_slice(&[0xFF, 0xD9]);
    std::fs::write(&files[0], &corrupt).expect("corrupt");
    assert_eq!(
        failure(&t),
        ErrorKind::UnsupportedFormat,
        "the engine's own kind"
    );
    // Cut short by a power loss, emptied, or gone: not aligned (align again).
    for torn in [&whole[..whole.len() / 2], &[][..]] {
        std::fs::write(&files[0], torn).expect("tear");
        assert_eq!(failure(&t), ErrorKind::NotFound, "{} bytes", torn.len());
    }
    std::fs::remove_file(&files[0]).expect("rm");
    assert_eq!(failure(&t), ErrorKind::NotFound);
}

#[test]
fn video_settings_are_validated_saved_and_restored_without_an_export() {
    let t = TestCore::new();
    let mut settings = default_video();
    settings.pace = crate::ipc::Pace::Fps { fps: 24.0 };
    settings.crossfade.frames = 2;
    settings.caption = Some(crate::ipc::CaptionOptions {
        position: crate::ipc::CaptionPosition::BottomLeft,
        size: 0.04,
        format: "%b %d, %Y".into(),
    });
    assert_eq!(
        export::set_video(&t.core, settings.clone()).expect("saved"),
        settings
    );
    let t = t.restart();
    assert_eq!(t.core.session.read().p.video, settings, "restored");
    // Rejected, and nothing saved: a caption that cannot format a day, and
    // values out of range.
    for bad in [
        crate::ipc::VideoSettings {
            caption: Some(crate::ipc::CaptionOptions {
                format: "%H:%M".into(),
                ..settings.caption.clone().expect("caption")
            }),
            ..settings.clone()
        },
        crate::ipc::VideoSettings {
            pace: crate::ipc::Pace::Fps { fps: 0.0 },
            ..settings.clone()
        },
        crate::ipc::VideoSettings {
            hold_last_secs: f64::NAN,
            ..settings.clone()
        },
    ] {
        let err = export::set_video(&t.core, bad).expect_err("invalid");
        assert_eq!(err.kind, ErrorKind::InvalidArgument, "{}", err.message);
        assert!(!err.message.is_empty());
    }
    assert_eq!(t.core.session.read().p.video, settings, "unchanged");
}

#[test]
fn caption_formats_that_cannot_format_a_day_are_refused_up_front() {
    let t = scanned();
    small_render(&t);
    t.align();
    let video = t.root.path().join("v.mp4");
    export::grant_video_path(&t.core, &video);
    for format in ["%b %d, %Y %H:%M", "%s", "%z"] {
        let settings = crate::ipc::VideoSettings {
            caption: Some(crate::ipc::CaptionOptions {
                position: crate::ipc::CaptionPosition::BottomLeft,
                size: 0.04,
                format: format.into(),
            }),
            ..default_video()
        };
        let sink = Arc::new(crate::jobs::VecSink::<ExportVideoEvent>::default());
        let err =
            crate::jobs::export_video::start(&t.core, &video.to_string_lossy(), settings, sink)
                .expect_err(format);
        assert_eq!(
            err.kind,
            ErrorKind::InvalidArgument,
            "{format}: {}",
            err.message
        );
    }
    assert!(
        t.core.session.read().p.video.caption.is_none(),
        "not persisted"
    );
}

#[test]
fn image_exports_go_only_into_picked_or_previous_folders() {
    let t = scanned();
    small_render(&t);
    t.align();
    let png = ImageExportSettings {
        format: ImageFormat::Png,
        jpeg_quality: 95,
        overwrite: false,
    };
    let picked = t.root.path().join("picked");
    std::fs::create_dir_all(picked.join("sub")).expect("mkdir");
    let start = |t: &TestCore, dir: &std::path::Path| {
        let sink = Arc::new(crate::jobs::VecSink::<ExportImagesEvent>::default());
        crate::jobs::export_images::start(&t.core, &dir.to_string_lossy(), png, sink)
            .map(|_| t.wait_idle())
    };
    assert_eq!(
        start(&t, &picked).expect_err("not picked").kind,
        ErrorKind::PermissionDenied
    );
    t.core
        .grants
        .grant(crate::grants::Access::ExportDir, &picked);
    assert_eq!(
        start(&t, &picked.join("sub"))
            .expect_err("only the picked folder")
            .kind,
        ErrorKind::PermissionDenied
    );
    start(&t, &picked).expect("picked");
    let t = t.restart_without_grants();
    // After a restart only the session's (canonical) spelling is granted.
    let picked = picked.canonicalize().expect("canonical");
    start(&t, &picked).expect("a folder we exported to before");
}

#[test]
fn outputs_are_capped_most_recent_first() {
    let mut list = Vec::new();
    for i in 0..crate::session::model::MAX_OUTPUTS + 50 {
        crate::session::model::push_output(&mut list, &format!("/o{i}"));
    }
    crate::session::model::push_output(&mut list, "/o60");
    assert_eq!(list.len(), crate::session::model::MAX_OUTPUTS);
    assert_eq!(list[0], "/o60");
    assert_eq!(list.iter().filter(|o| *o == "/o60").count(), 1);
}

#[test]
fn exports_are_recorded_on_disk_until_they_end() {
    let t = scanned();
    small_render(&t);
    t.align();
    let out = t.root.path().join("o");
    std::fs::create_dir_all(&out).expect("mkdir");
    let video = out.join("v.mp4");
    export::grant_video_path(&t.core, &video);
    let sink = Arc::new(crate::testutil::BlockingSink::<ExportVideoEvent>::default());
    crate::jobs::export_video::start(
        &t.core,
        &video.to_string_lossy(),
        default_video(),
        sink.clone(),
    )
    .expect("start");
    sink.wait_blocked();
    let on_disk = crate::session::persist::load(&t.core.paths.session_file());
    let video = out.canonicalize().expect("canonical").join("v.mp4");
    assert_eq!(
        on_disk.pending_outputs,
        vec![crate::session::model::PendingOutput {
            path: video.to_string_lossy().into_owned(),
            video: true,
            pid: std::process::id(),
        }],
        "written before any temporary file exists"
    );
    sink.release();
    t.wait_idle();
    assert!(t.core.session.read().p.pending_outputs.is_empty());
}

#[test]
fn leftovers_of_a_crashed_export_are_removed_at_the_next_start() {
    let t = TestCore::new();
    let out = t.root.path().join("o");
    std::fs::create_dir_all(&out).expect("mkdir");
    let pid = 4_000_000;
    let ours = [
        out.join(format!("v.mp4.{pid}-3.partial")),
        out.join(format!(".20140815.png.{pid}-7.tmp")),
    ];
    let theirs = [
        out.join("v.mp4"),
        out.join("v.mp4.partial"),
        out.join(format!("w.mp4.{pid}-3.partial")),
        out.join(format!(".20140815.png.{}-7.tmp", pid + 1)),
    ];
    for f in ours.iter().chain(&theirs) {
        std::fs::write(f, b"x").expect("write");
    }
    t.core.session.write().p.pending_outputs = vec![
        crate::session::model::PendingOutput {
            path: out.join("v.mp4").to_string_lossy().into_owned(),
            video: true,
            pid,
        },
        crate::session::model::PendingOutput {
            path: out.to_string_lossy().into_owned(),
            video: false,
            pid,
        },
    ];
    let t = t.restart();
    assert!(
        ours.iter().all(|f| !f.exists()),
        "our temporary files are gone"
    );
    assert!(theirs.iter().all(|f| f.exists()), "nothing else is touched");
    assert!(t.core.session.read().p.pending_outputs.is_empty());
}

#[test]
fn quitting_cancels_the_running_job_and_waits_for_it() {
    let t = TestCore::new();
    t.setup();
    t.engine
        .analyze_delay_ms
        .store(30, std::sync::atomic::Ordering::Relaxed);
    let sink = Arc::new(crate::jobs::VecSink::<crate::ipc::ScanEvent>::default());
    crate::jobs::scan::start(&t.core, sink.clone()).expect("scan");
    sink.wait_for(std::time::Duration::from_secs(20), |e| !e.is_empty());
    assert!(
        t.core.shutdown(std::time::Duration::from_secs(20)),
        "stopped in time"
    );
    assert!(t.core.jobs.active().is_none());
    let events = sink.wait_for(std::time::Duration::from_secs(20), |e| {
        e.last().is_some_and(crate::testutil::is_scan_terminal)
    });
    assert!(
        matches!(events.last(), Some(crate::ipc::ScanEvent::Cancelled(_))),
        "{events:?}"
    );
}

#[test]
fn reveal_never_probes_paths_that_are_not_outputs() {
    let t = TestCore::new();
    let existing = t.root.path().join("exists.txt");
    std::fs::write(&existing, b"x").expect("write");
    let missing = t.root.path().join("missing.txt");
    let kind = |p: &std::path::Path| {
        export::check_reveal(&t.core, &p.to_string_lossy())
            .expect_err("not an output")
            .kind
    };
    // Existing or not, a non-output gets the same answer (no existence oracle).
    assert_eq!(kind(&existing), ErrorKind::InvalidArgument);
    assert_eq!(kind(&missing), ErrorKind::InvalidArgument);
    assert_eq!(
        kind(std::path::Path::new("/nonexistent/x/../y")),
        ErrorKind::InvalidArgument
    );
    // Inside an output folder: allowed, unless a symlink leads elsewhere.
    std::fs::create_dir_all(t.root.path().join("out")).expect("mkdir");
    let out = t.root.path().join("out").canonicalize().expect("canonical");
    std::fs::write(out.join("20140815.png"), b"x").expect("write");
    crate::session::model::push_output(
        &mut t.core.session.write().p.outputs,
        &out.to_string_lossy(),
    );
    assert!(export::check_reveal(&t.core, &out.join("20140815.png").to_string_lossy()).is_ok());
    assert_eq!(
        export::check_reveal(&t.core, &out.join("gone.png").to_string_lossy())
            .expect_err("our own output is gone")
            .kind,
        ErrorKind::NotFound
    );
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(t.root.path(), out.join("escape")).expect("symlink");
        assert_eq!(
            kind(&out.join("escape/exists.txt")),
            ErrorKind::InvalidArgument
        );
    }
}

#[test]
fn only_finished_videos_become_outputs() {
    let t = scanned();
    small_render(&t);
    t.align();
    let masters = t
        .core
        .session
        .read()
        .frames
        .store()
        .expect("store")
        .root()
        .join("m");
    let first = std::fs::read_dir(&masters)
        .expect("masters")
        .flatten()
        .map(|e| e.path())
        .min()
        .expect("a master");
    std::fs::remove_file(&first).expect("rm");
    let video = t.root.path().join("v.mp4");
    let ev = t.export_video(&video, default_video());
    assert!(
        matches!(ev.last(), Some(ExportVideoEvent::Failed(_))),
        "{ev:?}"
    );
    assert!(
        t.core.session.read().p.outputs.is_empty(),
        "a failed export grants nothing that outlives it"
    );
}

#[test]
fn the_encoder_may_replace_only_what_the_user_confirmed() {
    let t = scanned();
    small_render(&t);
    t.align();
    let path = t.root.path().join("v.mp4");
    let confirmed = |grant_replace: bool| {
        let t2 = &t;
        t2.core
            .grants
            .grant(crate::grants::Access::ExportFile, &path);
        if grant_replace {
            t2.core
                .grants
                .grant(crate::grants::Access::ReplaceFile, &path);
        }
        crate::jobs::export_video::replace_confirmed(&t2.core, &path.to_string_lossy())
    };
    assert!(
        !confirmed(false),
        "a new name: a file appearing meanwhile is kept"
    );
    assert!(confirmed(true), "the dialog asked about this exact name");
}

/// `open_path` with the opener stubbed: what it was asked to open.
fn open(
    t: &TestCore,
    path: &std::path::Path,
) -> Result<Vec<std::path::PathBuf>, crate::ipc::IpcError> {
    let opened = std::sync::Mutex::new(Vec::new());
    export::open_output(&t.core, &path.to_string_lossy(), |p| {
        opened.lock().expect("lock").push(p.to_path_buf());
        Ok(())
    })?;
    Ok(opened.into_inner().expect("lock"))
}

#[test]
fn open_path_opens_finished_videos_and_nothing_else() {
    let t = scanned();
    small_render(&t);
    t.align();
    let video = t.root.path().canonicalize().expect("root").join("v.mp4");
    let ev = t.export_video(&video, default_video());
    assert!(
        matches!(ev.last(), Some(ExportVideoEvent::Finished(_))),
        "{ev:?}"
    );
    assert_eq!(open(&t, &video).expect("opened"), vec![video.clone()]);

    let refused = |path: &std::path::Path| {
        let e = open(&t, path).expect_err("refused");
        (e.kind, e.message)
    };
    let answer = refused(std::path::Path::new("/nonexistent/v.mp4"));
    assert_eq!(answer.0, ErrorKind::NotFound);
    // Existing or not, a non-output gets the same answer (no existence oracle).
    let other = t.root.path().join("other.mp4");
    std::fs::write(&other, b"x").expect("write");
    assert_eq!(refused(&other), answer);
    assert_eq!(refused(std::path::Path::new("relative/v.mp4")), answer);
    assert_eq!(
        refused(&video.parent().expect("dir").join("x/../v.mp4")),
        answer
    );
    // Outputs that are not finished videos: an image export folder, files in
    // it, another extension, a remote spelling, a folder named like a video.
    let out = t.root.path().canonicalize().expect("root").join("out");
    std::fs::create_dir_all(out.join("dir.mp4")).expect("mkdir");
    std::fs::write(out.join("20140815.png"), b"x").expect("write");
    let mov = t.root.path().canonicalize().expect("root").join("clip.mov");
    std::fs::write(&mov, b"x").expect("write");
    {
        let mut s = t.core.session.write();
        for o in [&out, &out.join("dir.mp4"), &mov] {
            crate::session::model::push_output(&mut s.p.outputs, &o.to_string_lossy());
        }
        crate::session::model::push_output(&mut s.p.outputs, "//server/share/v.mp4");
    }
    for p in [
        out.clone(),
        out.join("20140815.png"),
        out.join("dir.mp4"),
        mov,
        std::path::PathBuf::from("//server/share/v.mp4"),
    ] {
        assert_eq!(refused(&p), answer, "{}", p.display());
    }
    // A video replaced by a link elsewhere, then gone altogether.
    #[cfg(unix)]
    {
        std::fs::remove_file(&video).expect("rm");
        std::os::unix::fs::symlink(&other, &video).expect("link");
        assert_eq!(refused(&video), answer, "a link is never followed");
    }
    std::fs::remove_file(&video).expect("rm");
    assert_eq!(refused(&video), answer, "a deleted video");
    // The opener's own failure is reported.
    std::fs::write(&video, b"x").expect("write");
    let failed = export::open_output(&t.core, &video.to_string_lossy(), |_| {
        Err(crate::ipc::IpcError::internal("no default app"))
    })
    .expect_err("opener failed");
    assert_eq!(failed.kind, ErrorKind::Internal);
}
