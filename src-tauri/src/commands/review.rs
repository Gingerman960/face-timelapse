//! Scan, cancel and photo commands (§7.2 #11–15).

use std::sync::Arc;

use tauri::State;
use tauri::ipc::Channel;

use super::blocking;
use crate::error::{AppResult, msg};
use crate::ipc::{
    IpcError, JobId, LibraryCounts, PhotoDetail, PhotoId, PhotoQuery, PhotoSummary, ReviewDecision,
    ScanEvent,
};
use crate::jobs;
use crate::session::derive;
use crate::state::{AppState, Core};

/// `get_photos`: analyzed photos in relPath order (then manual adds).
///
/// # Errors
/// notReady without a folder.
pub fn photos(core: &Core, query: &PhotoQuery) -> AppResult<Vec<PhotoSummary>> {
    core.wait_restored();
    let s = core.session.read();
    if s.library.folder.is_none() {
        return Err(IpcError::not_ready(msg::NO_FOLDER));
    }
    Ok(s.library
        .entries
        .iter()
        .filter(|e| e.is_analyzed())
        .filter(|e| {
            query
                .statuses
                .as_ref()
                .is_none_or(|st| st.contains(&e.matching.status))
        })
        .map(|e| derive::photo_summary(&s, e))
        .collect())
}

/// `get_photo`.
///
/// # Errors
/// notFound.
pub fn photo(core: &Core, id: &str) -> AppResult<PhotoDetail> {
    core.wait_restored();
    let s = core.session.read();
    let e = s
        .library
        .get(id)
        .filter(|e| e.is_analyzed())
        .ok_or_else(|| IpcError::unknown("photo"))?;
    let faces = e
        .analysis
        .as_ref()
        .map(|a| {
            a.faces()
                .iter()
                .map(|f| crate::convert::face_geometry(f.bounds, &f.landmarks, f64::from(f.score)))
                .collect()
        })
        .unwrap_or_default();
    Ok(PhotoDetail {
        summary: derive::photo_summary(&s, e),
        path: e.path.to_string_lossy().into_owned(),
        faces,
        matched_face: e.matching.matched_face,
        raw_similarity: e.matching.cosine,
        preview_version: crate::protocol::preview::version(core, &s, id),
    })
}

/// `set_review_decision` (`pending` undoes).
///
/// # Errors
/// busy, notFound (any unknown id; nothing is changed then).
pub fn review(core: &Core, ids: &[PhotoId], decision: ReviewDecision) -> AppResult<LibraryCounts> {
    let _gate = core.begin_mutation()?;
    let counts = {
        let mut s = core.session.write();
        if ids
            .iter()
            .any(|id| s.library.get(id).is_none_or(|e| !e.is_analyzed()))
        {
            return Err(IpcError::unknown("photo"));
        }
        let faceless = ids.iter().filter_map(|id| s.library.get(id)).any(|e| {
            matches!(
                e.matching.status,
                crate::ipc::MatchStatus::NoFace | crate::ipc::MatchStatus::Failed
            )
        });
        if decision == ReviewDecision::Confirmed && faceless {
            return Err(IpcError::invalid(
                "Photos without a detected face can't be confirmed.",
            ));
        }
        let d = s
            .decisions_mut()
            .ok_or_else(|| IpcError::not_ready(msg::NO_FOLDER))?;
        for id in ids {
            if decision == ReviewDecision::Pending {
                d.reviews.remove(id);
            } else {
                d.reviews.insert(id.clone(), decision);
            }
        }
        let days = derive::days(&s);
        derive::counts(&s, &days)
    };
    core.mark_dirty();
    Ok(counts)
}

#[tauri::command]
pub async fn start_scan(
    state: State<'_, AppState>,
    on_event: Channel<ScanEvent>,
) -> Result<JobId, IpcError> {
    let core = Arc::clone(&state);
    blocking(move || jobs::scan::start(&core, Arc::new(on_event))).await
}

#[tauri::command]
pub async fn cancel_job(state: State<'_, AppState>, job_id: JobId) -> Result<(), IpcError> {
    state.jobs.cancel(&job_id);
    Ok(())
}

#[tauri::command]
pub async fn get_photos(
    state: State<'_, AppState>,
    query: PhotoQuery,
) -> Result<Vec<PhotoSummary>, IpcError> {
    let core = Arc::clone(&state);
    blocking(move || photos(&core, &query)).await
}

#[tauri::command]
pub async fn get_photo(
    state: State<'_, AppState>,
    photo_id: PhotoId,
) -> Result<PhotoDetail, IpcError> {
    let core = Arc::clone(&state);
    blocking(move || photo(&core, &photo_id)).await
}

#[tauri::command]
pub async fn set_review_decision(
    state: State<'_, AppState>,
    photo_ids: Vec<PhotoId>,
    decision: ReviewDecision,
) -> Result<LibraryCounts, IpcError> {
    let core = Arc::clone(&state);
    blocking(move || review(&core, &photo_ids, decision)).await
}
