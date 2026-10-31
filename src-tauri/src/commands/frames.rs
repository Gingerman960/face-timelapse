//! Align and frame commands (§7.2 #21–24).

use std::sync::Arc;

use tauri::State;
use tauri::ipc::Channel;

use super::blocking;
use crate::convert;
use crate::error::AppResult;
use crate::ipc::{
    AlignEvent, FrameAdjust, FrameSummary, FramesView, IpcError, JobId, LookSettings,
    NormalizeMode, PhotoId, RenderSettings,
};
use crate::jobs::{self, align};
use crate::session::{derive, frames};
use crate::state::{AppState, Core};

/// Computes the reference look statistics when the look is on and frames
/// exist, so `lookDelta` can be filled (errors only mean `lookDelta = null`).
fn ensure_look_stats(core: &Core) {
    let needed = {
        let s = core.session.read();
        s.p.look.normalize != NormalizeMode::Off
            && s.frames.manifest.reference_stats.is_none()
            && !s.frames.manifest.is_empty()
    };
    // On the protocol's pool: the rotate/crop has nested parallel work that
    // would otherwise queue behind a running job on the global pool.
    if needed && let Err(e) = core.protocol.install(|| crate::look::reference_stats(core)) {
        log::warn!("reference look statistics unavailable: {}", e.message);
    }
}

/// `get_frames`.
#[must_use]
pub fn view(core: &Core) -> FramesView {
    core.wait_restored();
    ensure_look_stats(core);
    let s = core.session.read();
    let days = derive::days(&s);
    derive::frames_view(&s, &days)
}

/// `set_frame_adjustment`: stores the nudge and re-renders that frame now.
///
/// # Errors
/// busy, notFound, invalidArgument; render errors.
pub fn adjust(core: &Core, photo_id: &str, adjust: FrameAdjust) -> AppResult<FrameSummary> {
    frames::validate_adjust(&adjust)?;
    let _gate = core.begin_mutation()?;
    let (spec, store, item) = {
        let s = core.session.read();
        let mut item =
            align::item_for(&s, photo_id).ok_or_else(|| IpcError::unknown("photo"))??;
        item.adjust = convert::adjust(adjust);
        let (spec, store) = align::spec(core, &s)?;
        (spec, store, item)
    };
    core.require_models()?;
    let entry = align::render_one(core, &item, &spec, &store)?;
    ensure_look_stats(core);
    let summary = {
        let mut s = core.session.write();
        if let Some(d) = s.decisions_mut() {
            if frames::is_identity(&adjust) {
                d.adjusts.remove(photo_id);
            } else {
                d.adjusts.insert(photo_id.to_owned(), adjust);
            }
        }
        let version = frames::frame_version(&entry.frame_key, &s.p.look);
        let residual_px = entry.residual_px;
        let look_delta = frames::frame_look(&s, &entry)
            .and_then(|l| l.delta())
            .map(convert::ipc_look_delta);
        if s.frames.fingerprint == spec.fingerprint {
            s.frames.insert(entry);
        }
        let e = s
            .library
            .get(photo_id)
            .ok_or_else(|| IpcError::unknown("photo"))?;
        let photo = derive::photo_summary(&s, e);
        FrameSummary {
            photo_id: photo_id.to_owned(),
            day_key: photo.day_key,
            taken_at: photo.taken_at,
            time_known: photo.time_known,
            version,
            residual_px,
            adjust,
            look_delta,
        }
    };
    core.save_frames();
    core.mark_dirty();
    Ok(summary)
}

/// `set_look`.
///
/// # Errors
/// busy, invalidArgument.
pub fn look(core: &Core, look: LookSettings) -> AppResult<FramesView> {
    if !look.strength.is_finite() || !(0.0..=1.0).contains(&look.strength) {
        return Err(IpcError::invalid("Strength must be between 0 and 1."));
    }
    {
        let _gate = core.begin_mutation()?;
        core.session.write().p.look = look;
    }
    core.mark_dirty();
    Ok(view(core))
}

#[tauri::command]
pub async fn start_align(
    state: State<'_, AppState>,
    render: RenderSettings,
    on_event: Channel<AlignEvent>,
) -> Result<JobId, IpcError> {
    let core = Arc::clone(&state);
    blocking(move || jobs::align::start(&core, render, Arc::new(on_event))).await
}

#[tauri::command]
pub async fn get_frames(state: State<'_, AppState>) -> Result<FramesView, IpcError> {
    let core = Arc::clone(&state);
    blocking(move || Ok(view(&core))).await
}

#[tauri::command]
pub async fn set_frame_adjustment(
    state: State<'_, AppState>,
    photo_id: PhotoId,
    adjust: FrameAdjust,
) -> Result<FrameSummary, IpcError> {
    let core = Arc::clone(&state);
    blocking(move || self::adjust(&core, &photo_id, adjust)).await
}

#[tauri::command]
pub async fn set_look(
    state: State<'_, AppState>,
    look: LookSettings,
) -> Result<FramesView, IpcError> {
    let core = Arc::clone(&state);
    blocking(move || self::look(&core, look)).await
}
