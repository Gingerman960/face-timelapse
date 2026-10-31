//! The 30 IPC commands of ARCHITECTURE.md §7.2.
//!
//! Every `#[tauri::command]` is a thin async wrapper: it clones the core and
//! runs the plain, unit-tested service function on Tauri's blocking pool so
//! the async runtime never stalls (anything > 1 ms leaves the runtime, §3).

pub mod app;
pub mod days;
pub mod dialogs;
pub mod export;
pub mod folder;
pub mod frames;
pub mod reference;
pub mod review;
#[cfg(test)]
mod tests;

use crate::error::AppResult;
use crate::ipc::IpcError;
use crate::state::Core;

/// Runs `f` on the blocking pool.
///
/// # Errors
/// `f`'s error, or `internal` if the task panicked.
pub async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| IpcError::internal(format!("command task failed: {e}")))?
}

/// Cheap busy pre-check before opening a dialog (the setter re-checks under the gate).
///
/// # Errors
/// `busy`.
pub fn ensure_idle(core: &Core) -> AppResult<()> {
    if core.jobs.active().is_some() {
        Err(IpcError::busy())
    } else {
        Ok(())
    }
}

/// Names of every registered command, in §7.2 order (checked against `build.rs`).
pub const COMMAND_NAMES: [&str; 31] = [
    "get_app_info",
    "get_session",
    "reset_session",
    "pick_reference_photo",
    "set_reference_photo",
    "set_reference_rotation",
    "set_reference_crop",
    "pick_source_folder",
    "set_source_folder",
    "clear_scan_cache",
    "start_scan",
    "cancel_job",
    "get_photos",
    "get_photo",
    "set_review_decision",
    "get_days",
    "select_day_photo",
    "move_photo_to_day",
    "add_photo_to_day",
    "set_day_excluded",
    "start_align",
    "get_frames",
    "set_frame_adjustment",
    "set_look",
    "pick_export_folder",
    "start_export_images",
    "pick_video_path",
    "start_export_video",
    "reveal_path",
    "set_video_settings",
    "open_path",
];
