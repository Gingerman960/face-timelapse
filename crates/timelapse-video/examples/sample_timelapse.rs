//! Encodes a timelapse from a folder of dated photos.
//!
//! ```text
//! cargo run --release -p timelapse-video --example sample_timelapse -- \
//!     --dir "/path/to/photos" --out /tmp/sample.mp4 --count 300 \
//!     --resolution 1080p --crossfade 2 --fps 24 --caption bottomLeft
//! ```
//!
//! Photos are ordered by the date in their file name (see
//! `date_from_filename`) and `--count` of them are picked evenly across the
//! whole range.

use std::path::PathBuf;
use std::process::ExitCode;

use timelapse_video::{
    CancelToken, CaptionOptions, CaptionPosition, Crossfade, ImageFiles, ImageInput, Pace, Quality,
    Resolution, VideoOptions, date_from_filename, encode_timelapse,
};

struct Args {
    dir: PathBuf,
    out: PathBuf,
    count: usize,
    landscape_only: bool,
    options: VideoOptions,
}

fn parse_value<T: serde::de::DeserializeOwned>(raw: &str) -> Result<T, String> {
    serde_json::from_str(&format!("\"{raw}\""))
        .or_else(|_| serde_json::from_str(raw))
        .map_err(|e| format!("invalid value {raw:?}: {e}"))
}

fn parse_args() -> Result<Args, String> {
    let mut args = Args {
        dir: PathBuf::new(),
        out: PathBuf::from("timelapse.mp4"),
        count: 300,
        landscape_only: false,
        options: VideoOptions::default(),
    };
    let mut it = std::env::args().skip(1);
    while let Some(flag) = it.next() {
        let mut value = || it.next().ok_or_else(|| format!("{flag} needs a value"));
        match flag.as_str() {
            "--dir" => args.dir = PathBuf::from(value()?),
            "--out" => args.out = PathBuf::from(value()?),
            "--count" => args.count = value()?.parse().map_err(|e| format!("--count: {e}"))?,
            "--fps" => {
                let fps = value()?.parse().map_err(|e| format!("--fps: {e}"))?;
                args.options.pace = Pace::Fps { fps };
            }
            "--duration" => {
                let seconds = value()?.parse().map_err(|e| format!("--duration: {e}"))?;
                args.options.pace = Pace::Duration { seconds };
            }
            "--resolution" => args.options.resolution = parse_value::<Resolution>(&value()?)?,
            "--quality" => args.options.quality = parse_value::<Quality>(&value()?)?,
            "--crossfade" => {
                let frames = value()?.parse().map_err(|e| format!("--crossfade: {e}"))?;
                args.options.crossfade = Crossfade {
                    frames,
                    ..Crossfade::default()
                };
            }
            "--caption" => {
                args.options.caption = Some(CaptionOptions {
                    position: parse_value::<CaptionPosition>(&value()?)?,
                    ..CaptionOptions::default()
                });
            }
            "--hold-last" => {
                args.options.hold_last_secs =
                    value()?.parse().map_err(|e| format!("--hold-last: {e}"))?;
            }
            "--threads" => {
                args.options.threads = value()?.parse().map_err(|e| format!("--threads: {e}"))?;
            }
            "--landscape" => args.landscape_only = true,
            "--encoder" => args.options.encoder = parse_value(&value()?)?,
            other => return Err(format!("unknown flag {other}")),
        }
    }
    if args.dir.as_os_str().is_empty() {
        return Err("--dir is required".into());
    }
    Ok(args)
}

/// True if the photo is wider than tall after EXIF orientation (header only).
fn is_landscape(path: &std::path::Path) -> bool {
    use image::ImageDecoder;
    let Ok(mut decoder) = image::ImageReader::open(path)
        .and_then(|r| r.with_guessed_format())
        .map_err(|e| e.to_string())
        .and_then(|r| r.into_decoder().map_err(|e| e.to_string()))
    else {
        return false;
    };
    let (w, h) = decoder.dimensions();
    let rotated = decoder
        .orientation()
        .map(|o| {
            use image::metadata::Orientation as O;
            matches!(
                o,
                O::Rotate90 | O::Rotate270 | O::Rotate90FlipH | O::Rotate270FlipH
            )
        })
        .unwrap_or(false);
    if rotated { h > w } else { w > h }
}

fn pick_photos(
    dir: &PathBuf,
    count: usize,
    landscape_only: bool,
) -> Result<Vec<ImageInput>, String> {
    let mut photos: Vec<ImageInput> = std::fs::read_dir(dir)
        .map_err(|e| format!("cannot read {}: {e}", dir.display()))?
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|p| {
            p.extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| matches!(e.to_ascii_lowercase().as_str(), "jpg" | "jpeg" | "png"))
        })
        .filter_map(|path| {
            date_from_filename(&path).map(|date| ImageInput {
                path,
                date: Some(date),
            })
        })
        .collect();
    if landscape_only {
        use rayon::prelude::*;
        photos = photos
            .into_par_iter()
            .filter(|p| is_landscape(&p.path))
            .collect();
    }
    photos.sort_by(|a, b| a.date.cmp(&b.date).then_with(|| a.path.cmp(&b.path)));
    if photos.is_empty() {
        return Err(format!("no dated photos in {}", dir.display()));
    }
    let count = count.clamp(1, photos.len());
    let step = photos.len() as f64 / count as f64;
    Ok((0..count)
        .map(|i| photos[((i as f64 + 0.5) * step) as usize].clone())
        .collect())
}

fn main() -> ExitCode {
    let args = match parse_args() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("error: {e}");
            return ExitCode::FAILURE;
        }
    };
    let photos = match pick_photos(&args.dir, args.count, args.landscape_only) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("error: {e}");
            return ExitCode::FAILURE;
        }
    };
    eprintln!(
        "encoding {} photos ({:?} .. {:?})",
        photos.len(),
        photos.first().and_then(|p| p.date),
        photos.last().and_then(|p| p.date)
    );
    let result = encode_timelapse(
        ImageFiles::new(photos),
        &args.options,
        &args.out,
        |p| {
            eprint!(
                "\r{:5.1}%  {}/{} frames  {:.1} fps  eta {:.1}s   ",
                p.fraction() * 100.0,
                p.frames_done,
                p.frames_total,
                p.frames_per_sec,
                p.eta_secs.unwrap_or(0.0)
            );
        },
        &CancelToken::new(),
    );
    eprintln!();
    match result {
        Ok(s) => {
            println!(
                "{}: {}x{} {} frames @ {} fps = {:.2}s, {:.1} MB, encoded in {:.2}s ({:.1} frames/s, {})",
                s.output.display(),
                s.width,
                s.height,
                s.frames,
                s.fps,
                s.duration_secs,
                s.bytes as f64 / 1e6,
                s.elapsed_secs,
                s.frames_per_sec(),
                s.encoder
            );
            if let Some(reason) = &s.encoder_fallback {
                println!("hardware encoder unavailable, used openh264: {reason}");
            }
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::FAILURE
        }
    }
}
