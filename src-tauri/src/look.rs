//! Look (exposure / white-balance normalization, ARCHITECTURE.md §9.6)
//! plumbing: the reference frame and its face statistics, computed once per
//! render fingerprint and kept in the frame manifest. Masters are stored
//! without the look; it is applied on read (`face_engine::frames::load_master`).

use face_engine as fe;
use face_engine::color::FaceStats;
use face_engine::geometry::Size;
use face_engine::image::RgbImage;

use crate::convert;
use crate::error::{AppResult, from_engine};
use crate::ipc::{IpcError, Rect};
use crate::session::reference;
use crate::state::Core;

/// The reference crop of the rotated reference photo, resized to `size`
/// (onion-skin base; look statistics).
///
/// # Errors
/// Decode errors.
pub fn reference_frame(
    path: &std::path::Path,
    rotation_deg: f64,
    crop: Rect,
    size: Size,
) -> AppResult<RgbImage> {
    let rotated = fe::reference::rotated_image(path, rotation_deg).map_err(|e| from_engine(&e))?;
    fe::reference::crop_frame(&rotated, convert::rect(crop), size).map_err(|e| from_engine(&e))
}

/// Reference face statistics for the current fingerprint (computed once,
/// then cached in the frame manifest).
///
/// # Errors
/// `notReady` without a detected reference; decode errors; an empty face region.
pub fn reference_stats(core: &Core) -> AppResult<FaceStats> {
    let (r, out, fingerprint) = {
        let s = core.session.read();
        if let Some(stats) = s.frames.manifest.reference_stats {
            return Ok(stats);
        }
        let r =
            s.p.reference
                .clone()
                .ok_or_else(|| IpcError::not_ready(crate::error::msg::NO_REFERENCE))?;
        (r, s.frames.output_size, s.frames.fingerprint.clone())
    };
    let det = r
        .detection
        .as_ref()
        .ok_or_else(IpcError::no_face_in_reference)?;
    let img = reference_frame(std::path::Path::new(&r.path), r.rotation_deg, r.crop, out)?;
    let stats = fe::color::face_stats(&img, &reference::target(det, out).anchors)
        .ok_or_else(|| IpcError::internal("face region too small for look statistics"))?;
    let mut s = core.session.write();
    if s.frames.fingerprint == fingerprint {
        s.frames.set_reference_stats(stats);
    }
    Ok(stats)
}
