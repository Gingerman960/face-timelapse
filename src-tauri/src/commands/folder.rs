//! Source folder commands (§7.2 #8–10).

use std::path::Path;
use std::sync::Arc;

use face_engine as fe;
use tauri::{AppHandle, Runtime, State};

use super::{blocking, dialogs, ensure_idle};
use crate::error::AppResult;
use crate::grants::Access;
use crate::ipc::{CacheScope, ClearCacheResult, FolderInfo, IpcError};
use crate::session::derive;
use crate::session::model::push_recent;
use crate::state::{AppState, Core};

/// `set_source_folder`. The folder is walked (and joined with its cache)
/// before the mutation gate is taken, so a huge folder never blocks other
/// changes; if a newer folder choice (or a reset) started meanwhile, this
/// one is discarded.
///
/// # Errors
/// busy, notFound, invalidArgument (not a dir), permissionDenied,
/// cancelled (superseded by a newer choice).
pub fn set_folder(core: &Core, path: &str) -> AppResult<FolderInfo> {
    let folder = core.granted(path, Access::Read)?;
    if !folder.is_dir() {
        return Err(IpcError::invalid("Choose a folder, not a file."));
    }
    std::fs::read_dir(&folder).map_err(|e| IpcError::io("reading the folder", &e))?;
    ensure_idle(core)?;
    let seq = core.next_folder_seq();
    let library = core.library_of(&folder)?;
    let _gate = core.begin_mutation()?;
    if !core.is_latest_folder(seq) {
        return Err(IpcError::new(
            crate::ipc::ErrorKind::Cancelled,
            crate::error::msg::FOLDER_SUPERSEDED,
        ));
    }
    let folder_str = folder.to_string_lossy().into_owned();
    let info = {
        let mut s = core.session.write();
        s.p.folder = Some(folder_str.clone());
        push_recent(&mut s.p.recents.folders, &folder_str);
        s.library = library;
        s.sync_manual();
        s.rematch();
        derive::folder_info(&s)
    };
    core.mark_dirty();
    info.ok_or_else(|| IpcError::internal("folder info missing after set"))
}

fn file_len(p: &Path) -> u64 {
    std::fs::metadata(p).map_or(0, |m| m.len())
}

fn dir_size(dir: &Path) -> u64 {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return 0;
    };
    rd.flatten()
        .map(|e| {
            let p = e.path();
            if p.is_dir() {
                dir_size(&p)
            } else {
                file_len(&p)
            }
        })
        .sum()
}

/// `clear_scan_cache`: drops cached analyses (and, for `all`, thumbnails).
///
/// # Errors
/// busy, io.
pub fn clear_cache(core: &Core, scope: CacheScope) -> AppResult<ClearCacheResult> {
    let _gate = core.begin_mutation()?;
    let folder = core.session.read().library.folder.clone();
    let mut result = ClearCacheResult {
        removed_entries: 0,
        freed_bytes: 0,
    };
    match scope {
        CacheScope::Folder => {
            let Some(folder) = folder.as_deref() else {
                return Ok(result);
            };
            let file = fe::cache::AnalysisCache::file_path(&core.paths.cache_dir, folder);
            result.removed_entries = core.session.read().library.analyzed_count();
            result.freed_bytes = file_len(&file);
            match std::fs::remove_file(&file) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(IpcError::io("clearing the scan cache", &e)),
            }
        }
        CacheScope::All => {
            let analysis = fe::cache::dir(&core.paths.cache_dir);
            let thumbs = fe::thumbs::dir(&core.paths.cache_dir);
            let rd = std::fs::read_dir(&analysis)
                .map_err(|e| IpcError::io("clearing the scan cache", &e))?;
            for entry in rd.flatten() {
                let p = entry.path();
                result.freed_bytes += file_len(&p);
                if let Some(n) = fe::cache::entry_count(&p) {
                    result.removed_entries = result
                        .removed_entries
                        .saturating_add(u32::try_from(n).unwrap_or(u32::MAX));
                }
            }
            result.freed_bytes += dir_size(&thumbs);
            for dir in [analysis, thumbs] {
                std::fs::remove_dir_all(&dir)
                    .map_err(|e| IpcError::io("clearing the scan cache", &e))?;
                std::fs::create_dir_all(&dir)
                    .map_err(|e| IpcError::io("clearing the scan cache", &e))?;
            }
        }
    }
    {
        let mut s = core.session.write();
        let walked = s.library.walked;
        for e in &mut s.library.entries[..walked] {
            e.analysis = None;
        }
        s.rematch();
        if s.p
            .last_scan
            .as_ref()
            .is_some_and(|l| Some(l.folder.as_str()) == s.p.folder.as_deref())
        {
            s.p.last_scan = None;
        }
    }
    core.mark_dirty();
    Ok(result)
}

#[tauri::command]
pub async fn pick_source_folder<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
) -> Result<Option<FolderInfo>, IpcError> {
    ensure_idle(&state)?;
    let Some(path) = dialogs::pick_folder(&app, "Choose the folder with your photos").await else {
        return Ok(None);
    };
    let core = Arc::clone(&state);
    // Granting resolves the path (file system): on the blocking pool.
    blocking(move || {
        core.grants.grant(Access::Read, &path);
        set_folder(&core, &path.to_string_lossy()).map(Some)
    })
    .await
}

#[tauri::command]
pub async fn set_source_folder(
    state: State<'_, AppState>,
    path: String,
) -> Result<FolderInfo, IpcError> {
    let core = Arc::clone(&state);
    blocking(move || set_folder(&core, &path)).await
}

#[tauri::command]
pub async fn clear_scan_cache(
    state: State<'_, AppState>,
    scope: CacheScope,
) -> Result<ClearCacheResult, IpcError> {
    let core = Arc::clone(&state);
    blocking(move || clear_cache(&core, scope)).await
}
