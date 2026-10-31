//! Daily grouping (ARCHITECTURE §9.4, LEGACY-SPEC §4.9).
//!
//! Pure functions over immutable inputs: candidates (included photos with
//! their capture time and score) + user decisions (moves, selections,
//! excluded days) → day groups.
//!
//! - day = date part of `taken_at`, unless the photo was moved;
//! - photos in a day: score desc, then earliest `taken_at`, then `rel_path`
//!   (natural order) — the first one is the automatic pick (legacy: best match);
//! - a manual selection that no longer points into its day falls back to the
//!   automatic pick;
//! - days ascending; frames are rendered/exported in that order.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use chrono::{NaiveDate, NaiveDateTime};
use serde::{Deserialize, Serialize};

use crate::walk::natural_cmp;

/// A photo eligible for the timelapse.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DayCandidate {
    /// Photo id.
    pub id: String,
    /// Relative path (tie-breaker).
    pub rel_path: String,
    /// Capture time.
    pub taken_at: NaiveDateTime,
    /// Calibrated match score.
    pub score: f64,
}

/// User decisions that shape the days.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DayDecisions {
    /// Photo id → day it was moved to.
    pub moves: BTreeMap<String, NaiveDate>,
    /// Day → photo chosen by the user.
    pub selections: BTreeMap<NaiveDate, String>,
    /// Days left out of the timelapse.
    pub excluded: BTreeSet<NaiveDate>,
}

impl DayDecisions {
    /// Returns a copy with `photo` moved to `day` (a move to the photo's own
    /// capture day is stored too; it is harmless).
    #[must_use]
    pub fn with_move(&self, photo: &str, day: NaiveDate) -> Self {
        let mut next = self.clone();
        next.moves.insert(photo.to_owned(), day);
        next
    }

    /// Returns a copy with `photo` selected for `day`.
    #[must_use]
    pub fn with_selection(&self, day: NaiveDate, photo: &str) -> Self {
        let mut next = self.clone();
        next.selections.insert(day, photo.to_owned());
        next
    }

    /// Returns a copy with the selection of `day` reset to automatic.
    #[must_use]
    pub fn without_selection(&self, day: NaiveDate) -> Self {
        let mut next = self.clone();
        next.selections.remove(&day);
        next
    }

    /// Returns a copy with `day` excluded or included.
    #[must_use]
    pub fn with_excluded(&self, day: NaiveDate, excluded: bool) -> Self {
        let mut next = self.clone();
        if excluded {
            next.excluded.insert(day);
        } else {
            next.excluded.remove(&day);
        }
        next
    }

    /// Effective day of a candidate.
    #[must_use]
    pub fn day_of(&self, c: &DayCandidate) -> NaiveDate {
        self.moves
            .get(&c.id)
            .copied()
            .unwrap_or_else(|| c.taken_at.date())
    }
}

/// One calendar day.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DayGroup {
    /// The day.
    pub day: NaiveDate,
    /// Photos, best first.
    pub photo_ids: Vec<String>,
    /// Photo used for the frame.
    pub selected_id: String,
    /// Automatic pick (`photo_ids[0]`).
    pub auto_selected_id: String,
    /// True when `selected_id` comes from a user selection.
    pub manual_selection: bool,
    /// True when the day is excluded from the timelapse.
    pub excluded: bool,
}

/// Ordering of photos inside a day: score desc, `taken_at` asc, `rel_path`.
fn rank(a: &DayCandidate, b: &DayCandidate) -> std::cmp::Ordering {
    b.score
        .total_cmp(&a.score)
        .then_with(|| a.taken_at.cmp(&b.taken_at))
        .then_with(|| natural_cmp(&a.rel_path, &b.rel_path))
}

/// Groups candidates into days.
#[must_use]
pub fn group_days(candidates: &[DayCandidate], decisions: &DayDecisions) -> Vec<DayGroup> {
    let mut by_day: BTreeMap<NaiveDate, Vec<&DayCandidate>> = BTreeMap::new();
    for c in candidates {
        by_day.entry(decisions.day_of(c)).or_default().push(c);
    }
    by_day
        .into_iter()
        .filter_map(|(day, mut photos)| {
            photos.sort_by(|a, b| rank(a, b));
            let auto = photos.first()?.id.clone();
            let chosen = decisions
                .selections
                .get(&day)
                .filter(|id| photos.iter().any(|p| &p.id == *id));
            Some(DayGroup {
                day,
                photo_ids: photos.iter().map(|p| p.id.clone()).collect(),
                selected_id: chosen.cloned().unwrap_or_else(|| auto.clone()),
                auto_selected_id: auto,
                manual_selection: chosen.is_some(),
                excluded: decisions.excluded.contains(&day),
            })
        })
        .collect()
}

/// `(day, selected photo)` of every non-excluded day, in day order.
#[must_use]
pub fn timeline(groups: &[DayGroup]) -> Vec<(NaiveDate, String)> {
    groups
        .iter()
        .filter(|g| !g.excluded)
        .map(|g| (g.day, g.selected_id.clone()))
        .collect()
}

/// Changes between two groupings.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DaysPatch {
    /// New or changed days.
    pub upserted: Vec<DayGroup>,
    /// Days that disappeared.
    pub removed: Vec<NaiveDate>,
}

/// Computes the patch turning `old` into `new`.
#[must_use]
pub fn diff(old: &[DayGroup], new: &[DayGroup]) -> DaysPatch {
    let before: HashMap<NaiveDate, &DayGroup> = old.iter().map(|g| (g.day, g)).collect();
    let after: BTreeSet<NaiveDate> = new.iter().map(|g| g.day).collect();
    DaysPatch {
        upserted: new
            .iter()
            .filter(|g| before.get(&g.day).is_none_or(|o| *o != *g))
            .cloned()
            .collect(),
        removed: old
            .iter()
            .map(|g| g.day)
            .filter(|d| !after.contains(d))
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn day(d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(2014, 8, d).expect("date")
    }

    fn cand(id: &str, d: u32, h: u32, score: f64) -> DayCandidate {
        DayCandidate {
            id: id.into(),
            rel_path: format!("{id}.jpg"),
            taken_at: day(d).and_hms_opt(h, 0, 0).expect("time"),
            score,
        }
    }

    fn photos() -> Vec<DayCandidate> {
        vec![
            cand("a", 15, 9, 0.70),
            cand("b", 15, 12, 0.90),
            cand("c", 15, 18, 0.90),
            cand("d", 16, 10, 0.65),
            cand("e", 14, 23, 0.80),
        ]
    }

    #[test]
    fn groups_by_day_with_best_match_first() {
        let g = group_days(&photos(), &DayDecisions::default());
        let days: Vec<_> = g.iter().map(|g| g.day).collect();
        assert_eq!(days, [day(14), day(15), day(16)]);
        // b and c tie on score → earlier capture (b) wins.
        assert_eq!(g[1].photo_ids, ["b", "c", "a"]);
        assert_eq!(g[1].selected_id, "b");
        assert_eq!(g[1].auto_selected_id, "b");
        assert!(!g[1].manual_selection && !g[1].excluded);
        assert_eq!(
            timeline(&g),
            [
                (day(14), "e".into()),
                (day(15), "b".into()),
                (day(16), "d".into())
            ]
        );
        assert!(group_days(&[], &DayDecisions::default()).is_empty());
    }

    #[test]
    fn rel_path_breaks_full_ties() {
        let mut p = vec![cand("x10", 1, 9, 0.8), cand("x9", 1, 9, 0.8)];
        p[0].rel_path = "IMG_10.jpg".into();
        p[1].rel_path = "IMG_9.jpg".into();
        let g = group_days(&p, &DayDecisions::default());
        assert_eq!(g[0].selected_id, "x9");
    }

    #[test]
    fn selections_moves_and_exclusions() {
        let p = photos();
        let base = DayDecisions::default();
        let picked = base.with_selection(day(15), "a");
        let g = group_days(&p, &picked);
        assert_eq!(g[1].selected_id, "a");
        assert!(g[1].manual_selection);
        assert_eq!(g[1].auto_selected_id, "b");

        // Moving the selected photo away falls back to the automatic pick.
        let moved = picked.with_move("a", day(16));
        let g2 = group_days(&p, &moved);
        assert_eq!(g2[1].selected_id, "b");
        assert!(!g2[1].manual_selection);
        assert_eq!(g2[2].photo_ids, ["a", "d"]);

        // Moving the only photo of a day removes that day.
        let g3 = group_days(&p, &base.with_move("e", day(20)));
        assert_eq!(
            g3.iter().map(|g| g.day).collect::<Vec<_>>(),
            [day(15), day(16), day(20)]
        );

        let ex = base.with_excluded(day(15), true);
        let g4 = group_days(&p, &ex);
        assert!(g4[1].excluded);
        assert_eq!(timeline(&g4).len(), 2);
        assert_eq!(ex.with_excluded(day(15), false), base);
        assert_eq!(picked.without_selection(day(15)), base);
        // Decisions are immutable values.
        assert!(base.moves.is_empty() && base.selections.is_empty());
    }

    #[test]
    fn diff_reports_changed_and_removed_days() {
        let p = photos();
        let base = DayDecisions::default();
        let old = group_days(&p, &base);
        let new = group_days(&p, &base.with_move("e", day(15)));
        let patch = diff(&old, &new);
        assert_eq!(patch.removed, [day(14)]);
        assert_eq!(patch.upserted.len(), 1);
        assert_eq!(patch.upserted[0].day, day(15));
        assert_eq!(diff(&old, &old), DaysPatch::default());
    }
}
