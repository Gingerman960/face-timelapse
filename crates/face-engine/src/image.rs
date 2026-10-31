//! A minimal owned RGB8 image plus the pixel operations the engine needs:
//! cropping, EXIF orientation, mirroring and SIMD resizing via
//! `fast_image_resize`.

use fast_image_resize::{self as fir, PixelType, ResizeAlg, ResizeOptions, Resizer};

use crate::error::{EngineError, Result};
use crate::geometry::Size;

/// Tightly packed, row-major 8-bit RGB image.
#[derive(Clone, PartialEq, Eq)]
pub struct RgbImage {
    width: u32,
    height: u32,
    data: Vec<u8>,
}

impl std::fmt::Debug for RgbImage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RgbImage")
            .field("width", &self.width)
            .field("height", &self.height)
            .finish_non_exhaustive()
    }
}

/// Resampling filter used by [`RgbImage::resized`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Filter {
    /// Box/area filter: fastest antialiased downscale.
    Box,
    /// Bilinear with antialiasing support (like OpenCV `INTER_AREA` when shrinking).
    Bilinear,
    /// Catmull-Rom bicubic: sharp, good default for thumbnails.
    CatmullRom,
    /// Lanczos3: highest quality, slowest.
    Lanczos3,
}

impl Filter {
    fn alg(self) -> ResizeAlg {
        let f = match self {
            Self::Box => fir::FilterType::Box,
            Self::Bilinear => fir::FilterType::Bilinear,
            Self::CatmullRom => fir::FilterType::CatmullRom,
            Self::Lanczos3 => fir::FilterType::Lanczos3,
        };
        ResizeAlg::Convolution(f)
    }
}

impl RgbImage {
    /// A black image.
    #[must_use]
    pub fn new(width: u32, height: u32) -> Self {
        Self {
            width,
            height,
            data: vec![0; width as usize * height as usize * 3],
        }
    }

    /// An image filled with one color.
    #[must_use]
    pub fn filled(width: u32, height: u32, rgb: [u8; 3]) -> Self {
        let n = width as usize * height as usize;
        let mut data = Vec::with_capacity(n * 3);
        for _ in 0..n {
            data.extend_from_slice(&rgb);
        }
        Self {
            width,
            height,
            data,
        }
    }

    /// Wraps raw RGB bytes.
    ///
    /// # Errors
    /// [`EngineError::InvalidArgument`] if the buffer length does not match.
    pub fn from_raw(width: u32, height: u32, data: Vec<u8>) -> Result<Self> {
        let expected = width as usize * height as usize * 3;
        if data.len() != expected {
            return Err(EngineError::InvalidArgument(format!(
                "RGB buffer has {} bytes, expected {expected} for {width}x{height}",
                data.len()
            )));
        }
        Ok(Self {
            width,
            height,
            data,
        })
    }

    /// Width in pixels.
    #[must_use]
    pub fn width(&self) -> u32 {
        self.width
    }

    /// Height in pixels.
    #[must_use]
    pub fn height(&self) -> u32 {
        self.height
    }

    /// Size in pixels.
    #[must_use]
    pub fn size(&self) -> Size {
        Size::new(self.width, self.height)
    }

    /// Raw bytes.
    #[must_use]
    pub fn as_raw(&self) -> &[u8] {
        &self.data
    }

    /// Mutable raw bytes.
    pub fn as_raw_mut(&mut self) -> &mut [u8] {
        &mut self.data
    }

    /// Consumes the image, returning its bytes.
    #[must_use]
    pub fn into_raw(self) -> Vec<u8> {
        self.data
    }

    /// Bytes per row.
    #[must_use]
    pub fn stride(&self) -> usize {
        self.width as usize * 3
    }

    /// Pixel at `(x, y)`; `None` out of bounds.
    #[must_use]
    pub fn pixel(&self, x: u32, y: u32) -> Option<[u8; 3]> {
        if x >= self.width || y >= self.height {
            return None;
        }
        let i = (y as usize * self.width as usize + x as usize) * 3;
        Some([self.data[i], self.data[i + 1], self.data[i + 2]])
    }

    /// Copies the rectangle `(x, y, w, h)`, clamped to the image.
    #[must_use]
    pub fn cropped(&self, x: u32, y: u32, w: u32, h: u32) -> Self {
        let x = x.min(self.width);
        let y = y.min(self.height);
        let w = w.min(self.width - x);
        let h = h.min(self.height - y);
        let mut out = Vec::with_capacity(w as usize * h as usize * 3);
        let stride = self.stride();
        for row in y..y + h {
            let start = row as usize * stride + x as usize * 3;
            out.extend_from_slice(&self.data[start..start + w as usize * 3]);
        }
        Self {
            width: w,
            height: h,
            data: out,
        }
    }

    /// Copies the `w × h` window at `(x, y)`, which may extend past the image;
    /// pixels outside the image are black.
    #[must_use]
    pub fn cropped_padded(&self, x: i64, y: i64, w: u32, h: u32) -> Self {
        let mut out = Self::new(w, h);
        let (iw, ih) = (i64::from(self.width), i64::from(self.height));
        let xa = x.clamp(0, iw);
        let xb = (x + i64::from(w)).clamp(0, iw);
        if xa >= xb {
            return out;
        }
        let stride = self.stride();
        let out_stride = out.stride();
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let (n, dx) = ((xb - xa) as usize * 3, (xa - x) as usize * 3);
        for row in 0..i64::from(h) {
            let sy = y + row;
            if !(0..ih).contains(&sy) {
                continue;
            }
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            let (s, d) = (
                sy as usize * stride + xa as usize * 3,
                row as usize * out_stride + dx,
            );
            out.data[d..d + n].copy_from_slice(&self.data[s..s + n]);
        }
        out
    }

    /// Mirror image (left ↔ right).
    #[must_use]
    pub fn flipped_horizontal(&self) -> Self {
        let mut out = self.data.clone();
        let stride = self.stride();
        let w = self.width as usize;
        for (dst, src) in out
            .chunks_exact_mut(stride)
            .zip(self.data.chunks_exact(stride))
        {
            for x in 0..w {
                let s = (w - 1 - x) * 3;
                dst[x * 3..x * 3 + 3].copy_from_slice(&src[s..s + 3]);
            }
        }
        Self {
            width: self.width,
            height: self.height,
            data: out,
        }
    }

    /// Applies an EXIF orientation (1–8) so the result displays upright.
    /// Unknown values are treated as 1 (no change).
    #[must_use]
    pub fn oriented(self, orientation: u16) -> Self {
        if !(2..=8).contains(&orientation) {
            return self;
        }
        let (w, h) = (self.width as usize, self.height as usize);
        let swap = orientation >= 5;
        let (ow, oh) = if swap { (h, w) } else { (w, h) };
        let mut out = vec![0u8; self.data.len()];
        for y in 0..h {
            for x in 0..w {
                let (dx, dy) = match orientation {
                    2 => (w - 1 - x, y),
                    3 => (w - 1 - x, h - 1 - y),
                    4 => (x, h - 1 - y),
                    5 => (y, x),
                    6 => (h - 1 - y, x),
                    7 => (h - 1 - y, w - 1 - x),
                    _ => (y, w - 1 - x), // 8
                };
                let s = (y * w + x) * 3;
                let d = (dy * ow + dx) * 3;
                out[d..d + 3].copy_from_slice(&self.data[s..s + 3]);
            }
        }
        #[allow(clippy::cast_possible_truncation)]
        Self {
            width: ow as u32,
            height: oh as u32,
            data: out,
        }
    }

    /// Resizes to exactly `w × h` with `filter` (SIMD, antialiased).
    ///
    /// # Errors
    /// [`EngineError::InvalidArgument`] for zero target sizes.
    pub fn resized(&self, w: u32, h: u32, filter: Filter) -> Result<Self> {
        if w == 0 || h == 0 || self.width == 0 || self.height == 0 {
            return Err(EngineError::InvalidArgument(format!(
                "cannot resize {}x{} to {w}x{h}",
                self.width, self.height
            )));
        }
        if w == self.width && h == self.height {
            return Ok(self.clone());
        }
        let src = fir::images::ImageRef::new(self.width, self.height, &self.data, PixelType::U8x3)
            .map_err(|e| EngineError::Internal(format!("resize source: {e}")))?;
        let mut dst = fir::images::Image::new(w, h, PixelType::U8x3);
        let mut resizer = Resizer::new();
        resizer
            .resize(
                &src,
                &mut dst,
                &ResizeOptions::new().resize_alg(filter.alg()),
            )
            .map_err(|e| EngineError::Internal(format!("resize: {e}")))?;
        Ok(Self {
            width: w,
            height: h,
            data: dst.into_vec(),
        })
    }

    /// Resizes so the long edge is at most `max` (never upscales).
    ///
    /// # Errors
    /// See [`RgbImage::resized`].
    pub fn fit_within(&self, max: u32, filter: Filter) -> Result<Self> {
        let target = self.size().fit_within(max);
        self.resized(target.width, target.height, filter)
    }

    /// Multiplies every channel by `factor` (clamped to 0–255).
    pub fn scale_brightness(&mut self, factor: f32) {
        if (factor - 1.0).abs() < f32::EPSILON {
            return;
        }
        let lut: Vec<u8> = (0..=255u16)
            .map(|v| {
                #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
                let r = (f32::from(v) * factor).round().clamp(0.0, 255.0) as u8;
                r
            })
            .collect();
        for v in &mut self.data {
            *v = lut[usize::from(*v)];
        }
    }
}

/// Size of an image after applying EXIF `orientation` to `raw`.
#[must_use]
pub fn oriented_size(raw: Size, orientation: u16) -> Size {
    if (5..=8).contains(&orientation) {
        Size::new(raw.height, raw.width)
    } else {
        raw
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 3×2 image whose pixel (x, y) = [x, y, 10*y + x].
    fn sample() -> RgbImage {
        let mut data = Vec::new();
        for y in 0..2u8 {
            for x in 0..3u8 {
                data.extend_from_slice(&[x, y, 10 * y + x]);
            }
        }
        RgbImage::from_raw(3, 2, data).expect("valid")
    }

    fn tag(img: &RgbImage, x: u32, y: u32) -> u8 {
        img.pixel(x, y).expect("in bounds")[2]
    }

    #[test]
    fn from_raw_validates_length() {
        assert!(RgbImage::from_raw(2, 2, vec![0; 11]).is_err());
        let img = sample();
        assert_eq!(img.size(), Size::new(3, 2));
        assert_eq!(img.stride(), 9);
        assert_eq!(img.pixel(3, 0), None);
        assert_eq!(format!("{img:?}"), "RgbImage { width: 3, height: 2, .. }");
        assert_eq!(img.clone().into_raw().len(), 18);
    }

    #[test]
    fn orientation_transforms_match_exif_semantics() {
        // Stored image:  0 1 2 / 10 11 12
        let cases: [(u16, (u32, u32), [u8; 2]); 8] = [
            (1, (3, 2), [0, 12]),
            (2, (3, 2), [2, 10]), // mirror horizontal
            (3, (3, 2), [12, 0]), // rotate 180
            (4, (3, 2), [10, 2]), // mirror vertical
            (5, (2, 3), [0, 12]), // transpose
            (6, (2, 3), [10, 2]), // rotate 90 CW
            (7, (2, 3), [12, 0]), // transverse
            (8, (2, 3), [2, 10]), // rotate 90 CCW
        ];
        for (o, (w, h), [first, last]) in cases {
            let out = sample().oriented(o);
            assert_eq!(out.size(), Size::new(w, h), "orientation {o}");
            assert_eq!(tag(&out, 0, 0), first, "orientation {o} top-left");
            assert_eq!(
                tag(&out, w - 1, h - 1),
                last,
                "orientation {o} bottom-right"
            );
            assert_eq!(oriented_size(sample().size(), o), Size::new(w, h));
        }
        // Rotate 90 CW: the stored bottom-left pixel becomes the top-left.
        let r = sample().oriented(6);
        assert_eq!(tag(&r, 1, 0), 0);
        assert_eq!(sample().oriented(0), sample());
        assert_eq!(sample().oriented(9), sample());
    }

    #[test]
    fn crop_flip_fill() {
        let img = sample();
        let c = img.cropped(1, 1, 5, 5);
        assert_eq!(c.size(), Size::new(2, 1));
        assert_eq!(c.as_raw(), &[1, 1, 11, 2, 1, 12]);
        let padded = img.cropped_padded(-1, 1, 3, 2);
        assert_eq!(padded.size(), Size::new(3, 2));
        assert_eq!(padded.pixel(0, 0), Some([0, 0, 0]));
        assert_eq!(padded.pixel(1, 0).map(|p| p[2]), Some(10));
        assert_eq!(padded.pixel(2, 1), Some([0, 0, 0]));
        assert!(
            img.cropped_padded(10, 0, 2, 2)
                .as_raw()
                .iter()
                .all(|&v| v == 0)
        );
        assert_eq!(img.cropped_padded(0, 0, 3, 2), img);
        let f = img.flipped_horizontal();
        assert_eq!(tag(&f, 0, 0), 2);
        assert_eq!(tag(&f, 2, 1), 10);
        let filled = RgbImage::filled(2, 1, [1, 2, 3]);
        assert_eq!(filled.as_raw(), &[1, 2, 3, 1, 2, 3]);
        assert_eq!(RgbImage::new(1, 1).as_raw(), &[0, 0, 0]);
    }

    #[test]
    fn resize_preserves_flat_color_and_validates() {
        let img = RgbImage::filled(40, 30, [200, 100, 50]);
        for f in [
            Filter::Box,
            Filter::Bilinear,
            Filter::CatmullRom,
            Filter::Lanczos3,
        ] {
            let small = img.resized(8, 6, f).expect("resize");
            assert_eq!(small.size(), Size::new(8, 6));
            assert!(small.as_raw().chunks(3).all(|p| p == [200, 100, 50]));
        }
        assert!(img.resized(0, 5, Filter::Box).is_err());
        assert_eq!(img.resized(40, 30, Filter::Box).expect("same"), img);
        assert_eq!(
            img.fit_within(20, Filter::Box).expect("fit").size(),
            Size::new(20, 15)
        );
    }

    #[test]
    fn brightness_scaling() {
        let mut img = RgbImage::filled(1, 1, [100, 200, 255]);
        img.scale_brightness(0.45);
        assert_eq!(img.as_raw(), &[45, 90, 115]);
        let mut same = RgbImage::filled(1, 1, [7, 8, 9]);
        same.scale_brightness(1.0);
        assert_eq!(same.as_raw(), &[7, 8, 9]);
        img.as_raw_mut()[0] = 1;
        assert_eq!(img.as_raw()[0], 1);
    }
}
