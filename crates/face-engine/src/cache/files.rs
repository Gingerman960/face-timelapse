//! Crash-safe and exclusive file writes shared by the caches, frame store
//! and exports: exclusive temporary names (never following a planted link),
//! atomic replace with or without fsync, and the JPEG wholeness checks that
//! readers of the non-fsynced image caches rely on.

use std::path::{Path, PathBuf};

use crate::error::{EngineError, Result};

/// Creates the first candidate path that does not exist yet, exclusively
/// (`O_CREAT | O_EXCL`: an existing file or a planted symlink is never
/// opened, so writes cannot be redirected).
///
/// # Errors
/// The last error when every candidate exists or creation fails otherwise.
pub fn create_exclusive(
    candidates: impl IntoIterator<Item = PathBuf>,
) -> std::io::Result<(PathBuf, std::fs::File)> {
    let mut last = std::io::Error::new(std::io::ErrorKind::AlreadyExists, "no candidate name");
    for path in candidates {
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(file) => return Ok((path, file)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => last = e,
            Err(e) => return Err(e),
        }
    }
    Err(last)
}

/// Hidden, unique temporary names next to `target`: `.{name}.{pid}-{n}.tmp`.
pub(crate) fn temp_names(target: &Path) -> impl Iterator<Item = PathBuf> + '_ {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let dir = target.parent().unwrap_or_else(|| Path::new("."));
    let name = target
        .file_name()
        .map_or_else(|| "file".into(), |n| n.to_string_lossy().into_owned());
    let pid = std::process::id();
    (0..64).map(move |_| {
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        dir.join(format!(".{name}.{pid}-{n}.tmp"))
    })
}

/// Whether `file_name` is a temporary file [`temp_names`] made in process
/// `pid` (`.{name}.{pid}-{n}.tmp`) — lets the app delete leftovers of a
/// crashed export in a folder it remembers, without touching other files.
#[must_use]
pub fn is_temp_name(file_name: &str, pid: u32) -> bool {
    let Some(rest) = file_name
        .strip_prefix('.')
        .and_then(|r| r.strip_suffix(".tmp"))
    else {
        return false;
    };
    let Some((name, seq)) = rest.rsplit_once(&format!(".{pid}-")) else {
        return false;
    };
    !name.is_empty() && !seq.is_empty() && seq.bytes().all(|b| b.is_ascii_digit())
}

/// Flushes a directory entry change (rename) to disk; best effort.
pub(crate) fn sync_dir(dir: &Path) {
    #[cfg(unix)]
    if let Ok(d) = std::fs::File::open(dir) {
        let _ = d.sync_all();
    }
    #[cfg(not(unix))]
    let _ = dir;
}

/// Writes `bytes` to `path` crash-safely: an exclusive temporary file in the
/// same directory, fsync, rename over the target, fsync of the directory.
/// For state that must survive a power loss (the analysis cache, frame
/// manifests, the session); image caches use [`write_atomic_cache`].
///
/// # Errors
/// [`EngineError::Io`] on failure (the temporary file is removed).
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    write_replacing(path, bytes, true)
}

/// Writes a rebuildable image cache file (thumbnails, aligned masters and
/// previews, protocol renders) atomically — an exclusive temporary file
/// renamed over the target, so readers never see a partial file while the
/// system runs — but without forcing it to disk. On macOS every fsync is a
/// full drive-cache flush: syncing each file cost the scan 13 % and align
/// 35 % of their throughput. After a power loss such a file may be empty or
/// cut short, so readers check it with [`is_whole_jpeg`] /
/// [`file_is_whole_jpeg`] and rebuild it.
///
/// # Errors
/// [`EngineError::Io`] on failure (the temporary file is removed).
pub fn write_atomic_cache(path: &Path, bytes: &[u8]) -> Result<()> {
    write_replacing(path, bytes, false)
}

fn write_replacing(path: &Path, bytes: &[u8], durable: bool) -> Result<()> {
    use std::io::Write as _;
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(dir)
        .map_err(|e| EngineError::io(format!("creating {}", dir.display()), e))?;
    let (tmp, mut file) = create_exclusive(temp_names(path))
        .map_err(|e| EngineError::io(format!("writing {}", path.display()), e))?;
    let written = file
        .write_all(bytes)
        .and_then(|()| if durable { file.sync_all() } else { Ok(()) });
    drop(file);
    if let Err(e) = written {
        let _ = std::fs::remove_file(&tmp);
        return Err(EngineError::io(format!("writing {}", path.display()), e));
    }
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        EngineError::io(format!("replacing {}", path.display()), e)
    })?;
    if durable {
        sync_dir(dir);
    }
    Ok(())
}

/// JPEG start-of-image marker.
const JPEG_SOI: [u8; 2] = [0xFF, 0xD8];
/// JPEG end-of-image marker (every encoder in this crate writes it last).
const JPEG_EOI: [u8; 2] = [0xFF, 0xD9];

/// Whether `bytes` look like a whole JPEG: starts with SOI and ends with
/// EOI. A cache file cut short or zero-filled by a power loss fails it.
#[must_use]
pub fn is_whole_jpeg(bytes: &[u8]) -> bool {
    bytes.len() >= 4 && bytes.starts_with(&JPEG_SOI) && bytes.ends_with(&JPEG_EOI)
}

/// [`is_whole_jpeg`] for a file, reading only its first and last two bytes.
#[must_use]
pub fn file_is_whole_jpeg(path: &Path) -> bool {
    use std::io::{Read as _, Seek as _, SeekFrom};
    let check = || -> std::io::Result<bool> {
        let mut f = std::fs::File::open(path)?;
        if f.metadata()?.len() < 4 {
            return Ok(false);
        }
        let (mut head, mut tail) = ([0u8; 2], [0u8; 2]);
        f.read_exact(&mut head)?;
        f.seek(SeekFrom::End(-2))?;
        f.read_exact(&mut tail)?;
        Ok(head == JPEG_SOI && tail == JPEG_EOI)
    };
    check().unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_writes_replace_atomically_and_torn_jpegs_are_recognised() {
        let dir = tempfile::tempdir().expect("tmp");
        let target = dir.path().join("t").join("a.jpg");
        let jpeg = crate::encode::jpeg(&crate::image::RgbImage::new(8, 8), 90).expect("jpeg");
        write_atomic_cache(&target, b"old").expect("write");
        write_atomic_cache(&target, &jpeg).expect("replace");
        assert_eq!(std::fs::read(&target).expect("read"), jpeg);
        let leftovers = std::fs::read_dir(target.parent().expect("dir"))
            .expect("list")
            .count();
        assert_eq!(leftovers, 1, "no temporary file left");
        assert!(is_whole_jpeg(&jpeg) && file_is_whole_jpeg(&target));
        for torn in [
            &jpeg[..jpeg.len() - 1],
            &jpeg[1..],
            &[][..],
            &[0xFF, 0xD8, 0xFF][..],
        ] {
            assert!(!is_whole_jpeg(torn));
            std::fs::write(&target, torn).expect("write");
            assert!(!file_is_whole_jpeg(&target));
        }
        std::fs::write(&target, vec![0u8; jpeg.len()]).expect("zeros");
        assert!(!file_is_whole_jpeg(&target), "zero-filled");
        assert!(!file_is_whole_jpeg(&dir.path().join("missing.jpg")));
        let blocker = dir.path().join("blocker");
        std::fs::write(&blocker, b"x").expect("file");
        assert!(write_atomic_cache(&blocker.join("f.jpg"), b"x").is_err());
    }

    #[test]
    fn temp_names_are_recognised_only_for_their_process() {
        let dir = tempfile::tempdir().expect("tempdir");
        let pid = std::process::id();
        let name = temp_names(&dir.path().join("20200101.png"))
            .next()
            .expect("a name")
            .file_name()
            .expect("file name")
            .to_string_lossy()
            .into_owned();
        assert!(is_temp_name(&name, pid), "{name}");
        assert!(!is_temp_name(&name, pid.wrapping_add(1)));
        assert!(is_temp_name(".a.png.7-12.tmp", 7));
        assert!(!is_temp_name("a.png.7-12.tmp", 7), "not hidden");
        assert!(!is_temp_name(".a.png.7-.tmp", 7));
        assert!(!is_temp_name(".a.png.7-1x.tmp", 7));
        assert!(!is_temp_name(".7-1.tmp", 7), "no file name");
        assert!(!is_temp_name(".a.png.7-1.partial", 7));
    }

    #[cfg(unix)]
    #[test]
    fn temp_files_never_follow_planted_symlinks() {
        let dir = tempfile::tempdir().expect("tmp");
        let victim = dir.path().join("victim.txt");
        std::fs::write(&victim, b"precious").expect("victim");
        let planted: Vec<PathBuf> = (0..3).map(|i| dir.path().join(format!(".t{i}"))).collect();
        for p in &planted {
            std::os::unix::fs::symlink(&victim, p).expect("symlink");
        }
        let candidates = planted
            .iter()
            .cloned()
            .chain(std::iter::once(dir.path().join(".t-free")));
        let (path, mut file) = create_exclusive(candidates).expect("free name");
        assert_eq!(path, dir.path().join(".t-free"));
        std::io::Write::write_all(&mut file, b"new").expect("write");
        assert_eq!(std::fs::read(&victim).expect("read"), b"precious");
        let none = create_exclusive(planted.iter().cloned()).expect_err("all taken");
        assert_eq!(none.kind(), std::io::ErrorKind::AlreadyExists);
        // write_atomic itself leaves no temp files and replaces the target.
        let target = dir.path().join("out.bin");
        write_atomic(&target, b"one").expect("write");
        write_atomic(&target, b"two").expect("write");
        assert_eq!(std::fs::read(&target).expect("read"), b"two");
    }

    #[test]
    fn write_atomic_replaces_and_reports_errors() {
        let dir = tempfile::tempdir().expect("tmp");
        let p = dir.path().join("sub/f.bin");
        write_atomic(&p, b"one").expect("write");
        write_atomic(&p, b"two").expect("rewrite");
        assert_eq!(std::fs::read(&p).expect("read"), b"two");
        // Parent is a file → cannot create the directory.
        let blocker = dir.path().join("blocker");
        std::fs::write(&blocker, b"x").expect("write");
        assert!(write_atomic(&blocker.join("f.bin"), b"x").is_err());
        // Target is a non-empty directory → rename fails, temp file removed.
        let target = dir.path().join("dir");
        std::fs::create_dir_all(target.join("inner")).expect("mkdir");
        assert!(write_atomic(&target, b"x").is_err());
        let leftovers = std::fs::read_dir(dir.path())
            .expect("ls")
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .count();
        assert_eq!(leftovers, 0);
    }
}
