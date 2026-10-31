//! Internal error helpers: everything the shell reports to the UI is an
//! [`IpcError`] with a friendly `message` (ARCHITECTURE.md §7.2, D6).
//!
//! Engine and video errors are mapped here so their wording never leaks
//! internals (paths only where the user picked them, never stack traces).

use std::path::Path;

use crate::ipc::{ErrorKind, IpcError};

/// Result type of every command and service function.
pub type AppResult<T> = Result<T, IpcError>;

/// Friendly messages from ARCHITECTURE.md §7.2.
pub mod msg {
    pub const BUSY: &str = "Another task is running. Wait for it to finish or cancel it.";
    pub const BUSY_CHANGE: &str =
        "FaceTimelapse is still applying your previous change. Try again in a moment.";
    pub const FOLDER_SUPERSEDED: &str = "A newer folder choice replaced this one.";
    pub const NO_FOLDER: &str = "Choose a source folder first.";
    pub const NO_REFERENCE: &str = "Choose a reference photo first.";
    pub const NO_FRAMES: &str = "Align at least one day first.";
    pub const NO_ACTIVE_DAYS: &str =
        "There are no days to align. Confirm some photos or include a day first.";
    pub const TOO_FEW_FRAMES: &str =
        "A video needs at least two aligned days. Align more days first.";
    pub const NO_FACE_IN_REFERENCE: &str =
        "No face found inside the crop. Widen the crop or pick another reference photo.";
    pub const PERMISSION_DENIED: &str = "FaceTimelapse isn't allowed to read that folder. Grant access in System Settings › Privacy & Security.";
    pub const NOT_GRANTED: &str =
        "FaceTimelapse can only use files and folders you choose or drop onto its window.";
    pub const DISK_FULL: &str = "The disk is full. Free some space and try again.";
    pub const NOT_OPENABLE: &str = "That video can't be opened. FaceTimelapse opens only videos it exported that are still where it saved them.";
    pub const MODEL_UNAVAILABLE: &str =
        "The face models couldn't be loaded. Reinstall FaceTimelapse.";
    pub const HEIC: &str = "HEIC photos aren't supported yet. Export them as JPEG first.";
    pub const CANCELLED: &str = "The task was cancelled.";
    pub const INTERNAL: &str = "Something went wrong inside FaceTimelapse. Try again; if it keeps happening, restart the app.";
}

impl IpcError {
    pub fn busy() -> Self {
        Self::new(ErrorKind::Busy, msg::BUSY)
    }

    pub fn not_ready(message: &str) -> Self {
        Self::new(ErrorKind::NotReady, message)
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::InvalidArgument, message)
    }

    pub fn cancelled() -> Self {
        Self::new(ErrorKind::Cancelled, msg::CANCELLED)
    }

    pub fn no_face_in_reference() -> Self {
        Self::new(ErrorKind::NoFaceInReference, msg::NO_FACE_IN_REFERENCE)
    }

    pub fn model_unavailable() -> Self {
        Self::new(ErrorKind::ModelUnavailable, msg::MODEL_UNAVAILABLE)
    }

    /// "This file is no longer there: …" for a path the user chose.
    pub fn missing_path(path: &Path) -> Self {
        Self::new(
            ErrorKind::NotFound,
            format!("This file is no longer there: {}", path.display()),
        )
    }

    /// Unknown photo/day id (ids never come from users directly).
    pub fn unknown(what: &str) -> Self {
        Self::new(
            ErrorKind::NotFound,
            format!("That {what} isn't part of this session any more."),
        )
    }

    /// Logs `detail` and returns a generic internal error (no internals in `message`).
    pub fn internal(detail: impl std::fmt::Display) -> Self {
        log::error!("internal error: {detail}");
        Self::new(ErrorKind::Internal, msg::INTERNAL)
    }

    /// A feature whose engine/video API has not landed yet (see INTEGRATION-NOTES.md).
    pub fn not_available(feature: &str) -> Self {
        log::warn!("engine gap hit: {feature}");
        Self::new(
            ErrorKind::Internal,
            format!("{feature} isn't available in this build yet."),
        )
    }

    /// Maps an I/O error that happened while doing `what` (shown to the user).
    pub fn io(what: &str, err: &std::io::Error) -> Self {
        log::warn!("i/o error while {what}: {err}");
        match err.kind() {
            std::io::ErrorKind::NotFound => Self::new(
                ErrorKind::NotFound,
                format!("Couldn't find the file while {what}."),
            ),
            std::io::ErrorKind::PermissionDenied => {
                Self::new(ErrorKind::PermissionDenied, msg::PERMISSION_DENIED)
            }
            std::io::ErrorKind::StorageFull | std::io::ErrorKind::QuotaExceeded => {
                Self::new(ErrorKind::DiskFull, msg::DISK_FULL)
            }
            _ => Self::new(ErrorKind::Io, format!("Couldn't finish {what}: {err}.")),
        }
    }
}

/// Maps a `face-engine` error to the IPC error, rephrasing per kind.
pub fn from_engine(err: &face_engine::EngineError) -> IpcError {
    from_engine_kind(err.kind(), &err.to_string())
}

/// [`from_engine`] for an error reported as kind + message (per-item
/// failures of the engine's loops).
pub fn from_engine_kind(kind: face_engine::ErrorKind, text: &str) -> IpcError {
    use face_engine::ErrorKind as E;
    match kind {
        E::NoFaceInReference => IpcError::no_face_in_reference(),
        E::NoFaceDetected => IpcError::new(ErrorKind::NoFaceDetected, capitalize(text)),
        E::NotFound => IpcError::new(ErrorKind::NotFound, capitalize(text)),
        E::InvalidArgument => IpcError::invalid(capitalize(text)),
        E::UnsupportedFormat => IpcError::new(ErrorKind::UnsupportedFormat, msg::HEIC),
        E::DecodeFailed => IpcError::new(ErrorKind::DecodeFailed, capitalize(text)),
        E::PermissionDenied => IpcError::new(ErrorKind::PermissionDenied, msg::PERMISSION_DENIED),
        E::DiskFull => IpcError::new(ErrorKind::DiskFull, msg::DISK_FULL),
        E::Io => IpcError::new(ErrorKind::Io, capitalize(text)),
        E::Cancelled => IpcError::cancelled(),
        E::ModelUnavailable => {
            log::error!("model error: {text}");
            IpcError::model_unavailable()
        }
        E::EncodeFailed => IpcError::new(ErrorKind::EncodeFailed, capitalize(text)),
        E::Internal => IpcError::internal(text),
    }
}

/// Maps a `timelapse-video` error to the IPC error.
pub fn from_video(err: &timelapse_video::VideoError) -> IpcError {
    use timelapse_video::VideoError as V;
    match err {
        V::InvalidOptions(m) => IpcError::invalid(capitalize(m)),
        V::EmptySource => IpcError::not_ready(msg::TOO_FEW_FRAMES),
        V::Cancelled => IpcError::cancelled(),
        V::Decode { .. } => IpcError::new(ErrorKind::DecodeFailed, capitalize(&err.to_string())),
        V::Io { source, .. } => IpcError::io("writing the video", source),
        V::Encoder(_) | V::Mux(_) => {
            log::error!("video encode error: {err}");
            IpcError::new(
                ErrorKind::EncodeFailed,
                "The video couldn't be encoded. Try a lower resolution or quality.",
            )
        }
        other => IpcError::internal(other),
    }
}

/// Upper-cases the first character and makes sure the sentence ends with a period.
pub fn capitalize(text: &str) -> String {
    let mut chars = text.trim().chars();
    let mut out = match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect::<String>(),
        None => return String::new(),
    };
    if !out.ends_with(['.', '!', '?']) {
        out.push('.');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ipc_error_serializes_as_kind_and_message() {
        let json = serde_json::to_value(IpcError::busy()).expect("serialize");
        assert_eq!(
            json,
            serde_json::json!({"kind": "busy", "message": msg::BUSY})
        );
        let back: IpcError = serde_json::from_value(json).expect("deserialize");
        assert_eq!(back.kind, ErrorKind::Busy);
    }

    #[test]
    fn every_error_kind_has_camel_case_wire_name() {
        let kinds = [
            (ErrorKind::NoFaceInReference, "noFaceInReference"),
            (ErrorKind::NoFaceDetected, "noFaceDetected"),
            (ErrorKind::NotFound, "notFound"),
            (ErrorKind::InvalidArgument, "invalidArgument"),
            (ErrorKind::UnsupportedFormat, "unsupportedFormat"),
            (ErrorKind::DecodeFailed, "decodeFailed"),
            (ErrorKind::PermissionDenied, "permissionDenied"),
            (ErrorKind::DiskFull, "diskFull"),
            (ErrorKind::Io, "io"),
            (ErrorKind::Busy, "busy"),
            (ErrorKind::Cancelled, "cancelled"),
            (ErrorKind::NotReady, "notReady"),
            (ErrorKind::ModelUnavailable, "modelUnavailable"),
            (ErrorKind::EncodeFailed, "encodeFailed"),
            (ErrorKind::Internal, "internal"),
        ];
        for (kind, wire) in kinds {
            assert_eq!(serde_json::to_value(kind).expect("kind"), wire);
        }
    }

    #[test]
    fn io_errors_map_to_kinds_with_friendly_messages() {
        use std::io::{Error, ErrorKind as K};
        assert_eq!(
            IpcError::io("x", &Error::from(K::NotFound)).kind,
            ErrorKind::NotFound
        );
        let denied = IpcError::io("x", &Error::from(K::PermissionDenied));
        assert_eq!(denied.kind, ErrorKind::PermissionDenied);
        assert_eq!(denied.message, msg::PERMISSION_DENIED);
        assert_eq!(
            IpcError::io("x", &Error::from(K::StorageFull)).kind,
            ErrorKind::DiskFull
        );
        let other = IpcError::io("saving", &Error::other("boom"));
        assert_eq!(other.kind, ErrorKind::Io);
        assert!(other.message.starts_with("Couldn't finish saving"));
    }

    #[test]
    fn internal_errors_hide_details() {
        let err = IpcError::internal("thread panicked at src/foo.rs:12");
        assert_eq!(err.kind, ErrorKind::Internal);
        assert!(!err.message.contains("src/foo.rs"));
    }

    #[test]
    fn engine_errors_are_rephrased() {
        use face_engine::EngineError;
        let p = Path::new("/a/IMG_1.jpg");
        assert_eq!(
            from_engine(&EngineError::NoFaceInReference),
            IpcError::no_face_in_reference()
        );
        let heic = from_engine(&EngineError::UnsupportedFormat { path: p.into() });
        assert_eq!(
            (heic.kind, heic.message.as_str()),
            (ErrorKind::UnsupportedFormat, msg::HEIC)
        );
        let decode = from_engine(&EngineError::decode(p, "truncated"));
        assert_eq!(decode.kind, ErrorKind::DecodeFailed);
        assert!(decode.message.starts_with("Could not decode"));
        let model = from_engine(&EngineError::Model {
            name: "m".into(),
            message: "x".into(),
        });
        assert_eq!(model, IpcError::model_unavailable());
        assert_eq!(
            from_engine(&EngineError::Cancelled).kind,
            ErrorKind::Cancelled
        );
        assert_eq!(
            from_engine(&EngineError::Internal("x".into())).kind,
            ErrorKind::Internal
        );
        assert_eq!(
            from_engine(&EngineError::Encode("x".into())).kind,
            ErrorKind::EncodeFailed
        );
        assert_eq!(
            from_engine(&EngineError::InvalidArgument("x".into())).kind,
            ErrorKind::InvalidArgument
        );
        assert_eq!(
            from_engine(&EngineError::NoFace { path: p.into() }).kind,
            ErrorKind::NoFaceDetected
        );
        let io = EngineError::io(
            "reading",
            std::io::Error::from(std::io::ErrorKind::StorageFull),
        );
        assert_eq!(from_engine(&io).kind, ErrorKind::DiskFull);
    }

    #[test]
    fn video_errors_are_mapped() {
        use timelapse_video::VideoError;
        let bad = from_video(&VideoError::InvalidOptions(
            "fps must be between 1 and 60".into(),
        ));
        assert_eq!(bad.kind, ErrorKind::InvalidArgument);
        assert_eq!(bad.message, "Fps must be between 1 and 60.");
        assert_eq!(
            from_video(&VideoError::Cancelled).kind,
            ErrorKind::Cancelled
        );
        assert_eq!(
            from_video(&VideoError::EmptySource).kind,
            ErrorKind::NotReady
        );
        assert_eq!(
            from_video(&VideoError::Encoder("x".into())).kind,
            ErrorKind::EncodeFailed
        );
        assert_eq!(
            from_video(&VideoError::Internal("x".into())).kind,
            ErrorKind::Internal
        );
    }

    #[test]
    fn capitalize_adds_period_once() {
        assert_eq!(capitalize("no face"), "No face.");
        assert_eq!(capitalize("Done!"), "Done!");
        assert_eq!(capitalize("  "), "");
    }
}
