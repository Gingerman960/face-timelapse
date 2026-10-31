//! Error type for the whole crate.

use std::path::PathBuf;

/// Convenience alias used throughout the crate.
pub type Result<T, E = VideoError> = std::result::Result<T, E>;

/// Everything that can go wrong while planning or encoding a timelapse.
///
/// Messages are written to be shown to the end user as-is (the Tauri layer
/// forwards `to_string()`), so they avoid internal jargon where possible.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum VideoError {
    /// The options are invalid or inconsistent with the frame count.
    #[error("invalid video options: {0}")]
    InvalidOptions(String),

    /// The frame source yielded no frames.
    #[error("there are no frames to encode")]
    EmptySource,

    /// The source announced `expected` frames but ended after `got`.
    #[error("the frame source ended early: expected {expected} frames, got {got}")]
    SourceExhausted {
        /// Frame count announced by [`crate::FrameSource::len`].
        expected: usize,
        /// Frames actually produced.
        got: usize,
    },

    /// A frame handed to the encoder is malformed (wrong buffer size, zero dimensions).
    #[error("frame {index} is invalid: {reason}")]
    InvalidFrame {
        /// Zero-based source frame index.
        index: usize,
        /// Human readable reason.
        reason: String,
    },

    /// An input image could not be read or decoded.
    #[error("could not decode image {path}: {message}")]
    Decode {
        /// Offending file.
        path: PathBuf,
        /// Decoder message.
        message: String,
    },

    /// A custom frame source reported an error.
    #[error("frame source error: {0}")]
    Source(String),

    /// The H.264 encoder failed.
    #[error("H.264 encoder error: {0}")]
    Encoder(String),

    /// Building the MP4 container failed.
    #[error("MP4 muxing error: {0}")]
    Mux(String),

    /// An I/O error, with a short description of what was being done.
    #[error("{context}: {source}")]
    Io {
        /// What the crate was doing (e.g. "writing video data").
        context: String,
        /// Underlying error.
        #[source]
        source: std::io::Error,
    },

    /// The encode was cancelled through its [`crate::CancelToken`].
    #[error("video export was cancelled")]
    Cancelled,

    /// A worker thread panicked; this is a bug.
    #[error("internal error: {0}")]
    Internal(String),
}

impl VideoError {
    /// Wraps an I/O error with context.
    pub(crate) fn io(context: impl Into<String>, source: std::io::Error) -> Self {
        Self::Io {
            context: context.into(),
            source,
        }
    }

    /// True if this error is the result of a user cancellation.
    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        matches!(self, Self::Cancelled)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messages_are_user_readable() {
        let err = VideoError::SourceExhausted {
            expected: 10,
            got: 3,
        };
        assert_eq!(
            err.to_string(),
            "the frame source ended early: expected 10 frames, got 3"
        );
        let io = VideoError::io("writing video data", std::io::Error::other("disk full"));
        assert_eq!(io.to_string(), "writing video data: disk full");
        assert!(VideoError::Cancelled.is_cancelled());
        assert!(!VideoError::EmptySource.is_cancelled());
    }
}
