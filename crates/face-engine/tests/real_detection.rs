//! Detection rate and identity separation on a deterministic 200-photo
//! sample of the real data set (skips without photos/models).

mod common;

use face_engine::analysis::PhotoAnalysis;
use face_engine::geometry::{Point, Rect};
use face_engine::matching::{COS_CONFIRMED, COS_UNCERTAIN};
use face_engine::recognize::{ARCFACE_TEMPLATE, Embedding};
use face_engine::reference::{AspectPreset, default_crop};
use rayon::prelude::*;

fn percentile(sorted: &[f64], p: f64) -> f64 {
    sorted[((sorted.len() - 1) as f64 * p).round() as usize]
}

#[test]
fn detection_rate_and_same_person_separation() {
    let Some((engine, photos, reference)) = common::real() else {
        return;
    };
    let ref_img = engine.load_reference(&reference, 0.0).expect("reference");
    let ref_det = engine
        .detect_reference(&ref_img, default_crop(ref_img.size(), AspectPreset::Free))
        .expect("detect")
        .expect("reference face");
    let sample = common::sample(engine, &photos, 200);
    assert!(
        sample.len() >= 150,
        "need a real library, found {}",
        sample.len()
    );
    let analyses: Vec<PhotoAnalysis> = engine.install(|| {
        sample
            .par_iter()
            .map(|e| {
                engine
                    .analyzer()
                    .analyze(&e.path, e.mtime_ns, None)
                    .analysis
            })
            .collect()
    });

    let with_face = analyses.iter().filter(|a| !a.faces().is_empty()).count();
    let rate = with_face as f64 / analyses.len() as f64;
    println!(
        "detection rate {:.2}% ({with_face}/{})",
        rate * 100.0,
        analyses.len()
    );
    assert!(rate >= 0.98, "detection rate {rate}");

    let mut same = Vec::new();
    let mut others = Vec::new();
    for a in &analyses {
        let cos: Vec<f64> = a
            .faces()
            .iter()
            .map(|f| f64::from(f.embedding.cosine(&ref_det.embedding)))
            .collect();
        if let Some((best, _)) = cos.iter().enumerate().max_by(|x, y| x.1.total_cmp(y.1)) {
            same.push(cos[best]);
            others.extend(
                cos.iter()
                    .enumerate()
                    .filter(|(i, _)| *i != best)
                    .map(|(_, c)| *c),
            );
        }
    }
    same.sort_by(f64::total_cmp);
    let (p5, median) = (percentile(&same, 0.05), percentile(&same, 0.5));
    println!(
        "same person: min {:.3} p5 {p5:.3} median {median:.3}; other faces: {others:?}",
        same[0]
    );
    assert!(median > 0.6, "median same-person cosine {median}");
    assert!(p5 > COS_CONFIRMED, "p5 same-person cosine {p5}");
    let confirmed = same.iter().filter(|c| **c >= COS_CONFIRMED).count() as f64 / same.len() as f64;
    assert!(confirmed >= 0.95, "confirmed fraction {confirmed}");
    assert!(
        others.iter().all(|c| *c < COS_CONFIRMED),
        "another face would be confirmed: {others:?}"
    );

    // No-face set: background strips beside the face. The detector must stay
    // silent and a template-shaped crop of background must not look like the user.
    let mut fake_cos = Vec::new();
    let mut false_detections = 0;
    for (e, a) in sample.iter().zip(&analyses).take(60) {
        let Some(face) = a.faces().first() else {
            continue;
        };
        let Ok(d) = face_engine::decode::decode_file(
            &e.path,
            face_engine::decode::DecodeTarget::MinLongEdge(640),
        ) else {
            continue;
        };
        let (w, h) = (f64::from(d.image.width()), f64::from(d.image.height()));
        let fb = face.bounds.scaled(w, h);
        let strip = if fb.center().x > w / 2.0 {
            Rect::new(0.0, 0.0, fb.x, h)
        } else {
            Rect::new(fb.right(), 0.0, w - fb.right(), h)
        };
        if strip.width < 64.0 {
            continue;
        }
        let bg = d.image.cropped(
            strip.x as u32,
            strip.y as u32,
            strip.width as u32,
            strip.height as u32,
        );
        false_detections += engine
            .analyzer()
            .detector()
            .detect(&bg)
            .expect("detect")
            .len();
        let s = (bg.width().min(bg.height()) as f64 / 112.0).min(3.0);
        let lm = ARCFACE_TEMPLATE.map(|p| Point::new(p.x * s, p.y * s));
        let fake: Embedding = engine
            .analyzer()
            .recognizer()
            .embed(&bg, &lm)
            .expect("embed");
        fake_cos.push(f64::from(fake.cosine(&ref_det.embedding)));
    }
    fake_cos.sort_by(f64::total_cmp);
    println!(
        "background crops: {} false detections; cosine max {:.3}",
        false_detections,
        fake_cos.last().copied().unwrap_or(0.0)
    );
    assert!(fake_cos.len() >= 20);
    // Background never reaches "confirmed"; almost all of it is rejected outright.
    assert!(fake_cos.iter().all(|c| *c < COS_CONFIRMED), "{fake_cos:?}");
    assert!(percentile(&fake_cos, 0.9) < COS_UNCERTAIN, "{fake_cos:?}");
    assert!(
        false_detections <= fake_cos.len() / 10,
        "{false_detections} detections in background strips"
    );
}
