//! Reference photo on the real data set (skips without photos/models).

mod common;

use face_engine::geometry::{Point, Rect};
use face_engine::reference::{AspectPreset, center_on_face, default_crop};

fn assert_anchor_order(a: &[Point; 5], what: &str) {
    assert!(
        a[0].x < a[1].x,
        "{what}: left eye must be image-left: {a:?}"
    );
    assert!(
        a[3].x < a[4].x,
        "{what}: left mouth corner must be image-left: {a:?}"
    );
    let eye_y = (a[0].y + a[1].y) / 2.0;
    let mouth_y = (a[3].y + a[4].y) / 2.0;
    assert!(
        eye_y < a[2].y && a[2].y < mouth_y,
        "{what}: eyes above nose above mouth: {a:?}"
    );
}

#[test]
fn reference_anchor_invariants_and_crop_presets() {
    let Some((engine, _, reference)) = common::real() else {
        return;
    };
    let img = engine
        .load_reference(&reference, 0.0)
        .expect("load reference");
    let face = img.face().expect("whole-image face");
    assert!(face.confidence > 0.8, "confidence {}", face.confidence);
    assert_anchor_order(&face.anchors, "whole image");
    let auto = img.auto_rotation_deg().expect("auto rotation");
    assert!(auto.abs() < 10.0, "auto rotation {auto}");

    for aspect in AspectPreset::ALL {
        let crop = default_crop(img.size(), aspect);
        let det = engine
            .detect_reference(&img, crop)
            .expect("detect")
            .unwrap_or_else(|| panic!("no face in {aspect:?} crop"));
        assert_anchor_order(&det.anchors, &format!("{aspect:?} crop"));
        let norm: f32 = det
            .embedding
            .as_slice()
            .iter()
            .map(|v| v * v)
            .sum::<f32>()
            .sqrt();
        assert!((norm - 1.0).abs() < 1e-4);
        // Face box lies inside the crop.
        assert!(
            det.face_box.x >= -0.05 && det.face_box.right() <= 1.05,
            "{:?}",
            det.face_box
        );
    }

    // A crop with no face in it.
    let corner = Rect::new(0.0, 0.0, 200.0, 200.0);
    assert!(
        engine
            .detect_reference(&img, corner)
            .expect("detect")
            .is_none()
    );

    // Center Face keeps the face centered in the crop.
    let size = img.size();
    let bounds_px = face
        .bounds
        .scaled(f64::from(size.width), f64::from(size.height));
    let crop = center_on_face(
        Rect::new(0.0, 0.0, 1200.0, 1200.0),
        bounds_px,
        size,
        AspectPreset::Square,
    );
    let c = crop.center();
    let fc = bounds_px.center();
    assert!(
        (c.x - fc.x).abs() <= 1.0 && (c.y - fc.y).abs() <= 1.0,
        "{crop:?} vs {fc:?}"
    );
}

#[test]
fn levelling_rotation_makes_the_eyes_horizontal() {
    let Some((engine, _, reference)) = common::real() else {
        return;
    };
    let img = engine.load_reference(&reference, 0.0).expect("load");
    let auto = img.auto_rotation_deg().expect("auto");
    let rotated = engine.load_reference(&reference, auto).expect("rotated");
    assert!(rotated.size().width > img.size().width || auto.abs() < 0.01);
    // Measured with the framing ensemble: a single whole-image detection's
    // eye line is off by up to ~2° on this photo (see `ensemble_detection`).
    let residual = rotated
        .eye_tilt_deg(engine.analyzer())
        .expect("measure")
        .expect("face after rotation");
    assert!(
        residual.abs() < 0.2,
        "eyes still tilted by {residual}° after {auto}°"
    );
    let again = rotated.auto_rotation_deg().expect("auto 2");
    assert!(
        (again - auto).abs() < 0.6,
        "absolute auto rotation drifted: {auto} → {again}"
    );
    assert!(engine.load_reference(&reference, 60.0).is_err());
}

#[test]
fn one_press_levels_the_eyes_and_a_second_changes_nothing() {
    let Some((engine, _, reference)) = common::real() else {
        return;
    };
    let auto = engine
        .load_reference(&reference, 0.0)
        .expect("load")
        .auto_rotation_deg()
        .expect("auto");
    let rotated = engine.load_reference(&reference, auto).expect("rotated");
    let residual = rotated
        .eye_tilt_deg(engine.analyzer())
        .expect("measure")
        .expect("face");
    assert!(
        residual.abs() < 0.2,
        "eyes still tilted by {residual:.3}° after one press ({auto:.3}°)"
    );
    let again = rotated.auto_rotation_deg().expect("auto 2");
    assert!(
        (again - auto).abs() < 0.05,
        "a second press would rotate again: {auto:.3} → {again:.3}"
    );
}

#[test]
fn a_second_face_in_the_crop_gets_its_own_landmarks_and_embedding() {
    let Some((engine, _, reference)) = common::real() else {
        return;
    };
    // The reference twice, side by side (a temp file; the photo is only read):
    // whichever copy the whole-image detection calls the main face, the
    // other half holds a second face of the same person.
    let photo =
        face_engine::decode::decode_file(&reference, face_engine::decode::DecodeTarget::Full)
            .expect("decode")
            .into_image()
            .fit_within(1200, face_engine::image::Filter::Bilinear)
            .expect("fit");
    let (w, h) = (photo.width(), photo.height());
    let mut twin = face_engine::image::RgbImage::new(2 * w, h);
    let (src_stride, dst_stride) = (photo.stride(), twin.stride());
    for y in 0..h as usize {
        let row = &photo.as_raw()[y * src_stride..(y + 1) * src_stride];
        let dst = &mut twin.as_raw_mut()[y * dst_stride..(y + 1) * dst_stride];
        dst[..src_stride].copy_from_slice(row);
        dst[src_stride..].copy_from_slice(row);
    }
    let dir = tempfile::tempdir().expect("tmp");
    let path = dir.path().join("twins.jpg");
    std::fs::write(&path, face_engine::encode::jpeg(&twin, 92).expect("jpeg")).expect("write");
    let img = engine.load_reference(&path, 0.0).expect("load");
    let half = |x: f64| Rect::new(x, 0.0, f64::from(w), f64::from(h));
    let left = engine
        .detect_reference(&img, half(0.0))
        .expect("left")
        .expect("face");
    let right = engine
        .detect_reference(&img, half(f64::from(w)))
        .expect("right")
        .expect("face");
    for d in [&left, &right] {
        assert_anchor_order(&d.anchors, "twin");
    }
    let cos = left.embedding.cosine(&right.embedding);
    assert!(cos > 0.9, "same face, measured apart: cos {cos:.3}");
}

#[test]
fn the_matching_embedding_does_not_depend_on_the_crop_or_rotation() {
    let Some((engine, _, reference)) = common::real() else {
        return;
    };
    let mut embeddings = Vec::new();
    for rotation in [0.0, 3.5] {
        let img = engine.load_reference(&reference, rotation).expect("load");
        for aspect in [
            AspectPreset::Free,
            AspectPreset::Portrait3x4,
            AspectPreset::Portrait4x5,
            AspectPreset::Square,
        ] {
            let det = engine
                .detect_reference(&img, default_crop(img.size(), aspect))
                .expect("detect")
                .expect("face");
            embeddings.push(((rotation, aspect), det.embedding));
        }
    }
    for (i, (a, ea)) in embeddings.iter().enumerate() {
        for (b, eb) in &embeddings[i + 1..] {
            let cos = ea.cosine(eb);
            assert!(cos > 0.995, "{a:?} vs {b:?}: cos {cos:.4}");
        }
    }
}
