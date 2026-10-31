//! Error type for the whole crate.
//!
//! Messages are short and safe to show to an end user; the Tauri shell maps
//! [`EngineError::kind`] onto its IPC `ErrorKind` and may rephrase.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize, Serializer, ser::SerializeStruct};

/// Convenience alias used throughout the crate.
pub type Result<T, E = EngineError> = std::result::Result<T, E>;

/// Coarse classification of an [`EngineError`], mirroring the IPC contract's
/// `ErrorKind` where the engine can produce it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorKind {
    /// No face inside the reference crop.
    NoFaceInReference,
    /// No face in a photo where one was required.
    NoFaceDetected,
    /// A file or directory does not exist.
    NotFound,
    /// A caller-supplied argument is out of range or inconsistent.
    InvalidArgument,
    /// The file type is recognised but not supported (e.g. HEIC).
    UnsupportedFormat,
    /// The file could not be decoded.
    DecodeFailed,
    /// The OS refused access.
    PermissionDenied,
    /// The disk is full.
    DiskFull,
    /// Any other I/O failure.
    Io,
    /// The operation was cancelled through a [`crate::CancelToken`].
    Cancelled,
    /// The ONNX models are missing or could not be loaded.
    ModelUnavailable,
    /// Encoding an output image failed.
    EncodeFailed,
    /// A bug or an unexpected internal state.
    Internal,
}

/// Everything that can go wrong inside the engine.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum EngineError {
    /// A model file is missing or could not be loaded/optimized.
    #[error("the face model {name} could not be loaded: {message}")]
    Model {
        /// File name of the model.
        name: String,
        /// Underlying problem.
        message: String,
    },

    /// Running a model failed.
    #[error("face model inference failed: {0}")]
    Inference(String),

    /// An I/O error, with what was being done.
    #[error("{context}: {source}")]
    Io {
        /// What the engine was doing.
        context: String,
        /// Underlying error.
        #[source]
        source: std::io::Error,
    },

    /// The image could not be decoded.
    #[error("could not decode {}: {message}", path.display())]
    Decode {
        /// Offending file.
        path: PathBuf,
        /// Decoder message.
        message: String,
    },

    /// The image format is not supported (HEIC/HEIF, unknown bytes).
    #[error("unsupported image format: {}", path.display())]
    UnsupportedFormat {
        /// Offending file.
        path: PathBuf,
    },

    /// No face inside the reference crop.
    #[error("no face found inside the reference crop")]
    NoFaceInReference,

    /// No face found in a photo where one was required.
    #[error("no face found in {}", path.display())]
    NoFace {
        /// Offending file.
        path: PathBuf,
    },

    /// A caller-supplied argument is invalid.
    #[error("invalid argument: {0}")]
    InvalidArgument(String),

    /// Encoding an image failed.
    #[error("could not encode image: {0}")]
    Encode(String),

    /// The operation was cancelled.
    #[error("the operation was cancelled")]
    Cancelled,

    /// Internal invariant violated (a bug).
    #[error("internal error: {0}")]
    Internal(String),
}

impl EngineError {
    /// Builds an [`EngineError::Io`] with context.
    pub fn io(context: impl Into<String>, source: std::io::Error) -> Self {
        Self::Io {
            context: context.into(),
            source,
        }
    }

    /// Builds an [`EngineError::Decode`].
    pub fn decode(path: &Path, message: impl Into<String>) -> Self {
        Self::Decode {
            path: path.to_path_buf(),
            message: message.into(),
        }
    }

    /// Coarse classification used by the IPC layer.
    #[must_use]
    pub fn kind(&self) -> ErrorKind {
        match self {
            Self::Model { .. } => ErrorKind::ModelUnavailable,
            Self::Inference(_) | Self::Internal(_) => ErrorKind::Internal,
            Self::Io { source, .. } => io_kind(source),
            Self::Decode { .. } => ErrorKind::DecodeFailed,
            Self::UnsupportedFormat { .. } => ErrorKind::UnsupportedFormat,
            Self::NoFaceInReference => ErrorKind::NoFaceInReference,
            Self::NoFace { .. } => ErrorKind::NoFaceDetected,
            Self::InvalidArgument(_) => ErrorKind::InvalidArgument,
            Self::Encode(_) => ErrorKind::EncodeFailed,
            Self::Cancelled => ErrorKind::Cancelled,
        }
    }
}

fn io_kind(err: &std::io::Error) -> ErrorKind {
    match err.kind() {
        std::io::ErrorKind::NotFound => ErrorKind::NotFound,
        std::io::ErrorKind::PermissionDenied => ErrorKind::PermissionDenied,
        std::io::ErrorKind::StorageFull => ErrorKind::DiskFull,
        _ => ErrorKind::Io,
    }
}

/// Serialized as `{ "kind": "...", "message": "..." }` so it can cross IPC.
impl Serialize for EngineError {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        let mut s = serializer.serialize_struct("EngineError", 2)?;
        s.serialize_field("kind", &self.kind())?;
        s.serialize_field("message", &self.to_string())?;
        s.end()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_map_io_errors() {
        let nf = EngineError::io(
            "reading",
            std::io::Error::from(std::io::ErrorKind::NotFound),
        );
        assert_eq!(nf.kind(), ErrorKind::NotFound);
        let pd = EngineError::io(
            "reading",
            std::io::Error::from(std::io::ErrorKind::PermissionDenied),
        );
        assert_eq!(pd.kind(), ErrorKind::PermissionDenied);
        let full = EngineError::io(
            "writing",
            std::io::Error::from(std::io::ErrorKind::StorageFull),
        );
        assert_eq!(full.kind(), ErrorKind::DiskFull);
        let other = EngineError::io("x", std::io::Error::other("boom"));
        assert_eq!(other.kind(), ErrorKind::Io);
        assert!(other.to_string().starts_with("x: "));
    }

    #[test]
    fn kinds_cover_every_variant() {
        let p = Path::new("/a/b.jpg");
        let cases = [
            (
                EngineError::Model {
                    name: "m".into(),
                    message: "x".into(),
                },
                ErrorKind::ModelUnavailable,
            ),
            (EngineError::Inference("x".into()), ErrorKind::Internal),
            (EngineError::decode(p, "bad"), ErrorKind::DecodeFailed),
            (
                EngineError::UnsupportedFormat { path: p.into() },
                ErrorKind::UnsupportedFormat,
            ),
            (EngineError::NoFaceInReference, ErrorKind::NoFaceInReference),
            (
                EngineError::NoFace { path: p.into() },
                ErrorKind::NoFaceDetected,
            ),
            (
                EngineError::InvalidArgument("x".into()),
                ErrorKind::InvalidArgument,
            ),
            (EngineError::Encode("x".into()), ErrorKind::EncodeFailed),
            (EngineError::Cancelled, ErrorKind::Cancelled),
            (EngineError::Internal("x".into()), ErrorKind::Internal),
        ];
        for (err, kind) in cases {
            assert_eq!(err.kind(), kind, "{err}");
            assert!(!err.to_string().is_empty());
        }
    }

    #[test]
    fn serializes_kind_and_message() {
        let err = EngineError::decode(Path::new("/x/y.jpg"), "truncated");
        let json = serde_json::to_value(&err).expect("serialize");
        assert_eq!(json["kind"], "decodeFailed");
        assert_eq!(json["message"], "could not decode /x/y.jpg: truncated");
    }
}
