//! Cache pruning (ARCHITECTURE.md §5), run once ~10 s after startup on a
//! background thread with the engine's prune functions: analysis files
//! unused for 90 days (never those of the current, remembered or recent
//! folders), all but the 3 most recent fingerprints under `frames/`,
//! `thumbs/` LRU down to 1.5 GB when above 2 GB, `previews/` LRU down to
//! 192 MB when above 256 MB, `look-*` folders of looks
//! other than the current one, and `reference/` images of older reference
//! versions.

use std::path::{Path, PathBuf};
use std::time::Duration;

use face_engine as fe;

use crate::session::frames::look_key;
use crate::state::Core;

pub const ANALYSIS_MAX_AGE: Duration = Duration::from_secs(90 * 24 * 3600);
pub const KEEP_FINGERPRINTS: usize = 3;
pub const THUMBS_HIGH: u64 = 2 * 1024 * 1024 * 1024;
pub const THUMBS_LOW: u64 = 1536 * 1024 * 1024;

/// What a prune pass removed.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Pruned {
    pub analysis_files: usize,
    pub fingerprints: usize,
    pub thumb_bytes: u64,
    /// `previews/` (v1.7) beyond its bound, oldest first.
    pub preview_bytes: u64,
    pub look_dirs: usize,
    pub reference_files: usize,
}

/// Folders whose analysis caches are kept regardless of age: the current
/// folder, folders with remembered decisions, and recent folders.
fn kept_folders(s: &crate::session::Session) -> Vec<PathBuf> {
    s.p.folder
        .iter()
        .chain(s.p.folders.keys())
        .chain(&s.p.recents.folders)
        .map(PathBuf::from)
        .collect()
}

/// Deletes `reference/` files whose name does not belong to the current
/// reference image/state versions (all of them without a reference).
fn prune_reference_dir(dir: &Path, current: &[String]) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let is_current = |name: &str| {
        current.iter().any(|v| {
            name.strip_prefix(v.as_str())
                .or_else(|| {
                    name.strip_prefix("frame-")
                        .and_then(|n| n.strip_prefix(v.as_str()))
                })
                .is_some_and(|rest| rest.starts_with('-'))
        })
    };
    entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .filter(|e| !is_current(&e.file_name().to_string_lossy()))
        .filter(|e| std::fs::remove_file(e.path()).is_ok())
        .count()
}

/// Prunes everything (logs a summary).
pub fn run(core: &Core) -> Pruned {
    let (fingerprint, look, store, keep, versions) = {
        let s = core.session.read();
        let versions = s.p.reference.as_ref().map_or_else(Vec::new, |r| {
            vec![
                crate::session::reference::image_version(r),
                crate::session::reference::state_version(r),
            ]
        });
        (
            s.frames.fingerprint.clone(),
            look_key(&s.p.look),
            s.frames.store().cloned(),
            kept_folders(&s),
            versions,
        )
    };
    let cache = &core.paths.cache_dir;
    let keep: Vec<&Path> = keep.iter().map(PathBuf::as_path).collect();
    // Only a fingerprint of loaded models may mark a cache as another
    // engine's: a launch with missing or unreadable models judges none.
    let fingerprint_now = core
        .engine
        .models_ready()
        .then(|| core.engine.fingerprint())
        .flatten();
    let pruned = Pruned {
        analysis_files: fe::cache::prune(
            cache,
            ANALYSIS_MAX_AGE,
            &keep,
            fingerprint_now.as_deref(),
        ),
        fingerprints: fe::frames::prune_fingerprints(cache, &fingerprint, KEEP_FINGERPRINTS),
        thumb_bytes: fe::thumbs::prune(cache, THUMBS_HIGH, THUMBS_LOW),
        preview_bytes: crate::protocol::preview::prune(core),
        look_dirs: store.map_or(0, |s| s.prune_looks(&look)),
        reference_files: prune_reference_dir(&core.paths.reference_dir(), &versions),
    };
    log::info!("cache prune: {pruned:?}");
    pruned
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_on_empty_core() {
        let t = crate::testutil::TestCore::new();
        assert_eq!(run(&t.core), Pruned::default());
    }

    #[test]
    fn run_keeps_the_current_look_and_fingerprint() {
        let t = crate::testutil::TestCore::new();
        t.setup();
        t.scan();
        t.align();
        let store = t
            .core
            .session
            .read()
            .frames
            .store()
            .cloned()
            .expect("store");
        for d in ["look-old", "look-off"] {
            std::fs::create_dir_all(store.root().join(d)).expect("mkdir");
        }
        let pruned = run(&t.core);
        assert_eq!(pruned.look_dirs, 1);
        assert!(
            store.root().join("look-off").is_dir(),
            "current look (off) kept"
        );
        assert!(store.root().join("m").is_dir());
    }

    fn age(file: &std::path::Path, days: u64) {
        let when = std::time::SystemTime::now() - Duration::from_secs(days * 24 * 3600);
        std::fs::File::options()
            .write(true)
            .open(file)
            .and_then(|f| f.set_modified(when))
            .expect("set mtime");
    }

    fn bins(t: &crate::testutil::TestCore) -> Vec<std::path::PathBuf> {
        let mut v: Vec<_> = std::fs::read_dir(fe::cache::dir(&t.core.paths.cache_dir))
            .expect("analysis dir")
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|x| x == "bin"))
            .collect();
        v.sort();
        v
    }

    #[test]
    fn analysis_caches_of_known_folders_never_age_out() {
        let t = crate::testutil::TestCore::new();
        t.setup();
        t.scan();
        let current = bins(&t);
        assert_eq!(current.len(), 1, "the scan wrote one cache");
        // A remembered folder (decisions) and a recent folder, both old.
        let remembered = t.root.path().join("remembered");
        let recent = t.root.path().join("recent");
        let forgotten = t.root.path().join("forgotten");
        for dir in [&remembered, &recent, &forgotten] {
            std::fs::create_dir_all(dir).expect("mkdir");
            // Caches this engine can load (another fingerprint is pruned at once):
            // copies of the one the scan wrote.
            let file = fe::cache::AnalysisCache::file_path(&t.core.paths.cache_dir, dir);
            std::fs::copy(&current[0], file).expect("write cache");
        }
        {
            let mut s = t.core.session.write();
            s.p.folders.insert(
                remembered.to_string_lossy().into_owned(),
                Default::default(),
            );
            s.p.recents
                .folders
                .push(recent.to_string_lossy().into_owned());
        }
        for f in bins(&t) {
            age(&f, 120);
        }
        let pruned = run(&t.core);
        assert_eq!(
            pruned.analysis_files, 1,
            "only the forgotten folder's cache"
        );
        let left = bins(&t);
        assert_eq!(left.len(), 3);
        assert!(left.contains(&current[0]), "current folder kept");
    }

    #[test]
    fn without_the_models_no_cache_is_judged_by_fingerprint() {
        let t = crate::testutil::TestCore::new();
        t.setup();
        t.scan();
        let current = bins(&t);
        // A kept folder's cache written by another engine, long unused.
        let other = t.root.path().join("other");
        std::fs::create_dir_all(&other).expect("mkdir");
        let file = fe::cache::AnalysisCache::file_path(&t.core.paths.cache_dir, &other);
        // The scan's cache with another (same-length) engine fingerprint.
        let ours = std::fs::read(&current[0]).expect("cache");
        let (fp, theirs) = (b"fake-engine-1", b"fake-engine-2");
        let at = ours
            .windows(fp.len())
            .position(|w| w == fp)
            .expect("fingerprint in the header");
        let mut bytes = ours.clone();
        bytes[at..at + fp.len()].copy_from_slice(theirs);
        std::fs::write(&file, bytes).expect("other engine's cache");
        t.core
            .session
            .write()
            .p
            .recents
            .folders
            .push(other.to_string_lossy().into_owned());
        for f in bins(&t) {
            age(&f, 400);
        }
        // This launch could not load the models: nothing is another engine's.
        t.engine
            .models_missing
            .store(true, std::sync::atomic::Ordering::Relaxed);
        assert_eq!(run(&t.core).analysis_files, 0);
        assert!(file.is_file() && current.iter().all(|c| c.is_file()));
        // With the models, the other engine's cache is past its grace period.
        t.engine
            .models_missing
            .store(false, std::sync::atomic::Ordering::Relaxed);
        assert_eq!(run(&t.core).analysis_files, 1);
        assert!(!file.exists());
    }

    #[test]
    fn reference_images_of_older_versions_are_pruned() {
        let t = crate::testutil::TestCore::new();
        t.setup();
        let state = crate::commands::app::snapshot(&t.core)
            .reference
            .expect("reference");
        let dir = t.core.paths.reference_dir();
        let keep = [
            t.core.paths.reference_file(&state.image.version, 320),
            t.core.paths.reference_frame_file(&state.version, 160),
        ];
        let stale = [
            t.core.paths.reference_file("0000000000000000", 320),
            t.core.paths.reference_frame_file("0000000000000000", 160),
            dir.join(".r.jpg.1-1.tmp"),
        ];
        for f in keep.iter().chain(&stale) {
            std::fs::write(f, b"x").expect("write");
        }
        let pruned = run(&t.core);
        assert_eq!(pruned.reference_files, stale.len());
        assert!(keep.iter().all(|f| f.is_file()));
        assert!(stale.iter().all(|f| !f.exists()));
        crate::commands::app::reset(&t.core).expect("reset");
        assert_eq!(
            run(&t.core).reference_files,
            keep.len(),
            "no reference: all go"
        );
    }
}
