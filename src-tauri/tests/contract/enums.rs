//! One sample per contract enum listing every value (see `../contract.rs`).

use facetimelapse_lib::ipc::*;
use serde_json::Value;

use super::samples::v;

/// Adds `X_all` samples through `put`.
pub fn put_all(put: &mut impl FnMut(&'static str, Value)) {
    put(
        "ErrorKind_all",
        v([
            ErrorKind::NoFaceInReference,
            ErrorKind::NoFaceDetected,
            ErrorKind::NotFound,
            ErrorKind::InvalidArgument,
            ErrorKind::UnsupportedFormat,
            ErrorKind::DecodeFailed,
            ErrorKind::PermissionDenied,
            ErrorKind::DiskFull,
            ErrorKind::Io,
            ErrorKind::Busy,
            ErrorKind::Cancelled,
            ErrorKind::NotReady,
            ErrorKind::ModelUnavailable,
            ErrorKind::EncodeFailed,
            ErrorKind::Internal,
        ]),
    );
    put(
        "Platform_all",
        v([Platform::Macos, Platform::Windows, Platform::Linux]),
    );
    put(
        "AspectPreset_all",
        v([
            AspectPreset::Free,
            AspectPreset::Square,
            AspectPreset::Landscape4x3,
            AspectPreset::Portrait3x4,
            AspectPreset::Portrait4x5,
            AspectPreset::Landscape16x9,
            AspectPreset::Portrait9x16,
        ]),
    );
    put("CacheScope_all", v([CacheScope::Folder, CacheScope::All]));
    put(
        "MatchStatus_all",
        v([
            MatchStatus::Confirmed,
            MatchStatus::Uncertain,
            MatchStatus::Rejected,
            MatchStatus::NoFace,
            MatchStatus::Failed,
        ]),
    );
    put(
        "ReviewDecision_all",
        v([
            ReviewDecision::Pending,
            ReviewDecision::Confirmed,
            ReviewDecision::Rejected,
        ]),
    );
    put(
        "DateSource_all",
        v([
            DateSource::Exif,
            DateSource::Filename,
            DateSource::FileTime,
            DateSource::Manual,
        ]),
    );
    put(
        "JobKind_all",
        v([
            JobKind::Scan,
            JobKind::Align,
            JobKind::ExportImages,
            JobKind::ExportVideo,
        ]),
    );
    put(
        "ScanRecentStatus_all",
        v([ScanRecentStatus::Confirmed, ScanRecentStatus::Uncertain]),
    );
    put(
        "Resolution_all",
        v([
            Resolution::Source,
            Resolution::P2160,
            Resolution::P1080,
            Resolution::P720,
        ]),
    );
    put(
        "BackdropMode_all",
        v([
            BackdropMode::Dimmed,
            BackdropMode::Blurred,
            BackdropMode::Black,
            BackdropMode::Extended,
        ]),
    );
    put(
        "FramesStatus_all",
        v([
            FramesStatus::Missing,
            FramesStatus::Stale,
            FramesStatus::Partial,
            FramesStatus::Complete,
        ]),
    );
    put(
        "NormalizeMode_all",
        v([
            NormalizeMode::Off,
            NormalizeMode::Exposure,
            NormalizeMode::ExposureAndColor,
        ]),
    );
    put("ImageFormat_all", v([ImageFormat::Png, ImageFormat::Jpeg]));
    put(
        "Pace_all",
        v([Pace::Fps { fps: 29.97 }, Pace::Duration { seconds: 120.0 }]),
    );
    put(
        "VideoQuality_all",
        v([
            VideoQuality::Low,
            VideoQuality::Medium,
            VideoQuality::High,
            VideoQuality::Max,
            VideoQuality::Bitrate { kbps: 8000 },
        ]),
    );
    put("Easing_all", v([Easing::Linear, Easing::EaseInOut]));
    put(
        "CaptionPosition_all",
        v([
            CaptionPosition::TopLeft,
            CaptionPosition::TopCenter,
            CaptionPosition::TopRight,
            CaptionPosition::BottomLeft,
            CaptionPosition::BottomCenter,
            CaptionPosition::BottomRight,
        ]),
    );
    put(
        "ScanStatus_all",
        v([
            ScanStatus::Missing,
            ScanStatus::Partial,
            ScanStatus::Complete,
        ]),
    );
}
