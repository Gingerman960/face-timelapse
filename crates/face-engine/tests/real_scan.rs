//! End-to-end on real photos: scan (cold + cached) → days → align → export
//! → video frames. The full-library throughput checks are `#[ignore]`d:
//!
//! ```text
//! cargo test -p face-engine --release --test real_scan -- --ignored --nocapture
//! ```

mod common;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

use face_engine::align::{RenderSettings, RenderTarget, Resolution};
use face_engine::days::{DayCandidate, DayDecisions, group_days, timeline};
use face_engine::export::{ImageExportSettings, ImageFormat};
use face_engine::frames::{FrameSequence, FrameSpec};
use face_engine::matching::MatchStatus;
use face_engine::reference::{AspectPreset, default_crop};
use face_engine::scan::{ScanEvent, ScanOptions, ScanReport};
use face_engine::{AlignItem, AlignJob, AlignSpec, CancelToken, Engine, ExportItem, NoProgress};

fn reference_embedding(
    engine: &Engine,
    reference: &std::path::Path,
) -> (
    face_engine::reference::ReferenceDetection,
    face_engine::geometry::Rect,
) {
    let img = engine.load_reference(reference, 0.0).expect("reference");
    let crop = default_crop(img.size(), AspectPreset::Free);
    (
        engine
            .detect_reference(&img, crop)
            .expect("detect")
            .expect("face"),
        crop,
    )
}

fn align_job(
    engine: &Engine,
    report: &ScanReport,
    det: &face_engine::reference::ReferenceDetection,
    crop: face_engine::geometry::Rect,
    max: usize,
) -> AlignJob {
    let photos: Vec<_> = report
        .photos
        .iter()
        .filter(|p| p.status == MatchStatus::Confirmed)
        .collect();
    let candidates: Vec<DayCandidate> = photos
        .iter()
        .map(|p| DayCandidate {
            id: p.id.clone(),
            rel_path: p.entry.rel_path.clone(),
            taken_at: p.analysis.taken_at,
            score: p.matched.map_or(0.0, |m| m.score),
        })
        .collect();
    let groups = group_days(&candidates, &DayDecisions::default());
    let line = timeline(&groups);
    let out = Resolution::P720
        .output_size(crop.width as u32, crop.height as u32)
        .expect("size");
    let items = line
        .iter()
        .take(max)
        .filter_map(|(day, id)| {
            let p = photos.iter().find(|p| &p.id == id)?;
            Some(AlignItem {
                photo_id: id.clone(),
                photo_version: p.version.clone(),
                source: p.entry.path.clone(),
                face: p.analysis.faces()[p.matched?.face_index].clone(),
                day: *day,
                adjust: Default::default(),
            })
        })
        .collect();
    AlignJob {
        items,
        spec: AlignSpec {
            target: RenderTarget::from_crop_anchors(&det.anchors, out),
            settings: RenderSettings {
                resolution: Resolution::P720,
                ..RenderSettings::default()
            },
            fingerprint: format!("test-{}", engine.fingerprint()),
        },
    }
}

#[test]
fn end_to_end_on_a_300_photo_subset() {
    let Some((_, photos, reference)) = common::real() else {
        return;
    };
    let cache = tempfile::tempdir().expect("cache");
    let engine = common::fresh_engine(cache.path()).expect("engine");
    let subset = common::sample(&engine, &photos, 300);
    let folder = common::symlink_folder(&subset);
    let (det, crop) = reference_embedding(&engine, &reference);

    let events = AtomicUsize::new(0);
    let sink = |e: ScanEvent| {
        events.fetch_add(1, Ordering::Relaxed);
        if let ScanEvent::Started { counts, .. } = e {
            assert_eq!(counts.total, subset.len());
        }
    };
    let t = Instant::now();
    let report = engine
        .scan(
            folder.path(),
            &det.embedding,
            ScanOptions::default(),
            &sink,
            &CancelToken::new(),
        )
        .expect("scan");
    let cold = t.elapsed();
    assert!(report.complete);
    assert_eq!(report.photos.len(), subset.len());
    assert!(events.load(Ordering::Relaxed) > subset.len());
    let c = report.counts;
    println!("300-photo scan {cold:?}: {c:?}");
    assert!(c.confirmed as f64 >= 0.95 * subset.len() as f64, "{c:?}");
    for p in report.photos.iter().take(20) {
        let thumb = face_engine::thumbs::path(cache.path(), &p.id, &p.version, 320);
        assert!(thumb.is_file(), "missing thumbnail {}", thumb.display());
    }

    // Cached rescan: everything from the cache, same statuses.
    let t = Instant::now();
    let again = engine
        .scan(
            folder.path(),
            &det.embedding,
            ScanOptions::default(),
            &NoProgress,
            &CancelToken::new(),
        )
        .expect("rescan");
    println!("cached rescan {:?}", t.elapsed());
    assert_eq!(again.counts.from_cache, subset.len());
    assert_eq!(again.counts.confirmed, c.confirmed);

    // Align 24 days at 720p, then again (all reused).
    let job = align_job(&engine, &report, &det, crop, 24);
    let aligned = engine
        .align(&job, &NoProgress, &CancelToken::new())
        .expect("align");
    assert_eq!(aligned.frames.len(), job.items.len());
    assert!(aligned.failures.is_empty(), "{:?}", aligned.failures);
    assert!(
        aligned
            .frames
            .iter()
            .all(|f| f.master.is_file() && f.face_stats.is_some())
    );
    let reused = engine
        .align(&job, &NoProgress, &CancelToken::new())
        .expect("align again");
    assert!(reused.frames.iter().all(|f| f.reused));

    // Export twice: names are YYYYMMDD, the second batch gets _1 suffixes.
    let out = tempfile::tempdir().expect("out");
    let items: Vec<ExportItem> = aligned
        .frames
        .iter()
        .map(|f| ExportItem {
            master: f.master.clone(),
            day: f.day,
            look: None,
        })
        .collect();
    let settings = ImageExportSettings {
        format: ImageFormat::Jpeg,
        jpeg_quality: 95,
        overwrite: false,
    };
    let first = engine
        .export_images(
            &items,
            out.path(),
            &settings,
            &NoProgress,
            &CancelToken::new(),
        )
        .expect("export");
    assert_eq!(first.files.len(), items.len());
    let name = first.files[0]
        .file_name()
        .and_then(|n| n.to_str())
        .expect("name")
        .to_owned();
    assert_eq!(name, format!("{}.jpg", items[0].day.format("%Y%m%d")));
    let second = engine
        .export_images(
            &items,
            out.path(),
            &settings,
            &NoProgress,
            &CancelToken::new(),
        )
        .expect("export 2");
    assert_eq!(second.renamed, items.len());

    // Video frames load in order with their dates.
    let seq = FrameSequence::new(
        aligned
            .frames
            .iter()
            .map(|f| FrameSpec {
                master: f.master.clone(),
                date: f.day,
                look: None,
            })
            .collect(),
        None,
    );
    let frames: Vec<_> = seq
        .into_loaders()
        .take(3)
        .map(|l| l().expect("frame"))
        .collect();
    assert_eq!(frames[0].date, items[0].day);
    assert_eq!(
        frames[0].rgb.len(),
        (frames[0].width * frames[0].height * 3) as usize
    );
}

#[test]
#[ignore = "full-library throughput; run with --release --ignored"]
fn full_library_scan_throughput() {
    let Some((_, photos, reference)) = common::real() else {
        return;
    };
    let cache = tempfile::tempdir().expect("cache");
    let engine = common::fresh_engine(cache.path()).expect("engine");
    let (det, _) = reference_embedding(&engine, &reference);
    let t = Instant::now();
    let r = engine
        .scan(
            &photos,
            &det.embedding,
            ScanOptions::default(),
            &NoProgress,
            &CancelToken::new(),
        )
        .expect("scan");
    let secs = t.elapsed().as_secs_f64();
    let rate = r.photos.len() as f64 / secs;
    println!(
        "full scan: {} photos in {secs:.2}s = {rate:.1} photos/s; {:?}",
        r.photos.len(),
        r.counts
    );
    let t = Instant::now();
    let again = engine
        .scan(
            &photos,
            &det.embedding,
            ScanOptions::default(),
            &NoProgress,
            &CancelToken::new(),
        )
        .expect("rescan");
    let cached_rate = again.photos.len() as f64 / t.elapsed().as_secs_f64();
    println!("cached rescan: {cached_rate:.0} photos/s");
    assert!(rate >= 100.0, "scan throughput {rate:.1} photos/s");
    assert!(
        cached_rate >= 5000.0,
        "cached rescan {cached_rate:.0} photos/s"
    );
}

#[test]
#[ignore = "align throughput; run with --release --ignored"]
fn align_throughput_1080p() {
    let Some((_, photos, reference)) = common::real() else {
        return;
    };
    let cache = tempfile::tempdir().expect("cache");
    let engine = common::fresh_engine(cache.path()).expect("engine");
    let subset = common::sample(&engine, &photos, 400);
    let folder = common::symlink_folder(&subset);
    let (det, crop) = reference_embedding(&engine, &reference);
    let report = engine
        .scan(
            folder.path(),
            &det.embedding,
            ScanOptions::default(),
            &NoProgress,
            &CancelToken::new(),
        )
        .expect("scan");
    let mut job = align_job(&engine, &report, &det, crop, 400);
    job.spec.settings.resolution = Resolution::P1080;
    job.spec.target = RenderTarget::from_crop_anchors(
        &det.anchors,
        Resolution::P1080
            .output_size(crop.width as u32, crop.height as u32)
            .expect("size"),
    );
    let t = Instant::now();
    let r = engine
        .align(&job, &NoProgress, &CancelToken::new())
        .expect("align");
    let rate = r.frames.len() as f64 / t.elapsed().as_secs_f64();
    println!("align 1080p: {} frames, {rate:.1} frames/s", r.frames.len());
    assert!(rate >= 60.0, "align throughput {rate:.1} frames/s");
}
