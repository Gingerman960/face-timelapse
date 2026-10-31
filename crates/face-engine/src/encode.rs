//! Image encoders: JPEG (`jpeg-encoder`, pure Rust) and PNG (`png` via the
//! `image` crate, fast compression).

use image::ImageEncoder;
use jpeg_encoder::{ColorType, Encoder, SamplingFactor};

use crate::error::{EngineError, Result};
use crate::image::RgbImage;

/// Chroma subsampling for JPEG output.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Chroma {
    /// 4:4:4 — full-resolution colour (masters, exports).
    Full,
    /// 4:2:0 — smaller files (thumbnails, previews).
    Subsampled,
}

/// Encodes a JPEG with 4:4:4 chroma at `quality` (1–100).
///
/// # Errors
/// [`EngineError::Encode`] if the image exceeds 65 535 px or encoding fails.
pub fn jpeg(img: &RgbImage, quality: u8) -> Result<Vec<u8>> {
    jpeg_with(img, quality, Chroma::Full)
}

/// Encodes a JPEG with the given chroma mode.
///
/// # Errors
/// See [`jpeg`].
pub fn jpeg_with(img: &RgbImage, quality: u8, chroma: Chroma) -> Result<Vec<u8>> {
    let w = u16::try_from(img.width())
        .map_err(|_| EngineError::Encode(format!("JPEG width {} too large", img.width())))?;
    let h = u16::try_from(img.height())
        .map_err(|_| EngineError::Encode(format!("JPEG height {} too large", img.height())))?;
    let mut out = Vec::with_capacity(img.as_raw().len() / 6);
    let mut enc = Encoder::new(&mut out, quality.clamp(1, 100));
    enc.set_sampling_factor(match chroma {
        Chroma::Full => SamplingFactor::R_4_4_4,
        Chroma::Subsampled => SamplingFactor::R_4_2_0,
    });
    enc.encode(img.as_raw(), w, h, ColorType::Rgb)
        .map_err(|e| EngineError::Encode(e.to_string()))?;
    Ok(out)
}

/// Encodes a PNG (8-bit RGB, fast deflate, adaptive filtering).
///
/// # Errors
/// [`EngineError::Encode`] on encoder failure.
pub fn png(img: &RgbImage) -> Result<Vec<u8>> {
    let mut out = Vec::with_capacity(img.as_raw().len() / 2);
    image::codecs::png::PngEncoder::new_with_quality(
        &mut out,
        image::codecs::png::CompressionType::Fast,
        image::codecs::png::FilterType::Adaptive,
    )
    .write_image(
        img.as_raw(),
        img.width(),
        img.height(),
        image::ExtendedColorType::Rgb8,
    )
    .map_err(|e| EngineError::Encode(e.to_string()))?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::decode::{DecodeTarget, decode, tests::pattern};
    use std::path::Path;

    #[test]
    fn jpeg_round_trip_is_close() {
        let src = pattern(64, 48);
        for chroma in [Chroma::Full, Chroma::Subsampled] {
            let bytes = jpeg_with(&src, 95, chroma).expect("encode");
            let back = decode(&bytes, Path::new("x.jpg"), 1, DecodeTarget::Full).expect("decode");
            let err: u64 = src
                .as_raw()
                .iter()
                .zip(back.image.as_raw())
                .map(|(a, b)| u64::from(a.abs_diff(*b)))
                .sum();
            let mean = err as f64 / src.as_raw().len() as f64;
            assert!(mean < 4.0, "{chroma:?}: mean abs error {mean}");
        }
    }

    #[test]
    fn png_is_lossless() {
        let src = pattern(33, 17);
        let bytes = png(&src).expect("png");
        let back = decode(&bytes, Path::new("x.png"), 1, DecodeTarget::Full).expect("decode");
        assert_eq!(back.image, src);
    }

    #[test]
    fn rejects_oversized_jpeg() {
        let wide = RgbImage::new(70_000, 1);
        assert_eq!(
            jpeg(&wide, 90).expect_err("too wide").kind(),
            crate::ErrorKind::EncodeFailed
        );
        let tall = RgbImage::new(1, 70_000);
        assert!(jpeg(&tall, 90).is_err());
    }
}
