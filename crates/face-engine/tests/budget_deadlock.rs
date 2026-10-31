//! Regression test for the scan deadlock of review 3 (no models needed).
//!
//! A scan-like `par_iter` where every item keeps its decoded image (and its
//! pixel-budget share) alive while aligning face crops, with a 4-component
//! progressive "bomb" mixed in whose budget request is the whole budget.
//! Before the fix, rayon work stealing inside the crop warp re-entered the
//! outer loop: a worker holding a share asked for the whole budget and
//! parked forever. A watchdog turns a hang into a failure.

use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use face_engine::decode::{DecodeTarget, decode};
use face_engine::geometry::Point;
use face_engine::image::RgbImage;
use rayon::prelude::*;

/// A 16 × 16 CMYK progressive JPEG whose SOF claims 12247² ≈ 150 MP: its
/// coefficient planes alone are the whole budget.
fn cmyk_progressive_bomb() -> Vec<u8> {
    let px = vec![128u8; 16 * 16 * 4];
    let mut out = Vec::new();
    let mut enc = jpeg_encoder::Encoder::new(&mut out, 90);
    enc.set_progressive(true);
    enc.encode(&px, 16, 16, jpeg_encoder::ColorType::Cmyk)
        .expect("cmyk");
    let sof = out
        .windows(2)
        .position(|w| w == [0xFF, 0xC2])
        .expect("SOF2");
    out[sof + 5..sof + 7].copy_from_slice(&12_247u16.to_be_bytes());
    out[sof + 7..sof + 9].copy_from_slice(&12_247u16.to_be_bytes());
    let sos = out.windows(2).position(|w| w == [0xFF, 0xDA]).expect("SOS");
    let len = usize::from(u16::from_be_bytes([out[sos + 2], out[sos + 3]]));
    out.truncate(sos + 2 + len + 4);
    out
}

#[test]
fn a_scan_holding_decodes_while_aligning_crops_never_hangs() {
    const ITEMS: usize = 120;
    // 3500² ≈ 12 MP: over the budget threshold, decoded at full size.
    let png = face_engine::encode::png(&RgbImage::new(3_500, 3_500)).expect("png");
    let bomb = cmyk_progressive_bomb();
    let done = std::sync::Arc::new(AtomicUsize::new(0));
    let (tx, rx) = std::sync::mpsc::channel();
    let counter = std::sync::Arc::clone(&done);
    // Detached: if it hangs, the watchdog fails the test instead of joining.
    std::thread::spawn(move || {
        (0..ITEMS).into_par_iter().for_each(|i| {
            // Every 10th item is the bomb; the others are large PNGs.
            let bytes = if i % 10 == 9 { &bomb } else { &png };
            if let Ok(d) = decode(bytes, Path::new("item"), 1, DecodeTarget::MinLongEdge(640)) {
                let c = f64::from(d.image.width()) / 2.0;
                let lm = [
                    Point::new(c - 40.0, c - 20.0),
                    Point::new(c + 40.0, c - 20.0),
                    Point::new(c, c + 10.0),
                    Point::new(c - 30.0, c + 40.0),
                    Point::new(c + 30.0, c + 40.0),
                ];
                for _ in 0..40 {
                    let _ = face_engine::recognize::align_crop(&d.image, &lm);
                }
            }
            counter.fetch_add(1, Ordering::SeqCst);
        });
        let _ = tx.send(());
    });
    let finished = rx.recv_timeout(Duration::from_secs(120));
    assert!(
        finished.is_ok(),
        "hung at {}/{ITEMS} items: a worker holding a budget share waited for budget",
        done.load(Ordering::SeqCst)
    );
}
