//! Conversions between the IPC contract types (`ipc.rs`, verbatim §7.4, so
//! they cannot derive anything from the engine) and `face-engine`'s types.
//! Pure field mapping only — every rule lives in the engine.

use face_engine as fe;
use face_engine::geometry;

use crate::ipc;

/// Contract rect → engine rect.
#[must_use]
pub fn rect(r: ipc::Rect) -> geometry::Rect {
    geometry::Rect::new(r.x, r.y, r.width, r.height)
}

/// Engine rect → contract rect.
#[must_use]
pub fn ipc_rect(r: geometry::Rect) -> ipc::Rect {
    ipc::Rect {
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
    }
}

/// Engine points → contract points.
#[must_use]
pub fn ipc_points(points: &[geometry::Point]) -> Vec<ipc::Point> {
    points
        .iter()
        .map(|p| ipc::Point { x: p.x, y: p.y })
        .collect()
}

/// Engine size → contract size.
#[must_use]
pub fn ipc_size(s: geometry::Size) -> ipc::Size {
    ipc::Size {
        width: s.width,
        height: s.height,
    }
}

/// A face (normalized geometry) as the contract's `FaceGeometry`.
#[must_use]
pub fn face_geometry(
    bounds: geometry::Rect,
    anchors: &[geometry::Point],
    confidence: f64,
) -> ipc::FaceGeometry {
    ipc::FaceGeometry {
        bounds: ipc_rect(bounds),
        anchors: ipc_points(anchors),
        confidence,
    }
}

/// Contract aspect → engine aspect (same wire values).
#[must_use]
pub fn aspect(a: ipc::AspectPreset) -> fe::reference::AspectPreset {
    use fe::reference::AspectPreset as A;
    match a {
        ipc::AspectPreset::Free => A::Free,
        ipc::AspectPreset::Square => A::Square,
        ipc::AspectPreset::Landscape4x3 => A::Landscape4x3,
        ipc::AspectPreset::Portrait3x4 => A::Portrait3x4,
        ipc::AspectPreset::Portrait4x5 => A::Portrait4x5,
        ipc::AspectPreset::Landscape16x9 => A::Landscape16x9,
        ipc::AspectPreset::Portrait9x16 => A::Portrait9x16,
    }
}

/// Contract resolution → engine resolution (same wire values and rule).
#[must_use]
pub fn resolution(r: ipc::Resolution) -> fe::align::Resolution {
    match r {
        ipc::Resolution::Source => fe::align::Resolution::Source,
        ipc::Resolution::P2160 => fe::align::Resolution::P2160,
        ipc::Resolution::P1080 => fe::align::Resolution::P1080,
        ipc::Resolution::P720 => fe::align::Resolution::P720,
    }
}

/// Contract resolution → the video crate's (same wire values and rule).
#[must_use]
pub fn video_resolution(r: ipc::Resolution) -> timelapse_video::Resolution {
    match r {
        ipc::Resolution::Source => timelapse_video::Resolution::Source,
        ipc::Resolution::P2160 => timelapse_video::Resolution::P2160,
        ipc::Resolution::P1080 => timelapse_video::Resolution::P1080,
        ipc::Resolution::P720 => timelapse_video::Resolution::P720,
    }
}

/// Contract backdrop → engine backdrop.
#[must_use]
pub fn backdrop(b: ipc::BackdropMode) -> fe::warp::BackdropMode {
    match b {
        ipc::BackdropMode::Dimmed => fe::warp::BackdropMode::Dimmed,
        ipc::BackdropMode::Blurred => fe::warp::BackdropMode::Blurred,
        ipc::BackdropMode::Black => fe::warp::BackdropMode::Black,
        ipc::BackdropMode::Extended => fe::warp::BackdropMode::Extended,
    }
}

/// Contract render settings → engine render settings.
#[must_use]
pub fn render_settings(r: ipc::RenderSettings) -> fe::align::RenderSettings {
    fe::align::RenderSettings {
        resolution: resolution(r.resolution),
        backdrop: backdrop(r.backdrop),
        refine_landmarks: r.refine_landmarks,
    }
}

/// Contract adjustment → engine adjustment.
#[must_use]
pub fn adjust(a: ipc::FrameAdjust) -> fe::align::FrameAdjust {
    fe::align::FrameAdjust {
        dx: a.dx,
        dy: a.dy,
        scale: a.scale,
        rotation_deg: a.rotation_deg,
    }
}

/// Engine identity adjustment as the contract value.
#[must_use]
pub fn identity_adjust() -> ipc::FrameAdjust {
    let a = fe::align::FrameAdjust::default();
    ipc::FrameAdjust {
        dx: a.dx,
        dy: a.dy,
        scale: a.scale,
        rotation_deg: a.rotation_deg,
    }
}

/// Contract look → engine look.
#[must_use]
pub fn look(l: ipc::LookSettings) -> fe::color::LookSettings {
    fe::color::LookSettings {
        normalize: match l.normalize {
            ipc::NormalizeMode::Off => fe::color::NormalizeMode::Off,
            ipc::NormalizeMode::Exposure => fe::color::NormalizeMode::Exposure,
            ipc::NormalizeMode::ExposureAndColor => fe::color::NormalizeMode::ExposureAndColor,
        },
        strength: l.strength,
    }
}

/// Engine look delta → contract look delta.
#[must_use]
pub fn ipc_look_delta(d: fe::color::LookDelta) -> ipc::LookDelta {
    ipc::LookDelta {
        exposure_ev: d.exposure_ev,
        color_shift: d.color_shift,
    }
}

/// Contract export settings → engine export settings.
#[must_use]
pub fn image_export(s: ipc::ImageExportSettings) -> fe::export::ImageExportSettings {
    fe::export::ImageExportSettings {
        format: match s.format {
            ipc::ImageFormat::Png => fe::export::ImageFormat::Png,
            ipc::ImageFormat::Jpeg => fe::export::ImageFormat::Jpeg,
        },
        jpeg_quality: s.jpeg_quality,
        overwrite: s.overwrite,
    }
}

/// Engine status → contract status.
#[must_use]
pub fn ipc_status(s: fe::matching::MatchStatus) -> ipc::MatchStatus {
    match s {
        fe::matching::MatchStatus::Confirmed => ipc::MatchStatus::Confirmed,
        fe::matching::MatchStatus::Uncertain => ipc::MatchStatus::Uncertain,
        fe::matching::MatchStatus::Rejected => ipc::MatchStatus::Rejected,
        fe::matching::MatchStatus::NoFace => ipc::MatchStatus::NoFace,
        fe::matching::MatchStatus::Failed => ipc::MatchStatus::Failed,
    }
}

/// Engine date source → contract date source.
#[must_use]
pub fn ipc_date_source(d: fe::dates::DateSource) -> ipc::DateSource {
    match d {
        fe::dates::DateSource::Exif => ipc::DateSource::Exif,
        fe::dates::DateSource::Filename => ipc::DateSource::Filename,
        fe::dates::DateSource::FileTime => ipc::DateSource::FileTime,
        fe::dates::DateSource::Manual => ipc::DateSource::Manual,
    }
}

/// Why a photo could not be analyzed, as the contract's error kind.
#[must_use]
pub fn failure_kind(k: fe::analysis::FailureKind) -> ipc::ErrorKind {
    match k {
        fe::analysis::FailureKind::UnsupportedFormat => ipc::ErrorKind::UnsupportedFormat,
        fe::analysis::FailureKind::DecodeFailed => ipc::ErrorKind::DecodeFailed,
        fe::analysis::FailureKind::Io => ipc::ErrorKind::Io,
        fe::analysis::FailureKind::Internal => ipc::ErrorKind::Internal,
    }
}

/// `YYYY-MM-DD` of a day.
#[must_use]
pub fn day_key(d: chrono::NaiveDate) -> ipc::DayKey {
    d.format("%Y-%m-%d").to_string()
}

/// A `YYYY-MM-DD` day key as a date (`None` if it is not a real date).
#[must_use]
pub fn day(key: &str) -> Option<chrono::NaiveDate> {
    (key.len() == 10)
        .then(|| chrono::NaiveDate::parse_from_str(key, "%Y-%m-%d").ok())
        .flatten()
}

/// An engine day group as the contract's.
#[must_use]
pub fn ipc_day_group(g: fe::days::DayGroup) -> ipc::DayGroup {
    ipc::DayGroup {
        day_key: day_key(g.day),
        photo_ids: g.photo_ids,
        selected_id: g.selected_id,
        auto_selected_id: g.auto_selected_id,
        manual_selection: g.manual_selection,
        excluded: g.excluded,
    }
}

/// An engine days patch as the contract's.
#[must_use]
pub fn ipc_days_patch(p: fe::days::DaysPatch) -> ipc::DaysPatch {
    ipc::DaysPatch {
        upserted: p.upserted.into_iter().map(ipc_day_group).collect(),
        removed: p.removed.into_iter().map(day_key).collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wire<T: serde::Serialize>(v: T) -> serde_json::Value {
        serde_json::to_value(v).expect("json")
    }

    #[test]
    fn enums_keep_their_wire_values() {
        for a in [
            ipc::AspectPreset::Free,
            ipc::AspectPreset::Square,
            ipc::AspectPreset::Landscape4x3,
            ipc::AspectPreset::Portrait3x4,
            ipc::AspectPreset::Portrait4x5,
            ipc::AspectPreset::Landscape16x9,
            ipc::AspectPreset::Portrait9x16,
        ] {
            assert_eq!(wire(a), wire(aspect(a)));
        }
        for r in [
            ipc::Resolution::Source,
            ipc::Resolution::P2160,
            ipc::Resolution::P1080,
            ipc::Resolution::P720,
        ] {
            assert_eq!(wire(r), wire(resolution(r)));
            assert_eq!(wire(r), wire(video_resolution(r)));
        }
        for b in [
            ipc::BackdropMode::Dimmed,
            ipc::BackdropMode::Blurred,
            ipc::BackdropMode::Black,
            ipc::BackdropMode::Extended,
        ] {
            assert_eq!(wire(b), wire(backdrop(b)));
        }
        for m in [
            ipc::NormalizeMode::Off,
            ipc::NormalizeMode::Exposure,
            ipc::NormalizeMode::ExposureAndColor,
        ] {
            let l = ipc::LookSettings {
                normalize: m,
                strength: 0.5,
            };
            assert_eq!(wire(l), wire(look(l)));
        }
        for s in [
            fe::matching::MatchStatus::Confirmed,
            fe::matching::MatchStatus::Uncertain,
            fe::matching::MatchStatus::Rejected,
            fe::matching::MatchStatus::NoFace,
            fe::matching::MatchStatus::Failed,
        ] {
            assert_eq!(wire(s), wire(ipc_status(s)));
        }
        for d in [
            fe::dates::DateSource::Exif,
            fe::dates::DateSource::Filename,
            fe::dates::DateSource::FileTime,
            fe::dates::DateSource::Manual,
        ] {
            assert_eq!(wire(d), wire(ipc_date_source(d)));
        }
        for f in [ipc::ImageFormat::Png, ipc::ImageFormat::Jpeg] {
            let s = ipc::ImageExportSettings {
                format: f,
                jpeg_quality: 90,
                overwrite: true,
            };
            assert_eq!(wire(s), wire(image_export(s)));
        }
    }

    #[test]
    fn structs_map_field_by_field() {
        let r = ipc::Rect {
            x: 1.0,
            y: 2.0,
            width: 3.0,
            height: 4.0,
        };
        assert_eq!(ipc_rect(rect(r)), r);
        let a = ipc::FrameAdjust {
            dx: 0.1,
            dy: -0.1,
            scale: 1.2,
            rotation_deg: 3.0,
        };
        assert_eq!(wire(a), wire(adjust(a)));
        assert_eq!(
            wire(identity_adjust()),
            wire(fe::align::FrameAdjust::default())
        );
        let rs = ipc::RenderSettings {
            resolution: ipc::Resolution::P720,
            backdrop: ipc::BackdropMode::Black,
            refine_landmarks: false,
        };
        assert_eq!(wire(rs), wire(render_settings(rs)));
        assert_eq!(
            ipc_size(geometry::Size::new(4, 3)),
            ipc::Size {
                width: 4,
                height: 3
            }
        );
        let g = face_geometry(rect(r), &[geometry::Point::new(0.5, 0.25)], 0.9);
        assert_eq!(g.anchors, [ipc::Point { x: 0.5, y: 0.25 }]);
        let d = ipc_look_delta(fe::color::LookDelta {
            exposure_ev: 0.5,
            color_shift: 2.0,
        });
        assert_eq!((d.exposure_ev, d.color_shift), (0.5, 2.0));
    }

    #[test]
    fn contract_constants_match_the_engine() {
        assert_eq!(ipc::THUMB_WIDTHS, fe::thumbs::THUMB_WIDTHS);
        assert_eq!(ipc::SCORE_CONFIRMED, fe::matching::SCORE_CONFIRMED);
        assert_eq!(ipc::SCORE_UNCERTAIN, fe::matching::SCORE_UNCERTAIN);
        assert!(ipc::ALIGNED_WIDTHS.contains(&fe::frames::PREVIEW_WIDTHS[0]));
        assert!(ipc::ALIGNED_WIDTHS.contains(&fe::frames::PREVIEW_WIDTHS[1]));
    }

    #[test]
    fn failure_kinds() {
        use fe::analysis::FailureKind as F;
        assert_eq!(
            failure_kind(F::UnsupportedFormat),
            ipc::ErrorKind::UnsupportedFormat
        );
        assert_eq!(failure_kind(F::DecodeFailed), ipc::ErrorKind::DecodeFailed);
        assert_eq!(failure_kind(F::Io), ipc::ErrorKind::Io);
        assert_eq!(failure_kind(F::Internal), ipc::ErrorKind::Internal);
    }

    #[test]
    fn day_keys() {
        let d = day("2014-08-15").expect("date");
        assert_eq!(day_key(d), "2014-08-15");
        assert!(day("2014-13-40").is_none());
        assert!(day("2014-8-15").is_none());
        assert!(day("").is_none());
        let g = fe::days::DayGroup {
            day: d,
            photo_ids: vec!["a".into()],
            selected_id: "a".into(),
            auto_selected_id: "a".into(),
            manual_selection: false,
            excluded: true,
        };
        let p = ipc_days_patch(fe::days::DaysPatch {
            upserted: vec![g],
            removed: vec![d],
        });
        assert_eq!(p.upserted[0].day_key, "2014-08-15");
        assert!(p.upserted[0].excluded);
        assert_eq!(p.removed, ["2014-08-15"]);
    }
}
