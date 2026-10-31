//! Per-photo analysis — one pass per file (ARCHITECTURE §4.1, §9.3):
//! read → EXIF (orientation, dates) → capture date → DCT-scaled decode →
//! YuNet → SFace for up to 3 faces → 320 px thumbnail.
//!
//! The result is reference-independent and is what the analysis cache stores.

use std::path::Path;

use chrono::NaiveDateTime;
use serde::{Deserialize, Serialize};

use crate::dates::{self, DateSource};
use crate::decode::{self, DecodeTarget};
use crate::detect::{Detector, DetectorConfig};
use crate::encode::{self, Chroma};
use crate::error::{EngineError, ErrorKind, Result};
use crate::geometry::{Point, Rect, Size};
use crate::image::Filter;
use crate::model::{ModelPaths, VerifiedModels};
use crate::recognize::{Embedding, Recognizer};

/// One face found in a photo. Geometry is normalized to `[0, 1]` of the
/// upright (EXIF-oriented) photo.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FaceRecord {
    /// Face box.
    pub bounds: Rect,
    /// `[leftEye, rightEye, noseTip, mouthLeft, mouthRight]`, image left/right.
    pub landmarks: [Point; 5],
    /// Detector confidence.
    pub score: f32,
    /// L2-normalized SFace embedding.
    pub embedding: Embedding,
}

impl FaceRecord {
    /// Landmarks in pixels of an image of `size`.
    #[must_use]
    pub fn landmarks_px(&self, size: Size) -> [Point; 5] {
        let (w, h) = (f64::from(size.width), f64::from(size.height));
        self.landmarks.map(|p| p.scaled(w, h))
    }

    /// Bounds in pixels of an image of `size`.
    #[must_use]
    pub fn bounds_px(&self, size: Size) -> Rect {
        self.bounds
            .scaled(f64::from(size.width), f64::from(size.height))
    }
}

/// Why a photo could not be analyzed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FailureKind {
    /// HEIC/HEIF or unknown bytes.
    UnsupportedFormat,
    /// Corrupt or truncated image data.
    DecodeFailed,
    /// The file could not be read.
    Io,
    /// Unexpected internal error (a bug, a model failure or a panic).
    Internal,
}

impl FailureKind {
    /// Classifies an engine error.
    #[must_use]
    pub fn of(err: &EngineError) -> Self {
        match err.kind() {
            ErrorKind::UnsupportedFormat => Self::UnsupportedFormat,
            ErrorKind::DecodeFailed => Self::DecodeFailed,
            ErrorKind::NotFound
            | ErrorKind::PermissionDenied
            | ErrorKind::Io
            | ErrorKind::DiskFull => Self::Io,
            _ => Self::Internal,
        }
    }
}

/// Faces, no face, or failure. (Externally tagged so it round-trips
/// through `postcard`, which cannot represent internally tagged enums.)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Outcome {
    /// At least one face (≤ 3, largest first).
    Faces {
        /// The faces.
        faces: Vec<FaceRecord>,
    },
    /// Decoded fine, no face found.
    NoFace,
    /// Could not be analyzed.
    Failed {
        /// Classification.
        kind: FailureKind,
        /// Human-readable detail.
        message: String,
    },
}

/// Reference-independent analysis of one photo (what the cache stores).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotoAnalysis {
    /// Upright full-resolution size (zero when the photo failed to decode).
    pub oriented_size: Size,
    /// Naive local capture time.
    pub taken_at: NaiveDateTime,
    /// Where `taken_at` came from.
    pub date_source: DateSource,
    /// Faces / no face / failure.
    pub outcome: Outcome,
}

impl PhotoAnalysis {
    /// True when the result describes the file itself and may be cached:
    /// I/O failures (offline volume, permissions) and internal errors
    /// (panics, model failures) are transient and must be retried.
    #[must_use]
    pub fn is_cacheable(&self) -> bool {
        !matches!(
            self.outcome,
            Outcome::Failed {
                kind: FailureKind::Io | FailureKind::Internal,
                ..
            }
        )
    }

    /// Faces (empty unless the outcome is [`Outcome::Faces`]).
    #[must_use]
    pub fn faces(&self) -> &[FaceRecord] {
        match &self.outcome {
            Outcome::Faces { faces } => faces,
            _ => &[],
        }
    }
}

/// What [`Analyzer::analyze`] returns.
#[derive(Debug, Clone)]
pub struct AnalysisOutput {
    /// The cacheable analysis.
    pub analysis: PhotoAnalysis,
    /// Encoded JPEG thumbnail (when requested and the photo decoded).
    pub thumbnail: Option<Vec<u8>>,
}

/// Per-photo analysis as the scan sees it: [`Analyzer`] in production, a
/// deterministic double in callers' tests (no models needed).
pub trait PhotoAnalyzer: Sync {
    /// Analysis-cache fingerprint (see [`Analyzer::fingerprint`]).
    fn fingerprint(&self) -> String;

    /// Analyzes one photo; never fails (see [`Analyzer::analyze`]).
    fn analyze(&self, path: &Path, mtime_ns: i64, thumb_width: Option<u32>) -> AnalysisOutput;
}

impl PhotoAnalyzer for Analyzer {
    fn fingerprint(&self) -> String {
        Analyzer::fingerprint(self)
    }

    fn analyze(&self, path: &Path, mtime_ns: i64, thumb_width: Option<u32>) -> AnalysisOutput {
        Analyzer::analyze(self, path, mtime_ns, thumb_width)
    }
}

/// Loaded models plus analysis parameters. Shared by all worker threads.
#[derive(Debug)]
pub struct Analyzer {
    detector: Detector,
    recognizer: Recognizer,
    models_fingerprint: String,
}

/// Version of the analysis algorithm/format; bump to invalidate caches.
/// 2: PNG/TIFF/WebP are analysed at working size (≤ 1279 px, like JPEG's
/// DCT-scaled decode) instead of full size, so their landmarks and
/// embeddings differ slightly from version 1.
pub const ANALYSIS_VERSION: u32 = 2;

impl Analyzer {
    /// Loads both models from `models_dir` after checking their pinned
    /// SHA-256 ([`ModelPaths::verify`]).
    ///
    /// # Errors
    /// [`EngineError::Model`] if a model is missing, altered or invalid.
    pub fn load(models_dir: &Path, config: DetectorConfig) -> Result<Self> {
        let paths = ModelPaths::in_dir(models_dir);
        paths.check()?;
        Self::from_verified(&paths.read_verified()?, config)
    }

    /// Builds both models from bytes that passed [`ModelPaths::read_verified`].
    ///
    /// # Errors
    /// [`EngineError::Model`] if a model is invalid.
    pub fn from_verified(models: &VerifiedModels, config: DetectorConfig) -> Result<Self> {
        Ok(Self {
            detector: Detector::from_bytes(&models.yunet, config)?,
            recognizer: Recognizer::from_bytes(&models.sface)?,
            models_fingerprint: models.fingerprint(),
        })
    }

    /// The detector.
    #[must_use]
    pub fn detector(&self) -> &Detector {
        &self.detector
    }

    /// The recognizer.
    #[must_use]
    pub fn recognizer(&self) -> &Recognizer {
        &self.recognizer
    }

    /// `hex(blake3(engine version, analysis version, detector config, models))[..16]`.
    /// Any change invalidates analysis caches.
    #[must_use]
    pub fn fingerprint(&self) -> String {
        fingerprint_of(&self.models_fingerprint, self.detector.config())
    }

    /// Analyzes one photo. Never fails: problems become [`Outcome::Failed`].
    /// `thumb_width` requests a JPEG thumbnail fitting `w × w`.
    #[must_use]
    pub fn analyze(&self, path: &Path, mtime_ns: i64, thumb_width: Option<u32>) -> AnalysisOutput {
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default();
        let file_time = std::fs::metadata(path)
            .ok()
            .and_then(|m| dates::file_time(&m))
            .unwrap_or_else(|| dates::local_from_unix_ns(mtime_ns));
        let fail = |err: &EngineError, exif: &dates::ExifDates| {
            let when = dates::resolve(exif, name, file_time);
            AnalysisOutput {
                analysis: PhotoAnalysis {
                    oriented_size: Size::default(),
                    taken_at: when.taken_at,
                    date_source: when.source,
                    outcome: Outcome::Failed {
                        kind: FailureKind::of(err),
                        message: err.to_string(),
                    },
                },
                thumbnail: None,
            }
        };
        let bytes = match decode::read_file(path) {
            Ok(b) => b,
            Err(err) => return fail(&err, &dates::ExifDates::default()),
        };
        let exif = decode::read_exif(&bytes);
        match self.analyze_bytes(&bytes, path, exif.orientation, thumb_width) {
            Ok((oriented_size, outcome, thumbnail)) => {
                let when = dates::resolve(&exif.dates, name, file_time);
                AnalysisOutput {
                    analysis: PhotoAnalysis {
                        oriented_size,
                        taken_at: when.taken_at,
                        date_source: when.source,
                        outcome,
                    },
                    thumbnail,
                }
            }
            Err(err) => fail(&err, &exif.dates),
        }
    }

    fn analyze_bytes(
        &self,
        bytes: &[u8],
        path: &Path,
        orientation: u16,
        thumb_width: Option<u32>,
    ) -> Result<(Size, Outcome, Option<Vec<u8>>)> {
        let long_edge = self.detector.config().input_long_edge;
        let decoded = decode::decode(
            bytes,
            path,
            orientation,
            DecodeTarget::MinLongEdge(long_edge),
        )?;
        let full_size = decoded.full_size;
        // Work at the scan's resolution: a JPEG is already DCT-scaled to
        // [long_edge, 2·long_edge); a PNG/TIFF/WebP decodes at full size and
        // is shrunk to the same bound here. The full-size buffer (and its
        // pixel-budget share) is gone before detection and embedding run.
        let work = if decoded.image.size().long_edge() >= 2 * long_edge {
            let small = decoded
                .image
                .fit_within(2 * long_edge - 1, crate::image::Filter::CatmullRom)?;
            drop(decoded);
            small
        } else {
            decoded.into_image()
        };
        let img = &work;
        let detections = self.detector.detect(img)?;
        let (w, h) = (f64::from(img.width()), f64::from(img.height()));
        let mut faces = Vec::with_capacity(detections.len());
        for d in &detections {
            let embedding = self.recognizer.embed(img, &d.landmarks)?;
            faces.push(FaceRecord {
                bounds: d.bounds.scaled(1.0 / w, 1.0 / h),
                landmarks: d.landmarks.map(|p| p.scaled(1.0 / w, 1.0 / h)),
                score: d.score,
                embedding,
            });
        }
        let thumbnail = match thumb_width {
            Some(tw) => Some(encode_thumbnail(img, tw)?),
            None => None,
        };
        let outcome = if faces.is_empty() {
            Outcome::NoFace
        } else {
            Outcome::Faces { faces }
        };
        Ok((full_size, outcome, thumbnail))
    }
}

/// The analysis-cache fingerprint for `models_dir` + `config` without loading
/// the models (only hashes the files) — identical to [`Analyzer::fingerprint`]
/// of an analyzer loaded from the same directory with the same config. Only
/// the pinned files ([`crate::model::MODELS_FINGERPRINT`]; [`Analyzer::load`]
/// checks their SHA-256) have one, so a fingerprint means "these would load".
///
/// # Errors
/// [`EngineError::Model`] / I/O errors when a model file is missing or altered.
pub fn analysis_fingerprint(models_dir: &Path, config: &DetectorConfig) -> Result<String> {
    let paths = ModelPaths::in_dir(models_dir);
    paths.check()?;
    let models = paths.fingerprint()?;
    if models != crate::model::MODELS_FINGERPRINT {
        return Err(EngineError::Model {
            name: "model files".into(),
            message: "not the pinned files (run scripts/fetch-models.sh)".into(),
        });
    }
    Ok(fingerprint_of(&models, config))
}

fn fingerprint_of(models_fingerprint: &str, config: &DetectorConfig) -> String {
    let text = format!(
        "{}|{}|{:?}|{}",
        crate::ENGINE_VERSION,
        ANALYSIS_VERSION,
        config,
        models_fingerprint
    );
    crate::walk::hex_prefix(text.as_bytes(), 16)
}

/// Fits `img` inside `w × w` and encodes it with the thumbnail quality rule
/// (q80 up to 640 px, q85 above; 4:2:0).
///
/// # Errors
/// Resize/encode failures.
pub fn encode_thumbnail(img: &crate::image::RgbImage, w: u32) -> Result<Vec<u8>> {
    let small = img.fit_within(w, Filter::CatmullRom)?;
    let quality = if w <= 640 { 80 } else { 85 };
    encode::jpeg_with(&small, quality, Chroma::Subsampled)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The real reference selfie (`FT_REFERENCE_PHOTO`), when present.
    fn reference_photo() -> Option<std::path::PathBuf> {
        let p = std::env::var_os("FT_REFERENCE_PHOTO").map_or_else(
            || {
                std::path::PathBuf::from(
                    "/Users/gingerman/Projects/everyday photos/reference/IMG_20140815_142326.jpg",
                )
            },
            std::path::PathBuf::from,
        );
        p.is_file().then_some(p)
    }

    #[test]
    fn large_full_size_decodes_hold_no_budget_during_detection_and_embedding() {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../models");
        let (Some(photo), Ok(analyzer)) = (
            reference_photo(),
            Analyzer::load(&repo, DetectorConfig::default()),
        ) else {
            return; // models or photo not available
        };
        // A PNG is always decoded at full size: 4160 × 3078 ≈ 12.8 MP, well
        // over the budget threshold, with a real face to embed.
        let img = crate::decode::decode_file(&photo, crate::decode::DecodeTarget::Full)
            .expect("decode")
            .image
            .resized(4160, 3078, crate::image::Filter::Bilinear)
            .expect("resize");
        let dir = tempfile::tempdir().expect("tmp");
        let png = dir.path().join("big.png");
        std::fs::write(&png, crate::encode::png(&img).expect("png")).expect("write");
        let out = analyzer.analyze(&png, 0, Some(320));
        assert!(
            matches!(out.analysis.outcome, Outcome::Faces { .. }),
            "{:?}",
            out.analysis.outcome
        );
    }

    #[test]
    fn models_are_built_from_the_bytes_that_were_verified() {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../models");
        let real = ModelPaths::in_dir(&repo);
        let Ok(()) = real.check() else { return }; // models not fetched
        let dir = tempfile::tempdir().expect("tmp");
        let paths = ModelPaths::in_dir(dir.path());
        std::fs::copy(&real.yunet, &paths.yunet).expect("copy");
        std::fs::copy(&real.sface, &paths.sface).expect("copy");
        let verified = paths.read_verified().expect("verified");
        // Swap the files after verification: nothing is read from disk again.
        std::fs::write(&paths.yunet, b"swapped").expect("write");
        std::fs::write(&paths.sface, b"swapped").expect("write");
        assert!(
            analysis_fingerprint(dir.path(), &DetectorConfig::default()).is_err(),
            "altered models have no fingerprint: no cache is theirs"
        );
        let analyzer =
            Analyzer::from_verified(&verified, DetectorConfig::default()).expect("verified bytes");
        assert_eq!(
            analyzer.fingerprint(),
            analysis_fingerprint(&repo, &DetectorConfig::default()).expect("fingerprint"),
            "same fingerprint as loading from the folder"
        );
    }

    #[test]
    fn fingerprint_formula_depends_on_every_input() {
        let a = fingerprint_of("models", &DetectorConfig::default());
        assert_eq!(a.len(), 16);
        assert_eq!(a, fingerprint_of("models", &DetectorConfig::default()));
        assert_ne!(a, fingerprint_of("other", &DetectorConfig::default()));
        let cfg = DetectorConfig {
            score_threshold: 0.7,
            ..DetectorConfig::default()
        };
        assert_ne!(a, fingerprint_of("models", &cfg));
        let dir = tempfile::tempdir().expect("tmp");
        assert!(analysis_fingerprint(dir.path(), &DetectorConfig::default()).is_err());
    }

    #[test]
    fn failure_kinds() {
        let p = Path::new("x");
        assert_eq!(
            FailureKind::of(&EngineError::UnsupportedFormat { path: p.into() }),
            FailureKind::UnsupportedFormat
        );
        assert_eq!(
            FailureKind::of(&EngineError::decode(p, "x")),
            FailureKind::DecodeFailed
        );
        assert_eq!(
            FailureKind::of(&EngineError::io("x", std::io::Error::other("x"))),
            FailureKind::Io
        );
        assert_eq!(
            FailureKind::of(&EngineError::Inference("x".into())),
            FailureKind::Internal
        );
    }

    #[test]
    fn face_record_pixel_helpers_and_outcome_accessors() {
        let rec = FaceRecord {
            bounds: Rect::new(0.25, 0.5, 0.5, 0.25),
            landmarks: [Point::new(0.5, 0.5); 5],
            score: 0.9,
            embedding: Embedding(vec![1.0]),
        };
        let s = Size::new(200, 100);
        assert_eq!(rec.bounds_px(s), Rect::new(50.0, 50.0, 100.0, 25.0));
        assert_eq!(rec.landmarks_px(s)[0], Point::new(100.0, 50.0));
        let mut a = PhotoAnalysis {
            oriented_size: s,
            taken_at: NaiveDateTime::default(),
            date_source: DateSource::Exif,
            outcome: Outcome::Faces { faces: vec![rec] },
        };
        assert_eq!(a.faces().len(), 1);
        assert!(a.is_cacheable());
        for (kind, cacheable) in [
            (FailureKind::DecodeFailed, true),
            (FailureKind::UnsupportedFormat, true),
            (FailureKind::Io, false),
            (FailureKind::Internal, false),
        ] {
            let failed = PhotoAnalysis {
                outcome: Outcome::Failed {
                    kind,
                    message: String::new(),
                },
                ..a.clone()
            };
            assert_eq!(failed.is_cacheable(), cacheable, "{kind:?}");
        }
        a.outcome = Outcome::NoFace;
        assert!(a.faces().is_empty());
    }

    #[test]
    fn thumbnail_quality_rule_and_size() {
        let img = crate::decode::tests::pattern(800, 600);
        let small = encode_thumbnail(&img, 320).expect("thumb");
        let d = crate::decode::decode(&small, Path::new("t.jpg"), 1, DecodeTarget::Full)
            .expect("decode");
        assert_eq!(d.image.size(), Size::new(320, 240));
        let big = encode_thumbnail(&img, 1280).expect("thumb");
        let d =
            crate::decode::decode(&big, Path::new("t.jpg"), 1, DecodeTarget::Full).expect("decode");
        assert_eq!(d.image.size(), Size::new(800, 600));
    }
}
