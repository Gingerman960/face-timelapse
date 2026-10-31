//! End-to-end encodes of synthetic frames, verified with ffprobe / ffmpeg.
//! Every test prints `skipped: ...` and passes if ffmpeg is not installed.

mod common;

use std::path::Path;

use common::{
    day, decode_yuv, mean, photo_frame, probe, psnr, solid_frame, tools, top_level_boxes,
};
use timelapse_video::encoder::create_encoder;
use timelapse_video::{
    CancelToken, CaptionOptions, CaptionPosition, Crossfade, Easing, EncoderBackend,
    EncoderSettings, Frame, FrameIter, Pace, Quality, Resolution, VideoOptions, YuvFrame,
    encode_timelapse,
};

fn encode(
    frames: Vec<Frame>,
    options: &VideoOptions,
    out: &Path,
) -> timelapse_video::EncodeSummary {
    encode_timelapse(
        FrameIter::from_frames(frames),
        options,
        out,
        |_| {},
        &CancelToken::new(),
    )
    .expect("encode")
}

/// Deterministic baseline: openh264 explicitly (Auto means VideoToolbox on macOS).
fn source_options(fps: f64) -> VideoOptions {
    VideoOptions {
        pace: Pace::Fps { fps },
        resolution: Resolution::Source,
        encoder: EncoderBackend::OpenH264,
        ..VideoOptions::default()
    }
}

/// openh264 everywhere, plus VideoToolbox when a hardware session works.
fn backends() -> Vec<EncoderBackend> {
    let mut list = vec![EncoderBackend::OpenH264];
    let probe = EncoderSettings::new(64, 48, 10.0, Quality::High);
    match create_encoder(EncoderBackend::VideoToolbox, &probe) {
        Ok(_) => list.push(EncoderBackend::VideoToolbox),
        Err(e) => println!("skipped VideoToolbox variant: {e}"),
    }
    list
}

fn with_backend(options: VideoOptions, encoder: EncoderBackend) -> VideoOptions {
    VideoOptions { encoder, ..options }
}

#[test]
fn moving_patterns_produce_a_standard_h264_mp4() {
    let Some((ffprobe, _)) = tools() else { return };
    let dir = tempfile::tempdir().unwrap();
    for backend in backends() {
        let out = dir.path().join(format!("patterns-{backend:?}.mp4"));
        let frames = (0..75).map(|t| photo_frame(640, 360, t, None)).collect();
        let summary = encode(frames, &with_backend(source_options(30.0), backend), &out);
        let name = summary.encoder.clone();
        assert_eq!(
            (summary.width, summary.height, summary.frames),
            (640, 360, 75)
        );
        assert_eq!(summary.bytes, std::fs::metadata(&out).unwrap().len());
        assert_eq!(summary.encoder_fallback, None);
        let p = probe(&ffprobe, &out);
        assert_eq!(p.codec, "h264", "{name}");
        assert_eq!(p.codec_tag, "avc1", "{name}");
        assert_eq!(p.profile, "High", "{name}");
        assert_eq!(p.pix_fmt, "yuv420p", "{name}");
        assert_eq!((p.width, p.height), (640, 360), "{name}");
        assert_eq!(p.nb_frames, 75, "{name}");
        assert_eq!(p.decoded_frames, 75, "{name}: every frame decodes");
        assert_eq!(p.r_frame_rate, "30/1", "{name}");
        assert!(
            (p.duration - 2.5).abs() < 1e-3,
            "{name}: duration {}",
            p.duration
        );
        assert!((p.format_duration - 2.5).abs() < 2e-3, "{name}");
        assert_eq!(p.color_range, "tv", "{name}");
        assert_eq!(p.color_primaries, "bt709", "{name}");
        assert_eq!(p.color_transfer, "bt709", "{name}");
        assert_eq!(p.color_space, "bt709", "{name}");
        // A keyframe at least every 2 seconds: frames 0 and 60.
        assert!(
            (2..=3).contains(&p.key_frames),
            "{name}: {} keyframes",
            p.key_frames
        );
        // Fast start: moov precedes mdat.
        let boxes = top_level_boxes(&out);
        let moov = boxes.iter().position(|b| b == "moov").unwrap();
        let mdat = boxes.iter().position(|b| b == "mdat").unwrap();
        assert_eq!(boxes[0], "ftyp", "{name}");
        assert!(moov < mdat, "{name}: {boxes:?}");
    }
}

#[test]
fn decoded_frames_match_the_source_with_high_psnr() {
    let Some((ffprobe, ffmpeg)) = tools() else {
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let frames: Vec<Frame> = (0..12)
        .map(|t| photo_frame(320, 240, t * 5, None))
        .collect();
    for backend in backends() {
        let mut sizes = Vec::new();
        for quality in [Quality::Low, Quality::Medium, Quality::High, Quality::Max] {
            let out = dir.path().join(format!("{quality:?}-{backend:?}.mp4"));
            let opts = VideoOptions {
                quality,
                ..with_backend(source_options(10.0), backend)
            };
            let summary = encode(frames.clone(), &opts, &out);
            sizes.push(summary.bytes);
            let p = probe(&ffprobe, &out);
            assert_eq!(p.nb_frames, 12);
            for index in [0u64, 7, 11] {
                let frame = &frames[index as usize];
                let want = YuvFrame::from_rgb(&frame.rgb, frame.width, frame.height).unwrap();
                let got = decode_yuv(&ffmpeg, &out, index);
                assert_eq!(got.len(), want.as_bytes().len());
                let luma = psnr(&got[..want.y().len()], want.y());
                let min = match quality {
                    Quality::Low => 30.0,
                    Quality::Medium => 33.0,
                    Quality::High => 36.0,
                    _ => 40.0,
                };
                assert!(
                    luma > min,
                    "{backend:?} {quality:?} frame {index}: Y PSNR {luma:.1} dB"
                );
                let chroma = psnr(&got[want.y().len()..], &want.as_bytes()[want.y().len()..]);
                assert!(
                    chroma > min,
                    "{backend:?} {quality:?} frame {index}: UV PSNR {chroma:.1} dB"
                );
            }
        }
        assert!(
            sizes.windows(2).all(|w| w[0] < w[1]),
            "{backend:?}: size grows with quality: {sizes:?}"
        );
    }
}

#[test]
fn colours_survive_the_round_trip_without_tint() {
    let Some((_, ffmpeg)) = tools() else { return };
    let dir = tempfile::tempdir().unwrap();
    for backend in backends() {
        let out = dir.path().join(format!("colours-{backend:?}.mp4"));
        let colours = [
            [255, 0, 0],
            [0, 255, 0],
            [0, 0, 255],
            [128, 128, 128],
            [235, 190, 160],
        ];
        let frames = colours
            .iter()
            .map(|&c| solid_frame(128, 96, c, None))
            .collect();
        encode(frames, &with_backend(source_options(5.0), backend), &out);
        for (i, &c) in colours.iter().enumerate() {
            let got = decode_yuv(&ffmpeg, &out, i as u64);
            let want = YuvFrame::from_rgb(&solid_frame(128, 96, c, None).rgb, 128, 96).unwrap();
            let (y, u) = (128 * 96, 128 * 96 / 4);
            for (name, a, b) in [
                ("Y", &got[..y], want.y()),
                ("U", &got[y..y + u], want.u()),
                ("V", &got[y + u..], want.v()),
            ] {
                let diff = (mean(a) - mean(b)).abs();
                assert!(
                    diff < 1.5,
                    "{backend:?} colour {c:?} plane {name}: mean off by {diff:.2}"
                );
            }
        }
    }
}

#[test]
fn crossfade_and_holds_follow_the_timeline() {
    let Some((ffprobe, ffmpeg)) = tools() else {
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    for backend in backends() {
        let out = dir.path().join(format!("fade-{backend:?}.mp4"));
        let frames = vec![
            solid_frame(160, 120, [0, 0, 0], None),
            solid_frame(160, 120, [255, 255, 255], None),
            solid_frame(160, 120, [0, 0, 0], None),
        ];
        let opts = VideoOptions {
            crossfade: Crossfade {
                frames: 3,
                easing: Easing::Linear,
            },
            hold_first_secs: 0.4,
            hold_last_secs: 1.0,
            ..with_backend(source_options(10.0), backend)
        };
        let summary = encode(frames, &opts, &out);
        // 3 photos + 2 * 3 blends + 4 + 10 hold frames.
        assert_eq!(summary.frames, 23);
        assert!((summary.duration_secs - 2.3).abs() < 1e-9);
        let p = probe(&ffprobe, &out);
        assert_eq!(p.nb_frames, 23);
        assert!((p.duration - 2.3).abs() < 1e-3, "{}", p.duration);
        let luma = |n: u64| mean(&decode_yuv(&ffmpeg, &out, n)[..160 * 120]);
        // Frames: 0-4 hold+key black, 5-7 blends up, 8 white, 9-11 blends down, 12.. black.
        assert!((luma(0) - 16.0).abs() < 2.0);
        assert!((luma(4) - 16.0).abs() < 2.0);
        let expected = [16.0 + 219.0 * 0.25, 16.0 + 219.0 * 0.5, 16.0 + 219.0 * 0.75];
        for (k, want) in expected.iter().enumerate() {
            let got = luma(5 + k as u64);
            assert!((got - want).abs() < 3.0, "blend {k}: {got:.1} vs {want:.1}");
        }
        assert!((luma(8) - 235.0).abs() < 2.0, "{backend:?}");
        assert!((luma(22) - 16.0).abs() < 2.0, "{backend:?}");
    }
}

#[test]
fn fractional_frame_rate_from_duration_is_exact() {
    let Some((ffprobe, _)) = tools() else { return };
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("fractional.mp4");
    let frames = (0..100).map(|t| photo_frame(96, 64, t, None)).collect();
    let opts = VideoOptions {
        pace: Pace::Duration { seconds: 7.0 },
        resolution: Resolution::Source,
        ..VideoOptions::default()
    };
    let summary = encode(frames, &opts, &out);
    // Legacy rounding: fps_for_duration(100, 7) = 14.29.
    assert!((summary.fps - 14.29).abs() < 1e-9);
    let p = probe(&ffprobe, &out);
    assert_eq!(p.r_frame_rate, "1429/100");
    assert_eq!(p.nb_frames, 100);
    assert!((p.duration - 100.0 / 14.29).abs() < 1e-3, "{}", p.duration);
}

#[test]
fn mixed_and_odd_frame_sizes_are_letterboxed_to_even_output() {
    let Some((ffprobe, ffmpeg)) = tools() else {
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("mixed.mp4");
    let frames = vec![
        solid_frame(333, 251, [200, 30, 30], None),
        solid_frame(100, 300, [30, 200, 30], None),
        solid_frame(1000, 200, [30, 30, 200], None),
    ];
    let opts = VideoOptions {
        background: [0, 0, 0],
        ..source_options(5.0)
    };
    let summary = encode(frames, &opts, &out);
    assert_eq!((summary.width, summary.height), (332, 250));
    let p = probe(&ffprobe, &out);
    assert_eq!((p.width, p.height, p.nb_frames), (332, 250, 3));
    // Frame 1 is a tall pillar: the left edge is background black.
    let frame = decode_yuv(&ffmpeg, &out, 1);
    let left_column: Vec<u8> = (0..250).map(|y| frame[y * 332 + 4]).collect();
    assert!(mean(&left_column) < 20.0, "{}", mean(&left_column));
    let centre: Vec<u8> = (0..250).map(|y| frame[y * 332 + 166]).collect();
    assert!(mean(&centre) > 100.0);
}

#[test]
fn presets_scale_and_captions_render() {
    let Some((ffprobe, ffmpeg)) = tools() else {
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let frames: Vec<Frame> = (0..4)
        .map(|t| solid_frame(400, 300, [40, 40, 40], day(t)))
        .collect();
    let plain = dir.path().join("plain.mp4");
    let captioned = dir.path().join("captioned.mp4");
    let base = VideoOptions {
        pace: Pace::Fps { fps: 4.0 },
        resolution: Resolution::P720,
        ..VideoOptions::default()
    };
    encode(frames.clone(), &base, &plain);
    let with_caption = VideoOptions {
        caption: Some(CaptionOptions {
            position: CaptionPosition::BottomLeft,
            ..CaptionOptions::default()
        }),
        ..base
    };
    encode(frames, &with_caption, &captioned);
    let p = probe(&ffprobe, &captioned);
    assert_eq!((p.width, p.height), (960, 720));
    let region_mean = |path: &Path| {
        let f = decode_yuv(&ffmpeg, path, 2);
        let rows = 640..700usize;
        let values: Vec<u8> = rows
            .flat_map(|y| f[y * 960 + 20..y * 960 + 300].to_vec())
            .collect();
        (mean(&values), values.iter().filter(|&&v| v > 200).count())
    };
    let (plain_mean, plain_bright) = region_mean(&plain);
    let (cap_mean, cap_bright) = region_mean(&captioned);
    assert_eq!(plain_bright, 0);
    assert!(cap_bright > 500, "white text pixels: {cap_bright}");
    assert!(cap_mean > plain_mean + 5.0);
}

#[test]
fn bitrate_mode_lands_near_the_target() {
    let Some((ffprobe, _)) = tools() else { return };
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("bitrate.mp4");
    let frames = (0..90)
        .map(|t| photo_frame(640, 360, t * 3, None))
        .collect();
    let opts = VideoOptions {
        quality: Quality::Bitrate { kbps: 1500 },
        ..source_options(30.0)
    };
    let summary = encode(frames, &opts, &out);
    let kbps = summary.bytes as f64 * 8.0 / summary.duration_secs / 1000.0;
    assert!((750.0..2250.0).contains(&kbps), "actual {kbps:.0} kbps");
    assert_eq!(probe(&ffprobe, &out).nb_frames, 90);
}

#[test]
fn auto_prefers_videotoolbox_on_macos_and_reports_any_fallback() {
    let Some((ffprobe, _)) = tools() else { return };
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("auto.mp4");
    let frames: Vec<Frame> = (0..48).map(|t| photo_frame(640, 360, t, None)).collect();
    let opts = VideoOptions {
        encoder: EncoderBackend::Auto,
        ..source_options(24.0)
    };
    let summary = encode(frames, &opts, &out);
    let hardware = backends().contains(&EncoderBackend::VideoToolbox);
    if hardware {
        assert_eq!(summary.encoder, "videotoolbox");
        assert_eq!(summary.encoder_fallback, None);
    } else {
        assert_eq!(summary.encoder, "openh264");
        // Off macOS Auto is openh264 by design, so there is nothing to report.
        assert_eq!(
            summary.encoder_fallback.is_some(),
            cfg!(target_os = "macos")
        );
    }
    let p = probe(&ffprobe, &out);
    assert_eq!((p.nb_frames, p.decoded_frames), (48, 48));
    assert_eq!(p.color_primaries, "bt709");
}
