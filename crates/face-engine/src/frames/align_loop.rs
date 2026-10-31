//! The one align loop ([`align_frames`]): reuse a master whose key is
//! current, else render it with a [`FrameRenderer`] on the current rayon
//! pool, report every finished item, honour cancellation between items.

#[allow(clippy::wildcard_imports)]
use super::*;

/// Renders one aligned frame: [`Detector`] in production (landmark
/// refinement needs the detector), a deterministic double in callers' tests.
pub trait FrameRenderer: Sync {
    /// Renders `request` (see [`align::render_frame`]).
    ///
    /// # Errors
    /// I/O, decode and inference errors for that photo.
    fn render(&self, request: &FrameRequest<'_>) -> Result<RenderedFrame>;
}

impl FrameRenderer for Detector {
    fn render(&self, request: &FrameRequest<'_>) -> Result<RenderedFrame> {
        align::render_frame(self, request)
    }
}

/// One frame to align.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignItem {
    /// Photo id.
    pub photo_id: String,
    /// Photo version (size + mtime).
    pub photo_version: String,
    /// Source photo.
    pub source: PathBuf,
    /// Matched face from the analysis.
    pub face: FaceRecord,
    /// Day of the frame.
    pub day: NaiveDate,
    /// User correction.
    pub adjust: FrameAdjust,
}

/// What every frame of a run shares.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignSpec {
    /// Target anchors + output size.
    pub target: RenderTarget,
    /// Render settings.
    pub settings: RenderSettings,
    /// Render fingerprint (see [`render_fingerprint`]).
    pub fingerprint: String,
}

impl AlignSpec {
    /// Frame key of `item` under this spec.
    #[must_use]
    pub fn frame_key(&self, item: &AlignItem) -> String {
        frame_key(&self.fingerprint, &item.photo_version, &item.adjust)
    }
}

/// A batch of frames sharing reference, output size and settings.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignJob {
    /// Shared parameters.
    pub spec: AlignSpec,
    /// Frames in timeline order.
    pub items: Vec<AlignItem>,
}

/// A frame available on disk.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignedFrame {
    /// Photo id.
    pub photo_id: String,
    /// Day.
    pub day: NaiveDate,
    /// Frame key.
    pub frame_key: String,
    /// Master JPEG.
    pub master: PathBuf,
    /// RMS anchor residual (output px).
    pub residual_px: f64,
    /// Face statistics for the look.
    pub face_stats: Option<FaceStats>,
    /// True when an existing master was reused.
    pub reused: bool,
}

impl AlignedFrame {
    /// The manifest entry describing this frame.
    #[must_use]
    pub fn manifest_entry(&self) -> ManifestEntry {
        ManifestEntry {
            photo_id: self.photo_id.clone(),
            frame_key: self.frame_key.clone(),
            residual_px: self.residual_px,
            face_stats: self.face_stats.map(|s| s.to_array()),
        }
    }
}

/// A frame that could not be rendered.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignFailure {
    /// Photo id.
    pub photo_id: String,
    /// Error class.
    pub kind: ErrorKind,
    /// Message.
    pub message: String,
}

/// Progress of [`align_frames`]: one event per finished item.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignProgress {
    /// Items finished (rendered, reused or failed).
    pub done: usize,
    /// Items in the run.
    pub total: usize,
    /// Reused masters so far.
    pub reused: usize,
    /// Failures so far.
    pub failed: usize,
    /// The item that just finished.
    pub outcome: std::result::Result<AlignedFrame, AlignFailure>,
    /// Render throughput (rendered frames / s).
    pub frames_per_second: f64,
    /// Estimated time left (ms).
    pub eta_ms: Option<u64>,
}

/// Result of [`align_frames`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignReport {
    /// Frames in item order (only finished ones when cancelled).
    pub frames: Vec<AlignedFrame>,
    /// Failures.
    pub failures: Vec<AlignFailure>,
    /// False when cancelled.
    pub complete: bool,
    /// Wall time.
    pub duration_ms: u64,
}

fn ms(d: std::time::Duration) -> u64 {
    u64::try_from(d.as_millis()).unwrap_or(u64::MAX)
}

/// Renders one item and writes its master + previews; panics become
/// [`EngineError::Internal`].
///
/// # Errors
/// Render, encode or I/O errors for that photo.
pub fn render_item(
    renderer: &dyn FrameRenderer,
    store: &FrameStore,
    spec: &AlignSpec,
    item: &AlignItem,
) -> Result<ManifestEntry> {
    let req = FrameRequest {
        source: &item.source,
        face: &item.face,
        target: &spec.target,
        backdrop: spec.settings.backdrop,
        adjust: item.adjust,
        refine_landmarks: spec.settings.refine_landmarks,
    };
    let frame = catch_unwind(AssertUnwindSafe(|| renderer.render(&req)))
        .map_err(|_| EngineError::Internal("panic while rendering a frame".into()))??;
    store.write(&item.photo_id, &spec.frame_key(item), &frame)
}

fn aligned(item: &AlignItem, store: &FrameStore, e: &ManifestEntry, reused: bool) -> AlignedFrame {
    AlignedFrame {
        photo_id: item.photo_id.clone(),
        day: item.day,
        frame_key: e.frame_key.clone(),
        master: store.master_path(&item.photo_id, &e.frame_key),
        residual_px: e.residual_px,
        face_stats: e.stats(),
        reused,
    }
}

/// Renders (or reuses) every item in parallel on the current rayon pool.
///
/// A master is reused when `existing` records the item's current frame key
/// and the file is on disk. New masters and previews are written to `store`;
/// the caller records them (e.g. [`AlignedFrame::manifest_entry`] into its
/// [`Manifest`]) — from the progress events as they arrive or from the report.
/// Per-item failures are reported, never fatal; cancellation stops before the
/// next item.
#[must_use]
pub fn align_frames(
    renderer: &dyn FrameRenderer,
    store: &FrameStore,
    spec: &AlignSpec,
    items: &[AlignItem],
    existing: &Manifest,
    sink: &dyn ProgressSink<AlignProgress>,
    cancel: &CancelToken,
) -> AlignReport {
    let clock = Throughput::start();
    let total = items.len();
    let (done, reused, failed, rendered) = (
        AtomicUsize::new(0),
        AtomicUsize::new(0),
        AtomicUsize::new(0),
        AtomicUsize::new(0),
    );
    crate::decode::assert_no_share_held("align loop");
    let results: Vec<Option<std::result::Result<AlignedFrame, AlignFailure>>> = items
        .par_iter()
        .map(|item| {
            if cancel.is_cancelled() {
                return None;
            }
            let key = spec.frame_key(item);
            let current = existing
                .current(&item.photo_id, &key)
                .filter(|_| store.has_master(&item.photo_id, &key));
            let outcome = if let Some(e) = current {
                reused.fetch_add(1, Ordering::Relaxed);
                Ok(aligned(item, store, e, true))
            } else {
                match render_item(renderer, store, spec, item) {
                    Ok(entry) => {
                        rendered.fetch_add(1, Ordering::Relaxed);
                        Ok(aligned(item, store, &entry, false))
                    }
                    Err(e) => {
                        failed.fetch_add(1, Ordering::Relaxed);
                        Err(AlignFailure {
                            photo_id: item.photo_id.clone(),
                            kind: e.kind(),
                            message: e.to_string(),
                        })
                    }
                }
            };
            let d = done.fetch_add(1, Ordering::Relaxed) + 1;
            sink.report(AlignProgress {
                done: d,
                total,
                reused: reused.load(Ordering::Relaxed),
                failed: failed.load(Ordering::Relaxed),
                outcome: outcome.clone(),
                frames_per_second: clock.rate(rendered.load(Ordering::Relaxed)),
                eta_ms: eta(clock.rate(d), total - d).map(ms),
            });
            Some(outcome)
        })
        .collect();
    let mut frames = Vec::new();
    let mut failures = Vec::new();
    for r in results.into_iter().flatten() {
        match r {
            Ok(f) => frames.push(f),
            Err(f) => failures.push(f),
        }
    }
    AlignReport {
        frames,
        failures,
        complete: !cancel.is_cancelled(),
        duration_ms: ms(clock.elapsed()),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::super::tests::*;
    use super::*;
    use crate::recognize::Embedding;

    /// Renders a flat frame; fails for sources named `fail*`, panics for `panic*`.
    struct FlatRenderer;

    impl FrameRenderer for FlatRenderer {
        fn render(&self, req: &FrameRequest<'_>) -> Result<RenderedFrame> {
            let name = req.source.to_string_lossy();
            assert!(!name.contains("panic"), "renderer panicked");
            if name.contains("fail") {
                return Err(EngineError::decode(req.source, "broken"));
            }
            Ok(RenderedFrame {
                image: RgbImage::filled(req.target.size.width, req.target.size.height, [90; 3]),
                ..rendered()
            })
        }
    }

    fn item(id: &str, source: &str) -> AlignItem {
        AlignItem {
            photo_id: id.into(),
            photo_version: "v1".into(),
            source: source.into(),
            face: FaceRecord {
                bounds: Rect::new(0.3, 0.3, 0.4, 0.4),
                landmarks: [Point::new(0.5, 0.5); 5],
                score: 0.9,
                embedding: Embedding(vec![1.0]),
            },
            day: NaiveDate::from_ymd_opt(2014, 8, 15).expect("date"),
            adjust: FrameAdjust::default(),
        }
    }

    #[test]
    fn align_loop_renders_reuses_fails_and_cancels() {
        let dir = tempfile::tempdir().expect("tmp");
        let store = FrameStore::new(dir.path(), "fp");
        let spec = AlignSpec {
            target: RenderTarget::from_crop_anchors(&[Point::new(0.5, 0.5); 5], Size::new(40, 30)),
            settings: RenderSettings::default(),
            fingerprint: "fp".into(),
        };
        let items = vec![
            item("a", "/x/a.jpg"),
            item("b", "/x/fail.jpg"),
            item("c", "/x/panic.jpg"),
        ];
        let events = Mutex::new(Vec::new());
        let sink = |p: AlignProgress| events.lock().expect("lock").push(p);
        let report = align_frames(
            &FlatRenderer,
            &store,
            &spec,
            &items,
            &Manifest::default(),
            &sink,
            &CancelToken::new(),
        );
        assert!(report.complete);
        assert_eq!(report.frames.len(), 1);
        assert!(!report.frames[0].reused);
        assert_eq!(report.failures.len(), 2);
        assert!(
            report
                .failures
                .iter()
                .any(|f| f.photo_id == "c" && f.kind == ErrorKind::Internal)
        );
        assert!(store.has_master("a", &spec.frame_key(&items[0])));
        let events = events.into_inner().expect("events");
        assert_eq!(events.len(), 3);
        assert!(events.iter().all(|e| e.total == 3));
        assert_eq!(events.iter().map(|e| e.done).max(), Some(3));

        // Reuse: the manifest names the current key and the master exists.
        let mut m = Manifest::default();
        m.insert(report.frames[0].manifest_entry());
        let again = align_frames(
            &FlatRenderer,
            &store,
            &spec,
            &items[..1],
            &m,
            &crate::NoProgress,
            &CancelToken::new(),
        );
        assert!(again.frames[0].reused);
        assert_eq!(again.frames[0].face_stats, rendered().face_stats);
        // A changed adjustment is a new key ⇒ rendered again.
        let mut moved = items[0].clone();
        moved.adjust.dx = 0.1;
        let third = align_frames(
            &FlatRenderer,
            &store,
            &spec,
            &[moved],
            &m,
            &crate::NoProgress,
            &CancelToken::new(),
        );
        assert!(!third.frames[0].reused);

        let cancel = CancelToken::new();
        cancel.cancel();
        let none = align_frames(
            &FlatRenderer,
            &store,
            &spec,
            &items,
            &m,
            &crate::NoProgress,
            &cancel,
        );
        assert!(!none.complete && none.frames.is_empty() && none.failures.is_empty());
        let single = render_item(&FlatRenderer, &store, &spec, &items[0]).expect("one");
        assert_eq!(single.frame_key, spec.frame_key(&items[0]));
    }
}
