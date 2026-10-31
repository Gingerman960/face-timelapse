//! Image decoding: format sniffing, EXIF (orientation, dates, thumbnail),
//! DCT-scaled JPEG decode and full decode, always returning an upright
//! (EXIF-oriented) RGB image.
//!
//! JPEG strategy (measured, see `BENCHMARKS.md`):
//! - scale < 1 → `jpeg-decoder` DCT-domain scaling (1/2, 1/4, 1/8): the IDCT
//!   and colour conversion run on the reduced image, so a 12 MP selfie decodes
//!   to 1008×756 in ~24 ms instead of a 30–56 ms full decode + resize;
//! - scale = 1 → `zune-jpeg` (fastest pure-Rust full decoder), falling back to
//!   `jpeg-decoder` for the rare files it rejects.
//!
//! Resource limits (decompression bombs: a few hundred bytes can claim a
//! 65535² image): files above [`MAX_FILE_BYTES`] are not read; every format's
//! header is checked against [`MAX_SIDE`] / [`MAX_PIXELS`] before any pixel
//! buffer exists; decoder allocations are capped; and full-resolution
//! buffers across all threads share [`PIXEL_BUDGET`], so parallel workers
//! cannot multiply the peak. A share is taken *before* a decoder allocates —
//! for jpeg-decoder its planes plus the RGB output (2 × the output), plus the
//! full-resolution coefficient planes of a progressive/lossless file whatever
//! output size is asked for — and stays with the [`Decoded`] image until the
//! caller drops it, calls [`Decoded::into_image`] or
//! [`Decoded::release_budget`].
//!
//! Deadlock freedom rests on two rules. (1) No thread runs parallel (rayon)
//! work while holding a share — a worker waiting on a stolen task could run
//! a sibling item that waits for budget its own stack holds. Every parallel
//! loop over pixels or items asserts this in debug builds; the scan shrinks
//! large decodes to its working size before detecting, align releases before
//! compositing, the reference before rotating, and the 112×112 face crop is
//! warped on the calling thread. (2) A thread that already holds a share never
//! waits for another (debug builds flag it as a bug; release builds proceed),
//! and waiting requests are served first-in, first-out — so a request for
//! the whole budget is served once the earlier holders finish, never starved.

use std::io::{Cursor, Read};
use std::path::Path;
use std::sync::{Condvar, Mutex};

use crate::dates::{self, ExifDates};
use crate::error::{EngineError, Result};
use crate::geometry::Size;
use crate::image::{RgbImage, oriented_size};

mod budget;
mod jpeg;

use budget::coefficient_pixels;
#[cfg(test)]
pub(crate) use budget::take_requests;
pub(crate) use budget::{PixelPermit, assert_no_share_held};
use jpeg::decode_jpeg;

/// Container format detected from magic bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageFormat {
    /// JPEG / JFIF / EXIF.
    Jpeg,
    /// PNG.
    Png,
    /// WebP.
    WebP,
    /// TIFF (either byte order).
    Tiff,
    /// HEIF/HEIC/AVIF family (recognised, not decodable).
    Heif,
    /// Anything else.
    Unknown,
}

/// Detects the container format from the first bytes of a file.
#[must_use]
pub fn sniff(bytes: &[u8]) -> ImageFormat {
    match bytes {
        [0xFF, 0xD8, 0xFF, ..] => ImageFormat::Jpeg,
        [0x89, b'P', b'N', b'G', ..] => ImageFormat::Png,
        [
            b'R',
            b'I',
            b'F',
            b'F',
            _,
            _,
            _,
            _,
            b'W',
            b'E',
            b'B',
            b'P',
            ..,
        ] => ImageFormat::WebP,
        [b'I', b'I', 0x2A, 0x00, ..] | [b'M', b'M', 0x00, 0x2A, ..] => ImageFormat::Tiff,
        [_, _, _, _, b'f', b't', b'y', b'p', ..] => ImageFormat::Heif,
        _ => ImageFormat::Unknown,
    }
}

/// Metadata read from the EXIF block.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ExifInfo {
    /// EXIF orientation 1–8 (1 when absent or invalid).
    pub orientation: u16,
    /// Date tags.
    pub dates: ExifDates,
    /// Byte range of the embedded JPEG thumbnail inside the file, if any.
    pub thumbnail: Option<std::ops::Range<usize>>,
}

/// Parses EXIF from an in-memory file. Missing or broken EXIF yields defaults.
#[must_use]
pub fn read_exif(bytes: &[u8]) -> ExifInfo {
    let mut info = ExifInfo {
        orientation: 1,
        ..ExifInfo::default()
    };
    // Many phones (e.g. Samsung) write a non-zero "next IFD" pointer after the
    // Exif sub-IFD; strict parsing rejects the whole block. Keep partial results.
    let parsed = exif::Reader::new()
        .continue_on_error(true)
        .read_from_container(&mut Cursor::new(bytes))
        .or_else(|e| {
            e.distill_partial_result(|errors| {
                log::trace!("ignored {} EXIF errors", errors.len());
            })
        });
    let Ok(exif) = parsed else {
        return info;
    };
    if let Some(o) = exif
        .get_field(exif::Tag::Orientation, exif::In::PRIMARY)
        .and_then(|f| f.value.get_uint(0))
        .and_then(|v| u16::try_from(v).ok())
        .filter(|v| (1..=8).contains(v))
    {
        info.orientation = o;
    }
    let date = |tag| {
        exif.get_field(tag, exif::In::PRIMARY)
            .and_then(|f| match &f.value {
                exif::Value::Ascii(parts) => parts
                    .first()
                    .and_then(|p| std::str::from_utf8(p).ok())
                    .and_then(dates::parse_exif_datetime),
                _ => None,
            })
    };
    info.dates = ExifDates {
        original: date(exif::Tag::DateTimeOriginal),
        digitized: date(exif::Tag::DateTimeDigitized),
        modified: date(exif::Tag::DateTime),
    };
    info.thumbnail = thumbnail_range(bytes, &exif);
    info
}

/// Locates the IFD1 JPEG thumbnail inside `bytes` (offsets in EXIF are
/// relative to the TIFF header, which is where `exif.buf()` starts).
fn thumbnail_range(bytes: &[u8], exif: &exif::Exif) -> Option<std::ops::Range<usize>> {
    let field = |tag| {
        exif.get_field(tag, exif::In::THUMBNAIL)
            .and_then(|f| f.value.get_uint(0))
            .and_then(|v| usize::try_from(v).ok())
    };
    let offset = field(exif::Tag::JPEGInterchangeFormat)?;
    let len = field(exif::Tag::JPEGInterchangeFormatLength)?;
    let buf = exif.buf();
    let thumb = buf.get(offset..offset.checked_add(len)?)?;
    if sniff(thumb) != ImageFormat::Jpeg {
        return None;
    }
    // Translate to an offset in the original file.
    let tiff_start = find_subslice(bytes, &buf[..buf.len().min(64)])?;
    let start = tiff_start.checked_add(offset)?;
    Some(start..start.checked_add(len)?)
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() {
        return None;
    }
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// How large the decoded image must be.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum DecodeTarget {
    /// Full resolution.
    Full,
    /// Smallest JPEG DCT scale whose long edge is ≥ this many pixels
    /// (non-JPEG formats always decode fully).
    MinLongEdge(u32),
    /// Smallest DCT factor `f ∈ {1/8, 1/4, 1/2, 1}` with `f ≥ factor`.
    MinScale(f64),
}

/// An upright decoded image and its relation to the full-resolution photo.
#[derive(Debug)]
pub struct Decoded {
    /// Upright RGB pixels.
    pub image: RgbImage,
    /// Upright full-resolution size of the photo.
    pub full_size: Size,
    /// EXIF orientation that was applied.
    pub orientation: u16,
    /// This image's share of [`PIXEL_BUDGET`] (none for small images).
    pub(crate) budget: Budget,
}

/// A share of [`PIXEL_BUDGET`]; dropping it gives the pixels back.
#[derive(Debug, Default)]
pub struct Budget(Option<PixelPermit>);

impl Decoded {
    /// Pixels of [`PIXEL_BUDGET`] this image still holds.
    #[must_use]
    pub fn budget_pixels(&self) -> u64 {
        self.budget.0.as_ref().map_or(0, PixelPermit::pixels)
    }

    /// The pixels, giving the budget share back now (moving `.image` out of
    /// a `Decoded` would keep the share until the rest of it is dropped).
    #[must_use]
    pub fn into_image(self) -> RgbImage {
        self.image
    }

    /// Gives this image's budget share back now — required before running
    /// parallel work on it (see the module docs); the pixels stay usable.
    pub fn release_budget(&mut self) {
        self.budget = Budget::default();
    }

    /// Horizontal factor from full-resolution to decoded pixels.
    #[must_use]
    pub fn scale_x(&self) -> f64 {
        f64::from(self.image.width()) / f64::from(self.full_size.width.max(1))
    }

    /// Vertical factor from full-resolution to decoded pixels.
    #[must_use]
    pub fn scale_y(&self) -> f64 {
        f64::from(self.image.height()) / f64::from(self.full_size.height.max(1))
    }
}

/// Largest image side the engine decodes (zune-jpeg's default limit).
pub const MAX_SIDE: u32 = 16_384;
/// Largest pixel count the engine decodes (~ 450 MB as RGB).
pub const MAX_PIXELS: u64 = 150_000_000;
/// Files larger than this are refused without being read.
pub const MAX_FILE_BYTES: u64 = 256 * 1024 * 1024;
/// Pixels of large decoded buffers allowed in flight at once, all threads
/// together (~ 1.2 GB as RGB).
pub const PIXEL_BUDGET: u64 = 400_000_000;
/// Decodes smaller than this skip the shared budget (DCT-scaled scans).
const BUDGET_THRESHOLD: u64 = 8_000_000;
/// Allocation cap handed to the decoders (bytes).
const MAX_ALLOC_BYTES: u64 = MAX_PIXELS * 4;

/// Refuses images whose header claims more than the engine decodes.
///
/// # Errors
/// [`EngineError::Decode`] ("too large").
pub fn check_dimensions(size: Size, path: &Path) -> Result<()> {
    let pixels = u64::from(size.width) * u64::from(size.height);
    if size.width > MAX_SIDE || size.height > MAX_SIDE || pixels > MAX_PIXELS {
        return Err(EngineError::decode(
            path,
            format!(
                "image too large ({}×{} px; the limit is {MAX_SIDE} px per side and {} MP)",
                size.width,
                size.height,
                MAX_PIXELS / 1_000_000
            ),
        ));
    }
    Ok(())
}

/// Reads a whole image file, refusing files above [`MAX_FILE_BYTES`].
///
/// # Errors
/// [`EngineError::Io`] on read failures, [`EngineError::Decode`] when too big.
pub fn read_file(path: &Path) -> Result<Vec<u8>> {
    let io = |e| EngineError::io(format!("reading {}", path.display()), e);
    let file = std::fs::File::open(path).map_err(io)?;
    let len = file.metadata().map_err(io)?.len();
    let too_big = || {
        EngineError::decode(
            path,
            format!(
                "file too large (limit {} MB)",
                MAX_FILE_BYTES / (1024 * 1024)
            ),
        )
    };
    if len > MAX_FILE_BYTES {
        return Err(too_big());
    }
    let mut bytes = Vec::with_capacity(usize::try_from(len).unwrap_or(0));
    file.take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(io)?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(too_big());
    }
    Ok(bytes)
}

/// Decodes `bytes` (a whole file) to an upright RGB image.
///
/// # Errors
/// [`EngineError::UnsupportedFormat`] for HEIF/unknown data,
/// [`EngineError::Decode`] for corrupt files.
pub fn decode(
    bytes: &[u8],
    path: &Path,
    orientation: u16,
    target: DecodeTarget,
) -> Result<Decoded> {
    let (raw, raw_full, permit) = match sniff(bytes) {
        ImageFormat::Jpeg => decode_jpeg(bytes, path, target)?,
        ImageFormat::Png | ImageFormat::WebP | ImageFormat::Tiff => {
            let (img, permit) = decode_other(bytes, path)?;
            let size = img.size();
            (img, size, permit)
        }
        ImageFormat::Heif | ImageFormat::Unknown => {
            return Err(EngineError::UnsupportedFormat {
                path: path.to_path_buf(),
            });
        }
    };
    // The share stays held through the orientation copy and after it.
    Ok(Decoded {
        image: raw.oriented(orientation),
        full_size: oriented_size(raw_full, orientation),
        orientation,
        budget: Budget(Some(permit)),
    })
}

/// Reads a file and decodes it (EXIF orientation applied).
///
/// # Errors
/// I/O errors plus everything [`decode`] returns.
pub fn decode_file(path: &Path, target: DecodeTarget) -> Result<Decoded> {
    let bytes = read_file(path)?;
    let exif = read_exif(&bytes);
    decode(&bytes, path, exif.orientation, target)
}

/// Upright full-resolution size from headers only (no pixel decode).
///
/// # Errors
/// Same as [`decode`].
pub fn probe_size(bytes: &[u8], path: &Path, orientation: u16) -> Result<Size> {
    let raw = match sniff(bytes) {
        ImageFormat::Jpeg => {
            let mut d = jpeg_decoder::Decoder::new(bytes);
            d.read_info()
                .map_err(|e| EngineError::decode(path, e.to_string()))?;
            let info = d
                .info()
                .ok_or_else(|| EngineError::decode(path, "missing JPEG header"))?;
            Size::new(u32::from(info.width), u32::from(info.height))
        }
        ImageFormat::Png | ImageFormat::WebP | ImageFormat::Tiff => {
            let reader = image::ImageReader::new(Cursor::new(bytes))
                .with_guessed_format()
                .map_err(|e| EngineError::decode(path, e.to_string()))?;
            let (w, h) = reader
                .into_dimensions()
                .map_err(|e| EngineError::decode(path, e.to_string()))?;
            Size::new(w, h)
        }
        ImageFormat::Heif | ImageFormat::Unknown => {
            return Err(EngineError::UnsupportedFormat {
                path: path.to_path_buf(),
            });
        }
    };
    check_dimensions(raw, path)?;
    Ok(oriented_size(raw, orientation))
}

fn decode_other(bytes: &[u8], path: &Path) -> Result<(RgbImage, PixelPermit)> {
    let err = |e: image::ImageError| EngineError::decode(path, e.to_string());
    let reader = || {
        let mut r = image::ImageReader::new(Cursor::new(bytes))
            .with_guessed_format()
            .map_err(|e| EngineError::decode(path, e.to_string()))?;
        let mut limits = image::Limits::default();
        limits.max_image_width = Some(MAX_SIDE);
        limits.max_image_height = Some(MAX_SIDE);
        limits.max_alloc = Some(MAX_ALLOC_BYTES);
        r.limits(limits);
        Ok::<_, EngineError>(r)
    };
    let (w, h) = reader()?.into_dimensions().map_err(err)?;
    check_dimensions(Size::new(w, h), path)?;
    let permit = PixelPermit::acquire(u64::from(w) * u64::from(h));
    let img = reader()?.decode().map_err(err)?;
    let rgb = img.into_rgb8();
    let (w, h) = rgb.dimensions();
    Ok((RgbImage::from_raw(w, h, rgb.into_raw())?, permit))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// Encodes a test image as baseline JPEG (q95, 4:4:4) via jpeg-encoder.
    pub(crate) fn jpeg_bytes(img: &RgbImage) -> Vec<u8> {
        crate::encode::jpeg(img, 95).expect("encode")
    }

    /// A tiny baseline JPEG whose SOF claims `dim × dim`, truncated right
    /// after the SOS header (a decompression bomb: a few hundred bytes).
    pub(crate) fn bomb_jpeg(dim: u16) -> Vec<u8> {
        let mut buf = jpeg_bytes(&pattern(16, 16));
        let sof = buf
            .windows(2)
            .position(|w| w == [0xFF, 0xC0] || w == [0xFF, 0xC1])
            .expect("SOF");
        buf[sof + 5..sof + 7].copy_from_slice(&dim.to_be_bytes());
        buf[sof + 7..sof + 9].copy_from_slice(&dim.to_be_bytes());
        let sos = buf.windows(2).position(|w| w == [0xFF, 0xDA]).expect("SOS");
        let len = usize::from(u16::from_be_bytes([buf[sos + 2], buf[sos + 3]]));
        buf.truncate(sos + 2 + len + 4);
        buf
    }

    /// A tiny *progressive* JPEG claiming `dim × dim`, truncated after the
    /// first scan header: jpeg-decoder allocates full-resolution coefficient
    /// planes for it even when asked for a small DCT-scaled output.
    pub(crate) fn progressive_bomb_jpeg(dim: u16) -> Vec<u8> {
        let img = pattern(16, 16);
        let mut buf = Vec::new();
        let mut enc = jpeg_encoder::Encoder::new(&mut buf, 90);
        enc.set_progressive(true);
        enc.set_sampling_factor(jpeg_encoder::SamplingFactor::R_4_4_4);
        enc.encode(img.as_raw(), 16, 16, jpeg_encoder::ColorType::Rgb)
            .expect("encode");
        let sof = buf
            .windows(2)
            .position(|w| w == [0xFF, 0xC2])
            .expect("SOF2");
        buf[sof + 5..sof + 7].copy_from_slice(&dim.to_be_bytes());
        buf[sof + 7..sof + 9].copy_from_slice(&dim.to_be_bytes());
        let sos = buf.windows(2).position(|w| w == [0xFF, 0xDA]).expect("SOS");
        let len = usize::from(u16::from_be_bytes([buf[sos + 2], buf[sos + 3]]));
        buf.truncate(sos + 2 + len + 4);
        buf
    }

    /// Gradient test pattern with a red block in the top-left quadrant.
    pub(crate) fn pattern(w: u32, h: u32) -> RgbImage {
        let mut data = Vec::with_capacity((w * h * 3) as usize);
        for y in 0..h {
            for x in 0..w {
                let red = x < w / 2 && y < h / 2;
                #[allow(clippy::cast_possible_truncation)]
                let g = ((x * 255) / w.max(1)) as u8;
                data.extend_from_slice(&[if red { 230 } else { 20 }, g, 60]);
            }
        }
        RgbImage::from_raw(w, h, data).expect("pattern")
    }

    #[test]
    fn progressive_jpegs_are_budgeted_at_full_size_before_decoding() {
        // 12000² = 144 MP: under every cap, but its coefficient planes alone
        // are ~860 MB whatever output size is asked for.
        let bomb = progressive_bomb_jpeg(12_000);
        assert!(bomb.len() < 1024, "{} bytes", bomb.len());
        let full = 12_000u64 * 12_000;
        for target in [DecodeTarget::MinLongEdge(640), DecodeTarget::MinScale(0.1)] {
            take_requests();
            let _ = decode(&bomb, Path::new("p.jpg"), 1, target);
            let requests = take_requests();
            assert!(
                requests.first().is_some_and(|&first| first >= 2 * full),
                "the first budget request must cover the coefficient planes: {requests:?}"
            );
        }
    }

    #[test]
    fn decoded_images_hold_their_budget_share_until_released() {
        let big = crate::encode::png(&RgbImage::new(3_000, 3_000)).expect("png");
        let mut d = decode(&big, Path::new("big.png"), 1, DecodeTarget::Full).expect("decode");
        assert_eq!(
            d.budget_pixels(),
            9_000_000,
            "held with the full-resolution pixels"
        );
        d.release_budget();
        assert_eq!(d.budget_pixels(), 0);
        let rotated = decode(&big, Path::new("big.png"), 6, DecodeTarget::Full).expect("decode");
        assert_eq!(
            rotated.budget_pixels(),
            9_000_000,
            "kept through the orientation copy"
        );
        // Small (DCT-scaled) results hold nothing.
        let small = decode(
            &jpeg_bytes(&pattern(4_000, 3_000)),
            Path::new("s.jpg"),
            1,
            DecodeTarget::MinLongEdge(640),
        )
        .expect("decode");
        assert_eq!(small.budget_pixels(), 0);
    }

    #[test]
    fn decompression_bombs_are_refused_before_allocating() {
        for target in [
            DecodeTarget::MinLongEdge(640),
            DecodeTarget::MinScale(0.5),
            DecodeTarget::Full,
        ] {
            let bomb = bomb_jpeg(20_000);
            assert!(bomb.len() < 1024, "{} bytes", bomb.len());
            let err = decode(&bomb, Path::new("bomb.jpg"), 1, target).expect_err("bomb");
            assert_eq!(err.kind(), crate::ErrorKind::DecodeFailed);
            assert!(err.to_string().contains("too large"), "{err}");
        }
        // The worst case (65535² ≈ 13 GB if decoded) is refused just as fast.
        let worst = decode(
            &bomb_jpeg(u16::MAX),
            Path::new("b.jpg"),
            1,
            DecodeTarget::Full,
        );
        assert!(worst.expect_err("bomb").to_string().contains("too large"));
        // Headers are checked by the size probe too.
        assert!(probe_size(&bomb_jpeg(20_000), Path::new("b.jpg"), 1).is_err());
        assert!(check_dimensions(Size::new(16_384, 9_000), Path::new("ok")).is_ok());
        assert!(check_dimensions(Size::new(16_385, 10), Path::new("x")).is_err());
        assert!(check_dimensions(Size::new(15_000, 15_000), Path::new("x")).is_err());
    }

    #[test]
    fn oversized_png_headers_and_files_are_refused() {
        // A PNG whose IHDR claims 20000×20000 (no pixel data at all).
        let mut png = crate::encode::png(&pattern(4, 4)).expect("png");
        let ihdr = png.windows(4).position(|w| w == b"IHDR").expect("IHDR");
        png[ihdr + 4..ihdr + 8].copy_from_slice(&20_000u32.to_be_bytes());
        png[ihdr + 8..ihdr + 12].copy_from_slice(&20_000u32.to_be_bytes());
        let err = decode(&png, Path::new("bomb.png"), 1, DecodeTarget::Full).expect_err("png");
        assert_eq!(err.kind(), crate::ErrorKind::DecodeFailed);
        // Files above the size cap are not read (sparse file: no disk used).
        let dir = tempfile::tempdir().expect("tmp");
        let big = dir.path().join("huge.jpg");
        std::fs::File::create(&big)
            .and_then(|f| f.set_len(MAX_FILE_BYTES + 1))
            .expect("sparse");
        let err = read_file(&big).expect_err("too big");
        assert!(err.to_string().contains("file too large"), "{err}");
        assert!(decode_file(&big, DecodeTarget::Full).is_err());
        assert!(read_file(&dir.path().join("missing.jpg")).is_err());
    }

    #[test]
    fn sniffs_magic_bytes() {
        assert_eq!(sniff(&[0xFF, 0xD8, 0xFF, 0xE0]), ImageFormat::Jpeg);
        assert_eq!(sniff(b"\x89PNG\r\n"), ImageFormat::Png);
        assert_eq!(sniff(b"RIFF\0\0\0\0WEBPVP8 "), ImageFormat::WebP);
        assert_eq!(sniff(b"II*\0...."), ImageFormat::Tiff);
        assert_eq!(sniff(b"MM\0*...."), ImageFormat::Tiff);
        assert_eq!(sniff(b"\0\0\0\x18ftypheic"), ImageFormat::Heif);
        assert_eq!(sniff(b"GIF89a"), ImageFormat::Unknown);
        assert_eq!(sniff(b""), ImageFormat::Unknown);
    }

    #[test]
    fn applies_orientation_after_decoding() {
        let bytes = jpeg_bytes(&pattern(64, 32));
        let d = decode(&bytes, Path::new("o.jpg"), 6, DecodeTarget::Full).expect("decode");
        assert_eq!(d.image.size(), Size::new(32, 64));
        assert_eq!(d.full_size, Size::new(32, 64));
        assert_eq!(d.orientation, 6);
        // Red block was top-left; after a 90° CW rotation it is top-right.
        assert!(d.image.pixel(28, 4).expect("px")[0] > 180);
        assert!(d.image.pixel(4, 4).expect("px")[0] < 60);
    }

    #[test]
    fn decodes_png_and_rejects_heif_and_garbage() {
        let src = pattern(20, 10);
        let png = crate::encode::png(&src).expect("png");
        let d = decode(&png, Path::new("a.png"), 1, DecodeTarget::MinLongEdge(5)).expect("png");
        assert_eq!(d.image, src);
        assert_eq!(
            probe_size(&png, Path::new("a.png"), 1).expect("probe"),
            Size::new(20, 10)
        );
        let heif = b"\0\0\0\x18ftypheic\0\0\0\0";
        let err = decode(heif, Path::new("a.heic"), 1, DecodeTarget::Full).expect_err("heif");
        assert_eq!(err.kind(), crate::ErrorKind::UnsupportedFormat);
        assert!(probe_size(heif, Path::new("a.heic"), 1).is_err());
        let mut broken = jpeg_bytes(&src);
        broken.truncate(30);
        let err = decode(&broken, Path::new("b.jpg"), 1, DecodeTarget::Full).expect_err("broken");
        assert_eq!(err.kind(), crate::ErrorKind::DecodeFailed);
        let err = decode(
            b"\x89PNG\r\n\x1a\nxx",
            Path::new("c.png"),
            1,
            DecodeTarget::Full,
        )
        .expect_err("bad png");
        assert_eq!(err.kind(), crate::ErrorKind::DecodeFailed);
    }

    #[test]
    fn exif_defaults_when_absent() {
        let info = read_exif(&jpeg_bytes(&pattern(8, 8)));
        assert_eq!(info.orientation, 1);
        assert_eq!(info.dates, ExifDates::default());
        assert!(info.thumbnail.is_none());
        assert_eq!(read_exif(b"garbage").orientation, 1);
    }

    #[test]
    fn decode_file_reads_from_disk() {
        let dir = tempfile::tempdir().expect("tmp");
        let path = dir.path().join("x.jpg");
        std::fs::write(&path, jpeg_bytes(&pattern(16, 16))).expect("write");
        let d = decode_file(&path, DecodeTarget::Full).expect("decode");
        assert_eq!(d.image.size(), Size::new(16, 16));
        let err =
            decode_file(&dir.path().join("missing.jpg"), DecodeTarget::Full).expect_err("missing");
        assert_eq!(err.kind(), crate::ErrorKind::NotFound);
    }
}
