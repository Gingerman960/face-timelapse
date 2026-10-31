//! Export, reveal and open commands (§7.2 #25–31).

use std::path::Path;
use std::sync::Arc;

use tauri::ipc::Channel;
use tauri::{AppHandle, Runtime, State};

use super::{blocking, dialogs, ensure_idle};
use crate::error::AppResult;
use crate::grants::Access;
use crate::ipc::{
    ErrorKind, ExportImagesEvent, ExportVideoEvent, ImageExportSettings, IpcError, JobId,
    VideoSettings,
};
use crate::jobs;
use crate::session::derive;
use crate::state::{AppState, Core};

/// `set_video_settings` (v1.5): validates and saves the video settings
/// (pace, crossfade, caption, …) without exporting, so they survive a
/// restart. Same rules as `start_export_video`, except the ones that need the
/// frames (enough frames, a duration the holds fit in). A light change like a
/// UI preference: no mutation gate, so it also works while a job runs (a
/// running export keeps the settings it started with). Saved with the usual
/// debounce; no `session-changed` (the caller already has the value).
///
/// # Errors
/// invalidArgument (pace, crossfade, holds, quality or caption out of range,
/// a caption format that cannot format a date such as `%H`).
pub fn set_video(core: &Core, settings: VideoSettings) -> AppResult<VideoSettings> {
    let master = core.session.read().frames.output_size;
    jobs::export_video::options(&settings, master)
        .validate()
        .map_err(|e| crate::error::from_video(&e))?;
    core.wait_restored();
    core.session.write().p.video = settings.clone();
    core.mark_dirty();
    Ok(settings)
}

/// Ensures a picked video path ends in `.mp4`.
#[must_use]
pub fn with_mp4(path: &Path) -> String {
    let s = path.to_string_lossy().into_owned();
    if path
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("mp4"))
    {
        s
    } else {
        format!("{s}.mp4")
    }
}

/// Grants a save-dialog result: the `.mp4` path may be created, and — only
/// when the dialog showed exactly that name *and* a file was there when it
/// returned, so it asked before replacing — that file may be replaced
/// (L7/D13). A name that was free is create-only: a file that appears there
/// later (before or while encoding) is never overwritten. Returns the path
/// to use.
pub fn grant_video_path(core: &Core, picked: &Path) -> String {
    let path = with_mp4(picked);
    core.grants.grant(Access::ExportFile, Path::new(&path));
    let confirmed = path == picked.to_string_lossy()
        && std::fs::symlink_metadata(&path).is_ok_and(|m| !m.is_dir());
    if confirmed {
        core.grants.grant(Access::ReplaceFile, Path::new(&path));
    }
    path
}

/// Default name for the save dialog.
#[must_use]
pub fn suggested_video_name(core: &Core, suggested: &str) -> String {
    let name = suggested.trim();
    if !name.is_empty() && !name.contains(['/', '\\']) {
        return with_mp4(Path::new(name));
    }
    let s = core.session.read();
    derive::default_video_name(&derive::days(&s))
}

/// `reveal_path`: only outputs this app wrote.
///
/// # Errors
/// notFound, invalidArgument.
pub fn check_reveal(core: &Core, path: &str) -> AppResult<std::path::PathBuf> {
    let p = Path::new(path);
    if !p.is_absolute() {
        return Err(IpcError::invalid("Paths must be absolute."));
    }
    let not_ours = || IpcError::invalid("Only files FaceTimelapse exported can be revealed.");
    if p.components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(not_ours());
    }
    // 1. Spelled inside an output? Decided without touching the disk, so a
    //    non-output gets the same answer whether it exists or not (and a
    //    Windows network path nobody exported to is never opened).
    let roots: Vec<std::path::PathBuf> = core
        .session
        .read()
        .p
        .outputs
        .iter()
        .map(std::path::PathBuf::from)
        .filter(|o| p.starts_with(o))
        .collect();
    if roots.is_empty() {
        return Err(not_ours());
    }
    // 2. Resolved inside a resolved output (a symlink must not lead out).
    let canonical = p.canonicalize().map_err(|_| IpcError::missing_path(p))?;
    if roots
        .iter()
        .any(|o| o.canonicalize().is_ok_and(|o| canonical.starts_with(o)))
    {
        Ok(canonical)
    } else {
        Err(not_ours())
    }
}

/// `open_path` (v1.7): `path` must be spelled exactly as a finished video
/// export in the session's outputs (`.mp4`, not a remote spelling) — decided
/// without touching the disk — and still be a regular file there (a link is
/// never followed). Every refusal, a missing video included, is the same
/// `notFound`, so it reveals nothing about other paths.
///
/// # Errors
/// notFound.
pub fn check_open(core: &Core, path: &str) -> AppResult<std::path::PathBuf> {
    let refused = || IpcError::new(ErrorKind::NotFound, crate::error::msg::NOT_OPENABLE);
    let p = Path::new(path);
    let spelled_ok = p.is_absolute()
        && !crate::grants::is_remote_prefix(path)
        && p.extension().is_some_and(|e| e.eq_ignore_ascii_case("mp4"))
        && core.session.read().p.outputs.iter().any(|o| o == path);
    if !spelled_ok {
        return Err(refused());
    }
    let regular = std::fs::symlink_metadata(p).is_ok_and(|m| m.file_type().is_file());
    let canonical = p
        .canonicalize()
        .ok()
        .filter(|_| regular)
        .ok_or_else(refused)?;
    Ok(canonical)
}

/// [`check_open`], then `open` (the opener plugin in the app; a stub in tests).
///
/// # Errors
/// notFound; `open`'s error.
pub fn open_output(
    core: &Core,
    path: &str,
    open: impl FnOnce(&Path) -> AppResult<()>,
) -> AppResult<()> {
    open(&check_open(core, path)?)
}

#[tauri::command]
pub async fn pick_export_folder<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
) -> Result<Option<String>, IpcError> {
    ensure_idle(&state)?;
    let Some(picked) = dialogs::pick_folder(&app, "Choose where to save the aligned photos").await
    else {
        return Ok(None);
    };
    let core = Arc::clone(&state);
    // Granting resolves the path (file system): on the blocking pool.
    blocking(move || {
        core.grants.grant(Access::ExportDir, &picked);
        Ok(Some(picked.to_string_lossy().into_owned()))
    })
    .await
}

#[tauri::command]
pub async fn start_export_images(
    state: State<'_, AppState>,
    dir: String,
    settings: ImageExportSettings,
    on_event: Channel<ExportImagesEvent>,
) -> Result<JobId, IpcError> {
    let core = Arc::clone(&state);
    blocking(move || jobs::export_images::start(&core, &dir, settings, Arc::new(on_event))).await
}

#[tauri::command]
pub async fn pick_video_path<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    suggested_name: String,
) -> Result<Option<String>, IpcError> {
    ensure_idle(&state)?;
    let name = suggested_video_name(&state, &suggested_name);
    let Some(picked) = dialogs::save_video(&app, &name).await else {
        return Ok(None);
    };
    let core = Arc::clone(&state);
    // Granting resolves the path (file system): on the blocking pool.
    blocking(move || Ok(Some(grant_video_path(&core, &picked)))).await
}

#[tauri::command]
pub async fn start_export_video(
    state: State<'_, AppState>,
    path: String,
    settings: VideoSettings,
    on_event: Channel<ExportVideoEvent>,
) -> Result<JobId, IpcError> {
    let core = Arc::clone(&state);
    blocking(move || jobs::export_video::start(&core, &path, settings, Arc::new(on_event))).await
}

#[tauri::command]
pub async fn set_video_settings(
    state: State<'_, AppState>,
    settings: VideoSettings,
) -> Result<VideoSettings, IpcError> {
    let core = Arc::clone(&state);
    blocking(move || set_video(&core, settings)).await
}

#[tauri::command]
pub async fn reveal_path<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    path: String,
) -> Result<(), IpcError> {
    use tauri_plugin_opener::OpenerExt;
    let target = check_reveal(&state, &path)?;
    app.opener()
        .reveal_item_in_dir(&target)
        .map_err(|e| IpcError::internal(format!("reveal failed: {e}")))
}

#[tauri::command]
pub async fn open_path<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    path: String,
) -> Result<(), IpcError> {
    use tauri_plugin_opener::OpenerExt;
    open_output(&state, &path, |video| {
        app.opener()
            .open_path(video.to_string_lossy(), None::<&str>)
            .map_err(|e| IpcError::internal(format!("open failed: {e}")))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mp4_suffix() {
        assert_eq!(with_mp4(Path::new("/a/b")), "/a/b.mp4");
        assert_eq!(with_mp4(Path::new("/a/b.MP4")), "/a/b.MP4");
    }
}
