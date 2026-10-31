//! Deterministic test engine. Behavior is driven by file names so tests can
//! build libraries with real (tiny) JPEGs:
//!
//! | name contains | outcome |
//! |---|---|
//! | `broken` | `Failed(decodeFailed)` |
//! | `noface` | `NoFace` |
//! | `other` | one face, orthogonal embedding → rejected |
//! | `unsure` | one face, cos 0.3 → uncertain |
//! | `twofaces` | a larger stranger + the subject → matched face 1 |
//! | anything else | the subject → confirmed |
//!
//! Dates come from `YYYYMMDD[_HHMMSS]` in the name (else 2020-01-01 noon).
//! The reference "face" sits at the center of the rotated reference image.
//! Only the model-backed operations are faked; everything else the shell
//! calls is the real `face-engine`.

use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use chrono::{NaiveDate, NaiveDateTime};
use face_engine as fe;
use face_engine::align::{FrameRequest, RenderedFrame};
use face_engine::analysis::{
    AnalysisOutput, FaceRecord, FailureKind, Outcome, PhotoAnalysis, PhotoAnalyzer,
};
use face_engine::dates::DateSource;
use face_engine::frames::FrameRenderer;
use face_engine::geometry::{Point, Rect, Similarity, Size};
use face_engine::image::RgbImage;
use face_engine::recognize::Embedding;
use face_engine::reference::{FaceGeometry, ReferenceDetection, ReferenceInfo};

use super::Engine;
use crate::error::{AppResult, from_engine};
use crate::ipc::IpcError;

pub const DIM: usize = 128;

/// Unit vector along axis `i`.
pub fn axis(i: usize) -> Vec<f32> {
    let mut v = vec![0.0; DIM];
    v[i] = 1.0;
    v
}

fn unsure() -> Vec<f32> {
    let mut v = vec![0.0; DIM];
    v[0] = 0.3;
    v[1] = (1.0f32 - 0.09).sqrt();
    v
}

const LANDMARKS: [[f64; 2]; 5] = [[0.4, 0.4], [0.6, 0.4], [0.5, 0.5], [0.42, 0.6], [0.58, 0.6]];

fn face(embedding: Vec<f32>, [x, y, w, h]: [f64; 4]) -> FaceRecord {
    FaceRecord {
        bounds: Rect::new(x, y, w, h),
        landmarks: LANDMARKS.map(|[x, y]| Point::new(x, y)),
        score: 0.95,
        embedding: Embedding(embedding),
    }
}

/// Face statistics every fake frame reports.
pub const FRAME_STATS: [f32; 6] = [0.6, 0.01, 0.02, 0.1, 0.02, 0.02];

/// Test double for [`Engine`].
#[derive(Default)]
pub struct FakeEngine {
    pub analyze_calls: AtomicUsize,
    pub render_calls: AtomicUsize,
    /// When set, `load_models` fails with `modelUnavailable`.
    pub models_missing: AtomicBool,
    /// Milliseconds each analysis sleeps (cancel tests).
    pub analyze_delay_ms: AtomicUsize,
    /// Milliseconds each frame render sleeps (coalescing tests).
    pub render_delay_ms: AtomicUsize,
    /// Runs inside `fingerprint()` — which loading a library calls after the
    /// folder walk — so tests can pause or panic there.
    fingerprint_hook: parking_lot::Mutex<Option<FingerprintHook>>,
}

/// See [`FakeEngine::set_fingerprint_hook`].
pub type FingerprintHook = std::sync::Arc<dyn Fn() + Send + Sync>;

impl FakeEngine {
    pub fn new() -> Self {
        Self::default()
    }

    /// Installs (or with `None` removes) the `fingerprint()` hook.
    pub fn set_fingerprint_hook(&self, hook: Option<FingerprintHook>) {
        *self.fingerprint_hook.lock() = hook;
    }
}

/// Parses `YYYYMMDD[_HHMMSS]` from a file name.
pub fn date_from_name(name: &str) -> Option<NaiveDateTime> {
    let bytes = name.as_bytes();
    (0..bytes.len().saturating_sub(7)).find_map(|i| {
        let digits = name.get(i..i + 8)?;
        if !digits.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        let date = NaiveDate::parse_from_str(digits, "%Y%m%d").ok()?;
        let time = name
            .get(i + 9..i + 15)
            .and_then(|t| chrono::NaiveTime::parse_from_str(t, "%H%M%S").ok())
            .unwrap_or_else(|| chrono::NaiveTime::from_hms_opt(12, 0, 0).unwrap_or_default());
        Some(date.and_time(time))
    })
}

impl PhotoAnalyzer for FakeEngine {
    fn fingerprint(&self) -> String {
        let hook = self.fingerprint_hook.lock().clone();
        if let Some(hook) = hook {
            hook();
        }
        "fake-engine-1".into()
    }

    fn analyze(&self, path: &Path, _mtime_ns: i64, thumb_width: Option<u32>) -> AnalysisOutput {
        self.analyze_calls.fetch_add(1, Ordering::Relaxed);
        let delay = self.analyze_delay_ms.load(Ordering::Relaxed);
        if delay > 0 {
            std::thread::sleep(std::time::Duration::from_millis(delay as u64));
        }
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let (taken_at, date_source) = date_from_name(&name).map_or_else(
            || {
                let d = NaiveDate::from_ymd_opt(2020, 1, 1).and_then(|d| d.and_hms_opt(12, 0, 0));
                (d.unwrap_or_default(), DateSource::FileTime)
            },
            |d| (d, DateSource::Filename),
        );
        let decoded = if name.contains("broken") {
            None
        } else {
            fe::decode::decode_file(path, fe::decode::DecodeTarget::Full).ok()
        };
        let Some(img) = decoded.map(|d| d.image) else {
            return AnalysisOutput {
                analysis: PhotoAnalysis {
                    oriented_size: Size::default(),
                    taken_at,
                    date_source,
                    outcome: Outcome::Failed {
                        kind: FailureKind::DecodeFailed,
                        message: "fake decode failure".into(),
                    },
                },
                thumbnail: None,
            };
        };
        let faces = if name.contains("noface") {
            None
        } else if name.contains("twofaces") {
            Some(vec![
                face(axis(2), [0.0, 0.0, 0.6, 0.6]),
                face(axis(0), [0.6, 0.6, 0.3, 0.3]),
            ])
        } else if name.contains("other") {
            Some(vec![face(axis(1), [0.3, 0.3, 0.4, 0.4])])
        } else if name.contains("unsure") {
            Some(vec![face(unsure(), [0.3, 0.3, 0.4, 0.4])])
        } else {
            Some(vec![face(axis(0), [0.3, 0.3, 0.4, 0.4])])
        };
        AnalysisOutput {
            analysis: PhotoAnalysis {
                oriented_size: img.size(),
                taken_at,
                date_source,
                outcome: faces.map_or(Outcome::NoFace, |faces| Outcome::Faces { faces }),
            },
            thumbnail: thumb_width.and_then(|w| fe::analysis::encode_thumbnail(&img, w).ok()),
        }
    }
}

impl FrameRenderer for FakeEngine {
    fn render(&self, request: &FrameRequest<'_>) -> fe::Result<RenderedFrame> {
        self.render_calls.fetch_add(1, Ordering::Relaxed);
        let delay = self.render_delay_ms.load(Ordering::Relaxed);
        if delay > 0 {
            std::thread::sleep(std::time::Duration::from_millis(delay as u64));
        }
        if request.source.to_string_lossy().contains("renderfail") {
            return Err(fe::EngineError::decode(
                request.source,
                "fake render failure",
            ));
        }
        std::fs::metadata(request.source)
            .map_err(|e| fe::EngineError::io(format!("reading {}", request.source.display()), e))?;
        let shade = (fe::walk::photo_id(request.source).as_bytes()[0] % 200) + 30;
        let out = request.target.size;
        Ok(RenderedFrame {
            image: RgbImage::filled(out.width, out.height, [shade, 100, 160]),
            residual_px: 0.5 + request.adjust.dx.abs(),
            face_stats: Some(fe::color::FaceStats::from_array(FRAME_STATS)),
            transform: Similarity::IDENTITY,
            source_anchors: [Point::default(); 5],
            refined: false,
        })
    }
}

impl Engine for FakeEngine {
    /// `None` with [`FakeEngine::models_missing`], like model files that are gone.
    fn fingerprint(&self) -> Option<String> {
        (!self.models_missing.load(Ordering::Relaxed)).then(|| PhotoAnalyzer::fingerprint(self))
    }

    fn models_ready(&self) -> bool {
        !self.models_missing.load(Ordering::Relaxed)
    }

    fn load_models(&self) -> AppResult<()> {
        if self.models_missing.load(Ordering::Relaxed) {
            Err(IpcError::model_unavailable())
        } else {
            Ok(())
        }
    }

    fn analyzer(&self) -> AppResult<&dyn PhotoAnalyzer> {
        self.load_models()?;
        Ok(self)
    }

    fn renderer(&self) -> AppResult<&dyn FrameRenderer> {
        self.load_models()?;
        Ok(self)
    }

    /// Like [`FrameRenderer::render`], with or without the models.
    fn render_preview(&self, request: &FrameRequest<'_>) -> AppResult<RenderedFrame> {
        FrameRenderer::render(self, request).map_err(|e| from_engine(&e))
    }

    fn reference(&self, path: &Path, rotation_deg: f64) -> AppResult<ReferenceInfo> {
        self.load_models()?;
        super::check_photo_path(path)?;
        let img = fe::reference::rotated_image(path, rotation_deg).map_err(|e| from_engine(&e))?;
        let noface = path.to_string_lossy().contains("noface");
        Ok(ReferenceInfo {
            size: img.size(),
            face: (!noface).then(|| FaceGeometry {
                bounds: Rect::new(0.4, 0.35, 0.2, 0.3),
                anchors: [
                    [0.45, 0.45],
                    [0.55, 0.45],
                    [0.5, 0.5],
                    [0.46, 0.56],
                    [0.54, 0.56],
                ]
                .map(|[x, y]| Point::new(x, y)),
                confidence: 0.97,
            }),
            auto_rotation_deg: (!noface).then_some(1.5),
        })
    }

    fn reference_crop(
        &self,
        path: &Path,
        rotation_deg: f64,
        crop: Rect,
    ) -> AppResult<Option<ReferenceDetection>> {
        let info = self.reference(path, rotation_deg)?;
        let (w, h) = (f64::from(info.size.width), f64::from(info.size.height));
        let (cx, cy) = (w / 2.0, h / 2.0);
        let inside =
            crop.x <= cx && cy >= crop.y && cx <= crop.x + crop.width && cy <= crop.y + crop.height;
        if info.face.is_none() || !inside {
            return Ok(None);
        }
        let norm =
            |x: f64, y: f64| Point::new((x - crop.x) / crop.width, (y - crop.y) / crop.height);
        let d = w.min(h) * 0.05;
        let anchors = [
            norm(cx - d, cy - d),
            norm(cx + d, cy - d),
            norm(cx, cy),
            norm(cx - d * 0.8, cy + d),
            norm(cx + d * 0.8, cy + d),
        ];
        Ok(Some(ReferenceDetection {
            anchors,
            face_box: Rect::new(anchors[0].x - 0.05, anchors[0].y - 0.05, 0.3, 0.3),
            confidence: 0.96,
            embedding: Embedding(axis(0)),
        }))
    }
}

/// Writes a small real JPEG for tests (a soft gradient, so look statistics
/// have some spread).
pub fn write_jpeg(path: &Path, w: u32, h: u32, shade: u8) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("mkdir");
    }
    let mut img = RgbImage::filled(w, h, [shade, shade / 2, 90]);
    let stride = img.stride();
    for (i, v) in img.as_raw_mut().iter_mut().enumerate() {
        let x = (i % stride) / 3;
        *v = v.saturating_add(u8::try_from(x * 16 / w.max(1) as usize).unwrap_or(0));
    }
    std::fs::write(
        path,
        fe::encode::jpeg_with(&img, 85, fe::encode::Chroma::Subsampled).expect("jpeg"),
    )
    .expect("write jpeg");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn date_parsing_from_names() {
        let d = date_from_name("IMG_20140815_142326.jpg").expect("date");
        assert_eq!(d.to_string(), "2014-08-15 14:23:26");
        let d = date_from_name("20120901.jpg").expect("date only");
        assert_eq!(d.to_string(), "2012-09-01 12:00:00");
        assert!(date_from_name("IMG_1234.jpg").is_none());
    }

    #[test]
    fn outcomes_follow_names() {
        let dir = tempfile::tempdir().expect("tempdir");
        let e = FakeEngine::new();
        let mk = |n: &str| {
            let p = dir.path().join(n);
            write_jpeg(&p, 32, 24, 100);
            p
        };
        let a = e.analyze(&mk("20140101.jpg"), 0, Some(16));
        assert_eq!(a.analysis.faces().len(), 1);
        assert_eq!(a.analysis.oriented_size, Size::new(32, 24));
        assert!(a.thumbnail.is_some());
        assert_eq!(
            e.analyze(&mk("noface.jpg"), 0, None).analysis.outcome,
            Outcome::NoFace
        );
        assert!(matches!(
            e.analyze(&mk("broken.jpg"), 0, None).analysis.outcome,
            Outcome::Failed { .. }
        ));
        assert_eq!(
            e.analyze(&mk("twofaces.jpg"), 0, None)
                .analysis
                .faces()
                .len(),
            2
        );
        let u = e.analyze(&mk("unsure.jpg"), 0, None);
        let (m, _) = fe::scan::match_photo(
            &u.analysis,
            &Embedding(axis(0)),
            &fe::matching::Calibration::default(),
        );
        let s = m.expect("match").score;
        assert!((0.4..0.6).contains(&s), "{s}");
        assert_eq!(e.analyze_calls.load(Ordering::Relaxed), 5);
        assert_eq!(Engine::fingerprint(&e).as_deref(), Some("fake-engine-1"));
        e.models_missing.store(true, Ordering::Relaxed);
        assert_eq!(Engine::fingerprint(&e), None, "no models, no fingerprint");
    }
}
