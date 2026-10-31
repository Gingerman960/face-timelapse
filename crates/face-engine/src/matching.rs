//! Identity matching: cosine similarity → calibrated legacy-scale score →
//! status (ARCHITECTURE §9.3, D8).
//!
//! Calibration keeps the legacy 0–1 display scale and its cut-offs
//! (confirmed ≥ 0.60, uncertain ≥ 0.40) with a continuous, monotonic
//! piecewise-linear map anchored at two cosine values `C` (→ 0.60) and
//! `U` (→ 0.40), `Z = 2U − C` (→ 0):
//!
//! ```text
//! cos ≥ C      : 0.60 + 0.40·(cos − C)/(1 − C)
//! U ≤ cos < C  : 0.40 + 0.20·(cos − U)/(C − U)
//! Z ≤ cos < U  : 0.40·(cos − Z)/(U − Z)
//! cos < Z      : 0
//! ```
//!
//! The constants were calibrated on the 3,593-photo set; see the crate README.

use serde::{Deserialize, Serialize};

use crate::recognize::Embedding;

/// Score at or above which a photo is `confirmed` (legacy cut-off).
pub const SCORE_CONFIRMED: f64 = 0.60;
/// Score at or above which a photo is `uncertain` (legacy cut-off).
pub const SCORE_UNCERTAIN: f64 = 0.40;

/// Calibrated cosine anchors (see crate README, "Calibration").
pub const COS_CONFIRMED: f64 = 0.363;
/// Calibrated cosine anchor for the uncertain band.
pub const COS_UNCERTAIN: f64 = 0.20;

/// Cosine anchors for [`calibrate`].
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Calibration {
    /// Cosine mapped to [`SCORE_CONFIRMED`].
    pub cos_confirmed: f64,
    /// Cosine mapped to [`SCORE_UNCERTAIN`].
    pub cos_uncertain: f64,
}

impl Default for Calibration {
    fn default() -> Self {
        Self {
            cos_confirmed: COS_CONFIRMED,
            cos_uncertain: COS_UNCERTAIN,
        }
    }
}

impl Calibration {
    /// Maps a cosine similarity onto the legacy 0–1 score scale.
    #[must_use]
    pub fn score(&self, cos: f64) -> f64 {
        let (c, u) = (self.cos_confirmed, self.cos_uncertain);
        let z = 2.0 * u - c;
        let s = if cos >= c {
            SCORE_CONFIRMED + (1.0 - SCORE_CONFIRMED) * (cos - c) / (1.0 - c)
        } else if cos >= u {
            SCORE_UNCERTAIN + (SCORE_CONFIRMED - SCORE_UNCERTAIN) * (cos - u) / (c - u)
        } else if cos >= z {
            SCORE_UNCERTAIN * (cos - z) / (u - z)
        } else {
            0.0
        };
        if s.is_nan() { 0.0 } else { s.clamp(0.0, 1.0) }
    }
}

/// [`Calibration::score`] with the default (calibrated) anchors.
#[must_use]
pub fn calibrate(cos: f64) -> f64 {
    Calibration::default().score(cos)
}

/// Outcome of matching one photo against the reference.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MatchStatus {
    /// Score ≥ 0.60.
    Confirmed,
    /// 0.40 ≤ score < 0.60.
    Uncertain,
    /// Score < 0.40.
    Rejected,
    /// The photo has no detectable face.
    NoFace,
    /// The photo could not be read or decoded.
    Failed,
}

/// Status for a score (faces present).
#[must_use]
pub fn categorize(score: f64) -> MatchStatus {
    if score >= SCORE_CONFIRMED {
        MatchStatus::Confirmed
    } else if score >= SCORE_UNCERTAIN {
        MatchStatus::Uncertain
    } else {
        MatchStatus::Rejected
    }
}

/// Best face for a reference embedding.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FaceMatch {
    /// Index into the photo's faces.
    pub face_index: usize,
    /// Raw cosine similarity.
    pub cosine: f64,
    /// Calibrated score.
    pub score: f64,
    /// Status derived from the score.
    pub status: MatchStatus,
}

/// `cos = max over faces(ref · face)`; `None` when there are no faces.
#[must_use]
pub fn match_faces<'a>(
    reference: &Embedding,
    faces: impl IntoIterator<Item = &'a Embedding>,
    calibration: &Calibration,
) -> Option<FaceMatch> {
    let (face_index, cos) = faces
        .into_iter()
        .map(|e| f64::from(reference.cosine(e)))
        .enumerate()
        .max_by(|a, b| a.1.total_cmp(&b.1))?;
    let score = calibration.score(cos);
    Some(FaceMatch {
        face_index,
        cosine: cos,
        score,
        status: categorize(score),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn calibration_hits_the_anchor_points() {
        let cal = Calibration::default();
        assert!((cal.score(COS_CONFIRMED) - 0.60).abs() < 1e-12);
        assert!((cal.score(COS_UNCERTAIN) - 0.40).abs() < 1e-12);
        assert!((cal.score(1.0) - 1.0).abs() < 1e-12);
        assert_eq!(cal.score(2.0 * COS_UNCERTAIN - COS_CONFIRMED), 0.0);
        assert_eq!(cal.score(-1.0), 0.0);
        assert_eq!(cal.score(f64::NAN), 0.0);
        assert_eq!(calibrate(0.5), cal.score(0.5));
    }

    #[test]
    fn calibration_is_monotonic_and_continuous() {
        for cal in [
            Calibration::default(),
            Calibration {
                cos_confirmed: 0.45,
                cos_uncertain: 0.30,
            },
        ] {
            let mut prev = cal.score(-1.0);
            let mut cos = -1.0;
            while cos <= 1.0 {
                let s = cal.score(cos);
                assert!(s >= prev - 1e-12, "not monotonic at {cos}");
                assert!(s - prev < 0.02, "jump at {cos}: {prev} → {s}");
                assert!((0.0..=1.0).contains(&s));
                prev = s;
                cos += 0.001;
            }
        }
    }

    #[test]
    fn categories_use_legacy_cutoffs() {
        assert_eq!(categorize(0.60), MatchStatus::Confirmed);
        assert_eq!(categorize(0.5999), MatchStatus::Uncertain);
        assert_eq!(categorize(0.40), MatchStatus::Uncertain);
        assert_eq!(categorize(0.3999), MatchStatus::Rejected);
        assert_eq!(categorize(0.0), MatchStatus::Rejected);
    }

    #[test]
    fn best_face_wins() {
        let r = Embedding::normalized(&[1.0, 0.0, 0.0]).expect("r");
        let faces = [
            Embedding::normalized(&[0.0, 1.0, 0.0]).expect("a"),
            Embedding::normalized(&[0.9, 0.1, 0.0]).expect("b"),
            Embedding::normalized(&[0.5, 0.5, 0.5]).expect("c"),
        ];
        let m = match_faces(&r, &faces, &Calibration::default()).expect("match");
        assert_eq!(m.face_index, 1);
        assert!(m.cosine > 0.99);
        assert_eq!(m.status, MatchStatus::Confirmed);
        assert!(match_faces(&r, &[], &Calibration::default()).is_none());
        let weak = [Embedding::normalized(&[0.0, 1.0, 0.0]).expect("w")];
        let m = match_faces(&r, &weak, &Calibration::default()).expect("match");
        assert_eq!(m.status, MatchStatus::Rejected);
    }
}
