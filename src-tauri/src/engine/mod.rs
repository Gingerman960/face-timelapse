//! The shell's seam to the face models.
//!
//! Only what needs the ONNX models goes through [`Engine`]: per-photo
//! analysis ([`PhotoAnalyzer`]), frame rendering ([`FrameRenderer`]) and the
//! reference detections. Everything else — walk, analysis cache, matching,
//! days, frame store, look, thumbnails, export naming — is called straight
//! from `face-engine` by the shell, in production and in tests alike.
//! `real.rs` is the production implementation, `fake.rs` a deterministic test
//! double driven by file names (no models needed).

use std::path::Path;

use face_engine::align::{FrameRequest, RenderedFrame};
use face_engine::analysis::PhotoAnalyzer;
use face_engine::frames::FrameRenderer;
use face_engine::geometry::Rect;
use face_engine::reference::{ReferenceDetection, ReferenceInfo};

use crate::error::AppResult;
use crate::ipc::{ErrorKind, IpcError};

#[cfg(test)]
pub mod fake;
pub mod real;

/// What the shell needs from the face models.
///
/// All methods are blocking and may be called from any thread; heavy work
/// runs on the rayon pool, never on the async runtime.
pub trait Engine: Send + Sync + 'static {
    /// Changes whenever cached analyses or frames could differ (engine
    /// version, model files, detector parameters). Available before the
    /// models load (startup reads caches first); `None` while the model
    /// files cannot be read and verified, so no cache is attributed to them
    /// (see [`crate::state::Core::engine_fingerprint`]).
    fn fingerprint(&self) -> Option<String>;

    /// True once the ONNX models are loaded.
    fn models_ready(&self) -> bool;

    /// Loads the models (idempotent).
    ///
    /// # Errors
    /// `modelUnavailable`.
    fn load_models(&self) -> AppResult<()>;

    /// The per-photo analyzer (loads the models on first use).
    ///
    /// # Errors
    /// `modelUnavailable`.
    fn analyzer(&self) -> AppResult<&dyn PhotoAnalyzer>;

    /// The aligned-frame renderer (loads the models on first use).
    ///
    /// # Errors
    /// `modelUnavailable`.
    fn renderer(&self) -> AppResult<&dyn FrameRenderer>;

    /// One aligned frame from the analysis landmarks as they are (never
    /// refined, so no models are needed): `ftimg` previews (v1.7).
    ///
    /// # Errors
    /// I/O and decode errors of that photo.
    fn render_preview(&self, request: &FrameRequest<'_>) -> AppResult<RenderedFrame>;

    /// Size / whole-image face / auto-rotation of the reference after `rotation_deg`.
    ///
    /// # Errors
    /// `notFound`, `unsupportedFormat`, `decodeFailed`, `modelUnavailable`.
    fn reference(&self, path: &Path, rotation_deg: f64) -> AppResult<ReferenceInfo>;

    /// Largest face inside `crop` (pixels of the rotated image); `None` = no face.
    ///
    /// # Errors
    /// As [`Engine::reference`].
    fn reference_crop(
        &self,
        path: &Path,
        rotation_deg: f64,
        crop: Rect,
    ) -> AppResult<Option<ReferenceDetection>>;
}

/// `notFound` / `unsupportedFormat` checks for a photo the user handed us.
///
/// # Errors
/// As described.
pub fn check_photo_path(path: &Path) -> AppResult<()> {
    use face_engine::walk::{FileKind, classify};
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let kind = classify(&name);
    if kind == FileKind::Unsupported {
        return Err(IpcError::new(
            ErrorKind::UnsupportedFormat,
            crate::error::msg::HEIC,
        ));
    }
    if !path.is_file() {
        return Err(IpcError::missing_path(path));
    }
    if kind == FileKind::Other {
        return Err(IpcError::new(
            ErrorKind::UnsupportedFormat,
            "That file type isn't supported. Use JPEG, PNG, TIFF or WebP photos.",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn photo_path_checks() {
        let dir = tempfile::tempdir().expect("tempdir");
        let jpg = dir.path().join("a.JPG");
        std::fs::write(&jpg, b"x").expect("write");
        assert!(check_photo_path(&jpg).is_ok());
        let heic = dir.path().join("b.heic");
        assert_eq!(
            check_photo_path(&heic).expect_err("heic").kind,
            ErrorKind::UnsupportedFormat
        );
        assert_eq!(
            check_photo_path(&dir.path().join("missing.jpg"))
                .expect_err("missing")
                .kind,
            ErrorKind::NotFound
        );
        let txt = dir.path().join("notes.txt");
        std::fs::write(&txt, b"x").expect("write");
        assert_eq!(
            check_photo_path(&txt).expect_err("txt").kind,
            ErrorKind::UnsupportedFormat
        );
    }
}
