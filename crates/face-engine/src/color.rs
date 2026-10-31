//! Exposure / white-balance normalization ("look", ARCHITECTURE §9.6).
//!
//! Statistics: Oklab mean/std of the face region R of an aligned frame
//! (stride 2, pixels with L in [P2, P98]). Transfer per channel:
//! `x' = (x − μs)·g + μr` with clamped gains, blended by `strength`, for L
//! only (`exposure`) or L, a, b (`exposureAndColor`). Applied through a 33³
//! RGB → RGB 3-D LUT (trilinear), gamut-clipped in linear RGB.

use rayon::prelude::*;
use serde::{Deserialize, Serialize};

use crate::geometry::{Point, Rect, Size};
use crate::image::RgbImage;

/// Which channels the look transfers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NormalizeMode {
    /// No normalization (legacy).
    #[default]
    Off,
    /// Lightness only.
    Exposure,
    /// Lightness and chroma (white balance).
    ExposureAndColor,
}

/// Look settings.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LookSettings {
    /// Mode.
    pub normalize: NormalizeMode,
    /// Blend strength in `[0, 1]`.
    pub strength: f64,
}

impl Default for LookSettings {
    fn default() -> Self {
        Self {
            normalize: NormalizeMode::Off,
            strength: 0.7,
        }
    }
}

impl LookSettings {
    /// Short stable key of the look: `"off"` when normalization is disabled
    /// (identical pixels to the masters), else a hash of mode + strength
    /// (to 1/1000). Names the look-preview folder of a frame store.
    #[must_use]
    pub fn cache_key(&self) -> String {
        let mode = match self.normalize {
            NormalizeMode::Off => return "off".into(),
            NormalizeMode::Exposure => "exposure",
            NormalizeMode::ExposureAndColor => "exposureAndColor",
        };
        #[allow(clippy::cast_possible_truncation)]
        let milli = (self.strength.clamp(0.0, 1.0) * 1000.0).round() as i64;
        crate::align::key_hash(&[mode, &milli.to_string()], 12)
    }
}

/// The look of one frame: its face statistics, the reference statistics and
/// the settings. Cheap to copy; the LUT is built where the pixels are decoded
/// (worker threads), never up front for a whole sequence.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FrameLook {
    /// Statistics of the un-normalized frame.
    pub frame: FaceStats,
    /// Statistics of the reference frame.
    pub reference: FaceStats,
    /// Mode and strength.
    pub settings: LookSettings,
}

impl FrameLook {
    /// The frame's LUT; `None` when the look is a no-op (off, or no change).
    #[must_use]
    pub fn lut(&self) -> Option<Lut3d> {
        Lut3d::for_frame(&self.frame, &self.reference, &self.settings)
    }

    /// Applies the look to `img` in place; false when it was a no-op.
    pub fn apply(&self, img: &mut RgbImage) -> bool {
        apply_look(img, &self.frame, &self.reference, &self.settings)
    }

    /// `lookDelta` of this frame (§9.6).
    #[must_use]
    pub fn delta(&self) -> Option<LookDelta> {
        look_delta(&self.frame, &self.reference, &self.settings)
    }
}

/// Oklab mean and standard deviation (L, a, b) over the face region.
/// Serialized as six floats `[μL, μa, μb, σL, σa, σb]`.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct FaceStats {
    /// Means.
    pub mean: [f32; 3],
    /// Standard deviations.
    pub std: [f32; 3],
}

impl FaceStats {
    /// `[μL, μa, μb, σL, σa, σb]`.
    #[must_use]
    pub fn to_array(&self) -> [f32; 6] {
        [
            self.mean[0],
            self.mean[1],
            self.mean[2],
            self.std[0],
            self.std[1],
            self.std[2],
        ]
    }

    /// Inverse of [`FaceStats::to_array`].
    #[must_use]
    pub fn from_array(v: [f32; 6]) -> Self {
        Self {
            mean: [v[0], v[1], v[2]],
            std: [v[3], v[4], v[5]],
        }
    }
}

/// Magnitude of a look adjustment (§9.6 `lookDelta`).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LookDelta {
    /// `3·log2(μ'L / μL)`; positive = brightened.
    pub exposure_ev: f64,
    /// `100·α·|Δ(a, b)|` in `exposureAndColor`, 0 in `exposure`.
    pub color_shift: f64,
}

// ───────────────────────── colour space ─────────────────────────

/// sRGB-encoded byte → linear light.
fn srgb_to_linear(v: f32) -> f32 {
    if v <= 0.040_45 {
        v / 12.92
    } else {
        ((v + 0.055) / 1.055).powf(2.4)
    }
}

/// Linear light → sRGB-encoded `[0, 1]`.
fn linear_to_srgb(v: f32) -> f32 {
    if v <= 0.003_130_8 {
        v * 12.92
    } else {
        1.055 * v.powf(1.0 / 2.4) - 0.055
    }
}

fn linear_lut() -> &'static [f32; 256] {
    static LUT: std::sync::OnceLock<[f32; 256]> = std::sync::OnceLock::new();
    LUT.get_or_init(|| {
        let mut t = [0f32; 256];
        for (i, v) in t.iter_mut().enumerate() {
            #[allow(clippy::cast_precision_loss)]
            let x = i as f32 / 255.0;
            *v = srgb_to_linear(x);
        }
        t
    })
}

/// Linear sRGB → Oklab.
#[must_use]
pub fn linear_to_oklab(c: [f32; 3]) -> [f32; 3] {
    let l = 0.412_221_47 * c[0] + 0.536_332_55 * c[1] + 0.051_445_995 * c[2];
    let m = 0.211_903_5 * c[0] + 0.680_699_5 * c[1] + 0.107_396_96 * c[2];
    let s = 0.088_302_46 * c[0] + 0.281_718_85 * c[1] + 0.629_978_7 * c[2];
    let (l, m, s) = (l.cbrt(), m.cbrt(), s.cbrt());
    [
        0.210_454_26 * l + 0.793_617_8 * m - 0.004_072_047 * s,
        1.977_998_5 * l - 2.428_592_2 * m + 0.450_593_7 * s,
        0.025_904_037 * l + 0.782_771_77 * m - 0.808_675_77 * s,
    ]
}

/// Oklab → linear sRGB (unclipped).
#[must_use]
pub fn oklab_to_linear(c: [f32; 3]) -> [f32; 3] {
    let l = c[0] + 0.396_337_78 * c[1] + 0.215_803_76 * c[2];
    let m = c[0] - 0.105_561_346 * c[1] - 0.063_854_17 * c[2];
    let s = c[0] - 0.089_484_18 * c[1] - 1.291_485_5 * c[2];
    let (l, m, s) = (l * l * l, m * m * m, s * s * s);
    [
        4.076_741_7 * l - 3.307_711_6 * m + 0.230_969_94 * s,
        -1.268_438 * l + 2.609_757_4 * m - 0.341_319_38 * s,
        -0.004_196_086_3 * l - 0.703_418_6 * m + 1.707_614_7 * s,
    ]
}

/// sRGB bytes → Oklab.
#[must_use]
pub fn rgb8_to_oklab(px: [u8; 3]) -> [f32; 3] {
    let lut = linear_lut();
    linear_to_oklab([
        lut[usize::from(px[0])],
        lut[usize::from(px[1])],
        lut[usize::from(px[2])],
    ])
}

// ───────────────────────── region & statistics ─────────────────────────

/// Face region R (§9.6) in output pixels, from anchors in output pixels,
/// clipped to the frame.
#[must_use]
pub fn face_region(anchors: &[Point; 5], frame: Size) -> Rect {
    let (el, er, ml, mr) = (anchors[0], anchors[1], anchors[3], anchors[4]);
    let ipd = el.distance(er);
    let eye_y = (el.y + er.y) / 2.0;
    let mouth_y = (ml.y + mr.y) / 2.0;
    let x0 = el.x.min(ml.x) - 0.35 * ipd;
    let x1 = er.x.max(mr.x) + 0.35 * ipd;
    let y0 = eye_y - 0.45 * ipd;
    let y1 = mouth_y + 0.35 * ipd;
    Rect::new(x0, y0, x1 - x0, y1 - y0).clipped(f64::from(frame.width), f64::from(frame.height))
}

/// Oklab statistics over `region` (stride 2, L within [P2, P98]).
/// `None` when the region holds fewer than 16 samples.
#[must_use]
pub fn region_stats(img: &RgbImage, region: Rect) -> Option<FaceStats> {
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let (x0, y0, x1, y1) = (
        region.x.max(0.0).floor() as u32,
        region.y.max(0.0).floor() as u32,
        (region.right().ceil() as u32).min(img.width()),
        (region.bottom().ceil() as u32).min(img.height()),
    );
    let mut samples = Vec::new();
    for y in (y0..y1).step_by(2) {
        for x in (x0..x1).step_by(2) {
            if let Some(px) = img.pixel(x, y) {
                samples.push(rgb8_to_oklab(px));
            }
        }
    }
    if samples.len() < 16 {
        return None;
    }
    let mut ls: Vec<f32> = samples.iter().map(|s| s[0]).collect();
    ls.sort_by(f32::total_cmp);
    let pct = |p: f32| {
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            clippy::cast_precision_loss
        )]
        let i = ((ls.len() - 1) as f32 * p).round() as usize;
        ls[i]
    };
    let (lo, hi) = (pct(0.02), pct(0.98));
    let kept: Vec<&[f32; 3]> = samples
        .iter()
        .filter(|s| s[0] >= lo && s[0] <= hi)
        .collect();
    #[allow(clippy::cast_precision_loss)]
    let n = kept.len().max(1) as f64;
    let mut mean = [0f64; 3];
    for s in &kept {
        for c in 0..3 {
            mean[c] += f64::from(s[c]);
        }
    }
    mean.iter_mut().for_each(|m| *m /= n);
    let mut var = [0f64; 3];
    for s in &kept {
        for c in 0..3 {
            var[c] += (f64::from(s[c]) - mean[c]).powi(2);
        }
    }
    #[allow(clippy::cast_possible_truncation)]
    Some(FaceStats {
        mean: mean.map(|m| m as f32),
        std: var.map(|v| (v / n).sqrt() as f32),
    })
}

/// Face statistics of an aligned frame given its anchors in output pixels.
#[must_use]
pub fn face_stats(img: &RgbImage, anchors: &[Point; 5]) -> Option<FaceStats> {
    region_stats(img, face_region(anchors, img.size()))
}

// ───────────────────────── transfer & LUT ─────────────────────────

/// Per-channel affine transfer in Oklab: `x'' = x + α·((x − μs)·g + μr − x)`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Transfer {
    gain: [f32; 3],
    src_mean: [f32; 3],
    ref_mean: [f32; 3],
    strength: f32,
    active: [bool; 3],
}

impl Transfer {
    /// Builds the transfer, or `None` when the look is off or does nothing.
    #[must_use]
    pub fn new(frame: &FaceStats, reference: &FaceStats, look: &LookSettings) -> Option<Self> {
        let active = match look.normalize {
            NormalizeMode::Off => return None,
            NormalizeMode::Exposure => [true, false, false],
            NormalizeMode::ExposureAndColor => [true, true, true],
        };
        #[allow(clippy::cast_possible_truncation)]
        let strength = look.strength.clamp(0.0, 1.0) as f32;
        if strength <= 0.0 {
            return None;
        }
        let gain = |c: usize, lo: f32, hi: f32| {
            let s = frame.std[c];
            if s > 1e-6 {
                (reference.std[c] / s).clamp(lo, hi)
            } else {
                1.0
            }
        };
        Some(Self {
            gain: [gain(0, 0.67, 1.5), gain(1, 0.5, 2.0), gain(2, 0.5, 2.0)],
            src_mean: frame.mean,
            ref_mean: reference.mean,
            strength,
            active,
        })
    }

    /// Applies the transfer to one Oklab colour.
    #[must_use]
    pub fn apply(&self, lab: [f32; 3]) -> [f32; 3] {
        let mut out = lab;
        for c in 0..3 {
            if self.active[c] {
                let target = (lab[c] - self.src_mean[c]) * self.gain[c] + self.ref_mean[c];
                out[c] = lab[c] + self.strength * (target - lab[c]);
            }
        }
        out
    }
}

/// Grid size of the 3-D LUT.
pub const LUT_SIZE: usize = 33;

/// RGB → RGB 3-D lookup table (sRGB bytes in, sRGB bytes out).
#[derive(Debug, Clone, PartialEq)]
pub struct Lut3d {
    /// `LUT_SIZE³` nodes, red fastest, values in 0–255.
    nodes: Vec<[f32; 3]>,
}

impl Lut3d {
    /// Samples `transfer` on a 33³ grid (gamut-clipped in linear RGB).
    #[must_use]
    pub fn build(transfer: &Transfer) -> Self {
        let n = LUT_SIZE;
        #[allow(clippy::cast_precision_loss)]
        let step = 1.0 / (n - 1) as f32;
        crate::decode::assert_no_share_held("LUT build");
        let nodes = (0..n * n * n)
            .into_par_iter()
            .map(|i| {
                let (r, g, b) = (i % n, (i / n) % n, i / (n * n));
                #[allow(clippy::cast_precision_loss)]
                let lin = [r, g, b].map(|v| srgb_to_linear(v as f32 * step));
                let lab = transfer.apply(linear_to_oklab(lin));
                oklab_to_linear(lab).map(|v| linear_to_srgb(v.clamp(0.0, 1.0)) * 255.0)
            })
            .collect();
        Self { nodes }
    }

    /// Builds the LUT for a frame, `None` when the look is a no-op.
    #[must_use]
    pub fn for_frame(
        frame: &FaceStats,
        reference: &FaceStats,
        look: &LookSettings,
    ) -> Option<Self> {
        Transfer::new(frame, reference, look).map(|t| Self::build(&t))
    }

    /// Maps one pixel (trilinear interpolation).
    #[must_use]
    pub fn map(&self, px: [u8; 3]) -> [u8; 3] {
        let n = LUT_SIZE;
        let idx = |v: u8| {
            #[allow(clippy::cast_precision_loss)]
            let p = f32::from(v) * (n - 1) as f32 / 255.0;
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            let i = (p as usize).min(n - 2);
            #[allow(clippy::cast_precision_loss)]
            let f = p - i as f32;
            (i, f)
        };
        let ((r0, fr), (g0, fg), (b0, fb)) = (idx(px[0]), idx(px[1]), idx(px[2]));
        let at = |r: usize, g: usize, b: usize| self.nodes[(b * n + g) * n + r];
        let mut out = [0u8; 3];
        for (c, o) in out.iter_mut().enumerate() {
            let lerp = |a: f32, b: f32, t: f32| a + (b - a) * t;
            let c00 = lerp(at(r0, g0, b0)[c], at(r0 + 1, g0, b0)[c], fr);
            let c10 = lerp(at(r0, g0 + 1, b0)[c], at(r0 + 1, g0 + 1, b0)[c], fr);
            let c01 = lerp(at(r0, g0, b0 + 1)[c], at(r0 + 1, g0, b0 + 1)[c], fr);
            let c11 = lerp(at(r0, g0 + 1, b0 + 1)[c], at(r0 + 1, g0 + 1, b0 + 1)[c], fr);
            let v = lerp(lerp(c00, c10, fg), lerp(c01, c11, fg), fb);
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            {
                *o = (v + 0.5).clamp(0.0, 255.0) as u8;
            }
        }
        out
    }

    /// Applies the LUT to every pixel in place (parallel rows).
    pub fn apply(&self, img: &mut RgbImage) {
        let stride = img.stride().max(1);
        crate::decode::assert_no_share_held("LUT apply");
        img.as_raw_mut().par_chunks_mut(stride).for_each(|row| {
            for px in row.as_chunks_mut::<3>().0 {
                *px = self.map(*px);
            }
        });
    }
}

/// Applies the look to `img` in place; returns false when it was a no-op.
pub fn apply_look(
    img: &mut RgbImage,
    frame: &FaceStats,
    reference: &FaceStats,
    look: &LookSettings,
) -> bool {
    match Lut3d::for_frame(frame, reference, look) {
        Some(lut) => {
            lut.apply(img);
            true
        }
        None => false,
    }
}

/// `lookDelta` from statistics only (§9.6). `None` when the look is off or
/// the frame is too dark to measure.
#[must_use]
pub fn look_delta(
    frame: &FaceStats,
    reference: &FaceStats,
    look: &LookSettings,
) -> Option<LookDelta> {
    if look.normalize == NormalizeMode::Off || frame.mean[0] <= 0.01 {
        return None;
    }
    let alpha = look.strength.clamp(0.0, 1.0);
    let (ls, lr) = (f64::from(frame.mean[0]), f64::from(reference.mean[0]));
    let l_out = ls + alpha * (lr - ls);
    if l_out <= 0.0 {
        return None;
    }
    let exposure_ev = 3.0 * (l_out / ls).log2();
    let color_shift = if look.normalize == NormalizeMode::ExposureAndColor {
        let da = f64::from(reference.mean[1] - frame.mean[1]);
        let db = f64::from(reference.mean[2] - frame.mean[2]);
        100.0 * alpha * da.hypot(db)
    } else {
        0.0
    };
    Some(LookDelta {
        exposure_ev,
        color_shift,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn patch(rgb: [u8; 3], noise: u8) -> RgbImage {
        let mut img = RgbImage::filled(64, 64, rgb);
        // Deterministic texture so σ > 0.
        for (i, v) in img.as_raw_mut().iter_mut().enumerate() {
            #[allow(clippy::cast_possible_truncation)]
            let d = ((i * 7919) % (2 * usize::from(noise) + 1)) as i16 - i16::from(noise);
            *v = (i16::from(*v) + d).clamp(0, 255) as u8;
        }
        img
    }

    fn whole(img: &RgbImage) -> Rect {
        Rect::new(0.0, 0.0, f64::from(img.width()), f64::from(img.height()))
    }

    #[test]
    fn oklab_round_trip_and_reference_values() {
        let white = rgb8_to_oklab([255, 255, 255]);
        assert!((white[0] - 1.0).abs() < 1e-3 && white[1].abs() < 1e-3 && white[2].abs() < 1e-3);
        let black = rgb8_to_oklab([0, 0, 0]);
        assert!(black[0].abs() < 1e-6);
        let red = rgb8_to_oklab([255, 0, 0]);
        assert!((red[0] - 0.628).abs() < 2e-3 && (red[1] - 0.225).abs() < 2e-3);
        for px in [[12u8, 200, 99], [255, 128, 0], [3, 3, 250]] {
            let lin = oklab_to_linear(rgb8_to_oklab(px));
            for c in 0..3 {
                let back = linear_to_srgb(lin[c]) * 255.0;
                assert!((back - f32::from(px[c])).abs() < 0.05, "{px:?}");
            }
        }
    }

    #[test]
    fn stats_on_flat_patch() {
        let img = RgbImage::filled(40, 40, [120, 100, 90]);
        let s = region_stats(&img, whole(&img)).expect("stats");
        let lab = rgb8_to_oklab([120, 100, 90]);
        for (c, v) in lab.iter().enumerate() {
            assert!((s.mean[c] - v).abs() < 1e-5);
            assert!(s.std[c] < 1e-5);
        }
        assert!(region_stats(&img, Rect::new(0.0, 0.0, 4.0, 4.0)).is_none());
        assert_eq!(FaceStats::from_array(s.to_array()), s);
    }

    #[test]
    fn region_matches_definition() {
        let a = [
            Point::new(40.0, 50.0),
            Point::new(60.0, 50.0),
            Point::new(50.0, 60.0),
            Point::new(42.0, 70.0),
            Point::new(58.0, 70.0),
        ];
        let r = face_region(&a, Size::new(100, 100));
        // IPD 20: x ∈ [33, 67], y ∈ [41, 77].
        assert!((r.x - 33.0).abs() < 1e-9 && (r.right() - 67.0).abs() < 1e-9);
        assert!((r.y - 41.0).abs() < 1e-9 && (r.bottom() - 77.0).abs() < 1e-9);
        let clipped = face_region(&a, Size::new(50, 50));
        assert!((clipped.right() - 50.0).abs() < 1e-9);
    }

    #[test]
    fn transfer_hits_target_statistics() {
        let src = patch([90, 70, 60], 14);
        let reference = patch([170, 150, 120], 12);
        let s = region_stats(&src, whole(&src)).expect("src");
        let r = region_stats(&reference, whole(&reference)).expect("ref");
        let look = LookSettings {
            normalize: NormalizeMode::ExposureAndColor,
            strength: 1.0,
        };
        let mut out = src.clone();
        assert!(apply_look(&mut out, &s, &r, &look));
        let o = region_stats(&out, whole(&out)).expect("out");
        for c in 0..3 {
            let tol = 0.02 * r.mean[0].abs().max(0.05);
            assert!(
                (o.mean[c] - r.mean[c]).abs() < tol,
                "mean {c}: {o:?} vs {r:?}"
            );
        }
        // σ follows the (clamped) gain: σ_out = σs · clamp(σr/σs).
        let gains = [(0.67, 1.5), (0.5, 2.0), (0.5, 2.0)];
        for (c, (lo, hi)) in gains.into_iter().enumerate() {
            let expected = s.std[c] * (r.std[c] / s.std[c]).clamp(lo, hi);
            assert!(
                (o.std[c] - expected).abs() < 0.02 * expected + 1e-3,
                "std {c}: {o:?}"
            );
        }
    }

    #[test]
    fn exposure_mode_leaves_chroma_and_strength_zero_is_identity() {
        let src = patch([90, 70, 60], 14);
        let reference = patch([170, 150, 120], 12);
        let s = region_stats(&src, whole(&src)).expect("src");
        let r = region_stats(&reference, whole(&reference)).expect("ref");
        let mut exp = src.clone();
        let look = LookSettings {
            normalize: NormalizeMode::Exposure,
            strength: 1.0,
        };
        assert!(apply_look(&mut exp, &s, &r, &look));
        let e = region_stats(&exp, whole(&exp)).expect("exp");
        assert!((e.mean[0] - r.mean[0]).abs() < 0.01);
        assert!((e.mean[1] - s.mean[1]).abs() < 0.01 && (e.mean[2] - s.mean[2]).abs() < 0.01);

        let zero = LookSettings {
            normalize: NormalizeMode::ExposureAndColor,
            strength: 0.0,
        };
        let mut same = src.clone();
        assert!(!apply_look(&mut same, &s, &r, &zero));
        assert_eq!(same, src);
        let off = LookSettings::default();
        assert!(Lut3d::for_frame(&s, &r, &off).is_none());
    }

    #[test]
    fn identity_transfer_lut_is_near_identity() {
        let stats = FaceStats {
            mean: [0.5, 0.0, 0.0],
            std: [0.1, 0.02, 0.02],
        };
        let look = LookSettings {
            normalize: NormalizeMode::ExposureAndColor,
            strength: 1.0,
        };
        let lut = Lut3d::for_frame(&stats, &stats, &look).expect("lut");
        for px in [[0u8, 0, 0], [255, 255, 255], [10, 200, 90], [128, 64, 32]] {
            let m = lut.map(px);
            for c in 0..3 {
                assert!(m[c].abs_diff(px[c]) <= 2, "{px:?} → {m:?}");
            }
        }
    }

    #[test]
    fn half_strength_moves_halfway() {
        let s = FaceStats {
            mean: [0.4, 0.01, 0.02],
            std: [0.1, 0.02, 0.02],
        };
        let r = FaceStats {
            mean: [0.6, 0.03, 0.02],
            std: [0.1, 0.02, 0.02],
        };
        let t = Transfer::new(
            &s,
            &r,
            &LookSettings {
                normalize: NormalizeMode::ExposureAndColor,
                strength: 0.5,
            },
        )
        .expect("transfer");
        let out = t.apply(s.mean);
        assert!((out[0] - 0.5).abs() < 1e-6 && (out[1] - 0.02).abs() < 1e-6);
    }

    #[test]
    fn look_delta_follows_the_spec() {
        let s = FaceStats {
            mean: [0.5, 0.02, 0.01],
            std: [0.1; 3],
        };
        let r = FaceStats {
            mean: [0.63, 0.05, 0.05],
            std: [0.1; 3],
        };
        let full = LookSettings {
            normalize: NormalizeMode::ExposureAndColor,
            strength: 1.0,
        };
        let d = look_delta(&s, &r, &full).expect("delta");
        assert!((d.exposure_ev - 3.0 * (0.63f64 / 0.5).log2()).abs() < 1e-5);
        assert!((d.color_shift - 100.0 * 0.03f64.hypot(0.04)).abs() < 1e-4);
        let exp = look_delta(
            &s,
            &r,
            &LookSettings {
                normalize: NormalizeMode::Exposure,
                strength: 0.5,
            },
        )
        .expect("delta");
        assert_eq!(exp.color_shift, 0.0);
        assert!(exp.exposure_ev > 0.0 && exp.exposure_ev < d.exposure_ev);
        assert!(look_delta(&s, &r, &LookSettings::default()).is_none());
        let dark = FaceStats {
            mean: [0.005, 0.0, 0.0],
            std: [0.0; 3],
        };
        assert!(look_delta(&dark, &r, &full).is_none());
    }

    #[test]
    fn frame_look_and_cache_keys() {
        let s = FaceStats {
            mean: [0.5, 0.02, 0.01],
            std: [0.1; 3],
        };
        let r = FaceStats {
            mean: [0.63, 0.05, 0.05],
            std: [0.1; 3],
        };
        let on = LookSettings {
            normalize: NormalizeMode::ExposureAndColor,
            strength: 1.0,
        };
        let look = FrameLook {
            frame: s,
            reference: r,
            settings: on,
        };
        assert!(look.lut().is_some());
        assert_eq!(look.delta(), look_delta(&s, &r, &on));
        let mut img = patch([120, 110, 100], 4);
        let before = img.clone();
        assert!(look.apply(&mut img));
        assert_ne!(img, before);
        let off = FrameLook {
            settings: LookSettings::default(),
            ..look
        };
        assert!(off.lut().is_none() && !off.apply(&mut img) && off.delta().is_none());

        assert_eq!(LookSettings::default().cache_key(), "off");
        let k = on.cache_key();
        assert_eq!(k.len(), 12);
        let exposure = LookSettings {
            normalize: NormalizeMode::Exposure,
            ..on
        };
        assert_ne!(k, exposure.cache_key());
        let weaker = LookSettings {
            strength: 0.5,
            ..on
        };
        assert_ne!(k, weaker.cache_key());
        let rounded = LookSettings {
            strength: 1.0 - 1e-6,
            ..on
        };
        assert_eq!(k, rounded.cache_key(), "strength keyed to 1/1000");
    }
}
