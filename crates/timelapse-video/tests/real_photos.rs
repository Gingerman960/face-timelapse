//! Throughput on the real photo library. Ignored by default (it needs the
//! private photos and a release build):
//!
//! ```text
//! cargo test -p timelapse-video --release --test real_photos -- --ignored --nocapture
//! ```
//!
//! `FT_PHOTOS_DIR` selects the folder (default: the maintainer's library when
//! present). The photos are only read; output goes to a temp dir.

mod common;

use std::path::{Path, PathBuf};

use timelapse_video::{
    CancelToken, CaptionOptions, Crossfade, ImageFiles, ImageInput, Pace, Resolution, VideoOptions,
    date_from_filename, encode_timelapse,
};

const DEFAULT_PHOTOS_DIR: &str = "/Users/gingerman/Projects/everyday photos/photos";
const SAMPLE_SIZE: usize = 300;
/// Conservative floor (decode of 12 MP JPEGs included); measured ~200+ on an M3 Max.
const MIN_FRAMES_PER_SEC: f64 = 30.0;

fn photos_dir() -> Option<PathBuf> {
    let dir = std::env::var_os("FT_PHOTOS_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(DEFAULT_PHOTOS_DIR));
    if dir.is_dir() {
        Some(dir)
    } else {
        println!("skipped: photo folder {} not found", dir.display());
        None
    }
}

fn stride_sample(dir: &Path, count: usize) -> Vec<ImageInput> {
    let mut all: Vec<PathBuf> = std::fs::read_dir(dir)
        .expect("read photo dir")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| matches!(e.to_ascii_lowercase().as_str(), "jpg" | "jpeg"))
        })
        .collect();
    all.sort_by_key(|p| (date_from_filename(p), p.clone()));
    let step = (all.len() / count.max(1)).max(1);
    all.into_iter()
        .step_by(step)
        .take(count)
        .map(|path| ImageInput {
            date: date_from_filename(&path),
            path,
        })
        .collect()
}

#[test]
#[ignore = "needs the private photo library; run with --release -- --ignored"]
fn encodes_300_real_photos_at_1080p() {
    let Some(dir) = photos_dir() else { return };
    let inputs = stride_sample(&dir, SAMPLE_SIZE);
    assert!(inputs.len() >= 10, "too few photos in {}", dir.display());
    let photos = inputs.len();
    let out_dir = tempfile::tempdir().unwrap();
    let out = out_dir.path().join("real.mp4");
    let options = VideoOptions {
        pace: Pace::Fps { fps: 30.0 },
        resolution: Resolution::P1080,
        crossfade: Crossfade {
            frames: 1,
            ..Crossfade::default()
        },
        caption: Some(CaptionOptions::default()),
        hold_last_secs: 1.0,
        ..VideoOptions::default()
    };
    let summary = encode_timelapse(
        ImageFiles::new(inputs),
        &options,
        &out,
        |_| {},
        &CancelToken::new(),
    )
    .expect("encode real photos");
    let photos_per_sec = photos as f64 / summary.elapsed_secs;
    println!(
        "real photos: {photos} photos -> {} frames {}x{} in {:.2}s = {:.1} photos/s, {:.1} frames/s, {:.1} MB",
        summary.frames,
        summary.width,
        summary.height,
        summary.elapsed_secs,
        photos_per_sec,
        summary.frames_per_sec(),
        summary.bytes as f64 / 1e6
    );
    assert_eq!(summary.frames, (photos * 2 - 1 + 30) as u64);
    if let Some((ffprobe, _)) = common::tools() {
        let p = common::probe(&ffprobe, &out);
        assert_eq!(p.nb_frames, summary.frames);
        assert_eq!(p.decoded_frames, summary.frames);
        assert_eq!(p.pix_fmt, "yuv420p");
    }
    assert!(
        summary.frames_per_sec() >= MIN_FRAMES_PER_SEC,
        "{:.1} frames/s",
        summary.frames_per_sec()
    );
}
