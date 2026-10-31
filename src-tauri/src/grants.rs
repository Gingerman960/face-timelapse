//! Path grants (ARCHITECTURE.md §13): which user-named paths commands may use.
//!
//! The webview can only name paths the user chose: native dialog results, OS
//! drops onto the window, and the session's own paths (current and recent
//! reference/folder, remembered folders, added photos, outputs).
//!
//! A path is checked in two steps. First its spelling must lie inside a
//! grant as spelled (no file-system access): anything else is refused with
//! `permissionDenied`, so a refusal reveals nothing about whether the path
//! exists and, on Windows, a UNC/WebDAV path nobody chose is never opened.
//! Then the path and the matching grants are resolved on disk (symlinks
//! followed) and the decision is made on those canonical forms: a directory
//! symlink inside a granted folder that points elsewhere is refused.

use std::collections::VecDeque;
use std::path::{Component, Path, PathBuf};

use parking_lot::Mutex;

use crate::error::AppResult;
use crate::ipc::{ErrorKind, IpcError};
use crate::session::Session;

/// Runtime grants kept (oldest dropped first); dialogs and drops add a few
/// per user action, so this is never reached in practice.
pub const MAX_GRANTS: usize = 256;

/// What a grant allows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Access {
    /// Read the file, or anything inside the folder.
    Read,
    /// Export images into exactly this folder.
    ExportDir,
    /// Create exactly this file (a video).
    ExportFile,
    /// Replace exactly this existing file (the save dialog confirmed it).
    ReplaceFile,
}

/// Paths granted at runtime by dialogs and drops (the session's own paths
/// are added at check time, see [`Grants::resolve`]).
#[derive(Debug, Default)]
pub struct Grants {
    granted: Mutex<VecDeque<(Access, PathBuf)>>,
}

/// User-facing refusal (also used when the path does not exist).
#[must_use]
pub fn denied() -> IpcError {
    IpcError::new(ErrorKind::PermissionDenied, crate::error::msg::NOT_GRANTED)
}

/// True for a Windows path on a local drive letter: `C:\…` or `\\?\C:\…`
/// (either slash). An allow-list: every other spelling — `\\server\share`,
/// `\\?\UNC\…`, `\\?\GLOBALROOT\Device\Mup\…`, `\\.\…`, `\??\…` — may
/// reach another machine or a device.
#[must_use]
pub fn is_local_disk_path(path: &str) -> bool {
    let p = path.replace('/', "\\");
    let rest = p.strip_prefix(r"\\?\").unwrap_or(&p);
    let b = rest.as_bytes();
    b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && b[2] == b'\\'
}

/// True for Windows device/UNC spellings (`\\…`, `//…`, `\??\…`) other
/// than a verbatim local drive (`\\?\C:\…`): see [`is_local_disk_path`].
#[must_use]
pub fn is_remote_prefix(path: &str) -> bool {
    let p = path.replace('/', "\\");
    (p.starts_with(r"\\") || p.starts_with(r"\??\")) && !is_local_disk_path(path)
}

/// Windows defence in depth for [`Grants::resolve`]: a path granted under a
/// local folder that *resolves* onto another machine (a junction or link to
/// `\\server`, `\\?\UNC\…`, `\\?\GLOBALROOT\…`) is refused — unless the
/// user chose a network location in the first place. `windows` is
/// `cfg!(windows)` (a parameter so the rule is testable everywhere).
fn leaves_local_disk(windows: bool, resolved: &Path, roots: &[(Access, PathBuf)]) -> bool {
    windows
        && is_remote_prefix(&resolved.to_string_lossy())
        && roots
            .iter()
            .all(|(_, r)| !is_remote_prefix(&r.to_string_lossy()))
}

/// The session's own paths, granted across restarts: the current and recent
/// reference/folder, folders with remembered decisions and hand-added photos
/// (read), and everything the app exported (export/replace, exact).
#[must_use]
pub fn of_session(s: &Session) -> Vec<(Access, PathBuf)> {
    let p = &s.p;
    let read = p
        .reference
        .iter()
        .map(|r| r.path.as_str())
        .chain(p.folder.as_deref())
        .chain(p.recents.references.iter().map(String::as_str))
        .chain(p.recents.folders.iter().map(String::as_str))
        .chain(p.folders.keys().map(String::as_str))
        .chain(
            p.folders
                .values()
                .flat_map(|d| d.manual_photos.iter().map(|m| m.path.as_str())),
        )
        .map(|x| (Access::Read, PathBuf::from(x)));
    let written = p.outputs.iter().flat_map(|o| {
        [Access::ExportDir, Access::ExportFile, Access::ReplaceFile].map(|a| (a, PathBuf::from(o)))
    });
    read.chain(written).collect()
}

/// The file-system location a granted path stands for: the canonical path,
/// or for a file that may not exist yet its canonical folder + name.
fn resolve_on_disk(path: &Path, access: Access) -> std::io::Result<PathBuf> {
    match access {
        Access::Read | Access::ExportDir => path.canonicalize(),
        Access::ExportFile | Access::ReplaceFile => {
            let name = path.file_name().ok_or_else(|| {
                std::io::Error::new(std::io::ErrorKind::InvalidInput, "no file name")
            })?;
            let parent = path.parent().ok_or_else(|| {
                std::io::Error::new(std::io::ErrorKind::InvalidInput, "no parent")
            })?;
            Ok(parent.canonicalize()?.join(name))
        }
    }
}

/// Whether a grant of `granted` for `kind` covers `path` for `access`.
fn covers(kind: Access, granted: &Path, access: Access, path: &Path) -> bool {
    match (kind, access) {
        (Access::Read, Access::Read) => path.starts_with(granted),
        (k, a) => k == a && path == granted,
    }
}

fn has_parent_refs(path: &Path) -> bool {
    path.components().any(|c| matches!(c, Component::ParentDir))
}

impl Grants {
    /// Records a dialog result (both its spelling and, where it resolves,
    /// its canonical form).
    pub fn grant(&self, access: Access, path: &Path) {
        let resolved = resolve_on_disk(path, access).ok();
        self.insert(access, std::iter::once(path.to_path_buf()).chain(resolved));
    }

    /// Records a path exactly as spelled, without touching the file system
    /// (OS drops: handled on the main thread, and the webview passes the
    /// same spelling back).
    pub fn grant_as_spelled(&self, access: Access, path: &Path) {
        self.insert(access, std::iter::once(path.to_path_buf()));
    }

    fn insert(&self, access: Access, paths: impl Iterator<Item = PathBuf>) {
        let mut g = self.granted.lock();
        for p in paths {
            g.retain(|(a, q)| !(*a == access && *q == p));
            g.push_back((access, p));
        }
        while g.len() > MAX_GRANTS {
            g.pop_front();
        }
    }

    /// Grants (runtime + session) that cover `path` for `access` as spelled.
    fn covering(
        &self,
        session: &[(Access, PathBuf)],
        access: Access,
        path: &Path,
    ) -> Vec<(Access, PathBuf)> {
        let g = self.granted.lock();
        g.iter()
            .chain(session)
            .filter(|(k, q)| covers(*k, q, access, path))
            .cloned()
            .collect()
    }

    /// Resolves `path` for `access` if it is granted, given the session's
    /// own grants `session`.
    ///
    /// # Errors
    /// `invalidArgument` for empty/relative paths or `..`;
    /// `permissionDenied` for anything not granted (existing or not) or
    /// resolving outside its grant; for a granted path, the real error
    /// (`notFound`, `io`).
    pub fn resolve(
        &self,
        session: &[(Access, PathBuf)],
        path: &str,
        access: Access,
    ) -> AppResult<PathBuf> {
        let p = Path::new(path);
        if path.is_empty() || !p.is_absolute() {
            return Err(IpcError::invalid("Paths must be absolute."));
        }
        if has_parent_refs(p) {
            return Err(IpcError::invalid("Paths must not contain “..”."));
        }
        // 1. Spelled inside a grant? Decided without touching the disk.
        let roots = self.covering(session, access, p);
        if roots.is_empty() {
            return Err(denied());
        }
        // 2. Resolved inside a resolved grant (symlinks followed on both).
        let resolved = match resolve_on_disk(p, access) {
            Ok(r) => r,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Err(IpcError::missing_path(p));
            }
            Err(e) => return Err(IpcError::io("opening that path", &e)),
        };
        let inside = roots.iter().any(|(kind, root)| {
            resolve_on_disk(root, *kind).is_ok_and(|r| covers(*kind, &r, access, &resolved))
        });
        if leaves_local_disk(cfg!(windows), &resolved, &roots) {
            log::warn!("refused a path that resolves onto another machine");
            return Err(denied());
        }
        if inside {
            Ok(resolved)
        } else {
            log::warn!("refused a path that resolves outside its grant (symlink)");
            Err(denied())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(p: &Path) -> String {
        p.to_string_lossy().into_owned()
    }

    #[test]
    fn ungranted_paths_are_refused_whether_or_not_they_exist() {
        let dir = tempfile::tempdir().expect("tempdir");
        let file = dir.path().join("secret.jpg");
        std::fs::write(&file, b"x").expect("write");
        let g = Grants::default();
        for p in [file.clone(), dir.path().join("missing.jpg")] {
            let err = g.resolve(&[], &s(&p), Access::Read).expect_err("denied");
            assert_eq!(err, denied(), "{}", p.display());
        }
        assert_eq!(
            g.resolve(&[], "relative.jpg", Access::Read)
                .expect_err("relative")
                .kind,
            ErrorKind::InvalidArgument
        );
        assert_eq!(
            g.resolve(&[], "", Access::Read).expect_err("empty").kind,
            ErrorKind::InvalidArgument
        );
    }

    #[test]
    fn folder_grants_cover_their_contents_only() {
        let root = tempfile::tempdir().expect("tempdir");
        let photos = root.path().join("photos");
        let other = root.path().join("other");
        for d in [&photos, &other] {
            std::fs::create_dir_all(d.join("sub")).expect("mkdir");
            std::fs::write(d.join("sub/a.jpg"), b"x").expect("write");
        }
        let g = Grants::default();
        g.grant(Access::Read, &photos);
        let ok = g
            .resolve(&[], &s(&photos.join("sub/a.jpg")), Access::Read)
            .expect("inside");
        assert_eq!(
            ok,
            photos.join("sub/a.jpg").canonicalize().expect("canonical")
        );
        assert_eq!(
            g.resolve(&[], &s(&other.join("sub/a.jpg")), Access::Read),
            Err(denied())
        );
        let escape = format!("{}/../other/sub/a.jpg", s(&photos));
        assert_eq!(
            g.resolve(&[], &escape, Access::Read)
                .expect_err("dotdot")
                .kind,
            ErrorKind::InvalidArgument
        );
        // A read grant never allows writing.
        assert_eq!(
            g.resolve(&[], &s(&photos), Access::ExportDir),
            Err(denied())
        );
        // A granted path that vanished reports the real error.
        let gone = photos.join("sub/gone.jpg");
        g.grant(Access::Read, &gone);
        assert_eq!(
            g.resolve(&[], &s(&gone), Access::Read)
                .expect_err("gone")
                .kind,
            ErrorKind::NotFound
        );
    }

    #[test]
    fn dropped_paths_are_granted_as_spelled() {
        let root = tempfile::tempdir().expect("tempdir");
        let dropped = root.path().join("dropped");
        std::fs::create_dir_all(&dropped).expect("mkdir");
        std::fs::write(dropped.join("a.jpg"), b"x").expect("write");
        let g = Grants::default();
        g.grant_as_spelled(Access::Read, &dropped);
        assert!(
            g.resolve(&[], &s(&dropped.join("a.jpg")), Access::Read)
                .is_ok()
        );
        assert_eq!(g.resolve(&[], &s(root.path()), Access::Read), Err(denied()));
    }

    #[test]
    fn canonical_and_spelled_forms_both_match() {
        let root = tempfile::tempdir().expect("tempdir");
        let real = root.path().join("real");
        std::fs::create_dir_all(&real).expect("mkdir");
        std::fs::write(real.join("a.jpg"), b"x").expect("write");
        let g = Grants::default();
        g.grant(Access::Read, &real);
        let canonical = real.canonicalize().expect("canonical");
        assert!(
            g.resolve(&[], &s(&canonical.join("a.jpg")), Access::Read)
                .is_ok()
        );
        #[cfg(unix)]
        {
            // Another spelling that was never granted is refused without
            // being resolved, even though it leads into a granted folder.
            let link = root.path().join("link");
            std::os::unix::fs::symlink(&real, &link).expect("symlink");
            assert_eq!(
                g.resolve(&[], &s(&link.join("a.jpg")), Access::Read),
                Err(denied())
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn directory_symlinks_cannot_lead_out_of_a_granted_folder() {
        let root = tempfile::tempdir().expect("tempdir");
        let (photos, private) = (root.path().join("photos"), root.path().join("private"));
        std::fs::create_dir_all(photos.join("sub")).expect("mkdir");
        std::fs::create_dir_all(&private).expect("mkdir");
        std::fs::write(private.join("secret.jpg"), b"x").expect("write");
        std::fs::write(photos.join("sub/a.jpg"), b"x").expect("write");
        std::os::unix::fs::symlink(&private, photos.join("out")).expect("symlink");
        std::os::unix::fs::symlink(photos.join("sub"), photos.join("in")).expect("symlink");
        for g in [Grants::default(), Grants::default()] {
            g.grant(Access::Read, &photos);
            for escape in [photos.join("out"), photos.join("out/secret.jpg")] {
                assert_eq!(
                    g.resolve(&[], &s(&escape), Access::Read),
                    Err(denied()),
                    "{escape:?}"
                );
            }
            assert!(
                g.resolve(&[], &s(&photos.join("in/a.jpg")), Access::Read)
                    .is_ok()
            );
        }
        // The same for drops (spelled grants) and for the session's own folders.
        let g = Grants::default();
        g.grant_as_spelled(Access::Read, &photos);
        assert_eq!(
            g.resolve(&[], &s(&photos.join("out/secret.jpg")), Access::Read),
            Err(denied())
        );
        let session = [(Access::Read, photos.canonicalize().expect("canonical"))];
        let spelled = photos
            .canonicalize()
            .expect("canonical")
            .join("out/secret.jpg");
        assert_eq!(
            Grants::default().resolve(&session, &s(&spelled), Access::Read),
            Err(denied())
        );
    }

    #[test]
    fn export_grants_are_exact() {
        let root = tempfile::tempdir().expect("tempdir");
        let out = root.path().join("out");
        std::fs::create_dir_all(out.join("sub")).expect("mkdir");
        let g = Grants::default();
        g.grant(Access::ExportDir, &out);
        g.grant(Access::ExportFile, &out.join("movie.mp4"));
        assert!(g.resolve(&[], &s(&out), Access::ExportDir).is_ok());
        assert_eq!(
            g.resolve(&[], &s(&out.join("sub")), Access::ExportDir),
            Err(denied())
        );
        let movie = g
            .resolve(&[], &s(&out.join("movie.mp4")), Access::ExportFile)
            .expect("granted video");
        assert_eq!(
            movie,
            out.canonicalize().expect("canonical").join("movie.mp4")
        );
        assert_eq!(
            g.resolve(&[], &s(&out.join("other.mp4")), Access::ExportFile),
            Err(denied())
        );
        assert_eq!(
            g.resolve(&[], &s(&out.join("movie.mp4")), Access::ReplaceFile),
            Err(denied()),
            "creating is not replacing"
        );
        // Session grants (outputs) work the same way.
        let session = [(Access::ExportDir, out.join("sub"))];
        assert!(
            g.resolve(&session, &s(&out.join("sub")), Access::ExportDir)
                .is_ok()
        );
    }

    #[test]
    fn runtime_grants_are_capped_newest_first() {
        let root = tempfile::tempdir().expect("tempdir");
        let g = Grants::default();
        let missing = |i: usize| root.path().join(format!("m{i}.jpg"));
        for i in 0..=MAX_GRANTS {
            g.grant(Access::Read, &missing(i));
        }
        assert_eq!(g.granted.lock().len(), MAX_GRANTS);
        assert_eq!(g.resolve(&[], &s(&missing(0)), Access::Read), Err(denied()));
        assert_eq!(
            g.resolve(&[], &s(&missing(MAX_GRANTS)), Access::Read)
                .expect_err("granted but missing")
                .kind,
            ErrorKind::NotFound
        );
    }

    #[test]
    fn a_local_grant_cannot_resolve_onto_another_machine() {
        let local = [(Access::Read, PathBuf::from(r"C:\Users\me\Photos"))];
        let network = [(Access::Read, PathBuf::from(r"\\nas\photos"))];
        // A junction inside a local folder pointing at a share: refused.
        assert!(leaves_local_disk(
            true,
            Path::new(r"\\?\UNC\evil\s\a.jpg"),
            &local
        ));
        assert!(leaves_local_disk(
            true,
            Path::new(r"\\?\GLOBALROOT\Device\Mup\evil\s"),
            &local
        ));
        // Staying on the local disk, or a network folder the user chose: fine.
        assert!(!leaves_local_disk(
            true,
            Path::new(r"\\?\C:\Users\me\Photos\a.jpg"),
            &local
        ));
        assert!(!leaves_local_disk(
            true,
            Path::new(r"\\?\UNC\nas\photos\a.jpg"),
            &network
        ));
        // Not Windows: never applies.
        assert!(!leaves_local_disk(
            false,
            Path::new(r"\\?\UNC\evil\s"),
            &local
        ));
    }

    #[test]
    fn remote_windows_prefixes_are_recognised() {
        for remote in [
            r"\\server\share\photos",
            r"\\?\UNC\server\share",
            r"\\?\unc\server\share",
            r"\\.\pipe\x",
            "//server/share",
            r"\\webdav@SSL\DavWWWRoot\x",
            r"\\?\GLOBALROOT\Device\Mup\attacker\share\a.jpg",
            r"\\?\GLOBALROOT\??\UNC\attacker\share\a.jpg",
            "//?/GLOBALROOT/Device/Mup/attacker/share",
            r"\\.\C:\Users\x",
            r"\??\UNC\attacker\share",
        ] {
            assert!(is_remote_prefix(remote), "{remote}");
            assert!(!is_local_disk_path(remote), "{remote}");
        }
        for local in [r"C:\Users\x", r"\\?\C:\Users\x", r"D:\", "c:/x", "//?/C:/x"] {
            assert!(!is_remote_prefix(local), "{local}");
            assert!(is_local_disk_path(local), "{local}");
        }
        assert!(!is_remote_prefix("/Users/x"), "Unix paths are not remote");
    }
}
