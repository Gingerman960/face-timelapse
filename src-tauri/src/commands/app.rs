//! `get_app_info`, `get_session`, `reset_session` (§7.2 #1–3).

use std::sync::Arc;

use tauri::{AppHandle, Runtime, State};

use super::blocking;
use crate::error::AppResult;
use crate::ipc::{AppInfo, IpcError, SessionSnapshot};
use crate::session::model::PersistedSession;
use crate::session::{Library, derive, reference};
use crate::state::{AppState, Core, work_threads};

/// Builds `AppInfo`.
#[must_use]
pub fn app_info(core: &Core) -> AppInfo {
    AppInfo {
        version: core.meta.version.clone(),
        platform: core.meta.platform,
        image_base_url: core.meta.image_base_url.clone(),
        models_ready: core.engine.models_ready(),
        models_error: core.models_error(),
        parallelism: u32::try_from(work_threads()).unwrap_or(1),
        data_dir: core.paths.data_dir.to_string_lossy().into_owned(),
        cache_dir: core.paths.cache_dir.to_string_lossy().into_owned(),
    }
}

/// Builds the full session snapshot.
#[must_use]
pub fn snapshot(core: &Core) -> SessionSnapshot {
    core.wait_restored();
    let s = core.session.read();
    let days = derive::days(&s);
    SessionSnapshot {
        reference: s.p.reference.as_ref().map(reference::to_state),
        folder: derive::folder_info(&s),
        scan: derive::scan_info(&s),
        counts: derive::counts(&s, &days),
        render: s.p.render,
        look: s.p.look,
        frames: derive::frames_info(&s, &days),
        image_export: s.p.image_export,
        video: s.p.video.clone(),
        active_job: core.jobs.active(),
        recents: s.p.recents.clone(),
    }
}

/// Clears reference, folder, decisions and settings; keeps recents and caches.
///
/// # Errors
/// `busy`.
pub fn reset(core: &Core) -> AppResult<SessionSnapshot> {
    {
        let _gate = core.begin_mutation()?;
        core.next_folder_seq();
        let mut s = core.session.write();
        let recents = std::mem::take(&mut s.p.recents);
        let outputs = std::mem::take(&mut s.p.outputs);
        s.p = PersistedSession {
            recents,
            outputs,
            ..PersistedSession::default()
        };
        s.library = Library::default();
        s.match_embedding = None;
        drop(s);
        core.sync_frames();
    }
    core.mark_dirty();
    Ok(snapshot(core))
}

/// Tells the UI that the session changed without a command of its own
/// (`SESSION_CHANGED_EVENT`, §7.4 v1.2): dev autoload, or the re-analysis of
/// a stale restored reference once the models load. Restore itself needs no
/// event: `get_session` waits for it.
pub fn notify_session_changed<R: Runtime>(app: &AppHandle<R>) {
    emit_app_event(app, crate::ipc::SESSION_CHANGED_EVENT);
}

/// The startup model load (§3 step 4): loads the models, records the outcome
/// for `AppInfo` (`modelsReady`, `modelsError`), then emits
/// `MODELS_CHANGED_EVENT` (§7.4 v1.6) — in that order, so a UI that subscribes
/// and then reads `get_app_info` never misses the outcome. True when ready.
pub fn load_models_and_notify<R: Runtime>(core: &Core, app: &AppHandle<R>) -> bool {
    let ready = core.load_models_recorded();
    emit_app_event(app, crate::ipc::MODELS_CHANGED_EVENT);
    ready
}

/// Emits a payload-less app event to every listener; a failure is logged.
pub(crate) fn emit_app_event<R: Runtime>(app: &AppHandle<R>, event: &str) {
    use tauri::Emitter;
    if let Err(e) = app.emit(event, ()) {
        log::warn!("{event} not emitted: {e}");
    }
}

#[tauri::command]
pub async fn get_app_info(state: State<'_, AppState>) -> Result<AppInfo, IpcError> {
    Ok(app_info(&state))
}

#[tauri::command]
pub async fn get_session(state: State<'_, AppState>) -> Result<SessionSnapshot, IpcError> {
    let core = Arc::clone(&state);
    let snap = blocking(move || Ok(snapshot(&core))).await;
    crate::startup::mark_once("first get_session served");
    snap
}

#[tauri::command]
pub async fn reset_session(state: State<'_, AppState>) -> Result<SessionSnapshot, IpcError> {
    let core = Arc::clone(&state);
    blocking(move || reset(&core)).await
}
