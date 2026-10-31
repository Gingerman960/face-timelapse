//! Shared inputs for the benches: the models and one real photo when
//! available (`FT_MODELS_DIR`, `FT_PHOTOS_DIR`/`FT_REFERENCE_PHOTO`, falling
//! back to the developer's paths), otherwise a synthetic 12 MP JPEG.

use std::path::{Path, PathBuf};

use face_engine::analysis::Analyzer;
use face_engine::detect::DetectorConfig;
use face_engine::image::RgbImage;

pub fn models_dir() -> PathBuf {
    std::env::var_os("FT_MODELS_DIR").map_or_else(
        || Path::new(env!("CARGO_MANIFEST_DIR")).join("../../models"),
        PathBuf::from,
    )
}

pub fn analyzer() -> Option<Analyzer> {
    match Analyzer::load(&models_dir(), DetectorConfig::default()) {
        Ok(a) => Some(a),
        Err(e) => {
            eprintln!("skipping model benches: {e}");
            None
        }
    }
}

/// A real selfie when present (the reference photo), else a synthetic JPEG
/// written to a temp file. Returns the path and its bytes.
pub fn sample_photo(tmp: &Path) -> (PathBuf, Vec<u8>) {
    let candidates = [
        std::env::var_os("FT_REFERENCE_PHOTO").map(PathBuf::from),
        Some(PathBuf::from(
            "/Users/gingerman/Projects/everyday photos/reference/IMG_20140815_142326.jpg",
        )),
    ];
    for p in candidates.into_iter().flatten() {
        if let Ok(bytes) = std::fs::read(&p) {
            return (p, bytes);
        }
    }
    let mut data = Vec::with_capacity(4032 * 3024 * 3);
    for y in 0..3024u32 {
        for x in 0..4032u32 {
            data.extend_from_slice(&[(x / 16) as u8, (y / 12) as u8, ((x ^ y) & 0xff) as u8]);
        }
    }
    let img = RgbImage::from_raw(4032, 3024, data).expect("synthetic image");
    let bytes = face_engine::encode::jpeg_with(&img, 90, face_engine::encode::Chroma::Subsampled)
        .expect("encode");
    let path = tmp.join("synthetic.jpg");
    std::fs::write(&path, &bytes).expect("write synthetic photo");
    (path, bytes)
}
