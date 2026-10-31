//! # face-engine
//!
//! The FaceTimelapse engine: everything between "a folder of selfies" and
//! "aligned frames on disk", in pure Rust with no Tauri types.
//!
//! Pipeline: [`walk`] a folder → [`analysis`] per photo (EXIF + dates,
//! DCT-scaled decode, YuNet [`detect`]ion, SFace [`recognize`] embeddings,
//! 320 px thumbnail) cached per folder by [`cache`] → [`matching`] against the
//! reference ([`mod@reference`]) → [`days`] grouping → [`align`]ment (legacy
//! Procrustes, antialiased warp, backdrop, feather) stored by [`frames`] →
//! [`color`] normalization on read → [`export`] / video frames.
//!
//! The [`Engine`] facade wires these together with progress reporting
//! ([`ProgressSink`]) and cooperative cancellation ([`CancelToken`]). Every
//! facade method delegates to the module function that owns the work
//! ([`scan::scan_folder`], [`frames::align_frames`],
//! [`export::export_images`], …); the Tauri shell calls those functions
//! directly from its own job runner, with the same loops. Heavy work runs on
//! the caller's rayon pool (one pool per app, sized by the app).
//!
//! ```no_run
//! use face_engine::{CancelToken, Engine, EngineConfig, NoProgress, scan::ScanOptions};
//! # fn main() -> face_engine::Result<()> {
//! let engine = Engine::new(EngineConfig::new("models", "/tmp/ft-cache"))?;
//! let reference = engine.load_reference("ref.jpg".as_ref(), 0.0)?;
//! let crop = face_engine::reference::default_crop(reference.size(), Default::default());
//! let detection = engine
//!     .detect_reference(&reference, crop)?
//!     .ok_or(face_engine::EngineError::NoFaceInReference)?;
//! let report = engine.scan(
//!     "photos".as_ref(),
//!     &detection.embedding,
//!     ScanOptions::default(),
//!     &NoProgress,
//!     &CancelToken::new(),
//! )?;
//! println!("{} photos, {} confirmed", report.photos.len(), report.counts.confirmed);
//! # Ok(()) }
//! ```

pub mod align;
pub mod analysis;
pub mod cache;
pub mod color;
pub mod dates;
pub mod days;
pub mod decode;
pub mod detect;
pub mod encode;
mod engine;
pub mod error;
pub mod export;
pub mod frames;
pub mod geometry;
pub mod image;
pub mod matching;
pub mod model;
pub mod progress;
pub mod recognize;
pub mod reference;
pub mod scan;
pub mod thumbs;
pub mod walk;
pub mod warp;

pub use engine::{Engine, EngineConfig};
pub use error::{EngineError, ErrorKind, Result};
pub use export::{ExportItem, ExportProgress, ExportReport};
pub use frames::{
    AlignFailure, AlignItem, AlignJob, AlignProgress, AlignReport, AlignSpec, AlignedFrame,
};
pub use progress::{CancelToken, NoProgress, ProgressSink};

/// Engine version; part of every cache fingerprint.
pub const ENGINE_VERSION: &str = env!("CARGO_PKG_VERSION");
