//! Aligned frame rendering (ARCHITECTURE §9.5).
//!
//! For one photo: header probe → legacy Procrustes from the matched face's
//! anchors onto the reference anchors → DCT-scaled decode (`f ≥ 1.25·s`) →
//! optional landmark refinement (YuNet on the face crop at 640 px, the
//! detection overlapping the scanned face most) → final Procrustes + user
//! adjustment → antialiased bilinear warp over the backdrop with a feathered
//! edge → residual and face statistics.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::analysis::FaceRecord;
use crate::color::{self, FaceStats};
use crate::decode::{self, DecodeTarget, Decoded};
use crate::detect::Detector;
use crate::error::{EngineError, Result};
use crate::geometry::{Point, Rect, Similarity, Size};
use crate::image::RgbImage;
use crate::warp::{self, BackdropMode};

/// Output resolution preset — same wire values and bounding-box semantics as
/// `timelapse_video::geometry::Resolution` (the crates do not depend on each
/// other, so the rule is mirrored here and pinned by identical tests).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
pub enum Resolution {
    /// The crop's pixel size (legacy), capped to 3840×2160.
    #[serde(rename = "source")]
    Source,
    /// Fits 3840×2160.
    #[serde(rename = "2160p")]
    P2160,
    /// Fits 1920×1080.
    #[default]
    #[serde(rename = "1080p")]
    P1080,
    /// Fits 1280×720.
    #[serde(rename = "720p")]
    P720,
}

/// Largest long side (H.264 level 5.2 limit shared with the video crate).
pub const MAX_LONG_SIDE: u32 = 3840;
/// Largest short side.
pub const MAX_SHORT_SIDE: u32 = 2160;
/// Smallest output side.
pub const MIN_SIDE: u32 = 16;

impl Resolution {
    /// `(long, short)` of the preset box, `None` for `Source`.
    #[must_use]
    pub fn bounding_box(self) -> Option<(u32, u32)> {
        match self {
            Self::Source => None,
            Self::P2160 => Some((3840, 2160)),
            Self::P1080 => Some((1920, 1080)),
            Self::P720 => Some((1280, 720)),
        }
    }

    /// Output size for a `src_w × src_h` crop: the largest even-sized
    /// rectangle with the crop's aspect inside the (orientation-matched) box.
    #[must_use]
    pub fn output_size(self, src_w: u32, src_h: u32) -> Option<Size> {
        if src_w == 0 || src_h == 0 {
            return None;
        }
        let landscape = src_w >= src_h;
        let (box_long, box_short) = self.bounding_box().unwrap_or_else(|| {
            let (long, short) = if landscape {
                (src_w, src_h)
            } else {
                (src_h, src_w)
            };
            (long.min(MAX_LONG_SIDE), short.min(MAX_SHORT_SIDE))
        });
        let (box_w, box_h) = if landscape {
            (box_long, box_short)
        } else {
            (box_short, box_long)
        };
        let (sw, sh) = (f64::from(src_w), f64::from(src_h));
        let scale = (f64::from(box_w) / sw).min(f64::from(box_h) / sh);
        let w = round_even(sw * scale).min(box_w & !1);
        let h = round_even(sh * scale).min(box_h & !1);
        Some(Size::new(w.max(MIN_SIDE), h.max(MIN_SIDE)))
    }
}

/// Rounds to the nearest even integer (ties up), never below 2.
#[must_use]
pub fn round_even(x: f64) -> u32 {
    let half = (x / 2.0).round().max(1.0);
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let h = half as u32;
    h.saturating_mul(2)
}

/// Post-Procrustes correction in output space. Identity = `{0, 0, 1, 0}`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameAdjust {
    /// Horizontal shift, fraction of output width.
    pub dx: f64,
    /// Vertical shift, fraction of output height.
    pub dy: f64,
    /// Scale about the output center.
    pub scale: f64,
    /// Clockwise rotation about the output center (degrees).
    pub rotation_deg: f64,
}

impl Default for FrameAdjust {
    fn default() -> Self {
        Self {
            dx: 0.0,
            dy: 0.0,
            scale: 1.0,
            rotation_deg: 0.0,
        }
    }
}

impl FrameAdjust {
    /// Validates the contract ranges (|dx|,|dy| ≤ 0.25, scale ∈ [0.5, 2], |rot| ≤ 20).
    ///
    /// # Errors
    /// [`EngineError::InvalidArgument`].
    pub fn validate(&self) -> Result<()> {
        let ok = self.dx.abs() <= 0.25
            && self.dy.abs() <= 0.25
            && (0.5..=2.0).contains(&self.scale)
            && self.rotation_deg.abs() <= 20.0;
        if ok {
            Ok(())
        } else {
            Err(EngineError::InvalidArgument(
                "frame adjustment out of range".into(),
            ))
        }
    }

    /// The adjustment as an output-space transform.
    #[must_use]
    pub fn transform(&self, out: Size) -> Similarity {
        let (w, h) = (f64::from(out.width), f64::from(out.height));
        Similarity::about(
            Point::new(w / 2.0, h / 2.0),
            self.scale,
            self.rotation_deg.to_radians(),
        )
        .then(&Similarity::translation(self.dx * w, self.dy * h))
    }
}

/// Render settings shared by all frames of a run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderSettings {
    /// Output size preset.
    pub resolution: Resolution,
    /// Backdrop mode.
    pub backdrop: BackdropMode,
    /// Re-detect landmarks on the full-resolution face before aligning.
    pub refine_landmarks: bool,
}

impl Default for RenderSettings {
    fn default() -> Self {
        Self {
            resolution: Resolution::P1080,
            backdrop: BackdropMode::Extended,
            refine_landmarks: true,
        }
    }
}

/// Where the anchors must land: reference anchors in output pixels.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderTarget {
    /// Target anchors (output pixels).
    pub anchors: [Point; 5],
    /// Output size.
    pub size: Size,
}

impl RenderTarget {
    /// Reference anchors normalized to the crop × output size (independent axes,
    /// legacy `scalePoints`).
    #[must_use]
    pub fn from_crop_anchors(anchors: &[Point; 5], size: Size) -> Self {
        let (w, h) = (f64::from(size.width), f64::from(size.height));
        Self {
            anchors: anchors.map(|p| p.scaled(w, h)),
            size,
        }
    }
}

/// One frame to render.
#[derive(Debug, Clone, Copy)]
pub struct FrameRequest<'a> {
    /// Source photo.
    pub source: &'a Path,
    /// The matched face from the analysis (normalized to the oriented photo).
    pub face: &'a FaceRecord,
    /// Target anchors and size.
    pub target: &'a RenderTarget,
    /// Backdrop mode.
    pub backdrop: BackdropMode,
    /// User correction.
    pub adjust: FrameAdjust,
    /// Refine landmarks before aligning.
    pub refine_landmarks: bool,
}

/// A rendered frame.
#[derive(Debug, Clone)]
pub struct RenderedFrame {
    /// Output pixels.
    pub image: RgbImage,
    /// RMS anchor error after Procrustes, output pixels.
    pub residual_px: f64,
    /// Look statistics of the un-normalized frame (`None` if the region is empty).
    pub face_stats: Option<FaceStats>,
    /// Full-resolution source → output transform (including the adjustment).
    pub transform: Similarity,
    /// Source anchors used (full-resolution pixels of the oriented photo).
    pub source_anchors: [Point; 5],
    /// True when refinement found the face again.
    pub refined: bool,
}

/// Renders one aligned frame.
///
/// # Errors
/// I/O, decode and inference errors for that photo.
pub fn render_frame(detector: &Detector, req: &FrameRequest<'_>) -> Result<RenderedFrame> {
    render_with(Some(detector), req)
}

/// [`render_frame`] with the analysis landmarks as they are, whatever
/// `refine_landmarks` says: needs no models (previews).
///
/// # Errors
/// I/O and decode errors for that photo.
pub fn render_frame_unrefined(req: &FrameRequest<'_>) -> Result<RenderedFrame> {
    render_with(None, req)
}

fn render_with(detector: Option<&Detector>, req: &FrameRequest<'_>) -> Result<RenderedFrame> {
    let out = req.target.size;
    if out.is_empty() {
        return Err(EngineError::InvalidArgument("empty output size".into()));
    }
    let bytes = decode::read_file(req.source)?;
    let exif = decode::read_exif(&bytes);
    let full = decode::probe_size(&bytes, req.source, exif.orientation)?;
    let scan_anchors = req.face.landmarks_px(full);
    let initial = Similarity::procrustes_legacy(&scan_anchors, &req.target.anchors);
    let factor = (1.25 * initial.scale()).min(1.0);
    let decoded = decode::decode(
        &bytes,
        req.source,
        exif.orientation,
        DecodeTarget::MinScale(factor),
    )?;

    let (source_anchors, refined) = match detector.filter(|_| req.refine_landmarks) {
        Some(d) => {
            refine(d, &decoded, req.face, full)?.map_or((scan_anchors, false), |a| (a, true))
        }
        None => (scan_anchors, false),
    };
    let procrustes = Similarity::procrustes_legacy(&source_anchors, &req.target.anchors);
    let residual_px = procrustes.residual_rms(&source_anchors, &req.target.anchors);
    let transform = procrustes.then(&req.adjust.transform(out));
    // `compose` consumes the decoded photo so the full-resolution buffer is
    // freed as soon as the antialiased source exists (bounds peak memory).
    let image = compose(decoded, &transform, out, req.backdrop)?;
    let face_stats = color::face_stats(&image, &req.target.anchors);
    Ok(RenderedFrame {
        image,
        residual_px,
        face_stats,
        transform,
        source_anchors,
        refined,
    })
}

/// Warps the decoded photo (full-resolution transform `t`) over its backdrop.
fn compose(
    mut decoded: Decoded,
    t: &Similarity,
    out: Size,
    mode: BackdropMode,
) -> Result<RgbImage> {
    // The warps and blurs below run in parallel on the work pool: a decode
    // budget share must not be held across them (see `decode`).
    decoded.release_budget();
    let f = (decoded.scale_x() + decoded.scale_y()) / 2.0;
    // decoded px → full px → output.
    let t_dec = Similarity::scaling(1.0 / f).then(t);
    if mode == BackdropMode::Extended {
        // Blurred layers from the whole photo, then one fused pass that only
        // evaluates the backdrop where the (antialiased) photo is not opaque.
        let backdrop = warp::ExtendedBackdrop::build(&decoded.image, &t_dec, out)?;
        let (src, t_src) = antialiased_source(decoded.image, &t_dec, out)?;
        let mut canvas = RgbImage::new(out.width, out.height);
        backdrop.composite(&src, &t_src, &mut canvas);
        return Ok(canvas);
    }
    let mut canvas = warp::backdrop(&decoded.image, out, mode)?;
    let (src, t_src) = antialiased_source(decoded.image, &t_dec, out)?;
    warp::warp_over(&src, &t_src, &mut canvas, warp::feather_px(out));
    Ok(canvas)
}

/// When the warp would shrink by more than 1.25×, pre-shrink the part of the
/// source that lands in the output with an antialiasing filter.
fn antialiased_source(img: RgbImage, t: &Similarity, out: Size) -> Result<(RgbImage, Similarity)> {
    let s = t.scale();
    if s >= 0.8 || s <= 0.0 {
        return Ok((img, *t));
    }
    let Some(inv) = t.inverse() else {
        return Ok((img, *t));
    };
    let (w, h) = (f64::from(out.width), f64::from(out.height));
    let corners = [
        Point::new(0.0, 0.0),
        Point::new(w, 0.0),
        Point::new(0.0, h),
        Point::new(w, h),
    ]
    .map(|p| inv.apply(p));
    let region = Rect::bounding(&corners)
        .unwrap_or_default()
        .padded(0.01)
        .clipped(f64::from(img.width()), f64::from(img.height()));
    if region.width < 2.0 || region.height < 2.0 {
        return Ok((img, *t));
    }
    let (x0, y0) = (region.x.floor(), region.y.floor());
    let (rw, rh) = (region.right().ceil() - x0, region.bottom().ceil() - y0);
    let r = s / 0.8;
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let small_size = Size::new(
        (rw * r).round().max(1.0) as u32,
        (rh * r).round().max(1.0) as u32,
    );
    // Resample the region straight from the full image (no intermediate copy).
    let small = warp::resize_region(&img, (x0, y0, rw, rh), small_size)?;
    drop(img);
    let sx = f64::from(small.width()) / rw;
    let sy = f64::from(small.height()) / rh;
    let t_small = Similarity::scaling(2.0 / (sx + sy))
        .then(&Similarity::translation(x0, y0))
        .then(t);
    Ok((small, t_small))
}

/// Re-detects the matched face around its scanned box (TTA, see
/// [`Detector::refine`]) and returns refined anchors in full-resolution pixels.
fn refine(
    detector: &Detector,
    decoded: &Decoded,
    face: &FaceRecord,
    full: Size,
) -> Result<Option<[Point; 5]>> {
    let img = &decoded.image;
    let (dw, dh) = (f64::from(img.width()), f64::from(img.height()));
    let Some(best) = detector.refine(img, face.bounds.scaled(dw, dh))? else {
        return Ok(None);
    };
    let (fx, fy) = (f64::from(full.width) / dw, f64::from(full.height) / dh);
    Ok(Some(best.landmarks.map(|p| p.scaled(fx, fy))))
}

/// `hex(blake3(parts…))[..n]` for cache keys (fingerprints, frame keys).
#[must_use]
pub fn key_hash(parts: &[&str], n: usize) -> String {
    crate::walk::hex_prefix(parts.join("\u{1f}").as_bytes(), n)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolution_rule_matches_the_video_crate() {
        let cases = [
            (Resolution::P1080, (3200, 2368), (1460, 1080)),
            (Resolution::P1080, (1000, 1000), (1080, 1080)),
            (Resolution::P1080, (4000, 3000), (1440, 1080)),
            (Resolution::P1080, (3000, 4000), (1080, 1440)),
            (Resolution::P1080, (1080, 1350), (1080, 1350)),
            (Resolution::P1080, (1600, 2000), (1080, 1350)),
            (Resolution::P1080, (1920, 1080), (1920, 1080)),
            (Resolution::P1080, (1080, 1920), (1080, 1920)),
            (Resolution::P720, (3000, 4000), (720, 960)),
            (Resolution::P2160, (100, 100), (2160, 2160)),
            (Resolution::Source, (1001, 751), (1000, 750)),
            (Resolution::Source, (3201, 2367), (2922, 2160)),
            (Resolution::Source, (8000, 6000), (2880, 2160)),
            (Resolution::Source, (10, 10), (16, 16)),
        ];
        for (res, (w, h), (ew, eh)) in cases {
            assert_eq!(
                res.output_size(w, h),
                Some(Size::new(ew, eh)),
                "{res:?} {w}x{h}"
            );
        }
        assert_eq!(Resolution::P1080.output_size(0, 5), None);
        assert_eq!(round_even(0.1), 2);
        assert_eq!(round_even(5.0), 6);
        let json = serde_json::to_string(&[
            Resolution::Source,
            Resolution::P2160,
            Resolution::P1080,
            Resolution::P720,
        ])
        .expect("json");
        assert_eq!(json, r#"["source","2160p","1080p","720p"]"#);
    }

    #[test]
    fn frame_adjust_validation_and_transform() {
        assert!(FrameAdjust::default().validate().is_ok());
        for bad in [
            FrameAdjust {
                dx: 0.3,
                ..FrameAdjust::default()
            },
            FrameAdjust {
                dy: -0.3,
                ..FrameAdjust::default()
            },
            FrameAdjust {
                scale: 0.4,
                ..FrameAdjust::default()
            },
            FrameAdjust {
                rotation_deg: 21.0,
                ..FrameAdjust::default()
            },
        ] {
            assert!(bad.validate().is_err(), "{bad:?}");
        }
        let out = Size::new(200, 100);
        let id = FrameAdjust::default().transform(out);
        let p = id.apply(Point::new(13.0, 7.0));
        assert!((p.x - 13.0).abs() < 1e-9 && (p.y - 7.0).abs() < 1e-9);
        let a = FrameAdjust {
            dx: 0.1,
            dy: -0.2,
            scale: 2.0,
            rotation_deg: 0.0,
        }
        .transform(out);
        let c = a.apply(Point::new(100.0, 50.0));
        assert!((c.x - 120.0).abs() < 1e-9 && (c.y - 30.0).abs() < 1e-9);
        let q = a.apply(Point::new(110.0, 50.0));
        assert!((q.x - 140.0).abs() < 1e-9);
    }

    #[test]
    fn target_scales_axes_independently() {
        let anchors = [Point::new(0.25, 0.5); 5];
        let t = RenderTarget::from_crop_anchors(&anchors, Size::new(400, 200));
        assert_eq!(t.anchors[0], Point::new(100.0, 100.0));
        assert_eq!(RenderSettings::default().resolution, Resolution::P1080);
        assert_eq!(RenderSettings::default().backdrop, BackdropMode::Extended);
        assert_eq!(key_hash(&["a", "b"], 12).len(), 12);
        assert_ne!(key_hash(&["a", "b"], 12), key_hash(&["ab"], 12));
    }

    #[test]
    fn unrefined_frames_need_no_models_and_keep_the_analysis_landmarks() {
        let dir = tempfile::tempdir().expect("tmp");
        let photo = dir.path().join("p.jpg");
        let img = crate::decode::tests::pattern(400, 300);
        std::fs::write(&photo, crate::decode::tests::jpeg_bytes(&img)).expect("write");
        let face = FaceRecord {
            bounds: Rect::new(0.3, 0.3, 0.4, 0.4),
            landmarks: [(0.4, 0.4), (0.6, 0.4), (0.5, 0.5), (0.42, 0.6), (0.58, 0.6)]
                .map(|(x, y)| Point::new(x, y)),
            score: 0.9,
            embedding: crate::recognize::Embedding(vec![1.0]),
        };
        let target = RenderTarget::from_crop_anchors(
            &[
                (0.35, 0.4),
                (0.65, 0.4),
                (0.5, 0.55),
                (0.38, 0.7),
                (0.62, 0.7),
            ]
            .map(|(x, y)| Point::new(x, y)),
            Size::new(64, 80),
        );
        let req = FrameRequest {
            source: &photo,
            face: &face,
            target: &target,
            backdrop: BackdropMode::Extended,
            adjust: FrameAdjust::default(),
            refine_landmarks: true,
        };
        let frame = render_frame_unrefined(&req).expect("frame without models");
        assert_eq!(frame.image.size(), Size::new(64, 80));
        assert!(!frame.refined, "never refined");
        assert_eq!(frame.source_anchors, face.landmarks_px(Size::new(400, 300)));
    }

    #[test]
    fn extended_frames_stay_sharp_where_the_photo_covers_the_canvas_edge() {
        // Shrinking 4× ⇒ the visible region is pre-shrunk; the photo covers
        // the whole canvas, so no backdrop may show through at its edges.
        let mut img = RgbImage::new(1600, 1200);
        let stride = img.stride();
        for (y, row) in img.as_raw_mut().chunks_mut(stride).enumerate() {
            for (x, px) in row.as_chunks_mut::<3>().0.iter_mut().enumerate() {
                // 16 px checkerboard: 4 px squares in the output, sharp detail
                // that any blurred backdrop showing through would wash out.
                *px = if (x / 16 + y / 16) % 2 == 0 {
                    [255; 3]
                } else {
                    [0; 3]
                };
            }
        }
        let t = Similarity::scaling(0.25).then(&Similarity::translation(-20.0, -15.0));
        let out = Size::new(320, 240);
        let mode = BackdropMode::Extended;
        let (src, ts) = antialiased_source(img.clone(), &t, out).expect("aa");
        let sharp = warp::warp_bilinear(&src, &ts, out.width, out.height, [0, 0, 0]);
        let decoded = Decoded {
            full_size: img.size(),
            image: img,
            orientation: 1,
            budget: crate::decode::Budget::default(),
        };
        let frame = compose(decoded, &t, out, mode).expect("extended");
        for y in 0..out.height {
            for x in [0, 5, 160, 314, 319] {
                let (a, b) = (
                    sharp.pixel(x, y).expect("px"),
                    frame.pixel(x, y).expect("px"),
                );
                assert!(
                    a.iter().zip(b).all(|(p, q)| p.abs_diff(q) <= 1),
                    "({x}, {y}): {a:?} vs {b:?}"
                );
            }
        }
    }

    #[test]
    fn antialiased_source_preserves_the_mapping() {
        let img = crate::decode::tests::pattern(800, 600);
        let t = Similarity::from_parts(0.25, 0.1, 10.0, 5.0);
        let out = Size::new(200, 150);
        let (small, ts) = antialiased_source(img.clone(), &t, out).expect("aa");
        assert!(small.width() < 800);
        assert!((ts.scale() - 0.8).abs() < 0.02, "{}", ts.scale());
        let direct = warp::warp_bilinear(&img, &t, 200, 150, [0, 0, 0]);
        let via = warp::warp_bilinear(&small, &ts, 200, 150, [0, 0, 0]);
        let diff: f64 = direct
            .as_raw()
            .iter()
            .zip(via.as_raw())
            .map(|(a, b)| f64::from(a.abs_diff(*b)))
            .sum::<f64>()
            / direct.as_raw().len() as f64;
        assert!(diff < 8.0, "{diff}");
        // No pre-shrink needed for mild scales.
        let (same, t2) =
            antialiased_source(img.clone(), &Similarity::scaling(0.9), out).expect("aa");
        assert_eq!(same.size(), img.size());
        assert_eq!(t2, Similarity::scaling(0.9));
    }
}
