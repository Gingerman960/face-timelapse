//! ONNX model loading and execution on `tract` (pure Rust).
//!
//! Runtime choice (see `BENCHMARKS.md`): tract runs SFace — the most
//! expensive model — faster than ONNX Runtime on this machine (18 vs 27 ms
//! single-thread, 581 vs 305 inferences/s on 16 threads), needs no native
//! library download/bundling/signing, and builds unchanged on macOS, Windows
//! and Linux.
//!
//! Weights are loaded once and shared by every worker thread: an optimized
//! plan is `Send + Sync`, and each run uses a pooled per-call state.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use tract_onnx::prelude::*;

use crate::error::{EngineError, Result};

/// File name of the YuNet detector (OpenCV Zoo, MIT).
pub const YUNET_FILE: &str = "face_detection_yunet_2023mar.onnx";
/// File name of the SFace recognizer (OpenCV Zoo, Apache-2.0).
pub const SFACE_FILE: &str = "face_recognition_sface_2021dec.onnx";
/// SHA-256 of [`YUNET_FILE`] (the pin of `scripts/fetch-models.sh`).
pub const YUNET_SHA256: &str = "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4";
/// SHA-256 of [`SFACE_FILE`] (the pin of `scripts/fetch-models.sh`).
pub const SFACE_SHA256: &str = "0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79";
/// [`ModelPaths::fingerprint`] of the pinned files (update with the pins).
/// Cheaper than the SHA-256 check, so the early analysis fingerprint uses it
/// to tell the pinned files from altered ones.
pub const MODELS_FINGERPRINT: &str = "9b9c58ececad8f42";

type Plan = Arc<TypedRunnableModel>;

/// Idle execution states kept per plan (more concurrent runs spawn temporaries).
const MAX_POOLED_STATES: usize = 16;
/// Optimized plans kept per variable-shape model (least recently used evicted).
const MAX_PLANS: usize = 16;

/// An optimized plan plus a pool of reusable execution states.
pub(crate) struct PooledPlan {
    plan: Plan,
    states: Mutex<Vec<TypedSimpleState>>,
}

impl PooledPlan {
    fn new(plan: Plan) -> Self {
        Self {
            plan,
            states: Mutex::new(Vec::new()),
        }
    }

    /// Runs the plan with one input tensor, returning all outputs.
    pub(crate) fn run(&self, input: Tensor) -> Result<TVec<TValue>> {
        let pooled = self.states.lock().ok().and_then(|mut v| v.pop());
        let mut state = match pooled {
            Some(s) => s,
            None => self
                .plan
                .spawn()
                .map_err(|e| EngineError::Inference(format!("{e:#}")))?,
        };
        let out = state
            .run(tvec!(input.into()))
            .map_err(|e| EngineError::Inference(format!("{e:#}")))?;
        if let Ok(mut pool) = self.states.lock()
            && pool.len() < MAX_POOLED_STATES
        {
            pool.push(state);
        }
        Ok(out)
    }
}

/// An ONNX model whose input spatial size varies per call (YuNet). One
/// optimized plan is built and cached per padded input shape.
pub(crate) struct ShapedModel {
    name: String,
    proto: InferenceModel,
    plans: Mutex<PlanCache>,
    /// Plans built so far (diagnostics).
    pub(crate) builds: std::sync::atomic::AtomicUsize,
}

/// A plan being built or built once; errors are not kept (next call retries).
type PlanSlot = std::sync::OnceLock<std::result::Result<Arc<PooledPlan>, String>>;

/// LRU of optimized plans keyed by `(h, w)`. The lock only guards the map:
/// plans are built outside it, so a new shape never stalls other workers.
#[derive(Default)]
struct PlanCache {
    tick: u64,
    entries: HashMap<(usize, usize), (u64, Arc<PlanSlot>)>,
}

impl ShapedModel {
    fn from_bytes(name: &str, bytes: &[u8]) -> Result<Self> {
        let proto = tract_onnx::onnx()
            .with_ignore_value_info(true)
            .model_for_read(&mut std::io::Cursor::new(bytes))
            .map_err(|e| model_err(name, &e))?;
        Ok(Self {
            name: name.to_owned(),
            proto,
            plans: Mutex::new(PlanCache::default()),
            builds: std::sync::atomic::AtomicUsize::new(0),
        })
    }

    /// Plan for a `1×3×h×w` input (built on first use, then cached). Only
    /// callers of the same new shape wait for its build.
    pub(crate) fn plan(&self, h: usize, w: usize) -> Result<Arc<PooledPlan>> {
        self.plan_with(h, w, || {
            self.proto
                .clone()
                .with_input_fact(0, f32::fact([1, 3, h, w]).into())
                .and_then(|m| m.into_optimized())
                .and_then(|m| m.into_runnable())
                .map(|plan| Arc::new(PooledPlan::new(plan)))
                .map_err(|e| format!("{e:#}"))
        })
    }

    /// [`ShapedModel::plan`] with the plan builder supplied (tests drive the
    /// failure path through it).
    fn plan_with(
        &self,
        h: usize,
        w: usize,
        build: impl FnOnce() -> std::result::Result<Arc<PooledPlan>, String>,
    ) -> Result<Arc<PooledPlan>> {
        let slot = {
            let mut plans = self
                .plans
                .lock()
                .map_err(|_| EngineError::Internal("model plan cache poisoned".into()))?;
            plans.tick += 1;
            let tick = plans.tick;
            if let Some((used, slot)) = plans.entries.get_mut(&(h, w)) {
                *used = tick;
                Arc::clone(slot)
            } else {
                if plans.entries.len() >= MAX_PLANS
                    && let Some(oldest) = plans
                        .entries
                        .iter()
                        .min_by_key(|(_, (used, _))| *used)
                        .map(|(k, _)| *k)
                {
                    plans.entries.remove(&oldest);
                }
                let slot = Arc::new(PlanSlot::new());
                plans.entries.insert((h, w), (tick, Arc::clone(&slot)));
                slot
            }
        };
        let built = slot.get_or_init(|| {
            self.builds
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            build()
        });
        match built {
            Ok(plan) => Ok(Arc::clone(plan)),
            Err(message) => {
                if let Ok(mut plans) = self.plans.lock()
                    && plans
                        .entries
                        .get(&(h, w))
                        .is_some_and(|(_, s)| Arc::ptr_eq(s, &slot))
                {
                    plans.entries.remove(&(h, w));
                }
                Err(EngineError::Model {
                    name: self.name.clone(),
                    message: message.clone(),
                })
            }
        }
    }

    /// Number of cached plans (for tests and diagnostics).
    #[cfg(test)]
    pub(crate) fn plan_count(&self) -> usize {
        self.plans.lock().map(|p| p.entries.len()).unwrap_or(0)
    }
}

/// Reads a model file (for the path-based loaders).
fn read_model(path: &Path) -> Result<Vec<u8>> {
    std::fs::read(path).map_err(|e| EngineError::Model {
        name: file_label(path),
        message: format!("cannot read it: {e}"),
    })
}

/// Loads a fixed-shape model (SFace) into a pooled plan.
pub(crate) fn load_fixed(path: &Path, shape: &[usize]) -> Result<PooledPlan> {
    load_fixed_bytes(&file_label(path), &read_model(path)?, shape)
}

/// [`load_fixed`] from the model's bytes.
pub(crate) fn load_fixed_bytes(name: &str, bytes: &[u8], shape: &[usize]) -> Result<PooledPlan> {
    let plan = tract_onnx::onnx()
        .model_for_read(&mut std::io::Cursor::new(bytes))
        .and_then(|m| m.with_input_fact(0, f32::fact(shape).into()))
        .and_then(|m| m.into_optimized())
        .and_then(|m| m.into_runnable())
        .map_err(|e| model_err(name, &e))?;
    Ok(PooledPlan::new(plan))
}

/// Loads the variable-shape YuNet model.
pub(crate) fn load_shaped(path: &Path) -> Result<ShapedModel> {
    ShapedModel::from_bytes(&file_label(path), &read_model(path)?)
}

/// [`load_shaped`] from the model's bytes.
pub(crate) fn load_shaped_bytes(name: &str, bytes: &[u8]) -> Result<ShapedModel> {
    ShapedModel::from_bytes(name, bytes)
}

/// Both model files, read once and checked against their pinned SHA-256
/// ([`ModelPaths::read_verified`]); models are built from these bytes, so a
/// file swapped after the check is never parsed.
pub struct VerifiedModels {
    pub(crate) yunet: Vec<u8>,
    pub(crate) sface: Vec<u8>,
}

impl std::fmt::Debug for VerifiedModels {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VerifiedModels")
            .field("yunet_bytes", &self.yunet.len())
            .field("sface_bytes", &self.sface.len())
            .finish()
    }
}

impl VerifiedModels {
    /// Same value as [`ModelPaths::fingerprint`] for these bytes.
    #[must_use]
    pub fn fingerprint(&self) -> String {
        fingerprint_of_bytes(&self.yunet, &self.sface)
    }
}

fn fingerprint_of_bytes(yunet: &[u8], sface: &[u8]) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(yunet);
    hasher.update(sface);
    let mut hex = hasher.finalize().to_hex().to_string();
    hex.truncate(16);
    hex
}

/// Locations of the two model files inside a models directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelPaths {
    /// YuNet detector.
    pub yunet: PathBuf,
    /// SFace recognizer.
    pub sface: PathBuf,
}

impl ModelPaths {
    /// Standard file names inside `dir`.
    #[must_use]
    pub fn in_dir(dir: &Path) -> Self {
        Self {
            yunet: dir.join(YUNET_FILE),
            sface: dir.join(SFACE_FILE),
        }
    }

    /// Fails with [`EngineError::Model`] when a file is missing.
    ///
    /// # Errors
    /// See above.
    pub fn check(&self) -> Result<()> {
        for path in [&self.yunet, &self.sface] {
            if !path.is_file() {
                return Err(EngineError::Model {
                    name: file_label(path),
                    message: format!(
                        "file not found at {} (run scripts/fetch-models.sh)",
                        path.display()
                    ),
                });
            }
        }
        Ok(())
    }

    /// Checks both files against their pinned SHA-256 so a replaced or
    /// corrupted model is never parsed.
    ///
    /// # Errors
    /// [`EngineError::Model`] on a mismatch or a read failure.
    pub fn verify(&self) -> Result<()> {
        self.read_verified().map(drop)
    }

    /// Reads both files once and checks their pinned SHA-256; build the
    /// models from the returned bytes (no second read, no swap window).
    ///
    /// # Errors
    /// [`EngineError::Model`] on a mismatch or a read failure.
    pub fn read_verified(&self) -> Result<VerifiedModels> {
        use sha2::Digest as _;
        let read = |path: &Path, expected: &str| {
            let bytes = read_model(path)?;
            let digest = sha2::Sha256::digest(&bytes);
            let actual: String = digest.iter().map(|b| format!("{b:02x}")).collect();
            if actual != expected {
                return Err(EngineError::Model {
                    name: file_label(path),
                    message: format!("SHA-256 mismatch (expected {expected}, found {actual})"),
                });
            }
            Ok(bytes)
        };
        Ok(VerifiedModels {
            yunet: read(&self.yunet, YUNET_SHA256)?,
            sface: read(&self.sface, SFACE_SHA256)?,
        })
    }

    /// `hex(blake3(yunet ‖ sface))[..16]` — part of the engine fingerprint.
    ///
    /// # Errors
    /// I/O errors reading the files.
    pub fn fingerprint(&self) -> Result<String> {
        let read = |path: &PathBuf| {
            std::fs::read(path)
                .map_err(|e| EngineError::io(format!("reading model {}", path.display()), e))
        };
        Ok(fingerprint_of_bytes(
            &read(&self.yunet)?,
            &read(&self.sface)?,
        ))
    }
}

fn file_label(path: &Path) -> String {
    path.file_name().map_or_else(
        || path.display().to_string(),
        |n| n.to_string_lossy().into_owned(),
    )
}

fn model_err(name: &str, e: &TractError) -> EngineError {
    EngineError::Model {
        name: name.to_owned(),
        message: format!("{e:#}"),
    }
}

/// Reads output `i` as a contiguous `f32` slice.
pub(crate) fn output_slice(outputs: &TVec<TValue>, i: usize) -> Result<&[f32]> {
    let t = outputs
        .get(i)
        .ok_or_else(|| EngineError::Inference(format!("model produced no output #{i}")))?;
    t.try_as_plain_ram()
        .and_then(|v| v.as_slice::<f32>())
        .map_err(|e| EngineError::Inference(format!("output #{i}: {e:#}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_pinned_models_have_the_pinned_fingerprint() {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../models");
        let paths = ModelPaths::in_dir(&repo);
        // Checked only when the models were fetched.
        let fetched = paths.fingerprint().ok().filter(|_| paths.verify().is_ok());
        assert!(
            fetched.as_deref().is_none_or(|f| f == MODELS_FINGERPRINT),
            "{fetched:?}"
        );
    }

    #[test]
    fn missing_models_are_reported() {
        let dir = tempfile::tempdir().expect("tmp");
        let paths = ModelPaths::in_dir(dir.path());
        let err = paths.check().expect_err("missing");
        assert_eq!(err.kind(), crate::ErrorKind::ModelUnavailable);
        assert!(err.to_string().contains(YUNET_FILE), "{err}");
        assert!(paths.fingerprint().is_err());
        assert!(load_fixed(&paths.sface, &[1, 3, 112, 112]).is_err());
        assert!(load_shaped(&paths.yunet).is_err());
    }

    /// The repository's YuNet, when fetched (tests skip without it).
    fn yunet() -> Option<ShapedModel> {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../models")
            .join(YUNET_FILE);
        let found = path.is_file();
        if !found {
            eprintln!("skipped: {} not present", path.display());
        }
        found.then(|| load_shaped(&path).expect("yunet"))
    }

    #[test]
    fn a_failed_plan_build_is_reported_and_retried_not_cached() {
        let Some(m) = yunet() else { return };
        let err = m
            .plan_with(64, 64, || Err("synthetic failure".into()))
            .err()
            .expect("failed build");
        assert_eq!(err.kind(), crate::ErrorKind::ModelUnavailable);
        assert!(err.to_string().contains("synthetic failure"), "{err}");
        assert_eq!(m.plan_count(), 0, "the failed slot is dropped");
        m.plan(64, 64).expect("next call builds again");
        assert_eq!(m.plan_count(), 1);
        assert_eq!(m.builds.load(std::sync::atomic::Ordering::SeqCst), 2);
    }

    #[test]
    fn unreadable_model_files_fail_verification() {
        let dir = tempfile::tempdir().expect("tmp");
        let err = ModelPaths::in_dir(dir.path())
            .verify()
            .expect_err("missing");
        assert_eq!(err.kind(), crate::ErrorKind::ModelUnavailable);
        assert!(err.to_string().contains("cannot read"), "{err}");
        let paths = ModelPaths::in_dir(dir.path());
        let err = crate::recognize::Recognizer::load(&paths.sface).expect_err("missing");
        assert!(err.to_string().contains("cannot read"), "{err}");
        assert!(crate::recognize::Recognizer::from_bytes(b"not a model").is_err());
        assert!(crate::detect::Detector::from_bytes(b"not a model", Default::default()).is_err());
    }

    #[test]
    fn verified_models_report_sizes_and_the_folder_fingerprint() {
        let dir = tempfile::tempdir().expect("tmp");
        let paths = ModelPaths::in_dir(dir.path());
        std::fs::write(&paths.yunet, b"yunet").expect("write");
        std::fs::write(&paths.sface, b"sface!").expect("write");
        let models = VerifiedModels {
            yunet: b"yunet".to_vec(),
            sface: b"sface!".to_vec(),
        };
        assert_eq!(
            models.fingerprint(),
            paths.fingerprint().expect("fingerprint"),
            "same value as hashing the files"
        );
        let debug = format!("{models:?}");
        assert!(
            debug.contains("yunet_bytes: 5") && debug.contains("sface_bytes: 6"),
            "{debug}"
        );
    }

    #[test]
    fn plan_cache_is_bounded() {
        let Some(m) = yunet() else { return };
        for i in 0..(MAX_PLANS + 3) {
            m.plan(32, 32 * (i + 1)).expect("plan");
        }
        assert_eq!(m.plan_count(), MAX_PLANS);
        // Most recently used shapes survive; the oldest were evicted.
        let before = m.plan_count();
        m.plan(32, 32 * (MAX_PLANS + 3)).expect("cached");
        assert_eq!(m.plan_count(), before);
    }

    #[test]
    fn concurrent_requests_for_a_new_shape_build_it_once() {
        let Some(m) = yunet().map(Arc::new) else {
            return;
        };
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let m = Arc::clone(&m);
                std::thread::spawn(move || m.plan(64, 96).map(|_| ()))
            })
            .collect();
        for t in threads {
            t.join().expect("join").expect("plan");
        }
        assert_eq!(m.plan_count(), 1);
        assert_eq!(m.builds.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[test]
    fn model_files_are_verified_against_pinned_hashes() {
        let dir = tempfile::tempdir().expect("tmp");
        let paths = ModelPaths::in_dir(dir.path());
        std::fs::write(&paths.yunet, b"tampered").expect("write");
        std::fs::write(&paths.sface, b"tampered").expect("write");
        let err = paths.verify().expect_err("tampered");
        assert_eq!(err.kind(), crate::ErrorKind::ModelUnavailable);
        assert!(err.to_string().contains("SHA-256"), "{err}");
        let err =
            crate::analysis::Analyzer::load(dir.path(), crate::detect::DetectorConfig::default())
                .expect_err("refused before parsing");
        assert!(err.to_string().contains("SHA-256"), "{err}");
        let real = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../models");
        if real.join(YUNET_FILE).is_file() {
            ModelPaths::in_dir(&real)
                .verify()
                .expect("pinned models verify");
        }
    }

    #[test]
    fn garbage_model_files_fail_to_load() {
        let dir = tempfile::tempdir().expect("tmp");
        let paths = ModelPaths::in_dir(dir.path());
        std::fs::write(&paths.yunet, b"not an onnx model").expect("write");
        std::fs::write(&paths.sface, b"also not").expect("write");
        assert!(paths.check().is_ok());
        assert_eq!(paths.fingerprint().expect("fp").len(), 16);
        let err = load_fixed(&paths.sface, &[1, 3, 112, 112])
            .err()
            .expect("bad");
        assert_eq!(err.kind(), crate::ErrorKind::ModelUnavailable);
        assert!(load_shaped(&paths.yunet).is_err());
        assert_eq!(file_label(Path::new("/")), "/");
    }
}
