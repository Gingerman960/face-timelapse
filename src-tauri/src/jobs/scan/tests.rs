//! Scan job tests on the fake engine.

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use crate::ipc::{ErrorKind, JobKind, MatchStatus, PhotoQuery, ScanEvent, ScanStatus};
use crate::jobs::{EventSink, VecSink};
use crate::testutil::{PHOTOS, TestCore, is_scan_terminal};

fn finished(events: &[ScanEvent]) -> &crate::ipc::ScanSummary {
    match events.last() {
        Some(ScanEvent::Finished(s)) => s,
        other => panic!("expected finished, got {other:?}"),
    }
}

#[test]
fn full_scan_streams_events_and_categorizes() {
    let t = TestCore::new();
    t.setup();
    let events = t.scan();
    assert!(
        matches!(events.first(), Some(ScanEvent::Started(s)) if s.total == PHOTOS.len() as u32)
    );
    let s = finished(&events);
    assert_eq!((s.total, s.from_cache, s.analyzed), (8, 0, 8));
    assert_eq!(
        (s.confirmed, s.uncertain, s.rejected, s.no_face, s.failed),
        (4, 1, 1, 1, 1)
    );
    let terminal = events.iter().filter(|e| is_scan_terminal(e)).count();
    assert_eq!(terminal, 1, "exactly one terminal event");
    let progress: Vec<_> = events
        .iter()
        .filter_map(|e| {
            if let ScanEvent::Progress(p) = e {
                Some(p)
            } else {
                None
            }
        })
        .collect();
    assert!(!progress.is_empty());
    assert!(progress.iter().all(|p| p.recent.len() <= 64));
    let recents: Vec<_> = progress.iter().flat_map(|p| p.recent.iter()).collect();
    assert_eq!(
        recents.len(),
        5,
        "confirmed + uncertain photos become mosaic tiles"
    );
    assert!(
        recents
            .iter()
            .all(|r| r.version.len() == 8 && r.day_key.starts_with("2014-08-"))
    );
    assert!(
        recents
            .iter()
            .any(|r| r.status == crate::ipc::ScanRecentStatus::Uncertain)
    );
    let snap = crate::commands::app::snapshot(&t.core);
    assert_eq!(snap.scan.status, ScanStatus::Complete);
    assert!(snap.active_job.is_none());
    assert_eq!(snap.counts.total, 8);
    assert_eq!(snap.counts.review_pending, 1);
    assert_eq!(
        snap.folder
            .as_ref()
            .map(|f| (f.image_count, f.analyzed_count, f.unsupported_count)),
        Some((8, 8, 1))
    );
    // Thumbnails were written during the scan.
    let photos =
        crate::commands::review::photos(&t.core, &PhotoQuery { statuses: None }).expect("photos");
    let ok = photos
        .iter()
        .find(|p| p.status == MatchStatus::Confirmed)
        .expect("confirmed");
    assert!(face_engine::thumbs::path(&t.core.paths.cache_dir, &ok.id, &ok.version, 320).is_file());
    assert!(ok.face_box.is_some());
    let noface = photos
        .iter()
        .find(|p| p.status == MatchStatus::NoFace)
        .expect("noface");
    assert!(noface.face_box.is_none());
    let two = photos
        .iter()
        .find(|p| p.file_name.contains("twofaces"))
        .expect("twofaces");
    assert_eq!(
        two.face_box.map(|b| b.x),
        Some(0.6),
        "matched (second) face, not the largest"
    );
    let detail = crate::commands::review::photo(&t.core, &two.id).expect("detail");
    assert_eq!((detail.matched_face, detail.faces.len()), (Some(1), 2));
}

#[test]
fn rescan_is_incremental_and_survives_restart() {
    let t = TestCore::new();
    let folder = t.setup();
    t.scan();
    assert_eq!(t.engine.analyze_calls.load(Ordering::Relaxed), 8);
    let s = t.scan();
    assert_eq!((finished(&s).from_cache, finished(&s).analyzed), (8, 0));
    assert_eq!(
        t.engine.analyze_calls.load(Ordering::Relaxed),
        8,
        "nothing re-analyzed"
    );
    // Touch one file and delete another: only the changed one is analyzed; the vanished one is dropped.
    crate::engine::fake::write_jpeg(&folder.join(PHOTOS[0]), 50, 30, 10);
    std::fs::remove_file(folder.join(PHOTOS[1])).expect("rm");
    let s = t.scan();
    assert_eq!(
        (
            finished(&s).total,
            finished(&s).from_cache,
            finished(&s).analyzed
        ),
        (7, 6, 1)
    );
    let t = t.restart();
    let snap = crate::commands::app::snapshot(&t.core);
    assert_eq!(snap.scan.status, ScanStatus::Complete);
    assert_eq!(
        snap.counts.total, 7,
        "library restored from the cache without rescanning"
    );
    assert_eq!(t.engine.analyze_calls.load(Ordering::Relaxed), 0);
}

#[test]
fn cancel_keeps_partial_results() {
    let t = TestCore::new();
    let folder = t.setup();
    // More photos than worker threads so a cancel lands mid-scan.
    let extra = crate::state::work_threads() * 3;
    for i in 0..extra {
        crate::engine::fake::write_jpeg(
            &folder.join(format!("more/IMG_2015{:04}.jpg", 101 + i)),
            16,
            16,
            9,
        );
    }
    let total = u32::try_from(PHOTOS.len() + extra).expect("small");
    t.engine.analyze_delay_ms.store(150, Ordering::Relaxed);
    let sink = Arc::new(VecSink::<ScanEvent>::default());
    let id = crate::jobs::scan::start(&t.core, sink.clone() as Arc<dyn EventSink<ScanEvent>>)
        .expect("start");
    assert_eq!(t.core.jobs.active().map(|j| j.kind), Some(JobKind::Scan));
    // Busy rule while scanning.
    let busy = crate::commands::folder::set_folder(&t.core, &t.photos().to_string_lossy())
        .expect_err("busy");
    assert_eq!(busy.kind, ErrorKind::Busy);
    assert!(
        crate::commands::review::photos(&t.core, &PhotoQuery { statuses: None }).is_ok(),
        "reads still work"
    );
    std::thread::sleep(Duration::from_millis(200));
    assert!(t.core.jobs.cancel(&id));
    let events = sink.wait_for(Duration::from_secs(10), |e| {
        e.last().is_some_and(is_scan_terminal)
    });
    t.wait_idle();
    let done = match events.last() {
        Some(ScanEvent::Cancelled(c)) => c.done,
        other => panic!("expected cancelled, got {other:?}"),
    };
    assert!(done < total, "{done} of {total}");
    assert_eq!(
        crate::commands::app::snapshot(&t.core).scan.status,
        ScanStatus::Partial
    );
    t.engine.analyze_delay_ms.store(0, Ordering::Relaxed);
    let s = t.scan();
    assert_eq!(
        finished(&s).from_cache,
        done,
        "resumes from the partial cache"
    );
}

#[test]
fn start_validates_inputs() {
    let t = TestCore::new();
    let sink = || Arc::new(VecSink::<ScanEvent>::default()) as Arc<dyn EventSink<ScanEvent>>;
    assert_eq!(
        crate::jobs::scan::start(&t.core, sink())
            .expect_err("no folder")
            .kind,
        ErrorKind::NotReady
    );
    let folder = t.write_library();
    crate::commands::folder::set_folder(&t.core, &folder.to_string_lossy()).expect("folder");
    assert_eq!(
        crate::jobs::scan::start(&t.core, sink())
            .expect_err("no reference")
            .kind,
        ErrorKind::NotReady
    );
    let r = t.write_reference("noface_ref.jpg");
    crate::commands::reference::set_photo(&t.core, &r.to_string_lossy()).expect("reference");
    assert_eq!(
        crate::jobs::scan::start(&t.core, sink())
            .expect_err("no face")
            .kind,
        ErrorKind::NoFaceInReference
    );
    let r = t.write_reference("ref.jpg");
    crate::commands::reference::set_photo(&t.core, &r.to_string_lossy()).expect("reference");
    t.engine.models_missing.store(true, Ordering::Relaxed);
    assert_eq!(
        crate::jobs::scan::start(&t.core, sink())
            .expect_err("models")
            .kind,
        ErrorKind::ModelUnavailable
    );
    assert!(
        t.core.jobs.active().is_none(),
        "failed starts leave no job behind"
    );
}

#[test]
fn a_folder_that_vanished_still_gets_started_before_failed() {
    let t = TestCore::new();
    let folder = t.setup();
    std::fs::remove_dir_all(&folder).expect("rm folder");
    let events = t.scan();
    assert!(
        matches!(events.as_slice(), [ScanEvent::Started(s), ScanEvent::Failed(_)] if s.total == 0),
        "{events:?}"
    );
}
