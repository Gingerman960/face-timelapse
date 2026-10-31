//! Pure derivations from [`Session`]: photo summaries, day groups (§9.4, via
//! `face_engine::days`), counts, folder/scan/frames info. Recomputed on
//! demand (≈1 ms for 3,600 photos).

use face_engine::days::{DayCandidate, DayDecisions, group_days};
use face_engine::geometry::Size;

use super::frames::{self as session_frames, frame_key, frame_version};
use super::reference;
use super::{PhotoEntry, Session, count_u32};
use crate::convert;
use crate::ipc::{
    DateSource, DayGroup, DaysPatch, FolderInfo, FrameSummary, FramesInfo, FramesStatus,
    FramesView, LibraryCounts, MatchStatus, PhotoSummary, ReviewDecision, ScanInfo, ScanStatus,
};

const LOCAL_FMT: &str = "%Y-%m-%dT%H:%M:%S";

/// Contract summary of an analyzed photo.
#[must_use]
pub fn photo_summary(s: &Session, e: &PhotoEntry) -> PhotoSummary {
    let analysis = e.analysis.as_deref();
    let manual = e.manual_day.is_some() || s.decisions().day_moves.contains_key(&e.id);
    let day_key = s.day_of(e);
    let taken_at = if e.manual_day.is_some() {
        format!("{day_key}T12:00:00")
    } else {
        analysis
            .map(|a| a.taken_at.format(LOCAL_FMT).to_string())
            .unwrap_or_default()
    };
    PhotoSummary {
        id: e.id.clone(),
        file_name: e.file_name.clone(),
        rel_path: e.rel_path.clone(),
        taken_at,
        date_source: if manual {
            DateSource::Manual
        } else {
            analysis.map_or(DateSource::FileTime, |a| {
                convert::ipc_date_source(a.date_source)
            })
        },
        // A day move keeps the photo's own time; a hand-added photo has none.
        time_known: e.manual_day.is_none()
            && analysis.is_some_and(|a| {
                face_engine::dates::time_known(a.date_source, a.taken_at, &e.file_name)
            }),
        day_key,
        score: e.matching.score,
        status: e.matching.status,
        review: if e.manual_day.is_some() {
            ReviewDecision::Confirmed
        } else {
            s.review(&e.id)
        },
        included: s.is_included(e),
        size: convert::ipc_size(analysis.map_or(Size::default(), |a| a.oriented_size)),
        version: e.version.clone(),
        face_box: face_box(e),
    }
}

/// Matched-face bounds (largest face without a reference); `None` for noFace/failed.
#[must_use]
pub fn face_box(e: &PhotoEntry) -> Option<crate::ipc::Rect> {
    e.matched_face().map(|f| convert::ipc_rect(f.bounds))
}

/// The folder's decisions as the engine's day decisions (invalid keys skipped).
fn day_decisions(s: &Session) -> DayDecisions {
    let d = s.decisions();
    DayDecisions {
        moves: d
            .day_moves
            .iter()
            .filter_map(|(id, k)| Some((id.clone(), convert::day(k)?)))
            .collect(),
        selections: d
            .day_selections
            .iter()
            .filter_map(|(k, id)| Some((convert::day(k)?, id.clone())))
            .collect(),
        excluded: d
            .excluded_days
            .iter()
            .filter_map(|k| convert::day(k))
            .collect(),
    }
}

/// Day groups of the included photos (engine form, day ascending). A manual
/// add counts at noon of its day.
#[must_use]
pub fn day_groups(s: &Session) -> Vec<face_engine::days::DayGroup> {
    let candidates: Vec<DayCandidate> = s
        .library
        .entries
        .iter()
        .filter(|e| s.is_included(e))
        .filter_map(|e| {
            let taken_at = match &e.manual_day {
                Some(k) => convert::day(k)?.and_hms_opt(12, 0, 0)?,
                None => e.analysis.as_ref()?.taken_at,
            };
            Some(DayCandidate {
                id: e.id.clone(),
                rel_path: e.rel_path.clone(),
                taken_at,
                score: e.matching.score,
            })
        })
        .collect();
    group_days(&candidates, &day_decisions(s))
}

/// All day groups, dayKey ascending.
#[must_use]
pub fn days(s: &Session) -> Vec<DayGroup> {
    day_groups(s)
        .into_iter()
        .map(convert::ipc_day_group)
        .collect()
}

/// Upserted/removed groups between two groupings.
#[must_use]
pub fn diff_days(
    before: &[face_engine::days::DayGroup],
    after: &[face_engine::days::DayGroup],
) -> DaysPatch {
    convert::ipc_days_patch(face_engine::days::diff(before, after))
}

/// Library counts (§7.3) given the current day groups.
#[must_use]
pub fn counts(s: &Session, days: &[DayGroup]) -> LibraryCounts {
    let mut c = LibraryCounts::default();
    for e in s.library.entries.iter().filter(|e| e.is_analyzed()) {
        c.total += 1;
        match e.matching.status {
            MatchStatus::Confirmed => c.confirmed += 1,
            MatchStatus::Uncertain => {
                c.uncertain += 1;
                if e.manual_day.is_none() && s.review(&e.id) == ReviewDecision::Pending {
                    c.review_pending += 1;
                }
            }
            MatchStatus::Rejected => c.rejected += 1,
            MatchStatus::NoFace => c.no_face += 1,
            MatchStatus::Failed => c.failed += 1,
        }
        if s.is_included(e) {
            c.included += 1;
        }
    }
    c.days = count_u32(days.len());
    c.active_days = count_u32(days.iter().filter(|d| !d.excluded).count());
    c
}

/// Folder info of the current library.
#[must_use]
pub fn folder_info(s: &Session) -> Option<FolderInfo> {
    let folder = s.library.folder.as_deref()?;
    Some(FolderInfo {
        path: folder.to_string_lossy().into_owned(),
        name: folder.file_name().map_or_else(
            || folder.to_string_lossy().into_owned(),
            |n| n.to_string_lossy().into_owned(),
        ),
        image_count: count_u32(s.library.walked),
        analyzed_count: s.library.analyzed_count(),
        unsupported_count: s.library.unsupported,
    })
}

/// Scan info for the current folder.
#[must_use]
pub fn scan_info(s: &Session) -> ScanInfo {
    match (&s.p.last_scan, s.folder_key()) {
        (Some(last), Some(folder)) if last.folder == folder => ScanInfo {
            status: last.status,
            last_summary: last.summary.clone(),
            scanned_at: Some(last.at.clone()),
        },
        _ => ScanInfo {
            status: ScanStatus::Missing,
            last_summary: None,
            scanned_at: None,
        },
    }
}

/// The current adjustment of a photo (identity when none).
#[must_use]
pub fn adjust_of(s: &Session, id: &str) -> crate::ipc::FrameAdjust {
    s.decisions()
        .adjusts
        .get(id)
        .copied()
        .unwrap_or_else(convert::identity_adjust)
}

/// Frame summaries of the active days that have a current frame, chronological.
#[must_use]
pub fn frame_summaries(s: &Session, days: &[DayGroup]) -> Vec<FrameSummary> {
    if s.frames.is_unset() {
        return Vec::new();
    }
    days.iter()
        .filter(|d| !d.excluded)
        .filter_map(|d| {
            let e = s.library.get(&d.selected_id)?;
            let adjust = adjust_of(s, &e.id);
            let key = frame_key(&s.frames.fingerprint, &e.version, &adjust);
            let rec = s.frames.current(&e.id, &key)?;
            let photo = photo_summary(s, e);
            Some(FrameSummary {
                photo_id: e.id.clone(),
                day_key: d.day_key.clone(),
                taken_at: photo.taken_at,
                time_known: photo.time_known,
                version: frame_version(&key, &s.p.look),
                residual_px: rec.residual_px,
                adjust,
                look_delta: session_frames::frame_look(s, rec)
                    .and_then(|l| l.delta())
                    .map(convert::ipc_look_delta),
            })
        })
        .collect()
}

fn frames_status(s: &Session, count: usize, expected: usize) -> FramesStatus {
    if count > 0 && count == expected {
        FramesStatus::Complete
    } else if count > 0 {
        FramesStatus::Partial
    } else if s.frames.others_exist || !s.frames.manifest.is_empty() {
        FramesStatus::Stale
    } else {
        FramesStatus::Missing
    }
}

/// Output size of the current reference crop and render settings.
#[must_use]
pub fn output_size(s: &Session) -> Option<crate::ipc::Size> {
    let r = s.p.reference.as_ref()?;
    reference::output_size(&r.crop, s.p.render.resolution).map(convert::ipc_size)
}

#[must_use]
pub fn frames_info(s: &Session, days: &[DayGroup]) -> FramesInfo {
    let count = frame_summaries(s, days).len();
    let expected = days.iter().filter(|d| !d.excluded).count();
    FramesInfo {
        status: frames_status(s, count, expected),
        count: count_u32(count),
        expected: count_u32(expected),
        output_size: output_size(s),
    }
}

#[must_use]
pub fn frames_view(s: &Session, days: &[DayGroup]) -> FramesView {
    let frames = frame_summaries(s, days);
    let expected = days.iter().filter(|d| !d.excluded).count();
    FramesView {
        status: frames_status(s, frames.len(), expected),
        output_size: output_size(s),
        render: s.p.render,
        look: s.p.look,
        reference_anchors: s
            .p
            .reference
            .as_ref()
            .and_then(|r| r.detection.as_ref())
            .map(|d| convert::ipc_points(&d.anchors)),
        frames,
    }
}

/// Default video file name `FaceTimelapse {firstYear}–{lastYear}.mp4`.
#[must_use]
pub fn default_video_name(days: &[DayGroup]) -> String {
    let active: Vec<&DayGroup> = days.iter().filter(|d| !d.excluded).collect();
    match (active.first(), active.last()) {
        (Some(a), Some(b)) => {
            let (y1, y2) = (
                &a.day_key[..4.min(a.day_key.len())],
                &b.day_key[..4.min(b.day_key.len())],
            );
            if y1 == y2 {
                format!("FaceTimelapse {y1}.mp4")
            } else {
                format!("FaceTimelapse {y1}–{y2}.mp4")
            }
        }
        _ => "FaceTimelapse.mp4".into(),
    }
}

/// Largest video resolution not exceeding the masters ("never larger than the masters").
#[must_use]
pub fn clamp_video_resolution(
    requested: crate::ipc::Resolution,
    master: Size,
) -> timelapse_video::Resolution {
    let want = convert::video_resolution(requested);
    match want.output_size(master.width, master.height) {
        Some((w, h)) if w > master.width || h > master.height => {
            timelapse_video::Resolution::Source
        }
        _ => want,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::fake::axis;
    use crate::session::Library;
    use face_engine::analysis::{FaceRecord, Outcome, PhotoAnalysis};
    use face_engine::dates;
    use face_engine::geometry::{Point, Rect};
    use face_engine::recognize::Embedding;
    use face_engine::walk::FileEntry;
    use std::sync::Arc;

    fn entry(name: &str, day: u32, hour: u32, emb: Option<Vec<f32>>) -> PhotoEntry {
        let file = FileEntry {
            path: format!("/p/{name}").into(),
            rel_path: name.into(),
            size: 1,
            mtime_ns: 1,
        };
        let outcome = emb.map_or(Outcome::NoFace, |e| Outcome::Faces {
            faces: vec![FaceRecord {
                bounds: Rect::default(),
                landmarks: [Point::default(); 5],
                score: 1.0,
                embedding: Embedding(e),
            }],
        });
        let a = PhotoAnalysis {
            oriented_size: Size::new(40, 30),
            taken_at: chrono::NaiveDate::from_ymd_opt(2014, 8, day)
                .and_then(|d| d.and_hms_opt(hour, 0, 0))
                .expect("date"),
            date_source: dates::DateSource::Exif,
            outcome,
        };
        PhotoEntry::from_file(&file, Some(Arc::new(a)))
    }

    pub fn session(entries: Vec<PhotoEntry>) -> Session {
        let mut s = Session::default();
        s.p.folder = Some("/p".into());
        s.library = Library {
            folder: Some("/p".into()),
            walked: entries.len(),
            entries,
            ..Library::default()
        };
        s.library.reindex();
        s.match_embedding = Some(Embedding(axis(0)));
        s.rematch();
        s
    }

    fn mixed() -> Vec<f32> {
        // cos 0.9 with axis(0): confirmed but below 1.0.
        let mut v = vec![0.0; 128];
        v[0] = 0.9;
        v[1] = (1.0f32 - 0.81).sqrt();
        v
    }

    #[test]
    fn days_group_rank_and_select() {
        let mut s = session(vec![
            entry("a.jpg", 15, 9, Some(mixed())),
            entry("b.jpg", 15, 8, Some(axis(0))),
            entry("c.jpg", 15, 7, Some(axis(0))),
            entry("d.jpg", 16, 7, Some(axis(1))),
            entry("e.jpg", 17, 7, None),
        ]);
        let d = days(&s);
        assert_eq!(d.len(), 1, "rejected/noFace days are not in the pool");
        let ids: Vec<&str> = d[0]
            .photo_ids
            .iter()
            .map(|id| s.library.get(id).map_or("", |e| e.file_name.as_str()))
            .collect();
        assert_eq!(
            ids,
            ["c.jpg", "b.jpg", "a.jpg"],
            "score desc, then takenAt asc"
        );
        assert_eq!(d[0].selected_id, d[0].auto_selected_id);
        assert!(!d[0].manual_selection);
        let pick = d[0].photo_ids[2].clone();
        s.decisions_mut()
            .expect("folder")
            .day_selections
            .insert("2014-08-15".into(), pick.clone());
        let d2 = days(&s);
        assert_eq!(
            (d2[0].selected_id.as_str(), d2[0].manual_selection),
            (pick.as_str(), true)
        );
        // A selection pointing outside the day falls back to the auto pick.
        s.decisions_mut()
            .expect("folder")
            .day_selections
            .insert("2014-08-15".into(), "ffffffffffffffff".into());
        assert_eq!(days(&s)[0].selected_id, d[0].auto_selected_id);
    }

    #[test]
    fn moves_reviews_exclusions_and_patch() {
        let mut s = session(vec![
            entry("a.jpg", 15, 9, Some(axis(0))),
            entry("b.jpg", 15, 8, Some(axis(0))),
        ]);
        let before = day_groups(&s);
        let a = s.library.entries[0].id.clone();
        s.decisions_mut()
            .expect("folder")
            .day_moves
            .insert(a.clone(), "2014-08-20".into());
        let after = day_groups(&s);
        let patch = diff_days(&before, &after);
        assert_eq!(patch.upserted.len(), 2);
        assert!(patch.removed.is_empty());
        assert_eq!(
            photo_summary(&s, &s.library.entries[0]).date_source,
            DateSource::Manual
        );
        s.decisions_mut()
            .expect("folder")
            .reviews
            .insert(a.clone(), ReviewDecision::Rejected);
        let gone = diff_days(&after, &day_groups(&s));
        assert_eq!(gone.removed, vec!["2014-08-20".to_string()]);
        s.decisions_mut()
            .expect("folder")
            .excluded_days
            .insert("2014-08-15".into());
        let d = days(&s);
        let c = counts(&s, &d);
        assert_eq!(
            (c.total, c.confirmed, c.included, c.days, c.active_days),
            (2, 2, 1, 1, 0)
        );
    }

    #[test]
    fn counts_track_review_pending() {
        let mut unsure = vec![0.0; 128];
        unsure[0] = 0.3;
        unsure[1] = (1.0f32 - 0.09).sqrt();
        let mut s = session(vec![
            entry("u.jpg", 15, 9, Some(unsure)),
            entry("n.jpg", 15, 8, None),
        ]);
        let c = counts(&s, &days(&s));
        assert_eq!(
            (c.uncertain, c.review_pending, c.no_face, c.included),
            (1, 1, 1, 0)
        );
        let u = s.library.entries[0].id.clone();
        s.decisions_mut()
            .expect("folder")
            .reviews
            .insert(u, ReviewDecision::Confirmed);
        let d = days(&s);
        let c = counts(&s, &d);
        assert_eq!((c.review_pending, c.included, c.days), (0, 1, 1));
        let sum = photo_summary(&s, &s.library.entries[0]);
        assert_eq!(
            (sum.review, sum.status, sum.included),
            (ReviewDecision::Confirmed, MatchStatus::Uncertain, true)
        );
        assert_eq!(sum.taken_at, "2014-08-15T09:00:00");
    }

    #[test]
    fn a_summary_knows_whether_its_time_of_day_is_real() {
        let dated = |name: &str, source| {
            let mut e = entry(name, 15, 9, Some(axis(0)));
            let mut a = (**e.analysis.as_ref().expect("analysis")).clone();
            a.date_source = source;
            e.analysis = Some(Arc::new(a));
            e
        };
        let s = session(vec![
            dated("IMG_20140815_142326.jpg", dates::DateSource::Exif),
            dated("IMG_20140815_142326.jpg", dates::DateSource::Filename),
            dated("IMG_20140815.jpg", dates::DateSource::Filename),
            dated("a.jpg", dates::DateSource::FileTime),
        ]);
        let known: Vec<bool> = s
            .library
            .entries
            .iter()
            .map(|e| photo_summary(&s, e).time_known)
            .collect();
        assert_eq!(known, [true, true, false, false]);
        // A photo added by hand to a day sits at noon of it: no real time.
        let mut manual = dated("IMG_20140815_142326.jpg", dates::DateSource::Exif);
        manual.manual_day = Some("2014-08-20".into());
        let summary = photo_summary(&s, &manual);
        assert!(!summary.time_known);
        assert!(summary.taken_at.ends_with("T12:00:00"));
    }

    #[test]
    fn misc_helpers() {
        let s = session(vec![]);
        assert_eq!(folder_info(&s).map(|f| f.name), Some("p".into()));
        assert_eq!(scan_info(&s).status, ScanStatus::Missing);
        let mk = |k: &str, excluded| DayGroup {
            day_key: k.into(),
            photo_ids: vec![],
            selected_id: String::new(),
            auto_selected_id: String::new(),
            manual_selection: false,
            excluded,
        };
        assert_eq!(
            default_video_name(&[mk("2012-01-01", false), mk("2022-01-01", false)]),
            "FaceTimelapse 2012–2022.mp4"
        );
        assert_eq!(
            default_video_name(&[mk("2012-01-01", false), mk("2022-01-01", true)]),
            "FaceTimelapse 2012.mp4"
        );
        assert_eq!(default_video_name(&[]), "FaceTimelapse.mp4");
        assert_eq!(
            clamp_video_resolution(crate::ipc::Resolution::P2160, Size::new(1920, 1080)),
            timelapse_video::Resolution::Source
        );
        assert_eq!(
            clamp_video_resolution(crate::ipc::Resolution::P720, Size::new(1920, 1080)),
            timelapse_video::Resolution::P720
        );
        let mut s = s;
        assert_eq!(frames_info(&s, &[]).status, FramesStatus::Missing);
        assert!(frames_view(&s, &[]).frames.is_empty());
        // Invalid day keys in decisions are ignored, not fatal.
        let d = s.decisions_mut().expect("folder");
        d.excluded_days.insert("garbage".into());
        d.day_moves.insert("x".into(), "2014-99-99".into());
        d.day_selections.insert("nope".into(), "x".into());
        assert!(days(&s).is_empty());
    }
}
