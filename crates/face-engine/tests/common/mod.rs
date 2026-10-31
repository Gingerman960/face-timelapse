//! Shared helpers for integration tests.
//!
//! Real-photo tests read `FT_PHOTOS_DIR` / `FT_REFERENCE_PHOTO` (defaulting to
//! the developer's library when present) and print `skipped: <reason>` and
//! pass when unavailable. Models come from `FT_MODELS_DIR` or `<repo>/models`.
//! Photos are never copied or modified; outputs go to temp dirs.
#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use face_engine::{Engine, EngineConfig};

pub const DEFAULT_PHOTOS: &str = "/Users/gingerman/Projects/everyday photos/photos";
pub const DEFAULT_REFERENCE: &str =
    "/Users/gingerman/Projects/everyday photos/reference/IMG_20140815_142326.jpg";

pub fn models_dir() -> PathBuf {
    std::env::var_os("FT_MODELS_DIR").map_or_else(
        || Path::new(env!("CARGO_MANIFEST_DIR")).join("../../models"),
        PathBuf::from,
    )
}

fn env_or_default(var: &str, default: &str) -> Option<PathBuf> {
    let p = std::env::var_os(var).map_or_else(|| PathBuf::from(default), PathBuf::from);
    p.exists().then_some(p)
}

pub fn photos_dir() -> Option<PathBuf> {
    env_or_default("FT_PHOTOS_DIR", DEFAULT_PHOTOS)
}

pub fn reference_photo() -> Option<PathBuf> {
    env_or_default("FT_REFERENCE_PHOTO", DEFAULT_REFERENCE)
}

/// A shared engine (models loaded once per test binary), `None` without models.
pub fn engine() -> Option<&'static Engine> {
    static ENGINE: OnceLock<Option<(Engine, tempfile::TempDir)>> = OnceLock::new();
    ENGINE
        .get_or_init(|| {
            let cache = tempfile::tempdir().ok()?;
            match Engine::new(EngineConfig::new(models_dir(), cache.path())) {
                Ok(e) => Some((e, cache)),
                Err(err) => {
                    eprintln!("skipped: models unavailable ({err})");
                    None
                }
            }
        })
        .as_ref()
        .map(|(e, _)| e)
}

/// A fresh engine with its own cache dir.
pub fn fresh_engine(cache: &Path) -> Option<Engine> {
    Engine::new(EngineConfig::new(models_dir(), cache)).ok()
}

/// Everything a real-photo test needs, or `None` after printing why it skips.
pub fn real() -> Option<(&'static Engine, PathBuf, PathBuf)> {
    let Some(engine) = engine() else {
        eprintln!("skipped: models unavailable (run scripts/fetch-models.sh)");
        return None;
    };
    let Some(photos) = photos_dir() else {
        eprintln!("skipped: set FT_PHOTOS_DIR to a folder of selfies");
        return None;
    };
    let Some(reference) = reference_photo() else {
        eprintln!("skipped: set FT_REFERENCE_PHOTO to the reference selfie");
        return None;
    };
    Some((engine, photos, reference))
}

/// Deterministic stride sample of about `n` supported photos.
pub fn sample(engine: &Engine, folder: &Path, n: usize) -> Vec<face_engine::walk::FileEntry> {
    let files = engine.walk(folder).map(|w| w.files).unwrap_or_default();
    let step = (files.len() / n.max(1)).max(1);
    files.into_iter().step_by(step).take(n).collect()
}

/// Temp folder of symlinks to `entries` (never copies the photos).
pub fn symlink_folder(entries: &[face_engine::walk::FileEntry]) -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("tempdir");
    for e in entries {
        let link = dir.path().join(e.file_name());
        #[cfg(unix)]
        std::os::unix::fs::symlink(&e.path, &link).expect("symlink");
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(&e.path, &link).expect("symlink");
    }
    dir
}

/// Writes a synthetic JPEG (gradient + blocks, no face) of the given size.
pub fn synthetic_jpeg(path: &Path, w: u32, h: u32, seed: u32) {
    let mut data = Vec::with_capacity((w * h * 3) as usize);
    for y in 0..h {
        for x in 0..w {
            let v = (x.wrapping_mul(7 + seed) ^ y.wrapping_mul(3 + seed)) & 0xff;
            data.extend_from_slice(&[(x * 255 / w) as u8, (y * 255 / h) as u8, v as u8]);
        }
    }
    let img = face_engine::image::RgbImage::from_raw(w, h, data).expect("image");
    std::fs::write(path, face_engine::encode::jpeg(&img, 90).expect("encode")).expect("write");
}
