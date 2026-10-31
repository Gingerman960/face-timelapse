//! Date caption rendering with the bundled Martian Mono variable font
//! (SIL OFL 1.1, see `assets/fonts/OFL-MartianMono.txt`), the app's data face,
//! set condensed (`wdth` 75) at weight 500 like film edge print.
//!
//! White text over a soft, slightly offset drop shadow keeps the date legible
//! on both bright and dark photos without a heavy box behind it. Digits are
//! laid out on a fixed (tabular) advance so the caption never jitters as days
//! change.

use ab_glyph::{Font, FontRef, GlyphId, PxScale, ScaleFont, VariableFont, point};
use chrono::NaiveDate;

use crate::error::{Result, VideoError};
use crate::options::{CaptionOptions, CaptionPosition};
use crate::yuv420::YuvFrame;

static FONT_BYTES: &[u8] = include_bytes!("../assets/fonts/MartianMono-Variable.ttf");

/// Variation axes applied to the caption font: weight and width.
const FONT_AXES: [([u8; 4], f32); 2] = [(*b"wght", 500.0), (*b"wdth", 75.0)];
/// A monospace word space is a full cell; 60 % keeps the date one unit.
const WORD_SPACE: f32 = 0.6;

/// Distance from the frame edge as a fraction of the shorter frame side.
const MARGIN_FRACTION: f32 = 0.04;
/// Soft drop shadow: offset (down) and blur radius as fractions of the font size.
const SHADOW_OFFSET: f32 = 0.05;
const SHADOW_BLUR: f32 = 0.09;
/// Peak opacity of the soft drop shadow.
const SHADOW_OPACITY: f32 = 0.5;
/// Tight dark halo hugging the glyphs (keeps white text legible on white
/// shirts and sky): dilation radius as a fraction of the font size.
const HALO_RADIUS: f32 = 0.04;
/// Peak opacity of the halo.
const HALO_OPACITY: f32 = 0.55;

/// The bundled caption font with [`FONT_AXES`] applied.
fn caption_font() -> Result<FontRef<'static>> {
    let mut font = FontRef::try_from_slice(FONT_BYTES)
        .map_err(|e| VideoError::Internal(format!("bundled font is invalid: {e}")))?;
    for (tag, value) in FONT_AXES {
        if !font.set_variation(&tag, value) {
            return Err(VideoError::Internal(format!(
                "bundled font lacks the {} axis",
                String::from_utf8_lossy(&tag)
            )));
        }
    }
    Ok(font)
}

/// Where to place a `box_w x box_h` caption on a `canvas_w x canvas_h` frame,
/// `margin` pixels from the edges. Returns the top-left corner (may be
/// negative if the caption is larger than the frame).
#[must_use]
pub fn caption_origin(
    position: CaptionPosition,
    (canvas_w, canvas_h): (u32, u32),
    (box_w, box_h): (u32, u32),
    margin: u32,
) -> (i64, i64) {
    let (cw, ch, bw, bh, m) = (
        i64::from(canvas_w),
        i64::from(canvas_h),
        i64::from(box_w),
        i64::from(box_h),
        i64::from(margin),
    );
    use CaptionPosition as P;
    let x = match position {
        P::TopLeft | P::BottomLeft => m,
        P::TopCenter | P::BottomCenter => (cw - bw) / 2,
        P::TopRight | P::BottomRight => cw - m - bw,
    };
    let y = match position {
        P::TopLeft | P::TopCenter | P::TopRight => m,
        P::BottomLeft | P::BottomCenter | P::BottomRight => ch - m - bh,
    };
    (x, y)
}

/// A rendered caption: an 8-bit coverage mask for the text and its shadow.
#[derive(Debug, Clone, PartialEq)]
pub struct CaptionMask {
    /// Mask width.
    pub width: u32,
    /// Mask height.
    pub height: u32,
    /// Text coverage, `0..=1`.
    pub text: Vec<f32>,
    /// Shadow alpha (already offset, blurred and scaled by opacity).
    pub shadow: Vec<f32>,
    /// Offset of the mask's top-left corner relative to the text box origin.
    pub pad: u32,
    /// Width of the text box (advance width).
    pub box_width: u32,
    /// Height of the text box (ascent + descent).
    pub box_height: u32,
}

/// Renders date captions for one output size.
pub struct CaptionRenderer {
    font: FontRef<'static>,
    scale: PxScale,
    format: String,
    position: CaptionPosition,
    canvas: (u32, u32),
    margin: u32,
    digit_advance: f32,
}

impl std::fmt::Debug for CaptionRenderer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CaptionRenderer")
            .field("size_px", &self.scale.y)
            .field("format", &self.format)
            .field("position", &self.position)
            .finish_non_exhaustive()
    }
}

impl CaptionRenderer {
    /// Prepares a renderer for `width x height` frames.
    ///
    /// # Errors
    /// [`VideoError::Internal`] if the bundled font cannot be parsed.
    pub fn new(options: &CaptionOptions, width: u32, height: u32) -> Result<Self> {
        let font = caption_font()?;
        let em_px = (f64::from(height) * options.size).max(6.0) as f32;
        // `PxScale` measures ascent - descent; `size` is the em height.
        let units_per_em = font.units_per_em().unwrap_or(1000.0);
        let px = em_px * (font.ascent_unscaled() - font.descent_unscaled()) / units_per_em;
        let scale = PxScale::from(px);
        let scaled = font.as_scaled(scale);
        let digit_advance = ('0'..='9')
            .map(|d| scaled.h_advance(font.glyph_id(d)))
            .fold(0.0f32, f32::max);
        Ok(Self {
            font,
            scale,
            format: options.format.clone(),
            position: options.position,
            canvas: (width, height),
            margin: (width.min(height) as f32 * MARGIN_FRACTION).round() as u32,
            digit_advance,
        })
    }

    /// Font em size in pixels.
    #[must_use]
    pub fn em_px(&self) -> f32 {
        let units_per_em = self.font.units_per_em().unwrap_or(1000.0);
        self.scale.y * units_per_em / (self.font.ascent_unscaled() - self.font.descent_unscaled())
    }

    /// Caption text for a date, e.g. `Aug 15, 2014`. A pattern that cannot
    /// format a date (rejected by validation) falls back to the default
    /// format instead of panicking a frame worker.
    #[must_use]
    pub fn text_for(&self, date: NaiveDate) -> String {
        crate::options::format_date(date, &self.format)
            .or_else(|| crate::options::format_date(date, crate::options::DEFAULT_DATE_FORMAT))
            .unwrap_or_default()
    }

    /// Glyphs with their x positions (tabular digits) and the total advance.
    fn layout(&self, text: &str) -> (Vec<(GlyphId, f32)>, f32) {
        let scaled = self.font.as_scaled(self.scale);
        let mut caret = 0.0f32;
        let mut prev: Option<GlyphId> = None;
        let mut glyphs = Vec::with_capacity(text.len());
        for c in text.chars() {
            let id = self.font.glyph_id(c);
            if let Some(p) = prev {
                caret += scaled.kern(p, id);
            }
            let advance = scaled.h_advance(id) * if c == ' ' { WORD_SPACE } else { 1.0 };
            if c.is_ascii_digit() {
                // Centre the digit in a fixed-width cell.
                glyphs.push((id, caret + (self.digit_advance - advance) / 2.0));
                caret += self.digit_advance;
            } else {
                glyphs.push((id, caret));
                caret += advance;
            }
            prev = Some(id);
        }
        (glyphs, caret)
    }

    /// Rasterises `text` into coverage masks.
    #[must_use]
    pub fn render(&self, text: &str) -> CaptionMask {
        let scaled = self.font.as_scaled(self.scale);
        let (glyphs, advance) = self.layout(text);
        let px = self.scale.y;
        let offset = (px * SHADOW_OFFSET).round().max(1.0) as u32;
        let blur = (px * SHADOW_BLUR).round().max(1.0) as u32;
        let halo_radius = (px * HALO_RADIUS).round().max(1.0) as u32;
        let pad = (offset + blur * 2).max(halo_radius + 2) + 2;
        let box_width = advance.ceil().max(1.0) as u32;
        let box_height = (scaled.ascent() - scaled.descent()).ceil().max(1.0) as u32;
        let (w, h) = (box_width + 2 * pad, box_height + 2 * pad);
        let mut text_mask = vec![0f32; (w * h) as usize];
        let baseline = pad as f32 + scaled.ascent();
        for (id, x) in glyphs {
            let glyph = id.with_scale_and_position(self.scale, point(pad as f32 + x, baseline));
            let Some(outlined) = self.font.outline_glyph(glyph) else {
                continue; // whitespace
            };
            let bounds = outlined.px_bounds();
            outlined.draw(|gx, gy, coverage| {
                let x = bounds.min.x as i64 + i64::from(gx);
                let y = bounds.min.y as i64 + i64::from(gy);
                if (0..i64::from(w)).contains(&x) && (0..i64::from(h)).contains(&y) {
                    let cell = &mut text_mask[(y as u32 * w + x as u32) as usize];
                    *cell = (*cell + coverage).min(1.0);
                }
            });
        }
        let mut drop = shift_down(&text_mask, w, h, offset);
        // Three box blurs approximate a Gaussian.
        for _ in 0..3 {
            drop = box_blur(&drop, w, h, blur.div_ceil(2));
        }
        let halo = box_blur(&dilate(&text_mask, w, h, halo_radius), w, h, 1);
        // Union of the two dark layers.
        let shadow = drop
            .iter()
            .zip(&halo)
            .map(|(&d, &h)| 1.0 - (1.0 - d * SHADOW_OPACITY) * (1.0 - h * HALO_OPACITY))
            .collect();
        CaptionMask {
            width: w,
            height: h,
            text: text_mask,
            shadow,
            pad,
            box_width,
            box_height,
        }
    }

    /// Renders the caption for `date` and positions it on the frame.
    #[must_use]
    pub fn place(&self, date: NaiveDate) -> PlacedCaption {
        let mask = self.render(&self.text_for(date));
        let (ox, oy) = caption_origin(
            self.position,
            self.canvas,
            (mask.box_width, mask.box_height),
            self.margin,
        );
        // Even-aligned so the mask lines up with the 4:2:0 chroma grid.
        let even = |v: i64| v - v.rem_euclid(2);
        PlacedCaption {
            left: even(ox - i64::from(mask.pad)),
            top: even(oy - i64::from(mask.pad)),
            mask,
        }
    }
}

/// A rendered caption at a fixed position, ready to be composited onto
/// frames. Compositing happens in Y'CbCr after crossfade blending, so the
/// date never ghosts during a dissolve.
#[derive(Debug, Clone, PartialEq)]
pub struct PlacedCaption {
    /// Coverage masks.
    pub mask: CaptionMask,
    /// Frame x of the mask's left edge (even).
    pub left: i64,
    /// Frame y of the mask's top edge (even).
    pub top: i64,
}

/// Limited-range luma of black and the luma span up to white.
const Y_BLACK: f32 = 16.0;
const Y_SPAN: f32 = 219.0;
const C_ZERO: f32 = 128.0;

impl PlacedCaption {
    /// Composites black shadow then white text onto `frame`, clipped to it.
    ///
    /// Alpha compositing commutes with the affine RGB→Y'CbCr transform, so
    /// this matches drawing in RGB; chroma uses the 2x2-averaged coverage.
    pub fn apply(&self, frame: &mut YuvFrame) {
        let (fw, fh) = (i64::from(frame.width()), i64::from(frame.height()));
        let m = &self.mask;
        let (luma, cb, cr) = frame.planes_mut();
        for my in 0..m.height {
            let y = self.top + i64::from(my);
            if !(0..fh).contains(&y) {
                continue;
            }
            for mx in 0..m.width {
                let x = self.left + i64::from(mx);
                let i = (my * m.width + mx) as usize;
                let (shadow, text) = (m.shadow[i], m.text[i]);
                if !(0..fw).contains(&x) || (shadow <= 0.0 && text <= 0.0) {
                    continue;
                }
                let p = &mut luma[(y * fw + x) as usize];
                let dark = (f32::from(*p) - Y_BLACK) * (1.0 - shadow);
                let lit = dark * (1.0 - text) + Y_SPAN * text;
                *p = (Y_BLACK + lit).round().clamp(0.0, 255.0) as u8;
            }
        }
        let (cw, ch) = (fw / 2, fh / 2);
        for cy in 0..m.height.div_ceil(2) {
            let y = self.top / 2 + i64::from(cy);
            if !(0..ch).contains(&y) {
                continue;
            }
            for cx in 0..m.width.div_ceil(2) {
                let x = self.left / 2 + i64::from(cx);
                if !(0..cw).contains(&x) {
                    continue;
                }
                let keep = self.chroma_keep(cx, cy);
                if keep >= 1.0 {
                    continue;
                }
                let i = (y * cw + x) as usize;
                for plane in [&mut *cb, &mut *cr] {
                    let c = (f32::from(plane[i]) - C_ZERO) * keep + C_ZERO;
                    plane[i] = c.round().clamp(0.0, 255.0) as u8;
                }
            }
        }
    }

    /// Average share of the original colour kept over a 2x2 block.
    fn chroma_keep(&self, cx: u32, cy: u32) -> f32 {
        let m = &self.mask;
        let mut keep = 0.0;
        for (dx, dy) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
            let (mx, my) = (cx * 2 + dx, cy * 2 + dy);
            keep += if mx < m.width && my < m.height {
                let i = (my * m.width + mx) as usize;
                (1.0 - m.shadow[i]) * (1.0 - m.text[i])
            } else {
                1.0
            };
        }
        keep / 4.0
    }
}

/// Running maximum of one line over a window of radius `r`.
fn max_line(line: &[f32], r: usize, out: &mut [f32]) {
    for (x, o) in out.iter_mut().enumerate() {
        let lo = x.saturating_sub(r);
        let hi = (x + r + 1).min(line.len());
        *o = line[lo..hi].iter().copied().fold(0.0, f32::max);
    }
}

/// Separable square dilation (max filter) with radius `r`.
fn dilate(src: &[f32], w: u32, h: u32, r: u32) -> Vec<f32> {
    let (w, h, r) = (w as usize, h as usize, r as usize);
    let mut tmp = vec![0f32; src.len()];
    for (row, out) in src.chunks_exact(w).zip(tmp.chunks_exact_mut(w)) {
        max_line(row, r, out);
    }
    let mut out = vec![0f32; src.len()];
    let (mut column, mut result) = (vec![0f32; h], vec![0f32; h]);
    for x in 0..w {
        for (y, c) in column.iter_mut().enumerate() {
            *c = tmp[y * w + x];
        }
        max_line(&column, r, &mut result);
        for (y, &v) in result.iter().enumerate() {
            out[y * w + x] = v;
        }
    }
    out
}

fn shift_down(mask: &[f32], w: u32, h: u32, by: u32) -> Vec<f32> {
    let mut out = vec![0f32; mask.len()];
    let shift = (by * w) as usize;
    if (by as usize) < h as usize {
        out[shift..].copy_from_slice(&mask[..mask.len() - shift]);
    }
    out
}

/// Running-sum box blur of one line (zero padding outside), O(len).
fn blur_line(line: &[f32], r: usize, out: &mut [f32]) {
    let n = line.len();
    let norm = 1.0 / (2 * r + 1) as f32;
    let mut sum: f32 = line[..(r + 1).min(n)].iter().sum();
    for x in 0..n {
        out[x] = sum * norm;
        if x + r + 1 < n {
            sum += line[x + r + 1];
        }
        if x >= r {
            sum -= line[x - r];
        }
    }
}

/// Separable box blur with radius `r` (zero padding at the borders).
fn box_blur(src: &[f32], w: u32, h: u32, r: u32) -> Vec<f32> {
    let (w, h, r) = (w as usize, h as usize, r as usize);
    let mut tmp = vec![0f32; src.len()];
    for (row, out) in src.chunks_exact(w).zip(tmp.chunks_exact_mut(w)) {
        blur_line(row, r, out);
    }
    let mut out = vec![0f32; src.len()];
    let (mut column, mut blurred) = (vec![0f32; h], vec![0f32; h]);
    for x in 0..w {
        for (y, c) in column.iter_mut().enumerate() {
            *c = tmp[y * w + x];
        }
        blur_line(&column, r, &mut blurred);
        for (y, &v) in blurred.iter().enumerate() {
            out[y * w + x] = v;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::options::DEFAULT_DATE_FORMAT;

    fn renderer(position: CaptionPosition, w: u32, h: u32) -> CaptionRenderer {
        let opts = CaptionOptions {
            position,
            ..CaptionOptions::default()
        };
        CaptionRenderer::new(&opts, w, h).unwrap()
    }

    fn date(y: i32, m: u32, d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, d).unwrap()
    }

    #[test]
    fn formats_dates_like_the_spec() {
        let r = renderer(CaptionPosition::BottomLeft, 1920, 1080);
        assert_eq!(r.text_for(date(2014, 8, 15)), "Aug 15, 2014");
        assert_eq!(r.text_for(date(2012, 9, 1)), "Sep 1, 2012");
        assert_eq!(DEFAULT_DATE_FORMAT, "%b %-d, %Y");
        assert!((r.em_px() - 48.6).abs() < 1e-2, "{}", r.em_px());
        assert!(format!("{r:?}").contains("BottomLeft"));
    }

    #[test]
    fn unformattable_patterns_fall_back_instead_of_panicking() {
        // Bypasses option validation on purpose: rendering must never panic.
        let opts = CaptionOptions {
            format: "%Y %H:%M".into(),
            ..CaptionOptions::default()
        };
        let r = CaptionRenderer::new(&opts, 640, 360).unwrap();
        assert_eq!(r.text_for(date(2014, 8, 15)), "Aug 15, 2014");
    }

    #[test]
    fn font_is_condensed_and_monospaced() {
        let condensed = caption_font().unwrap();
        let default = FontRef::try_from_slice(FONT_BYTES).unwrap();
        let advance = |f: &FontRef<'_>, c: char| f.h_advance_unscaled(f.glyph_id(c));
        // Default instance is wdth 112.5; ours is 75.
        let (narrow, wide) = (advance(&condensed, 'M'), advance(&default, 'M'));
        assert!(narrow <= wide * 0.8, "{narrow} vs {wide}");
        assert_eq!(advance(&condensed, 'M'), advance(&condensed, '1'));
        assert_eq!(advance(&condensed, '0'), advance(&condensed, '8'));
    }

    #[test]
    fn origin_for_every_position() {
        use CaptionPosition as P;
        let c = (1000, 500);
        let b = (200, 50);
        assert_eq!(caption_origin(P::TopLeft, c, b, 20), (20, 20));
        assert_eq!(caption_origin(P::TopCenter, c, b, 20), (400, 20));
        assert_eq!(caption_origin(P::TopRight, c, b, 20), (780, 20));
        assert_eq!(caption_origin(P::BottomLeft, c, b, 20), (20, 430));
        assert_eq!(caption_origin(P::BottomCenter, c, b, 20), (400, 430));
        assert_eq!(caption_origin(P::BottomRight, c, b, 20), (780, 430));
        assert_eq!(
            caption_origin(P::BottomRight, (100, 40), (200, 50), 0),
            (-100, -10)
        );
    }

    #[test]
    fn digits_are_tabular_so_width_does_not_jitter() {
        let r = renderer(CaptionPosition::BottomCenter, 1920, 1080);
        let a = r.render("Aug 11, 2011");
        let b = r.render("Aug 00, 2000");
        assert_eq!(a.box_width, b.box_width);
        assert!(a.box_width > 100 && a.box_width < 600, "{}", a.box_width);
        assert!(a.box_height >= 48);
    }

    #[test]
    fn mask_has_ink_and_a_softer_offset_shadow() {
        let r = renderer(CaptionPosition::BottomLeft, 1280, 720);
        let m = r.render("Aug 15, 2014");
        assert_eq!(m.text.len(), (m.width * m.height) as usize);
        let ink: f32 = m.text.iter().sum();
        assert!(ink > 100.0, "{ink}");
        let max_shadow = m.shadow.iter().copied().fold(0.0, f32::max);
        assert!(max_shadow > 0.5 && max_shadow <= 1.0, "{max_shadow}");
        // Shadow centroid sits below the text centroid.
        let centroid = |v: &[f32]| {
            let total: f32 = v.iter().sum();
            v.iter()
                .enumerate()
                .map(|(i, a)| (i as u32 / m.width) as f32 * a)
                .sum::<f32>()
                / total
        };
        assert!(centroid(&m.shadow) > centroid(&m.text));
    }

    /// Reference: composite in RGB (shadow to black, then white text).
    fn composite_rgb(canvas: &mut [u8], w: u32, h: u32, placed: &PlacedCaption) {
        let m = &placed.mask;
        for my in 0..m.height {
            for mx in 0..m.width {
                let (x, y) = (placed.left + i64::from(mx), placed.top + i64::from(my));
                if x < 0 || y < 0 || x >= i64::from(w) || y >= i64::from(h) {
                    continue;
                }
                let i = (my * m.width + mx) as usize;
                let p = ((y as u32 * w + x as u32) * 3) as usize;
                for c in &mut canvas[p..p + 3] {
                    let v = f32::from(*c) * (1.0 - m.shadow[i]);
                    *c = (v * (1.0 - m.text[i]) + 255.0 * m.text[i]).round() as u8;
                }
            }
        }
    }

    fn photo_like(w: u32, h: u32) -> Vec<u8> {
        (0..w * h)
            .flat_map(|i| {
                let (x, y) = (i % w, i / w);
                [(x * 255 / w) as u8, (y * 255 / h) as u8, 90]
            })
            .collect()
    }

    #[test]
    fn yuv_compositing_matches_rgb_compositing() {
        let (w, h) = (480u32, 270u32);
        let rgb = photo_like(w, h);
        let r = renderer(CaptionPosition::BottomRight, w, h);
        let placed = r.place(date(2014, 8, 15));
        assert_eq!(placed.left % 2, 0);
        assert_eq!(placed.top % 2, 0);

        let mut reference_rgb = rgb.clone();
        composite_rgb(&mut reference_rgb, w, h, &placed);
        let reference = YuvFrame::from_rgb(&reference_rgb, w, h).unwrap();
        let mut ours = YuvFrame::from_rgb(&rgb, w, h).unwrap();
        placed.apply(&mut ours);

        let worst = |a: &[u8], b: &[u8]| {
            a.iter()
                .zip(b)
                .map(|(x, y)| x.abs_diff(*y))
                .max()
                .unwrap_or(0)
        };
        assert!(
            worst(ours.y(), reference.y()) <= 2,
            "Y {}",
            worst(ours.y(), reference.y())
        );
        assert!(
            worst(ours.u(), reference.u()) <= 3,
            "U {}",
            worst(ours.u(), reference.u())
        );
        assert!(
            worst(ours.v(), reference.v()) <= 3,
            "V {}",
            worst(ours.v(), reference.v())
        );
        assert_ne!(
            ours.y(),
            YuvFrame::from_rgb(&rgb, w, h).unwrap().y(),
            "caption drawn"
        );
    }

    #[test]
    fn caption_lands_in_the_requested_corner() {
        let (w, h) = (640u32, 360u32);
        let mut frame = YuvFrame::from_rgb(&[128u8; 640 * 360 * 3], w, h).unwrap();
        let before = frame.clone();
        renderer(CaptionPosition::BottomRight, w, h)
            .place(date(2014, 8, 15))
            .apply(&mut frame);
        let (mut white, mut dark) = (0, 0);
        for (i, (&now, &was)) in frame.y().iter().zip(before.y()).enumerate() {
            let (x, y) = (i as u32 % w, i as u32 / w);
            if now > 225 {
                white += 1;
                assert!(
                    x > w / 2 && y > h / 2,
                    "text outside bottom-right at {x},{y}"
                );
            } else if now + 15 < was {
                dark += 1;
            }
        }
        assert!(white > 50, "{white}");
        assert!(dark > 50, "{dark}");
        assert_eq!(
            frame.y()[10 * w as usize + 10],
            before.y()[10 * w as usize + 10]
        );
        // A neutral grey stays neutral under white text and black shadow.
        assert!(
            frame
                .u()
                .iter()
                .chain(frame.v())
                .all(|&c| c.abs_diff(128) <= 1)
        );
    }

    #[test]
    fn white_text_stays_legible_on_a_white_background() {
        let (w, h) = (1920u32, 1080u32);
        let mut frame = YuvFrame::from_rgb(&vec![255u8; 1920 * 1080 * 3], w, h).unwrap();
        renderer(CaptionPosition::BottomLeft, w, h)
            .place(date(2017, 9, 4))
            .apply(&mut frame);
        // The halo must outline the glyphs with clearly darker pixels.
        let outlined = frame.y().iter().filter(|&&v| v < 140).count();
        assert!(outlined > 1000, "only {outlined} dark outline pixels");
    }

    #[test]
    fn oversized_caption_is_clipped_not_panicking() {
        let opts = CaptionOptions {
            size: 0.2,
            ..CaptionOptions::default()
        };
        let r = CaptionRenderer::new(&opts, 64, 64).unwrap();
        let mut frame = YuvFrame::from_rgb(&[0u8; 64 * 64 * 3], 64, 64).unwrap();
        let placed = r.place(date(2020, 12, 31));
        assert!(placed.left < 0 || placed.left + i64::from(placed.mask.width) > 64);
        placed.apply(&mut frame);
        assert!(frame.y().iter().any(|&v| v > 16));
    }

    #[test]
    fn blur_and_shift_helpers() {
        let mut m = vec![0f32; 25];
        m[12] = 1.0;
        let b = box_blur(&m, 5, 5, 1);
        assert!((b.iter().sum::<f32>() - 1.0).abs() < 1e-5);
        assert!((b[12] - 1.0 / 9.0).abs() < 1e-6);
        assert!((b[6] - 1.0 / 9.0).abs() < 1e-6);
        assert!(b[0].abs() < 1e-6);
        // Radius larger than the image still conserves nothing outside.
        let wide = box_blur(&m, 5, 5, 7);
        assert!(wide.iter().all(|v| (v - 1.0 / 225.0).abs() < 1e-6));
        let d = dilate(&m, 5, 5, 1);
        assert_eq!(d.iter().filter(|&&v| v == 1.0).count(), 9);
        assert_eq!(d[0], 0.0);
        let s = shift_down(&m, 5, 5, 2);
        assert_eq!(s[22], 1.0);
        assert_eq!(shift_down(&m, 5, 5, 9).iter().sum::<f32>(), 0.0);
    }
}
