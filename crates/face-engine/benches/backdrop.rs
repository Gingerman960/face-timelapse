//! Backdrop + composite cost per 1080p frame for every backdrop mode, on a
//! real selfie decoded at a typical alignment scale: the photo covering the
//! frame, and the hard case (rotated, offset, partly outside the frame).
//! `extended` must stay within +25 % of `dimmed` (ARCHITECTURE §9.5).

#[allow(dead_code)] // shares `common` with the model benches
mod common;

use std::hint::black_box;

use criterion::{Criterion, criterion_group, criterion_main};
use face_engine::decode::{self, DecodeTarget};
use face_engine::geometry::{Point, Similarity, Size};
use face_engine::image::RgbImage;
use face_engine::warp::{self, BackdropMode};

fn benches(c: &mut Criterion) {
    let tmp = tempfile::tempdir().expect("tmp");
    let (path, bytes) = common::sample_photo(tmp.path());
    let exif = decode::read_exif(&bytes);
    // Alignment decodes at ≥ 1.25× the output scale: ~2000 px for 1080p.
    let src = decode::decode(
        &bytes,
        &path,
        exif.orientation,
        DecodeTarget::MinLongEdge(2000),
    )
    .expect("decode")
    .image;
    let out = Size::new(1920, 1080);
    let (w, h) = (f64::from(src.width()), f64::from(src.height()));
    let center = Point::new(w / 2.0, h / 2.0);
    let covered = Similarity::about(center, 0.8 * 1920.0 / w.min(h * 16.0 / 9.0), 0.0)
        .then(&Similarity::translation(960.0 - center.x, 540.0 - center.y));
    // Photo ~85 % of the frame height, tilted 8°, shifted left and down.
    let partial = Similarity::about(center, 0.85 * 1080.0 / h, 8f64.to_radians())
        .then(&Similarity::translation(760.0 - center.x, 640.0 - center.y));
    let mut g = c.benchmark_group("compose_1080p");
    g.sample_size(30);
    for (geometry, t) in [("covered", covered), ("partial", partial)] {
        for mode in [
            BackdropMode::Dimmed,
            BackdropMode::Blurred,
            BackdropMode::Black,
            BackdropMode::Extended,
        ] {
            g.bench_function(format!("{geometry}/{mode:?}").to_lowercase(), |b| {
                b.iter(|| {
                    // What `align::render_frame` does after decoding.
                    if mode == BackdropMode::Extended {
                        let backdrop = warp::ExtendedBackdrop::build(black_box(&src), &t, out)
                            .expect("backdrop");
                        let mut canvas = RgbImage::new(out.width, out.height);
                        backdrop.composite(&src, &t, &mut canvas);
                        canvas
                    } else {
                        let mut canvas =
                            warp::backdrop(black_box(&src), out, mode).expect("backdrop");
                        warp::warp_over(&src, &t, &mut canvas, warp::feather_px(out));
                        canvas
                    }
                })
            });
        }
    }
    g.finish();
}

criterion_group!(backdrop, benches);
criterion_main!(backdrop);
