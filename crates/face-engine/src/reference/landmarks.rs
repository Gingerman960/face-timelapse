//! The reference photo's main face: landmarks averaged over many framings
//! (YuNet's 5 points move with how a face is framed), the levelling angle
//! and the matching embedding, measured once per photo version on the
//! unrotated photo so neither the crop nor the rotation changes them.

use std::path::{Path, PathBuf};

use super::{WHOLE_IMAGE_DETECT_EDGE, crop_of, detect_largest, eye_level_angle};
use crate::analysis::Analyzer;
use crate::detect::Detection;
use crate::error::Result;
use crate::geometry::Rect;
use crate::image::{Filter, RgbImage};
use crate::recognize::Embedding;
use crate::warp;

/// The photo's main face as matching and anchors use it: [`ensemble_detection`]
/// landmarks and the embedding taken on the *unrotated* photo, so neither
/// the crop nor the rotation changes them.
#[derive(Debug, Clone)]
pub(super) struct MainFace {
    /// Unrotated photo pixels.
    pub(super) detection: Detection,
    pub(super) embedding: Embedding,
}

/// What a photo's reference analysis computes once (cached per version).
#[derive(Debug, Clone)]
pub(super) struct PhotoFace {
    pub(super) level: Option<f64>,
    pub(super) main: Option<MainFace>,
}

/// The crop's face is the main face when its box overlaps it this much.
pub(super) const MAIN_FACE_IOU: f64 = 0.3;

/// Box scales × shifts (fractions of the box) of [`ensemble_detection`].
const FRAMING_SCALES: [f64; 5] = [0.8, 0.9, 1.0, 1.1, 1.25];

const FRAMING_SHIFTS: [(f64, f64); 5] =
    [(0.0, 0.0), (0.1, 0.0), (-0.1, 0.0), (0.0, 0.1), (0.0, -0.1)];

/// Long edge of the face neighbourhood [`level_rotation`] re-measures on.
const LEVEL_PATCH_EDGE: u32 = 1024;

/// Remembered levelling angles (per photo version; rotations reuse them).
const LEVEL_CACHE_SIZE: usize = 8;

/// The face's landmarks averaged over 25 framings of `face_box` (pixels of
/// `img`), each with the TTA refinement of aligned frames. YuNet's 5-point
/// landmarks shift by several pixels with how the face is framed — the eye
/// line by ±0.7° on a real selfie — while the mean over framings is stable
/// (±0.13°) and moves exactly with a rotation. Framings run in parallel.
///
/// # Errors
/// Inference failures.
pub fn ensemble_detection(
    analyzer: &Analyzer,
    img: &RgbImage,
    face_box: Rect,
) -> Result<Option<Detection>> {
    use rayon::prelude::*;
    let c = face_box.center();
    let boxes: Vec<Rect> = FRAMING_SCALES
        .iter()
        .flat_map(|&k| {
            FRAMING_SHIFTS.iter().map(move |&(dx, dy)| {
                let (w, h) = (face_box.width * k, face_box.height * k);
                Rect::new(
                    c.x - w / 2.0 + dx * face_box.width,
                    c.y - h / 2.0 + dy * face_box.height,
                    w,
                    h,
                )
            })
        })
        .collect();
    crate::decode::assert_no_share_held("reference landmarks");
    let found = boxes
        .par_iter()
        .map(|b| analyzer.detector().refine(img, *b))
        .collect::<Result<Vec<_>>>()?;
    let found: Vec<Detection> = found.into_iter().flatten().collect();
    Ok(crate::detect::mean_detection(&found))
}

/// Absolute rotation (degrees, clockwise) that levels the eyes of the
/// largest face of `source` (the unrotated photo); `None` without a face.
/// See [`level_rotation_of`].
///
/// # Errors
/// Resize or inference failures.
pub fn level_rotation(analyzer: &Analyzer, source: &RgbImage) -> Result<Option<f64>> {
    Ok(analyze_photo_face(analyzer, source)?.level)
}

/// Measures the largest face of `source` (the unrotated photo): its
/// [`ensemble_detection`] landmarks and embedding (what matching and the
/// target anchors use) and the levelling angle (see [`level_rotation_of`]).
fn analyze_photo_face(analyzer: &Analyzer, source: &RgbImage) -> Result<PhotoFace> {
    let small = source.fit_within(WHOLE_IMAGE_DETECT_EDGE, Filter::Bilinear)?;
    let Some(found) = detect_largest(analyzer, &small)? else {
        return Ok(PhotoFace {
            level: None,
            main: None,
        });
    };
    let k = f64::from(source.width()) / f64::from(small.width().max(1));
    let face = found.scaled(k, k);
    let Some(detection) = ensemble_detection(analyzer, source, face.bounds)? else {
        return Ok(PhotoFace {
            level: Some(eye_level_angle(found.landmarks[0], found.landmarks[1])),
            main: None,
        });
    };
    let embedding = analyzer.recognizer().embed(source, &detection.landmarks)?;
    let estimate = eye_level_angle(detection.landmarks[0], detection.landmarks[1]);
    Ok(PhotoFace {
        level: Some(level_rotation_of(analyzer, source, face.bounds, estimate)?),
        main: Some(MainFace {
            detection,
            embedding,
        }),
    })
}

/// The levelling angle of the face in `face_box` (the whole-image
/// detection's box, in `source` pixels) whose [`ensemble_detection`] eye line
/// reads `estimate`: re-measured once on the face's neighbourhood rotated by
/// that estimate, absorbing what the landmark model under-reads. The result
/// depends only on the photo, so applying it once levels the eyes (a single
/// whole-image detection's eye line wobbles by ±0.5° and sits up to ~2° off
/// on a real selfie) and a second press changes nothing.
fn level_rotation_of(
    analyzer: &Analyzer,
    source: &RgbImage,
    face_box: Rect,
    estimate: f64,
) -> Result<f64> {
    let b = face_box;
    let side = b.width.max(b.height) * 3.0;
    let c = b.center();
    let region = Rect::new(c.x - side / 2.0, c.y - side / 2.0, side, side)
        .clipped(f64::from(source.width()), f64::from(source.height()));
    let patch = crop_of(source, region)?.fit_within(LEVEL_PATCH_EDGE, Filter::CatmullRom)?;
    let to_patch = f64::from(patch.width()) / region.width.round().max(1.0);
    let local = b
        .translated_by(-region.x.round(), -region.y.round())
        .scaled(to_patch, to_patch);
    let (rotated, t) = warp::rotate_expand(&patch, estimate);
    let center = t.apply(local.center());
    let bounds = Rect::new(
        center.x - local.width / 2.0,
        center.y - local.height / 2.0,
        local.width,
        local.height,
    );
    let residual = ensemble_detection(analyzer, &rotated, bounds)?
        .map_or(0.0, |d| eye_level_angle(d.landmarks[0], d.landmarks[1]));
    Ok(estimate + residual)
}

/// [`analyze_photo_face`] remembered per photo version, so changing the
/// rotation or the crop (which reloads the photo) does not re-measure.
pub(super) fn cached_photo_face(
    analyzer: &Analyzer,
    path: &Path,
    source: &RgbImage,
) -> Result<PhotoFace> {
    type Key = (PathBuf, u64, i64);
    static CACHE: std::sync::Mutex<Vec<(Key, PhotoFace)>> = std::sync::Mutex::new(Vec::new());
    let key = crate::walk::file_stamp(path)
        .ok()
        .map(|(len, mtime)| (path.to_path_buf(), len, mtime));
    let lock = || {
        CACHE
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    };
    if let Some(key) = &key
        && let Some((_, v)) = lock().iter().find(|(k, _)| k == key)
    {
        return Ok(v.clone());
    }
    let value = analyze_photo_face(analyzer, source)?;
    if let Some(key) = key {
        let mut cache = lock();
        cache.retain(|(k, _)| *k != key);
        cache.push((key, value.clone()));
        let excess = cache.len().saturating_sub(LEVEL_CACHE_SIZE);
        cache.drain(..excess);
    }
    Ok(value)
}
