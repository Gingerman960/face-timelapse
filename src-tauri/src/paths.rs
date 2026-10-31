//! On-disk layout (ARCHITECTURE.md §5).
//!
//! `FT_DATA_DIR=X` relocates data, cache and logs to `X/{data,cache,logs}`
//! (tests and smoke runs). The engine owns the layout of what it writes under
//! the cache root (`analysis/`, `thumbs/`, `frames/`); the shell owns
//! `session.json`, the logs, the protocol's `reference/` cache and `tmp/`.

use std::path::{Path, PathBuf};

use face_engine as fe;

/// Environment variable that relocates all app directories.
pub const DATA_DIR_ENV: &str = "FT_DATA_DIR";
/// Cache layout version; bump to orphan every cache file at once.
pub const CACHE_LAYOUT: &str = "v1";

/// Resolved application directories.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppPaths {
    /// `session.json` lives here.
    pub data_dir: PathBuf,
    /// Root of the versioned cache (`…/Caches/<id>/v1`).
    pub cache_dir: PathBuf,
    /// `facetimelapse.log` (+ rotations).
    pub log_dir: PathBuf,
    /// Directory holding `models/*.onnx` (bundle resources or the repo).
    pub models_dir: PathBuf,
}

impl AppPaths {
    /// All directories under one root (the `FT_DATA_DIR` layout).
    #[must_use]
    pub fn under_root(root: &Path, models_dir: PathBuf) -> Self {
        Self {
            data_dir: root.join("data"),
            cache_dir: root.join("cache").join(CACHE_LAYOUT),
            log_dir: root.join("logs"),
            models_dir,
        }
    }

    /// Platform directories, unless `FT_DATA_DIR` is set.
    #[must_use]
    pub fn from_platform(
        data_dir: PathBuf,
        cache_root: &Path,
        log_dir: PathBuf,
        models_dir: PathBuf,
    ) -> Self {
        match std::env::var_os(DATA_DIR_ENV).filter(|v| !v.is_empty()) {
            Some(root) => Self::under_root(Path::new(&root), models_dir),
            None => Self {
                data_dir,
                cache_dir: cache_root.join(CACHE_LAYOUT),
                log_dir,
                models_dir,
            },
        }
    }

    /// Creates every directory and empties `tmp/`. On Unix the data, cache
    /// and log folders are made private to the user (0700): they hold the
    /// session (photo paths), face embeddings and thumbnails.
    ///
    /// # Errors
    /// The first directory that could not be created or protected.
    pub fn prepare(&self) -> std::io::Result<()> {
        let tmp = self.tmp_dir();
        if tmp.exists() {
            std::fs::remove_dir_all(&tmp)?;
        }
        for dir in [
            &self.data_dir,
            &self.cache_dir,
            &self.log_dir,
            &fe::cache::dir(&self.cache_dir),
            &fe::thumbs::dir(&self.cache_dir),
            &fe::frames::root(&self.cache_dir),
            &self.reference_dir(),
            &tmp,
        ] {
            std::fs::create_dir_all(dir)?;
        }
        #[cfg(unix)]
        for dir in [&self.data_dir, &self.cache_dir, &self.log_dir] {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
        }
        Ok(())
    }

    #[must_use]
    pub fn session_file(&self) -> PathBuf {
        self.data_dir.join("session.json")
    }

    #[must_use]
    pub fn log_file(&self) -> PathBuf {
        self.log_dir.join("facetimelapse.log")
    }

    /// Protocol cache of reference images.
    #[must_use]
    pub fn reference_dir(&self) -> PathBuf {
        self.cache_dir.join("reference")
    }

    /// `reference/{refVersion}-{w}.jpg`.
    #[must_use]
    pub fn reference_file(&self, image_version: &str, width: u32) -> PathBuf {
        self.reference_dir()
            .join(format!("{image_version}-{width}.jpg"))
    }

    /// `reference/frame-{refStateVersion}-{w}.jpg`.
    #[must_use]
    pub fn reference_frame_file(&self, state_version: &str, width: u32) -> PathBuf {
        self.reference_dir()
            .join(format!("frame-{state_version}-{width}.jpg"))
    }

    /// `previews/`: `ftimg` previews of Review candidates (v1.7; bounded, LRU).
    #[must_use]
    pub fn preview_dir(&self) -> PathBuf {
        self.cache_dir.join("previews")
    }

    /// `previews/{photoId}-{previewVersion}-{w}.jpg`.
    #[must_use]
    pub fn preview_file(&self, photo_id: &str, version: &str, width: u32) -> PathBuf {
        self.preview_dir()
            .join(format!("{photo_id}-{version}-{width}.jpg"))
    }

    #[must_use]
    pub fn tmp_dir(&self) -> PathBuf {
        self.cache_dir.join("tmp")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn under_root_uses_data_cache_logs() {
        let p = AppPaths::under_root(Path::new("/x"), PathBuf::from("/m"));
        assert_eq!(p.data_dir, Path::new("/x/data"));
        assert_eq!(p.cache_dir, Path::new("/x/cache/v1"));
        assert_eq!(p.log_dir, Path::new("/x/logs"));
        assert_eq!(p.models_dir, Path::new("/m"));
        assert_eq!(p.session_file(), Path::new("/x/data/session.json"));
        assert_eq!(
            p.reference_file("r1", 640),
            Path::new("/x/cache/v1/reference/r1-640.jpg")
        );
        assert_eq!(
            p.reference_frame_file("s1", 320),
            Path::new("/x/cache/v1/reference/frame-s1-320.jpg")
        );
        assert_eq!(p.log_file(), Path::new("/x/logs/facetimelapse.log"));
    }

    #[test]
    fn prepare_creates_dirs_and_empties_tmp() {
        let root = tempfile::tempdir().expect("tempdir");
        let p = AppPaths::under_root(root.path(), PathBuf::new());
        p.prepare().expect("prepare");
        std::fs::write(p.tmp_dir().join("junk"), b"x").expect("write");
        p.prepare().expect("prepare again");
        assert!(fe::thumbs::dir(&p.cache_dir).is_dir());
        assert!(fe::frames::root(&p.cache_dir).is_dir());
        assert!(fe::cache::dir(&p.cache_dir).is_dir());
        assert_eq!(std::fs::read_dir(p.tmp_dir()).expect("tmp").count(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn app_dirs_are_private_to_the_user() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().expect("tempdir");
        let p = AppPaths::under_root(root.path(), PathBuf::new());
        // An older install created them world-readable.
        for d in [&p.data_dir, &p.cache_dir, &p.log_dir] {
            std::fs::create_dir_all(d).expect("mkdir");
            std::fs::set_permissions(d, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        }
        p.prepare().expect("prepare");
        for d in [&p.data_dir, &p.cache_dir, &p.log_dir] {
            let mode = std::fs::metadata(d).expect("meta").permissions().mode() & 0o777;
            assert_eq!(mode, 0o700, "{}", d.display());
        }
    }

    #[test]
    fn platform_dirs_get_versioned_cache() {
        // FT_DATA_DIR is not set in the unit-test environment by default.
        if std::env::var_os(DATA_DIR_ENV).is_some() {
            return;
        }
        let p = AppPaths::from_platform(
            PathBuf::from("/d"),
            Path::new("/c"),
            PathBuf::from("/l"),
            PathBuf::from("/m"),
        );
        assert_eq!(p.cache_dir, Path::new("/c/v1"));
        assert_eq!(p.data_dir, Path::new("/d"));
    }
}
