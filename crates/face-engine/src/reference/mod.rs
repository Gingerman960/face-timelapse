//! Reference photo setup (LEGACY-SPEC §3.1/§4.7, ARCHITECTURE §9.3).
//!
//! - The reference is decoded at full resolution, EXIF-oriented and rotated
//!   clockwise by `rotation_deg` onto an expanded canvas with black corners
//!   (legacy "Align Face" = sharp `rotate(angle)`).
//! - Crops live in pixels of that rotated image; aspect presets follow the
//!   legacy `computeARCrop` / "Center Face" math.
//! - The face inside the crop is detected with the crop downscaled to a long
//!   edge ≤ 1280 (largest face), then embedded with SFace.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::analysis::Analyzer;
use crate::decode::{self, DecodeTarget};
use crate::detect::Detection;
use crate::error::{EngineError, Result};
use crate::geometry::{Point, Rect, Similarity, Size};
use crate::image::{Filter, RgbImage};
use crate::recognize::Embedding;
use crate::warp;

mod crop;
mod landmarks;

pub use crop::{
    ASPECT_TOLERANCE, AspectPreset, CROP_TOLERANCE_PX, CropProblem, MIN_CROP_PX, aspect_crop,
    center_on_face, check_crop, clamp_box, default_crop, rotate_crop, snap_crop, validate_crop,
};
use landmarks::{MAIN_FACE_IOU, MainFace, cached_photo_face};
pub use landmarks::{ensemble_detection, level_rotation};

/// Rotation (degrees, clockwise) that levels the eyes: `−atan2(dy, dx)`.
#[must_use]
pub fn eye_level_angle(left_eye: Point, right_eye: Point) -> f64 {
    let (dx, dy) = (right_eye.x - left_eye.x, right_eye.y - left_eye.y);
    -dy.atan2(dx).to_degrees()
}

/// Version of the reference analysis (levelling angle, main-face landmarks
/// and embedding). Bumped whenever it changes so stored analyses are redone;
/// 2 = framing ensemble measured on the unrotated photo (one-press levelling,
/// matching independent of the crop and the rotation).
pub const REFERENCE_VERSION: u32 = 2;

/// Legacy straighten threshold: smaller angles are not applied.
pub const LEVEL_THRESHOLD_DEG: f64 = 0.3;

/// Largest reference rotation either way (degrees).
pub const MAX_ROTATION_DEG: f64 = 45.0;

/// True for a finite rotation within ±[`MAX_ROTATION_DEG`].
#[must_use]
pub fn rotation_ok(rotation_deg: f64) -> bool {
    rotation_deg.is_finite() && rotation_deg.abs() <= MAX_ROTATION_DEG
}

/// Decodes `path` (EXIF orientation) and rotates it clockwise by
/// `rotation_deg` onto an expanded canvas with black corners — the image
/// reference crops are expressed in. No models needed.
///
/// # Errors
/// I/O, unsupported format or decode errors; an out-of-range rotation is an
/// invalid argument.
pub fn rotated_image(path: &Path, rotation_deg: f64) -> Result<RgbImage> {
    if !rotation_ok(rotation_deg) {
        return Err(EngineError::InvalidArgument(
            "rotation must be between -45° and 45°".into(),
        ));
    }
    let mut decoded = decode::decode_file(path, DecodeTarget::Full)?;
    Ok(if rotation_deg.abs() > 0.01 {
        // The rotation runs in parallel: give the decode budget back first.
        decoded.release_budget();
        warp::rotate_expand(&decoded.image, rotation_deg).0
    } else {
        decoded.image
    })
}

/// `crop` (pixels of `image`, clipped to it) resized to `out` with independent
/// axes — the reference frame used as onion-skin base and for the look's
/// reference statistics.
///
/// # Errors
/// An empty crop or output size.
pub fn crop_frame(image: &RgbImage, crop: Rect, out: Size) -> Result<RgbImage> {
    crop_of(image, crop)?.resized(out.width, out.height, Filter::CatmullRom)
}

fn crop_of(image: &RgbImage, crop: Rect) -> Result<RgbImage> {
    let c = crop.clipped(f64::from(image.width()), f64::from(image.height()));
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let (x, y, w, h) = (
        c.x.round() as u32,
        c.y.round() as u32,
        c.width.round() as u32,
        c.height.round() as u32,
    );
    if w == 0 || h == 0 {
        return Err(EngineError::InvalidArgument("the crop is empty".into()));
    }
    Ok(image.cropped(x, y, w, h))
}

/// A face normalized to `[0, 1]` of some image.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FaceGeometry {
    /// Face box.
    pub bounds: Rect,
    /// `[leftEye, rightEye, noseTip, mouthLeft, mouthRight]`.
    pub anchors: [Point; 5],
    /// Detector confidence.
    pub confidence: f64,
}

impl FaceGeometry {
    fn from_detection(d: &Detection, size: Size) -> Self {
        let (sx, sy) = (1.0 / f64::from(size.width), 1.0 / f64::from(size.height));
        let n = d.scaled(sx, sy);
        Self {
            bounds: n.bounds,
            anchors: n.landmarks,
            confidence: f64::from(d.score),
        }
    }
}

/// What is known about a loaded reference without its pixels (cacheable).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceInfo {
    /// Pixel size after orientation and rotation (crop space).
    pub size: Size,
    /// Largest face on the whole rotated image (normalized to it).
    pub face: Option<FaceGeometry>,
    /// Absolute rotation that would level the eyes of `face`.
    pub auto_rotation_deg: Option<f64>,
}

/// The face inside the reference crop.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceDetection {
    /// Anchors normalized to the crop.
    pub anchors: [Point; 5],
    /// Face box normalized to the crop.
    pub face_box: Rect,
    /// Detector confidence.
    pub confidence: f64,
    /// SFace embedding.
    pub embedding: Embedding,
}

/// Long edge used to find the face on the whole reference image.
pub const WHOLE_IMAGE_DETECT_EDGE: u32 = 1024;
/// Maximum long edge of the crop when detecting the reference face.
pub const CROP_DETECT_EDGE: u32 = 1280;

/// A decoded, oriented and rotated reference photo kept in memory so crop
/// changes only re-run detection.
#[derive(Debug, Clone)]
pub struct ReferenceImage {
    path: PathBuf,
    rotation_deg: f64,
    image: RgbImage,
    face: Option<FaceGeometry>,
    auto_rotation_deg: Option<f64>,
    /// The main face, measured once per photo on the unrotated photo.
    main: Option<MainFace>,
    /// Unrotated → rotated pixels.
    to_rotated: Similarity,
}

impl ReferenceImage {
    /// Decodes `path` (EXIF orientation), rotates it by `rotation_deg`
    /// (clockwise, expanded canvas) and finds the largest face on the whole
    /// rotated image at ≤ 1024 px.
    ///
    /// # Errors
    /// I/O, unsupported format, decode or inference errors; an out-of-range
    /// rotation (|r| > 45°) is an invalid argument.
    pub fn load(analyzer: &Analyzer, path: &Path, rotation_deg: f64) -> Result<Self> {
        if !rotation_ok(rotation_deg) {
            return Err(EngineError::InvalidArgument(
                "rotation must be between -45° and 45°".into(),
            ));
        }
        // The unrotated photo: the levelling angle is measured on it, so it
        // is the same whatever rotation is applied now (one `L` press).
        let source = decode::decode_file(path, DecodeTarget::Full)?.into_image();
        let photo = cached_photo_face(analyzer, path, &source)?;
        let (image, to_rotated) = if rotation_deg.abs() > 0.01 {
            warp::rotate_expand(&source, rotation_deg)
        } else {
            (source, Similarity::IDENTITY)
        };
        let small = image.fit_within(WHOLE_IMAGE_DETECT_EDGE, Filter::Bilinear)?;
        let face_det = detect_largest(analyzer, &small)?;
        let face = face_det.map(|d| FaceGeometry::from_detection(&d, small.size()));
        Ok(Self {
            path: path.to_path_buf(),
            rotation_deg,
            image,
            face,
            auto_rotation_deg: photo.level,
            main: photo.main,
            to_rotated,
        })
    }

    /// Source path.
    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Applied rotation (degrees, clockwise).
    #[must_use]
    pub fn rotation_deg(&self) -> f64 {
        self.rotation_deg
    }

    /// Pixel size after orientation and rotation (crop space).
    #[must_use]
    pub fn size(&self) -> Size {
        self.image.size()
    }

    /// The rotated full-resolution image.
    #[must_use]
    pub fn image(&self) -> &RgbImage {
        &self.image
    }

    /// Largest face on the whole rotated image (normalized to it).
    #[must_use]
    pub fn face(&self) -> Option<FaceGeometry> {
        self.face
    }

    /// Absolute rotation (degrees, clockwise, relative to the EXIF-oriented
    /// photo) that would level the eyes of [`ReferenceImage::face`].
    #[must_use]
    pub fn auto_rotation_deg(&self) -> Option<f64> {
        self.auto_rotation_deg
    }

    /// The eyes' remaining tilt on this (rotated) image, in degrees, measured
    /// like [`level_rotation`] (refined landmarks of the whole-image face);
    /// `None` without a face.
    ///
    /// # Errors
    /// Inference failures.
    pub fn eye_tilt_deg(&self, analyzer: &Analyzer) -> Result<Option<f64>> {
        let Some(face) = self.face else {
            return Ok(None);
        };
        let s = self.size();
        let bounds = face.bounds.scaled(f64::from(s.width), f64::from(s.height));
        Ok(ensemble_detection(analyzer, &self.image, bounds)?
            .map(|d| eye_level_angle(d.landmarks[0], d.landmarks[1])))
    }

    /// A detection on the unrotated photo, in this (rotated) image's pixels.
    fn rotated(&self, d: &Detection) -> Detection {
        let t = &self.to_rotated;
        let c = t.apply(d.bounds.center());
        let (w, h) = (d.bounds.width * t.scale(), d.bounds.height * t.scale());
        Detection {
            bounds: Rect::new(c.x - w / 2.0, c.y - h / 2.0, w, h),
            landmarks: d.landmarks.map(|p| t.apply(p)),
            score: d.score,
        }
    }

    /// Size, whole-image face and auto-rotation (no pixels).
    #[must_use]
    pub fn info(&self) -> ReferenceInfo {
        ReferenceInfo {
            size: self.size(),
            face: self.face,
            auto_rotation_deg: self.auto_rotation_deg,
        }
    }

    /// Detects the largest face inside `crop` (pixels of the rotated image)
    /// and embeds it. `Ok(None)` when no face is found.
    ///
    /// # Errors
    /// Invalid crops, inference failures.
    pub fn detect_crop(
        &self,
        analyzer: &Analyzer,
        crop: Rect,
    ) -> Result<Option<ReferenceDetection>> {
        let roi = self.crop_image(crop)?;
        let work = roi.fit_within(CROP_DETECT_EDGE, Filter::Bilinear)?;
        // The crop only chooses *which* face; its landmarks and embedding are
        // taken on the full-resolution image, so they do not depend on how
        // large the crop is (matching must not change with the output crop).
        let Some(found) = detect_largest(analyzer, &work)? else {
            return Ok(None);
        };
        let c = crop.clipped(
            f64::from(self.image.width()),
            f64::from(self.image.height()),
        );
        let (ox, oy) = (c.x.round(), c.y.round());
        let k = f64::from(roi.width()) / f64::from(work.width().max(1));
        let found = found.scaled(k, k).translated(ox, oy);
        // The main face (the crop's usual subject) always gets the same
        // landmarks and embedding, measured once on the unrotated photo, so
        // matching and anchors move with neither the crop nor the rotation.
        // Another face gets its own ensemble on this image. Both use the TTA
        // refinement aligned frames use (no systematic anchor offset).
        let main = self.main.as_ref().map(|m| (self.rotated(&m.detection), m));
        let (det, embedding) = match main {
            Some((d, m)) if d.bounds.iou(&found.bounds) >= MAIN_FACE_IOU => {
                (d, m.embedding.clone())
            }
            _ => {
                let d = ensemble_detection(analyzer, &self.image, found.bounds)?.unwrap_or(found);
                let e = analyzer.recognizer().embed(&self.image, &d.landmarks)?;
                (d, e)
            }
        };
        let det = Detection {
            score: found.score,
            ..det
        };
        let n = FaceGeometry::from_detection(&det.translated(-ox, -oy), roi.size());
        Ok(Some(ReferenceDetection {
            anchors: n.anchors,
            face_box: n.bounds,
            confidence: n.confidence,
            embedding,
        }))
    }

    /// The crop resized to `out` (independent axes) — the reference frame
    /// used as onion-skin base and for the look's reference statistics.
    ///
    /// # Errors
    /// Invalid crops or sizes.
    pub fn render_frame(&self, crop: Rect, out: Size) -> Result<RgbImage> {
        crop_frame(&self.image, crop, out)
    }

    fn crop_image(&self, crop: Rect) -> Result<RgbImage> {
        crop_of(&self.image, crop)
    }
}

/// Largest face, trying the working size first and then smaller sizes
/// (YuNet misses faces that are very large relative to its input).
fn detect_largest(analyzer: &Analyzer, img: &RgbImage) -> Result<Option<Detection>> {
    // Square letterboxed inputs with edges rounded to 128 px bound the number
    // of optimized plans however the user drags the crop.
    let long = img.size().long_edge().max(1);
    let first = long.div_ceil(128).saturating_mul(128).min(CROP_DETECT_EDGE);
    let mut edges = vec![first];
    edges.extend([640, 320].into_iter().filter(|&e| e < first));
    for edge in edges {
        let faces = analyzer.detector().detect_square(img, edge)?;
        if let Some(d) = faces.into_iter().next() {
            return Ok(Some(d));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pure_rotation_and_crop_frames() {
        let dir = tempfile::tempdir().expect("tmp");
        let p = dir.path().join("r.jpg");
        std::fs::write(
            &p,
            crate::decode::tests::jpeg_bytes(&crate::decode::tests::pattern(64, 48)),
        )
        .expect("write");
        let plain = rotated_image(&p, 0.0).expect("plain");
        assert_eq!(plain.size(), Size::new(64, 48));
        let rotated = rotated_image(&p, 10.0).expect("rotated");
        assert_eq!(rotated.size(), warp::rotated_size(Size::new(64, 48), 10.0));
        assert!(rotated_image(&p, 50.0).is_err());
        assert!(rotated_image(&dir.path().join("none.jpg"), 0.0).is_err());
        let f =
            crop_frame(&plain, Rect::new(8.0, 8.0, 32.0, 24.0), Size::new(64, 48)).expect("frame");
        assert_eq!(f.size(), Size::new(64, 48));
        assert!(crop_frame(&plain, Rect::new(100.0, 100.0, 10.0, 10.0), Size::new(8, 8)).is_err());
    }

    #[test]
    fn eye_level_angle_follows_legacy_sign() {
        // Right eye lower than left → clockwise tilt → negative correction.
        let a = eye_level_angle(Point::new(0.0, 0.0), Point::new(10.0, 10.0));
        assert!((a + 45.0).abs() < 1e-9);
        assert!(eye_level_angle(Point::new(0.0, 5.0), Point::new(10.0, 5.0)).abs() < 1e-12);
    }
}
