//! Frame inputs: in-memory RGB frames, lazily computed frames, or image files.
//!
//! A [`FrameSource`] hands out one [`FrameLoader`] per frame, in order. The
//! encoder runs loaders on its worker pool, so expensive work (JPEG decoding,
//! or face alignment done by the caller) happens in parallel while results
//! are still consumed in order.

use std::path::{Path, PathBuf};

use chrono::NaiveDate;
use image::{DynamicImage, ImageDecoder, ImageReader};

use crate::error::{Result, VideoError};

/// One input frame: tightly packed 8-bit RGB pixels plus an optional date
/// used for the caption.
#[derive(Clone, PartialEq, Eq)]
pub struct Frame {
    /// Width in pixels.
    pub width: u32,
    /// Height in pixels.
    pub height: u32,
    /// `width * height * 3` bytes, row-major RGB.
    pub rgb: Vec<u8>,
    /// Capture date shown in the caption (if captions are enabled).
    pub date: Option<NaiveDate>,
}

impl std::fmt::Debug for Frame {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Frame")
            .field("width", &self.width)
            .field("height", &self.height)
            .field("date", &self.date)
            .finish_non_exhaustive()
    }
}

impl Frame {
    /// Creates a frame, checking that the buffer matches the dimensions.
    ///
    /// # Errors
    /// [`VideoError::InvalidFrame`] (index 0) if the buffer size is wrong.
    pub fn new(width: u32, height: u32, rgb: Vec<u8>, date: Option<NaiveDate>) -> Result<Self> {
        let frame = Self {
            width,
            height,
            rgb,
            date,
        };
        frame.validate(0)?;
        Ok(frame)
    }

    /// Checks dimensions and buffer length; `index` is used in the error.
    ///
    /// # Errors
    /// [`VideoError::InvalidFrame`] describing the problem.
    pub fn validate(&self, index: usize) -> Result<()> {
        if self.width == 0 || self.height == 0 {
            return Err(VideoError::InvalidFrame {
                index,
                reason: format!("zero-sized frame {}x{}", self.width, self.height),
            });
        }
        let expected = self.width as usize * self.height as usize * 3;
        if self.rgb.len() != expected {
            return Err(VideoError::InvalidFrame {
                index,
                reason: format!(
                    "RGB buffer has {} bytes, expected {expected} for {}x{}",
                    self.rgb.len(),
                    self.width,
                    self.height
                ),
            });
        }
        Ok(())
    }
}

/// Deferred production of one frame; executed on a worker thread.
pub type FrameLoader = Box<dyn FnOnce() -> Result<Frame> + Send>;

/// An ordered sequence of frames with a known length.
pub trait FrameSource: Send {
    /// Number of frames [`FrameSource::next_loader`] will yield.
    fn len(&self) -> usize;

    /// True if the source has no frames.
    fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// The loader for the next frame, or `None` when exhausted.
    fn next_loader(&mut self) -> Option<FrameLoader>;
}

/// A JPEG/PNG file and the date to caption it with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageInput {
    /// Image file.
    pub path: PathBuf,
    /// Caption date.
    pub date: Option<NaiveDate>,
}

/// Frames decoded from image files (JPEG or PNG, EXIF orientation applied).
#[derive(Debug, Clone)]
pub struct ImageFiles {
    inputs: std::vec::IntoIter<ImageInput>,
    len: usize,
}

impl ImageFiles {
    /// Frames from `inputs`, in the given order.
    #[must_use]
    pub fn new(inputs: Vec<ImageInput>) -> Self {
        let len = inputs.len();
        Self {
            inputs: inputs.into_iter(),
            len,
        }
    }

    /// Frames from paths, dating each one from its file name when possible
    /// (see [`date_from_filename`]).
    #[must_use]
    pub fn from_paths<P: AsRef<Path>>(paths: &[P]) -> Self {
        Self::new(
            paths
                .iter()
                .map(|p| ImageInput {
                    path: p.as_ref().to_path_buf(),
                    date: date_from_filename(p.as_ref()),
                })
                .collect(),
        )
    }
}

impl FrameSource for ImageFiles {
    fn len(&self) -> usize {
        self.len
    }

    fn next_loader(&mut self) -> Option<FrameLoader> {
        let input = self.inputs.next()?;
        Some(Box::new(move || decode_image(&input.path, input.date)))
    }
}

/// Frames produced by an iterator (e.g. aligned frames from the face engine).
pub struct FrameIter<I> {
    iter: I,
    len: usize,
}

impl<I> FrameIter<I>
where
    I: Iterator<Item = Result<Frame>> + Send,
{
    /// Wraps `iter`, which must yield exactly `len` items.
    pub fn new(iter: I, len: usize) -> Self {
        Self { iter, len }
    }
}

impl FrameIter<std::iter::Map<std::vec::IntoIter<Frame>, fn(Frame) -> Result<Frame>>> {
    /// Frames already in memory.
    #[must_use]
    pub fn from_frames(frames: Vec<Frame>) -> Self {
        let len = frames.len();
        Self {
            iter: frames.into_iter().map(Ok as fn(Frame) -> Result<Frame>),
            len,
        }
    }
}

impl<I> FrameSource for FrameIter<I>
where
    I: Iterator<Item = Result<Frame>> + Send,
{
    fn len(&self) -> usize {
        self.len
    }

    fn next_loader(&mut self) -> Option<FrameLoader> {
        let item = self.iter.next()?;
        Some(Box::new(move || item))
    }
}

/// Largest image side [`decode_image`] decodes (the face engine's limit).
pub const MAX_DECODE_SIDE: u32 = 16_384;
/// Largest pixel count [`decode_image`] decodes (the face engine's limit).
pub const MAX_DECODE_PIXELS: u64 = 150_000_000;

/// Decodes a JPEG/PNG file into an RGB frame, honouring EXIF orientation.
/// Images over [`MAX_DECODE_SIDE`] per side or [`MAX_DECODE_PIXELS`] are
/// refused from their header, before any pixel buffer exists, and the
/// decoder's allocations are capped.
///
/// # Errors
/// [`VideoError::Decode`] if the file cannot be opened or decoded, or is too large.
pub fn decode_image(path: &Path, date: Option<NaiveDate>) -> Result<Frame> {
    let decode_err = |message: String| VideoError::Decode {
        path: path.to_path_buf(),
        message,
    };
    let mut reader = ImageReader::open(path)
        .and_then(ImageReader::with_guessed_format)
        .map_err(|e| decode_err(e.to_string()))?;
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(MAX_DECODE_PIXELS * 4);
    reader.limits(limits);
    let mut decoder = reader
        .into_decoder()
        .map_err(|e| decode_err(e.to_string()))?;
    let (w, h) = decoder.dimensions();
    if w > MAX_DECODE_SIDE || h > MAX_DECODE_SIDE || u64::from(w) * u64::from(h) > MAX_DECODE_PIXELS
    {
        return Err(decode_err(format!(
            "image too large ({w}×{h} px; the limit is {MAX_DECODE_SIDE} px per side and {} MP)",
            MAX_DECODE_PIXELS / 1_000_000
        )));
    }
    let orientation = decoder
        .orientation()
        .map_err(|e| decode_err(e.to_string()))?;
    let mut image = DynamicImage::from_decoder(decoder).map_err(|e| decode_err(e.to_string()))?;
    image.apply_orientation(orientation);
    let rgb = image.into_rgb8();
    let (width, height) = rgb.dimensions();
    Ok(Frame {
        width,
        height,
        rgb: rgb.into_raw(),
        date,
    })
}

/// Extracts a `YYYYMMDD` date (years 1990-2099) from a file name such as
/// `20120901_111216.jpg` or `IMG_20140815_142326.jpg`.
#[must_use]
pub fn date_from_filename(path: &Path) -> Option<NaiveDate> {
    let name = path.file_name()?.to_str()?;
    let bytes = name.as_bytes();
    (0..bytes.len().saturating_sub(7)).find_map(|start| {
        let window = &bytes[start..start + 8];
        let bounded = (start == 0 || !bytes[start - 1].is_ascii_digit())
            && bytes.get(start + 8).is_none_or(|b| !b.is_ascii_digit());
        if !bounded || !window.iter().all(u8::is_ascii_digit) {
            return None;
        }
        let digits = std::str::from_utf8(window).ok()?;
        let year: i32 = digits[..4].parse().ok()?;
        let month: u32 = digits[4..6].parse().ok()?;
        let day: u32 = digits[6..].parse().ok()?;
        (1990..=2099)
            .contains(&year)
            .then(|| NaiveDate::from_ymd_opt(year, month, day))
            .flatten()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ymd(y: i32, m: u32, d: u32) -> Option<NaiveDate> {
        NaiveDate::from_ymd_opt(y, m, d)
    }

    #[test]
    fn frame_validation_checks_buffer_size() {
        assert!(Frame::new(2, 2, vec![0; 12], None).is_ok());
        let err = Frame::new(2, 2, vec![0; 11], None).unwrap_err();
        assert!(err.to_string().contains("expected 12"), "{err}");
        assert!(Frame::new(0, 2, vec![], None).is_err());
        let f = Frame::new(1, 1, vec![1, 2, 3], ymd(2020, 1, 2)).unwrap();
        assert!(format!("{f:?}").contains("2020-01-02"));
    }

    #[test]
    fn parses_dates_from_known_filename_patterns() {
        let cases = [
            ("20120901_111216.jpg", ymd(2012, 9, 1)),
            ("IMG_20140815_142326.jpg", ymd(2014, 8, 15)),
            ("IMG_20220829.jpg", ymd(2022, 8, 29)),
            ("IMG_20190101_ 1.JPG", ymd(2019, 1, 1)),
            ("20130505_120000(1).jpg", ymd(2013, 5, 5)),
            ("IMG_20221399.jpg", None),
            ("photo.jpg", None),
            ("123456789.jpg", None),
            ("18990101.jpg", None),
        ];
        for (name, want) in cases {
            assert_eq!(date_from_filename(Path::new(name)), want, "{name}");
        }
    }

    #[test]
    fn frame_iter_yields_frames_in_order() {
        let frames: Vec<Frame> = (0..3u8)
            .map(|i| Frame::new(1, 1, vec![i, i, i], None).unwrap())
            .collect();
        let mut src = FrameIter::from_frames(frames);
        assert_eq!(src.len(), 3);
        assert!(!src.is_empty());
        let got: Vec<u8> = std::iter::from_fn(|| src.next_loader())
            .map(|load| load().unwrap().rgb[0])
            .collect();
        assert_eq!(got, vec![0, 1, 2]);
    }

    #[test]
    fn decodes_png_and_reports_missing_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("IMG_20200304.png");
        image::RgbImage::from_fn(5, 3, |x, y| image::Rgb([x as u8 * 10, y as u8 * 20, 7]))
            .save(&path)
            .unwrap();
        let mut src = ImageFiles::from_paths(&[&path, &dir.path().join("missing.jpg")]);
        assert_eq!(src.len(), 2);
        let frame = (src.next_loader().unwrap())().unwrap();
        assert_eq!((frame.width, frame.height), (5, 3));
        assert_eq!(&frame.rgb[3..6], &[10, 0, 7]);
        assert_eq!(frame.date, ymd(2020, 3, 4));
        let err = (src.next_loader().unwrap())().unwrap_err();
        assert!(matches!(err, VideoError::Decode { .. }), "{err}");
        assert!(src.next_loader().is_none());
    }

    #[test]
    fn images_beyond_the_decode_limits_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        // Tiny file, but a side over the limit (the face engine's limit too).
        let wide = dir.path().join("wide.png");
        image::RgbImage::new(MAX_DECODE_SIDE + 1, 2)
            .save(&wide)
            .unwrap();
        let err = decode_image(&wide, None).unwrap_err();
        assert!(err.to_string().contains("too large"), "{err}");
        let ok = dir.path().join("ok.png");
        image::RgbImage::new(MAX_DECODE_SIDE, 2).save(&ok).unwrap();
        assert!(decode_image(&ok, None).is_ok());
    }

    #[test]
    fn applies_exif_orientation_to_jpeg() {
        // A 4x2 JPEG with EXIF orientation 6 (rotate 90 CW) must decode as 2x4.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rotated.jpg");
        let img = image::RgbImage::from_pixel(4, 2, image::Rgb([200, 100, 50]));
        let mut jpeg = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 95)
            .encode_image(&img)
            .unwrap();
        // Insert an APP1/Exif segment right after SOI.
        let exif: &[u8] = &[
            b'E', b'x', b'i', b'f', 0, 0, b'M', b'M', 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0,
            0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0,
        ];
        let mut out = jpeg[..2].to_vec();
        out.extend_from_slice(&[0xff, 0xe1]);
        out.extend_from_slice(&((exif.len() + 2) as u16).to_be_bytes());
        out.extend_from_slice(exif);
        out.extend_from_slice(&jpeg[2..]);
        std::fs::write(&path, out).unwrap();
        let frame = decode_image(&path, None).unwrap();
        assert_eq!((frame.width, frame.height), (2, 4));
    }
}
