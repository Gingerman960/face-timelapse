//! Reference photo commands (§7.2 #4–7).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use face_engine as fe;
use tauri::{AppHandle, Runtime, State};

use super::{blocking, dialogs, ensure_idle};
use crate::error::AppResult;
use crate::grants::Access;
use crate::ipc::{AspectPreset, IpcError, Rect, ReferenceState};
use crate::session::model::{PersistedReference, push_recent};
use crate::session::reference::{self, default_crop, validate_crop, validate_rotation};
use crate::state::{AppState, Core};

/// Which crop [`store_reference`] stores.
#[derive(Debug, Clone, Copy)]
enum CropChoice {
    /// The default crop for the aspect (a new photo).
    Default,
    /// This crop, validated against the image.
    Exact(Rect),
    /// The crop the photo had at another rotation (on a canvas of `size`),
    /// carried over so the same part of the photo stays framed (§7.2 #6).
    Carried {
        crop: Rect,
        size: fe::geometry::Size,
        rotation_deg: f64,
    },
}

/// What a stored reference analysis was made with: the engine's models and
/// settings plus the reference algorithm's version, so a change to either
/// re-analyzes a restored reference.
fn analysis_tag(core: &Core) -> String {
    format!(
        "{}+reference-v{}",
        core.engine_fingerprint(),
        fe::reference::REFERENCE_VERSION
    )
}

/// Analyzes `path` at `rotation` and stores it as the reference.
fn store_reference(
    core: &Core,
    path: &Path,
    rotation_deg: f64,
    crop: CropChoice,
    aspect: AspectPreset,
) -> AppResult<ReferenceState> {
    let (size, mtime) =
        fe::walk::file_stamp(path).map_err(|e| IpcError::io("reading the reference photo", &e))?;
    let image = core.engine.reference(path, rotation_deg)?;
    let crop = match crop {
        CropChoice::Default => default_crop(image.size, aspect),
        CropChoice::Exact(c) => validate_crop(&c, image.size, aspect)?,
        CropChoice::Carried {
            crop,
            size,
            rotation_deg: from,
        } => {
            let moved = fe::reference::rotate_crop(
                crate::convert::rect(crop),
                (size, from),
                (image.size, rotation_deg),
                crate::convert::aspect(aspect),
            );
            validate_crop(&crate::convert::ipc_rect(moved), image.size, aspect)
                .unwrap_or_else(|_| default_crop(image.size, aspect))
        }
    };
    // Whole pixels: the stored crop is exactly the one frames render with,
    // and still valid (a later refresh re-validates it).
    let snapped = crate::convert::ipc_rect(fe::reference::snap_crop(
        crate::convert::rect(crop),
        image.size,
        crate::convert::aspect(aspect),
    ));
    let crop = validate_crop(&snapped, image.size, aspect)?;
    let detection = core
        .engine
        .reference_crop(path, rotation_deg, crate::convert::rect(crop))?;
    let path_str = path.to_string_lossy().into_owned();
    let mut r = PersistedReference {
        path: path_str.clone(),
        rotation_deg,
        crop,
        aspect,
        file_version: fe::walk::photo_version(size, mtime),
        engine: analysis_tag(core),
        image,
        detection,
        match_embedding: None,
    };
    let state = reference::to_state(&r);
    {
        let mut s = core.session.write();
        let same_photo =
            s.p.reference
                .as_ref()
                .is_some_and(|old| old.path == path_str);
        // Keep matching stable while the user drags the crop off the face —
        // persisted, so a restart matches the same way (M5).
        if r.detection.is_none() && same_photo {
            r.match_embedding.clone_from(&s.match_embedding);
        }
        s.match_embedding = reference::match_embedding(&r);
        push_recent(&mut s.p.recents.references, &path_str);
        s.p.reference = Some(r);
        s.rematch();
    }
    core.sync_frames();
    core.mark_dirty();
    Ok(state)
}

/// `set_reference_photo`.
///
/// # Errors
/// busy, notFound, unsupportedFormat, decodeFailed, modelUnavailable.
pub fn set_photo(core: &Core, path: &str) -> AppResult<ReferenceState> {
    let canonical = core.granted(path, Access::Read)?;
    if !canonical.is_file() {
        return Err(IpcError::invalid("Choose a photo file, not a folder."));
    }
    crate::engine::check_photo_path(&canonical)?;
    let _gate = core.begin_mutation()?;
    let aspect = core
        .session
        .read()
        .p
        .reference
        .as_ref()
        .map_or(AspectPreset::Free, |r| r.aspect);
    store_reference(core, &canonical, 0.0, CropChoice::Default, aspect)
}

fn current(core: &Core) -> AppResult<PersistedReference> {
    core.session
        .read()
        .p
        .reference
        .clone()
        .ok_or_else(|| IpcError::not_ready(crate::error::msg::NO_REFERENCE))
}

/// `set_reference_rotation`. The crop follows the photo: it keeps framing
/// the same part of it (nudged inside, or shrunk, only when the new canvas
/// requires), never re-centred.
///
/// # Errors
/// busy, notReady, invalidArgument.
pub fn set_rotation(core: &Core, rotation_deg: f64) -> AppResult<ReferenceState> {
    let rotation_deg = validate_rotation(rotation_deg)?;
    let _gate = core.begin_mutation()?;
    let r = current(core)?;
    let carried = CropChoice::Carried {
        crop: r.crop,
        size: r.image.size,
        rotation_deg: r.rotation_deg,
    };
    store_reference(core, Path::new(&r.path), rotation_deg, carried, r.aspect)
}

/// `set_reference_crop`; re-matches the library in memory.
///
/// # Errors
/// busy, notReady, invalidArgument.
pub fn set_crop(core: &Core, crop: Rect, aspect: AspectPreset) -> AppResult<ReferenceState> {
    let _gate = core.begin_mutation()?;
    let r = current(core)?;
    let crop = validate_crop(&crop, r.image.size, aspect)?;
    store_reference(
        core,
        Path::new(&r.path),
        r.rotation_deg,
        CropChoice::Exact(crop),
        aspect,
    )
}

/// What [`try_refresh`] did.
#[derive(Debug, PartialEq, Eq)]
enum Refresh {
    Unchanged,
    Refreshed,
    /// A job or another change held the gate; try again later.
    Busy,
}

fn try_refresh(core: &Core) -> Refresh {
    let Some(r) = core.session.read().p.reference.clone() else {
        return Refresh::Unchanged;
    };
    let path = PathBuf::from(&r.path);
    let Ok((size, mtime)) = fe::walk::file_stamp(&path) else {
        log::warn!("reference photo is gone; keeping the cached analysis");
        return Refresh::Unchanged;
    };
    if r.file_version == fe::walk::photo_version(size, mtime) && r.engine == analysis_tag(core) {
        return Refresh::Unchanged;
    }
    let Ok(_gate) = core.begin_mutation() else {
        return Refresh::Busy;
    };
    if core.session.read().p.reference.as_ref() != Some(&r) {
        return Refresh::Unchanged; // the user changed it meanwhile
    }
    let exact = CropChoice::Exact(r.crop);
    let result = store_reference(core, &path, r.rotation_deg, exact, r.aspect)
        .or_else(|_| store_reference(core, &path, r.rotation_deg, CropChoice::Default, r.aspect));
    match result {
        Ok(_) => Refresh::Refreshed,
        Err(e) => {
            log::warn!("could not refresh the reference: {}", e.message);
            Refresh::Unchanged
        }
    }
}

/// Re-analyzes a restored reference whose file or engine changed (after
/// models load); true when the session changed. Gives up if busy.
pub fn refresh_if_stale(core: &Core) -> bool {
    try_refresh(core) == Refresh::Refreshed
}

/// [`refresh_if_stale`] for the startup models thread: while a job (or
/// another change) is in the way, waits for it to end and tries again.
pub fn refresh_when_idle(core: &Core) -> bool {
    loop {
        match try_refresh(core) {
            Refresh::Busy => {
                core.jobs.wait_idle(std::time::Duration::from_secs(3600));
            }
            done => return done == Refresh::Refreshed,
        }
    }
}

#[tauri::command]
pub async fn pick_reference_photo<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
) -> Result<Option<ReferenceState>, IpcError> {
    ensure_idle(&state)?;
    let Some(path) = dialogs::pick_photo(&app, "Choose a reference photo").await else {
        return Ok(None);
    };
    let core = Arc::clone(&state);
    // Granting resolves the path (file system): on the blocking pool.
    blocking(move || {
        core.grants.grant(Access::Read, &path);
        set_photo(&core, &path.to_string_lossy()).map(Some)
    })
    .await
}

#[tauri::command]
pub async fn set_reference_photo(
    state: State<'_, AppState>,
    path: String,
) -> Result<ReferenceState, IpcError> {
    let core = Arc::clone(&state);
    blocking(move || set_photo(&core, &path)).await
}

#[tauri::command]
pub async fn set_reference_rotation(
    state: State<'_, AppState>,
    rotation_deg: f64,
) -> Result<ReferenceState, IpcError> {
    let core = Arc::clone(&state);
    blocking(move || set_rotation(&core, rotation_deg)).await
}

#[tauri::command]
pub async fn set_reference_crop(
    state: State<'_, AppState>,
    crop: Rect,
    aspect: AspectPreset,
) -> Result<ReferenceState, IpcError> {
    let core = Arc::clone(&state);
    blocking(move || set_crop(&core, crop, aspect)).await
}
