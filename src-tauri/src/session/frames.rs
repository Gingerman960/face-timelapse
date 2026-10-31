//! The aligned frames of the session's current render fingerprint: the
//! engine's [`FrameStore`] (layout, masters, manifest file) with its
//! [`Manifest`] held in memory, plus the IPC-facing versions.
//!
//! Keys are the engine's (`face_engine::frames::{render_fingerprint,
//! frame_key}`); `FrameSummary.version = blake3(frameKey, lookKey)[..12]`
//! where `lookKey` is `LookSettings::cache_key` (`"off"` when the look is off).

use std::sync::Arc;

use face_engine::align::key_hash;
use face_engine::color::{FaceStats, FrameLook};
use face_engine::frames::{FrameStore, Manifest, ManifestEntry};
use face_engine::geometry::Size;
use parking_lot::Mutex;

use crate::convert;
use crate::error::{AppResult, from_engine};
use crate::ipc::{FrameAdjust, IpcError, LookSettings};

/// Frames of the current fingerprint (unset until a reference is detected).
#[derive(Debug, Clone, Default)]
pub struct Frames {
    /// Render fingerprint; empty = unset.
    pub fingerprint: String,
    store: Option<FrameStore>,
    /// Output size of every frame of this fingerprint.
    pub output_size: Size,
    /// Current master of each photo + reference look statistics.
    pub manifest: Manifest,
    /// Frames exist for some other fingerprint (⇒ `stale` when this one is empty).
    pub others_exist: bool,
    /// The manifest has unsaved changes.
    pub dirty: bool,
    /// Change counter; see [`ManifestWrite`].
    seq: u64,
    /// Newest `seq` written to disk (shared by the snapshots of this store).
    written: Arc<Mutex<u64>>,
}

/// A manifest snapshot taken under the session lock and written outside it
/// (§3: no file I/O under the session lock). Writes are serialized per
/// store and a snapshot older than the last one written is skipped.
pub struct ManifestWrite {
    pub fingerprint: String,
    store: FrameStore,
    manifest: Manifest,
    seq: u64,
    written: Arc<Mutex<u64>>,
}

impl ManifestWrite {
    /// Writes the snapshot unless a newer one already was.
    ///
    /// # Errors
    /// I/O errors.
    pub fn write(self) -> AppResult<()> {
        let mut written = self.written.lock();
        if self.seq <= *written {
            return Ok(());
        }
        self.store
            .save_manifest(&self.manifest)
            .map_err(|e| from_engine(&e))?;
        *written = self.seq;
        Ok(())
    }
}

impl Frames {
    /// Opens the store of `fingerprint` and loads its manifest.
    #[must_use]
    pub fn open(cache_dir: &std::path::Path, fingerprint: &str, output_size: Size) -> Self {
        let store = FrameStore::new(cache_dir, fingerprint);
        Self {
            fingerprint: fingerprint.to_owned(),
            output_size,
            manifest: store.load_usable_manifest(),
            others_exist: store.others_exist(),
            store: Some(store),
            dirty: false,
            seq: 0,
            written: Arc::default(),
        }
    }

    /// True when there is no fingerprint (no detected reference yet).
    #[must_use]
    pub fn is_unset(&self) -> bool {
        self.store.is_none()
    }

    /// The engine store (`None` when unset).
    #[must_use]
    pub fn store(&self) -> Option<&FrameStore> {
        self.store.as_ref()
    }

    /// The photo's frame if it was rendered with `frame_key`.
    #[must_use]
    pub fn current(&self, photo_id: &str, frame_key: &str) -> Option<&ManifestEntry> {
        self.manifest.current(photo_id, frame_key)
    }

    /// Records a rendered frame.
    pub fn insert(&mut self, entry: ManifestEntry) {
        self.manifest.insert(entry);
        self.changed();
    }

    /// Records the reference look statistics of this fingerprint.
    pub fn set_reference_stats(&mut self, stats: FaceStats) {
        self.manifest.reference_stats = Some(stats);
        self.changed();
    }

    fn changed(&mut self) {
        self.dirty = true;
        self.seq += 1;
    }

    /// The manifest to write if it has unsaved changes (marks it clean; call
    /// under the session lock, then [`ManifestWrite::write`] outside it).
    pub fn take_write(&mut self) -> Option<ManifestWrite> {
        let store = self.store.as_ref().filter(|_| self.dirty)?.clone();
        self.dirty = false;
        Some(ManifestWrite {
            fingerprint: self.fingerprint.clone(),
            store,
            manifest: self.manifest.clone(),
            seq: self.seq,
            written: Arc::clone(&self.written),
        })
    }
}

/// The look of a recorded frame under the session's look settings; `None`
/// when the look is off or the frame/reference statistics are missing.
#[must_use]
pub fn frame_look(s: &super::Session, rec: &ManifestEntry) -> Option<FrameLook> {
    if s.p.look.normalize == crate::ipc::NormalizeMode::Off {
        return None;
    }
    Some(FrameLook {
        frame: rec.stats()?,
        reference: s.frames.manifest.reference_stats?,
        settings: convert::look(s.p.look),
    })
}

/// `frameKey` of a photo version + contract adjustment under `fingerprint`.
#[must_use]
pub fn frame_key(fingerprint: &str, photo_version: &str, adjust: &FrameAdjust) -> String {
    face_engine::frames::frame_key(fingerprint, photo_version, &convert::adjust(*adjust))
}

/// The look's cache key (`"off"` when disabled; names `look-{key}` folders).
#[must_use]
pub fn look_key(look: &LookSettings) -> String {
    convert::look(*look).cache_key()
}

/// `FrameSummary.version`.
#[must_use]
pub fn frame_version(frame_key: &str, look: &LookSettings) -> String {
    key_hash(&[frame_key, &look_key(look)], 12)
}

/// Validates a frame adjustment (§7.2).
///
/// # Errors
/// `invalidArgument`.
pub fn validate_adjust(a: &FrameAdjust) -> AppResult<()> {
    convert::adjust(*a).validate().map_err(|_| {
        IpcError::invalid(
            "Adjustments must stay within ±25 % offset, 0.5–2× scale and ±20° rotation.",
        )
    })
}

/// True for the identity adjustment.
#[must_use]
pub fn is_identity(a: &FrameAdjust) -> bool {
    *a == convert::identity_adjust()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::NormalizeMode;

    fn identity() -> FrameAdjust {
        convert::identity_adjust()
    }

    #[test]
    fn keys_and_versions() {
        let k1 = frame_key("fp", "v1", &identity());
        let adj = FrameAdjust {
            dx: 0.1,
            ..identity()
        };
        assert_ne!(k1, frame_key("fp", "v1", &adj));
        assert_ne!(k1, frame_key("fp", "v2", &identity()));
        let off = LookSettings {
            normalize: NormalizeMode::Off,
            strength: 0.7,
        };
        let on = LookSettings {
            normalize: NormalizeMode::Exposure,
            strength: 0.7,
        };
        assert_eq!(look_key(&off), "off");
        assert_ne!(frame_version(&k1, &off), frame_version(&k1, &on));
        assert_eq!(frame_version(&k1, &off).len(), 12);
        assert!(is_identity(&identity()));
        assert!(!is_identity(&adj));
    }

    #[test]
    fn adjust_validation() {
        assert!(validate_adjust(&identity()).is_ok());
        for bad in [
            FrameAdjust {
                dx: 0.3,
                ..identity()
            },
            FrameAdjust {
                dy: -0.26,
                ..identity()
            },
            FrameAdjust {
                scale: 2.1,
                ..identity()
            },
            FrameAdjust {
                rotation_deg: 21.0,
                ..identity()
            },
            FrameAdjust {
                dx: f64::NAN,
                ..identity()
            },
            FrameAdjust {
                scale: f64::INFINITY,
                ..identity()
            },
        ] {
            assert!(validate_adjust(&bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn manifest_round_trip_through_the_store() {
        let root = tempfile::tempdir().expect("tempdir");
        let unset = Frames::default();
        assert!(unset.is_unset() && unset.store().is_none());
        let mut s = Frames::open(root.path(), "fp1", Size::new(10, 10));
        assert!(!s.is_unset() && !s.others_exist);
        s.insert(ManifestEntry {
            photo_id: "a".into(),
            frame_key: "k".into(),
            residual_px: 1.0,
            face_stats: Some([0.0; 6]),
        });
        s.set_reference_stats(FaceStats::from_array([1.0; 6]));
        put_master(&s, "a");
        s.take_write().expect("dirty").write().expect("write");
        assert!(!s.dirty);
        assert!(s.take_write().is_none(), "clean: nothing to write");
        let again = Frames::open(root.path(), "fp1", Size::new(10, 10));
        assert!(again.current("a", "k").is_some());
        assert!(again.current("a", "other").is_none());
        assert_eq!(
            again.manifest.reference_stats,
            Some(FaceStats::from_array([1.0; 6]))
        );
        let other = Frames::open(root.path(), "fp2", Size::new(10, 10));
        assert!(other.others_exist);
        assert!(other.manifest.is_empty());
        // A master a power loss cut short: the frame counts as not aligned.
        let master = again.store().expect("store").master_path("a", "k");
        let whole = std::fs::read(&master).expect("master");
        std::fs::write(&master, &whole[..whole.len() / 2]).expect("cut");
        let torn = Frames::open(root.path(), "fp1", Size::new(10, 10));
        assert!(torn.current("a", "k").is_none());
    }

    /// A whole (tiny) master for `id` with key `k`, as align writes it.
    fn put_master(f: &Frames, id: &str) {
        let path = f.store().expect("store").master_path(id, "k");
        std::fs::create_dir_all(path.parent().expect("dir")).expect("mkdir");
        let jpeg =
            face_engine::encode::jpeg(&face_engine::image::RgbImage::new(4, 4), 90).expect("jpeg");
        std::fs::write(path, jpeg).expect("master");
    }

    fn entry(id: &str) -> ManifestEntry {
        ManifestEntry {
            photo_id: id.into(),
            frame_key: "k".into(),
            residual_px: 1.0,
            face_stats: None,
        }
    }

    #[test]
    fn snapshots_written_late_never_replace_newer_ones() {
        let root = tempfile::tempdir().expect("tempdir");
        let mut f = Frames::open(root.path(), "fp", Size::new(10, 10));
        put_master(&f, "a");
        put_master(&f, "b");
        f.insert(entry("a"));
        let older = f.take_write().expect("dirty");
        f.insert(entry("b"));
        let newer = f.take_write().expect("dirty");
        newer.write().expect("write newer");
        older.write().expect("late older write is skipped");
        let disk = Frames::open(root.path(), "fp", Size::new(10, 10));
        assert!(disk.current("a", "k").is_some() && disk.current("b", "k").is_some());
    }
}
