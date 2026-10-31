//! The [`Engine`] facade: loaded models + the cache directory (+ optionally a
//! dedicated thread pool), exposing every long job with progress and
//! cancellation. Every method delegates to the module function that owns the
//! work ([`scan_folder`], [`align_frames`], [`export::export_images`], …), so
//! an app that composes those functions itself (the Tauri shell does, for its
//! own job model) runs exactly the same loops.

use std::path::{Path, PathBuf};

use crate::align::{self, FrameRequest, RenderedFrame};
use crate::analysis::{AnalysisOutput, Analyzer};
use crate::cache::AnalysisCache;
use crate::detect::DetectorConfig;
use crate::error::{EngineError, Result};
use crate::export::{self, ExportItem, ExportProgress, ExportReport, ImageExportSettings};
use crate::frames::{AlignJob, AlignProgress, AlignReport, FrameStore, align_frames};
use crate::geometry::Rect;
use crate::matching::Calibration;
use crate::progress::{CancelToken, ProgressSink};
use crate::recognize::Embedding;
use crate::reference::{ReferenceDetection, ReferenceImage};
use crate::scan::{ScanContext, ScanEvent, ScanOptions, ScanReport, scan_folder};
use crate::thumbs;
use crate::walk::{self, WalkResult};

/// Engine construction parameters.
#[derive(Debug, Clone, PartialEq)]
pub struct EngineConfig {
    /// Folder with `face_detection_yunet_2023mar.onnx` and
    /// `face_recognition_sface_2021dec.onnx` (bundled resources in the app).
    pub models_dir: PathBuf,
    /// App cache root (`analysis/`, `thumbs/`, `frames/` live below it).
    pub cache_dir: PathBuf,
    /// `Some(n)`: a dedicated pool of `n` workers. `None`: run on the caller's
    /// rayon pool (the global one unless the caller `install`s another) — an
    /// app sizes that single pool itself (FaceTimelapse: cores − 1), so heavy
    /// work never oversubscribes the CPU with a second pool.
    pub threads: Option<usize>,
    /// Detector parameters.
    pub detector: DetectorConfig,
    /// Score calibration.
    pub calibration: Calibration,
}

impl EngineConfig {
    /// Defaults for the given folders.
    #[must_use]
    pub fn new(models_dir: impl Into<PathBuf>, cache_dir: impl Into<PathBuf>) -> Self {
        Self {
            models_dir: models_dir.into(),
            cache_dir: cache_dir.into(),
            threads: None,
            detector: DetectorConfig::default(),
            calibration: Calibration::default(),
        }
    }
}

/// The face engine. Cheap to share behind an `Arc`; all methods take `&self`.
pub struct Engine {
    analyzer: Analyzer,
    pool: Option<rayon::ThreadPool>,
    cache_dir: PathBuf,
    calibration: Calibration,
}

impl std::fmt::Debug for Engine {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Engine")
            .field("cache_dir", &self.cache_dir)
            .field("threads", &self.threads())
            .finish_non_exhaustive()
    }
}

impl Engine {
    /// Loads the models (and builds the dedicated pool when configured).
    ///
    /// # Errors
    /// [`EngineError::Model`] when models are missing/invalid,
    /// [`EngineError::Internal`] if the thread pool cannot be created.
    pub fn new(config: EngineConfig) -> Result<Self> {
        let analyzer = Analyzer::load(&config.models_dir, config.detector)?;
        let pool = config
            .threads
            .map(|n| {
                rayon::ThreadPoolBuilder::new()
                    .num_threads(n.max(1))
                    .thread_name(|i| format!("face-engine-{i}"))
                    .build()
                    .map_err(|e| EngineError::Internal(format!("thread pool: {e}")))
            })
            .transpose()?;
        Ok(Self {
            analyzer,
            pool,
            cache_dir: config.cache_dir,
            calibration: config.calibration,
        })
    }

    /// Engine fingerprint (invalidates analysis caches and frames on change).
    #[must_use]
    pub fn fingerprint(&self) -> String {
        self.analyzer.fingerprint()
    }

    /// The loaded models.
    #[must_use]
    pub fn analyzer(&self) -> &Analyzer {
        &self.analyzer
    }

    /// Score calibration in use.
    #[must_use]
    pub fn calibration(&self) -> Calibration {
        self.calibration
    }

    /// Cache root.
    #[must_use]
    pub fn cache_dir(&self) -> &Path {
        &self.cache_dir
    }

    /// Number of worker threads heavy work runs on.
    #[must_use]
    pub fn threads(&self) -> usize {
        self.pool.as_ref().map_or_else(
            rayon::current_num_threads,
            rayon::ThreadPool::current_num_threads,
        )
    }

    /// Runs `f` on the engine's workers (the dedicated pool if any).
    pub fn install<R: Send>(&self, f: impl FnOnce() -> R + Send) -> R {
        match &self.pool {
            Some(pool) => pool.install(f),
            None => f(),
        }
    }

    /// Walks a folder (§9.1).
    ///
    /// # Errors
    /// Missing/unreadable folder.
    pub fn walk(&self, folder: &Path) -> Result<WalkResult> {
        walk::walk(folder)
    }

    /// Analyzes one photo (never fails; see [`Analyzer::analyze`]).
    #[must_use]
    pub fn analyze_photo(&self, path: &Path, thumb_width: Option<u32>) -> AnalysisOutput {
        let mtime = std::fs::metadata(path)
            .map(|m| walk::mtime_ns(&m))
            .unwrap_or(0);
        self.analyzer.analyze(path, mtime, thumb_width)
    }

    /// Loads a reference photo with `rotation_deg` applied.
    ///
    /// # Errors
    /// See [`ReferenceImage::load`].
    pub fn load_reference(&self, path: &Path, rotation_deg: f64) -> Result<ReferenceImage> {
        self.install(|| ReferenceImage::load(&self.analyzer, path, rotation_deg))
    }

    /// Detects and embeds the face inside a reference crop.
    ///
    /// # Errors
    /// See [`ReferenceImage::detect_crop`].
    pub fn detect_reference(
        &self,
        image: &ReferenceImage,
        crop: Rect,
    ) -> Result<Option<ReferenceDetection>> {
        self.install(|| image.detect_crop(&self.analyzer, crop))
    }

    /// Incremental scan of `folder` against `reference` ([`scan_folder`]).
    ///
    /// # Errors
    /// Folder-level failures only.
    pub fn scan(
        &self,
        folder: &Path,
        reference: &Embedding,
        options: ScanOptions,
        sink: &dyn ProgressSink<ScanEvent>,
        cancel: &CancelToken,
    ) -> Result<ScanReport> {
        let ctx = ScanContext {
            analyzer: &self.analyzer,
            cache_dir: &self.cache_dir,
            reference,
            calibration: self.calibration,
            options,
        };
        self.install(|| scan_folder(&ctx, folder, sink, cancel))
    }

    /// Deletes the analysis cache of `folder`; returns `(entries, bytes)`.
    ///
    /// # Errors
    /// I/O errors.
    pub fn clear_scan_cache(&self, folder: &Path) -> Result<(usize, u64)> {
        let canonical = folder
            .canonicalize()
            .unwrap_or_else(|_| folder.to_path_buf());
        let (mut cache, _) = AnalysisCache::load(&self.cache_dir, &canonical, &self.fingerprint());
        cache.delete()
    }

    /// Renders one frame (no disk I/O besides reading the photo).
    ///
    /// # Errors
    /// See [`align::render_frame`].
    pub fn render_frame(&self, request: &FrameRequest<'_>) -> Result<RenderedFrame> {
        self.install(|| align::render_frame(self.analyzer.detector(), request))
    }

    /// Thumbnail of a source photo (disk-cached under `thumbs/`).
    ///
    /// # Errors
    /// I/O, decode or encode errors.
    pub fn thumbnail(&self, path: &Path, id: &str, version: &str, width: u32) -> Result<Vec<u8>> {
        thumbs::thumbnail(Some(&self.cache_dir), path, id, version, width)
    }

    /// Frame store for a render fingerprint.
    #[must_use]
    pub fn frame_store(&self, fingerprint: &str) -> FrameStore {
        FrameStore::new(&self.cache_dir, fingerprint)
    }

    /// Renders (or reuses) every frame of `job` ([`align_frames`]) and records
    /// the new masters in the store's manifest.
    ///
    /// # Errors
    /// Only job-level failures (manifest write); per-frame errors are reported
    /// in [`AlignReport::failures`].
    pub fn align(
        &self,
        job: &AlignJob,
        sink: &dyn ProgressSink<AlignProgress>,
        cancel: &CancelToken,
    ) -> Result<AlignReport> {
        let store = self.frame_store(&job.spec.fingerprint);
        let mut manifest = store.load_usable_manifest();
        let report = self.install(|| {
            align_frames(
                self.analyzer.detector(),
                &store,
                &job.spec,
                &job.items,
                &manifest,
                sink,
                cancel,
            )
        });
        for f in report.frames.iter().filter(|f| !f.reused) {
            manifest.insert(f.manifest_entry());
        }
        store.save_manifest(&manifest)?;
        Ok(report)
    }

    /// Exports masters (+ look) as PNG/JPEG into `dir` ([`export::export_images`]).
    ///
    /// # Errors
    /// Invalid settings, a missing/unwritable folder or the first per-file error.
    pub fn export_images(
        &self,
        items: &[ExportItem],
        dir: &Path,
        settings: &ImageExportSettings,
        sink: &dyn ProgressSink<ExportProgress>,
        cancel: &CancelToken,
    ) -> Result<ExportReport> {
        self.install(|| export::export_images(items, dir, settings, sink, cancel))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ErrorKind;

    #[test]
    fn config_defaults_and_missing_models() {
        let dir = tempfile::tempdir().expect("tmp");
        let cfg = EngineConfig::new(dir.path().join("models"), dir.path().join("cache"));
        assert_eq!(cfg.threads, None);
        assert_eq!(cfg.detector, DetectorConfig::default());
        let err = Engine::new(cfg).expect_err("no models");
        assert_eq!(err.kind(), ErrorKind::ModelUnavailable);
    }
}
