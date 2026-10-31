//! Encode throughput benchmarks.
//!
//! ```text
//! cargo bench -p timelapse-video --bench encode
//! ```
//!
//! * `pipeline/*`: full `encode_timelapse` on frames that are already at the
//!   output size (how the app feeds aligned masters), reported in frames/s.
//! * `openh264/*`: the H.264 encoder alone on pre-converted I420 frames, per
//!   thread/slice count.
//! * `rgb_to_i420` and `resize`: the per-frame preparation kernels.

#[path = "../tests/common/mod.rs"]
mod common;

use std::sync::Arc;
use std::time::Duration;

use criterion::{BatchSize, Criterion, Throughput, criterion_group, criterion_main};
use timelapse_video::compose::Compositor;
use timelapse_video::{
    CancelToken, CaptionOptions, EncoderBackend, EncoderSettings, Frame, FrameLoader, FrameSource,
    OpenH264Encoder, Pace, Quality, Resolution, ScaleMode, VideoEncoder, VideoOptions, YuvFrame,
    encode_timelapse,
};

/// Distinct synthetic frames per size (cycled to reach the frame count).
const DISTINCT: usize = 8;
/// Per-pixel noise amplitude similar to downscaled phone photos.
const REALISTIC_GRAIN: i32 = 3;

/// Cycles through shared frames; the clone in the loader runs on the worker
/// pool, standing in for decoding a master JPEG.
struct Cycled {
    frames: Arc<Vec<Frame>>,
    next: usize,
    len: usize,
}

impl FrameSource for Cycled {
    fn len(&self) -> usize {
        self.len
    }

    fn next_loader(&mut self) -> Option<FrameLoader> {
        if self.next == self.len {
            return None;
        }
        let frames = Arc::clone(&self.frames);
        let i = self.next % frames.len();
        self.next += 1;
        Some(Box::new(move || Ok(frames[i].clone())))
    }
}

fn frames(w: u32, h: u32) -> Arc<Vec<Frame>> {
    Arc::new(
        (0..DISTINCT as u32)
            .map(|t| common::grainy_frame(w, h, t * 11, REALISTIC_GRAIN, common::day(t)))
            .collect(),
    )
}

fn bench_pipeline(c: &mut Criterion) {
    let mut group = c.benchmark_group("pipeline");
    group
        .sample_size(10)
        .measurement_time(Duration::from_secs(20));
    let dir = tempfile::tempdir().unwrap();
    let backends = [
        ("", EncoderBackend::OpenH264),
        #[cfg(target_os = "macos")]
        ("-videotoolbox", EncoderBackend::VideoToolbox),
    ];
    for (suffix, backend) in backends {
        for (name, w, h, count) in [
            ("1080x1080", 1080, 1080, 120usize),
            ("1080p", 1920, 1080, 120),
            ("2160p", 3840, 2160, 40),
        ] {
            let shared = frames(w, h);
            let options = VideoOptions {
                pace: Pace::Fps { fps: 30.0 },
                resolution: Resolution::Source,
                quality: Quality::High,
                caption: Some(CaptionOptions::default()),
                encoder: backend,
                ..VideoOptions::default()
            };
            let out = dir.path().join(format!("{name}{suffix}.mp4"));
            group.throughput(Throughput::Elements(count as u64));
            group.bench_function(format!("{name}{suffix}"), |b| {
                b.iter(|| {
                    let source = Cycled {
                        frames: Arc::clone(&shared),
                        next: 0,
                        len: count,
                    };
                    encode_timelapse(source, &options, &out, |_| {}, &CancelToken::new()).unwrap()
                });
            });
        }
    }
    group.finish();
}

fn bench_encoder_threads(c: &mut Criterion) {
    let mut group = c.benchmark_group("openh264");
    group
        .sample_size(10)
        .measurement_time(Duration::from_secs(10));
    for (name, w, h, count) in [
        ("1080p", 1920u32, 1080u32, 60usize),
        ("2160p", 3840, 2160, 20),
    ] {
        let yuv: Vec<YuvFrame> = frames(w, h)
            .iter()
            .map(|f| YuvFrame::from_rgb(&f.rgb, w, h).unwrap())
            .collect();
        group.throughput(Throughput::Elements(count as u64));
        for threads in [1u16, 2, 4, 8] {
            let settings = EncoderSettings {
                threads,
                ..EncoderSettings::new(w, h, 30.0, Quality::High)
            };
            group.bench_function(format!("{name}/threads-{threads}"), |b| {
                b.iter_batched(
                    || OpenH264Encoder::new(&settings).unwrap(),
                    |mut encoder| {
                        let mut out = Vec::new();
                        for i in 0..count {
                            encoder.encode(&yuv[i % yuv.len()], &mut out).unwrap();
                        }
                        out.len()
                    },
                    BatchSize::PerIteration,
                );
            });
        }
    }
    group.finish();
}

fn bench_kernels(c: &mut Criterion) {
    let mut group = c.benchmark_group("kernels");
    let frame = common::photo_frame(1920, 1080, 3, None);
    group.throughput(Throughput::Elements(1));
    group.bench_function("rgb_to_i420/1080p", |b| {
        b.iter(|| YuvFrame::from_rgb(&frame.rgb, 1920, 1080).unwrap());
    });
    let photo = common::photo_frame(4032, 3024, 1, None);
    let compositor = Compositor::new(1440, 1080, ScaleMode::Fit, [0, 0, 0]);
    group.bench_function("resize/4032x3024-to-1440x1080", |b| {
        b.iter_batched(
            || photo.clone(),
            |p| compositor.compose(p).unwrap(),
            BatchSize::LargeInput,
        );
    });
    group.finish();
}

criterion_group!(
    benches,
    bench_pipeline,
    bench_encoder_threads,
    bench_kernels
);
criterion_main!(benches);
