//! Reference photo plumbing for the IPC layer: friendly validation messages
//! over the engine's crop/rotation rules, versions for the image protocol and
//! the contract view (`ReferenceState`).

use face_engine::align::{RenderTarget, key_hash};
use face_engine::geometry::Size;
use face_engine::reference::{self as fe_ref, CropProblem};

use crate::convert;
use crate::error::AppResult;
use crate::ipc::{
    AspectPreset, IpcError, Rect, ReferenceDetection, ReferenceImage, ReferenceState, Resolution,
    Version,
};
use crate::session::model::PersistedReference;

/// The embedding photos are matched against: the crop's face, else the one
/// kept from the last detected crop of the same photo.
#[must_use]
pub fn match_embedding(r: &PersistedReference) -> Option<face_engine::recognize::Embedding> {
    r.detection
        .as_ref()
        .map(|d| d.embedding.clone())
        .or_else(|| r.match_embedding.clone())
}

/// Largest centered crop with the preset's aspect (whole image for `free`).
#[must_use]
pub fn default_crop(size: Size, aspect: AspectPreset) -> Rect {
    convert::ipc_rect(fe_ref::default_crop(size, convert::aspect(aspect)))
}

/// Validates a crop against the image size and aspect; returns it clamped to the image.
///
/// # Errors
/// `invalidArgument` with a user-facing reason.
pub fn validate_crop(crop: &Rect, size: Size, aspect: AspectPreset) -> AppResult<Rect> {
    fe_ref::check_crop(convert::rect(*crop), size, convert::aspect(aspect))
        .map(convert::ipc_rect)
        .map_err(|p| {
            IpcError::invalid(match p {
                CropProblem::NotFinite => "The crop has invalid numbers.",
                CropProblem::Outside => "The crop must stay inside the photo.",
                CropProblem::TooSmall => "The crop is too small. Make it at least 32 × 32 pixels.",
                CropProblem::AspectMismatch => "The crop doesn't match the chosen aspect ratio.",
            })
        })
}

/// Validates a rotation in degrees.
///
/// # Errors
/// `invalidArgument` outside `[-45, 45]` or non-finite.
pub fn validate_rotation(deg: f64) -> AppResult<f64> {
    if fe_ref::rotation_ok(deg) {
        Ok(deg)
    } else {
        Err(IpcError::invalid("Rotation must be between −45° and 45°."))
    }
}

/// Version of the rotated reference image (`reference` route).
#[must_use]
pub fn image_version(r: &PersistedReference) -> Version {
    key_hash(
        &[&r.path, &r.file_version, &format!("{:.6}", r.rotation_deg)],
        12,
    )
}

/// Version of the reference state (`reference/frame` route): image + crop + aspect.
#[must_use]
pub fn state_version(r: &PersistedReference) -> Version {
    let c = &r.crop;
    key_hash(
        &[
            &image_version(r),
            &format!("{:.3}|{:.3}|{:.3}|{:.3}", c.x, c.y, c.width, c.height),
            &serde_json::to_string(&r.aspect).unwrap_or_default(),
        ],
        12,
    )
}

/// Contract view of the persisted reference.
#[must_use]
pub fn to_state(r: &PersistedReference) -> ReferenceState {
    let file_name = std::path::Path::new(&r.path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    ReferenceState {
        image: ReferenceImage {
            path: r.path.clone(),
            file_name,
            rotation_deg: r.rotation_deg,
            auto_rotation_deg: r.image.auto_rotation_deg,
            size: convert::ipc_size(r.image.size),
            face: r
                .image
                .face
                .as_ref()
                .map(|f| convert::face_geometry(f.bounds, &f.anchors, f.confidence)),
            version: image_version(r),
        },
        crop: r.crop,
        aspect: r.aspect,
        detection: r.detection.as_ref().map(|d| ReferenceDetection {
            anchors: convert::ipc_points(&d.anchors),
            face_box: convert::ipc_rect(d.face_box),
            confidence: d.confidence,
        }),
        version: state_version(r),
    }
}

/// Aligned output size for a crop and resolution preset (§9.5).
#[must_use]
pub fn output_size(crop: &Rect, resolution: Resolution) -> Option<Size> {
    let (w, h) = (crop.width.round(), crop.height.round());
    if w < 1.0 || h < 1.0 {
        return None;
    }
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    convert::resolution(resolution).output_size(w as u32, h as u32)
}

/// Where the reference anchors land in an output frame.
#[must_use]
pub fn target(detection: &face_engine::reference::ReferenceDetection, out: Size) -> RenderTarget {
    RenderTarget::from_crop_anchors(&detection.anchors, out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use face_engine::geometry::{Point, Rect as FeRect};
    use face_engine::recognize::Embedding;
    use face_engine::reference::{FaceGeometry, ReferenceInfo};

    fn reference() -> PersistedReference {
        PersistedReference {
            path: "/r/ref.jpg".into(),
            rotation_deg: 0.0,
            crop: Rect {
                x: 0.0,
                y: 0.0,
                width: 3200.0,
                height: 2368.0,
            },
            aspect: AspectPreset::Free,
            file_version: "abcd1234".into(),
            engine: "e".into(),
            image: ReferenceInfo {
                size: Size::new(3200, 2368),
                face: Some(FaceGeometry {
                    bounds: FeRect::new(0.1, 0.2, 0.3, 0.4),
                    anchors: [Point::new(0.5, 0.5); 5],
                    confidence: 0.9,
                }),
                auto_rotation_deg: Some(-1.2),
            },
            match_embedding: None,
            detection: Some(face_engine::reference::ReferenceDetection {
                anchors: [
                    Point::new(0.3, 0.4),
                    Point::new(0.7, 0.4),
                    Point::new(0.5, 0.55),
                    Point::new(0.35, 0.7),
                    Point::new(0.65, 0.7),
                ],
                face_box: FeRect::new(0.1, 0.2, 0.3, 0.4),
                confidence: 0.97,
                embedding: Embedding(vec![1.0]),
            }),
        }
    }

    #[test]
    fn default_crops_are_centered_and_exact() {
        let free = default_crop(Size::new(3200, 2368), AspectPreset::Free);
        assert_eq!((free.width, free.height), (3200.0, 2368.0));
        let sq = default_crop(Size::new(3200, 2368), AspectPreset::Square);
        assert_eq!(
            (sq.x, sq.y, sq.width, sq.height),
            (416.0, 0.0, 2368.0, 2368.0)
        );
        let tall = default_crop(Size::new(3000, 4000), AspectPreset::Landscape16x9);
        assert_eq!((tall.width, tall.height), (3000.0, 1688.0));
        assert_eq!(tall.y, 1156.0);
    }

    #[test]
    fn crop_validation_messages() {
        let size = Size::new(1000, 800);
        let ok = Rect {
            x: -0.5,
            y: 0.0,
            width: 400.0,
            height: 300.0,
        };
        assert_eq!(
            validate_crop(&ok, size, AspectPreset::Landscape4x3)
                .expect("valid")
                .x,
            0.0
        );
        let msg = |r: Rect, a| validate_crop(&r, size, a).expect_err("invalid").message;
        assert!(
            msg(
                Rect {
                    x: 700.0,
                    y: 0.0,
                    width: 400.0,
                    height: 300.0
                },
                AspectPreset::Free
            )
            .contains("inside")
        );
        assert!(
            msg(
                Rect {
                    x: 0.0,
                    y: 0.0,
                    width: 31.0,
                    height: 40.0
                },
                AspectPreset::Free
            )
            .contains("too small")
        );
        assert!(
            msg(
                Rect {
                    x: 0.0,
                    y: 0.0,
                    width: 400.0,
                    height: 400.0
                },
                AspectPreset::Landscape16x9
            )
            .contains("aspect")
        );
        assert!(
            msg(
                Rect {
                    x: f64::NAN,
                    y: 0.0,
                    width: 400.0,
                    height: 400.0
                },
                AspectPreset::Free
            )
            .contains("invalid numbers")
        );
        assert!(validate_rotation(45.0).is_ok());
        assert!(validate_rotation(-45.1).is_err());
        assert!(validate_rotation(f64::INFINITY).is_err());
    }

    #[test]
    fn versions_track_rotation_and_crop() {
        let r = reference();
        let mut moved = r.clone();
        moved.crop.x = 1.0;
        assert_eq!(image_version(&r), image_version(&moved));
        assert_ne!(state_version(&r), state_version(&moved));
        let mut rotated = r.clone();
        rotated.rotation_deg = 2.0;
        assert_ne!(image_version(&r), image_version(&rotated));
        for a in [
            AspectPreset::Square,
            AspectPreset::Landscape4x3,
            AspectPreset::Portrait3x4,
            AspectPreset::Portrait4x5,
            AspectPreset::Landscape16x9,
            AspectPreset::Portrait9x16,
        ] {
            let mut x = r.clone();
            x.aspect = a;
            assert_ne!(state_version(&r), state_version(&x));
        }
    }

    #[test]
    fn state_conversion_and_geometry() {
        let s = to_state(&reference());
        assert_eq!(s.image.file_name, "ref.jpg");
        assert_eq!((s.image.size.width, s.image.size.height), (3200, 2368));
        assert_eq!(s.detection.as_ref().map(|d| d.anchors.len()), Some(5));
        assert_eq!(s.image.face.as_ref().map(|f| f.bounds.width), Some(0.3));
        assert_eq!(
            output_size(&s.crop, Resolution::P1080),
            Some(Size::new(1460, 1080))
        );
        // `source` = crop size capped to 3840×2160 (VIDEO crate rule).
        assert_eq!(
            output_size(&s.crop, Resolution::Source),
            Some(Size::new(2918, 2160))
        );
        assert_eq!(
            output_size(
                &Rect {
                    x: 0.0,
                    y: 0.0,
                    width: 0.0,
                    height: 1.0
                },
                Resolution::P720
            ),
            None
        );
        let c45 = default_crop(Size::new(3200, 2368), AspectPreset::Portrait4x5);
        assert_eq!(
            output_size(&c45, Resolution::P1080),
            Some(Size::new(1080, 1350)),
            "§9.5 example"
        );
        let det = reference().detection.expect("det");
        let t = target(&det, Size::new(100, 200));
        assert_eq!(t.anchors[0], Point::new(30.0, 80.0));
    }
}
