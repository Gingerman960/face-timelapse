//! Shared helpers for integration tests: synthetic frames and ffprobe/ffmpeg
//! based verification. ffmpeg is only used to *check* our output; tests that
//! need it print `skipped: ...` and pass when it is not installed.

#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::process::Command;

use chrono::NaiveDate;
use timelapse_video::Frame;

/// Locations checked for ffmpeg/ffprobe besides `PATH`.
const EXTRA_BIN_DIRS: [&str; 2] = ["/opt/homebrew/bin", "/usr/local/bin"];

fn find_tool(name: &str) -> Option<PathBuf> {
    let works = |p: &Path| {
        Command::new(p)
            .arg("-version")
            .output()
            .is_ok_and(|o| o.status.success())
    };
    let on_path = PathBuf::from(name);
    if works(&on_path) {
        return Some(on_path);
    }
    EXTRA_BIN_DIRS
        .iter()
        .map(|dir| Path::new(dir).join(name))
        .find(|p| works(p))
}

/// `(ffprobe, ffmpeg)` if both are installed.
pub fn tools() -> Option<(PathBuf, PathBuf)> {
    let found = find_tool("ffprobe").zip(find_tool("ffmpeg"));
    if found.is_none() {
        println!("skipped: ffmpeg/ffprobe not installed");
    }
    found
}

/// Stream and container facts reported by ffprobe.
#[derive(Debug, Clone)]
pub struct Probe {
    pub codec: String,
    pub codec_tag: String,
    pub profile: String,
    pub pix_fmt: String,
    pub width: u32,
    pub height: u32,
    pub nb_frames: u64,
    pub duration: f64,
    pub r_frame_rate: String,
    pub color_range: String,
    pub color_primaries: String,
    pub color_space: String,
    pub color_transfer: String,
    pub format_duration: f64,
    pub key_frames: u64,
    pub decoded_frames: u64,
}

fn field<'a>(v: &'a serde_json::Value, key: &str) -> &'a serde_json::Value {
    &v[key]
}

fn as_string(v: &serde_json::Value) -> String {
    v.as_str().map(str::to_owned).unwrap_or_default()
}

fn as_f64(v: &serde_json::Value) -> f64 {
    v.as_str()
        .and_then(|s| s.parse().ok())
        .or_else(|| v.as_f64())
        .unwrap_or(f64::NAN)
}

/// Runs ffprobe (including a full decode to count frames) on `path`.
pub fn probe(ffprobe: &Path, path: &Path) -> Probe {
    let out = Command::new(ffprobe)
        .args([
            "-v",
            "error",
            "-count_frames",
            "-show_streams",
            "-show_format",
        ])
        .args(["-show_entries", "packet=flags", "-of", "json"])
        .arg(path)
        .output()
        .expect("run ffprobe");
    assert!(
        out.status.success(),
        "ffprobe failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let json: serde_json::Value = serde_json::from_slice(&out.stdout).expect("ffprobe json");
    let streams = json["streams"].as_array().expect("streams");
    assert_eq!(streams.len(), 1, "exactly one stream");
    let s = &streams[0];
    let key_frames = json["packets"]
        .as_array()
        .map(|p| {
            p.iter()
                .filter(|pkt| as_string(&pkt["flags"]).starts_with('K'))
                .count() as u64
        })
        .unwrap_or(0);
    Probe {
        codec: as_string(field(s, "codec_name")),
        codec_tag: as_string(field(s, "codec_tag_string")),
        profile: as_string(field(s, "profile")),
        pix_fmt: as_string(field(s, "pix_fmt")),
        width: s["width"].as_u64().unwrap_or(0) as u32,
        height: s["height"].as_u64().unwrap_or(0) as u32,
        nb_frames: as_f64(field(s, "nb_frames")) as u64,
        duration: as_f64(field(s, "duration")),
        r_frame_rate: as_string(field(s, "r_frame_rate")),
        color_range: as_string(field(s, "color_range")),
        color_primaries: as_string(field(s, "color_primaries")),
        color_space: as_string(field(s, "color_space")),
        color_transfer: as_string(field(s, "color_transfer")),
        format_duration: as_f64(&json["format"]["duration"]),
        key_frames,
        decoded_frames: as_f64(field(s, "nb_read_frames")) as u64,
    }
}

/// Decodes frame `index` with ffmpeg as raw planar 8-bit 4:2:0 (`Y|U|V`).
pub fn decode_yuv(ffmpeg: &Path, path: &Path, index: u64) -> Vec<u8> {
    let out = Command::new(ffmpeg)
        .args(["-v", "error", "-i"])
        .arg(path)
        .args(["-vf", &format!("select=eq(n\\,{index})"), "-vframes", "1"])
        .args(["-f", "rawvideo", "-pix_fmt", "yuv420p", "-"])
        .output()
        .expect("run ffmpeg");
    assert!(
        out.status.success(),
        "ffmpeg failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    out.stdout
}

/// Peak signal-to-noise ratio between two 8-bit planes, in dB.
pub fn psnr(a: &[u8], b: &[u8]) -> f64 {
    assert_eq!(a.len(), b.len());
    let mse = a
        .iter()
        .zip(b)
        .map(|(&x, &y)| {
            let d = f64::from(x) - f64::from(y);
            d * d
        })
        .sum::<f64>()
        / a.len() as f64;
    if mse == 0.0 {
        f64::INFINITY
    } else {
        10.0 * (255.0f64 * 255.0 / mse).log10()
    }
}

/// Mean of a plane.
pub fn mean(plane: &[u8]) -> f64 {
    plane.iter().map(|&v| f64::from(v)).sum::<f64>() / plane.len() as f64
}

/// Deterministic xorshift noise in `[-amp, amp]`.
fn noise(seed: u32, amp: i32) -> i32 {
    let mut x = seed.wrapping_mul(0x9E37_79B9) ^ 0x85EB_CA6B;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    (x % (2 * amp as u32 + 1)) as i32 - amp
}

/// A photo-like synthetic frame: smooth colour gradients, a moving disc and
/// heavy grain (a worst case for the encoder).
pub fn photo_frame(w: u32, h: u32, t: u32, date: Option<NaiveDate>) -> Frame {
    grainy_frame(w, h, t, 10, date)
}

/// Like [`photo_frame`] with grain amplitude `grain` (downscaled phone photos
/// carry roughly +-3 of noise).
pub fn grainy_frame(w: u32, h: u32, t: u32, grain: i32, date: Option<NaiveDate>) -> Frame {
    let mut rgb = Vec::with_capacity((w * h * 3) as usize);
    let (cx, cy) = ((w / 4 + t * 7) % w, h / 2);
    let radius2 = (h / 4).pow(2);
    for y in 0..h {
        for x in 0..w {
            let dx = x.abs_diff(cx);
            let dy = y.abs_diff(cy);
            let in_disc = dx * dx + dy * dy < radius2;
            let grain = noise(x * 7919 + y * 104_729 + t * 15_485_863, grain);
            let base = [
                (x * 200 / w + 30) as i32,
                (y * 180 / h + 40) as i32,
                (((x + y + t * 3) % 256) / 2 + 60) as i32,
            ];
            let px = if in_disc { [220, 170, 140] } else { base };
            rgb.extend(px.iter().map(|&c| (c + grain).clamp(0, 255) as u8));
        }
    }
    Frame::new(w, h, rgb, date).expect("valid frame")
}

/// A flat colour frame.
pub fn solid_frame(w: u32, h: u32, rgb: [u8; 3], date: Option<NaiveDate>) -> Frame {
    Frame::new(w, h, rgb.repeat((w * h) as usize), date).expect("valid frame")
}

/// Top-level MP4 box types in file order.
pub fn top_level_boxes(path: &Path) -> Vec<String> {
    let data = std::fs::read(path).expect("read mp4");
    let mut kinds = Vec::new();
    let mut i = 0usize;
    while i + 8 <= data.len() {
        let size = u32::from_be_bytes(data[i..i + 4].try_into().unwrap()) as usize;
        kinds.push(String::from_utf8_lossy(&data[i + 4..i + 8]).into_owned());
        if size < 8 {
            break;
        }
        i += size;
    }
    kinds
}

/// Days counting up from 2014-08-15.
pub fn day(n: u32) -> Option<NaiveDate> {
    NaiveDate::from_ymd_opt(2014, 8, 15)?.checked_add_days(chrono::Days::new(u64::from(n)))
}
