//! Per-folder analysis cache (ARCHITECTURE §4.1, §5).
//!
//! File: `{cache_dir}/analysis/{folderKey}.bin`, `postcard`-encoded:
//! `{magic "FTAC", formatVersion, engineFingerprint, folder, entries[]}`.
//!
//! Why postcard: the whole cache (~3,600 entries with 128-d embeddings) is
//! ~2–3 MB and is always read and written as a unit — a compact serde binary
//! format is a few milliseconds each way, pure Rust, and needs no schema
//! migrations (a format or engine change simply discards the file). SQLite
//! would add a C dependency and per-row overhead for no benefit here.
//!
//! - A hit requires the same relative path, size and mtime (ns).
//! - Reference-independent: no-face and failed photos are cached too.
//! - Writes are atomic (`*.tmp` + rename); corrupt or mismatched files are
//!   ignored (logged) and rebuilt.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::analysis::PhotoAnalysis;
use crate::error::{EngineError, Result};
use crate::walk::{FileEntry, folder_key};

mod files;
mod prune;

pub use files::{
    create_exclusive, file_is_whole_jpeg, is_temp_name, is_whole_jpeg, write_atomic,
    write_atomic_cache,
};
pub(crate) use files::{sync_dir, temp_names};
pub use prune::{OTHER_ENGINE_GRACE, RECENT_WRITE, prune};

/// File magic.
pub const CACHE_MAGIC: [u8; 4] = *b"FTAC";
/// Bump when the on-disk layout changes.
pub const CACHE_FORMAT_VERSION: u32 = 1;

/// One cached photo.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheEntry {
    /// Path relative to the folder.
    pub rel_path: String,
    /// File size when analyzed.
    pub size: u64,
    /// Modification time (ns) when analyzed.
    pub mtime_ns: i64,
    /// The analysis.
    pub analysis: PhotoAnalysis,
}

#[derive(Serialize, Deserialize)]
struct Header {
    magic: [u8; 4],
    format_version: u32,
    engine_fingerprint: String,
}

#[derive(Serialize, Deserialize)]
struct CacheFile {
    magic: [u8; 4],
    format_version: u32,
    engine_fingerprint: String,
    folder: String,
    entries: Vec<CacheEntry>,
}

/// In-memory view of one folder's cache file.
#[derive(Debug, Clone)]
pub struct AnalysisCache {
    file: PathBuf,
    fingerprint: String,
    folder: String,
    entries: HashMap<String, CacheEntry>,
    dirty: bool,
}

/// Why a cache file was not used.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoadStatus {
    /// Loaded successfully.
    Loaded,
    /// No file yet.
    Missing,
    /// Different format version or engine fingerprint.
    Stale,
    /// Unreadable or undecodable.
    Corrupt,
}

/// `{cache_dir}/analysis` — every folder's cache file lives here.
#[must_use]
pub fn dir(cache_dir: &Path) -> PathBuf {
    cache_dir.join("analysis")
}

/// Number of entries in a cache file without decoding them (header + length
/// prefix only); `None` for missing, foreign or corrupt files.
#[must_use]
pub fn entry_count(file: &Path) -> Option<usize> {
    #[derive(Deserialize)]
    struct Head {
        magic: [u8; 4],
        _format_version: u32,
        _engine_fingerprint: String,
        _folder: String,
    }
    let bytes = std::fs::read(file).ok()?;
    let (head, rest) = postcard::take_from_bytes::<Head>(&bytes).ok()?;
    if head.magic != CACHE_MAGIC {
        return None;
    }
    postcard::take_from_bytes::<usize>(rest)
        .ok()
        .map(|(n, _)| n)
}

impl AnalysisCache {
    /// `{cache_dir}/analysis/{folderKey}.bin`.
    #[must_use]
    pub fn file_path(cache_dir: &Path, folder: &Path) -> PathBuf {
        dir(cache_dir).join(format!("{}.bin", folder_key(folder)))
    }

    /// An empty cache that will be written to the standard location.
    #[must_use]
    pub fn empty(cache_dir: &Path, folder: &Path, fingerprint: &str) -> Self {
        Self {
            file: Self::file_path(cache_dir, folder),
            fingerprint: fingerprint.to_owned(),
            folder: folder.to_string_lossy().into_owned(),
            entries: HashMap::new(),
            dirty: false,
        }
    }

    /// Loads the cache for `folder`; anything unusable yields an empty cache.
    #[must_use]
    pub fn load(cache_dir: &Path, folder: &Path, fingerprint: &str) -> (Self, LoadStatus) {
        let mut cache = Self::empty(cache_dir, folder, fingerprint);
        let bytes = match std::fs::read(&cache.file) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return (cache, LoadStatus::Missing);
            }
            Err(e) => {
                log::warn!("analysis cache {} unreadable: {e}", cache.file.display());
                return (cache, LoadStatus::Corrupt);
            }
        };
        match postcard::take_from_bytes::<Header>(&bytes) {
            Ok((h, _)) if h.magic == CACHE_MAGIC => {
                if h.format_version != CACHE_FORMAT_VERSION || h.engine_fingerprint != fingerprint {
                    log::info!(
                        "analysis cache {} is stale; rebuilding",
                        cache.file.display()
                    );
                    return (cache, LoadStatus::Stale);
                }
            }
            _ => {
                log::warn!("analysis cache {} has a bad header", cache.file.display());
                return (cache, LoadStatus::Corrupt);
            }
        }
        match postcard::from_bytes::<CacheFile>(&bytes) {
            Ok(file) => {
                cache.entries = file
                    .entries
                    .into_iter()
                    .map(|e| (e.rel_path.clone(), e))
                    .collect();
                touch(&cache.file);
                (cache, LoadStatus::Loaded)
            }
            Err(e) => {
                log::warn!("analysis cache {} is corrupt: {e}", cache.file.display());
                (cache, LoadStatus::Corrupt)
            }
        }
    }

    /// Cached analysis if `entry` is unchanged (same rel path, size, mtime).
    #[must_use]
    pub fn lookup(&self, entry: &FileEntry) -> Option<&PhotoAnalysis> {
        self.entries
            .get(&entry.rel_path)
            .filter(|c| c.size == entry.size && c.mtime_ns == entry.mtime_ns)
            .map(|c| &c.analysis)
    }

    /// Records a fresh analysis.
    pub fn insert(&mut self, entry: &FileEntry, analysis: PhotoAnalysis) {
        self.entries.insert(
            entry.rel_path.clone(),
            CacheEntry {
                rel_path: entry.rel_path.clone(),
                size: entry.size,
                mtime_ns: entry.mtime_ns,
                analysis,
            },
        );
        self.dirty = true;
    }

    /// Drops entries whose relative path is not in `keep`; returns how many.
    pub fn retain_paths(&mut self, keep: &HashSet<&str>) -> usize {
        let before = self.entries.len();
        self.entries.retain(|k, _| keep.contains(k.as_str()));
        let removed = before - self.entries.len();
        if removed > 0 {
            self.dirty = true;
        }
        removed
    }

    /// All entries (unordered).
    pub fn entries(&self) -> impl ExactSizeIterator<Item = &CacheEntry> {
        self.entries.values()
    }

    /// Consumes the cache, returning its entries sorted by relative path.
    #[must_use]
    pub fn into_entries(self) -> Vec<CacheEntry> {
        let mut v: Vec<CacheEntry> = self.entries.into_values().collect();
        v.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
        v
    }

    /// Engine fingerprint the cache belongs to.
    #[must_use]
    pub fn fingerprint(&self) -> &str {
        &self.fingerprint
    }

    /// Number of entries.
    #[must_use]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// True when there are no entries.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// True when there are unsaved changes.
    #[must_use]
    pub fn is_dirty(&self) -> bool {
        self.dirty
    }

    /// Location of the cache file.
    #[must_use]
    pub fn path(&self) -> &Path {
        &self.file
    }

    /// Writes the cache atomically if it has unsaved changes.
    ///
    /// # Errors
    /// [`EngineError::Io`] / [`EngineError::Internal`] on write or encode failure.
    pub fn save(&mut self) -> Result<()> {
        if !self.dirty {
            return Ok(());
        }
        let mut entries: Vec<&CacheEntry> = self.entries.values().collect();
        entries.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
        let file = CacheFileRef {
            magic: CACHE_MAGIC,
            format_version: CACHE_FORMAT_VERSION,
            engine_fingerprint: &self.fingerprint,
            folder: &self.folder,
            entries,
        };
        let bytes = postcard::to_stdvec(&file)
            .map_err(|e| EngineError::Internal(format!("encoding analysis cache: {e}")))?;
        write_atomic(&self.file, &bytes)?;
        self.dirty = false;
        Ok(())
    }

    /// Deletes the cache file (and clears memory). Returns `(entries, bytes)` removed.
    ///
    /// # Errors
    /// I/O errors other than "not found".
    pub fn delete(&mut self) -> Result<(usize, u64)> {
        let n = self.entries.len();
        self.entries.clear();
        self.dirty = false;
        let bytes = std::fs::metadata(&self.file).map(|m| m.len()).unwrap_or(0);
        match std::fs::remove_file(&self.file) {
            Ok(()) => Ok((n, bytes)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok((n, 0)),
            Err(e) => Err(EngineError::io(
                format!("deleting {}", self.file.display()),
                e,
            )),
        }
    }
}

/// Borrowing twin of [`CacheFile`] for zero-copy serialization.
#[derive(Serialize)]
struct CacheFileRef<'a> {
    magic: [u8; 4],
    format_version: u32,
    engine_fingerprint: &'a str,
    folder: &'a str,
    entries: Vec<&'a CacheEntry>,
}

/// Marks a cache file as used now (its modification time is its age).
fn touch(file: &Path) {
    let touched = std::fs::File::options()
        .write(true)
        .open(file)
        .and_then(|f| f.set_modified(std::time::SystemTime::now()));
    if let Err(e) = touched {
        log::debug!("could not refresh {}: {e}", file.display());
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::analysis::{FaceRecord, FailureKind, Outcome};
    use crate::dates::DateSource;
    use crate::geometry::{Point, Rect, Size};
    use crate::recognize::Embedding;
    use chrono::NaiveDate;

    pub(crate) fn analysis(faces: usize) -> PhotoAnalysis {
        let face = FaceRecord {
            bounds: Rect::new(0.1, 0.2, 0.3, 0.4),
            landmarks: [Point::new(0.3, 0.3); 5],
            score: 0.93,
            embedding: Embedding(vec![0.125; 128]),
        };
        PhotoAnalysis {
            oriented_size: Size::new(4032, 3024),
            taken_at: NaiveDate::from_ymd_opt(2014, 8, 15)
                .and_then(|d| d.and_hms_opt(14, 23, 26))
                .expect("date"),
            date_source: DateSource::Exif,
            outcome: if faces == 0 {
                Outcome::NoFace
            } else {
                Outcome::Faces {
                    faces: vec![face; faces],
                }
            },
        }
    }

    pub(crate) fn entry(rel: &str, size: u64, mtime: i64) -> FileEntry {
        FileEntry {
            path: PathBuf::from("/x").join(rel),
            rel_path: rel.into(),
            size,
            mtime_ns: mtime,
        }
    }

    #[test]
    fn round_trips_all_outcomes() {
        let dir = tempfile::tempdir().expect("tmp");
        let folder = dir.path().join("photos");
        let (mut c, status) = AnalysisCache::load(dir.path(), &folder, "fp1");
        assert_eq!(status, LoadStatus::Missing);
        c.insert(&entry("a.jpg", 10, 1), analysis(2));
        c.insert(&entry("b.jpg", 11, 2), analysis(0));
        let failed = PhotoAnalysis {
            outcome: Outcome::Failed {
                kind: FailureKind::DecodeFailed,
                message: "truncated".into(),
            },
            ..analysis(0)
        };
        c.insert(&entry("c.jpg", 12, 3), failed.clone());
        assert!(c.is_dirty());
        c.save().expect("save");
        assert!(!c.is_dirty());
        c.save().expect("no-op save");
        assert!(
            c.path()
                .ends_with(format!("analysis/{}.bin", folder_key(&folder)))
        );

        let (back, status) = AnalysisCache::load(dir.path(), &folder, "fp1");
        assert_eq!(status, LoadStatus::Loaded);
        assert_eq!(back.len(), 3);
        assert_eq!(back.entries().count(), 3);
        assert_eq!(back.fingerprint(), "fp1");
        let all = back.clone().into_entries();
        let rels: Vec<_> = all.iter().map(|e| e.rel_path.as_str()).collect();
        assert_eq!(rels, ["a.jpg", "b.jpg", "c.jpg"]);
        assert_eq!(back.lookup(&entry("a.jpg", 10, 1)), Some(&analysis(2)));
        assert_eq!(back.lookup(&entry("b.jpg", 11, 2)), Some(&analysis(0)));
        assert_eq!(back.lookup(&entry("c.jpg", 12, 3)), Some(&failed));
        assert_eq!(entry_count(back.path()), Some(3));
        assert_eq!(entry_count(&dir.path().join("missing.bin")), None);
        // ~2.5 KB per face entry at most.
        let size = std::fs::metadata(back.path()).expect("meta").len();
        assert!(size < 3 * 1024, "{size}");
    }

    #[test]
    fn invalidates_on_size_mtime_and_fingerprint() {
        let dir = tempfile::tempdir().expect("tmp");
        let folder = dir.path().join("p");
        let mut c = AnalysisCache::empty(dir.path(), &folder, "fp1");
        c.insert(&entry("a.jpg", 10, 1), analysis(1));
        c.save().expect("save");
        let (c, _) = AnalysisCache::load(dir.path(), &folder, "fp1");
        assert!(c.lookup(&entry("a.jpg", 10, 1)).is_some());
        assert!(c.lookup(&entry("a.jpg", 11, 1)).is_none(), "size changed");
        assert!(c.lookup(&entry("a.jpg", 10, 2)).is_none(), "mtime changed");
        assert!(c.lookup(&entry("b.jpg", 10, 1)).is_none(), "other file");
        let (stale, status) = AnalysisCache::load(dir.path(), &folder, "fp2");
        assert_eq!(status, LoadStatus::Stale);
        assert!(stale.is_empty());
    }

    #[test]
    fn corrupt_files_are_ignored() {
        let dir = tempfile::tempdir().expect("tmp");
        let folder = dir.path().join("p");
        let path = AnalysisCache::file_path(dir.path(), &folder);
        std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        std::fs::write(&path, b"garbage").expect("write");
        assert_eq!(
            AnalysisCache::load(dir.path(), &folder, "fp").1,
            LoadStatus::Corrupt
        );
        assert_eq!(entry_count(&path), None, "garbage has no entry count");
        let foreign = postcard::to_stdvec(&(*b"XXXX", 1u32, "fp", "f", 0usize)).expect("enc");
        std::fs::write(&path, foreign).expect("write");
        assert_eq!(entry_count(&path), None, "wrong magic");
        // Valid header, truncated body.
        let mut c = AnalysisCache::empty(dir.path(), &folder, "fp");
        c.insert(&entry("a.jpg", 1, 1), analysis(1));
        c.save().expect("save");
        let bytes = std::fs::read(&path).expect("read");
        std::fs::write(&path, &bytes[..bytes.len() - 40]).expect("truncate");
        assert_eq!(
            AnalysisCache::load(dir.path(), &folder, "fp").1,
            LoadStatus::Corrupt
        );
        // Old format version.
        let header = postcard::to_stdvec(&Header {
            magic: CACHE_MAGIC,
            format_version: 0,
            engine_fingerprint: "fp".into(),
        })
        .expect("hdr");
        std::fs::write(&path, header).expect("write");
        assert_eq!(
            AnalysisCache::load(dir.path(), &folder, "fp").1,
            LoadStatus::Stale
        );
        // A directory where the file should be.
        std::fs::remove_file(&path).expect("rm");
        std::fs::create_dir_all(&path).expect("mkdir");
        assert_eq!(
            AnalysisCache::load(dir.path(), &folder, "fp").1,
            LoadStatus::Corrupt
        );
    }

    #[test]
    fn retain_and_delete() {
        let dir = tempfile::tempdir().expect("tmp");
        let folder = dir.path().join("p");
        let mut c = AnalysisCache::empty(dir.path(), &folder, "fp");
        c.insert(&entry("a.jpg", 1, 1), analysis(1));
        c.insert(&entry("b.jpg", 1, 1), analysis(1));
        c.save().expect("save");
        let keep: HashSet<&str> = ["a.jpg"].into_iter().collect();
        assert_eq!(c.retain_paths(&keep), 1);
        assert_eq!(c.retain_paths(&keep), 0);
        assert!(c.is_dirty());
        c.save().expect("save");
        let (mut c, _) = AnalysisCache::load(dir.path(), &folder, "fp");
        assert_eq!(c.len(), 1);
        let (n, bytes) = c.delete().expect("delete");
        assert_eq!(n, 1);
        assert!(bytes > 0);
        assert!(c.is_empty());
        assert_eq!(c.delete().expect("again"), (0, 0));
    }

    pub(crate) fn age(path: &Path, days: u64) {
        let when = std::time::SystemTime::now() - std::time::Duration::from_secs(days * 86_400);
        std::fs::File::options()
            .write(true)
            .open(path)
            .and_then(|f| f.set_modified(when))
            .expect("set mtime");
    }

    #[cfg(unix)]
    #[test]
    fn a_read_only_cache_still_loads() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().expect("tmp");
        let folder = dir.path().join("f");
        let mut c = AnalysisCache::empty(dir.path(), &folder, "fp");
        c.insert(&entry("a.jpg", 1, 1), analysis(0));
        c.save().expect("save");
        std::fs::set_permissions(c.path(), std::fs::Permissions::from_mode(0o444)).expect("chmod");
        let (loaded, status) = AnalysisCache::load(dir.path(), &folder, "fp");
        assert_eq!(
            (status, loaded.len()),
            (LoadStatus::Loaded, 1),
            "age refresh is best effort"
        );
    }
}
