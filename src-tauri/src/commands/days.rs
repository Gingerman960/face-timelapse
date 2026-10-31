//! Day commands (§7.2 #16–20).

use std::sync::Arc;

use face_engine as fe;
use face_engine::analysis::{Outcome, PhotoAnalysis};
use tauri::{AppHandle, Runtime, State};

use super::{blocking, dialogs, ensure_idle};
use crate::error::{AppResult, msg};
use crate::grants::Access;
use crate::ipc::{DayGroup, DayKey, DaysPatch, ErrorKind, IpcError, PhotoId, ReviewDecision};
use crate::session::model::ManualPhoto;
use crate::session::{Session, derive};
use crate::state::{AppState, Core};

/// `YYYY-MM-DD` that is a real calendar date.
#[must_use]
pub fn is_day_key(s: &str) -> bool {
    crate::convert::day(s).is_some()
}

/// `get_days`.
///
/// # Errors
/// notReady without a folder.
pub fn days(core: &Core) -> AppResult<Vec<DayGroup>> {
    core.wait_restored();
    let s = core.session.read();
    if s.library.folder.is_none() {
        return Err(IpcError::not_ready(msg::NO_FOLDER));
    }
    Ok(derive::days(&s))
}

fn find_day(days: Vec<DayGroup>, key: &str) -> AppResult<DayGroup> {
    days.into_iter()
        .find(|d| d.day_key == key)
        .ok_or_else(|| IpcError::unknown("day"))
}

/// Runs a decision mutation and returns the before/after day patch.
fn mutate_days(
    core: &Core,
    f: impl FnOnce(&mut Session) -> AppResult<()>,
) -> AppResult<(DaysPatch, Vec<DayGroup>)> {
    let _gate = core.begin_mutation()?;
    let out = {
        let mut s = core.session.write();
        if s.library.folder.is_none() {
            return Err(IpcError::not_ready(msg::NO_FOLDER));
        }
        let before = derive::day_groups(&s);
        f(&mut s)?;
        let after = derive::day_groups(&s);
        (
            derive::diff_days(&before, &after),
            after
                .into_iter()
                .map(crate::convert::ipc_day_group)
                .collect(),
        )
    };
    core.mark_dirty();
    Ok(out)
}

/// `select_day_photo`.
///
/// # Errors
/// busy, notFound, invalidArgument (photo not in day).
pub fn select(core: &Core, day_key: &str, photo_id: &str) -> AppResult<DayGroup> {
    let (_, after) = mutate_days(core, |s| {
        let day = find_day(derive::days(s), day_key)?;
        if !day.photo_ids.iter().any(|p| p == photo_id) {
            return Err(IpcError::invalid("That photo isn't part of this day."));
        }
        if let Some(d) = s.decisions_mut() {
            d.day_selections
                .insert(day_key.to_owned(), photo_id.to_owned());
        }
        Ok(())
    })?;
    find_day(after, day_key)
}

/// `move_photo_to_day` (moving back to the capture day removes the move).
///
/// # Errors
/// busy, notFound, invalidArgument (bad dayKey).
pub fn move_photo(core: &Core, photo_id: &str, day_key: &str) -> AppResult<DaysPatch> {
    if !is_day_key(day_key) {
        return Err(IpcError::invalid("That isn't a valid day."));
    }
    let (patch, _) = mutate_days(core, |s| {
        let e = s
            .library
            .get(photo_id)
            .filter(|e| e.is_analyzed())
            .ok_or_else(|| IpcError::unknown("photo"))?;
        let natural = e.manual_day.clone().or_else(|| {
            e.analysis
                .as_ref()
                .map(|a| crate::convert::day_key(a.taken_at.date()))
        });
        let d = s
            .decisions_mut()
            .ok_or_else(|| IpcError::not_ready(msg::NO_FOLDER))?;
        if natural.as_deref() == Some(day_key) {
            d.day_moves.remove(photo_id);
        } else {
            d.day_moves.insert(photo_id.to_owned(), day_key.to_owned());
        }
        Ok(())
    })?;
    Ok(patch)
}

/// `set_day_excluded`.
///
/// # Errors
/// busy, notFound.
pub fn set_excluded(core: &Core, day_key: &str, excluded: bool) -> AppResult<DayGroup> {
    let (_, after) = mutate_days(core, |s| {
        find_day(derive::days(s), day_key)?;
        let d = s
            .decisions_mut()
            .ok_or_else(|| IpcError::not_ready(msg::NO_FOLDER))?;
        if excluded {
            d.excluded_days.insert(day_key.to_owned());
        } else {
            d.excluded_days.remove(day_key);
        }
        Ok(())
    })?;
    find_day(after, day_key)
}

/// `add_photo_to_day` with a concrete path. A photo of the folder becomes a
/// confirmed move (analyzed first if the scan has not reached it yet — the
/// analysis is kept like a scan's); a photo outside the folder is analyzed
/// and added by hand. Either way it must contain a face.
///
/// # Errors
/// busy, notFound, permissionDenied, unsupportedFormat, decodeFailed,
/// noFaceDetected, invalidArgument, cancelled (the folder changed meanwhile).
pub fn add_photo(core: &Core, day_key: &str, path: &str) -> AppResult<DaysPatch> {
    if !is_day_key(day_key) {
        return Err(IpcError::invalid("That isn't a valid day."));
    }
    let canonical = core.granted(path, Access::Read)?;
    crate::engine::check_photo_path(&canonical)?;
    ensure_idle(core)?;
    let _slot = core.begin_add_analysis()?;
    let _awake = crate::jobs::keep_awake::KeepAwake::begin("FaceTimelapse is reading a photo");
    let id: PhotoId = fe::walk::photo_id(&canonical);
    let (folder, known) = {
        let s = core.session.read();
        let known = s.library.get(&id).map(|e| {
            let manual = s
                .library
                .index
                .get(&id)
                .is_some_and(|&i| i >= s.library.walked);
            (e.analysis.clone(), manual)
        });
        (s.library.folder.clone(), known)
    };
    let manual = match known {
        // A photo of the folder: move it (analyze it now if needed).
        Some((analysis, false)) => {
            let analysis = match analysis {
                Some(a) => a,
                None => analyze_folder_photo(core, &id, &canonical, folder.as_deref())?,
            };
            require_face(&analysis, &canonical)?;
            None
        }
        // Outside photo, new or already added by hand (to another day).
        _ => Some(analyze_outside_photo(core, day_key, &canonical)?),
    };
    let (patch, _) = mutate_days(core, move |s| {
        // Under the gate: the analysis ran without it, so the folder may
        // have changed meanwhile — never record into another folder.
        if s.library.folder != folder {
            return Err(IpcError::new(
                ErrorKind::Cancelled,
                "The folder changed while the photo was being read. Add it again.",
            ));
        }
        if manual.is_none() && s.library.get(&id).is_none() {
            return Err(IpcError::unknown("photo"));
        }
        let d = s
            .decisions_mut()
            .ok_or_else(|| IpcError::not_ready(msg::NO_FOLDER))?;
        match manual {
            Some(m) => {
                d.manual_photos.retain(|x| x.path != m.path);
                d.manual_photos.push(m);
            }
            None => {
                d.reviews.insert(id.clone(), ReviewDecision::Confirmed);
                d.day_moves.insert(id.clone(), day_key.to_owned());
            }
        }
        s.sync_manual();
        Ok(())
    })?;
    Ok(patch)
}

/// `noFaceDetected` unless the analysis found a face.
fn require_face(analysis: &PhotoAnalysis, path: &std::path::Path) -> AppResult<()> {
    match &analysis.outcome {
        Outcome::Faces { .. } => Ok(()),
        Outcome::NoFace | Outcome::Failed { .. } => Err(IpcError::new(
            ErrorKind::NoFaceDetected,
            format!(
                "No face found in {}, so it can't be added to this day.",
                file_name(path)
            ),
        )),
    }
}

/// Analyzes `path` like the scan does (thumbnail written to the cache).
fn analyze(core: &Core, path: &std::path::Path) -> AppResult<(PhotoAnalysis, u64, i64)> {
    let (size, mtime_ns) =
        fe::walk::file_stamp(path).map_err(|e| IpcError::io("reading the photo", &e))?;
    let analyzed =
        core.engine
            .analyzer()?
            .analyze(path, mtime_ns, Some(crate::jobs::scan::SCAN_THUMB));
    if let Some(jpeg) = &analyzed.thumbnail {
        let thumb = fe::thumbs::path(
            &core.paths.cache_dir,
            &fe::walk::photo_id(path),
            &fe::walk::photo_version(size, mtime_ns),
            crate::jobs::scan::SCAN_THUMB,
        );
        if let Err(e) = fe::cache::write_atomic_cache(&thumb, jpeg) {
            log::warn!("thumbnail write failed: {e}");
        }
    }
    Ok((analyzed.analysis, size, mtime_ns))
}

/// Analyzes a walked folder photo the scan has not reached, stores the
/// result in the library and the folder's analysis cache, and returns it.
fn analyze_folder_photo(
    core: &Core,
    id: &str,
    path: &std::path::Path,
    folder: Option<&std::path::Path>,
) -> AppResult<Arc<PhotoAnalysis>> {
    let (analysis, size, mtime_ns) = analyze(core, path)?;
    let analysis = Arc::new(analysis);
    let stored = {
        let mut s = core.session.write();
        // A job that started meanwhile owns the library (and its cache);
        // a different folder is not ours to touch.
        if core.jobs.active().is_some() || s.library.folder.as_deref() != folder {
            return Ok(analysis);
        }
        let folder = s.library.folder.clone();
        let entry = s.library.index.get(id).copied().and_then(|i| {
            let e = &mut s.library.entries[i];
            (e.size == size && e.mtime_ns == mtime_ns).then(|| {
                e.analysis = Some(Arc::clone(&analysis));
                fe::walk::FileEntry {
                    path: e.path.clone(),
                    rel_path: e.rel_path.clone(),
                    size,
                    mtime_ns,
                }
            })
        });
        s.rematch();
        folder.zip(entry)
    };
    if let Some((folder, entry)) = stored
        && analysis.is_cacheable()
    {
        let (mut cache, _) = fe::cache::AnalysisCache::load(
            &core.paths.cache_dir,
            &folder,
            &core.engine_fingerprint(),
        );
        cache.insert(&entry, (*analysis).clone());
        if let Err(e) = cache.save() {
            log::warn!("analysis cache not saved: {e}");
        }
    }
    Ok(analysis)
}

/// Analyzes a photo from outside the folder for a hand-added entry.
fn analyze_outside_photo(
    core: &Core,
    day_key: &str,
    path: &std::path::Path,
) -> AppResult<ManualPhoto> {
    let (analysis, size, mtime_ns) = analyze(core, path)?;
    if let Outcome::Failed { kind, message } = &analysis.outcome {
        log::warn!("could not analyze an added photo: {message}");
        return Err(IpcError::new(
            crate::convert::failure_kind(*kind),
            format!("Couldn't read {}.", file_name(path)),
        ));
    }
    require_face(&analysis, path)?;
    Ok(ManualPhoto {
        path: path.to_string_lossy().into_owned(),
        day_key: day_key.to_owned(),
        size,
        mtime_ns,
        analysis,
    })
}

fn file_name(p: &std::path::Path) -> String {
    p.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

#[tauri::command]
pub async fn get_days(state: State<'_, AppState>) -> Result<Vec<DayGroup>, IpcError> {
    let core = Arc::clone(&state);
    blocking(move || days(&core)).await
}

#[tauri::command]
pub async fn select_day_photo(
    state: State<'_, AppState>,
    day_key: DayKey,
    photo_id: PhotoId,
) -> Result<DayGroup, IpcError> {
    let core = Arc::clone(&state);
    blocking(move || select(&core, &day_key, &photo_id)).await
}

#[tauri::command]
pub async fn move_photo_to_day(
    state: State<'_, AppState>,
    photo_id: PhotoId,
    day_key: DayKey,
) -> Result<DaysPatch, IpcError> {
    let core = Arc::clone(&state);
    blocking(move || move_photo(&core, &photo_id, &day_key)).await
}

#[tauri::command]
pub async fn add_photo_to_day<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    day_key: DayKey,
    path: Option<String>,
) -> Result<Option<DaysPatch>, IpcError> {
    let (path, picked) = match path {
        Some(p) => (p, None),
        None => {
            ensure_idle(&state)?;
            match dialogs::pick_photo(&app, "Add a photo to this day").await {
                Some(p) => (p.to_string_lossy().into_owned(), Some(p)),
                None => return Ok(None),
            }
        }
    };
    let core = Arc::clone(&state);
    // Granting resolves the path (file system): on the blocking pool.
    blocking(move || {
        if let Some(p) = &picked {
            core.grants.grant(crate::grants::Access::Read, p);
        }
        add_photo(&core, &day_key, &path).map(Some)
    })
    .await
}

#[tauri::command]
pub async fn set_day_excluded(
    state: State<'_, AppState>,
    day_key: DayKey,
    excluded: bool,
) -> Result<DayGroup, IpcError> {
    let core = Arc::clone(&state);
    blocking(move || set_excluded(&core, &day_key, excluded)).await
}
