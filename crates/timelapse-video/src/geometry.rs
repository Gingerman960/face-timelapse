//! Output size selection and placement of source frames on the output canvas.

use serde::{Deserialize, Serialize};

/// Largest long side the H.264 encoder accepts (openh264 tops out at level 5.2).
pub const MAX_LONG_SIDE: u32 = 3840;
/// Largest short side the H.264 encoder accepts.
pub const MAX_SHORT_SIDE: u32 = 2160;
/// Smallest dimension we produce (H.264 macroblocks are 16 px; tiny videos
/// are useless and some decoders reject them).
pub const MIN_SIDE: u32 = 16;

/// Output resolution preset.
///
/// Presets describe a bounding box (`3840x2160`, `1920x1080`, `1280x720`)
/// oriented like the source (portrait sources get a portrait box). The output
/// is the largest even-sized rectangle with the source aspect ratio that fits
/// the box. Presets may upscale small sources; [`Resolution::Source`] never does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum Resolution {
    /// Keep the source size (rounded to even, capped to the encoder maximum).
    #[serde(rename = "source")]
    Source,
    /// 4K UHD class (fits 3840x2160).
    #[serde(rename = "2160p")]
    P2160,
    /// Full HD class (fits 1920x1080).
    #[default]
    #[serde(rename = "1080p")]
    P1080,
    /// HD class (fits 1280x720).
    #[serde(rename = "720p")]
    P720,
}

impl Resolution {
    /// Bounding box `(long, short)` of the preset, `None` for [`Resolution::Source`].
    #[must_use]
    pub fn bounding_box(self) -> Option<(u32, u32)> {
        match self {
            Self::Source => None,
            Self::P2160 => Some((3840, 2160)),
            Self::P1080 => Some((1920, 1080)),
            Self::P720 => Some((1280, 720)),
        }
    }

    /// Computes the output `(width, height)` for a source of `src_w x src_h`.
    ///
    /// The result is always even, at least [`MIN_SIDE`], within the encoder
    /// limits, and as close as possible to the source aspect ratio.
    /// Returns `None` if a source dimension is zero.
    #[must_use]
    pub fn output_size(self, src_w: u32, src_h: u32) -> Option<(u32, u32)> {
        if src_w == 0 || src_h == 0 {
            return None;
        }
        let landscape = src_w >= src_h;
        let (box_long, box_short) = match self.bounding_box() {
            Some(bbox) => bbox,
            None => {
                let (long, short) = if landscape {
                    (src_w, src_h)
                } else {
                    (src_h, src_w)
                };
                (long.min(MAX_LONG_SIDE), short.min(MAX_SHORT_SIDE))
            }
        };
        let (box_w, box_h) = if landscape {
            (box_long, box_short)
        } else {
            (box_short, box_long)
        };
        Some(fit_even(src_w, src_h, box_w, box_h))
    }
}

/// Largest even `(w, h)` with the aspect of `src_w:src_h` that fits in `box_w x box_h`.
fn fit_even(src_w: u32, src_h: u32, box_w: u32, box_h: u32) -> (u32, u32) {
    let (sw, sh) = (f64::from(src_w), f64::from(src_h));
    let scale = (f64::from(box_w) / sw).min(f64::from(box_h) / sh);
    let w = round_even(sw * scale).min(box_w & !1);
    let h = round_even(sh * scale).min(box_h & !1);
    (w.max(MIN_SIDE), h.max(MIN_SIDE))
}

/// Rounds to the nearest even integer (ties go up), never below 2.
#[must_use]
pub fn round_even(x: f64) -> u32 {
    let half = (x / 2.0).round().max(1.0);
    // Bounded by MAX_LONG_SIDE in all callers; the cast saturates otherwise.
    (half as u32).saturating_mul(2)
}

/// How a frame whose aspect differs from the output is placed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ScaleMode {
    /// Scale to fit inside the output and fill the rest with the background
    /// colour (letterbox / pillarbox). Nothing is cropped.
    #[default]
    Fit,
    /// Scale to cover the whole output, cropping the overflow evenly.
    Fill,
}

/// Placement of a (possibly cropped) source image on the output canvas.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Placement {
    /// Source crop rectangle `(left, top, width, height)` in source pixels.
    pub src_crop: (f64, f64, f64, f64),
    /// Destination rectangle `(x, y, width, height)` on the canvas.
    pub dst: (u32, u32, u32, u32),
}

impl Placement {
    /// True when the destination covers the whole canvas (no background shows).
    #[must_use]
    pub fn covers(&self, out_w: u32, out_h: u32) -> bool {
        self.dst == (0, 0, out_w, out_h)
    }
}

/// Computes where a `src_w x src_h` frame goes on an `out_w x out_h` canvas.
#[must_use]
pub fn place(src_w: u32, src_h: u32, out_w: u32, out_h: u32, mode: ScaleMode) -> Placement {
    let (sw, sh) = (f64::from(src_w), f64::from(src_h));
    let (ow, oh) = (f64::from(out_w), f64::from(out_h));
    match mode {
        ScaleMode::Fit => {
            let scale = (ow / sw).min(oh / sh);
            let w = ((sw * scale).round() as u32).clamp(1, out_w);
            let h = ((sh * scale).round() as u32).clamp(1, out_h);
            Placement {
                src_crop: (0.0, 0.0, sw, sh),
                dst: ((out_w - w) / 2, (out_h - h) / 2, w, h),
            }
        }
        ScaleMode::Fill => {
            let scale = (ow / sw).max(oh / sh);
            let crop_w = (ow / scale).min(sw);
            let crop_h = (oh / scale).min(sh);
            Placement {
                src_crop: ((sw - crop_w) / 2.0, (sh - crop_h) / 2.0, crop_w, crop_h),
                dst: (0, 0, out_w, out_h),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presets_fit_landscape_and_portrait_boxes() {
        // 4:3 landscape phone photo.
        assert_eq!(
            Resolution::P1080.output_size(4032, 3024),
            Some((1440, 1080))
        );
        assert_eq!(
            Resolution::P2160.output_size(4032, 3024),
            Some((2880, 2160))
        );
        assert_eq!(Resolution::P720.output_size(4032, 3024), Some((960, 720)));
        // 16:9 exactly fills the box.
        assert_eq!(
            Resolution::P1080.output_size(3840, 2160),
            Some((1920, 1080))
        );
        // Portrait legacy output size 2362x3330 gets a portrait box (1080 wide),
        // which matches the legacy 1080x1522 export.
        assert_eq!(
            Resolution::P1080.output_size(2362, 3330),
            Some((1080, 1522))
        );
        // Ultra-wide is limited by the long side.
        assert_eq!(Resolution::P1080.output_size(3440, 1440), Some((1920, 804)));
    }

    #[test]
    fn presets_upscale_small_sources() {
        assert_eq!(Resolution::P1080.output_size(512, 512), Some((1080, 1080)));
        assert_eq!(Resolution::P720.output_size(400, 300), Some((960, 720)));
    }

    #[test]
    fn source_keeps_size_rounded_to_even_and_capped() {
        assert_eq!(
            Resolution::Source.output_size(1080, 1522),
            Some((1080, 1522))
        );
        // Odd sizes are truncated to even like the legacy `trunc(iw/2)*2` filter.
        assert_eq!(Resolution::Source.output_size(511, 383), Some((510, 382)));
        // Larger than the encoder limit: scaled down into 2160x3840.
        let (w, h) = Resolution::Source.output_size(2362, 3330).unwrap();
        assert_eq!(h, 3046);
        assert_eq!(w, 2160);
        let (w, h) = Resolution::Source.output_size(4032, 3024).unwrap();
        assert_eq!((w, h), (2880, 2160));
        assert_eq!(Resolution::Source.output_size(0, 10), None);
    }

    #[test]
    fn outputs_are_always_even_and_within_limits() {
        let sizes = [
            (1, 1),
            (3, 1000),
            (1000, 3),
            (4033, 3025),
            (17, 9),
            (5000, 5000),
        ];
        for res in [
            Resolution::Source,
            Resolution::P2160,
            Resolution::P1080,
            Resolution::P720,
        ] {
            for (w, h) in sizes {
                let (ow, oh) = res.output_size(w, h).unwrap();
                assert_eq!(ow % 2, 0, "{res:?} {w}x{h}");
                assert_eq!(oh % 2, 0, "{res:?} {w}x{h}");
                assert!(ow >= MIN_SIDE && oh >= MIN_SIDE);
                assert!(ow.max(oh) <= MAX_LONG_SIDE && ow.min(oh) <= MAX_SHORT_SIDE);
            }
        }
    }

    #[test]
    fn aspect_ratio_is_preserved_within_rounding() {
        for (w, h) in [
            (4032, 3024),
            (3264, 2448),
            (1080, 1522),
            (2362, 3330),
            (1000, 333),
        ] {
            let (ow, oh) = Resolution::P1080.output_size(w, h).unwrap();
            let src = f64::from(w) / f64::from(h);
            let out = f64::from(ow) / f64::from(oh);
            // One even step of error on the shorter side at most.
            let tolerance = 2.0 / f64::from(ow.min(oh)) * src.max(1.0);
            assert!((src - out).abs() <= tolerance, "{w}x{h} -> {ow}x{oh}");
        }
    }

    #[test]
    fn round_even_rounds_to_nearest_even() {
        assert_eq!(round_even(0.0), 2);
        assert_eq!(round_even(2.9), 2);
        assert_eq!(round_even(3.0), 4);
        assert_eq!(round_even(1079.4), 1080);
        assert_eq!(round_even(765.9), 766);
    }

    #[test]
    fn fit_letterboxes_and_centers() {
        // 4:3 into 16:9: pillarbox.
        let p = place(4032, 3024, 1920, 1080, ScaleMode::Fit);
        assert_eq!(p.dst, (240, 0, 1440, 1080));
        assert_eq!(p.src_crop, (0.0, 0.0, 4032.0, 3024.0));
        assert!(!p.covers(1920, 1080));
        // Same aspect covers the canvas.
        let p = place(3840, 2160, 1920, 1080, ScaleMode::Fit);
        assert!(p.covers(1920, 1080));
        // Tall frame into landscape canvas: centred column.
        let p = place(100, 1000, 1000, 100, ScaleMode::Fit);
        assert_eq!(p.dst, (495, 0, 10, 100));
    }

    #[test]
    fn fill_crops_evenly() {
        let p = place(4032, 3024, 1920, 1080, ScaleMode::Fill);
        assert!(p.covers(1920, 1080));
        let (left, top, w, h) = p.src_crop;
        assert_eq!(left, 0.0);
        assert!((w - 4032.0).abs() < 1e-9);
        assert!((h - 2268.0).abs() < 1e-9);
        assert!((top - 378.0).abs() < 1e-9);
    }
}
