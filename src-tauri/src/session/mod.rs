//! Backend-owned session state (D2): persisted choices + the in-memory
//! library of the current folder, its matching against the reference, and the
//! frames of the current render fingerprint. Domain rules (ids, matching,
//! days, keys) are the engine's; this module holds state and decisions.

pub mod derive;
pub mod frames;
pub mod model;
pub mod persist;
pub mod reference;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use face_engine::analysis::{Outcome, PhotoAnalysis};
use face_engine::matching::{Calibration, FaceMatch};
use face_engine::recognize::Embedding;
use face_engine::walk::FileEntry;

use crate::convert;
use crate::ipc::{DayKey, MatchStatus, PhotoId, ReviewDecision};
use frames::Frames;
use model::{FolderDecisions, PersistedSession};

/// Matching result of one photo against the reference embedding.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MatchInfo {
    pub status: MatchStatus,
    /// Calibrated `[0,1]`; 0 for noFace/failed.
    pub score: f64,
    pub matched_face: Option<u32>,
    pub cosine: Option<f64>,
}

impl MatchInfo {
    const UNANALYZED: Self = Self {
        status: MatchStatus::Failed,
        score: 0.0,
        matched_face: None,
        cosine: None,
    };

    fn of(status: MatchStatus) -> Self {
        Self {
            status,
            ..Self::UNANALYZED
        }
    }

    fn from_engine(m: Option<FaceMatch>, status: face_engine::matching::MatchStatus) -> Self {
        Self {
            status: convert::ipc_status(status),
            score: m.map_or(0.0, |m| m.score),
            matched_face: m.and_then(|m| u32::try_from(m.face_index).ok()),
            cosine: m.map(|m| m.cosine),
        }
    }
}

/// A photo known to the session: a walked file of the folder or a manual add.
#[derive(Debug, Clone)]
pub struct PhotoEntry {
    pub id: PhotoId,
    pub path: PathBuf,
    /// Relative to the folder; absolute for manual photos outside it.
    pub rel_path: String,
    pub file_name: String,
    pub size: u64,
    pub mtime_ns: i64,
    pub version: String,
    /// `None` = walked but not analyzed yet (not listed by `get_photos`).
    pub analysis: Option<Arc<PhotoAnalysis>>,
    /// Day of a manual add.
    pub manual_day: Option<DayKey>,
    pub matching: MatchInfo,
}

impl PhotoEntry {
    #[must_use]
    pub fn from_file(file: &FileEntry, analysis: Option<Arc<PhotoAnalysis>>) -> Self {
        Self {
            id: file.id(),
            path: file.path.clone(),
            rel_path: file.rel_path.clone(),
            file_name: file.file_name().to_owned(),
            size: file.size,
            mtime_ns: file.mtime_ns,
            version: file.version(),
            analysis,
            manual_day: None,
            matching: MatchInfo::UNANALYZED,
        }
    }

    #[must_use]
    pub fn is_analyzed(&self) -> bool {
        self.analysis.is_some()
    }

    /// The face matched to the reference (largest face without a reference).
    #[must_use]
    pub fn matched_face(&self) -> Option<&face_engine::analysis::FaceRecord> {
        let faces = self.analysis.as_ref()?.faces();
        faces.get(self.matching.matched_face.map_or(0, |i| i as usize))
    }
}

/// Photos of the current folder (natural order) followed by manual adds.
#[derive(Debug, Default, Clone)]
pub struct Library {
    /// Canonical folder.
    pub folder: Option<PathBuf>,
    pub entries: Vec<PhotoEntry>,
    pub index: HashMap<PhotoId, usize>,
    /// Number of leading entries that come from the folder walk.
    pub walked: usize,
    pub unsupported: u32,
}

impl Library {
    /// Builds the library from a walk; `analysis_of` returns the cached or
    /// fresh analysis of an unchanged file (none = not analyzed yet).
    #[must_use]
    pub fn from_walk(
        folder: PathBuf,
        files: &[FileEntry],
        unsupported: u32,
        mut analysis_of: impl FnMut(&FileEntry) -> Option<PhotoAnalysis>,
    ) -> Self {
        let entries: Vec<PhotoEntry> = files
            .iter()
            .map(|f| PhotoEntry::from_file(f, analysis_of(f).map(Arc::new)))
            .collect();
        let mut lib = Self {
            folder: Some(folder),
            walked: entries.len(),
            entries,
            unsupported,
            ..Self::default()
        };
        lib.reindex();
        lib
    }

    pub fn reindex(&mut self) {
        self.index = self
            .entries
            .iter()
            .enumerate()
            .map(|(i, e)| (e.id.clone(), i))
            .collect();
    }

    #[must_use]
    pub fn get(&self, id: &str) -> Option<&PhotoEntry> {
        self.index.get(id).map(|&i| &self.entries[i])
    }

    /// Walked folder files.
    #[must_use]
    pub fn walked(&self) -> &[PhotoEntry] {
        &self.entries[..self.walked]
    }

    #[must_use]
    pub fn analyzed_count(&self) -> u32 {
        count_u32(self.walked().iter().filter(|e| e.is_analyzed()).count())
    }

    /// Replaces manual entries (after the walked ones).
    pub fn set_manual(&mut self, manual: Vec<PhotoEntry>) {
        self.entries.truncate(self.walked);
        self.reindex();
        for m in manual {
            // A manual add of a file that is part of the folder is handled as a move.
            if !self.index.contains_key(&m.id) {
                self.index.insert(m.id.clone(), self.entries.len());
                self.entries.push(m);
            }
        }
    }
}

/// Saturating usize → u32 for counts.
#[must_use]
pub fn count_u32(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

/// Full in-memory session.
#[derive(Debug, Default)]
pub struct Session {
    pub p: PersistedSession,
    pub library: Library,
    /// Embedding used for matching (the current reference detection).
    pub match_embedding: Option<Embedding>,
    pub frames: Frames,
}

impl Session {
    /// Key of the current folder in `p.folders`.
    #[must_use]
    pub fn folder_key(&self) -> Option<&str> {
        self.p.folder.as_deref()
    }

    /// Decisions for the current folder (empty if none).
    #[must_use]
    pub fn decisions(&self) -> &FolderDecisions {
        static EMPTY: std::sync::OnceLock<FolderDecisions> = std::sync::OnceLock::new();
        self.folder_key()
            .and_then(|k| self.p.folders.get(k))
            .unwrap_or_else(|| EMPTY.get_or_init(FolderDecisions::default))
    }

    /// Mutable decisions for the current folder (created on demand).
    pub fn decisions_mut(&mut self) -> Option<&mut FolderDecisions> {
        let key = self.p.folder.clone()?;
        Some(self.p.folders.entry(key).or_default())
    }

    #[must_use]
    pub fn review(&self, id: &str) -> ReviewDecision {
        self.decisions()
            .reviews
            .get(id)
            .copied()
            .unwrap_or(ReviewDecision::Pending)
    }

    /// In the day pool (§9.4): manual adds always; else confirmed by review or by match.
    #[must_use]
    pub fn is_included(&self, e: &PhotoEntry) -> bool {
        if !e.is_analyzed() {
            return false;
        }
        if e.manual_day.is_some() {
            return true;
        }
        match self.review(&e.id) {
            ReviewDecision::Confirmed => true,
            ReviewDecision::Rejected => false,
            ReviewDecision::Pending => e.matching.status == MatchStatus::Confirmed,
        }
    }

    /// Effective day: user move ⟶ manual day ⟶ capture date.
    #[must_use]
    pub fn day_of(&self, e: &PhotoEntry) -> DayKey {
        if let Some(day) = self.decisions().day_moves.get(&e.id) {
            return day.clone();
        }
        if let Some(day) = &e.manual_day {
            return day.clone();
        }
        e.analysis
            .as_ref()
            .map(|a| convert::day_key(a.taken_at.date()))
            .unwrap_or_default()
    }

    /// Recomputes every photo's [`MatchInfo`] against `match_embedding`.
    pub fn rematch(&mut self) {
        let emb = self.match_embedding.clone();
        for e in &mut self.library.entries {
            e.matching = match_photo(emb.as_ref(), e.analysis.as_deref());
        }
    }

    /// Rebuilds manual entries from the folder's decisions.
    pub fn sync_manual(&mut self) {
        let manual: Vec<PhotoEntry> = self
            .decisions()
            .manual_photos
            .iter()
            .map(|m| manual_entry(m, self.library.folder.as_deref()))
            .collect();
        self.library.set_manual(manual);
        let emb = self.match_embedding.clone();
        for e in &mut self.library.entries[self.library.walked..] {
            e.matching = match_photo(emb.as_ref(), e.analysis.as_deref());
        }
    }
}

/// Library entry for a manual photo.
#[must_use]
pub fn manual_entry(m: &model::ManualPhoto, folder: Option<&Path>) -> PhotoEntry {
    let path = PathBuf::from(&m.path);
    let rel_path = folder.and_then(|f| path.strip_prefix(f).ok()).map_or_else(
        || m.path.clone(),
        |r| r.to_string_lossy().replace('\\', "/"),
    );
    let file = FileEntry {
        path: path.clone(),
        rel_path,
        size: m.size,
        mtime_ns: m.mtime_ns,
    };
    let mut entry = PhotoEntry::from_file(&file, Some(Arc::new(m.analysis.clone())));
    entry.manual_day = Some(m.day_key.clone());
    entry
}

/// Status/score of one analysis against the reference embedding (§9.3,
/// `face_engine::scan::match_photo`); without a reference every photo with
/// faces is `rejected`.
#[must_use]
pub fn match_photo(reference: Option<&Embedding>, analysis: Option<&PhotoAnalysis>) -> MatchInfo {
    let Some(analysis) = analysis else {
        return MatchInfo::UNANALYZED;
    };
    match reference {
        Some(r) => {
            let (m, status) = face_engine::scan::match_photo(analysis, r, &Calibration::default());
            MatchInfo::from_engine(m, status)
        }
        None => MatchInfo::of(match &analysis.outcome {
            Outcome::Failed { .. } => MatchStatus::Failed,
            Outcome::Faces { faces } if !faces.is_empty() => MatchStatus::Rejected,
            Outcome::Faces { .. } | Outcome::NoFace => MatchStatus::NoFace,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::fake::axis;
    use face_engine::analysis::{FaceRecord, FailureKind};
    use face_engine::dates::DateSource;
    use face_engine::geometry::{Point, Rect, Size};

    pub fn analysis(faces: Vec<Vec<f32>>) -> PhotoAnalysis {
        PhotoAnalysis {
            oriented_size: Size::new(40, 30),
            taken_at: chrono::NaiveDate::from_ymd_opt(2014, 8, 15)
                .and_then(|d| d.and_hms_opt(10, 0, 0))
                .expect("date"),
            date_source: DateSource::Exif,
            outcome: Outcome::Faces {
                faces: faces
                    .into_iter()
                    .map(|embedding| FaceRecord {
                        bounds: Rect::default(),
                        landmarks: [Point::default(); 5],
                        score: 1.0,
                        embedding: Embedding(embedding),
                    })
                    .collect(),
            },
        }
    }

    #[test]
    fn matching_picks_best_face_and_categorizes() {
        let r = Embedding(axis(0));
        let m = match_photo(Some(&r), Some(&analysis(vec![axis(1), axis(0)])));
        assert_eq!(
            (m.status, m.matched_face),
            (MatchStatus::Confirmed, Some(1))
        );
        assert!((m.score - 1.0).abs() < 1e-9);
        assert!(m.cosine.is_some_and(|c| (c - 1.0).abs() < 1e-6));
        let m = match_photo(Some(&r), Some(&analysis(vec![axis(1)])));
        assert_eq!(m.status, MatchStatus::Rejected);
        let m = match_photo(None, Some(&analysis(vec![axis(0)])));
        assert_eq!(m.status, MatchStatus::Rejected);
        let mut none = analysis(vec![]);
        assert_eq!(
            match_photo(Some(&r), Some(&none)).status,
            MatchStatus::NoFace
        );
        assert_eq!(match_photo(None, Some(&none)).status, MatchStatus::NoFace);
        none.outcome = Outcome::NoFace;
        assert_eq!(
            match_photo(Some(&r), Some(&none)).status,
            MatchStatus::NoFace
        );
        none.outcome = Outcome::Failed {
            kind: FailureKind::DecodeFailed,
            message: String::new(),
        };
        assert_eq!(
            match_photo(Some(&r), Some(&none)).status,
            MatchStatus::Failed
        );
        assert_eq!(match_photo(None, Some(&none)).status, MatchStatus::Failed);
        assert_eq!(match_photo(Some(&r), None).status, MatchStatus::Failed);
    }

    #[test]
    fn library_uses_analyses_by_file() {
        let files = vec![
            FileEntry {
                path: "/p/a.jpg".into(),
                rel_path: "a.jpg".into(),
                size: 1,
                mtime_ns: 1,
            },
            FileEntry {
                path: "/p/b.jpg".into(),
                rel_path: "b.jpg".into(),
                size: 1,
                mtime_ns: 1,
            },
        ];
        let lib = Library::from_walk("/p".into(), &files, 3, |f| {
            (f.rel_path == "a.jpg").then(|| analysis(vec![axis(0)]))
        });
        assert_eq!(lib.analyzed_count(), 1);
        assert_eq!(lib.unsupported, 3);
        let id = face_engine::walk::photo_id(Path::new("/p/a.jpg"));
        assert_eq!(lib.get(&id).map(|e| e.file_name.as_str()), Some("a.jpg"));
        assert_eq!(lib.get(&id).map(|e| e.version.len()), Some(8));
    }

    #[test]
    fn manual_entries_get_relative_paths_inside_folder() {
        let m = model::ManualPhoto {
            path: "/p/sub/x.jpg".into(),
            day_key: "2014-08-16".into(),
            size: 1,
            mtime_ns: 1,
            analysis: analysis(vec![axis(0)]),
        };
        assert_eq!(
            manual_entry(&m, Some(Path::new("/p"))).rel_path,
            "sub/x.jpg"
        );
        assert_eq!(
            manual_entry(&m, Some(Path::new("/q"))).rel_path,
            "/p/sub/x.jpg"
        );
        let mut s = Session::default();
        s.p.folder = Some("/p".into());
        s.decisions_mut().expect("folder").manual_photos.push(m);
        s.library = Library::from_walk("/p".into(), &[], 0, |_| None);
        s.sync_manual();
        assert_eq!(s.library.entries.len(), 1);
        let e = &s.library.entries[0];
        assert!(s.is_included(e));
        assert_eq!(s.day_of(e), "2014-08-16");
        assert!(e.matched_face().is_some());
    }
}
