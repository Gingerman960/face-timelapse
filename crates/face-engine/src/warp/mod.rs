//! Pixel warps: inverse-mapped bilinear sampling under a similarity
//! transform, backdrops (extended / dimmed / blurred / black) and feathered
//! compositing.
//!
//! Coordinate convention: continuous coordinates where pixel `i` covers
//! `[i, i + 1)` (its center is `i + 0.5`). Under this convention scaling an
//! image by `s` scales every coordinate by exactly `s`, so landmarks found on
//! a downscaled image map to full resolution without half-pixel drift.

use rayon::prelude::*;
use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::geometry::{Point, Similarity, Size};
use crate::image::{Filter, RgbImage};

mod extended;

pub use extended::{ExtendedBackdrop, extended_backdrop};

/// How the area not covered by the warped photo is filled.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BackdropMode {
    /// Legacy: the untransformed photo scaled to cover, × 0.45, no blur.
    Dimmed,
    /// Cover-scaled photo, Gaussian blur σ = 1.5 % of the long edge, × 0.6.
    Blurred,
    /// Plain black.
    Black,
    /// The *warped* photo continued past its border (clamp-to-edge), heavily
    /// blurred and darkened with distance from the photo, under a wide
    /// feather: no visible rectangle where the photo ends (default).
    #[default]
    Extended,
}

/// Legacy dimming factor (black overlay with α 0.55).
pub const DIMMED_FACTOR: f32 = 0.45;
/// Brightness of the blurred backdrop.
pub const BLURRED_FACTOR: f32 = 0.6;
/// Blur σ as a fraction of the output long edge.
pub const BLUR_SIGMA_FRACTION: f64 = 0.015;
/// Blur σ of the extended backdrop far from the photo, as a fraction of the
/// output long edge.
pub const EXTENDED_SIGMA_FRACTION: f64 = 0.04;
/// Blur σ of the extended backdrop at the photo's border (fraction of the
/// output long edge); it grows to [`EXTENDED_SIGMA_FRACTION`] with distance.
pub const EXTENDED_NEAR_SIGMA_FRACTION: f64 = 0.015;
/// Brightness of the extended backdrop far away from the photo.
pub const EXTENDED_FACTOR: f32 = 0.75;
/// Distance outside the photo (fraction of the output long edge) over which
/// the extended backdrop goes from the near blur at full brightness to the
/// far blur at [`EXTENDED_FACTOR`] (smoothstep): no step at the border.
pub const EXTENDED_RAMP_FRACTION: f32 = 0.08;
/// Feather of the extended mode as a fraction of the output long edge.
pub const EXTENDED_FEATHER_FRACTION: f32 = 0.025;
/// Blur σ (pixels) of the near layer on the reduced canvas it is built on.
const EXTENDED_SMALL_SIGMA: f64 = 2.0;

/// Feather width for an output: `max(2 px, 0.4 % of the long edge)`.
#[must_use]
pub fn feather_px(out: Size) -> f32 {
    #[allow(clippy::cast_precision_loss)]
    let long = out.long_edge() as f32;
    (long * 0.004).max(2.0)
}

/// Feather width for `mode`: [`EXTENDED_FEATHER_FRACTION`] of the long edge
/// for [`BackdropMode::Extended`], [`feather_px`] otherwise.
#[must_use]
pub fn feather_for(out: Size, mode: BackdropMode) -> f32 {
    match mode {
        BackdropMode::Extended => {
            #[allow(clippy::cast_precision_loss)]
            let long = out.long_edge() as f32;
            (long * EXTENDED_FEATHER_FRACTION).max(2.0)
        }
        BackdropMode::Dimmed | BackdropMode::Blurred | BackdropMode::Black => feather_px(out),
    }
}

/// Samples `src` bilinearly at continuous position `(x, y)` (corner
/// convention), clamping to the edge pixels.
#[inline]
fn sample(src: &[u8], w: usize, h: usize, x: f32, y: f32) -> [f32; 3] {
    let fx = (x - 0.5).clamp(0.0, (w - 1) as f32);
    let fy = (y - 0.5).clamp(0.0, (h - 1) as f32);
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let (x0, y0) = (fx as usize, fy as usize);
    let (x1, y1) = ((x0 + 1).min(w - 1), (y0 + 1).min(h - 1));
    #[allow(clippy::cast_precision_loss)]
    let (ax, ay) = (fx - x0 as f32, fy - y0 as f32);
    let stride = w * 3;
    let (r0, r1) = (y0 * stride, y1 * stride);
    let mut out = [0f32; 3];
    for (c, o) in out.iter_mut().enumerate() {
        let p00 = f32::from(src[r0 + x0 * 3 + c]);
        let p10 = f32::from(src[r0 + x1 * 3 + c]);
        let p01 = f32::from(src[r1 + x0 * 3 + c]);
        let p11 = f32::from(src[r1 + x1 * 3 + c]);
        let top = p00 + (p10 - p00) * ax;
        let bot = p01 + (p11 - p01) * ax;
        *o = top + (bot - top) * ay;
    }
    out
}

#[inline]
fn to_u8(v: f32) -> u8 {
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let r = (v + 0.5).clamp(0.0, 255.0) as u8;
    r
}

/// Row-major inverse mapping parameters in f32.
#[derive(Debug, Clone, Copy)]
struct Inverse {
    a: f32,
    b: f32,
    tx: f32,
    ty: f32,
}

impl Inverse {
    fn of(t: &Similarity) -> Option<Self> {
        let inv = t.inverse()?;
        #[allow(clippy::cast_possible_truncation)]
        Some(Self {
            a: inv.a as f32,
            b: inv.b as f32,
            tx: inv.tx as f32,
            ty: inv.ty as f32,
        })
    }

    /// Source position of the center of output pixel `(0, y)` and the per-x step.
    #[inline]
    fn row_start(&self, y: usize) -> (f32, f32, f32, f32) {
        #[allow(clippy::cast_precision_loss)]
        let cy = y as f32 + 0.5;
        let sx = self.a * 0.5 - self.b * cy + self.tx;
        let sy = self.b * 0.5 + self.a * cy + self.ty;
        (sx, sy, self.a, self.b)
    }
}

/// Warps `src` into a new `out_w × out_h` image; `t` maps source → output.
/// Output pixels whose source lies outside `src` get `border`.
#[must_use]
pub fn warp_bilinear(
    src: &RgbImage,
    t: &Similarity,
    out_w: u32,
    out_h: u32,
    border: [u8; 3],
) -> RgbImage {
    let mut out = RgbImage::filled(out_w, out_h, border);
    let (Some(inv), false) = (Inverse::of(t), src.size().is_empty()) else {
        return out;
    };
    let (w, h) = (src.width() as usize, src.height() as usize);
    #[allow(clippy::cast_precision_loss)]
    let (wf, hf) = (w as f32, h as f32);
    let data = src.as_raw();
    let stride = out.stride().max(1);
    let row_fn = |(y, row): (usize, &mut [u8])| {
        let (mut sx, mut sy, dx, dy) = inv.row_start(y);
        for px in row.as_chunks_mut::<3>().0 {
            if sx >= 0.0 && sy >= 0.0 && sx <= wf && sy <= hf {
                let v = sample(data, w, h, sx, sy);
                px.copy_from_slice(&[to_u8(v[0]), to_u8(v[1]), to_u8(v[2])]);
            }
            sx += dx;
            sy += dy;
        }
    };
    if u64::from(out_w) * u64::from(out_h) <= SEQUENTIAL_MAX_PIXELS {
        // Small outputs (the 112×112 face crop of every embedding) gain
        // nothing from rayon — and stay callable while a decode holds budget.
        out.as_raw_mut()
            .chunks_mut(stride)
            .enumerate()
            .for_each(row_fn);
    } else {
        crate::decode::assert_no_share_held("warp_bilinear");
        out.as_raw_mut()
            .par_chunks_mut(stride)
            .enumerate()
            .for_each(row_fn);
    }
    out
}

/// Outputs up to this many pixels are warped on the calling thread.
pub const SEQUENTIAL_MAX_PIXELS: u64 = 256 * 256;

/// Composites `src` warped by `t` over `canvas` (same size as the output),
/// with a foreground alpha that ramps from 0 at the warped source boundary
/// to 1 at `feather` output pixels inside it.
pub fn warp_over(src: &RgbImage, t: &Similarity, canvas: &mut RgbImage, feather: f32) {
    let (Some(inv), false) = (Inverse::of(t), src.size().is_empty()) else {
        return;
    };
    let (w, h) = (src.width() as usize, src.height() as usize);
    #[allow(clippy::cast_precision_loss)]
    let (wf, hf) = (w as f32, h as f32);
    #[allow(clippy::cast_possible_truncation)]
    let out_per_src = t.scale() as f32;
    let inv_feather = if feather > 0.0 {
        out_per_src / feather
    } else {
        f32::INFINITY
    };
    let data = src.as_raw();
    let stride = canvas.stride();
    crate::decode::assert_no_share_held("warp_over");
    canvas
        .as_raw_mut()
        .par_chunks_mut(stride.max(1))
        .enumerate()
        .for_each(|(y, row)| {
            let (mut sx, mut sy, dx, dy) = inv.row_start(y);
            for px in row.as_chunks_mut::<3>().0 {
                // Distance (source px) to the nearest source edge; > 0 inside.
                let d = sx.min(sy).min(wf - sx).min(hf - sy);
                if d > 0.0 {
                    let alpha = (d * inv_feather).min(1.0);
                    let v = sample(data, w, h, sx, sy);
                    for c in 0..3 {
                        let bg = f32::from(px[c]);
                        px[c] = to_u8(bg + (v[c] - bg) * alpha);
                    }
                }
                sx += dx;
                sy += dy;
            }
        });
}

/// Builds the backdrop for an `out` canvas from the (untransformed) photo.
/// [`BackdropMode::Extended`] uses the cover-scaled photo as its geometry.
///
/// # Errors
/// Resize failures (zero sizes).
pub fn backdrop(src: &RgbImage, out: Size, mode: BackdropMode) -> Result<RgbImage> {
    match mode {
        BackdropMode::Extended => extended_backdrop(src, &cover_transform(src.size(), out), out),
        BackdropMode::Black => Ok(RgbImage::new(out.width, out.height)),
        BackdropMode::Dimmed => {
            let mut img = cover(src, out)?;
            img.scale_brightness(DIMMED_FACTOR);
            Ok(img)
        }
        BackdropMode::Blurred => {
            let sigma = f64::from(out.long_edge()) * BLUR_SIGMA_FRACTION;
            // Blur at a reduced size where σ ≈ 2 px, then upscale.
            let factor = (2.0 / sigma).min(1.0);
            let small = Size::new(
                crate::geometry::scale_dim(out.width, factor),
                crate::geometry::scale_dim(out.height, factor),
            );
            let base = cover(src, small)?;
            #[allow(clippy::cast_possible_truncation)]
            let blurred = gaussian_blur(&base, (sigma * factor) as f32);
            let mut img = blurred.resized(out.width, out.height, Filter::Bilinear)?;
            img.scale_brightness(BLURRED_FACTOR);
            Ok(img)
        }
    }
}

/// The transform that scales an image of `size` to cover `out`, centered.
#[must_use]
pub fn cover_transform(size: Size, out: Size) -> Similarity {
    let (w, h) = (f64::from(size.width), f64::from(size.height));
    let scale = (f64::from(out.width) / w).max(f64::from(out.height) / h);
    Similarity::from_parts(
        scale,
        0.0,
        (f64::from(out.width) - w * scale) / 2.0,
        (f64::from(out.height) - h * scale) / 2.0,
    )
}

/// `src` scaled to cover `out`, centered (legacy backdrop geometry).
///
/// # Errors
/// Resize failures (zero sizes).
pub fn cover(src: &RgbImage, out: Size) -> Result<RgbImage> {
    let (w, h) = (f64::from(src.width()), f64::from(src.height()));
    let scale = (f64::from(out.width) / w).max(f64::from(out.height) / h);
    let (cw, ch) = (f64::from(out.width) / scale, f64::from(out.height) / scale);
    let crop_box = ((w - cw) / 2.0, (h - ch) / 2.0, cw, ch);
    resize_region(src, crop_box, out)
}

pub(crate) fn resize_region(
    src: &RgbImage,
    (x, y, w, h): (f64, f64, f64, f64),
    out: Size,
) -> Result<RgbImage> {
    use fast_image_resize as fir;
    if out.is_empty() || src.size().is_empty() {
        return Err(crate::error::EngineError::InvalidArgument(
            "cannot resize to or from an empty image".into(),
        ));
    }
    let src_ref = fir::images::ImageRef::new(
        src.width(),
        src.height(),
        src.as_raw(),
        fir::PixelType::U8x3,
    )
    .map_err(|e| crate::error::EngineError::Internal(format!("resize source: {e}")))?;
    let mut dst = fir::images::Image::new(out.width, out.height, fir::PixelType::U8x3);
    let opts = fir::ResizeOptions::new()
        .resize_alg(fir::ResizeAlg::Convolution(fir::FilterType::Bilinear))
        .crop(x, y, w, h);
    fir::Resizer::new()
        .resize(&src_ref, &mut dst, &opts)
        .map_err(|e| crate::error::EngineError::Internal(format!("resize: {e}")))?;
    RgbImage::from_raw(out.width, out.height, dst.into_vec())
}

/// Separable Gaussian blur (kernel radius 3σ, edges clamped).
#[must_use]
pub fn gaussian_blur(img: &RgbImage, sigma: f32) -> RgbImage {
    if sigma <= 0.0 || img.size().is_empty() {
        return img.clone();
    }
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let radius = (sigma * 3.0).ceil() as usize;
    #[allow(clippy::cast_precision_loss)]
    let mut kernel: Vec<f32> = (0..=2 * radius)
        .map(|i| {
            let d = i as f32 - radius as f32;
            (-d * d / (2.0 * sigma * sigma)).exp()
        })
        .collect();
    let sum: f32 = kernel.iter().sum();
    kernel.iter_mut().for_each(|k| *k /= sum);
    let (w, h) = (img.width() as usize, img.height() as usize);
    crate::decode::assert_no_share_held("gaussian_blur");
    let pass = |data: &[u8], horizontal: bool| -> Vec<u8> {
        let mut out = vec![0u8; data.len()];
        out.par_chunks_mut(w * 3).enumerate().for_each(|(y, row)| {
            for x in 0..w {
                let mut acc = [0f32; 3];
                for (i, k) in kernel.iter().enumerate() {
                    let off = i as isize - radius as isize;
                    let (sx, sy) = if horizontal {
                        ((x as isize + off).clamp(0, w as isize - 1) as usize, y)
                    } else {
                        (x, (y as isize + off).clamp(0, h as isize - 1) as usize)
                    };
                    let p = (sy * w + sx) * 3;
                    for c in 0..3 {
                        acc[c] += f32::from(data[p + c]) * k;
                    }
                }
                for c in 0..3 {
                    row[x * 3 + c] = to_u8(acc[c]);
                }
            }
        });
        out
    };
    let horizontal = pass(img.as_raw(), true);
    let both = pass(&horizontal, false);
    #[allow(clippy::cast_possible_truncation)]
    RgbImage::from_raw(w as u32, h as u32, both).unwrap_or_else(|_| img.clone())
}

/// Rotates `img` clockwise by `degrees` about its center onto an expanded
/// canvas that contains the whole rotated image (black corners) — the
/// semantics of sharp's `rotate(angle)` used by the legacy "Align Face".
/// Returns the image and the transform mapping original → rotated pixels.
#[must_use]
pub fn rotate_expand(img: &RgbImage, degrees: f64) -> (RgbImage, Similarity) {
    let t_size = rotated_size(img.size(), degrees);
    let t = rotation_transform(img.size(), degrees);
    if degrees.abs() < 1e-9 {
        return (img.clone(), t);
    }
    (
        warp_bilinear(img, &t, t_size.width, t_size.height, [0, 0, 0]),
        t,
    )
}

/// Canvas size after rotating an image of `size` by `degrees` with expansion.
#[must_use]
pub fn rotated_size(size: Size, degrees: f64) -> Size {
    let (s, c) = degrees.to_radians().sin_cos();
    let (w, h) = (f64::from(size.width), f64::from(size.height));
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let dim = |v: f64| (v - 1e-6).ceil().max(1.0) as u32;
    Size::new(
        dim(w * c.abs() + h * s.abs()),
        dim(w * s.abs() + h * c.abs()),
    )
}

/// Transform mapping original pixels to the expanded rotated canvas.
#[must_use]
pub fn rotation_transform(size: Size, degrees: f64) -> Similarity {
    let out = rotated_size(size, degrees);
    let c_in = Point::new(f64::from(size.width) / 2.0, f64::from(size.height) / 2.0);
    let c_out = Point::new(f64::from(out.width) / 2.0, f64::from(out.height) / 2.0);
    Similarity::translation(-c_in.x, -c_in.y)
        .then(&Similarity::from_parts(1.0, degrees.to_radians(), 0.0, 0.0))
        .then(&Similarity::translation(c_out.x, c_out.y))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::decode::tests::pattern;

    fn mean_abs_diff(a: &RgbImage, b: &RgbImage) -> f64 {
        let n = a.as_raw().len().max(1);
        a.as_raw()
            .iter()
            .zip(b.as_raw())
            .map(|(x, y)| f64::from(x.abs_diff(*y)))
            .sum::<f64>()
            / n as f64
    }

    #[test]
    fn identity_warp_reproduces_the_image() {
        let img = pattern(37, 23);
        let out = warp_bilinear(&img, &Similarity::IDENTITY, 37, 23, [9, 9, 9]);
        assert_eq!(out, img);
    }

    #[test]
    fn integer_translation_shifts_pixels_and_fills_border() {
        let img = pattern(20, 10);
        let out = warp_bilinear(&img, &Similarity::translation(3.0, 2.0), 20, 10, [1, 2, 3]);
        assert_eq!(out.pixel(5, 4), img.pixel(2, 2));
        assert_eq!(out.pixel(0, 0), Some([1, 2, 3]));
        assert_eq!(out.pixel(2, 5), Some([1, 2, 3]));
    }

    #[test]
    fn rotation_by_90_degrees_maps_pixels_exactly() {
        let img = pattern(8, 6);
        let (rot, t) = rotate_expand(&img, 90.0);
        assert_eq!(rot.size(), Size::new(6, 8));
        // Clockwise: original top-left pixel ends up top-right.
        assert_eq!(rot.pixel(5, 0), img.pixel(0, 0));
        assert_eq!(rot.pixel(0, 7), img.pixel(7, 5));
        let p = t.apply(Point::new(0.5, 0.5));
        assert!(
            (p.x - 5.5).abs() < 1e-9 && (p.y - 0.5).abs() < 1e-9,
            "{p:?}"
        );
        let (same, id) = rotate_expand(&img, 0.0);
        assert_eq!(same, img);
        assert!((id.tx).abs() < 1e-9);
    }

    #[test]
    fn rotated_size_expands_the_canvas() {
        assert_eq!(rotated_size(Size::new(100, 50), 0.0), Size::new(100, 50));
        assert_eq!(rotated_size(Size::new(100, 50), 90.0), Size::new(50, 100));
        let s = rotated_size(Size::new(100, 100), 45.0);
        assert_eq!(s, Size::new(142, 142));
        assert_eq!(
            rotated_size(Size::new(100, 50), -10.0),
            rotated_size(Size::new(100, 50), 10.0)
        );
    }

    #[test]
    fn warp_matches_resize_for_pure_downscale() {
        let img = pattern(200, 100);
        let half = warp_bilinear(&img, &Similarity::scaling(0.5), 100, 50, [0, 0, 0]);
        let reference = img.resized(100, 50, Filter::Bilinear).expect("resize");
        assert!(mean_abs_diff(&half, &reference) < 3.0);
    }

    #[test]
    fn degenerate_transform_leaves_border() {
        let img = pattern(4, 4);
        let out = warp_bilinear(&img, &Similarity::scaling(0.0), 3, 3, [7, 7, 7]);
        assert!(out.as_raw().iter().all(|&v| v == 7));
        let mut canvas = RgbImage::filled(3, 3, [5, 5, 5]);
        warp_over(&img, &Similarity::scaling(0.0), &mut canvas, 2.0);
        assert!(canvas.as_raw().iter().all(|&v| v == 5));
        let empty = RgbImage::new(0, 0);
        let out = warp_bilinear(&empty, &Similarity::IDENTITY, 2, 2, [1, 1, 1]);
        assert!(out.as_raw().iter().all(|&v| v == 1));
    }

    #[test]
    fn feathered_composite_ramps_at_the_edge() {
        let fg = RgbImage::filled(100, 100, [200, 200, 200]);
        let mut canvas = RgbImage::filled(120, 120, [0, 0, 0]);
        warp_over(&fg, &Similarity::translation(10.0, 10.0), &mut canvas, 4.0);
        assert_eq!(canvas.pixel(5, 50), Some([0, 0, 0])); // outside
        assert_eq!(canvas.pixel(60, 60), Some([200, 200, 200])); // deep inside
        // Pixel center 0.5 px inside the edge → alpha 0.5/4.
        let edge = canvas.pixel(10, 60).expect("px")[0];
        assert!((20..=30).contains(&edge), "{edge}");
        let ramp = canvas.pixel(12, 60).expect("px")[0];
        assert!(ramp > edge && ramp < 200, "{ramp}");
        // Zero feather = hard edge.
        let mut hard = RgbImage::filled(120, 120, [0, 0, 0]);
        warp_over(&fg, &Similarity::translation(10.0, 10.0), &mut hard, 0.0);
        assert_eq!(hard.pixel(10, 60), Some([200, 200, 200]));
    }

    #[test]
    fn backdrops() {
        let src = RgbImage::filled(400, 300, [100, 200, 40]);
        let out = Size::new(160, 160);
        let black = backdrop(&src, out, BackdropMode::Black).expect("black");
        assert!(black.as_raw().iter().all(|&v| v == 0));
        let dimmed = backdrop(&src, out, BackdropMode::Dimmed).expect("dimmed");
        assert_eq!(dimmed.size(), out);
        assert_eq!(dimmed.pixel(80, 80), Some([45, 90, 18]));
        let blurred = backdrop(&src, out, BackdropMode::Blurred).expect("blurred");
        assert_eq!(blurred.pixel(10, 150), Some([60, 120, 24]));
        assert!(backdrop(&RgbImage::new(0, 0), out, BackdropMode::Dimmed).is_err());
    }

    #[test]
    fn cover_crops_the_center() {
        // Left half red, right half blue; a square cover keeps the middle.
        let mut img = RgbImage::filled(200, 100, [0, 0, 255]);
        for y in 0..100 {
            for x in 0..100 {
                let i = (y * 200 + x) * 3;
                img.as_raw_mut()[i..i + 3].copy_from_slice(&[255, 0, 0]);
            }
        }
        let c = cover(&img, Size::new(50, 50)).expect("cover");
        assert_eq!(c.pixel(5, 25).map(|p| p[0] > 200), Some(true));
        assert_eq!(c.pixel(45, 25).map(|p| p[2] > 200), Some(true));
    }

    #[test]
    fn gaussian_blur_preserves_flat_and_smooths_edges() {
        let flat = RgbImage::filled(20, 20, [50, 60, 70]);
        assert_eq!(gaussian_blur(&flat, 2.0), flat);
        assert_eq!(gaussian_blur(&flat, 0.0), flat);
        let mut step = RgbImage::filled(20, 1, [0, 0, 0]);
        for x in 10..20 {
            step.as_raw_mut()[x * 3] = 255;
        }
        let b = gaussian_blur(&step, 1.5);
        let v9 = b.pixel(9, 0).expect("px")[0];
        let v10 = b.pixel(10, 0).expect("px")[0];
        assert!(v9 > 20 && v9 < 128 && v10 > 128 && v10 < 235, "{v9} {v10}");
    }

    #[test]
    fn feather_width_rule() {
        assert!((feather_px(Size::new(1920, 1080)) - 7.68).abs() < 1e-4);
        assert!((feather_px(Size::new(300, 200)) - 2.0).abs() < 1e-6);
        let hd = Size::new(1920, 1080);
        assert!((feather_for(hd, BackdropMode::Extended) - 48.0).abs() < 1e-3);
        for m in [
            BackdropMode::Dimmed,
            BackdropMode::Blurred,
            BackdropMode::Black,
        ] {
            assert!((feather_for(hd, m) - 7.68).abs() < 1e-4);
        }
        assert!((feather_for(Size::new(50, 40), BackdropMode::Extended) - 2.0).abs() < 1e-6);
    }

    #[test]
    fn extended_is_the_default_wire_value() {
        assert_eq!(BackdropMode::default(), BackdropMode::Extended);
        let json = serde_json::to_string(&[
            BackdropMode::Dimmed,
            BackdropMode::Blurred,
            BackdropMode::Black,
            BackdropMode::Extended,
        ])
        .expect("json");
        assert_eq!(json, r#"["dimmed","blurred","black","extended"]"#);
        let back: BackdropMode = serde_json::from_str(r#""extended""#).expect("parse");
        assert_eq!(back, BackdropMode::Extended);
    }

    #[test]
    fn cover_transform_centers_and_covers() {
        let t = cover_transform(Size::new(200, 100), Size::new(50, 50));
        let tl = t.apply(Point::new(0.0, 0.0));
        let br = t.apply(Point::new(200.0, 100.0));
        assert!((tl.y).abs() < 1e-9 && (br.y - 50.0).abs() < 1e-9);
        assert!((tl.x + 25.0).abs() < 1e-9 && (br.x - 75.0).abs() < 1e-9);
    }
}
