//! Per-stage benchmarks: decode, detect, embed, full per-photo analysis,
//! warp/render and the look LUT.

mod common;

use std::hint::black_box;
use std::path::Path;

use criterion::{Criterion, criterion_group, criterion_main};
use face_engine::align::{FrameRequest, RenderTarget, Resolution};
use face_engine::color::{FaceStats, LookSettings, Lut3d, NormalizeMode};
use face_engine::decode::{self, DecodeTarget};
use face_engine::geometry::{Similarity, Size};
use face_engine::image::Filter;
use face_engine::recognize::align_crop;
use face_engine::warp::{self, BackdropMode};

fn benches(c: &mut Criterion) {
    let tmp = tempfile::tempdir().expect("tmp");
    let (path, bytes) = common::sample_photo(tmp.path());
    let exif = decode::read_exif(&bytes);

    let mut g = c.benchmark_group("decode");
    g.sample_size(20);
    g.bench_function("jpeg_dct_scaled_640", |b| {
        b.iter(|| {
            decode::decode(
                black_box(&bytes),
                &path,
                exif.orientation,
                DecodeTarget::MinLongEdge(640),
            )
        })
    });
    g.bench_function("jpeg_full", |b| {
        b.iter(|| {
            decode::decode(
                black_box(&bytes),
                &path,
                exif.orientation,
                DecodeTarget::Full,
            )
        })
    });
    g.finish();

    let full = decode::decode(&bytes, &path, exif.orientation, DecodeTarget::Full).expect("decode");
    let scaled = decode::decode(
        &bytes,
        &path,
        exif.orientation,
        DecodeTarget::MinLongEdge(640),
    )
    .expect("decode");

    let mut g = c.benchmark_group("warp");
    g.sample_size(20);
    let t = Similarity::from_parts(0.45, 0.03, -40.0, 10.0);
    g.bench_function("bilinear_1080p_from_12mp", |b| {
        b.iter(|| warp::warp_bilinear(black_box(&full.image), &t, 1920, 1080, [0, 0, 0]))
    });
    let out = Size::new(1920, 1080);
    g.bench_function("dimmed_backdrop_1080p", |b| {
        b.iter(|| warp::backdrop(black_box(&full.image), out, BackdropMode::Dimmed))
    });
    let frame = full
        .image
        .resized(1920, 1080, Filter::Bilinear)
        .expect("frame");
    let stats = FaceStats {
        mean: [0.6, 0.02, 0.03],
        std: [0.08, 0.02, 0.02],
    };
    let target = FaceStats {
        mean: [0.68, 0.015, 0.04],
        std: [0.09, 0.02, 0.02],
    };
    let look = LookSettings {
        normalize: NormalizeMode::ExposureAndColor,
        strength: 0.7,
    };
    g.bench_function("look_lut_build", |b| {
        b.iter(|| Lut3d::for_frame(&stats, &target, &look))
    });
    let lut = Lut3d::for_frame(&stats, &target, &look).expect("lut");
    g.bench_function("look_lut_apply_1080p", |b| {
        b.iter_batched(
            || frame.clone(),
            |mut f| lut.apply(&mut f),
            criterion::BatchSize::LargeInput,
        )
    });
    g.finish();

    let Some(an) = common::analyzer() else { return };
    let work = scaled.image.fit_within(640, Filter::Bilinear).expect("640");
    let mut g = c.benchmark_group("models");
    g.sample_size(30);
    g.bench_function("yunet_640", |b| {
        b.iter(|| an.detector().detect(black_box(&work)))
    });
    let faces = an.detector().detect(&work).expect("detect");
    if let Some(face) = faces.first() {
        let crop = align_crop(&work, &face.landmarks).expect("crop");
        g.bench_function("sface_embed", |b| {
            b.iter(|| an.recognizer().embed_crop(black_box(&crop)))
        });
        g.bench_function("sface_align_crop", |b| {
            b.iter(|| align_crop(black_box(&work), &face.landmarks))
        });
    }
    g.finish();

    let mut g = c.benchmark_group("pipeline");
    g.sample_size(15);
    g.bench_function("analyze_photo", |b| {
        b.iter(|| an.analyze(black_box(&path), 0, Some(320)))
    });
    let analysis = an.analyze(&path, 0, None).analysis;
    if let Some(face) = analysis.faces().first() {
        let size = Resolution::P1080
            .output_size(3200, 2368)
            .unwrap_or(Size::new(1460, 1080));
        let anchors = face.landmarks;
        let target = RenderTarget::from_crop_anchors(&anchors, size);
        for refine in [false, true] {
            let req = FrameRequest {
                source: Path::new(&path),
                face,
                target: &target,
                backdrop: BackdropMode::Dimmed,
                adjust: Default::default(),
                refine_landmarks: refine,
            };
            let name = if refine {
                "render_frame_1080p_refined"
            } else {
                "render_frame_1080p"
            };
            g.bench_function(name, |b| {
                b.iter(|| face_engine::align::render_frame(an.detector(), black_box(&req)))
            });
        }
    }
    g.finish();
}

criterion_group!(analyze, benches);
criterion_main!(analyze);
