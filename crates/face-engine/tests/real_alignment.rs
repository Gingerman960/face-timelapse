//! Alignment accuracy on real photos (skips without photos/models).
//!
//! Every aligned frame is measured again with the TTA landmark protocol
//! (`Detector::refine`) around the reference face box. Two numbers matter for
//! a timelapse, both normalized by the reference inter-pupillary distance:
//! - **jitter**: RMS spread of the measured eye positions across frames
//!   (what makes a timelapse wobble);
//! - **bias**: distance of their mean from the reference eye anchors.

mod common;

use face_engine::align::{FrameRequest, RenderTarget, Resolution, render_frame};
use face_engine::geometry::Point;
use face_engine::matching::MatchStatus;
use face_engine::reference::{AspectPreset, default_crop};
use face_engine::scan::match_photo;
use face_engine::warp::BackdropMode;
use rayon::prelude::*;

/// `(jitter, bias)` of eye measurements `[left.x, left.y, right.x, right.y]`.
fn jitter_and_bias(m: &[[f64; 4]], target: &[Point; 5]) -> (f64, f64) {
    let n = m.len() as f64;
    let t = [target[0].x, target[0].y, target[1].x, target[1].y];
    let (mut var, mut bias) = (0.0, 0.0);
    for k in 0..4 {
        let mean = m.iter().map(|v| v[k]).sum::<f64>() / n;
        var += m.iter().map(|v| (v[k] - mean).powi(2)).sum::<f64>() / n;
        bias += (mean - t[k]).powi(2);
    }
    let ipd = target[0].distance(target[1]);
    ((var / 2.0).sqrt() / ipd, (bias / 2.0).sqrt() / ipd)
}

#[test]
fn aligned_eyes_are_stable_across_frames() {
    let Some((engine, photos, reference)) = common::real() else {
        return;
    };
    let ref_img = engine.load_reference(&reference, 0.0).expect("reference");
    let crop = default_crop(ref_img.size(), AspectPreset::Landscape4x3);
    let det = engine
        .detect_reference(&ref_img, crop)
        .expect("detect")
        .expect("face");
    let out = Resolution::P1080
        .output_size(crop.width as u32, crop.height as u32)
        .expect("size");
    let target = RenderTarget::from_crop_anchors(&det.anchors, out);
    let face_box = det
        .face_box
        .scaled(f64::from(out.width), f64::from(out.height));
    let detector = engine.analyzer().detector();
    let sample = common::sample(engine, &photos, 60);

    // Per frame: eyes measured after aligning with scan anchors / refined anchors.
    let rows: Vec<([f64; 4], [f64; 4], f64)> = engine.install(|| {
        sample
            .par_iter()
            .filter_map(|e| {
                let a = engine
                    .analyzer()
                    .analyze(&e.path, e.mtime_ns, None)
                    .analysis;
                let (m, status) = match_photo(&a, &det.embedding, &engine.calibration());
                if status != MatchStatus::Confirmed {
                    return None;
                }
                let face = &a.faces()[m?.face_index];
                let mut eyes = [[0.0; 4]; 2];
                let mut residual = 0.0;
                for (i, refine) in [false, true].into_iter().enumerate() {
                    let req = FrameRequest {
                        source: &e.path,
                        face,
                        target: &target,
                        backdrop: BackdropMode::Dimmed,
                        adjust: Default::default(),
                        refine_landmarks: refine,
                    };
                    let frame = render_frame(detector, &req).ok()?;
                    let found = detector.refine(&frame.image, face_box).ok()??;
                    let l = found.landmarks;
                    eyes[i] = [l[0].x, l[0].y, l[1].x, l[1].y];
                    residual = frame.residual_px;
                }
                Some((eyes[0], eyes[1], residual))
            })
            .collect()
    });
    assert!(rows.len() >= 45, "only {} frames measured", rows.len());
    let scan: Vec<_> = rows.iter().map(|r| r.0).collect();
    let refined: Vec<_> = rows.iter().map(|r| r.1).collect();
    let (j0, b0) = jitter_and_bias(&scan, &target.anchors);
    let (j1, b1) = jitter_and_bias(&refined, &target.anchors);
    let mut residuals: Vec<f64> = rows.iter().map(|r| r.2).collect();
    residuals.sort_by(f64::total_cmp);
    let ipd = target.anchors[0].distance(target.anchors[1]);
    println!(
        "{} frames at {}x{}, IPD {ipd:.0} px: eye jitter scan anchors {:.4} IPD ({:.1} px), \
         refined {:.4} IPD ({:.1} px); bias scan {b0:.4} refined {b1:.4} IPD; \
         Procrustes residual median {:.2} px, max {:.2} px",
        rows.len(),
        out.width,
        out.height,
        j0,
        j0 * ipd,
        j1,
        j1 * ipd,
        residuals[residuals.len() / 2],
        residuals[residuals.len() - 1],
    );
    assert!(j1 < 0.035, "eye jitter {j1} of IPD");
    assert!(j1 <= j0, "refinement must reduce jitter: {j0} → {j1}");
    assert!(b1 < 0.03, "eye bias {b1} of IPD");
}
