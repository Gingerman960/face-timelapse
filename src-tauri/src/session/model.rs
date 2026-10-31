//! Persisted session (`session.json`, ARCHITECTURE.md §5) and its defaults (§7.5).
//!
//! The file is internal and versioned. Beyond the documented fields it caches
//! the reference analysis (sizes, detection, embedding) so a restored session
//! shows statuses instantly, before the models finish loading. Analyses are
//! stored in the engine's own serde shapes; `persist.rs` migrates older files.

use std::collections::{BTreeMap, BTreeSet};

use face_engine::analysis::PhotoAnalysis;
use face_engine::recognize::Embedding;
use face_engine::reference::{ReferenceDetection, ReferenceInfo};
use serde::{Deserialize, Serialize};

use crate::ipc::{
    AspectPreset, BackdropMode, CaptionOptions, Crossfade, DayKey, Easing, FrameAdjust,
    ImageExportSettings, ImageFormat, LocalDateTime, LookSettings, NormalizeMode, Pace, PhotoId,
    Recents, Rect, RenderSettings, Resolution, ReviewDecision, ScanStatus, ScanSummary,
    VideoQuality, VideoSettings,
};

/// Current `session.json` schema version (2: analyses/reference in the
/// engine's serde shapes; v1 files are migrated on load).
pub const SESSION_VERSION: u32 = 2;
/// Most-recently-used list length.
pub const MAX_RECENTS: usize = 10;
/// Outputs remembered for `reveal_path` and re-export (most recent first).
pub const MAX_OUTPUTS: usize = 200;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PersistedSession {
    pub version: u32,
    pub reference: Option<PersistedReference>,
    pub folder: Option<String>,
    pub render: RenderSettings,
    pub look: LookSettings,
    pub image_export: ImageExportSettings,
    pub video: VideoSettings,
    pub last_scan: Option<LastScan>,
    /// Per-folder user decisions keyed by canonical folder path (§4.3).
    pub folders: BTreeMap<String, FolderDecisions>,
    pub recents: Recents,
    /// Files/dirs this app wrote (the only paths `reveal_path` accepts).
    pub outputs: Vec<String>,
    /// Exports in progress; their temporary files are deleted at the next
    /// start if the app died before they ended.
    pub pending_outputs: Vec<PendingOutput>,
    /// The engine fingerprint of the last start whose models were readable:
    /// without models, caches and frames are read with it (read-only). Kept
    /// by `Core` and filled in when saving (`None` in `Session::p`).
    pub last_engine_fingerprint: Option<String>,
}

/// An export in progress (written to disk before its first temporary file).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingOutput {
    /// The video file, or the image export folder.
    pub path: String,
    pub video: bool,
    /// Process whose id is part of the temporary file names.
    pub pid: u32,
}

impl Default for PersistedSession {
    fn default() -> Self {
        Self {
            version: SESSION_VERSION,
            reference: None,
            folder: None,
            render: default_render(),
            look: default_look(),
            image_export: default_image_export(),
            video: default_video(),
            last_scan: None,
            folders: BTreeMap::new(),
            recents: Recents::default(),
            outputs: Vec::new(),
            pending_outputs: Vec::new(),
            last_engine_fingerprint: None,
        }
    }
}

#[must_use]
pub fn default_render() -> RenderSettings {
    RenderSettings {
        resolution: Resolution::P1080,
        backdrop: BackdropMode::Extended,
        refine_landmarks: true,
    }
}

#[must_use]
pub fn default_look() -> LookSettings {
    LookSettings {
        normalize: NormalizeMode::Off,
        strength: 0.7,
    }
}

#[must_use]
pub fn default_image_export() -> ImageExportSettings {
    ImageExportSettings {
        format: ImageFormat::Png,
        jpeg_quality: 95,
        overwrite: false,
    }
}

#[must_use]
pub fn default_video() -> VideoSettings {
    VideoSettings {
        pace: Pace::Fps { fps: 10.0 },
        resolution: Resolution::Source,
        quality: VideoQuality::High,
        crossfade: Crossfade {
            frames: 0,
            easing: Easing::EaseInOut,
        },
        caption: None::<CaptionOptions>,
        hold_first_secs: 0.0,
        hold_last_secs: 1.0,
    }
}

/// Reference choice plus its cached analysis.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedReference {
    pub path: String,
    pub rotation_deg: f64,
    /// Pixels of the rotated image.
    pub crop: Rect,
    pub aspect: AspectPreset,
    /// `photo_version(size, mtime)` of the reference file when analyzed.
    pub file_version: String,
    /// Engine fingerprint the cached analysis was made with.
    pub engine: String,
    pub image: ReferenceInfo,
    pub detection: Option<ReferenceDetection>,
    /// The embedding matching uses while the crop holds no face: the last
    /// detected crop's of the same photo (absent when `detection` is set).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub match_embedding: Option<Embedding>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LastScan {
    pub folder: String,
    pub at: LocalDateTime,
    pub status: ScanStatus,
    pub summary: Option<ScanSummary>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FolderDecisions {
    pub reviews: BTreeMap<PhotoId, ReviewDecision>,
    pub day_moves: BTreeMap<PhotoId, DayKey>,
    pub manual_photos: Vec<ManualPhoto>,
    pub day_selections: BTreeMap<DayKey, PhotoId>,
    pub excluded_days: BTreeSet<DayKey>,
    pub adjusts: BTreeMap<PhotoId, FrameAdjust>,
}

/// A photo added to a day by hand (kept with its analysis so restore needs no models).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualPhoto {
    pub path: String,
    pub day_key: DayKey,
    pub size: u64,
    pub mtime_ns: i64,
    pub analysis: PhotoAnalysis,
}

/// Moves `item` to the front of an MRU list (dedup, capped).
pub fn push_recent(list: &mut Vec<String>, item: &str) {
    push_capped(list, item, MAX_RECENTS);
}

/// Records an output (MRU, dedup, capped at [`MAX_OUTPUTS`]).
pub fn push_output(list: &mut Vec<String>, item: &str) {
    push_capped(list, item, MAX_OUTPUTS);
}

fn push_capped(list: &mut Vec<String>, item: &str, cap: usize) {
    list.retain(|x| x != item);
    list.insert(0, item.to_owned());
    list.truncate(cap);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_architecture() {
        let s = PersistedSession::default();
        let json = serde_json::to_value(&s).expect("serialize");
        assert_eq!(
            json["render"],
            serde_json::json!({"resolution": "1080p", "backdrop": "extended", "refineLandmarks": true})
        );
        assert_eq!(
            json["look"],
            serde_json::json!({"normalize": "off", "strength": 0.7})
        );
        assert_eq!(
            json["imageExport"],
            serde_json::json!({"format": "png", "jpegQuality": 95, "overwrite": false})
        );
        assert_eq!(
            json["video"],
            serde_json::json!({"pace": {"mode": "fps", "fps": 10.0}, "resolution": "source", "quality": "high",
                "crossfade": {"frames": 0, "easing": "easeInOut"}, "caption": null, "holdFirstSecs": 0.0, "holdLastSecs": 1.0})
        );
        assert_eq!(json["version"], SESSION_VERSION);
    }

    #[test]
    fn missing_fields_fall_back_to_defaults() {
        let s: PersistedSession =
            serde_json::from_str(r#"{"version":2,"folder":"/p"}"#).expect("parse");
        assert_eq!(s.folder.as_deref(), Some("/p"));
        assert_eq!(s.render, default_render());
        let d: FolderDecisions = serde_json::from_str("{}").expect("parse");
        assert!(d.reviews.is_empty());
    }

    #[test]
    fn recents_are_mru_deduped_and_capped() {
        let mut v = Vec::new();
        for i in 0..12 {
            push_recent(&mut v, &format!("/p{i}"));
        }
        push_recent(&mut v, "/p5");
        assert_eq!(v.len(), MAX_RECENTS);
        assert_eq!(v[0], "/p5");
        assert_eq!(v.iter().filter(|x| *x == "/p5").count(), 1);
    }
}
