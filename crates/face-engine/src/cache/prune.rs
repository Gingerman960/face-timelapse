//! Pruning the analysis caches (`{cache_dir}/analysis/*.bin`).
//!
//! Rules, per file, by what its header says:
//! - **Unusable** (unreadable, not a cache, another format version): never
//!   loadable by any build of this format, so it goes once it is no longer
//!   being written ([`RECENT_WRITE`]).
//! - **Another engine's** (current format, other fingerprint): kept for
//!   [`OTHER_ENGINE_GRACE`] after its last use, whatever its folder. Two
//!   builds sharing one cache folder (a dev build next to the installed app,
//!   a beta next to stable) therefore leave each other's caches alone while
//!   both are in use; an upgrade's old caches go a month later.
//! - **Loadable**: aged out after `max_age` unless its folder is kept.
//!
//! Only an authoritative fingerprint (models loaded) may mark a cache as
//! another engine's: without one (`None`) every readable cache counts as
//! loadable, so a launch with missing or unreadable models deletes nothing
//! it should not. A file is re-inspected right before it is deleted, and one
//! written in the last [`RECENT_WRITE`] is never deleted, so a scan replacing
//! it meanwhile keeps its fresh file.

use std::collections::HashSet;
use std::path::Path;
use std::time::{Duration, SystemTime};

use super::{CACHE_FORMAT_VERSION, CACHE_MAGIC, Header, dir};
use crate::walk::folder_key;

/// Files modified this recently are never deleted (a write may be under way).
pub const RECENT_WRITE: Duration = Duration::from_secs(10 * 60);
/// How long a cache of another engine fingerprint is kept after its last use.
pub const OTHER_ENGINE_GRACE: Duration = Duration::from_secs(30 * 86_400);

/// What a cache file's header says about it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Loadable,
    OtherEngine,
    Unusable,
}

/// Deletes the analysis cache files the rules above allow; returns how many.
/// `keep` are the app's current and remembered folders; `fingerprint` is the
/// engine's analysis fingerprint once its models are loaded, else `None`.
#[must_use]
pub fn prune(
    cache_dir: &Path,
    max_age: Duration,
    keep: &[&Path],
    fingerprint: Option<&str>,
) -> usize {
    let Ok(entries) = std::fs::read_dir(dir(cache_dir)) else {
        return 0;
    };
    let kept: HashSet<String> = keep
        .iter()
        .map(|f| format!("{}.bin", folder_key(f)))
        .collect();
    let now = SystemTime::now();
    entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "bin"))
        .filter(|p| {
            let Some(seen) = inspect(p, fingerprint) else {
                return false;
            };
            let age = now.duration_since(seen.1).unwrap_or(Duration::ZERO);
            let name = p.file_name().map(|n| n.to_string_lossy().into_owned());
            let is_kept = name.is_some_and(|n| kept.contains(&n));
            deletable(seen.0, age, is_kept, max_age)
                // Unchanged since it was judged (a scan may have replaced it).
                && inspect(p, fingerprint) == Some(seen)
        })
        .filter(|p| std::fs::remove_file(p).is_ok())
        .count()
}

/// Whether a file of `kind`, last modified `age` ago, may go.
fn deletable(kind: Kind, age: Duration, kept: bool, max_age: Duration) -> bool {
    if age < RECENT_WRITE {
        return false;
    }
    match kind {
        Kind::Unusable => true,
        Kind::OtherEngine => age > OTHER_ENGINE_GRACE,
        Kind::Loadable => !kept && age > max_age,
    }
}

/// The file's kind and modification time; `None` when it cannot be stat'ed.
fn inspect(file: &Path, fingerprint: Option<&str>) -> Option<(Kind, SystemTime)> {
    use std::io::Read as _;
    /// Enough for the header (magic, version and a short fingerprint).
    const HEADER_BYTES: u64 = 256;
    let modified = std::fs::metadata(file).and_then(|m| m.modified()).ok()?;
    let mut head = Vec::new();
    let read = std::fs::File::open(file).and_then(|f| f.take(HEADER_BYTES).read_to_end(&mut head));
    let kind = match postcard::take_from_bytes::<Header>(&head) {
        Ok((h, _))
            if read.is_ok()
                && h.magic == CACHE_MAGIC
                && h.format_version == CACHE_FORMAT_VERSION =>
        {
            match fingerprint {
                Some(fp) if h.engine_fingerprint != fp => Kind::OtherEngine,
                _ => Kind::Loadable,
            }
        }
        _ => Kind::Unusable,
    };
    Some((kind, modified))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cache::AnalysisCache;
    use crate::cache::tests::{age, analysis, entry};

    const NINETY_DAYS: Duration = Duration::from_secs(90 * 86_400);

    /// A cache for `folder` written by an engine with `fingerprint`, last used `days` ago.
    fn cache(root: &Path, folder: &Path, fingerprint: &str, days: u64) -> std::path::PathBuf {
        let mut c = AnalysisCache::empty(root, folder, fingerprint);
        c.insert(&entry("a.jpg", 1, 1), analysis(0));
        c.save().expect("save");
        age(c.path(), days);
        c.path().to_path_buf()
    }

    #[test]
    fn loadable_caches_age_out_unless_their_folder_is_kept() {
        let dir = tempfile::tempdir().expect("tmp");
        let (used, other) = (dir.path().join("used"), dir.path().join("other"));
        let used_file = cache(dir.path(), &used, "fp", 100);
        let other_file = cache(dir.path(), &other, "fp", 100);
        assert_eq!(
            prune(dir.path(), NINETY_DAYS, &[used.as_path()], Some("fp")),
            1
        );
        assert!(used_file.is_file() && !other_file.exists());
        // Reading a cache counts as using it (hit-only rescans write nothing).
        age(&used_file, 100);
        let (_, status) = AnalysisCache::load(dir.path(), &used, "fp");
        assert_eq!(status, crate::cache::LoadStatus::Loaded);
        assert_eq!(
            prune(dir.path(), NINETY_DAYS, &[], Some("fp")),
            0,
            "freshly used"
        );
        assert_eq!(
            prune(&dir.path().join("none"), NINETY_DAYS, &[], Some("fp")),
            0
        );
    }

    #[test]
    fn another_engines_caches_get_a_grace_period_even_in_kept_folders() {
        let dir = tempfile::tempdir().expect("tmp");
        let (recent, old) = (dir.path().join("recent"), dir.path().join("old"));
        let recent_file = cache(dir.path(), &recent, "other-engine", 10);
        let old_file = cache(dir.path(), &old, "other-engine", 40);
        let keep = [recent.as_path(), old.as_path()];
        assert_eq!(prune(dir.path(), NINETY_DAYS, &keep, Some("fp")), 1);
        assert!(recent_file.is_file(), "within the grace period");
        assert!(
            !old_file.exists(),
            "unused for longer than the grace period"
        );
    }

    #[test]
    fn without_an_authoritative_fingerprint_nothing_counts_as_another_engines() {
        let dir = tempfile::tempdir().expect("tmp");
        let kept = dir.path().join("kept");
        let file = cache(dir.path(), &kept, "some-engine", 400);
        // E.g. the models could not be read at this launch.
        assert_eq!(prune(dir.path(), NINETY_DAYS, &[kept.as_path()], None), 0);
        assert!(file.is_file());
    }

    #[test]
    fn unusable_files_go_once_they_are_not_being_written() {
        let dir = tempfile::tempdir().expect("tmp");
        let analysis_dir = crate::cache::dir(dir.path());
        std::fs::create_dir_all(&analysis_dir).expect("mkdir");
        let (fresh, stale) = (
            analysis_dir.join("fresh.bin"),
            analysis_dir.join("stale.bin"),
        );
        for f in [&fresh, &stale] {
            std::fs::write(f, b"not a cache").expect("junk");
        }
        age(&stale, 1);
        assert_eq!(prune(dir.path(), NINETY_DAYS, &[], None), 1);
        assert!(fresh.is_file() && !stale.exists());
    }

    #[test]
    fn a_file_replaced_after_it_was_judged_is_not_deleted() {
        let dir = tempfile::tempdir().expect("tmp");
        let folder = dir.path().join("f");
        let file = cache(dir.path(), &folder, "other-engine", 40);
        let judged = inspect(&file, Some("fp")).expect("inspect");
        assert_eq!(judged.0, Kind::OtherEngine);
        assert!(deletable(
            judged.0,
            Duration::from_secs(40 * 86_400),
            true,
            NINETY_DAYS
        ));
        // A scan writes this engine's cache over it meanwhile.
        cache(dir.path(), &folder, "fp", 0);
        assert_ne!(
            inspect(&file, Some("fp")),
            Some(judged),
            "re-inspected before deleting"
        );
        assert_eq!(
            prune(dir.path(), NINETY_DAYS, &[folder.as_path()], Some("fp")),
            0
        );
        assert!(file.is_file());
    }

    #[test]
    fn nothing_written_in_the_last_minutes_is_ever_deleted() {
        for kind in [Kind::Loadable, Kind::OtherEngine, Kind::Unusable] {
            assert!(!deletable(
                kind,
                Duration::from_secs(60),
                false,
                Duration::ZERO
            ));
        }
    }
}
