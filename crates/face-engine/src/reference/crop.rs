//! Crop geometry of the reference: aspect presets, the legacy
//! `computeARCrop` / "Center Face" math, carrying a crop through a rotation,
//! and crop validation. Pure functions in pixels of the rotated image.

use serde::{Deserialize, Serialize};

use crate::error::{EngineError, Result};
use crate::geometry::{Point, Rect, Similarity, Size};

/// Output aspect presets (wire values as in the IPC contract).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
pub enum AspectPreset {
    /// Any aspect.
    #[default]
    #[serde(rename = "free")]
    Free,
    /// 1:1.
    #[serde(rename = "1:1")]
    Square,
    /// 4:3.
    #[serde(rename = "4:3")]
    Landscape4x3,
    /// 3:4.
    #[serde(rename = "3:4")]
    Portrait3x4,
    /// 4:5.
    #[serde(rename = "4:5")]
    Portrait4x5,
    /// 16:9.
    #[serde(rename = "16:9")]
    Landscape16x9,
    /// 9:16.
    #[serde(rename = "9:16")]
    Portrait9x16,
}

impl AspectPreset {
    /// All presets in UI order.
    pub const ALL: [Self; 7] = [
        Self::Free,
        Self::Square,
        Self::Landscape4x3,
        Self::Portrait3x4,
        Self::Portrait4x5,
        Self::Landscape16x9,
        Self::Portrait9x16,
    ];

    /// Width / height, `None` for [`AspectPreset::Free`].
    #[must_use]
    pub fn ratio(self) -> Option<f64> {
        match self {
            Self::Free => None,
            Self::Square => Some(1.0),
            Self::Landscape4x3 => Some(4.0 / 3.0),
            Self::Portrait3x4 => Some(3.0 / 4.0),
            Self::Portrait4x5 => Some(4.0 / 5.0),
            Self::Landscape16x9 => Some(16.0 / 9.0),
            Self::Portrait9x16 => Some(9.0 / 16.0),
        }
    }
}

/// Largest crop of `aspect` centered on `center` and clamped inside `image`
/// (legacy `computeARCrop`, in image pixels). `Free` = the whole image.
#[must_use]
pub fn aspect_crop(image: Size, center: Point, aspect: AspectPreset) -> Rect {
    let (pw, ph) = (f64::from(image.width), f64::from(image.height));
    let Some(ar) = aspect.ratio() else {
        return Rect::new(0.0, 0.0, pw, ph);
    };
    let mut cw = pw;
    let mut ch = cw / ar;
    if ch > ph {
        ch = ph;
        cw = ch * ar;
    }
    let (cw, ch) = (cw.round(), ch.round());
    let x = (center.x - cw / 2.0).round().clamp(0.0, (pw - cw).max(0.0));
    let y = (center.y - ch / 2.0).round().clamp(0.0, (ph - ch).max(0.0));
    Rect::new(x, y, cw, ch)
}

/// Default crop: the largest `aspect` crop centered in the image.
#[must_use]
pub fn default_crop(image: Size, aspect: AspectPreset) -> Rect {
    let c = Point::new(f64::from(image.width) / 2.0, f64::from(image.height) / 2.0);
    aspect_crop(image, c, aspect)
}

/// Legacy "Center Face": keeps the crop size unless the face cannot be
/// exactly centered, in which case the crop shrinks (keeping the aspect when
/// locked); then centers the crop on the face box and clamps it.
#[must_use]
pub fn center_on_face(crop: Rect, face_box: Rect, image: Size, aspect: AspectPreset) -> Rect {
    let (pw, ph) = (f64::from(image.width), f64::from(image.height));
    let c = face_box.center();
    let max_w = c.x.min(pw - c.x) * 2.0;
    let max_h = c.y.min(ph - c.y) * 2.0;
    let (mut cw, mut ch) = (crop.width, crop.height);
    if cw > max_w || ch > max_h {
        if let Some(ar) = aspect.ratio() {
            cw = cw.min(max_w);
            ch = (cw / ar).round();
            if ch > max_h {
                ch = max_h;
                cw = (ch * ar).round();
            }
        } else {
            cw = cw.min(max_w);
            ch = ch.min(max_h);
        }
    }
    let x = (c.x - cw / 2.0).round();
    let y = (c.y - ch / 2.0).round();
    clamp_box(Rect::new(x, y, cw, ch), image)
}

/// Where `crop` — pixels of the photo rotated by `from_deg` onto a canvas of
/// `from` — lands on the photo rotated by `to_deg` (canvas `to`), so changing
/// the rotation keeps the same part of the photo framed: the crop's centre
/// follows the photo, its size is kept (a rotation does not scale), and it is
/// only nudged back inside the new canvas, or shrunk with its aspect when the
/// canvas became smaller than it. It is never re-centred.
#[must_use]
pub fn rotate_crop(crop: Rect, from: (Size, f64), to: (Size, f64), aspect: AspectPreset) -> Rect {
    let ((from, from_deg), (to, to_deg)) = (from, to);
    let half = |s: Size| Point::new(f64::from(s.width) / 2.0, f64::from(s.height) / 2.0);
    let (c0, c1) = (half(from), half(to));
    // Both canvases rotate the photo about its centre onto their own centre
    // (`warp::rotation_transform`), so one maps onto the other by the
    // difference of the angles about the canvas centres.
    let t = Similarity::translation(-c0.x, -c0.y)
        .then(&Similarity::from_parts(
            1.0,
            (to_deg - from_deg).to_radians(),
            0.0,
            0.0,
        ))
        .then(&Similarity::translation(c1.x, c1.y));
    let center = t.apply(crop.center());
    let (pw, ph) = (f64::from(to.width), f64::from(to.height));
    let (w, h) = if aspect.ratio().is_some() {
        let k = (pw / crop.width).min(ph / crop.height).min(1.0);
        (crop.width * k, crop.height * k)
    } else {
        (crop.width.min(pw), crop.height.min(ph))
    };
    let x = (center.x - w / 2.0).clamp(0.0, (pw - w).max(0.0));
    let y = (center.y - h / 2.0).clamp(0.0, (ph - h).max(0.0));
    Rect::new(x, y, w, h)
}

/// `crop` on whole pixels: the stored crop is exactly what the frames were
/// rendered with, whatever produced it (the UI's Level and Centre, a
/// rotation carrying the crop), and it still passes [`check_crop`].
///
/// A free crop has each edge rounded to the nearest pixel. A locked crop
/// takes the whole size nearest to its own whose aspect stays within
/// [`ASPECT_TOLERANCE`] (rounding both sides of a small crop on its own can
/// drift by ~3 %), re-centred on the same point; either is kept inside the
/// image (at least 1 × 1).
#[must_use]
pub fn snap_crop(crop: Rect, image: Size, aspect: AspectPreset) -> Rect {
    let edges = snap_edges(crop, image);
    let Some(ratio) = aspect.ratio() else {
        return edges;
    };
    /// Sizes tried either side of the rounded width.
    const REACH: i32 = 8;
    let (pw, ph) = (f64::from(image.width), f64::from(image.height));
    let allowed = |w: f64, h: f64| {
        (1.0..=pw).contains(&w)
            && (1.0..=ph).contains(&h)
            && ((w / h) / ratio - 1.0).abs() <= ASPECT_TOLERANCE
            && (w >= MIN_CROP_PX || crop.width < MIN_CROP_PX)
            && (h >= MIN_CROP_PX || crop.height < MIN_CROP_PX)
    };
    let best = (-REACH..=REACH)
        .map(|dw| crop.width.round() + f64::from(dw))
        .flat_map(|w| [(w, (w / ratio).floor()), (w, (w / ratio).ceil())])
        .filter(|&(w, h)| allowed(w, h))
        .min_by(|a, b| {
            let cost = |(w, h): (f64, f64)| (w - crop.width).abs() + (h - crop.height).abs();
            cost(*a).total_cmp(&cost(*b))
        });
    let Some((w, h)) = best else {
        return edges;
    };
    let c = crop.center();
    let x = (c.x - w / 2.0).round().clamp(0.0, pw - w);
    let y = (c.y - h / 2.0).round().clamp(0.0, ph - h);
    Rect::new(x, y, w, h)
}

/// Each edge of `crop` rounded to the nearest pixel, inside the image.
fn snap_edges(crop: Rect, image: Size) -> Rect {
    let (pw, ph) = (f64::from(image.width), f64::from(image.height));
    let snap = |start: f64, len: f64, limit: f64| {
        let a = start.round().clamp(0.0, (limit - 1.0).max(0.0));
        let b = (start + len).round().clamp(a + 1.0, limit.max(a + 1.0));
        (a, b - a)
    };
    let (x, w) = snap(crop.x, crop.width, pw);
    let (y, h) = snap(crop.y, crop.height, ph);
    Rect::new(x, y, w, h)
}

/// Keeps a box inside the image (minimum 1 px), like the legacy `clampBox`
/// but without its minimum-size rule.
#[must_use]
pub fn clamp_box(b: Rect, image: Size) -> Rect {
    let (pw, ph) = (f64::from(image.width), f64::from(image.height));
    let w = b.width.clamp(1.0, pw.max(1.0));
    let h = b.height.clamp(1.0, ph.max(1.0));
    let x = b.x.clamp(0.0, (pw - w).max(0.0));
    let y = b.y.clamp(0.0, (ph - h).max(0.0));
    Rect::new(x, y, w, h)
}

/// Minimum crop side accepted by [`validate_crop`].
pub const MIN_CROP_PX: f64 = 32.0;

/// How far a crop may poke out of the image (pixels).
pub const CROP_TOLERANCE_PX: f64 = 1.0;

/// Relative aspect tolerance of a locked crop.
pub const ASPECT_TOLERANCE: f64 = 0.01;

/// Why a crop was refused (callers word the message).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CropProblem {
    /// NaN or infinite numbers.
    NotFinite,
    /// Outside the image by more than [`CROP_TOLERANCE_PX`].
    Outside,
    /// Narrower or lower than [`MIN_CROP_PX`].
    TooSmall,
    /// Does not match the locked aspect within [`ASPECT_TOLERANCE`].
    AspectMismatch,
}

impl CropProblem {
    fn message(self) -> &'static str {
        match self {
            Self::NotFinite => "the crop has invalid numbers",
            Self::Outside => "the crop must lie inside the photo",
            Self::TooSmall => "the crop must be at least 32×32 px",
            Self::AspectMismatch => "the crop does not match the aspect ratio",
        }
    }
}

/// Checks a crop against the image (1 px tolerance), the minimum size and the
/// aspect (within 1 % unless free) and returns it clamped inside the image.
///
/// # Errors
/// The [`CropProblem`].
pub fn check_crop(
    crop: Rect,
    image: Size,
    aspect: AspectPreset,
) -> std::result::Result<Rect, CropProblem> {
    let (pw, ph) = (f64::from(image.width), f64::from(image.height));
    if ![crop.x, crop.y, crop.width, crop.height]
        .iter()
        .all(|v| v.is_finite())
    {
        return Err(CropProblem::NotFinite);
    }
    let t = CROP_TOLERANCE_PX;
    if crop.x < -t || crop.y < -t || crop.right() > pw + t || crop.bottom() > ph + t {
        return Err(CropProblem::Outside);
    }
    if crop.width < MIN_CROP_PX || crop.height < MIN_CROP_PX {
        return Err(CropProblem::TooSmall);
    }
    if let Some(ar) = aspect.ratio()
        && ((crop.width / crop.height) / ar - 1.0).abs() > ASPECT_TOLERANCE
    {
        return Err(CropProblem::AspectMismatch);
    }
    let x = crop.x.clamp(0.0, pw);
    let y = crop.y.clamp(0.0, ph);
    Ok(Rect::new(
        x,
        y,
        crop.width.min(pw - x),
        crop.height.min(ph - y),
    ))
}

/// [`check_crop`] as an engine error.
///
/// # Errors
/// [`EngineError::InvalidArgument`] describing the problem.
pub fn validate_crop(crop: Rect, image: Size, aspect: AspectPreset) -> Result<()> {
    check_crop(crop, image, aspect)
        .map(|_| ())
        .map_err(|p| EngineError::InvalidArgument(p.message().into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::reference::rotation_ok;
    use crate::warp;

    fn close(a: Rect, b: Rect) -> bool {
        (a.x - b.x).abs() < 1e-9
            && (a.y - b.y).abs() < 1e-9
            && (a.width - b.width).abs() < 1e-9
            && (a.height - b.height).abs() < 1e-9
    }

    #[test]
    fn presets_and_ratios() {
        assert_eq!(AspectPreset::ALL.len(), 7);
        assert_eq!(AspectPreset::Free.ratio(), None);
        assert_eq!(AspectPreset::Portrait4x5.ratio(), Some(0.8));
        let json = serde_json::to_string(&AspectPreset::ALL).expect("json");
        assert_eq!(json, r#"["free","1:1","4:3","3:4","4:5","16:9","9:16"]"#);
    }

    #[test]
    fn default_crops_match_legacy_compute_ar_crop() {
        let img = Size::new(3200, 2368);
        assert!(close(
            default_crop(img, AspectPreset::Free),
            Rect::new(0.0, 0.0, 3200.0, 2368.0)
        ));
        assert!(close(
            default_crop(img, AspectPreset::Square),
            Rect::new(416.0, 0.0, 2368.0, 2368.0)
        ));
        assert!(close(
            default_crop(img, AspectPreset::Landscape16x9),
            Rect::new(0.0, 284.0, 3200.0, 1800.0)
        ));
        assert!(close(
            default_crop(img, AspectPreset::Portrait4x5),
            Rect::new(653.0, 0.0, 1894.0, 2368.0)
        ));
        // Off-center request is clamped to the image.
        let c = aspect_crop(img, Point::new(0.0, 0.0), AspectPreset::Square);
        assert!(close(c, Rect::new(0.0, 0.0, 2368.0, 2368.0)));
    }

    #[test]
    fn center_on_face_keeps_size_when_possible() {
        let img = Size::new(1000, 800);
        let crop = Rect::new(0.0, 0.0, 400.0, 400.0);
        let face = Rect::new(450.0, 350.0, 100.0, 100.0); // center (500, 400)
        let c = center_on_face(crop, face, img, AspectPreset::Square);
        assert!(close(c, Rect::new(300.0, 200.0, 400.0, 400.0)), "{c:?}");
    }

    #[test]
    fn center_on_face_shrinks_near_edges() {
        let img = Size::new(1000, 800);
        let face = Rect::new(50.0, 350.0, 100.0, 100.0); // center (100, 400)
        let locked = center_on_face(
            Rect::new(0.0, 0.0, 600.0, 450.0),
            face,
            img,
            AspectPreset::Landscape4x3,
        );
        assert!(
            close(locked, Rect::new(0.0, 325.0, 200.0, 150.0)),
            "{locked:?}"
        );
        let free = center_on_face(
            Rect::new(0.0, 0.0, 600.0, 450.0),
            face,
            img,
            AspectPreset::Free,
        );
        assert!(close(free, Rect::new(0.0, 175.0, 200.0, 450.0)), "{free:?}");
        // Height-limited locked crop.
        let face_top = Rect::new(450.0, 50.0, 100.0, 100.0); // center (500, 100)
        let c = center_on_face(
            Rect::new(0.0, 0.0, 400.0, 400.0),
            face_top,
            img,
            AspectPreset::Square,
        );
        assert!(close(c, Rect::new(400.0, 0.0, 200.0, 200.0)), "{c:?}");
    }

    #[test]
    fn clamp_and_validate() {
        let img = Size::new(100, 80);
        assert!(close(
            clamp_box(Rect::new(-10.0, 70.0, 50.0, 50.0), img),
            Rect::new(0.0, 30.0, 50.0, 50.0)
        ));
        assert!(close(
            clamp_box(Rect::new(0.0, 0.0, 500.0, 0.0), img),
            Rect::new(0.0, 0.0, 100.0, 1.0)
        ));
        assert!(validate_crop(Rect::new(0.0, 0.0, 100.0, 80.0), img, AspectPreset::Free).is_ok());
        assert!(validate_crop(Rect::new(-0.5, 0.0, 80.0, 80.0), img, AspectPreset::Square).is_ok());
        assert!(validate_crop(Rect::new(0.0, 0.0, 80.0, 79.5), img, AspectPreset::Square).is_ok());
        for bad in [
            Rect::new(-5.0, 0.0, 50.0, 50.0),
            Rect::new(60.0, 0.0, 50.0, 50.0),
            Rect::new(0.0, 0.0, 20.0, 50.0),
            Rect::new(0.0, 0.0, f64::NAN, 50.0),
        ] {
            assert!(
                validate_crop(bad, img, AspectPreset::Free).is_err(),
                "{bad:?}"
            );
        }
        assert!(validate_crop(Rect::new(0.0, 0.0, 60.0, 50.0), img, AspectPreset::Square).is_err());
    }

    #[test]
    fn check_crop_reports_problems_and_clamps() {
        let size = Size::new(1000, 800);
        let ok = check_crop(
            Rect::new(-0.5, 0.0, 400.0, 300.0),
            size,
            AspectPreset::Landscape4x3,
        )
        .expect("valid");
        assert!(close(ok, Rect::new(0.0, 0.0, 400.0, 300.0)), "{ok:?}");
        let edge = check_crop(
            Rect::new(900.5, 0.0, 100.0, 100.0),
            size,
            AspectPreset::Free,
        )
        .expect("within tolerance");
        assert!(
            (edge.right() - 1000.0).abs() < 1e-9,
            "clamped inside: {edge:?}"
        );
        for (crop, aspect, problem) in [
            (
                Rect::new(700.0, 0.0, 400.0, 300.0),
                AspectPreset::Free,
                CropProblem::Outside,
            ),
            (
                Rect::new(0.0, 0.0, 31.0, 40.0),
                AspectPreset::Free,
                CropProblem::TooSmall,
            ),
            (
                Rect::new(0.0, 0.0, 400.0, 400.0),
                AspectPreset::Landscape16x9,
                CropProblem::AspectMismatch,
            ),
            (
                Rect::new(f64::NAN, 0.0, 400.0, 400.0),
                AspectPreset::Free,
                CropProblem::NotFinite,
            ),
        ] {
            assert_eq!(check_crop(crop, size, aspect), Err(problem));
            assert!(!problem.message().is_empty());
        }
        assert!(rotation_ok(45.0) && rotation_ok(-45.0) && rotation_ok(0.0));
        assert!(!rotation_ok(-45.1) && !rotation_ok(f64::INFINITY) && !rotation_ok(f64::NAN));
    }

    #[test]
    fn a_rotated_crop_keeps_framing_the_same_part_of_the_photo() {
        let source = Size::new(4000, 3000);
        let at = |deg: f64| (warp::rotated_size(source, deg), deg);
        // A 3:4 crop around a point of the photo, on the unrotated canvas.
        let face = Point::new(1300.0, 1100.0);
        let crop = Rect::new(face.x - 600.0, face.y - 800.0, 1200.0, 1600.0);
        let rotated = rotate_crop(crop, at(0.0), at(8.0), AspectPreset::Portrait3x4);
        let expected = warp::rotation_transform(source, 8.0).apply(face);
        let c = rotated.center();
        assert!((c.x - expected.x).abs() < 1e-6 && (c.y - expected.y).abs() < 1e-6);
        assert_eq!((rotated.width, rotated.height), (1200.0, 1600.0));
        // Between two rotations, and back again.
        let further = rotate_crop(rotated, at(8.0), at(-5.0), AspectPreset::Portrait3x4);
        let expected = warp::rotation_transform(source, -5.0).apply(face);
        assert!((further.center().x - expected.x).abs() < 1e-6);
        assert!((further.center().y - expected.y).abs() < 1e-6);
        let back = rotate_crop(further, at(-5.0), at(0.0), AspectPreset::Portrait3x4);
        assert!(close(back, crop), "{back:?} vs {crop:?}");
    }

    #[test]
    fn crops_snap_to_whole_pixels_inside_the_image() {
        let image = Size::new(100, 80);
        // Edges round to the nearest pixel (Level/Centre write such crops).
        let s = snap_crop(Rect::new(10.4, 20.6, 40.3, 50.2), image, AspectPreset::Free);
        assert_eq!((s.x, s.y, s.width, s.height), (10.0, 21.0, 41.0, 50.0));
        assert_eq!(check_crop(s, image, AspectPreset::Free), Ok(s));
        // Whole crops are unchanged; edges past the image are pulled in.
        let whole = Rect::new(4.0, 2.0, 36.0, 48.0);
        assert_eq!(snap_crop(whole, image, AspectPreset::Free), whole);
        let out = snap_crop(
            Rect::new(-0.4, 70.2, 100.7, 10.4),
            image,
            AspectPreset::Free,
        );
        assert_eq!(
            (out.x, out.y, out.width, out.height),
            (0.0, 70.0, 100.0, 10.0)
        );
        let empty = snap_crop(Rect::new(99.8, 79.9, 0.1, 0.1), image, AspectPreset::Free);
        assert!(empty.width >= 1.0 && empty.right() <= 100.0 && empty.bottom() <= 80.0);
    }

    #[test]
    fn snapped_locked_crops_keep_their_aspect_at_every_small_size() {
        // Every preset, every width from the minimum to 300 px, fractional
        // positions, in a roomy image and pressed against its far corner.
        for aspect in AspectPreset::ALL {
            let Some(ratio) = aspect.ratio() else {
                continue;
            };
            for w in 32..=300u32 {
                let width = f64::from(w) + 0.37;
                let height = width / ratio;
                if height < MIN_CROP_PX {
                    continue;
                }
                for image in [
                    Size::new(2000, 2000),
                    Size::new(w + 1, height.ceil() as u32 + 1),
                ] {
                    let (pw, ph) = (f64::from(image.width), f64::from(image.height));
                    let crop = Rect::new(
                        (pw - width - 0.2).max(0.0),
                        (ph - height - 0.4).max(0.0),
                        width.min(pw),
                        height.min(ph),
                    );
                    let s = snap_crop(crop, image, aspect);
                    for v in [s.x, s.y, s.width, s.height] {
                        assert_eq!(v, v.round(), "{aspect:?} {crop:?} → {s:?}");
                    }
                    assert_eq!(
                        check_crop(s, image, aspect),
                        Ok(s),
                        "{aspect:?} {crop:?} → {s:?}"
                    );
                    let (dc, dw) = (
                        (s.center().x - crop.center().x).abs()
                            + (s.center().y - crop.center().y).abs(),
                        (s.width - crop.width).abs(),
                    );
                    assert!(dc <= 6.0 && dw <= 8.0, "{aspect:?} {crop:?} → {s:?}");
                }
            }
        }
    }

    #[test]
    fn a_rotated_crop_is_nudged_or_shrunk_into_the_new_canvas() {
        let source = Size::new(1000, 800);
        let at = |deg: f64| (warp::rotated_size(source, deg), deg);
        let (wide, _) = at(20.0);
        // Against the corner of the expanded canvas: nudged inside, same size.
        let corner = Rect::new(0.0, 0.0, 300.0, 400.0);
        let nudged = rotate_crop(corner, at(20.0), at(0.0), AspectPreset::Portrait3x4);
        assert_eq!((nudged.width, nudged.height), (300.0, 400.0));
        assert_eq!(
            check_crop(nudged, source, AspectPreset::Portrait3x4),
            Ok(nudged)
        );
        // Larger than the plain photo: shrunk with its aspect, still valid.
        let big = default_crop(wide, AspectPreset::Portrait3x4);
        assert!(big.height > f64::from(source.height));
        let shrunk = rotate_crop(big, at(20.0), at(0.0), AspectPreset::Portrait3x4);
        assert!(shrunk.height <= f64::from(source.height) + 1e-9);
        assert_eq!(
            check_crop(shrunk, source, AspectPreset::Portrait3x4),
            Ok(shrunk)
        );
        // A free crop is clipped per axis.
        let free = rotate_crop(
            Rect::new(0.0, 0.0, f64::from(wide.width), f64::from(wide.height)),
            at(20.0),
            at(0.0),
            AspectPreset::Free,
        );
        assert!(close(free, Rect::new(0.0, 0.0, 1000.0, 800.0)), "{free:?}");
    }
}
