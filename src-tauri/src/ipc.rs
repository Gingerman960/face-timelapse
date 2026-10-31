//! src-tauri/src/ipc.rs
//! BINDING IPC CONTRACT — copied verbatim from docs/rewrite/ARCHITECTURE.md §7.4.
//! TypeScript mirror: ui/src/ipc/contract.ts. Change the doc first, then both files.
#![allow(clippy::module_name_repetitions)]

use serde::{Deserialize, Serialize};

// ───────────────────────── Scalars ─────────────────────────
/// 16 lowercase hex chars: blake3(canonical absolute path).
pub type PhotoId = String;
/// Opaque job id, unique per app run.
pub type JobId = String;
/// Calendar day `YYYY-MM-DD`.
pub type DayKey = String;
/// Wall-clock local time without offset: `YYYY-MM-DDTHH:MM:SS`.
pub type LocalDateTime = String;
/// Opaque cache-busting token (lowercase hex).
pub type Version = String;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

/// Pixel size.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Size {
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

// ───────────────────────── Errors ─────────────────────────
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorKind {
    NoFaceInReference,
    NoFaceDetected,
    NotFound,
    InvalidArgument,
    UnsupportedFormat,
    DecodeFailed,
    PermissionDenied,
    DiskFull,
    Io,
    Busy,
    Cancelled,
    NotReady,
    ModelUnavailable,
    EncodeFailed,
    Internal,
}

/// Every command rejects with exactly this shape. `message` is user-facing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, thiserror::Error)]
#[serde(rename_all = "camelCase")]
#[error("{message}")]
pub struct IpcError {
    pub kind: ErrorKind,
    pub message: String,
}

impl IpcError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self { kind, message: message.into() }
    }
}

// ───────────────────────── App ─────────────────────────
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Macos,
    Windows,
    Linux,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub platform: Platform,
    /// Ends with '/': `ftimg://localhost/` or `http://ftimg.localhost/` (Windows).
    pub image_base_url: String,
    pub models_ready: bool,
    /// v1.6: why the background model load failed (user-facing); `None` while
    /// loading and once ready.
    pub models_error: Option<String>,
    pub parallelism: u32,
    pub data_dir: String,
    pub cache_dir: String,
}

// ───────────────────────── Reference ─────────────────────────
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum AspectPreset {
    #[serde(rename = "free")]
    Free,
    #[serde(rename = "1:1")]
    Square,
    #[serde(rename = "4:3")]
    Landscape4x3,
    #[serde(rename = "3:4")]
    Portrait3x4,
    #[serde(rename = "4:5")]
    Portrait4x5,
    #[serde(rename = "16:9")]
    Landscape16x9,
    #[serde(rename = "9:16")]
    Portrait9x16,
}

/// Normalized [0,1] to its image. Anchors: [leftEye, rightEye, noseTip, mouthLeft, mouthRight].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FaceGeometry {
    pub bounds: Rect,
    pub anchors: Vec<Point>,
    pub confidence: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceImage {
    pub path: String,
    pub file_name: String,
    /// Clockwise degrees after EXIF orientation, [-45, 45].
    pub rotation_deg: f64,
    pub auto_rotation_deg: Option<f64>,
    /// Pixel size after orientation + rotation (crop space).
    pub size: Size,
    pub face: Option<FaceGeometry>,
    pub version: Version,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceDetection {
    /// Normalized to the crop.
    pub anchors: Vec<Point>,
    /// Normalized to the crop.
    pub face_box: Rect,
    pub confidence: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceState {
    pub image: ReferenceImage,
    /// Pixels in `image.size` space.
    pub crop: Rect,
    pub aspect: AspectPreset,
    pub detection: Option<ReferenceDetection>,
    pub version: Version,
}

// ───────────────────────── Folder & library ─────────────────────────
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderInfo {
    pub path: String,
    pub name: String,
    pub image_count: u32,
    pub analyzed_count: u32,
    pub unsupported_count: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CacheScope {
    Folder,
    All,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearCacheResult {
    pub removed_entries: u32,
    pub freed_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MatchStatus {
    Confirmed,
    Uncertain,
    Rejected,
    NoFace,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReviewDecision {
    Pending,
    Confirmed,
    Rejected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DateSource {
    Exif,
    Filename,
    FileTime,
    Manual,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotoSummary {
    pub id: PhotoId,
    pub file_name: String,
    pub rel_path: String,
    pub taken_at: LocalDateTime,
    pub date_source: DateSource,
    /// v1.4: taken_at has a real time of day (EXIF, or a file name with a time).
    pub time_known: bool,
    pub day_key: DayKey,
    /// Calibrated [0,1]; >= 0.60 confirmed, >= 0.40 uncertain.
    pub score: f64,
    pub status: MatchStatus,
    pub review: ReviewDecision,
    pub included: bool,
    pub size: Size,
    /// Matched-face bounds, normalized to the oriented image; None for noFace/failed.
    pub face_box: Option<Rect>,
    pub version: Version,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotoDetail {
    pub summary: PhotoSummary,
    pub path: String,
    pub faces: Vec<FaceGeometry>,
    pub matched_face: Option<u32>,
    pub raw_similarity: Option<f64>,
    /// v1.7: `v` of the `preview` route (the aligned frame this photo would get
    /// now); `None` without a matched face or a reference face.
    pub preview_version: Option<Version>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotoQuery {
    pub statuses: Option<Vec<MatchStatus>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryCounts {
    pub total: u32,
    pub confirmed: u32,
    pub uncertain: u32,
    pub rejected: u32,
    pub no_face: u32,
    pub failed: u32,
    pub review_pending: u32,
    pub included: u32,
    pub days: u32,
    pub active_days: u32,
}

// ───────────────────────── Jobs (shared) ─────────────────────────
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum JobKind {
    Scan,
    Align,
    ExportImages,
    ExportVideo,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveJob {
    pub job_id: JobId,
    pub kind: JobKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobStarted {
    pub job_id: JobId,
    pub total: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobFailed {
    pub job_id: JobId,
    pub error: IpcError,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobCancelled {
    pub job_id: JobId,
    pub done: u32,
}

// ───────────────────────── Scan ─────────────────────────
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    pub job_id: JobId,
    pub done: u32,
    pub total: u32,
    pub from_cache: u32,
    pub analyzed: u32,
    pub confirmed: u32,
    pub uncertain: u32,
    pub rejected: u32,
    pub no_face: u32,
    pub failed: u32,
    pub current_file: Option<String>,
    pub photos_per_second: f64,
    pub eta_ms: Option<u64>,
    /// Max 64 entries.
    pub recent: Vec<ScanRecent>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ScanRecentStatus {
    Confirmed,
    Uncertain,
}

/// Mosaic tile: thumb URL = `thumb/{id}?v={version}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanRecent {
    pub id: PhotoId,
    /// Photo version (thumb route).
    pub version: Version,
    pub day_key: DayKey,
    pub status: ScanRecentStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanSummary {
    pub job_id: JobId,
    pub total: u32,
    pub from_cache: u32,
    pub analyzed: u32,
    pub confirmed: u32,
    pub uncertain: u32,
    pub rejected: u32,
    pub no_face: u32,
    pub failed: u32,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ScanEvent {
    Started(JobStarted),
    Progress(ScanProgress),
    Finished(ScanSummary),
    Failed(JobFailed),
    Cancelled(JobCancelled),
}

// ───────────────────────── Days ─────────────────────────
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DayGroup {
    pub day_key: DayKey,
    pub photo_ids: Vec<PhotoId>,
    pub selected_id: PhotoId,
    pub auto_selected_id: PhotoId,
    pub manual_selection: bool,
    pub excluded: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DaysPatch {
    pub upserted: Vec<DayGroup>,
    pub removed: Vec<DayKey>,
}

// ───────────────────────── Align & frames ─────────────────────────
/// Same wire values and semantics as `timelapse_video::geometry::Resolution`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Resolution {
    #[serde(rename = "source")]
    Source,
    #[serde(rename = "2160p")]
    P2160,
    #[serde(rename = "1080p")]
    P1080,
    #[serde(rename = "720p")]
    P720,
}

/// `extended` (v1.2, default): the photo's own edges continued outward, blurred and darkened.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BackdropMode {
    Dimmed,
    Blurred,
    Black,
    Extended,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderSettings {
    pub resolution: Resolution,
    pub backdrop: BackdropMode,
    pub refine_landmarks: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignProgress {
    pub job_id: JobId,
    pub done: u32,
    pub total: u32,
    pub reused: u32,
    pub failed: u32,
    pub current_photo_id: Option<PhotoId>,
    pub frames_per_second: f64,
    pub eta_ms: Option<u64>,
    /// Max 64 entries.
    pub recent: Vec<AlignRecent>,
}

/// Aligned tile: URL = `aligned/{id}?v={version}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignRecent {
    pub id: PhotoId,
    /// Frame version (aligned route).
    pub version: Version,
    pub day_key: DayKey,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignFailure {
    pub photo_id: PhotoId,
    pub error: IpcError,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignSummary {
    pub job_id: JobId,
    pub total: u32,
    pub rendered: u32,
    pub reused: u32,
    pub failed: Vec<AlignFailure>,
    pub output_size: Size,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AlignEvent {
    Started(JobStarted),
    Progress(AlignProgress),
    Finished(AlignSummary),
    Failed(JobFailed),
    Cancelled(JobCancelled),
}

/// Post-Procrustes correction in output space. Identity = { 0, 0, 1, 0 }.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameAdjust {
    /// Fraction of output width.
    pub dx: f64,
    /// Fraction of output height.
    pub dy: f64,
    pub scale: f64,
    pub rotation_deg: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameSummary {
    pub photo_id: PhotoId,
    pub day_key: DayKey,
    pub taken_at: LocalDateTime,
    /// v1.4: as `PhotoSummary::time_known`.
    pub time_known: bool,
    pub version: Version,
    pub residual_px: f64,
    pub adjust: FrameAdjust,
    /// None when look is off or stats are missing (§9.6).
    pub look_delta: Option<LookDelta>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LookDelta {
    /// 3·log2(L_out / L_in) on the face-region Oklab mean L; positive = brightened.
    pub exposure_ev: f64,
    /// 100 × Oklab (a,b) mean distance moved; 0 in `exposure` mode.
    pub color_shift: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FramesStatus {
    #[serde(rename = "none")]
    Missing,
    Stale,
    Partial,
    Complete,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NormalizeMode {
    Off,
    Exposure,
    ExposureAndColor,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LookSettings {
    pub normalize: NormalizeMode,
    pub strength: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FramesView {
    pub status: FramesStatus,
    pub output_size: Option<Size>,
    pub render: RenderSettings,
    pub look: LookSettings,
    pub reference_anchors: Option<Vec<Point>>,
    pub frames: Vec<FrameSummary>,
}

// ───────────────────────── Export: images ─────────────────────────
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ImageFormat {
    Png,
    Jpeg,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageExportSettings {
    pub format: ImageFormat,
    /// 50..=100.
    pub jpeg_quality: u8,
    pub overwrite: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportProgress {
    pub job_id: JobId,
    pub done: u32,
    pub total: u32,
    pub current_file: Option<String>,
    pub eta_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportImagesSummary {
    pub job_id: JobId,
    pub dir: String,
    pub written: u32,
    pub renamed: u32,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ExportImagesEvent {
    Started(JobStarted),
    Progress(ExportProgress),
    Finished(ExportImagesSummary),
    Failed(JobFailed),
    Cancelled(JobCancelled),
}

// ───────────────────────── Export: video (mirrors timelapse-video options) ─────────────────────────
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum Pace {
    Fps { fps: f64 },
    Duration { seconds: f64 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VideoQuality {
    Low,
    Medium,
    High,
    Max,
    Bitrate { kbps: u32 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Easing {
    Linear,
    EaseInOut,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Crossfade {
    pub frames: u32,
    pub easing: Easing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CaptionPosition {
    TopLeft,
    TopCenter,
    TopRight,
    BottomLeft,
    BottomCenter,
    BottomRight,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionOptions {
    pub position: CaptionPosition,
    /// Em-height as a fraction of output height, 0.01..=0.2.
    pub size: f64,
    /// chrono strftime.
    pub format: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoSettings {
    pub pace: Pace,
    pub resolution: Resolution,
    pub quality: VideoQuality,
    pub crossfade: Crossfade,
    pub caption: Option<CaptionOptions>,
    pub hold_first_secs: f64,
    pub hold_last_secs: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoProgress {
    pub job_id: JobId,
    pub frames_done: u32,
    pub frames_total: u32,
    pub encode_fps: f64,
    pub eta_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoSummary {
    pub job_id: JobId,
    pub path: String,
    pub frames: u32,
    pub duration_secs: f64,
    pub bytes: u64,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ExportVideoEvent {
    Started(JobStarted),
    Progress(VideoProgress),
    Finished(VideoSummary),
    Failed(JobFailed),
    Cancelled(JobCancelled),
}

// ───────────────────────── Session ─────────────────────────
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ScanStatus {
    #[serde(rename = "none")]
    Missing,
    Partial,
    Complete,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanInfo {
    pub status: ScanStatus,
    pub last_summary: Option<ScanSummary>,
    pub scanned_at: Option<LocalDateTime>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FramesInfo {
    pub status: FramesStatus,
    pub count: u32,
    pub expected: u32,
    pub output_size: Option<Size>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Recents {
    pub references: Vec<String>,
    pub folders: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSnapshot {
    pub reference: Option<ReferenceState>,
    pub folder: Option<FolderInfo>,
    pub scan: ScanInfo,
    pub counts: LibraryCounts,
    pub render: RenderSettings,
    pub look: LookSettings,
    pub frames: FramesInfo,
    pub image_export: ImageExportSettings,
    pub video: VideoSettings,
    pub active_job: Option<ActiveJob>,
    pub recents: Recents,
}

// ───────────────────────── Image protocol ─────────────────────────
pub const IMAGE_SCHEME: &str = "ftimg";
pub const THUMB_WIDTHS: [u32; 5] = [160, 320, 640, 1280, 2048];
pub const ALIGNED_WIDTHS: [u32; 4] = [160, 320, 640, 1280];
pub const REFERENCE_WIDTHS: [u32; 4] = [320, 640, 1280, 2048];
pub const REFERENCE_FRAME_WIDTHS: [u32; 4] = [160, 320, 640, 1280];
/// v1.7: widths of the `preview` route.
pub const PREVIEW_WIDTHS: [u32; 2] = [640, 1280];

/// Parsed `ftimg` request path. Grammar (query order irrelevant, unknown keys ignored):
///   /thumb/{id}?w={u32}&v={hex}  /aligned/{id}[?w={u32}][&v={hex}]
///   /reference?w={u32}&v={hex}   /reference/frame?w={u32}&v={hex}
///   /preview/{id}?w={u32}&v={hex}   (v1.7; v = PhotoDetail.previewVersion)
/// `id` = `^[0-9a-f]{16}$`. `width` is already rounded up to the route's bucket.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ImageRoute {
    Thumb { photo_id: PhotoId, width: u32, version: Option<Version> },
    Aligned { photo_id: PhotoId, width: Option<u32>, version: Option<Version> },
    Reference { width: u32, version: Option<Version> },
    ReferenceFrame { width: u32, version: Option<Version> },
    /// v1.7: the photo's aligned frame rendered on demand (never stored as a frame).
    Preview { photo_id: PhotoId, width: u32, version: Option<Version> },
}

/// Score cut-offs (legacy semantics).
pub const SCORE_CONFIRMED: f64 = 0.60;
pub const SCORE_UNCERTAIN: f64 = 0.40;

/// App event, no payload (v1.2): the backend changed session state on its own,
/// not in answer to a command (dev autoload, re-analysis of a stale reference once
/// the models load). Listen with `listen('session-changed', …)` and re-query
/// `get_session` and the queries derived from it.
pub const SESSION_CHANGED_EVENT: &str = "session-changed";

/// App event, no payload (v1.6): the background model load finished, successfully
/// or not; re-read `get_app_info` (`modelsReady`, `modelsError`). Emitted once, after
/// the outcome is recorded: subscribe first, then read `get_app_info`, so a load that
/// finished before the subscription is not missed.
pub const MODELS_CHANGED_EVENT: &str = "models-changed";

/// App event, no payload (v1.8): Help › Keyboard Shortcuts (⌘/) in the native menu
/// was chosen; the UI lays its Keys card over the current screen (as "?" does).
/// Emitted by the shell only: the webview can listen but not emit (§13).
pub const SHOW_KEYS_EVENT: &str = "show-keys";
