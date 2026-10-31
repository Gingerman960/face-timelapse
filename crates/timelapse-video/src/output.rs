//! Crash- and cancel-safe output: the video is written to a unique
//! `{name}.{pid}-{n}.partial` file next to the target (created exclusively,
//! so an existing file or planted link is never truncated or followed) and
//! atomically renamed into place on success. If encoding fails, is cancelled
//! or panics, that temporary file is deleted and any existing file at the
//! target path is left untouched.

use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::error::{Result, VideoError};

/// Suffix of the in-progress file (`{name}.{pid}-{n}.partial`).
pub const PARTIAL_SUFFIX: &str = ".partial";

/// Distinct names tried before giving up (only reached if all are taken).
const MAX_NAME_TRIES: usize = 64;

/// Per-process sequence making concurrent temp names distinct.
static SEQ: AtomicU64 = AtomicU64::new(0);

/// Whether `file_name` is a temporary file this crate creates for `target_name`
/// in process `pid` — lets an app delete leftovers of a crashed run (it knows
/// the target and the old pid) without touching anyone else's `.partial` files.
#[must_use]
pub fn is_partial_name(file_name: &str, target_name: &str, pid: u32) -> bool {
    file_name
        .strip_prefix(target_name)
        .and_then(|rest| rest.strip_prefix(&format!(".{pid}-")))
        .and_then(|rest| rest.strip_suffix(PARTIAL_SUFFIX))
        .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

/// A temporary output file next to the target that is removed on drop
/// unless committed.
#[derive(Debug)]
pub struct PartialFile {
    temp: PathBuf,
    target: PathBuf,
    committed: bool,
}

impl PartialFile {
    /// Creates a fresh, uniquely named temporary file next to the target.
    ///
    /// # Errors
    /// [`VideoError::InvalidOptions`] if the target is a directory or has no
    /// file name; [`VideoError::Io`] if the directory is missing or not writable.
    pub fn create(target: &Path) -> Result<(Self, File)> {
        let name = target
            .file_name()
            .filter(|n| !n.is_empty())
            .ok_or_else(|| {
                VideoError::InvalidOptions(format!("{} is not a file path", target.display()))
            })?;
        if target.is_dir() {
            return Err(VideoError::InvalidOptions(format!(
                "{} is a directory",
                target.display()
            )));
        }
        let pid = std::process::id();
        let io_err = |e| {
            let dir = target.parent().unwrap_or_else(|| Path::new("."));
            VideoError::io(
                format!("cannot create the video file in {}", dir.display()),
                e,
            )
        };
        let mut last = std::io::Error::new(std::io::ErrorKind::AlreadyExists, "no free name");
        for _ in 0..MAX_NAME_TRIES {
            let n = SEQ.fetch_add(1, Ordering::Relaxed);
            let mut temp_name = name.to_os_string();
            temp_name.push(format!(".{pid}-{n}{PARTIAL_SUFFIX}"));
            let temp = target.with_file_name(temp_name);
            match OpenOptions::new().write(true).create_new(true).open(&temp) {
                Ok(file) => {
                    let guard = Self {
                        temp,
                        target: target.to_path_buf(),
                        committed: false,
                    };
                    return Ok((guard, file));
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => last = e,
                Err(e) => return Err(io_err(e)),
            }
        }
        Err(io_err(last))
    }

    /// Path of the temporary file.
    #[must_use]
    pub fn temp_path(&self) -> &Path {
        &self.temp
    }

    /// Flushes `file` to disk and renames the temporary file onto the target
    /// (replacing an existing file atomically). Returns the final size.
    ///
    /// # Errors
    /// [`VideoError::Io`] if syncing or renaming fails (the temp file is then removed).
    pub fn commit(mut self, file: File) -> Result<u64> {
        file.sync_all()
            .map_err(|e| VideoError::io("flushing the video to disk", e))?;
        let size = file
            .metadata()
            .map_err(|e| VideoError::io("reading the video size", e))?
            .len();
        drop(file);
        std::fs::rename(&self.temp, &self.target).map_err(|e| {
            VideoError::io(format!("saving the video to {}", self.target.display()), e)
        })?;
        self.committed = true;
        sync_parent(&self.target);
        Ok(size)
    }
}

impl PartialFile {
    /// Like [`PartialFile::commit`] but never replaces anything: the video
    /// goes to the target, or — if a file appeared there meanwhile — to the
    /// first free `{stem}_{n}.{ext}`. Placement is a hard link (atomic, fails
    /// on an existing name); where links are unsupported (FAT, some shares)
    /// the name is checked and renamed onto. Returns the path and size.
    ///
    /// # Errors
    /// [`VideoError::Io`] if syncing or placing fails (the temp file is then removed).
    pub fn commit_new(self, file: File) -> Result<Committed> {
        self.commit_new_with(file, &|from, to| std::fs::hard_link(from, to))
    }

    /// [`PartialFile::commit_new`] with the link function supplied (tests
    /// drive the no-link fallback through it). Not generic, so production and
    /// tests run one copy of the code.
    fn commit_new_with(
        mut self,
        file: File,
        link: &dyn Fn(&Path, &Path) -> std::io::Result<()>,
    ) -> Result<Committed> {
        file.sync_all()
            .map_err(|e| VideoError::io("flushing the video to disk", e))?;
        let size = file
            .metadata()
            .map_err(|e| VideoError::io("reading the video size", e))?
            .len();
        drop(file);
        let stem = self
            .target
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let ext = self
            .target
            .extension()
            .map(|e| format!(".{}", e.to_string_lossy()))
            .unwrap_or_default();
        let io_err =
            |e| VideoError::io(format!("saving the video to {}", self.target.display()), e);
        let candidates = std::iter::once(self.target.clone())
            .chain((1u32..10_000).map(|n| self.target.with_file_name(format!("{stem}_{n}{ext}"))));
        let mut links = true;
        for candidate in candidates {
            if links {
                match link(&self.temp, &candidate) {
                    Ok(()) => {
                        self.committed = true;
                        sync_parent(&candidate);
                        // A second name for the same data; if it can't go,
                        // say so (the app keeps its cleanup record).
                        let leftover = std::fs::remove_file(&self.temp)
                            .err()
                            .map(|_| self.temp.clone());
                        return Ok(Committed {
                            path: candidate,
                            size,
                            leftover,
                        });
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                    Err(_) => links = false,
                }
            }
            // No hard links (FAT/exFAT, some shares): claim the name with an
            // exclusive create — so a file already there is never touched —
            // then rename onto our own empty placeholder. The only residual
            // window: another process deleting that placeholder and creating
            // a file of the same name between the two calls.
            match OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&candidate)
            {
                Ok(placeholder) => drop(placeholder),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(io_err(e)),
            }
            if let Err(e) = std::fs::rename(&self.temp, &candidate) {
                let _ = std::fs::remove_file(&candidate);
                return Err(io_err(e));
            }
            self.committed = true;
            sync_parent(&candidate);
            return Ok(Committed {
                path: candidate,
                size,
                leftover: None,
            });
        }
        Err(VideoError::io(
            "saving the video",
            std::io::Error::new(std::io::ErrorKind::AlreadyExists, "no free file name"),
        ))
    }
}

/// Where [`PartialFile::commit_new`] put the video.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Committed {
    /// The final path (the target, or `{stem}_{n}.{ext}`).
    pub path: PathBuf,
    /// Size in bytes.
    pub size: u64,
    /// The temporary name, if it could not be removed after placing.
    pub leftover: Option<PathBuf>,
}

/// Flushes the rename to disk (best effort; a no-op off Unix).
fn sync_parent(path: &Path) {
    #[cfg(unix)]
    if let Some(Ok(dir)) = path.parent().map(File::open) {
        let _ = dir.sync_all();
    }
    #[cfg(not(unix))]
    let _ = path;
}

impl Drop for PartialFile {
    fn drop(&mut self) {
        if !self.committed {
            // Best effort: the file may already be gone; nothing else to do.
            let _ = std::fs::remove_file(&self.temp);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn commit_renames_atomically_and_replaces_existing() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("out.mp4");
        std::fs::write(&target, b"old").unwrap();
        let (partial, mut file) = PartialFile::create(&target).unwrap();
        let temp = partial.temp_path().to_path_buf();
        assert_eq!(temp.parent(), Some(dir.path()));
        let temp_name = temp.file_name().unwrap().to_str().unwrap();
        assert!(
            is_partial_name(temp_name, "out.mp4", std::process::id()),
            "{temp_name}"
        );
        file.write_all(b"new video").unwrap();
        // Until commit, the old file is intact.
        assert_eq!(std::fs::read(&target).unwrap(), b"old");
        assert_eq!(partial.commit(file).unwrap(), 9);
        assert_eq!(std::fs::read(&target).unwrap(), b"new video");
        assert!(!temp.exists());
    }

    #[test]
    fn dropping_without_commit_removes_the_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("cancelled.mp4");
        let (partial, mut file) = PartialFile::create(&target).unwrap();
        file.write_all(b"partial").unwrap();
        let temp = partial.temp_path().to_path_buf();
        assert!(temp.exists());
        drop(file);
        drop(partial);
        assert!(!temp.exists());
        assert!(!target.exists());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn rejects_directories_and_missing_parents() {
        let dir = tempfile::tempdir().unwrap();
        let err = PartialFile::create(dir.path()).unwrap_err();
        assert!(matches!(err, VideoError::InvalidOptions(_)), "{err}");
        let err = PartialFile::create(&dir.path().join("nope/out.mp4")).unwrap_err();
        assert!(matches!(err, VideoError::Io { .. }), "{err}");
        assert!(PartialFile::create(Path::new("/")).is_err());
    }

    #[test]
    fn unrelated_partial_files_are_never_truncated_or_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("a.mp4");
        let foreign = dir.path().join("a.mp4.partial");
        std::fs::write(&foreign, b"someone else's download").unwrap();
        // Cancelled run: our own temp goes, the foreign file stays.
        let (partial, file) = PartialFile::create(&target).unwrap();
        assert_ne!(partial.temp_path(), foreign);
        drop(file);
        drop(partial);
        // Committed run: likewise.
        let (partial, mut file) = PartialFile::create(&target).unwrap();
        file.write_all(b"ok").unwrap();
        assert_eq!(partial.commit(file).unwrap(), 2);
        assert_eq!(std::fs::read(&target).unwrap(), b"ok");
        assert_eq!(std::fs::read(&foreign).unwrap(), b"someone else's download");
    }

    #[test]
    fn concurrent_writers_get_distinct_exclusive_temp_files() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("same.mp4");
        let (a, mut fa) = PartialFile::create(&target).unwrap();
        let (b, mut fb) = PartialFile::create(&target).unwrap();
        assert_ne!(a.temp_path(), b.temp_path());
        fa.write_all(b"aaaa").unwrap();
        fb.write_all(b"bb").unwrap();
        assert_eq!(std::fs::read(a.temp_path()).unwrap(), b"aaaa");
        assert_eq!(std::fs::read(b.temp_path()).unwrap(), b"bb");
    }

    #[cfg(unix)]
    #[test]
    fn temp_files_never_follow_planted_symlinks() {
        let dir = tempfile::tempdir().unwrap();
        let victim = dir.path().join("victim.txt");
        std::fs::write(&victim, b"precious").unwrap();
        let target = dir.path().join("v.mp4");
        // Plant links at every name this process could pick next.
        let pid = std::process::id();
        let next = SEQ.load(std::sync::atomic::Ordering::Relaxed);
        for n in next..next + 8 {
            let _ = std::os::unix::fs::symlink(
                &victim,
                dir.path().join(format!("v.mp4.{pid}-{n}.partial")),
            );
        }
        let (partial, mut file) = PartialFile::create(&target).unwrap();
        file.write_all(b"video").unwrap();
        assert_eq!(partial.commit(file).unwrap(), 5);
        assert_eq!(std::fs::read(&victim).unwrap(), b"precious");
        assert_eq!(std::fs::read(&target).unwrap(), b"video");
    }

    #[test]
    fn committing_without_replace_never_touches_a_file_that_appeared() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("v.mp4");
        // Nothing there: placed at the target.
        let (partial, mut file) = PartialFile::create(&target).unwrap();
        file.write_all(b"first").unwrap();
        let c = partial.commit_new(file).unwrap();
        assert_eq!((c.path.as_path(), c.size), (target.as_path(), 5));
        // Someone else's file appeared there during the encode: kept.
        let (partial, mut file) = PartialFile::create(&target).unwrap();
        let temp = partial.temp_path().to_path_buf();
        file.write_all(b"second").unwrap();
        let path = partial.commit_new(file).unwrap().path;
        assert_eq!(path, dir.path().join("v_1.mp4"));
        assert_eq!(std::fs::read(&target).unwrap(), b"first");
        assert_eq!(std::fs::read(&path).unwrap(), b"second");
        assert!(!temp.exists(), "no temporary file left");
    }

    #[test]
    fn without_hard_links_a_free_name_is_checked_then_renamed_onto() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("v.mp4");
        std::fs::write(&target, b"theirs").unwrap();
        let no_links =
            |_: &Path, _: &Path| Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "FAT"));
        let (partial, mut file) = PartialFile::create(&target).unwrap();
        file.write_all(b"ours").unwrap();
        let path = partial.commit_new_with(file, &no_links).unwrap().path;
        assert_eq!(path, dir.path().join("v_1.mp4"));
        assert_eq!(std::fs::read(&target).unwrap(), b"theirs");
        assert_eq!(std::fs::read(&path).unwrap(), b"ours");
        // Every name taken: an error, and the temporary file is removed.
        let taken =
            |_: &Path, _: &Path| Err(std::io::Error::from(std::io::ErrorKind::AlreadyExists));
        let (partial, file) = PartialFile::create(&target).unwrap();
        let temp = partial.temp_path().to_path_buf();
        let err = partial.commit_new_with(file, &taken).unwrap_err();
        assert!(err.to_string().contains("no free file name"), "{err}");
        assert!(!temp.exists());
    }

    #[test]
    fn failed_commits_report_the_error_and_leave_no_temporary_file() {
        let dir = tempfile::tempdir().unwrap();
        // The target turned into a non-empty folder: the rename fails.
        let target = dir.path().join("v.mp4");
        let (partial, file) = PartialFile::create(&target).unwrap();
        let temp = partial.temp_path().to_path_buf();
        std::fs::create_dir_all(target.join("inner")).unwrap();
        assert!(matches!(
            partial.commit(file).unwrap_err(),
            VideoError::Io { .. }
        ));
        assert!(!temp.exists());
        // No links and the folder vanished: placing fails cleanly too.
        let sub = dir.path().join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        let (partial, file) = PartialFile::create(&sub.join("w.mp4")).unwrap();
        std::fs::remove_dir_all(&sub).unwrap();
        let no_links =
            |_: &Path, _: &Path| Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "FAT"));
        assert!(matches!(
            partial.commit_new_with(file, &no_links).unwrap_err(),
            VideoError::Io { .. }
        ));
    }

    #[cfg(unix)]
    #[test]
    fn a_temporary_name_that_cannot_be_removed_is_reported() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("out");
        std::fs::create_dir_all(&sub).unwrap();
        let (partial, mut file) = PartialFile::create(&sub.join("v.mp4")).unwrap();
        file.write_all(b"video").unwrap();
        // Link, then lock the folder: the temporary name can't be unlinked.
        let link_then_lock = |from: &Path, to: &Path| {
            std::fs::hard_link(from, to)?;
            std::fs::set_permissions(to.parent().unwrap(), std::fs::Permissions::from_mode(0o555))
        };
        let placed = partial.commit_new_with(file, &link_then_lock).unwrap();
        std::fs::set_permissions(&sub, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(placed.path, sub.join("v.mp4"));
        let leftover = placed
            .leftover
            .expect("reported, so the app keeps its cleanup record");
        assert!(leftover.exists());
    }

    #[test]
    fn partial_names_are_recognised_only_for_the_given_target_and_process() {
        assert!(is_partial_name("a.mp4.42-0.partial", "a.mp4", 42));
        assert!(is_partial_name("a.mp4.42-1234.partial", "a.mp4", 42));
        assert!(!is_partial_name("a.mp4.partial", "a.mp4", 42));
        assert!(!is_partial_name("a.mp4.43-0.partial", "a.mp4", 42));
        assert!(!is_partial_name("b.mp4.42-0.partial", "a.mp4", 42));
        assert!(!is_partial_name("a.mp4.42-x.partial", "a.mp4", 42));
        assert!(!is_partial_name("a.mp4.42-.partial", "a.mp4", 42));
        assert!(!is_partial_name("a.mp4.42-0.tmp", "a.mp4", 42));
    }
}
