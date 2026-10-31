//! I420 (planar YUV 4:2:0) frames, RGB conversion and crossfade blending.
//!
//! Colour handling: frames are converted with BT.709 coefficients in limited
//! ("TV") range, which is what H.264 players assume for HD content, and the
//! stream is tagged accordingly (VUI + `colr` box) so no player has to guess.
//! The RGB→YUV step uses the SIMD (NEON/AVX2/SSE) kernels of the `yuv` crate.

use yuv::{
    BufferStoreMut, YuvConversionMode, YuvPlanarImageMut, YuvRange, YuvStandardMatrix,
    rgb_to_yuv420,
};

use crate::error::{Result, VideoError};

/// An I420 frame with even dimensions stored in one contiguous buffer
/// (`Y` plane, then `U`, then `V`; no row padding).
#[derive(Clone, PartialEq, Eq)]
pub struct YuvFrame {
    width: u32,
    height: u32,
    data: Vec<u8>,
}

impl std::fmt::Debug for YuvFrame {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("YuvFrame")
            .field("width", &self.width)
            .field("height", &self.height)
            .finish_non_exhaustive()
    }
}

fn check_dims(width: u32, height: u32) -> Result<()> {
    if width == 0 || height == 0 || !width.is_multiple_of(2) || !height.is_multiple_of(2) {
        return Err(VideoError::Internal(format!(
            "I420 frames need non-zero even dimensions, got {width}x{height}"
        )));
    }
    Ok(())
}

impl YuvFrame {
    fn luma_len(&self) -> usize {
        self.width as usize * self.height as usize
    }

    fn chroma_len(&self) -> usize {
        self.luma_len() / 4
    }

    /// Converts tightly packed RGB8 pixels (BT.709, limited range).
    ///
    /// # Errors
    /// [`VideoError::Internal`] if the dimensions are odd/zero or the buffer
    /// length is not `width * height * 3`.
    pub fn from_rgb(rgb: &[u8], width: u32, height: u32) -> Result<Self> {
        check_dims(width, height)?;
        let luma = width as usize * height as usize;
        if rgb.len() != luma * 3 {
            return Err(VideoError::Internal(format!(
                "RGB buffer is {} bytes, expected {} for {width}x{height}",
                rgb.len(),
                luma * 3
            )));
        }
        let mut data = vec![0u8; luma + luma / 2];
        let (y, uv) = data.split_at_mut(luma);
        let (u, v) = uv.split_at_mut(luma / 4);
        let mut planar = YuvPlanarImageMut {
            y_plane: BufferStoreMut::Borrowed(y),
            y_stride: width,
            u_plane: BufferStoreMut::Borrowed(u),
            u_stride: width / 2,
            v_plane: BufferStoreMut::Borrowed(v),
            v_stride: width / 2,
            width,
            height,
        };
        rgb_to_yuv420(
            &mut planar,
            rgb,
            width * 3,
            YuvRange::Limited,
            YuvStandardMatrix::Bt709,
            YuvConversionMode::Balanced,
        )
        .map_err(|e| VideoError::Internal(format!("RGB to YUV conversion failed: {e}")))?;
        Ok(Self {
            width,
            height,
            data,
        })
    }

    /// Wraps an existing tightly packed I420 buffer (`Y|U|V`, BT.709 limited range).
    ///
    /// # Errors
    /// [`VideoError::Internal`] if the dimensions are odd/zero or the buffer
    /// length is not `width * height * 3 / 2`.
    pub fn from_i420(data: Vec<u8>, width: u32, height: u32) -> Result<Self> {
        check_dims(width, height)?;
        let expected = width as usize * height as usize * 3 / 2;
        if data.len() != expected {
            return Err(VideoError::Internal(format!(
                "I420 buffer is {} bytes, expected {expected} for {width}x{height}",
                data.len()
            )));
        }
        Ok(Self {
            width,
            height,
            data,
        })
    }

    /// Frame width in pixels.
    #[must_use]
    pub fn width(&self) -> u32 {
        self.width
    }

    /// Frame height in pixels.
    #[must_use]
    pub fn height(&self) -> u32 {
        self.height
    }

    /// Luma plane, `width` bytes per row.
    #[must_use]
    pub fn y(&self) -> &[u8] {
        &self.data[..self.luma_len()]
    }

    /// Cb plane, `width / 2` bytes per row.
    #[must_use]
    pub fn u(&self) -> &[u8] {
        let start = self.luma_len();
        &self.data[start..start + self.chroma_len()]
    }

    /// Cr plane, `width / 2` bytes per row.
    #[must_use]
    pub fn v(&self) -> &[u8] {
        &self.data[self.luma_len() + self.chroma_len()..]
    }

    /// Mutable `(Y, U, V)` planes.
    pub(crate) fn planes_mut(&mut self) -> (&mut [u8], &mut [u8], &mut [u8]) {
        let luma = self.luma_len();
        let chroma = self.chroma_len();
        let (y, uv) = self.data.split_at_mut(luma);
        let (u, v) = uv.split_at_mut(chroma);
        (y, u, v)
    }

    /// The whole contiguous `Y|U|V` buffer.
    #[must_use]
    pub fn as_bytes(&self) -> &[u8] {
        &self.data
    }

    /// Dissolve between two frames of equal size: `weight` is the share of `b`
    /// (clamped to `[0, 1]`). Blending in Y'CbCr equals blending in gamma
    /// encoded RGB because the conversion is affine.
    ///
    /// # Errors
    /// [`VideoError::Internal`] if the frames differ in size.
    pub fn blend(a: &Self, b: &Self, weight: f32) -> Result<Self> {
        if (a.width, a.height) != (b.width, b.height) {
            return Err(VideoError::Internal(format!(
                "cannot blend {}x{} with {}x{}",
                a.width, a.height, b.width, b.height
            )));
        }
        // 8.8 fixed point; the loop auto-vectorises.
        let wb = u16::try_from((weight.clamp(0.0, 1.0) * 256.0).round() as u32).unwrap_or(256);
        let wa = 256 - wb;
        let data = a
            .data
            .iter()
            .zip(&b.data)
            .map(|(&pa, &pb)| ((u16::from(pa) * wa + u16::from(pb) * wb + 128) >> 8) as u8)
            .collect();
        Ok(Self {
            width: a.width,
            height: a.height,
            data,
        })
    }
}

#[cfg(test)]
pub(crate) mod reference {
    //! Straightforward floating-point BT.709 limited-range conversion used to
    //! validate the SIMD path.

    const KR: f64 = 0.2126;
    const KB: f64 = 0.0722;

    /// `(Y, Cb, Cr)` for one RGB pixel, unrounded.
    pub fn ycbcr(r: u8, g: u8, b: u8) -> (f64, f64, f64) {
        let (r, g, b) = (
            f64::from(r) / 255.0,
            f64::from(g) / 255.0,
            f64::from(b) / 255.0,
        );
        let y = KR * r + (1.0 - KR - KB) * g + KB * b;
        let cb = (b - y) / (2.0 * (1.0 - KB));
        let cr = (r - y) / (2.0 * (1.0 - KR));
        (16.0 + 219.0 * y, 128.0 + 224.0 * cb, 128.0 + 224.0 * cr)
    }

    /// Inverse of [`ycbcr`], clamped to `[0, 255]`.
    #[allow(dead_code)]
    pub fn rgb(y: f64, cb: f64, cr: f64) -> (f64, f64, f64) {
        let y = (y - 16.0) / 219.0;
        let cb = (cb - 128.0) / 224.0;
        let cr = (cr - 128.0) / 224.0;
        let r = y + 2.0 * (1.0 - KR) * cr;
        let b = y + 2.0 * (1.0 - KB) * cb;
        let g = (y - KR * r - KB * b) / (1.0 - KR - KB);
        let c = |v: f64| (v * 255.0).clamp(0.0, 255.0);
        (c(r), c(g), c(b))
    }
}

#[cfg(test)]
mod tests {
    use super::reference::ycbcr;
    use super::*;

    fn solid(r: u8, g: u8, b: u8, w: u32, h: u32) -> Vec<u8> {
        [r, g, b].repeat((w * h) as usize)
    }

    #[test]
    fn known_colours_match_bt709_limited_reference() {
        // Canonical BT.709 limited-range values.
        let cases: [([u8; 3], [u8; 3]); 6] = [
            ([0, 0, 0], [16, 128, 128]),
            ([255, 255, 255], [235, 128, 128]),
            ([255, 0, 0], [63, 102, 240]),
            ([0, 255, 0], [173, 42, 26]),
            ([0, 0, 255], [32, 240, 118]),
            ([128, 128, 128], [126, 128, 128]),
        ];
        for ([r, g, b], [ey, eu, ev]) in cases {
            let f = YuvFrame::from_rgb(&solid(r, g, b, 4, 2), 4, 2).unwrap();
            for (plane, want, name) in [(f.y(), ey, "Y"), (f.u(), eu, "U"), (f.v(), ev, "V")] {
                for &got in plane {
                    assert!(
                        got.abs_diff(want) <= 1,
                        "{name} for rgb({r},{g},{b}): got {got}, want {want}"
                    );
                }
            }
        }
    }

    #[test]
    fn simd_path_matches_float_reference_on_a_gradient() {
        let (w, h) = (64u32, 32u32);
        let mut rgb = Vec::with_capacity((w * h * 3) as usize);
        for y in 0..h {
            for x in 0..w {
                rgb.extend_from_slice(&[(x * 4) as u8, (y * 8) as u8, ((x + y) * 3) as u8]);
            }
        }
        let f = YuvFrame::from_rgb(&rgb, w, h).unwrap();
        // The fixed-point SIMD kernel may be off by one code value (plus a
        // little); check both the worst case and that there is no bias.
        let (mut worst, mut bias) = (0.0f64, 0.0f64);
        for y in 0..h as usize {
            for x in 0..w as usize {
                let p = &rgb[(y * w as usize + x) * 3..][..3];
                let (ry, _, _) = ycbcr(p[0], p[1], p[2]);
                let err = f64::from(f.y()[y * w as usize + x]) - ry;
                worst = worst.max(err.abs());
                bias += err / f64::from(w * h);
            }
        }
        assert!(worst <= 1.25, "worst Y error {worst}");
        assert!(bias.abs() <= 0.6, "Y bias {bias}");
        // Chroma is the 2x2 average (within rounding) of the reference.
        let cw = (w / 2) as usize;
        for cy in 0..(h / 2) as usize {
            for cx in 0..cw {
                let (mut su, mut sv) = (0.0, 0.0);
                for (dx, dy) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
                    let p = &rgb[((cy * 2 + dy) * w as usize + cx * 2 + dx) * 3..][..3];
                    let (_, u, v) = ycbcr(p[0], p[1], p[2]);
                    su += u / 4.0;
                    sv += v / 4.0;
                }
                assert!(
                    (f64::from(f.u()[cy * cw + cx]) - su).abs() <= 1.5,
                    "U at {cx},{cy}"
                );
                assert!(
                    (f64::from(f.v()[cy * cw + cx]) - sv).abs() <= 1.5,
                    "V at {cx},{cy}"
                );
            }
        }
    }

    #[test]
    fn plane_layout_is_contiguous_i420() {
        let f = YuvFrame::from_rgb(&solid(10, 20, 30, 6, 4), 6, 4).unwrap();
        assert_eq!((f.width(), f.height()), (6, 4));
        assert_eq!(f.y().len(), 24);
        assert_eq!(f.u().len(), 6);
        assert_eq!(f.v().len(), 6);
        assert_eq!(f.as_bytes().len(), 36);
        assert!(format!("{f:?}").contains("width: 6"));
    }

    #[test]
    fn from_i420_round_trips_and_validates() {
        let f = YuvFrame::from_rgb(&solid(10, 200, 30, 4, 2), 4, 2).unwrap();
        let again = YuvFrame::from_i420(f.as_bytes().to_vec(), 4, 2).unwrap();
        assert_eq!(again, f);
        assert!(YuvFrame::from_i420(vec![0; 11], 4, 2).is_err());
        assert!(YuvFrame::from_i420(vec![0; 12], 3, 2).is_err());
    }

    #[test]
    fn rejects_bad_dimensions_and_buffers() {
        assert!(YuvFrame::from_rgb(&solid(0, 0, 0, 3, 2), 3, 2).is_err());
        assert!(YuvFrame::from_rgb(&[], 0, 2).is_err());
        assert!(YuvFrame::from_rgb(&[0; 10], 2, 2).is_err());
    }

    #[test]
    fn blend_interpolates_and_respects_endpoints() {
        let a = YuvFrame::from_rgb(&solid(0, 0, 0, 4, 4), 4, 4).unwrap();
        let b = YuvFrame::from_rgb(&solid(255, 255, 255, 4, 4), 4, 4).unwrap();
        assert_eq!(YuvFrame::blend(&a, &b, 0.0).unwrap(), a);
        assert_eq!(YuvFrame::blend(&a, &b, 1.0).unwrap(), b);
        assert_eq!(YuvFrame::blend(&a, &b, 7.0).unwrap(), b);
        let mid = YuvFrame::blend(&a, &b, 0.5).unwrap();
        assert!(
            mid.y().iter().all(|&v| v == 126 || v == 125),
            "{:?}",
            &mid.y()[..4]
        );
        assert!(mid.u().iter().all(|&v| v == 128));
        let other = YuvFrame::from_rgb(&solid(0, 0, 0, 2, 2), 2, 2).unwrap();
        assert!(YuvFrame::blend(&a, &other, 0.5).is_err());
    }
}
