//! Folder walk (ARCHITECTURE §9.1) and stable file identities (§5 keys).
//!
//! - recursive; names starting with `.` are skipped (files and directories);
//! - directory symlinks are not followed, file symlinks are accepted;
//! - `.jpg .jpeg .png .tif .tiff .webp` are supported, `.heic .heif` are
//!   reported separately as unsupported (case-insensitive);
//! - natural sort by relative path (`IMG_2` before `IMG_10`).

use std::cmp::Ordering;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};

use crate::error::{EngineError, Result};

/// Extensions the engine decodes.
pub const SUPPORTED_EXTENSIONS: [&str; 6] = ["jpg", "jpeg", "png", "tif", "tiff", "webp"];
/// Extensions that are counted but cannot be decoded (no pure-Rust HEVC).
pub const UNSUPPORTED_EXTENSIONS: [&str; 2] = ["heic", "heif"];

/// One image file found by [`walk`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    /// Absolute path (root joined with `rel_path`).
    pub path: PathBuf,
    /// Path relative to the walked root, `/`-separated.
    pub rel_path: String,
    /// File size in bytes.
    pub size: u64,
    /// Modification time, nanoseconds since the Unix epoch (0 if unknown).
    pub mtime_ns: i64,
}

impl FileEntry {
    /// File name component.
    #[must_use]
    pub fn file_name(&self) -> &str {
        self.rel_path.rsplit('/').next().unwrap_or(&self.rel_path)
    }

    /// [`photo_id`] of this file.
    #[must_use]
    pub fn id(&self) -> String {
        photo_id(&self.path)
    }

    /// [`photo_version`] of this file.
    #[must_use]
    pub fn version(&self) -> String {
        photo_version(self.size, self.mtime_ns)
    }
}

/// Result of walking a folder.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WalkResult {
    /// Canonical root folder.
    pub root: PathBuf,
    /// Supported images, natural-sorted by `rel_path`.
    pub files: Vec<FileEntry>,
    /// HEIC/HEIF files (counted, never analyzed), natural-sorted.
    pub unsupported: Vec<FileEntry>,
}

/// Classification of a file name by extension.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileKind {
    /// Decodable image.
    Supported,
    /// Image the engine recognises but cannot decode (HEIC/HEIF).
    Unsupported,
    /// Not an image.
    Other,
}

/// Classifies `name` by its (case-insensitive) extension.
#[must_use]
pub fn classify(name: &str) -> FileKind {
    let Some((_, ext)) = name.rsplit_once('.') else {
        return FileKind::Other;
    };
    let ext = ext.to_ascii_lowercase();
    if SUPPORTED_EXTENSIONS.contains(&ext.as_str()) {
        FileKind::Supported
    } else if UNSUPPORTED_EXTENSIONS.contains(&ext.as_str()) {
        FileKind::Unsupported
    } else {
        FileKind::Other
    }
}

/// Walks `root` recursively (see module docs).
///
/// # Errors
/// [`EngineError::Io`] if `root` does not exist or is not a readable
/// directory. Unreadable sub-directories are skipped (logged at debug level).
pub fn walk(root: &Path) -> Result<WalkResult> {
    let canonical = root
        .canonicalize()
        .map_err(|e| EngineError::io(format!("opening folder {}", root.display()), e))?;
    if !canonical.is_dir() {
        return Err(EngineError::InvalidArgument(format!(
            "{} is not a folder",
            root.display()
        )));
    }
    let mut result = WalkResult {
        root: canonical.clone(),
        ..WalkResult::default()
    };
    // Surface permission problems on the root itself; deeper ones are skipped.
    std::fs::read_dir(&canonical)
        .map_err(|e| EngineError::io(format!("reading folder {}", root.display()), e))?;
    walk_dir(&canonical, "", &mut result);
    result
        .files
        .sort_by(|a, b| natural_cmp(&a.rel_path, &b.rel_path));
    result
        .unsupported
        .sort_by(|a, b| natural_cmp(&a.rel_path, &b.rel_path));
    Ok(result)
}

fn walk_dir(dir: &Path, rel_prefix: &str, out: &mut WalkResult) {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(err) => {
            log::debug!("skipping unreadable folder {}: {err}", dir.display());
            return;
        }
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            log::debug!("skipping non-UTF-8 name in {}", dir.display());
            continue;
        };
        if name.starts_with('.') {
            continue;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        let rel = if rel_prefix.is_empty() {
            name.to_owned()
        } else {
            format!("{rel_prefix}/{name}")
        };
        if file_type.is_dir() {
            walk_dir(&path, &rel, out);
            continue;
        }
        if !(file_type.is_file() || file_type.is_symlink()) {
            continue;
        }
        let kind = classify(name);
        if kind == FileKind::Other {
            continue;
        }
        // `metadata` follows symlinks: directory symlinks and broken links drop out here.
        let Ok(meta) = std::fs::metadata(&path) else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        let entry = FileEntry {
            path,
            rel_path: rel,
            size: meta.len(),
            mtime_ns: mtime_ns(&meta),
        };
        match kind {
            FileKind::Supported => out.files.push(entry),
            FileKind::Unsupported => out.unsupported.push(entry),
            FileKind::Other => {}
        }
    }
}

/// Modification time in nanoseconds since the Unix epoch (0 if unavailable).
#[must_use]
pub fn mtime_ns(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| match t.duration_since(UNIX_EPOCH) {
            Ok(d) => i64::try_from(d.as_nanos()).ok(),
            Err(e) => i64::try_from(e.duration().as_nanos()).ok().map(|n| -n),
        })
        .unwrap_or(0)
}

/// Builds a [`FileEntry`] for a single file (e.g. a manually added photo).
///
/// # Errors
/// [`EngineError::Io`] if the file cannot be stat'ed.
pub fn entry_for(path: &Path) -> Result<FileEntry> {
    let meta = std::fs::metadata(path)
        .map_err(|e| EngineError::io(format!("reading {}", path.display()), e))?;
    if !meta.is_file() {
        return Err(EngineError::InvalidArgument(format!(
            "{} is not a file",
            path.display()
        )));
    }
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_owned();
    Ok(FileEntry {
        path: path.to_path_buf(),
        rel_path: name,
        size: meta.len(),
        mtime_ns: mtime_ns(&meta),
    })
}

/// `hex(blake3(canonical absolute path))[0..16]` — stable photo id.
///
/// `path` must already be canonical: [`walk`] entries are (canonical root +
/// relative path), user-picked files are canonicalized once at the boundary.
/// Hashing as given (no per-file `realpath`) keeps restores fast and gives two
/// symlinks to the same file two distinct ids, so library ids never collide.
#[must_use]
pub fn photo_id(path: &Path) -> String {
    hex_prefix(path_bytes(path).as_slice(), 16)
}

/// `hex(blake3(canonical folder path))[0..16]` — analysis cache file key
/// (`folder` must be canonical, as returned in [`WalkResult::root`]).
#[must_use]
pub fn folder_key(folder: &Path) -> String {
    photo_id(folder)
}

/// File size and modification time (ns), the inputs of [`photo_version`].
///
/// # Errors
/// The metadata error.
pub fn file_stamp(path: &Path) -> std::io::Result<(u64, i64)> {
    let meta = std::fs::metadata(path)?;
    Ok((meta.len(), mtime_ns(&meta)))
}

/// `hex(blake3(size ‖ mtimeNs))[0..8]` — changes whenever the file changes.
#[must_use]
pub fn photo_version(size: u64, mtime_ns: i64) -> String {
    let mut bytes = [0u8; 16];
    bytes[..8].copy_from_slice(&size.to_le_bytes());
    bytes[8..].copy_from_slice(&mtime_ns.to_le_bytes());
    hex_prefix(&bytes, 8)
}

/// First `chars` lowercase hex chars of `blake3(bytes)`.
#[must_use]
pub fn hex_prefix(bytes: &[u8], chars: usize) -> String {
    let hash = blake3::hash(bytes);
    let mut hex = hash.to_hex().to_string();
    hex.truncate(chars);
    hex
}

fn path_bytes(path: &Path) -> Vec<u8> {
    path.to_string_lossy().as_bytes().to_vec()
}

/// Natural ordering: digit runs compare numerically, other characters
/// case-insensitively; ties fall back to a byte comparison.
#[must_use]
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    let (mut ai, mut bi) = (a.char_indices().peekable(), b.char_indices().peekable());
    // First difference in leading zeros ("2" vs "02"), used only on a full tie.
    let mut zeros_tiebreak = Ordering::Equal;
    loop {
        match (ai.peek().copied(), bi.peek().copied()) {
            (None, None) => return zeros_tiebreak.then_with(|| a.cmp(b)),
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some((_, ca)), Some((_, cb))) => {
                if ca.is_ascii_digit() && cb.is_ascii_digit() {
                    let na = take_digits(&mut ai);
                    let nb = take_digits(&mut bi);
                    let ord = cmp_digit_runs(&na, &nb);
                    if ord != Ordering::Equal {
                        return ord;
                    }
                    if zeros_tiebreak == Ordering::Equal {
                        zeros_tiebreak = na.len().cmp(&nb.len());
                    }
                } else {
                    let (la, lb) = (ca.to_lowercase().next(), cb.to_lowercase().next());
                    if la != lb {
                        return la.cmp(&lb);
                    }
                    ai.next();
                    bi.next();
                }
            }
        }
    }
}

fn take_digits(it: &mut std::iter::Peekable<std::str::CharIndices<'_>>) -> String {
    let mut s = String::new();
    while let Some(&(_, c)) = it.peek() {
        if !c.is_ascii_digit() {
            break;
        }
        s.push(c);
        it.next();
    }
    s
}

fn cmp_digit_runs(a: &str, b: &str) -> Ordering {
    let ta = a.trim_start_matches('0');
    let tb = b.trim_start_matches('0');
    ta.len().cmp(&tb.len()).then_with(|| ta.cmp(tb))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn touch(path: &Path) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("mkdir");
        }
        std::fs::write(path, b"x").expect("write");
    }

    #[test]
    fn classifies_extensions_case_insensitively() {
        for name in [
            "a.jpg", "b.JPG", "c.jpeg", "d.PNG", "e.tif", "f.TIFF", "g.webp",
        ] {
            assert_eq!(classify(name), FileKind::Supported, "{name}");
        }
        for name in ["a.heic", "b.HEIF"] {
            assert_eq!(classify(name), FileKind::Unsupported, "{name}");
        }
        for name in ["desktop.ini", "fix_photo_dates.py", "noext", "a.gif"] {
            assert_eq!(classify(name), FileKind::Other, "{name}");
        }
    }

    #[test]
    fn walks_recursively_skipping_dotfiles_and_sorting_naturally() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        for rel in [
            "IMG_10.jpg",
            "IMG_2.JPG",
            "sub/b.png",
            "sub/deeper/c.webp",
            ".hidden.jpg",
            ".git/d.jpg",
            "notes.txt",
            "phone.HEIC",
        ] {
            touch(&root.join(rel));
        }
        let res = walk(root).expect("walk");
        let rels: Vec<_> = res.files.iter().map(|f| f.rel_path.as_str()).collect();
        assert_eq!(
            rels,
            ["IMG_2.JPG", "IMG_10.jpg", "sub/b.png", "sub/deeper/c.webp"]
        );
        assert_eq!(res.unsupported.len(), 1);
        assert_eq!(res.unsupported[0].file_name(), "phone.HEIC");
        let first = &res.files[0];
        assert_eq!(first.size, 1);
        assert!(first.mtime_ns > 0);
        assert_eq!(first.file_name(), "IMG_2.JPG");
        assert!(first.path.is_absolute());
        assert_eq!(res.root, root.canonicalize().expect("canon"));
    }

    #[cfg(unix)]
    #[test]
    fn follows_file_symlinks_but_not_directory_symlinks() {
        let dir = tempfile::tempdir().expect("tempdir");
        let outside = tempfile::tempdir().expect("tempdir");
        touch(&outside.path().join("target.jpg"));
        touch(&outside.path().join("inner/x.jpg"));
        std::os::unix::fs::symlink(
            outside.path().join("target.jpg"),
            dir.path().join("link.jpg"),
        )
        .expect("symlink");
        std::os::unix::fs::symlink(outside.path().join("inner"), dir.path().join("dirlink"))
            .expect("symlink");
        std::os::unix::fs::symlink(
            dir.path().join("missing.jpg"),
            dir.path().join("broken.jpg"),
        )
        .expect("symlink");
        let res = walk(dir.path()).expect("walk");
        let rels: Vec<_> = res.files.iter().map(|f| f.rel_path.as_str()).collect();
        assert_eq!(rels, ["link.jpg"]);
    }

    #[test]
    fn walk_errors_on_missing_or_file_root() {
        let dir = tempfile::tempdir().expect("tempdir");
        let missing = walk(&dir.path().join("nope")).expect_err("missing");
        assert_eq!(missing.kind(), crate::ErrorKind::NotFound);
        let file = dir.path().join("f.jpg");
        touch(&file);
        assert_eq!(
            walk(&file).expect_err("file").kind(),
            crate::ErrorKind::InvalidArgument
        );
    }

    #[test]
    fn ids_are_stable_and_versions_track_changes() {
        let dir = tempfile::tempdir().expect("tempdir");
        let file = dir.path().join("a.jpg");
        touch(&file);
        let id = photo_id(&file);
        assert_eq!(id.len(), 16);
        assert!(
            id.chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        );
        assert_eq!(id, photo_id(&file), "stable");
        // Ids hash the path as given: callers canonicalize once at the boundary.
        let indirect = dir.path().join(".").join("a.jpg");
        assert_eq!(
            photo_id(&indirect.canonicalize().expect("canon")),
            photo_id(&file.canonicalize().expect("canon"))
        );
        assert_ne!(photo_id(&dir.path().join("b.jpg")), id);
        assert_eq!(folder_key(dir.path()).len(), 16);
        assert_eq!(folder_key(dir.path()), photo_id(dir.path()));
        // Known value (pins the formula: the shell persists ids in session.json).
        assert_eq!(photo_id(Path::new("/photos/IMG_1.jpg")).len(), 16);
        assert_ne!(
            photo_id(Path::new("/photos/IMG_1.jpg")),
            photo_id(Path::new("/photos/IMG_2.jpg"))
        );
        let (size, mtime) = file_stamp(&file).expect("stamp");
        assert_eq!((size, mtime), (1, entry_for(&file).expect("e").mtime_ns));
        assert!(file_stamp(&dir.path().join("missing")).is_err());

        let v1 = photo_version(100, 5);
        assert_eq!(v1.len(), 8);
        assert_eq!(v1, photo_version(100, 5));
        assert_ne!(v1, photo_version(101, 5));
        assert_ne!(v1, photo_version(100, 6));

        let entry = entry_for(&file).expect("entry");
        assert_eq!(entry.id(), id);
        assert_eq!(entry.version(), photo_version(entry.size, entry.mtime_ns));
        assert!(entry_for(dir.path()).is_err());
        assert!(entry_for(&dir.path().join("zzz.jpg")).is_err());
    }

    #[test]
    fn natural_order() {
        let mut v = vec!["a10", "a2", "A1", "a02", "b", "a", "a2b", "10", "9"];
        v.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(v, ["9", "10", "a", "A1", "a2", "a02", "a2b", "a10", "b"]);
        assert_eq!(natural_cmp("x", "x"), Ordering::Equal);
        assert_eq!(natural_cmp("IMG_20140815", "IMG_20140816"), Ordering::Less);
    }
}
