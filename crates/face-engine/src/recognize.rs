//! SFace face recognition (OpenCV Zoo `face_recognition_sface_2021dec.onnx`).
//!
//! Re-implements OpenCV's `FaceRecognizerSF`:
//! - `alignCrop`: least-squares similarity from the 5 YuNet landmarks onto the
//!   standard 112×112 ArcFace template, bilinear warp, black border;
//! - `feature`: RGB, raw 0–255 floats, NCHW → 128-d vector;
//! - this crate additionally L2-normalizes so cosine similarity is a dot product.
//!
//! Aliasing guard: when the face is much larger than the template (scale
//! < 0.5), the source region is first downsampled with an antialiasing filter
//! so the bilinear warp never decimates by more than 1.25×.

use std::path::Path;

use serde::{Deserialize, Serialize};
use tract_onnx::prelude::*;

use crate::error::{EngineError, Result};
use crate::geometry::{Point, Rect, Similarity};
use crate::image::{Filter, RgbImage};
use crate::model::{self, PooledPlan};
use crate::warp;

/// Side of the SFace input crop.
pub const CROP_SIZE: u32 = 112;
/// Embedding dimensionality.
pub const EMBEDDING_DIM: usize = 128;

/// ArcFace 112×112 template, in anchor order (image-left eye first).
pub const ARCFACE_TEMPLATE: [Point; 5] = [
    Point::new(38.2946, 51.6963),
    Point::new(73.5318, 51.5014),
    Point::new(56.0252, 71.7366),
    Point::new(41.5493, 92.3655),
    Point::new(70.7299, 92.2041),
];

/// A 128-d L2-normalized face embedding.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Embedding(pub Vec<f32>);

impl Embedding {
    /// Normalizes `raw` to unit length (`None` for zero/non-finite vectors).
    #[must_use]
    pub fn normalized(raw: &[f32]) -> Option<Self> {
        let norm = raw.iter().map(|v| v * v).sum::<f32>().sqrt();
        if !(norm.is_finite() && norm > 0.0) {
            return None;
        }
        Some(Self(raw.iter().map(|v| v / norm).collect()))
    }

    /// Cosine similarity (dot product of unit vectors), in `[-1, 1]`.
    #[must_use]
    pub fn cosine(&self, other: &Self) -> f32 {
        if self.0.len() != other.0.len() {
            return 0.0;
        }
        self.0
            .iter()
            .zip(&other.0)
            .map(|(a, b)| a * b)
            .sum::<f32>()
            .clamp(-1.0, 1.0)
    }

    /// The raw components.
    #[must_use]
    pub fn as_slice(&self) -> &[f32] {
        &self.0
    }
}

/// The SFace recognizer. Shareable across threads.
pub struct Recognizer {
    plan: PooledPlan,
}

impl std::fmt::Debug for Recognizer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Recognizer").finish_non_exhaustive()
    }
}

impl Recognizer {
    /// Loads SFace from `path`.
    ///
    /// # Errors
    /// [`EngineError::Model`] if the file is missing or invalid.
    pub fn load(path: &Path) -> Result<Self> {
        let s = CROP_SIZE as usize;
        Ok(Self {
            plan: model::load_fixed(path, &[1, 3, s, s])?,
        })
    }

    /// Builds SFace from its (verified) file bytes.
    ///
    /// # Errors
    /// [`EngineError::Model`] if the bytes are not a valid model.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
        let s = CROP_SIZE as usize;
        Ok(Self {
            plan: model::load_fixed_bytes(model::SFACE_FILE, bytes, &[1, 3, s, s])?,
        })
    }

    /// Aligns the face given by `landmarks` (pixels of `img`) and embeds it.
    ///
    /// # Errors
    /// Inference failures or degenerate landmarks.
    pub fn embed(&self, img: &RgbImage, landmarks: &[Point; 5]) -> Result<Embedding> {
        let crop = align_crop(img, landmarks)?;
        self.embed_crop(&crop)
    }

    /// Embeds an already aligned 112×112 crop.
    ///
    /// # Errors
    /// Wrong crop size or inference failure.
    pub fn embed_crop(&self, crop: &RgbImage) -> Result<Embedding> {
        if crop.width() != CROP_SIZE || crop.height() != CROP_SIZE {
            return Err(EngineError::InvalidArgument(format!(
                "SFace needs a {CROP_SIZE}x{CROP_SIZE} crop, got {}x{}",
                crop.width(),
                crop.height()
            )));
        }
        let plane = (CROP_SIZE * CROP_SIZE) as usize;
        let mut data = vec![0f32; 3 * plane];
        for (i, px) in crop.as_raw().as_chunks::<3>().0.iter().enumerate() {
            data[i] = f32::from(px[0]);
            data[plane + i] = f32::from(px[1]);
            data[2 * plane + i] = f32::from(px[2]);
        }
        let s = CROP_SIZE as usize;
        let input = tract_ndarray::Array4::from_shape_vec((1, 3, s, s), data)
            .map(IntoTensor::into_tensor)
            .map_err(|e| EngineError::Internal(format!("SFace input tensor: {e}")))?;
        let outputs = self.plan.run(input)?;
        let raw = model::output_slice(&outputs, 0)?;
        if raw.len() != EMBEDDING_DIM {
            return Err(EngineError::Inference(format!(
                "SFace returned {} values, expected {EMBEDDING_DIM}",
                raw.len()
            )));
        }
        Embedding::normalized(raw)
            .ok_or_else(|| EngineError::Inference("SFace returned a zero embedding".into()))
    }
}

/// OpenCV-compatible `alignCrop`: warps the face onto the 112×112 template.
///
/// # Errors
/// [`EngineError::InvalidArgument`] for degenerate landmarks.
pub fn align_crop(img: &RgbImage, landmarks: &[Point; 5]) -> Result<RgbImage> {
    let t = Similarity::least_squares(landmarks, &ARCFACE_TEMPLATE, None)
        .ok_or_else(|| EngineError::InvalidArgument("degenerate face landmarks".into()))?;
    let scale = t.scale();
    if scale < 0.5 {
        // Antialias: shrink the region the crop samples from, then warp.
        if let Some(inv) = t.inverse() {
            let corners = [
                Point::new(0.0, 0.0),
                Point::new(f64::from(CROP_SIZE), 0.0),
                Point::new(0.0, f64::from(CROP_SIZE)),
                Point::new(f64::from(CROP_SIZE), f64::from(CROP_SIZE)),
            ]
            .map(|p| inv.apply(p));
            let region = Rect::bounding(&corners)
                .unwrap_or_default()
                .padded(0.02)
                .clipped(f64::from(img.width()), f64::from(img.height()));
            if region.width >= 2.0 && region.height >= 2.0 {
                return crop_resized(img, &region, &t, scale * 1.25);
            }
        }
    }
    Ok(warp::warp_bilinear(
        img,
        &t,
        CROP_SIZE,
        CROP_SIZE,
        [0, 0, 0],
    ))
}

fn crop_resized(img: &RgbImage, region: &Rect, t: &Similarity, factor: f64) -> Result<RgbImage> {
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let (x0, y0, x1, y1) = (
        region.x.floor() as u32,
        region.y.floor() as u32,
        region.right().ceil() as u32,
        region.bottom().ceil() as u32,
    );
    let roi = img.cropped(x0, y0, x1 - x0, y1 - y0);
    let dim = |v: u32| {
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let r = (f64::from(v) * factor).round().max(1.0) as u32;
        r
    };
    let small = roi.resized(dim(roi.width()), dim(roi.height()), Filter::Bilinear)?;
    let sx = f64::from(small.width()) / f64::from(roi.width());
    let sy = f64::from(small.height()) / f64::from(roi.height());
    // small px → roi px → img px → crop px.
    let to_img = Similarity::translation(f64::from(x0), f64::from(y0));
    let from_small = Similarity {
        a: 1.0 / sx.midpoint(sy),
        b: 0.0,
        tx: 0.0,
        ty: 0.0,
    };
    let full = from_small.then(&to_img).then(t);
    Ok(warp::warp_bilinear(
        &small,
        &full,
        CROP_SIZE,
        CROP_SIZE,
        [0, 0, 0],
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalization_and_cosine() {
        let e = Embedding::normalized(&[3.0, 4.0]).expect("norm");
        assert!((e.0[0] - 0.6).abs() < 1e-6 && (e.0[1] - 0.8).abs() < 1e-6);
        assert!((e.cosine(&e) - 1.0).abs() < 1e-6);
        let o = Embedding::normalized(&[-4.0, 3.0]).expect("norm");
        assert!(e.cosine(&o).abs() < 1e-6);
        let neg = Embedding::normalized(&[-3.0, -4.0]).expect("norm");
        assert!((e.cosine(&neg) + 1.0).abs() < 1e-6);
        assert!(Embedding::normalized(&[0.0, 0.0]).is_none());
        assert!(Embedding::normalized(&[f32::NAN, 1.0]).is_none());
        assert_eq!(e.cosine(&Embedding(vec![1.0])), 0.0);
        assert_eq!(e.as_slice().len(), 2);
    }

    fn template_scaled(s: f64, dx: f64, dy: f64) -> [Point; 5] {
        ARCFACE_TEMPLATE.map(|p| Point::new(p.x * s + dx, p.y * s + dy))
    }

    #[test]
    fn align_crop_of_template_aligned_face_is_identity() {
        let img = crate::decode::tests::pattern(112, 112);
        let crop = align_crop(&img, &ARCFACE_TEMPLATE).expect("crop");
        assert_eq!(crop.size(), crate::geometry::Size::new(112, 112));
        let diff: u32 = crop
            .as_raw()
            .iter()
            .zip(img.as_raw())
            .map(|(a, b)| u32::from(a.abs_diff(*b)))
            .max()
            .unwrap_or(0);
        assert!(diff <= 1, "max diff {diff}");
    }

    #[test]
    fn large_faces_use_the_antialiased_path() {
        // Face 4× the template size inside a 600×600 image.
        let img = crate::decode::tests::pattern(600, 600);
        let lm = template_scaled(4.0, 20.0, 10.0);
        let crop = align_crop(&img, &lm).expect("crop");
        assert_eq!(crop.width(), 112);
        // The crop samples the image's top-left red quadrant → red-ish top-left.
        let px = crop.pixel(10, 10).expect("px");
        assert!(px[0] > 150, "{px:?}");
        let direct = warp::warp_bilinear(
            &img,
            &Similarity::least_squares(&lm, &ARCFACE_TEMPLATE, None).expect("t"),
            112,
            112,
            [0, 0, 0],
        );
        // Both paths agree on smooth content.
        let mean_diff = crop
            .as_raw()
            .iter()
            .zip(direct.as_raw())
            .map(|(a, b)| f64::from(a.abs_diff(*b)))
            .sum::<f64>()
            / (112.0 * 112.0 * 3.0);
        assert!(mean_diff < 6.0, "{mean_diff}");
    }

    #[test]
    fn degenerate_landmarks_are_rejected() {
        let img = RgbImage::new(10, 10);
        let same = [Point::new(5.0, 5.0); 5];
        assert!(align_crop(&img, &same).is_err());
    }
}
