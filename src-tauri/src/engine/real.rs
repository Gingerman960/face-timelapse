//! [`Engine`] backed by the `face-engine` models.

use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use face_engine as fe;
use face_engine::analysis::{Analyzer, PhotoAnalyzer};
use face_engine::detect::DetectorConfig;
use face_engine::frames::FrameRenderer;
use face_engine::geometry::Rect;
use face_engine::reference::{ReferenceDetection, ReferenceImage, ReferenceInfo};
use parking_lot::Mutex;

use super::{Engine, check_photo_path};
use crate::error::{AppResult, from_engine};
use crate::ipc::IpcError;

pub use fe::model::{SFACE_FILE, YUNET_FILE};

/// Production engine.
pub struct RealEngine {
    models_dir: PathBuf,
    analyzer: OnceLock<Analyzer>,
    load_lock: Mutex<()>,
    fingerprint: OnceLock<String>,
    /// The model files' stamps when the fingerprint last failed: an unchanged
    /// broken set is not hashed again (~38 MB per call otherwise).
    failed: Mutex<Option<ModelStamps>>,
    /// Fingerprints computed from the files (tests).
    hashes: std::sync::atomic::AtomicUsize,
    /// Decoded + rotated reference, reused across crop changes (§11: < 150 ms).
    reference: Mutex<Option<(RefKey, Arc<ReferenceImage>)>>,
}

/// (length, mtime) of each model file; `None` for a missing one.
type ModelStamps = [Option<(u64, std::time::SystemTime)>; 2];

#[derive(Debug, Clone, PartialEq)]
struct RefKey {
    path: PathBuf,
    stamp: (u64, i64),
    rotation_bits: u64,
}

impl RealEngine {
    #[must_use]
    pub fn new(models_dir: PathBuf) -> Self {
        Self {
            models_dir,
            analyzer: OnceLock::new(),
            load_lock: Mutex::new(()),
            fingerprint: OnceLock::new(),
            failed: Mutex::new(None),
            hashes: std::sync::atomic::AtomicUsize::new(0),
            reference: Mutex::new(None),
        }
    }

    fn model_stamps(&self) -> ModelStamps {
        [YUNET_FILE, SFACE_FILE].map(|name| {
            let meta = std::fs::metadata(self.models_dir.join(name)).ok()?;
            Some((meta.len(), meta.modified().ok()?))
        })
    }

    fn loaded(&self) -> AppResult<&Analyzer> {
        self.load_models()?;
        self.analyzer.get().ok_or_else(IpcError::model_unavailable)
    }

    fn reference_for(&self, path: &Path, rotation_deg: f64) -> AppResult<Arc<ReferenceImage>> {
        check_photo_path(path)?;
        let stamp = fe::walk::file_stamp(path)
            .map_err(|e| IpcError::io("reading the reference photo", &e))?;
        let key = RefKey {
            path: path.to_path_buf(),
            stamp,
            rotation_bits: rotation_deg.to_bits(),
        };
        if let Some((k, img)) = self.reference.lock().as_ref()
            && *k == key
        {
            return Ok(Arc::clone(img));
        }
        let img = Arc::new(
            ReferenceImage::load(self.loaded()?, path, rotation_deg)
                .map_err(|e| from_engine(&e))?,
        );
        *self.reference.lock() = Some((key, Arc::clone(&img)));
        Ok(img)
    }
}

impl Engine for RealEngine {
    fn fingerprint(&self) -> Option<String> {
        if let Some(known) = self.fingerprint.get() {
            return Some(known.clone());
        }
        if let Some(a) = self.analyzer.get() {
            return Some(self.fingerprint.get_or_init(|| a.fingerprint()).clone());
        }
        // Same formula without loading the models (startup reads caches first).
        // Only a real fingerprint is remembered (the models may be readable
        // later); a failure only until the files change. Held while hashing,
        // so concurrent callers wait for one hash instead of each hashing.
        let stamps = self.model_stamps();
        let mut failed = self.failed.lock();
        if failed.as_ref() == Some(&stamps) {
            return None;
        }
        self.hashes
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        match fe::analysis::analysis_fingerprint(&self.models_dir, &DetectorConfig::default()) {
            Ok(f) => Some(self.fingerprint.get_or_init(|| f).clone()),
            Err(_) => {
                *failed = Some(stamps);
                None
            }
        }
    }

    fn models_ready(&self) -> bool {
        self.analyzer.get().is_some()
    }

    fn load_models(&self) -> AppResult<()> {
        if self.analyzer.get().is_some() {
            return Ok(());
        }
        let _guard = self.load_lock.lock();
        if self.analyzer.get().is_some() {
            return Ok(());
        }
        let started = std::time::Instant::now();
        let analyzer = Analyzer::load(&self.models_dir, DetectorConfig::default())
            .map_err(|e| from_engine(&e))?;
        if self
            .fingerprint
            .get()
            .is_some_and(|early| *early != analyzer.fingerprint())
        {
            // Only if the model files changed while the app was starting.
            log::warn!("engine fingerprint changed while loading; caches will be rebuilt");
        }
        let _ = self.analyzer.set(analyzer);
        log::info!("face models loaded in {} ms", started.elapsed().as_millis());
        Ok(())
    }

    fn analyzer(&self) -> AppResult<&dyn PhotoAnalyzer> {
        Ok(self.loaded()?)
    }

    fn renderer(&self) -> AppResult<&dyn FrameRenderer> {
        Ok(self.loaded()?.detector())
    }

    fn render_preview(
        &self,
        request: &fe::align::FrameRequest<'_>,
    ) -> AppResult<fe::align::RenderedFrame> {
        fe::align::render_frame_unrefined(request).map_err(|e| from_engine(&e))
    }

    fn reference(&self, path: &Path, rotation_deg: f64) -> AppResult<ReferenceInfo> {
        Ok(self.reference_for(path, rotation_deg)?.info())
    }

    fn reference_crop(
        &self,
        path: &Path,
        rotation_deg: f64,
        crop: Rect,
    ) -> AppResult<Option<ReferenceDetection>> {
        let r = self.reference_for(path, rotation_deg)?;
        r.detect_crop(self.loaded()?, crop)
            .map_err(|e| from_engine(&e))
    }
}

#[cfg(test)]
mod tests;
