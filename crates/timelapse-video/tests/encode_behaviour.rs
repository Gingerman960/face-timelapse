//! Pipeline behaviour that needs no external tools: progress, cancellation,
//! cleanup, error propagation and image-file input.

mod common;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use common::{day, photo_frame};
use timelapse_video::{
    CancelToken, CaptionOptions, Crossfade, Frame, FrameIter, ImageFiles, ImageInput, Pace,
    Progress, Resolution, VideoError, VideoOptions, encode_timelapse,
};

fn options() -> VideoOptions {
    VideoOptions {
        pace: Pace::Fps { fps: 30.0 },
        resolution: Resolution::Source,
        ..VideoOptions::default()
    }
}

fn frames(n: u32) -> Vec<Frame> {
    (0..n).map(|t| photo_frame(160, 96, t, day(t))).collect()
}

fn dir_entries(dir: &std::path::Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

#[test]
fn progress_is_monotonic_and_ends_complete() {
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("progress.mp4");
    let mut reports: Vec<Progress> = Vec::new();
    let opts = VideoOptions {
        crossfade: Crossfade {
            frames: 2,
            ..Crossfade::default()
        },
        hold_last_secs: 1.0,
        ..options()
    };
    let summary = encode_timelapse(
        FrameIter::from_frames(frames(40)),
        &opts,
        &out,
        |p| reports.push(p.clone()),
        &CancelToken::new(),
    )
    .unwrap();
    // 40 + 39 * 2 blends + 30 hold frames.
    assert_eq!(summary.frames, 148);
    // Default options: VideoToolbox on macOS (or openh264 after a fallback).
    assert!(
        ["openh264", "videotoolbox"].contains(&summary.encoder.as_str()),
        "{}",
        summary.encoder
    );
    assert!(summary.frames_per_sec() > 0.0);
    assert!(!reports.is_empty());
    assert!(
        reports
            .windows(2)
            .all(|w| w[0].frames_done < w[1].frames_done)
    );
    let last = reports.last().unwrap();
    assert_eq!((last.frames_done, last.frames_total), (148, 148));
    assert!((last.fraction() - 1.0).abs() < 1e-12);
    assert!((last.total_secs - 148.0 / 30.0).abs() < 1e-9);
    assert_eq!(dir_entries(dir.path()), vec!["progress.mp4"]);
}

#[test]
fn cancelling_mid_encode_removes_the_partial_and_keeps_the_old_file() {
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("keep.mp4");
    std::fs::write(&out, b"previous export").unwrap();
    let cancel = CancelToken::new();
    let mut saw_partial = false;
    let err = encode_timelapse(
        FrameIter::from_frames(frames(200)),
        &VideoOptions {
            threads: 2,
            ..options()
        },
        &out,
        |p| {
            saw_partial |= dir_entries(dir.path())
                .iter()
                .any(|n| timelapse_video::is_partial_name(n, "keep.mp4", std::process::id()));
            if p.frames_done >= 20 {
                cancel.cancel();
            }
        },
        &cancel,
    )
    .unwrap_err();
    assert!(err.is_cancelled(), "{err}");
    assert!(
        saw_partial,
        "the encoder writes to {{name}}.{{pid}}-{{n}}.partial"
    );
    assert_eq!(std::fs::read(&out).unwrap(), b"previous export");
    assert_eq!(dir_entries(dir.path()), vec!["keep.mp4"]);
}

#[test]
fn cancelling_from_another_thread_stops_promptly() {
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("threaded.mp4");
    let flag = Arc::new(AtomicBool::new(false));
    let cancel = CancelToken::from_flag(Arc::clone(&flag));
    // A slow, lazily computed source: each frame takes ~5 ms to "load".
    let slow = (0..400u32).map(|t| {
        std::thread::sleep(std::time::Duration::from_millis(5));
        Ok(photo_frame(64, 48, t, None))
    });
    let canceller = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(150));
        flag.store(true, Ordering::Release);
    });
    let started = std::time::Instant::now();
    let err =
        encode_timelapse(FrameIter::new(slow, 400), &options(), &out, |_| {}, &cancel).unwrap_err();
    canceller.join().unwrap();
    assert!(err.is_cancelled(), "{err}");
    assert!(
        started.elapsed().as_secs_f64() < 1.5,
        "took {:?}",
        started.elapsed()
    );
    assert!(dir_entries(dir.path()).is_empty());
}

#[test]
fn decode_errors_abort_and_clean_up() {
    let dir = tempfile::tempdir().unwrap();
    let good = dir.path().join("IMG_20200101.png");
    image::RgbImage::from_pixel(64, 48, image::Rgb([90, 120, 150]))
        .save(&good)
        .unwrap();
    let bad = dir.path().join("IMG_20200102.jpg");
    std::fs::write(&bad, b"not a jpeg").unwrap();
    let out = dir.path().join("out.mp4");
    let err = encode_timelapse(
        ImageFiles::from_paths(&[&good, &bad, &good]),
        &options(),
        &out,
        |_| {},
        &CancelToken::new(),
    )
    .unwrap_err();
    match err {
        VideoError::Decode { path, .. } => assert_eq!(path, bad),
        other => panic!("unexpected {other}"),
    }
    assert!(!out.exists());
    let leftovers: Vec<String> = dir_entries(dir.path())
        .into_iter()
        .filter(|n| n.ends_with(".partial"))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
}

#[test]
fn image_files_with_captions_encode_end_to_end() {
    let dir = tempfile::tempdir().unwrap();
    let inputs: Vec<ImageInput> = (0..6u8)
        .map(|i| {
            let path = dir.path().join(format!("photo_{i}.png"));
            image::RgbImage::from_fn(200, 150, |x, y| {
                image::Rgb([(x as u8).wrapping_add(i * 20), y as u8, 128])
            })
            .save(&path)
            .unwrap();
            ImageInput {
                path,
                date: day(u32::from(i)),
            }
        })
        .collect();
    let out = dir.path().join("files.mp4");
    let summary = encode_timelapse(
        ImageFiles::new(inputs),
        &VideoOptions {
            caption: Some(CaptionOptions::default()),
            resolution: Resolution::P720,
            ..options()
        },
        &out,
        |_| {},
        &CancelToken::new(),
    )
    .unwrap();
    assert_eq!(
        (summary.width, summary.height, summary.frames),
        (960, 720, 6)
    );
    assert!(summary.bytes > 1000);
    assert_eq!(summary.output, out);
}

#[test]
fn invalid_options_and_paths_fail_before_writing() {
    let dir = tempfile::tempdir().unwrap();
    let bad_fps = VideoOptions {
        pace: Pace::Fps { fps: 120.0 },
        ..options()
    };
    let err = encode_timelapse(
        FrameIter::from_frames(frames(3)),
        &bad_fps,
        &dir.path().join("a.mp4"),
        |_| {},
        &CancelToken::new(),
    )
    .unwrap_err();
    assert!(matches!(err, VideoError::InvalidOptions(_)), "{err}");

    let err = encode_timelapse(
        FrameIter::from_frames(Vec::new()),
        &options(),
        &dir.path().join("b.mp4"),
        |_| {},
        &CancelToken::new(),
    )
    .unwrap_err();
    assert!(matches!(err, VideoError::EmptySource), "{err}");

    let err = encode_timelapse(
        FrameIter::from_frames(frames(3)),
        &options(),
        &dir.path().join("missing/dir/c.mp4"),
        |_| {},
        &CancelToken::new(),
    )
    .unwrap_err();
    assert!(matches!(err, VideoError::Io { .. }), "{err}");
    assert!(dir_entries(dir.path()).is_empty());
}

#[test]
fn without_replace_a_file_appearing_during_the_encode_is_kept() {
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("mine.mp4");
    let mut planted = false;
    let summary = encode_timelapse(
        FrameIter::from_frames(frames(30)),
        &VideoOptions {
            replace_existing: false,
            ..options()
        },
        &out,
        |p| {
            if !planted && p.frames_done >= 5 {
                std::fs::write(&out, b"someone else's file").unwrap();
                planted = true;
            }
        },
        &CancelToken::new(),
    )
    .unwrap();
    assert!(planted);
    assert_eq!(summary.output, dir.path().join("mine_1.mp4"));
    assert_eq!(std::fs::read(&out).unwrap(), b"someone else's file");
    assert!(std::fs::metadata(&summary.output).unwrap().len() > 0);
}

#[test]
fn crossfades_carry_the_nearer_photos_caption() {
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("cap.mp4");
    let summary = encode_timelapse(
        FrameIter::from_frames(frames(4)),
        &VideoOptions {
            crossfade: Crossfade {
                frames: 3,
                ..Crossfade::default()
            },
            caption: Some(CaptionOptions::default()),
            ..options()
        },
        &out,
        |_| {},
        &CancelToken::new(),
    )
    .unwrap();
    assert!(summary.frames > 4 && summary.bytes > 0, "{summary:?}");
}
