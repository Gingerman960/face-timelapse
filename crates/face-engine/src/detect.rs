//! YuNet face detection (OpenCV Zoo `face_detection_yunet_2023mar.onnx`).
//!
//! Pre/post-processing re-implements OpenCV's `FaceDetectorYN`:
//! - input: BGR, raw 0–255 floats, NCHW, zero-padded bottom/right to a
//!   multiple of 32;
//! - outputs (in order): `cls_{8,16,32}`, `obj_{8,16,32}`, `bbox_{8,16,32}`,
//!   `kps_{8,16,32}`; per grid cell `score = sqrt(clamp(cls)·clamp(obj))`,
//!   `cx = (col + dx)·s`, `w = exp(dw)·s`, landmarks `(col + kx)·s`;
//! - greedy NMS on IoU.
//!
//! Landmark order is YuNet's: subject's right eye, left eye, nose tip, right
//! mouth corner, left mouth corner — i.e. image-left first for a frontal,
//! non-mirrored face, which is the anchor order used everywhere
//! (`[leftEye, rightEye, noseTip, mouthLeft, mouthRight]`, image left/right).

use std::path::Path;

use serde::{Deserialize, Serialize};
use tract_onnx::prelude::*;

use crate::error::{EngineError, Result};
use crate::geometry::{Point, Rect, Size};
use crate::image::{Filter, RgbImage};
use crate::model::{self, ShapedModel};

/// Strides of YuNet's three detection heads.
const STRIDES: [usize; 3] = [8, 16, 32];
/// Scan inputs are padded to a multiple of this (few distinct plan shapes).
const SCAN_PAD: usize = 128;

/// Input sizes are padded to a multiple of this.
const PAD: usize = 32;

/// Detector parameters (ARCHITECTURE §9.3 defaults).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectorConfig {
    /// Long edge (px) the image is resized to before detection.
    pub input_long_edge: u32,
    /// Minimum detection score.
    pub score_threshold: f32,
    /// NMS IoU threshold.
    pub nms_iou: f32,
    /// Maximum detections kept after NMS.
    pub top_k: usize,
    /// Faces whose short side is below this many pixels *at 640 px* are dropped.
    pub min_face_px_at_640: f32,
    /// Keep at most this many faces (largest first).
    pub max_faces: usize,
    /// Drop faces whose area is below this fraction of the largest face.
    pub min_area_ratio: f32,
}

impl Default for DetectorConfig {
    fn default() -> Self {
        Self {
            input_long_edge: 640,
            score_threshold: 0.6,
            nms_iou: 0.3,
            top_k: 50,
            min_face_px_at_640: 24.0,
            max_faces: 3,
            min_area_ratio: 0.10,
        }
    }
}

/// One detected face, in pixels of the image passed to the detector.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Detection {
    /// Face box.
    pub bounds: Rect,
    /// `[leftEye, rightEye, noseTip, mouthLeft, mouthRight]` (image left/right).
    pub landmarks: [Point; 5],
    /// Detector confidence (0–1).
    pub score: f32,
}

impl Detection {
    /// Scales coordinates by `(sx, sy)`.
    #[must_use]
    pub fn scaled(&self, sx: f64, sy: f64) -> Self {
        Self {
            bounds: self.bounds.scaled(sx, sy),
            landmarks: self.landmarks.map(|p| p.scaled(sx, sy)),
            score: self.score,
        }
    }

    /// Translates coordinates by `(dx, dy)`.
    #[must_use]
    pub fn translated(&self, dx: f64, dy: f64) -> Self {
        let mut b = self.bounds;
        b.x += dx;
        b.y += dy;
        Self {
            bounds: b,
            landmarks: self.landmarks.map(|p| Point::new(p.x + dx, p.y + dy)),
            score: self.score,
        }
    }

    /// The detection expressed in the un-mirrored image when it was found in
    /// a horizontally mirrored copy of width `width` (left/right anchors swap).
    #[must_use]
    pub fn unmirrored(&self, width: f64) -> Self {
        let m = |p: Point| Point::new(width - p.x, p.y);
        let l = self.landmarks;
        Self {
            bounds: Rect::new(
                width - self.bounds.right(),
                self.bounds.y,
                self.bounds.width,
                self.bounds.height,
            ),
            landmarks: [m(l[1]), m(l[0]), m(l[2]), m(l[4]), m(l[3])],
            score: self.score,
        }
    }

    /// Distance between the two eye anchors.
    #[must_use]
    pub fn eye_distance(&self) -> f64 {
        self.landmarks[0].distance(self.landmarks[1])
    }
}

/// The YuNet detector. Shareable across threads.
pub struct Detector {
    model: ShapedModel,
    config: DetectorConfig,
}

impl std::fmt::Debug for Detector {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Detector")
            .field("config", &self.config)
            .finish_non_exhaustive()
    }
}

impl Detector {
    /// Loads YuNet from `path`.
    ///
    /// # Errors
    /// [`EngineError::Model`] if the file is missing or invalid.
    pub fn load(path: &Path, config: DetectorConfig) -> Result<Self> {
        Self::with_model(model::load_shaped(path)?, config)
    }

    /// Builds YuNet from its (verified) file bytes.
    ///
    /// # Errors
    /// [`EngineError::Model`] if the bytes are not a valid model.
    pub fn from_bytes(bytes: &[u8], config: DetectorConfig) -> Result<Self> {
        Self::with_model(model::load_shaped_bytes(model::YUNET_FILE, bytes)?, config)
    }

    fn with_model(model: model::ShapedModel, config: DetectorConfig) -> Result<Self> {
        let detector = Self { model, config };
        // Build the plan for the most common scan shape eagerly (4:3).
        let s = config.input_long_edge as usize;
        let coarse = |v: usize| v.max(1).div_ceil(SCAN_PAD) * SCAN_PAD;
        detector.model.plan(coarse(s * 3 / 4), coarse(s))?;
        Ok(detector)
    }

    /// Active configuration.
    #[must_use]
    pub fn config(&self) -> &DetectorConfig {
        &self.config
    }

    /// Detects faces after resizing `img` so its long edge equals
    /// [`DetectorConfig::input_long_edge`]. Coordinates are in `img` pixels;
    /// results are filtered (§9.3) and sorted largest first.
    ///
    /// # Errors
    /// Inference failures.
    pub fn detect(&self, img: &RgbImage) -> Result<Vec<Detection>> {
        self.detect_at(img, self.config.input_long_edge)
    }

    /// Like [`Detector::detect`] with an explicit working long edge.
    ///
    /// # Errors
    /// Inference failures.
    pub fn detect_at(&self, img: &RgbImage, long_edge: u32) -> Result<Vec<Detection>> {
        if img.size().is_empty() {
            return Ok(Vec::new());
        }
        let work = resize_to_long_edge(img, long_edge)?;
        // Coarse padding (multiples of SCAN_PAD) keeps the number of distinct
        // network shapes — one optimized plan each — small across a library
        // of mixed aspect ratios. Padding is zero below/right: results match.
        let (w, h) = (work.width() as usize, work.height() as usize);
        let coarse = |v: usize| v.max(1).div_ceil(SCAN_PAD) * SCAN_PAD;
        let raw = self.run_network_padded(&work, coarse(w), coarse(h))?;
        let sx = f64::from(img.width()) / f64::from(work.width());
        let sy = f64::from(img.height()) / f64::from(work.height());
        let min_side = f64::from(self.config.min_face_px_at_640) * f64::from(long_edge) / 640.0;
        let kept = filter_faces(
            raw,
            min_side,
            self.config.max_faces,
            self.config.min_area_ratio,
        );
        Ok(kept.into_iter().map(|d| d.scaled(sx, sy)).collect())
    }

    /// Runs the network on `img` as-is (padded to a multiple of 32) and
    /// returns all detections after NMS, best score first, unfiltered.
    ///
    /// # Errors
    /// Inference failures.
    pub fn run_network(&self, img: &RgbImage) -> Result<Vec<Detection>> {
        let (w, h) = (img.width() as usize, img.height() as usize);
        self.run_network_padded(img, pad(w), pad(h))
    }

    /// [`Detector::run_network`] with an explicit (larger) padded input size.
    fn run_network_padded(&self, img: &RgbImage, pw: usize, ph: usize) -> Result<Vec<Detection>> {
        let (pw, ph) = (
            pw.max(pad(img.width() as usize)),
            ph.max(pad(img.height() as usize)),
        );
        let input = to_bgr_tensor(img, pw, ph)?;
        let plan = self.model.plan(ph, pw)?;
        let outputs = plan.run(input)?;
        if outputs.len() != 12 {
            return Err(EngineError::Inference(format!(
                "YuNet returned {} outputs, expected 12",
                outputs.len()
            )));
        }
        let mut heads = Vec::with_capacity(12);
        for i in 0..12 {
            heads.push(model::output_slice(&outputs, i)?);
        }
        let raw = decode_heads(&heads, pw, ph, self.config.score_threshold)?;
        Ok(nms(raw, self.config.nms_iou, self.config.top_k))
    }
}

/// Rounds up to the next multiple of 32 (minimum 32).
fn pad(v: usize) -> usize {
    v.max(1).div_ceil(PAD) * PAD
}

/// Resizes so the long edge equals `long_edge` (up or down), keeping aspect.
pub(crate) fn resize_to_long_edge(img: &RgbImage, long_edge: u32) -> Result<RgbImage> {
    let long = img.size().long_edge();
    if long == long_edge {
        return Ok(img.clone());
    }
    let s = f64::from(long_edge) / f64::from(long);
    let dim = |v: u32| {
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let r = (f64::from(v) * s).round().max(1.0) as u32;
        r
    };
    img.resized(dim(img.width()), dim(img.height()), Filter::Bilinear)
}

/// Packs RGB pixels into a zero-padded `1×3×ph×pw` BGR float tensor.
fn to_bgr_tensor(img: &RgbImage, pw: usize, ph: usize) -> Result<Tensor> {
    let (w, h) = (img.width() as usize, img.height() as usize);
    let plane = pw * ph;
    let mut data = vec![0f32; 3 * plane];
    let raw = img.as_raw();
    for y in 0..h {
        let row = &raw[y * w * 3..(y + 1) * w * 3];
        let base = y * pw;
        for (x, px) in row.as_chunks::<3>().0.iter().enumerate() {
            data[base + x] = f32::from(px[2]);
            data[plane + base + x] = f32::from(px[1]);
            data[2 * plane + base + x] = f32::from(px[0]);
        }
    }
    tract_ndarray::Array4::from_shape_vec((1, 3, ph, pw), data)
        .map(IntoTensor::into_tensor)
        .map_err(|e| EngineError::Internal(format!("YuNet input tensor: {e}")))
}

/// Decodes the 12 YuNet heads for a `pw × ph` padded input.
pub(crate) fn decode_heads(
    heads: &[&[f32]],
    pw: usize,
    ph: usize,
    score_threshold: f32,
) -> Result<Vec<Detection>> {
    let mut out = Vec::new();
    for (i, &stride) in STRIDES.iter().enumerate() {
        let (cols, rows) = (pw / stride, ph / stride);
        let n = cols * rows;
        let (cls, obj, bbox, kps) = (heads[i], heads[i + 3], heads[i + 6], heads[i + 9]);
        if cls.len() < n || obj.len() < n || bbox.len() < n * 4 || kps.len() < n * 10 {
            return Err(EngineError::Inference(format!(
                "YuNet head for stride {stride} has unexpected size"
            )));
        }
        #[allow(clippy::cast_precision_loss)]
        let s = stride as f32;
        for idx in 0..n {
            let score = (cls[idx].clamp(0.0, 1.0) * obj[idx].clamp(0.0, 1.0)).sqrt();
            if score < score_threshold {
                continue;
            }
            #[allow(clippy::cast_precision_loss)]
            let (c, r) = ((idx % cols) as f32, (idx / cols) as f32);
            let b = &bbox[idx * 4..idx * 4 + 4];
            let cx = (c + b[0]) * s;
            let cy = (r + b[1]) * s;
            let w = b[2].exp() * s;
            let h = b[3].exp() * s;
            let k = &kps[idx * 10..idx * 10 + 10];
            let lm = |j: usize| {
                Point::new(
                    f64::from((k[2 * j] + c) * s),
                    f64::from((k[2 * j + 1] + r) * s),
                )
            };
            out.push(Detection {
                bounds: Rect::new(
                    f64::from(cx - w / 2.0),
                    f64::from(cy - h / 2.0),
                    f64::from(w),
                    f64::from(h),
                ),
                landmarks: [lm(0), lm(1), lm(2), lm(3), lm(4)],
                score,
            });
        }
    }
    Ok(out)
}

/// Greedy non-maximum suppression; keeps at most `top_k`, best score first.
#[must_use]
pub fn nms(mut dets: Vec<Detection>, iou_threshold: f32, top_k: usize) -> Vec<Detection> {
    dets.sort_by(|a, b| b.score.total_cmp(&a.score));
    let mut kept: Vec<Detection> = Vec::new();
    for d in dets {
        if kept.len() >= top_k {
            break;
        }
        if kept
            .iter()
            .all(|k| k.bounds.iou(&d.bounds) <= f64::from(iou_threshold))
        {
            kept.push(d);
        }
    }
    kept
}

/// ARCHITECTURE §9.3 face filter: drop faces with a short side below
/// `min_side`, then keep the `max_faces` largest whose area is at least
/// `min_area_ratio` of the largest. Result is sorted largest first.
#[must_use]
pub fn filter_faces(
    dets: Vec<Detection>,
    min_side: f64,
    max_faces: usize,
    min_area_ratio: f32,
) -> Vec<Detection> {
    let mut faces: Vec<_> = dets
        .into_iter()
        .filter(|d| d.bounds.width.min(d.bounds.height) >= min_side)
        .collect();
    faces.sort_by(|a, b| b.bounds.area().total_cmp(&a.bounds.area()));
    let Some(largest) = faces.first().map(|d| d.bounds.area()) else {
        return faces;
    };
    faces.retain(|d| d.bounds.area() >= largest * f64::from(min_area_ratio));
    faces.truncate(max_faces);
    faces
}

/// Working sizes used by [`Detector::refine`] (each also run mirrored).
/// Chosen by measurement (BENCHMARKS.md): eye jitter across frames drops from
/// 4.8 % to 2.3 % of the inter-pupillary distance for ~45 ms per frame.
pub const REFINE_SCALES: [u32; 2] = [384, 512];
/// Minimum IoU with the expected face box for a refinement detection.
pub const REFINE_MIN_IOU: f64 = 0.3;

impl Detector {
    /// Re-detects the face whose box is `face_box` (pixels of `img`) on a
    /// square crop around it (side = 2 × the box's long side, black outside
    /// the image), with test-time augmentation: every size in
    /// [`REFINE_SCALES`], plain and mirrored. Landmarks of the detections
    /// overlapping `face_box` (IoU ≥ 0.3) are averaged, halving YuNet's
    /// landmark jitter across frames. Square inputs keep the number of
    /// optimized model plans fixed. Returns `None` when the face is not
    /// found again.
    ///
    /// # Errors
    /// Inference failures.
    pub fn refine(&self, img: &RgbImage, face_box: Rect) -> Result<Option<Detection>> {
        let side = (face_box.width.max(face_box.height) * 2.0).round();
        if !(side >= 16.0 && side.is_finite()) {
            return Ok(None);
        }
        let c = face_box.center();
        let (ox, oy) = ((c.x - side / 2.0).round(), (c.y - side / 2.0).round());
        // Sample the square straight at the largest working size: a 512 px
        // patch instead of a full-resolution crop (memory and time).
        let patch_side = REFINE_SCALES.iter().copied().max().unwrap_or(512);
        let crop = square_patch(img, ox, oy, side, patch_side)?;
        let k = f64::from(patch_side) / side;
        let mirrored = crop.flipped_horizontal();
        let local = face_box.translated_by(-ox, -oy).scaled(k, k);
        let mut found: Vec<Detection> = Vec::with_capacity(REFINE_SCALES.len() * 2);
        for edge in REFINE_SCALES {
            let plain = self.detect_at(&crop, edge)?;
            let flipped: Vec<Detection> = self
                .detect_at(&mirrored, edge)?
                .iter()
                .map(|d| d.unmirrored(f64::from(patch_side)))
                .collect();
            for dets in [plain, flipped] {
                if let Some(d) =
                    best_overlap(&dets, &local).filter(|d| d.bounds.iou(&local) >= REFINE_MIN_IOU)
                {
                    found.push(d);
                }
            }
        }
        Ok(mean_detection(&found).map(|d| d.scaled(1.0 / k, 1.0 / k).translated(ox, oy)))
    }

    /// Detects faces with the image letterboxed into a square network input
    /// of `edge` (rounded up to 32): one optimized plan per edge, whatever
    /// the aspect ratio. Results are filtered like [`Detector::detect`].
    ///
    /// # Errors
    /// Inference failures.
    pub fn detect_square(&self, img: &RgbImage, edge: u32) -> Result<Vec<Detection>> {
        if img.size().is_empty() {
            return Ok(Vec::new());
        }
        let work = resize_to_long_edge(img, edge)?;
        let p = pad(edge as usize);
        let raw = self.run_network_padded(&work, p, p)?;
        let sx = f64::from(img.width()) / f64::from(work.width());
        let sy = f64::from(img.height()) / f64::from(work.height());
        let min_side = f64::from(self.config.min_face_px_at_640) * f64::from(edge) / 640.0;
        let kept = filter_faces(
            raw,
            min_side,
            self.config.max_faces,
            self.config.min_area_ratio,
        );
        Ok(kept.into_iter().map(|d| d.scaled(sx, sy)).collect())
    }
}

/// The `side × side` square of `img` at `(x0, y0)` (may extend past the
/// image; black there), resampled to `out × out`.
fn square_patch(img: &RgbImage, x0: f64, y0: f64, side: f64, out: u32) -> Result<RgbImage> {
    let k = f64::from(out) / side;
    let clip =
        Rect::new(x0, y0, side, side).clipped(f64::from(img.width()), f64::from(img.height()));
    let mut patch = RgbImage::new(out, out);
    if clip.width < 1.0 || clip.height < 1.0 {
        return Ok(patch);
    }
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let (pw, ph, px, py) = (
        (clip.width * k).round().clamp(1.0, f64::from(out)) as u32,
        (clip.height * k).round().clamp(1.0, f64::from(out)) as u32,
        ((clip.x - x0) * k).round().max(0.0) as u32,
        ((clip.y - y0) * k).round().max(0.0) as u32,
    );
    let part = crate::warp::resize_region(
        img,
        (clip.x, clip.y, clip.width, clip.height),
        Size::new(pw, ph),
    )?;
    let (px, py) = (px.min(out - pw), py.min(out - ph));
    let stride = patch.stride();
    let row_bytes = part.stride();
    let raw = patch.as_raw_mut();
    for (y, row) in part.as_raw().chunks(row_bytes).enumerate() {
        let d = (py as usize + y) * stride + px as usize * 3;
        raw[d..d + row_bytes].copy_from_slice(row);
    }
    Ok(patch)
}

/// Point-wise mean of several detections of the same face.
#[must_use]
pub fn mean_detection(dets: &[Detection]) -> Option<Detection> {
    let first = dets.first()?;
    #[allow(clippy::cast_precision_loss)]
    let n = dets.len() as f64;
    let mut landmarks = [Point::default(); 5];
    let (mut x, mut y, mut bw, mut bh, mut score) = (0.0, 0.0, 0.0, 0.0, 0.0f32);
    for d in dets {
        for (acc, p) in landmarks.iter_mut().zip(d.landmarks) {
            acc.x += p.x / n;
            acc.y += p.y / n;
        }
        x += d.bounds.x / n;
        y += d.bounds.y / n;
        bw += d.bounds.width / n;
        bh += d.bounds.height / n;
        score = score.max(d.score);
    }
    Some(Detection {
        bounds: Rect::new(x, y, bw, bh),
        landmarks,
        score: if dets.len() == 1 { first.score } else { score },
    })
}

/// Picks the detection overlapping `target` the most (IoU), if any overlaps.
#[must_use]
pub fn best_overlap(dets: &[Detection], target: &Rect) -> Option<Detection> {
    dets.iter()
        .map(|d| (d.bounds.iou(target), d))
        .filter(|(iou, _)| *iou > 0.0)
        .max_by(|a, b| a.0.total_cmp(&b.0))
        .map(|(_, d)| *d)
}

/// Size of the padded network input for an image of `size` resized to `long_edge`.
#[must_use]
pub fn padded_input(size: Size, long_edge: u32) -> (usize, usize) {
    let s = f64::from(long_edge) / f64::from(size.long_edge().max(1));
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let dim = |v: u32| pad((f64::from(v) * s).round() as usize);
    (dim(size.width), dim(size.height))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Zeroed heads for a `pw × ph` input.
    fn empty_heads(pw: usize, ph: usize) -> Vec<Vec<f32>> {
        let mut heads = Vec::new();
        for per_cell in [1, 1, 4, 10] {
            for s in STRIDES {
                heads.push(vec![0.0; (pw / s) * (ph / s) * per_cell]);
            }
        }
        heads
    }

    fn set_cell(heads: &mut [Vec<f32>], head: usize, cols: usize, col: usize, row: usize) {
        let idx = row * cols + col;
        heads[head][idx] = 0.9; // cls
        heads[head + 3][idx] = 0.9; // obj → score 0.9
        heads[head + 6][idx * 4..idx * 4 + 4].copy_from_slice(&[0.5, 0.25, 2f32.ln(), 3f32.ln()]);
        let kps = [0.1, 0.2, 0.9, 0.2, 0.5, 0.5, 0.2, 0.8, 0.8, 0.8];
        heads[head + 9][idx * 10..idx * 10 + 10].copy_from_slice(&kps);
    }

    fn as_slices(heads: &[Vec<f32>]) -> Vec<&[f32]> {
        heads.iter().map(Vec::as_slice).collect()
    }

    #[test]
    fn decodes_a_single_synthetic_face() {
        let (pw, ph) = (64, 32);
        let mut heads = empty_heads(pw, ph);
        // Stride 16 head (index 1): 4 cols × 2 rows; cell (col 2, row 1).
        set_cell(&mut heads, 1, 4, 2, 1);
        let dets = decode_heads(&as_slices(&heads), pw, ph, 0.6).expect("decode");
        assert_eq!(dets.len(), 1);
        let d = dets[0];
        assert!((d.score - 0.9).abs() < 1e-6);
        // cx = (2 + 0.5)·16 = 40, cy = (1 + 0.25)·16 = 20, w = 2·16, h = 3·16.
        let b = d.bounds;
        assert!(
            (b.x - 24.0).abs() < 1e-4 && (b.y - (-4.0)).abs() < 1e-4,
            "{b:?}"
        );
        assert!((b.width - 32.0).abs() < 1e-4 && (b.height - 48.0).abs() < 1e-4);
        assert!((d.landmarks[0].x - 33.6).abs() < 1e-4 && (d.landmarks[0].y - 19.2).abs() < 1e-4);
        assert!((d.landmarks[4].x - 44.8).abs() < 1e-4 && (d.landmarks[4].y - 28.8).abs() < 1e-4);
        // Anchor order invariants hold for this synthetic frontal face.
        assert!(d.landmarks[0].x < d.landmarks[1].x && d.landmarks[3].x < d.landmarks[4].x);
        assert!(
            decode_heads(&as_slices(&heads), pw, ph, 0.95)
                .expect("decode")
                .is_empty()
        );
    }

    #[test]
    fn square_patch_resamples_and_pads() {
        let img = RgbImage::filled(100, 50, [200, 100, 50]);
        let p = square_patch(&img, -50.0, 0.0, 100.0, 50).expect("patch");
        assert_eq!(p.size(), Size::new(50, 50));
        assert_eq!(p.pixel(10, 10), Some([0, 0, 0]), "left of the image");
        assert_eq!(p.pixel(40, 10), Some([200, 100, 50]));
        assert_eq!(p.pixel(40, 40), Some([0, 0, 0]), "below the image");
        let empty = square_patch(&img, 500.0, 500.0, 10.0, 8).expect("empty");
        assert!(empty.as_raw().iter().all(|&v| v == 0));
    }

    #[test]
    fn rejects_wrongly_sized_heads() {
        let heads = empty_heads(32, 32);
        let mut short = heads.clone();
        short[0].clear();
        assert!(decode_heads(&as_slices(&short), 32, 32, 0.5).is_err());
    }

    fn det(x: f64, y: f64, w: f64, h: f64, score: f32) -> Detection {
        Detection {
            bounds: Rect::new(x, y, w, h),
            landmarks: [Point::new(x, y); 5],
            score,
        }
    }

    #[test]
    fn nms_keeps_best_of_overlapping_boxes() {
        let dets = vec![
            det(0.0, 0.0, 10.0, 10.0, 0.7),
            det(1.0, 1.0, 10.0, 10.0, 0.9),
            det(50.0, 50.0, 10.0, 10.0, 0.8),
            det(52.0, 50.0, 10.0, 10.0, 0.61),
        ];
        let kept = nms(dets.clone(), 0.3, 10);
        let scores: Vec<_> = kept.iter().map(|d| d.score).collect();
        assert_eq!(scores, [0.9, 0.8]);
        assert_eq!(nms(dets.clone(), 0.3, 1).len(), 1);
        // A permissive threshold keeps everything.
        assert_eq!(nms(dets, 0.99, 10).len(), 4);
    }

    #[test]
    fn filter_drops_small_and_minor_faces() {
        let dets = vec![
            det(0.0, 0.0, 100.0, 100.0, 0.9),
            det(0.0, 0.0, 40.0, 40.0, 0.9),  // 16 % of largest: kept
            det(0.0, 0.0, 30.0, 30.0, 0.9),  // 9 %: dropped
            det(0.0, 0.0, 200.0, 20.0, 0.9), // short side 20 < 24: dropped
            det(0.0, 0.0, 35.0, 35.0, 0.9),  // 12 %: kept but 4th → truncated? no, 3rd
        ];
        let kept = filter_faces(dets, 24.0, 3, 0.10);
        let widths: Vec<_> = kept.iter().map(|d| d.bounds.width).collect();
        assert_eq!(widths, [100.0, 40.0, 35.0]);
        assert!(filter_faces(Vec::new(), 24.0, 3, 0.1).is_empty());
        let one = filter_faces(vec![det(0.0, 0.0, 50.0, 50.0, 0.9); 5], 24.0, 2, 0.1);
        assert_eq!(one.len(), 2);
    }

    #[test]
    fn mirror_average_scale_translate() {
        let d = Detection {
            bounds: Rect::new(10.0, 20.0, 30.0, 40.0),
            landmarks: [
                Point::new(15.0, 30.0),
                Point::new(35.0, 30.0),
                Point::new(25.0, 40.0),
                Point::new(18.0, 50.0),
                Point::new(32.0, 50.0),
            ],
            score: 0.8,
        };
        let m = d.unmirrored(100.0);
        assert_eq!(m.bounds, Rect::new(60.0, 20.0, 30.0, 40.0));
        assert_eq!(m.landmarks[0], Point::new(65.0, 30.0));
        assert_eq!(m.landmarks[1], Point::new(85.0, 30.0));
        assert_eq!(m.landmarks[3], Point::new(68.0, 50.0));
        // Mirroring twice is the identity.
        assert_eq!(m.unmirrored(100.0), d);
        let avg = mean_detection(&[d, d.translated(2.0, 4.0)]).expect("mean");
        assert_eq!(avg.landmarks[2], Point::new(26.0, 42.0));
        assert_eq!(avg.bounds, Rect::new(11.0, 22.0, 30.0, 40.0));
        assert_eq!(d.scaled(2.0, 0.5).bounds, Rect::new(20.0, 10.0, 60.0, 20.0));
        assert!((d.eye_distance() - 20.0).abs() < 1e-12);
        assert!(mean_detection(&[]).is_none());
        assert_eq!(mean_detection(&[d]), Some(d));
        let others = [d.translated(100.0, 0.0), d.translated(5.0, 0.0)];
        let best = best_overlap(&others, &d.bounds).expect("overlap");
        assert_eq!(best.bounds.x, 15.0);
        assert!(best_overlap(&others[..1], &d.bounds).is_none());
    }

    #[test]
    fn tensor_layout_is_bgr_planar_and_padded() {
        let img = RgbImage::from_raw(2, 1, vec![1, 2, 3, 4, 5, 6]).expect("img");
        let t = to_bgr_tensor(&img, 32, 32).expect("tensor");
        assert_eq!(t.shape(), &[1, 3, 32, 32]);
        let v = t
            .try_as_plain_ram()
            .and_then(|p| p.as_slice::<f32>())
            .expect("slice");
        let plane = 32 * 32;
        assert_eq!((v[0], v[1], v[2]), (3.0, 6.0, 0.0)); // B plane
        assert_eq!((v[plane], v[plane + 1]), (2.0, 5.0)); // G plane
        assert_eq!((v[2 * plane], v[2 * plane + 1]), (1.0, 4.0)); // R plane
        assert_eq!(pad(1), 32);
        assert_eq!(pad(480), 480);
        assert_eq!(pad(481), 512);
        assert_eq!(padded_input(Size::new(4032, 3024), 640), (640, 480));
        assert_eq!(padded_input(Size::new(1080, 1920), 640), (384, 640));
    }

    #[test]
    fn resize_to_long_edge_scales_both_ways() {
        let img = RgbImage::new(400, 300);
        assert_eq!(
            resize_to_long_edge(&img, 640).expect("up").size(),
            Size::new(640, 480)
        );
        assert_eq!(
            resize_to_long_edge(&img, 200).expect("down").size(),
            Size::new(200, 150)
        );
        assert_eq!(
            resize_to_long_edge(&img, 400).expect("same").size(),
            Size::new(400, 300)
        );
    }

    #[test]
    fn degenerate_inputs_need_no_inference() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../models/face_detection_yunet_2023mar.onnx");
        let Ok(d) = Detector::load(&path, DetectorConfig::default()) else {
            return;
        };
        assert!(format!("{d:?}").starts_with("Detector"));
        let empty = RgbImage::new(0, 0);
        assert!(d.detect_at(&empty, 640).expect("empty").is_empty());
        assert!(d.detect_square(&empty, 640).expect("empty").is_empty());
        let tiny_box = Rect::new(10.0, 10.0, 2.0, 2.0);
        assert!(
            d.refine(&RgbImage::new(64, 64), tiny_box)
                .expect("tiny")
                .is_none()
        );
        assert!(d.run_network(&RgbImage::new(64, 48)).is_ok());
    }
}
