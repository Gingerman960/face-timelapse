//! The `preview` route (v1.7, ARCHITECTURE.md §6): a Review candidate's
//! aligned frame, rendered on demand exactly as align would place it — same
//! reference, crop, render fingerprint, backdrop and nudge — but from the
//! analysis landmarks as they are (no re-detection, so no models needed) and
//! straight at the preview size (a small decode). Nothing is written to the
//! frame store: the JPEG goes to `previews/`, a small LRU cache (hits touch
//! the file's mtime) bounded by [`PREVIEWS_HIGH`] / [`PREVIEWS_LOW`] off the
//! render path: by the startup prune and then every [`PRUNE_EVERY`].

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use face_engine as fe;
use face_engine::align::FrameRequest;

use super::{Plan, not_found};
use crate::error::{AppResult, from_engine};
use crate::ipc::Version;
use crate::jobs::align::item_for;
use crate::session::frames::frame_key;
use crate::session::{Session, derive, reference};
use crate::state::Core;

/// Above this many bytes, `previews/` is pruned (oldest first)…
pub const PREVIEWS_HIGH: u64 = 256 * 1024 * 1024;
/// …down to this many.
pub const PREVIEWS_LOW: u64 = 192 * 1024 * 1024;
/// How often the app's prune thread checks the bound after startup.
pub const PRUNE_EVERY: Duration = Duration::from_secs(5 * 60);

/// What a preview of one photo is made from.
struct Candidate {
    item: fe::frames::AlignItem,
    /// The frame key the photo would get now: the preview's version.
    key: Version,
    /// The frame size align would render.
    out: fe::geometry::Size,
    detection: fe::reference::ReferenceDetection,
}

/// `None` without a reference face or a matched face.
fn candidate(core: &Core, s: &Session, photo_id: &str) -> Option<Candidate> {
    let item = item_for(s, photo_id)?.ok()?;
    let (fingerprint, out) = core.render_key(s)?;
    let detection = s.p.reference.as_ref()?.detection.clone()?;
    let key = frame_key(
        &fingerprint,
        &item.photo_version,
        &derive::adjust_of(s, photo_id),
    );
    Some(Candidate {
        item,
        key,
        out,
        detection,
    })
}

/// `PhotoDetail.previewVersion`: the frame key the photo would get now
/// (render fingerprint, photo version, nudge); `None` without a reference
/// face or a matched face.
#[must_use]
pub fn version(core: &Core, s: &Session, photo_id: &str) -> Option<Version> {
    candidate(core, s, photo_id).map(|c| c.key)
}

/// Plans `preview/{id}?w=` (404 when there is no [`version`]).
///
/// # Errors
/// `notFound`.
pub fn plan(
    core: &Core,
    s: &Session,
    photo_id: &str,
    width: u32,
    requested: Option<&str>,
) -> AppResult<Plan> {
    let Candidate {
        item,
        key,
        out,
        detection,
    } = candidate(core, s, photo_id).ok_or_else(not_found)?;
    let target = reference::target(&detection, out.fit_within(width));
    let backdrop = crate::convert::render_settings(s.p.render).backdrop;
    Ok(Plan {
        lru: true,
        cache: core.paths.preview_file(photo_id, &key, width),
        current: requested == Some(key.as_str()),
        render: Box::new(move |core| {
            let frame = core.engine.render_preview(&FrameRequest {
                source: &item.source,
                face: &item.face,
                target: &target,
                backdrop,
                adjust: item.adjust,
                refine_landmarks: false,
            })?;
            fe::frames::preview_bytes(&frame.image, width).map_err(|e| from_engine(&e))
        }),
    })
}

/// Keeps `previews/` within its bound; returns the bytes freed.
pub fn prune(core: &Core) -> u64 {
    prune_dir(&core.paths.preview_dir(), PREVIEWS_HIGH, PREVIEWS_LOW)
}

/// Marks a preview as just used (its mtime is the LRU clock: access times are
/// updated lazily, if at all). A failure only makes it look older.
pub fn mark_used(path: &Path) {
    let _ = std::fs::File::options()
        .write(true)
        .open(path)
        .and_then(|f| f.set_modified(SystemTime::now()));
}

/// Deletes the least recently used files of `dir` (by mtime, see
/// [`mark_used`]) until it holds at most `low` bytes, but only when it holds
/// more than `high`. Names starting with `.` (the temporary files of renders
/// being written) are neither counted nor deleted. Returns bytes freed.
#[must_use]
pub fn prune_dir(dir: &Path, high: u64, low: u64) -> u64 {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut files: Vec<(SystemTime, u64, PathBuf)> = rd
        .flatten()
        .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
        .filter_map(|e| {
            let meta = e.metadata().ok().filter(std::fs::Metadata::is_file)?;
            Some((meta.modified().ok()?, meta.len(), e.path()))
        })
        .collect();
    let mut total: u64 = files.iter().map(|f| f.1).sum();
    if total <= high {
        return 0;
    }
    files.sort_by_key(|f| f.0);
    let mut freed = 0;
    for (_, len, path) in files {
        if total <= low {
            break;
        }
        if std::fs::remove_file(&path).is_ok() {
            total -= len;
            freed += len;
        }
    }
    freed
}
