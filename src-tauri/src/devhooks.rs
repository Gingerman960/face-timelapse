//! Debug-only smoke hook (ARCHITECTURE.md §12):
//! `FT_DEV_AUTOLOAD="reference=<photo>;folder=<dir>"` sets the reference photo
//! and the source folder at startup (after restore + model loading) so a
//! smoke run can start scanning immediately. Compiled out of release builds.

use crate::state::Core;

/// Parsed `FT_DEV_AUTOLOAD`.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Autoload {
    pub reference: Option<String>,
    pub folder: Option<String>,
}

/// Parses `key=value;key=value` (unknown keys ignored).
#[must_use]
pub fn parse(spec: &str) -> Autoload {
    let mut out = Autoload::default();
    for part in spec.split(';') {
        if let Some((k, v)) = part.split_once('=') {
            let v = v.trim();
            if v.is_empty() {
                continue;
            }
            match k.trim() {
                "reference" => out.reference = Some(v.to_owned()),
                "folder" => out.folder = Some(v.to_owned()),
                _ => {}
            }
        }
    }
    out
}

/// Applies an autoload spec; true when the session changed (the caller
/// then emits `session-changed` so an already-rendered UI re-queries). The
/// spec comes from the developer's environment, so its paths are granted
/// like a dialog result.
pub fn apply(core: &Core, spec: &Autoload) -> bool {
    use crate::grants::Access;
    for p in spec.reference.iter().chain(&spec.folder) {
        core.grants.grant(Access::Read, std::path::Path::new(p));
    }
    let mut changed = false;
    if let Some(r) = &spec.reference {
        match crate::commands::reference::set_photo(core, r) {
            Ok(state) => {
                changed = true;
                log::info!(
                    "dev autoload: reference set (face: {})",
                    state.detection.is_some()
                );
            }
            Err(e) => log::warn!("dev autoload: reference failed: {}", e.message),
        }
    }
    if let Some(f) = &spec.folder {
        match crate::commands::folder::set_folder(core, f) {
            Ok(info) => {
                changed = true;
                log::info!("dev autoload: folder set ({} images)", info.image_count);
            }
            Err(e) => log::warn!("dev autoload: folder failed: {}", e.message),
        }
    }
    changed
}

/// Runs the hook from the environment (debug builds only); true when the
/// session changed.
pub fn autoload(core: &Core) -> bool {
    if cfg!(debug_assertions)
        && let Ok(spec) = std::env::var("FT_DEV_AUTOLOAD")
    {
        core.wait_restored_fully();
        return apply(core, &parse(&spec));
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_spec() {
        assert_eq!(
            parse("reference=/a/b.jpg; folder=/p ;x=1;junk"),
            Autoload {
                reference: Some("/a/b.jpg".into()),
                folder: Some("/p".into())
            }
        );
        assert_eq!(parse(""), Autoload::default());
        assert_eq!(parse("folder="), Autoload::default());
    }

    #[test]
    fn apply_logs_failures_without_panicking() {
        let t = crate::testutil::TestCore::new();
        assert!(!apply(
            &t.core,
            &parse("reference=/missing.jpg;folder=/missing")
        ));
        assert!(t.core.session.read().p.folder.is_none());
        assert!(!autoload(&t.core), "no FT_DEV_AUTOLOAD in tests");
    }

    #[test]
    fn apply_reports_changes() {
        let t = crate::testutil::TestCore::new();
        let folder = t.write_library();
        let r = t.write_reference("ref.jpg");
        let spec = format!(
            "reference={};folder={}",
            r.to_string_lossy(),
            folder.to_string_lossy()
        );
        assert!(apply(&t.core, &parse(&spec)));
        assert!(t.core.session.read().p.folder.is_some());
    }
}
