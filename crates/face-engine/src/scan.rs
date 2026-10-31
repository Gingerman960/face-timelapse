//! Incremental, parallel folder scan (ARCHITECTURE §4.1).
//!
//! walk → partition by (rel path, size, mtime) against the analysis cache →
//! analyze misses on the rayon pool (one decode per photo, thumbnails written
//! as a by-product) → flush the cache every 2 s / 500 entries and at the end →
//! match every photo against the reference in memory.
//!
//! Per-photo failures never abort the scan; panics inside a worker become a
//! `failed` photo. Transient failures (I/O, internal) are not cached, so the
//! next scan retries them. Cancellation is cooperative and keeps everything analyzed
//! so far (the cache is flushed).

use std::collections::HashSet;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use rayon::prelude::*;
use serde::{Deserialize, Serialize};

use crate::analysis::{FailureKind, Outcome, PhotoAnalysis, PhotoAnalyzer};
use crate::cache::{AnalysisCache, write_atomic_cache};
use crate::dates;
use crate::error::Result;
use crate::matching::{Calibration, FaceMatch, MatchStatus, match_faces};
use crate::progress::{CancelToken, ProgressSink, Throughput};
use crate::recognize::Embedding;
use crate::thumbs;
use crate::walk::{self, FileEntry};

/// Scan behaviour.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanOptions {
    /// Ignore cached results and analyze everything again ("rescan from scratch").
    pub rescan_all: bool,
    /// Write 320 px thumbnails while scanning.
    pub write_thumbnails: bool,
    /// Flush the cache at least this often (ms).
    pub flush_interval_ms: u64,
    /// …or after this many new entries.
    pub flush_every: usize,
}

impl Default for ScanOptions {
    fn default() -> Self {
        Self {
            rescan_all: false,
            write_thumbnails: true,
            flush_interval_ms: 2_000,
            flush_every: 500,
        }
    }
}

/// One photo after a scan.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedPhoto {
    /// File identity.
    pub entry: FileEntry,
    /// Stable photo id.
    pub id: String,
    /// Photo version (changes when the file changes).
    pub version: String,
    /// Reference-independent analysis.
    pub analysis: PhotoAnalysis,
    /// True when the analysis came from the cache.
    pub from_cache: bool,
    /// Best face vs the reference (when the photo has faces).
    pub matched: Option<FaceMatch>,
    /// Status vs the reference.
    pub status: MatchStatus,
}

impl ScannedPhoto {
    /// The face matched against the reference, if any.
    #[must_use]
    pub fn matched_face(&self) -> Option<&crate::analysis::FaceRecord> {
        self.analysis.faces().get(self.matched?.face_index)
    }

    /// `faceBox` of the IPC contract: the matched face's bounds normalized to
    /// the oriented photo (`None` for no-face / failed photos).
    #[must_use]
    pub fn face_box(&self) -> Option<crate::geometry::Rect> {
        self.matched_face().map(|f| f.bounds)
    }
}

/// Running totals.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanCounts {
    /// Photos processed so far (cache hits + analyzed).
    pub done: usize,
    /// Supported photos in the folder.
    pub total: usize,
    /// Served from the cache.
    pub from_cache: usize,
    /// Analyzed in this run.
    pub analyzed: usize,
    /// Status counts.
    pub confirmed: usize,
    /// Status counts.
    pub uncertain: usize,
    /// Status counts.
    pub rejected: usize,
    /// Status counts.
    pub no_face: usize,
    /// Status counts.
    pub failed: usize,
}

impl ScanCounts {
    fn add(&mut self, status: MatchStatus) {
        self.done += 1;
        match status {
            MatchStatus::Confirmed => self.confirmed += 1,
            MatchStatus::Uncertain => self.uncertain += 1,
            MatchStatus::Rejected => self.rejected += 1,
            MatchStatus::NoFace => self.no_face += 1,
            MatchStatus::Failed => self.failed += 1,
        }
    }
}

/// One photo that was just analyzed (enough for live UI tiles).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanItem {
    /// Stable photo id.
    pub id: String,
    /// Photo version.
    pub version: String,
    /// Path relative to the folder.
    pub rel_path: String,
    /// Capture time.
    pub taken_at: chrono::NaiveDateTime,
    /// Status vs the reference.
    pub status: MatchStatus,
}

/// Progress events, emitted from worker threads.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ScanEvent {
    /// Walk + cache partition done; `counts` already covers every cache hit
    /// (`from_cache`, statuses), so one event reports all hits at once.
    Started {
        /// Totals after the partition (`total` = supported photos).
        counts: ScanCounts,
        /// HEIC/HEIF files skipped.
        unsupported: usize,
    },
    /// One more photo analyzed.
    Progress {
        /// Totals so far.
        counts: ScanCounts,
        /// The photo just finished.
        photo: ScanItem,
        /// Analysis throughput of this run.
        photos_per_second: f64,
        /// Estimated time left (ms).
        eta_ms: Option<u64>,
    },
}

/// Result of a scan.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanReport {
    /// Canonical folder.
    pub root: std::path::PathBuf,
    /// Every supported file of the folder, natural `rel_path` order.
    pub files: Vec<FileEntry>,
    /// Photos in natural `rel_path` order (only those processed when cancelled).
    pub photos: Vec<ScannedPhoto>,
    /// HEIC/HEIF files.
    pub unsupported: Vec<FileEntry>,
    /// Final totals.
    pub counts: ScanCounts,
    /// False when the scan was cancelled.
    pub complete: bool,
    /// Wall time.
    pub duration_ms: u64,
}

/// Matches an analysis against the reference.
#[must_use]
pub fn match_photo(
    analysis: &PhotoAnalysis,
    reference: &Embedding,
    calibration: &Calibration,
) -> (Option<FaceMatch>, MatchStatus) {
    match &analysis.outcome {
        Outcome::Failed { .. } => (None, MatchStatus::Failed),
        Outcome::NoFace => (None, MatchStatus::NoFace),
        Outcome::Faces { faces } => {
            let m = match_faces(reference, faces.iter().map(|f| &f.embedding), calibration);
            let status = m.map_or(MatchStatus::NoFace, |m| m.status);
            (m, status)
        }
    }
}

/// Re-matches already scanned photos against a new reference (in memory).
pub fn rematch(photos: &mut [ScannedPhoto], reference: &Embedding, calibration: &Calibration) {
    photos.par_iter_mut().for_each(|p| {
        let (m, s) = match_photo(&p.analysis, reference, calibration);
        p.matched = m;
        p.status = s;
    });
}

/// Everything the scan needs besides the folder.
pub struct ScanContext<'a> {
    /// Per-photo analysis (the loaded models in production).
    pub analyzer: &'a dyn PhotoAnalyzer,
    /// Root of the app cache (`analysis/`, `thumbs/` live below it).
    pub cache_dir: &'a Path,
    /// Reference embedding.
    pub reference: &'a Embedding,
    /// Score calibration.
    pub calibration: Calibration,
    /// Options.
    pub options: ScanOptions,
}

struct Shared {
    cache: AnalysisCache,
    counts: ScanCounts,
    since_flush: usize,
    last_flush: Instant,
}

/// Scans `folder`. Misses are analyzed with `par_iter` on the current rayon
/// pool (the caller's `install`ed pool, else the global one — the app sizes
/// the global pool to cores − 1).
///
/// # Errors
/// Only folder-level failures (missing/unreadable folder). Cache write
/// failures are logged, not fatal.
pub fn scan_folder(
    ctx: &ScanContext<'_>,
    folder: &Path,
    sink: &dyn ProgressSink<ScanEvent>,
    cancel: &CancelToken,
) -> Result<ScanReport> {
    let clock = Throughput::start();
    let walked = walk::walk(folder)?;
    let fingerprint = ctx.analyzer.fingerprint();
    let cache = if ctx.options.rescan_all {
        AnalysisCache::empty(ctx.cache_dir, &walked.root, &fingerprint)
    } else {
        AnalysisCache::load(ctx.cache_dir, &walked.root, &fingerprint).0
    };

    let total = walked.files.len();
    let mut slots: Vec<Option<ScannedPhoto>> = vec![None; total];
    let mut misses = Vec::new();
    let mut counts = ScanCounts {
        total,
        ..ScanCounts::default()
    };
    for (i, entry) in walked.files.iter().enumerate() {
        if let Some(a) = cache.lookup(entry) {
            let photo = finish_photo(entry, a.clone(), true, ctx);
            counts.add(photo.status);
            counts.from_cache += 1;
            slots[i] = Some(photo);
        } else {
            misses.push(i);
        }
    }
    sink.report(ScanEvent::Started {
        counts,
        unsupported: walked.unsupported.len(),
    });

    let shared = Mutex::new(Shared {
        cache,
        counts,
        since_flush: 0,
        last_flush: Instant::now(),
    });
    crate::decode::assert_no_share_held("scan loop");
    let analyzed: Vec<(usize, ScannedPhoto)> = misses
        .par_iter()
        .filter_map(|&i| {
            if cancel.is_cancelled() {
                return None;
            }
            let entry = &walked.files[i];
            let photo = analyze_one(ctx, entry);
            record(ctx, &shared, entry, &photo, sink, &clock, misses.len());
            Some((i, photo))
        })
        .collect();
    for (i, photo) in analyzed {
        slots[i] = Some(photo);
    }

    let complete = !cancel.is_cancelled();
    let mut shared = shared
        .into_inner()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if complete {
        let keep: HashSet<&str> = walked.files.iter().map(|f| f.rel_path.as_str()).collect();
        shared.cache.retain_paths(&keep);
    }
    if let Err(e) = shared.cache.save() {
        log::warn!("could not save analysis cache: {e}");
    }
    let photos: Vec<ScannedPhoto> = slots.into_iter().flatten().collect();
    let mut final_counts = ScanCounts {
        total,
        ..ScanCounts::default()
    };
    for p in &photos {
        final_counts.add(p.status);
        if p.from_cache {
            final_counts.from_cache += 1;
        } else {
            final_counts.analyzed += 1;
        }
    }
    Ok(ScanReport {
        root: walked.root,
        files: walked.files,
        photos,
        unsupported: walked.unsupported,
        counts: final_counts,
        complete,
        duration_ms: u64::try_from(clock.elapsed().as_millis()).unwrap_or(u64::MAX),
    })
}

fn analyze_one(ctx: &ScanContext<'_>, entry: &FileEntry) -> ScannedPhoto {
    let thumb_w = ctx
        .options
        .write_thumbnails
        .then_some(thumbs::SCAN_THUMB_WIDTH);
    let out = catch_unwind(AssertUnwindSafe(|| {
        ctx.analyzer.analyze(&entry.path, entry.mtime_ns, thumb_w)
    }));
    let analysis = match out {
        Ok(out) => {
            if let Some(bytes) = out.thumbnail {
                let p = thumbs::path(
                    ctx.cache_dir,
                    &entry.id(),
                    &entry.version(),
                    thumbs::SCAN_THUMB_WIDTH,
                );
                if let Err(e) = write_atomic_cache(&p, &bytes) {
                    log::debug!("thumbnail write failed: {e}");
                }
            }
            out.analysis
        }
        Err(_) => {
            log::error!("analysis panicked on {}", entry.path.display());
            let when = dates::resolve(
                &dates::ExifDates::default(),
                entry.file_name(),
                dates::local_from_unix_ns(entry.mtime_ns),
            );
            PhotoAnalysis {
                oriented_size: crate::geometry::Size::default(),
                taken_at: when.taken_at,
                date_source: when.source,
                outcome: Outcome::Failed {
                    kind: FailureKind::Internal,
                    message: "internal error while analyzing this photo".into(),
                },
            }
        }
    };
    finish_photo(entry, analysis, false, ctx)
}

fn finish_photo(
    entry: &FileEntry,
    analysis: PhotoAnalysis,
    from_cache: bool,
    ctx: &ScanContext<'_>,
) -> ScannedPhoto {
    let (matched, status) = match_photo(&analysis, ctx.reference, &ctx.calibration);
    ScannedPhoto {
        entry: entry.clone(),
        id: entry.id(),
        version: entry.version(),
        analysis,
        from_cache,
        matched,
        status,
    }
}

fn record(
    ctx: &ScanContext<'_>,
    shared: &Mutex<Shared>,
    entry: &FileEntry,
    photo: &ScannedPhoto,
    sink: &dyn ProgressSink<ScanEvent>,
    clock: &Throughput,
    to_analyze: usize,
) {
    let counts = {
        let Ok(mut s) = shared.lock() else {
            return;
        };
        if photo.analysis.is_cacheable() {
            s.cache.insert(entry, photo.analysis.clone());
        }
        s.counts.add(photo.status);
        s.counts.analyzed += 1;
        s.since_flush += 1;
        let due = s.since_flush >= ctx.options.flush_every
            || s.last_flush.elapsed() >= Duration::from_millis(ctx.options.flush_interval_ms);
        if due {
            if let Err(e) = s.cache.save() {
                log::warn!("could not flush analysis cache: {e}");
            }
            s.since_flush = 0;
            s.last_flush = Instant::now();
        }
        s.counts
    };
    let rate = clock.rate(counts.analyzed);
    sink.report(ScanEvent::Progress {
        counts,
        photo: ScanItem {
            id: photo.id.clone(),
            version: photo.version.clone(),
            rel_path: entry.rel_path.clone(),
            taken_at: photo.analysis.taken_at,
            status: photo.status,
        },
        photos_per_second: rate,
        eta_ms: crate::progress::eta(rate, to_analyze.saturating_sub(counts.analyzed))
            .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX)),
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analysis::FaceRecord;
    use crate::dates::DateSource;
    use crate::geometry::{Point, Rect, Size};

    fn analysis(outcome: Outcome) -> PhotoAnalysis {
        PhotoAnalysis {
            oriented_size: Size::new(10, 10),
            taken_at: chrono::NaiveDateTime::default(),
            date_source: DateSource::FileTime,
            outcome,
        }
    }

    fn face(v: [f32; 2]) -> FaceRecord {
        FaceRecord {
            bounds: Rect::default(),
            landmarks: [Point::default(); 5],
            score: 0.9,
            embedding: Embedding::normalized(&v).expect("emb"),
        }
    }

    #[test]
    fn match_photo_maps_outcomes_to_statuses() {
        let r = Embedding::normalized(&[1.0, 0.0]).expect("r");
        let cal = Calibration::default();
        let failed = analysis(Outcome::Failed {
            kind: FailureKind::Io,
            message: "x".into(),
        });
        assert_eq!(match_photo(&failed, &r, &cal), (None, MatchStatus::Failed));
        assert_eq!(
            match_photo(&analysis(Outcome::NoFace), &r, &cal),
            (None, MatchStatus::NoFace)
        );
        let empty = analysis(Outcome::Faces { faces: vec![] });
        assert_eq!(match_photo(&empty, &r, &cal).1, MatchStatus::NoFace);
        let two = analysis(Outcome::Faces {
            faces: vec![face([0.0, 1.0]), face([1.0, 0.1])],
        });
        let (m, s) = match_photo(&two, &r, &cal);
        assert_eq!(s, MatchStatus::Confirmed);
        assert_eq!(m.map(|m| m.face_index), Some(1));
    }

    #[test]
    fn rematch_updates_statuses() {
        let entry = FileEntry {
            path: "/x/a.jpg".into(),
            rel_path: "a.jpg".into(),
            size: 1,
            mtime_ns: 1,
        };
        let mut photos = vec![ScannedPhoto {
            id: "id".into(),
            version: "v".into(),
            analysis: analysis(Outcome::Faces {
                faces: vec![face([1.0, 0.0])],
            }),
            entry,
            from_cache: true,
            matched: None,
            status: MatchStatus::Rejected,
        }];
        let r = Embedding::normalized(&[1.0, 0.0]).expect("r");
        assert!(photos[0].face_box().is_none());
        rematch(&mut photos, &r, &Calibration::default());
        assert_eq!(photos[0].status, MatchStatus::Confirmed);
        assert_eq!(photos[0].face_box(), Some(Rect::default()));
        assert!(photos[0].matched_face().is_some());
        let other = Embedding::normalized(&[0.0, 1.0]).expect("o");
        rematch(&mut photos, &other, &Calibration::default());
        assert_eq!(photos[0].status, MatchStatus::Rejected);
    }

    /// Analyzer double: `io*` files fail with an I/O error, `bad*` with a
    /// decode error, everything else has one face.
    struct Flaky(std::sync::atomic::AtomicUsize);

    impl PhotoAnalyzer for Flaky {
        fn fingerprint(&self) -> String {
            "flaky".into()
        }

        fn analyze(&self, path: &Path, _: i64, _: Option<u32>) -> crate::analysis::AnalysisOutput {
            self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            assert!(!name.starts_with("panic"), "analyzer blew up on {name}");
            let outcome = if name.starts_with("io") {
                Outcome::Failed {
                    kind: FailureKind::Io,
                    message: "offline".into(),
                }
            } else if name.starts_with("bad") {
                Outcome::Failed {
                    kind: FailureKind::DecodeFailed,
                    message: "corrupt".into(),
                }
            } else {
                Outcome::Faces {
                    faces: vec![face([1.0, 0.0])],
                }
            };
            crate::analysis::AnalysisOutput {
                analysis: analysis(outcome),
                thumbnail: None,
            }
        }
    }

    #[test]
    fn a_panicking_analysis_fails_only_that_photo_and_is_retried() {
        let photos = tempfile::tempdir().expect("photos");
        let cache = tempfile::tempdir().expect("cache");
        for name in ["a.jpg", "panic_20200101.jpg"] {
            std::fs::write(photos.path().join(name), b"x").expect("write");
        }
        let analyzer = Flaky(std::sync::atomic::AtomicUsize::new(0));
        let reference = Embedding::normalized(&[1.0, 0.0]).expect("r");
        let ctx = ScanContext {
            analyzer: &analyzer,
            cache_dir: cache.path(),
            reference: &reference,
            calibration: Calibration::default(),
            options: ScanOptions::default(),
        };
        let scan = || {
            scan_folder(&ctx, photos.path(), &crate::NoProgress, &CancelToken::new()).expect("scan")
        };
        let first = scan();
        assert_eq!((first.counts.analyzed, first.counts.failed), (2, 1));
        let failed = first
            .photos
            .iter()
            .find(|p| p.entry.rel_path.starts_with("panic"))
            .expect("reported");
        assert!(matches!(
            failed.analysis.outcome,
            Outcome::Failed {
                kind: FailureKind::Internal,
                ..
            }
        ));
        assert_eq!(
            failed.analysis.taken_at.date().to_string(),
            "2020-01-01",
            "dated from its name"
        );
        let second = scan();
        assert_eq!(
            (second.counts.from_cache, second.counts.analyzed),
            (1, 1),
            "retried"
        );
    }

    #[test]
    fn transient_failures_are_not_cached() {
        let photos = tempfile::tempdir().expect("photos");
        let cache = tempfile::tempdir().expect("cache");
        for name in ["a.jpg", "io.jpg", "bad.jpg"] {
            std::fs::write(photos.path().join(name), b"x").expect("write");
        }
        let analyzer = Flaky(std::sync::atomic::AtomicUsize::new(0));
        let reference = Embedding::normalized(&[1.0, 0.0]).expect("r");
        let ctx = ScanContext {
            analyzer: &analyzer,
            cache_dir: cache.path(),
            reference: &reference,
            calibration: Calibration::default(),
            options: ScanOptions::default(),
        };
        let scan = || {
            scan_folder(&ctx, photos.path(), &crate::NoProgress, &CancelToken::new()).expect("scan")
        };
        let first = scan();
        assert_eq!((first.counts.analyzed, first.counts.failed), (3, 2));
        let second = scan();
        // The decode failure is a property of the file: cached. The I/O
        // failure (offline volume, permissions) is retried next time.
        assert_eq!(
            (second.counts.from_cache, second.counts.analyzed),
            (2, 1),
            "{:?}",
            second.counts
        );
        assert_eq!(analyzer.0.load(std::sync::atomic::Ordering::SeqCst), 4);
    }

    #[test]
    fn counts_accumulate_by_status() {
        let mut c = ScanCounts::default();
        for s in [
            MatchStatus::Confirmed,
            MatchStatus::Uncertain,
            MatchStatus::Rejected,
            MatchStatus::NoFace,
            MatchStatus::Failed,
            MatchStatus::Confirmed,
        ] {
            c.add(s);
        }
        assert_eq!(
            (
                c.done,
                c.confirmed,
                c.uncertain,
                c.rejected,
                c.no_face,
                c.failed
            ),
            (6, 2, 1, 1, 1, 1)
        );
    }
}
