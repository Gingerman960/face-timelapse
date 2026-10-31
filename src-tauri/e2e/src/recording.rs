//! Pure parts of the `record_start` / `record_stop` commands: the encoder
//! command line, the frame clock and the pixel copy. The macOS capture loop
//! lives in `capture.rs`.
//!
//! A recording is a constant-frame-rate video of the app's own window. Each
//! capture is stamped with the slot of the frame clock it was taken in; slots
//! that passed while a capture was running repeat the previous image, so the
//! video keeps wall-clock time even when a capture is slower than one frame.

use std::time::Duration;

use serde::{Deserialize, Serialize};

/// Video codec of a recording (encoded by an `ffmpeg` child process from raw
/// BGRA frames on its standard input).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecordCodec {
    /// ProRes 4444 (VideoToolbox) with alpha: keeps the window's transparent
    /// rounded corners.
    #[default]
    Prores4444,
    /// ProRes 422 HQ (VideoToolbox), opaque.
    ProresHq,
    /// H.264 High (VideoToolbox) at a high bitrate, opaque, small files.
    H264,
    /// No encoder: each captured frame is appended to the file as raw BGRA
    /// (held frames are not repeated; the `.frames.tsv` slots rebuild the
    /// frame clock later). For takes where the app saturates the CPU and an
    /// encoder would fall behind.
    Raw,
}

/// The `ffmpeg` arguments that read `width`×`height` BGRA frames at `fps`
/// from standard input and write `out`; `None` for [`RecordCodec::Raw`].
#[must_use]
pub fn ffmpeg_args(
    codec: RecordCodec,
    width: u32,
    height: u32,
    fps: u32,
    out: &str,
) -> Option<Vec<String>> {
    let mut a: Vec<String> = [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-y",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "bgra",
        "-video_size",
    ]
    .iter()
    .map(|s| (*s).to_owned())
    .collect();
    a.push(format!("{width}x{height}"));
    a.push("-framerate".to_owned());
    a.push(fps.to_string());
    a.push("-i".to_owned());
    a.push("pipe:0".to_owned());
    let tail: &[&str] = match codec {
        RecordCodec::Prores4444 => &[
            "-c:v",
            "prores_videotoolbox",
            "-profile:v",
            "4444",
            "-pix_fmt",
            "bgra",
        ],
        RecordCodec::ProresHq => &[
            "-c:v",
            "prores_videotoolbox",
            "-profile:v",
            "hq",
            "-pix_fmt",
            "bgra",
        ],
        RecordCodec::H264 => &[
            "-c:v",
            "h264_videotoolbox",
            "-profile:v",
            "high",
            "-b:v",
            "80M",
            "-pix_fmt",
            "yuv420p",
        ],
        RecordCodec::Raw => return None,
    };
    a.extend(tail.iter().map(|s| (*s).to_owned()));
    a.push(out.to_owned());
    Some(a)
}

/// The frame-clock slot that time `elapsed` (since the first capture) falls
/// in.
#[must_use]
pub fn slot_at(elapsed: Duration, fps: u32) -> u64 {
    // Non-negative and far below u64::MAX for any real recording.
    (elapsed.as_secs_f64() * f64::from(fps.max(1))).floor() as u64
}

/// When slot `slot` starts, measured from the first capture.
#[must_use]
pub fn slot_start(slot: u64, fps: u32) -> Duration {
    // Exact for any slot count a recording can reach (< 2^52).
    Duration::from_secs_f64(slot as f64 / f64::from(fps.max(1)))
}

/// Checks that a CoreGraphics image is 32-bit with its alpha (or padding)
/// byte first in a 32-bit little-endian word, i.e. B, G, R, A in memory.
///
/// # Errors
/// A message naming the layout when it is anything else.
pub fn check_bgra(bits_per_pixel: usize, bitmap_info: u32) -> Result<(), String> {
    const ALPHA_MASK: u32 = 0x1F;
    const ORDER_MASK: u32 = 0x7000;
    const ORDER_32_LITTLE: u32 = 0x2000;
    const PREMULTIPLIED_FIRST: u32 = 2;
    const FIRST: u32 = 4;
    const NONE_SKIP_FIRST: u32 = 6;
    let alpha = bitmap_info & ALPHA_MASK;
    let order = bitmap_info & ORDER_MASK;
    let alpha_first = matches!(alpha, PREMULTIPLIED_FIRST | FIRST | NONE_SKIP_FIRST);
    if bits_per_pixel == 32 && order == ORDER_32_LITTLE && alpha_first {
        Ok(())
    } else {
        Err(format!(
            "unsupported capture layout: {bits_per_pixel} bits per pixel, bitmap info {bitmap_info:#x}"
        ))
    }
}

/// A packed BGRA frame of `width`×`height` pixels (no row padding).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub width: usize,
    pub height: usize,
    pub bytes: Vec<u8>,
}

impl Frame {
    /// A fully transparent frame.
    #[must_use]
    pub fn blank(width: usize, height: usize) -> Self {
        Self {
            width,
            height,
            bytes: vec![0; width * height * 4],
        }
    }

    /// Clears the frame, then copies a BGRA image (`src_w`×`src_h`, rows
    /// `stride` bytes apart) into it, centred; parts that do not fit are
    /// cut off. The window is centred because macOS scales it about its
    /// centre while it animates.
    ///
    /// # Errors
    /// When `src` is shorter than its size and stride say.
    pub fn put_centered(
        &mut self,
        src: &[u8],
        src_w: usize,
        src_h: usize,
        stride: usize,
    ) -> Result<(), String> {
        if src_h > 0 && (stride < src_w * 4 || src.len() < stride * (src_h - 1) + src_w * 4) {
            return Err(format!(
                "capture buffer of {} bytes is too small for {src_w}x{src_h} at stride {stride}",
                src.len()
            ));
        }
        self.bytes.fill(0);
        let w = src_w.min(self.width);
        let h = src_h.min(self.height);
        let (sx, dx) = offsets(src_w, self.width);
        let (sy, dy) = offsets(src_h, self.height);
        for row in 0..h {
            let s = (sy + row) * stride + sx * 4;
            let d = ((dy + row) * self.width + dx) * 4;
            self.bytes[d..d + w * 4].copy_from_slice(&src[s..s + w * 4]);
        }
        Ok(())
    }
}

impl Frame {
    /// True when a 32×32 grid of sampled bytes is all zero: the window
    /// server returns transparent captures while the screen is locked or the
    /// window is on another Space.
    #[must_use]
    pub fn looks_blank(&self) -> bool {
        let row = self.width * 4;
        if row == 0 || self.height == 0 {
            return true;
        }
        (0..32).all(|sy| {
            let y = sy * (self.height - 1) / 31;
            (0..32).all(|sx| self.bytes[y * row + sx * (row - 1) / 31] == 0)
        })
    }
}

/// Where a centred copy starts in the source and in the destination along
/// one axis.
fn offsets(src: usize, dst: usize) -> (usize, usize) {
    if src > dst {
        ((src - dst) / 2, 0)
    } else {
        (0, (dst - src) / 2)
    }
}

/// The `q`-quantile (0..=1) of sorted samples, or 0 without samples.
#[must_use]
pub fn quantile(sorted: &[f64], q: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    // The index is within 0..len by construction.
    let i = ((sorted.len() - 1) as f64 * q.clamp(0.0, 1.0)).round() as usize;
    sorted[i]
}

/// Rounds a size down to an even number (encoders want even dimensions).
#[must_use]
pub fn even(n: usize) -> usize {
    n & !1
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_encoder_command_lines() {
        let a = ffmpeg_args(RecordCodec::Prores4444, 2880, 1800, 60, "/tmp/a.mov").expect("args");
        let s = a.join(" ");
        assert!(
            s.contains("-f rawvideo -pix_fmt bgra -video_size 2880x1800 -framerate 60 -i pipe:0")
        );
        assert!(s.contains("-c:v prores_videotoolbox -profile:v 4444"));
        assert_eq!(a.last().map(String::as_str), Some("/tmp/a.mov"));
        let s = ffmpeg_args(RecordCodec::ProresHq, 2, 2, 30, "o.mov")
            .expect("args")
            .join(" ");
        assert!(s.contains("-profile:v hq"));
        let s = ffmpeg_args(RecordCodec::H264, 2, 2, 30, "o.mp4")
            .expect("args")
            .join(" ");
        assert!(s.contains("h264_videotoolbox") && s.contains("yuv420p"));
        assert_eq!(ffmpeg_args(RecordCodec::Raw, 2, 2, 30, "o.bgra"), None);
    }

    #[test]
    fn maps_time_to_frame_slots() {
        assert_eq!(slot_at(Duration::ZERO, 60), 0);
        assert_eq!(slot_at(Duration::from_millis(16), 60), 0);
        assert_eq!(slot_at(Duration::from_millis(17), 60), 1);
        assert_eq!(slot_at(Duration::from_millis(1000), 60), 60);
        assert_eq!(slot_at(Duration::from_millis(1000), 0), 1);
        assert_eq!(slot_start(60, 60), Duration::from_secs(1));
        assert_eq!(slot_start(3, 30), Duration::from_millis(100));
    }

    #[test]
    fn accepts_only_bgra_captures() {
        assert!(check_bgra(32, 0x2002).is_ok());
        assert!(check_bgra(32, 0x2006).is_ok());
        assert!(check_bgra(32, 0x2004).is_ok());
        assert!(
            check_bgra(32, 0x0002).is_err(),
            "default byte order is RGBA-like"
        );
        assert!(check_bgra(32, 0x2001).is_err(), "alpha last");
        assert!(check_bgra(64, 0x2002).is_err());
        let e = check_bgra(24, 0x5).expect_err("24 bit");
        assert!(e.contains("24 bits") && e.contains("0x5"), "{e}");
    }

    #[test]
    fn centres_smaller_and_crops_larger_images() {
        // 2x1 source into a 4x3 frame: lands in the middle row, columns 1-2.
        let mut f = Frame::blank(4, 3);
        let src = [1, 1, 1, 1, 2, 2, 2, 2, 9, 9, 9, 9];
        f.put_centered(&src, 2, 1, 12).expect("copy");
        let px = |x: usize, y: usize| f.bytes[(y * 4 + x) * 4];
        assert_eq!((px(0, 1), px(1, 1), px(2, 1), px(3, 1)), (0, 1, 2, 0));
        assert_eq!((px(1, 0), px(1, 2)), (0, 0));
        // 4x1 source into a 2x1 frame: the middle two pixels.
        let mut g = Frame::blank(2, 1);
        let src = [1, 0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0, 4, 0, 0, 0];
        g.put_centered(&src, 4, 1, 16).expect("copy");
        assert_eq!((g.bytes[0], g.bytes[4]), (2, 3));
        // A later smaller copy clears what the earlier one left.
        g.put_centered(&[7, 7, 7, 7], 1, 1, 4).expect("copy");
        assert_eq!((g.bytes[0], g.bytes[4]), (7, 0));
        assert!(g.put_centered(&[0; 4], 2, 1, 8).is_err(), "short buffer");
        assert!(
            g.put_centered(&[0; 8], 2, 1, 4).is_err(),
            "stride below row"
        );
        assert!(Frame::blank(40, 40).looks_blank());
        assert!(Frame::blank(0, 0).looks_blank());
        let mut lit = Frame::blank(40, 40);
        lit.bytes[0] = 1;
        assert!(!lit.looks_blank());
    }

    #[test]
    fn summarises_samples() {
        assert!(quantile(&[], 0.5).abs() < f64::EPSILON);
        let s = [1.0, 2.0, 3.0, 4.0, 5.0];
        assert!((quantile(&s, 0.5) - 3.0).abs() < f64::EPSILON);
        assert!((quantile(&s, 0.95) - 5.0).abs() < f64::EPSILON);
        assert!((quantile(&s, 0.0) - 1.0).abs() < f64::EPSILON);
        assert_eq!((even(1801), even(2880), even(0)), (1800, 2880, 0));
    }
}
