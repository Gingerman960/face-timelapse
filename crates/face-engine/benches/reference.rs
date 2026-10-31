//! Reference crop update: detect + embed in the crop, then re-match a
//! 3,600-photo library in memory (budget: < 150 ms p95).

mod common;

use std::hint::black_box;

use chrono::NaiveDateTime;
use criterion::{Criterion, criterion_group, criterion_main};
use face_engine::analysis::{FaceRecord, Outcome, PhotoAnalysis};
use face_engine::dates::DateSource;
use face_engine::geometry::{Point, Rect, Size};
use face_engine::matching::{Calibration, MatchStatus};
use face_engine::recognize::Embedding;
use face_engine::reference::{AspectPreset, ReferenceImage, default_crop};
use face_engine::scan::match_photo;

fn library(n: usize) -> Vec<PhotoAnalysis> {
    (0..n)
        .map(|i| {
            let v: Vec<f32> = (0..128)
                .map(|j| ((i * 31 + j * 17) % 97) as f32 - 48.0)
                .collect();
            PhotoAnalysis {
                oriented_size: Size::new(4032, 3024),
                taken_at: NaiveDateTime::default(),
                date_source: DateSource::Exif,
                outcome: Outcome::Faces {
                    faces: vec![FaceRecord {
                        bounds: Rect::new(0.3, 0.2, 0.4, 0.5),
                        landmarks: [Point::new(0.5, 0.5); 5],
                        score: 0.9,
                        embedding: Embedding::normalized(&v).unwrap_or(Embedding(vec![0.0; 128])),
                    }],
                },
            }
        })
        .collect()
}

fn benches(c: &mut Criterion) {
    let lib = library(3600);
    let probe = lib[0].faces()[0].embedding.clone();
    let cal = Calibration::default();
    c.bench_function("rematch_3600", |b| {
        b.iter(|| {
            lib.iter()
                .filter(|a| match_photo(a, black_box(&probe), &cal).1 == MatchStatus::Confirmed)
                .count()
        })
    });

    let Some(an) = common::analyzer() else { return };
    let tmp = tempfile::tempdir().expect("tmp");
    let (path, _) = common::sample_photo(tmp.path());
    let Ok(reference) = ReferenceImage::load(&an, &path, 0.0) else {
        return;
    };
    let crop = default_crop(reference.size(), AspectPreset::Square);
    let mut g = c.benchmark_group("reference");
    g.sample_size(20);
    g.bench_function("crop_update_detect_embed_rematch", |b| {
        b.iter(|| {
            let det = reference.detect_crop(&an, black_box(crop)).ok().flatten();
            det.map(|d| {
                lib.iter()
                    .filter(|a| match_photo(a, &d.embedding, &cal).0.is_some())
                    .count()
            })
        })
    });
    g.sample_size(10);
    g.bench_function("load_reference_full", |b| {
        b.iter(|| ReferenceImage::load(&an, black_box(&path), 0.0))
    });
    g.finish();
}

criterion_group!(reference, benches);
criterion_main!(reference);
