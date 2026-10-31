//! Persistent aligned-frame store, the align loop and the frame source for
//! video export (ARCHITECTURE §4.2, §5, D10).
//!
//! Layout under `{cache_dir}/frames/{fingerprint}/`:
//! - `m/{photoId}-{frameKey}.jpg` — master, JPEG q95 4:4:4 at output size;
//! - `p/{photoId}-{frameKey}-{w}.jpg` — previews (640 q85, 320 q80), look off;
//! - `look-{lookKey}/{photoId}-{frameKey}-{w|full}.jpg` — look-applied views;
//! - `manifest.bin` — postcard [`Manifest`]: the current frame of each photo
//!   (`frameKey`, residual, face statistics) + the reference look statistics.
//!
//! Why JPEG q95 4:4:4 masters: visually lossless, ~0.4 MB at 1080p (vs
//! ~6 MB raw/QOI-class lossless, ~3 MB PNG), decode in a few ms, and a JPEG
//! export without look is a plain byte copy. 3,600 frames ≈ 1.4 GB.
//!
//! [`align_frames`] is the one align loop (the [`crate::Engine`] facade and
//! the app's job runner both call it): reuse a master whose key is current,
//! else render it with a [`FrameRenderer`] on the current rayon pool, report
//! every finished item, honour cancellation between items.

use std::collections::HashMap;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use chrono::NaiveDate;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};

use crate::align::{
    self, FrameAdjust, FrameRequest, RenderSettings, RenderTarget, RenderedFrame, key_hash,
};
use crate::analysis::FaceRecord;
use crate::cache::{file_is_whole_jpeg, write_atomic, write_atomic_cache};
use crate::color::{FaceStats, FrameLook};
use crate::decode::{self, DecodeTarget};
use crate::detect::Detector;
use crate::encode::{self, Chroma};
use crate::error::{EngineError, ErrorKind, Result};
use crate::geometry::{Point, Rect, Size};
use crate::image::{Filter, RgbImage};
use crate::progress::{CancelToken, ProgressSink, Throughput, eta};

/// Preview widths written next to every master.
pub const PREVIEW_WIDTHS: [u32; 2] = [640, 320];

/// Version of the render pipeline, mixed into every render fingerprint. Bump
/// it whenever the same inputs would produce different pixels or keys, so
/// stale masters re-render. 2: `extended` backdrop, engine-owned keys.
pub const RENDER_VERSION: u32 = 2;

const MANIFEST_FILE: &str = "manifest.bin";
const MANIFEST_VERSION: u32 = 2;

/// Inputs of the render fingerprint (§4.2): anything that changes every frame.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FingerprintInputs<'a> {
    /// Engine fingerprint (version + models + detector parameters).
    pub engine: &'a str,
    /// Reference photo path.
    pub reference_path: &'a str,
    /// Reference photo version (size + mtime).
    pub reference_version: &'a str,
    /// Reference rotation.
    pub rotation_deg: f64,
    /// Crop in rotated-image pixels.
    pub crop: Rect,
    /// Aspect preset wire value.
    pub aspect: &'a str,
    /// Reference anchors (normalized to the crop).
    pub anchors: [Point; 5],
    /// Output size.
    pub output: Size,
    /// Render settings.
    pub settings: RenderSettings,
}

/// `fingerprint = blake3(RENDER_VERSION, …inputs)[..16]` over [`FingerprintInputs`].
#[must_use]
pub fn render_fingerprint(inputs: &FingerprintInputs<'_>) -> String {
    let json = stable_hex(&Quantized::of(inputs));
    key_hash(&[&RENDER_VERSION.to_string(), &json], 16)
}

/// [`FingerprintInputs`] with every float in fixed units (whole pixels,
/// micro-units of the crop, micro-degrees), so the fingerprint depends on
/// what the frames look like and not on the last bit of a float: a value
/// computed live and the same value read back from a file must give the same
/// fingerprint (QA: frames turned stale after a restart).
#[derive(Serialize)]
struct Quantized<'a> {
    engine: &'a str,
    reference_path: &'a str,
    reference_version: &'a str,
    rotation_micro_deg: i64,
    crop_px: [i64; 4],
    aspect: &'a str,
    anchors_micro: [[i64; 2]; 5],
    output: Size,
    settings: RenderSettings,
}

impl<'a> Quantized<'a> {
    fn of(i: &FingerprintInputs<'a>) -> Self {
        /// Units per pixel, per normalized crop unit and per degree.
        const MICRO: f64 = 1e6;
        #[allow(clippy::cast_possible_truncation)]
        let q = |v: f64, units: f64| (v * units).round() as i64;
        let c = i.crop;
        Self {
            engine: i.engine,
            reference_path: i.reference_path,
            reference_version: i.reference_version,
            rotation_micro_deg: q(i.rotation_deg, MICRO),
            crop_px: [c.x, c.y, c.width, c.height].map(|v| q(v, 1.0)),
            aspect: i.aspect,
            anchors_micro: i.anchors.map(|p| [q(p.x, MICRO), q(p.y, MICRO)]),
            output: i.output,
            settings: i.settings,
        }
    }
}

/// `frameKey = blake3(fingerprint, photo version, adjust)[..12]`.
#[must_use]
pub fn frame_key(fingerprint: &str, photo_version: &str, adjust: &FrameAdjust) -> String {
    let adj = format!(
        "{:.6}|{:.6}|{:.6}|{:.6}",
        adjust.dx, adjust.dy, adjust.scale, adjust.rotation_deg
    );
    key_hash(&[fingerprint, photo_version, &adj], 12)
}

fn stable_hex<T: Serialize>(v: &T) -> String {
    // postcard gives a stable, compact byte encoding; hex it for hashing.
    postcard::to_stdvec(v)
        .map(|b| b.iter().map(|x| format!("{x:02x}")).collect())
        .unwrap_or_default()
}

/// One manifest entry: the current master of a photo.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestEntry {
    /// Photo id.
    pub photo_id: String,
    /// Frame key.
    pub frame_key: String,
    /// RMS anchor residual (output px).
    pub residual_px: f64,
    /// Face statistics `[μL, μa, μb, σL, σa, σb]` (`None` if the region was empty).
    pub face_stats: Option<[f32; 6]>,
}

impl ManifestEntry {
    /// The face statistics as [`FaceStats`].
    #[must_use]
    pub fn stats(&self) -> Option<FaceStats> {
        self.face_stats.map(FaceStats::from_array)
    }
}

/// Frames of one fingerprint: the current master of each photo plus the
/// reference look statistics (computed once per fingerprint).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Manifest {
    entries: HashMap<String, ManifestEntry>,
    /// Face statistics of the reference frame, once computed.
    pub reference_stats: Option<FaceStats>,
}

impl Manifest {
    /// The photo's entry, whatever its key.
    #[must_use]
    pub fn get(&self, photo_id: &str) -> Option<&ManifestEntry> {
        self.entries.get(photo_id)
    }

    /// The photo's entry if it was rendered with `frame_key`.
    #[must_use]
    pub fn current(&self, photo_id: &str, frame_key: &str) -> Option<&ManifestEntry> {
        self.get(photo_id).filter(|e| e.frame_key == frame_key)
    }

    /// Records (or replaces) the photo's frame.
    pub fn insert(&mut self, entry: ManifestEntry) {
        self.entries.insert(entry.photo_id.clone(), entry);
    }

    /// All entries (unordered).
    pub fn entries(&self) -> impl ExactSizeIterator<Item = &ManifestEntry> {
        self.entries.values()
    }

    /// Number of photos with a frame.
    #[must_use]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// True when no frame was recorded.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

#[derive(Serialize, Deserialize)]
struct ManifestFile {
    version: u32,
    reference_stats: Option<[f32; 6]>,
    entries: Vec<ManifestEntry>,
}

/// `{cache_dir}/frames` — one folder per render fingerprint.
#[must_use]
pub fn root(cache_dir: &Path) -> PathBuf {
    cache_dir.join("frames")
}

/// Frames of one render fingerprint.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrameStore {
    root: PathBuf,
}

impl FrameStore {
    /// `{cache_dir}/frames/{fingerprint}`.
    #[must_use]
    pub fn new(cache_dir: &Path, fingerprint: &str) -> Self {
        Self {
            root: root(cache_dir).join(fingerprint),
        }
    }

    /// Store directory.
    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Master JPEG path.
    #[must_use]
    pub fn master_path(&self, photo_id: &str, frame_key: &str) -> PathBuf {
        self.root
            .join("m")
            .join(format!("{photo_id}-{frame_key}.jpg"))
    }

    /// Preview JPEG path (look off).
    #[must_use]
    pub fn preview_path(&self, photo_id: &str, frame_key: &str, w: u32) -> PathBuf {
        self.root
            .join("p")
            .join(format!("{photo_id}-{frame_key}-{w}.jpg"))
    }

    /// Look-applied view (`w = None` ⇒ master size); `look_key` is
    /// [`crate::color::LookSettings::cache_key`].
    #[must_use]
    pub fn look_preview_path(
        &self,
        look_key: &str,
        photo_id: &str,
        frame_key: &str,
        w: Option<u32>,
    ) -> PathBuf {
        let w = w.map_or_else(|| "full".to_owned(), |w| w.to_string());
        self.root
            .join(format!("look-{look_key}"))
            .join(format!("{photo_id}-{frame_key}-{w}.jpg"))
    }

    /// Writes the master and previews of a rendered frame.
    ///
    /// # Errors
    /// Encode or I/O errors.
    pub fn write(
        &self,
        photo_id: &str,
        frame_key: &str,
        frame: &RenderedFrame,
    ) -> Result<ManifestEntry> {
        let master = encode::jpeg(&frame.image, crate::export::MASTER_QUALITY)?;
        // Rebuildable files: atomic but not fsynced (see `write_atomic_cache`);
        // `has_master` rejects one a power loss cut short.
        write_atomic_cache(&self.master_path(photo_id, frame_key), &master)?;
        for w in PREVIEW_WIDTHS {
            let bytes = preview_bytes(&frame.image, w)?;
            write_atomic_cache(&self.preview_path(photo_id, frame_key, w), &bytes)?;
        }
        Ok(ManifestEntry {
            photo_id: photo_id.to_owned(),
            frame_key: frame_key.to_owned(),
            residual_px: frame.residual_px,
            face_stats: frame.face_stats.map(|s| s.to_array()),
        })
    }

    /// True when the master exists and is a whole JPEG (one cut short by a
    /// power loss is rendered again).
    #[must_use]
    pub fn has_master(&self, photo_id: &str, frame_key: &str) -> bool {
        file_is_whole_jpeg(&self.master_path(photo_id, frame_key))
    }

    /// [`FrameStore::load_manifest`] without the frames whose master is
    /// missing or was cut short by a power loss ([`FrameStore::has_master`]),
    /// so they count as not aligned and align renders them again.
    #[must_use]
    pub fn load_usable_manifest(&self) -> Manifest {
        let mut manifest = self.load_manifest();
        let before = manifest.entries.len();
        manifest
            .entries
            .retain(|_, e| self.has_master(&e.photo_id, &e.frame_key));
        let dropped = before - manifest.entries.len();
        if dropped > 0 {
            log::warn!(
                "{dropped} aligned frames are missing or incomplete; they will be aligned again"
            );
        }
        manifest
    }

    /// Loads the manifest (empty when missing, unreadable or of another version).
    #[must_use]
    pub fn load_manifest(&self) -> Manifest {
        let Ok(bytes) = std::fs::read(self.root.join(MANIFEST_FILE)) else {
            return Manifest::default();
        };
        match postcard::from_bytes::<ManifestFile>(&bytes) {
            Ok(m) if m.version == MANIFEST_VERSION => {
                let mut manifest = Manifest {
                    reference_stats: m.reference_stats.map(FaceStats::from_array),
                    ..Manifest::default()
                };
                for e in m.entries {
                    manifest.insert(e);
                }
                manifest
            }
            Ok(_) => {
                log::info!("frame manifest of another version ignored");
                Manifest::default()
            }
            Err(e) => {
                log::warn!("frame manifest unreadable, ignoring: {e}");
                Manifest::default()
            }
        }
    }

    /// Saves the manifest atomically.
    ///
    /// # Errors
    /// Encode or I/O errors.
    pub fn save_manifest(&self, manifest: &Manifest) -> Result<()> {
        let mut entries: Vec<ManifestEntry> = manifest.entries().cloned().collect();
        entries.sort_by(|a, b| a.photo_id.cmp(&b.photo_id));
        let file = ManifestFile {
            version: MANIFEST_VERSION,
            reference_stats: manifest.reference_stats.map(|s| s.to_array()),
            entries,
        };
        let bytes = postcard::to_stdvec(&file)
            .map_err(|e| EngineError::Internal(format!("manifest: {e}")))?;
        write_atomic(&self.root.join(MANIFEST_FILE), &bytes)
    }

    /// True when another fingerprint next to this one has frames (so an empty
    /// store means "stale" rather than "never aligned").
    #[must_use]
    pub fn others_exist(&self) -> bool {
        let (Some(parent), Some(own)) = (self.root.parent(), self.root.file_name()) else {
            return false;
        };
        std::fs::read_dir(parent).is_ok_and(|rd| {
            rd.flatten()
                .any(|e| e.file_name() != own && e.path().join(MANIFEST_FILE).is_file())
        })
    }

    /// Deletes `look-*` folders other than `keep_look_key`'s; returns how many.
    #[must_use]
    pub fn prune_looks(&self, keep_look_key: &str) -> usize {
        let keep = format!("look-{keep_look_key}");
        let Ok(rd) = std::fs::read_dir(&self.root) else {
            return 0;
        };
        rd.flatten()
            .filter(|e| {
                let name = e.file_name();
                let name = name.to_string_lossy();
                name.starts_with("look-") && name != keep
            })
            .filter(|e| std::fs::remove_dir_all(e.path()).is_ok())
            .count()
    }
}

/// Encodes a preview of width bucket `w` (fit inside `w × w`; q85 ≥ 640, else q80).
///
/// # Errors
/// Resize/encode failures.
pub fn preview_bytes(img: &RgbImage, w: u32) -> Result<Vec<u8>> {
    let small = img.fit_within(w, Filter::CatmullRom)?;
    let q = if w >= 640 { 85 } else { 80 };
    encode::jpeg_with(&small, q, Chroma::Subsampled)
}

/// A frame view as JPEG: a preview for `Some(w)`, else master quality at full size.
///
/// # Errors
/// Resize/encode failures.
pub fn view_bytes(img: &RgbImage, w: Option<u32>) -> Result<Vec<u8>> {
    match w {
        Some(w) => preview_bytes(img, w),
        None => encode::jpeg(img, crate::export::MASTER_QUALITY),
    }
}

/// Folders used within this long are never pruned (a fingerprint whose
/// first frames are being rendered has no manifest yet).
pub const PRUNE_GRACE: std::time::Duration = std::time::Duration::from_secs(3600);

/// Keeps `current` plus the `keep − 1` most recently used other fingerprint
/// folders (by manifest mtime, else the folder's own mtime) and anything used
/// within [`PRUNE_GRACE`]; returns how many were deleted. Never deletes
/// `current`.
#[must_use]
pub fn prune_fingerprints(cache_dir: &Path, current: &str, keep: usize) -> usize {
    let Ok(rd) = std::fs::read_dir(root(cache_dir)) else {
        return 0;
    };
    let modified = |p: &Path| p.metadata().and_then(|m| m.modified()).ok();
    let mut dirs: Vec<(std::time::SystemTime, PathBuf)> = rd
        .flatten()
        .filter(|e| e.path().is_dir() && e.file_name().to_string_lossy() != current)
        .map(|e| {
            let used = modified(&e.path().join(MANIFEST_FILE))
                .or_else(|| modified(&e.path()))
                .unwrap_or(std::time::UNIX_EPOCH);
            (used, e.path())
        })
        .collect();
    dirs.sort_by_key(|d| std::cmp::Reverse(d.0));
    let now = std::time::SystemTime::now();
    dirs.into_iter()
        .skip(keep.saturating_sub(1))
        .filter(|(used, _)| now.duration_since(*used).is_ok_and(|age| age > PRUNE_GRACE))
        .filter(|(_, p)| std::fs::remove_dir_all(p).is_ok())
        .count()
}

/// Decodes a master and applies its look (if any).
///
/// # Errors
/// I/O or decode errors; `NotFound` for a master a power loss cut short
/// (masters are not fsynced): it must be rendered again, never decoded with
/// a filled-in tail.
pub fn load_master(master: &Path, look: Option<&FrameLook>) -> Result<RgbImage> {
    let bytes = whole_master(master)?;
    let mut img = decode::decode(&bytes, master, 1, DecodeTarget::Full)?.image;
    if let Some(look) = look {
        look.apply(&mut img);
    }
    Ok(img)
}

/// A master's bytes, provided it is a whole JPEG (see [`load_master`]).
///
/// # Errors
/// I/O errors; `NotFound` when the file is missing or cut short.
pub fn whole_master(master: &Path) -> Result<Vec<u8>> {
    let bytes = decode::read_file(master)?;
    if crate::cache::is_whole_jpeg(&bytes) {
        Ok(bytes)
    } else {
        Err(EngineError::io(
            format!("reading {}", master.display()),
            std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "the aligned frame is incomplete; align again",
            ),
        ))
    }
}

mod align_loop;
mod sequence;

pub use align_loop::{
    AlignFailure, AlignItem, AlignJob, AlignProgress, AlignReport, AlignSpec, AlignedFrame,
    FrameRenderer, align_frames, render_item,
};
pub use sequence::{FrameLoader, FrameSequence, FrameSpec, RgbFrame, load_frame};

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::color::{LookSettings, NormalizeMode};
    use crate::decode::tests::pattern;
    use crate::geometry::Similarity;

    pub(crate) fn rendered() -> RenderedFrame {
        RenderedFrame {
            image: pattern(96, 64),
            residual_px: 1.5,
            face_stats: Some(FaceStats {
                mean: [0.5, 0.01, 0.02],
                std: [0.1, 0.01, 0.01],
            }),
            transform: Similarity::IDENTITY,
            source_anchors: [Point::default(); 5],
            refined: true,
        }
    }

    pub(crate) fn entry(id: &str, key: &str) -> ManifestEntry {
        ManifestEntry {
            photo_id: id.into(),
            frame_key: key.into(),
            residual_px: 1.0,
            face_stats: None,
        }
    }

    #[test]
    fn keys_change_with_inputs() {
        let base = FingerprintInputs {
            engine: "e",
            reference_path: "/r.jpg",
            reference_version: "v",
            rotation_deg: 0.0,
            crop: Rect::new(0.0, 0.0, 10.0, 10.0),
            aspect: "free",
            anchors: [Point::new(0.5, 0.5); 5],
            output: Size::new(1920, 1080),
            settings: RenderSettings::default(),
        };
        let a = render_fingerprint(&base);
        assert_eq!(a.len(), 16);
        assert_eq!(a, render_fingerprint(&base.clone()));
        let rotated = FingerprintInputs {
            rotation_deg: 1.0,
            ..base.clone()
        };
        assert_ne!(a, render_fingerprint(&rotated));
        let other_out = FingerprintInputs {
            output: Size::new(1280, 720),
            ..base.clone()
        };
        assert_ne!(a, render_fingerprint(&other_out));
        let other_backdrop = FingerprintInputs {
            settings: RenderSettings {
                backdrop: crate::warp::BackdropMode::Black,
                ..RenderSettings::default()
            },
            ..base.clone()
        };
        assert_ne!(a, render_fingerprint(&other_backdrop));
        let moved = FingerprintInputs {
            anchors: [Point::new(0.4, 0.5); 5],
            ..base.clone()
        };
        assert_ne!(a, render_fingerprint(&moved));
        let cropped = FingerprintInputs {
            crop: Rect::new(1.0, 0.0, 10.0, 10.0),
            ..base.clone()
        };
        assert_ne!(a, render_fingerprint(&cropped), "one pixel");
        // The last bit of a float (a value read back from a file) changes nothing.
        let ulp = |v: f64| f64::from_bits(v.to_bits() + 1);
        let noisy = FingerprintInputs {
            rotation_deg: ulp(9.358_281_489_029_741),
            anchors: [Point::new(ulp(0.5), 0.5); 5],
            ..base.clone()
        };
        let exact = FingerprintInputs {
            rotation_deg: 9.358_281_489_029_741,
            ..base
        };
        assert_eq!(render_fingerprint(&noisy), render_fingerprint(&exact));
        let k = frame_key("fp", "ver", &FrameAdjust::default());
        assert_eq!(k.len(), 12);
        assert_ne!(
            k,
            frame_key(
                "fp",
                "ver",
                &FrameAdjust {
                    dx: 0.01,
                    ..FrameAdjust::default()
                }
            )
        );
        assert_ne!(k, frame_key("fp", "ver2", &FrameAdjust::default()));
    }

    #[test]
    fn a_master_cut_short_is_never_decoded_exported_or_listed() {
        let dir = tempfile::tempdir().expect("tmp");
        let store = FrameStore::new(dir.path(), "abc");
        let e = store.write("p1", "k1", &rendered()).expect("write");
        let mut m = Manifest::default();
        m.insert(e);
        store.save_manifest(&m).expect("manifest");
        let master = store.master_path("p1", "k1");
        let whole = std::fs::read(&master).expect("master");
        assert!(load_master(&master, None).is_ok());
        assert_eq!(whole_master(&master).expect("whole"), whole);
        for torn in [&whole[..whole.len() / 2], &[][..]] {
            std::fs::write(&master, torn).expect("tear");
            for err in [
                load_master(&master, None).expect_err("torn").kind(),
                whole_master(&master).expect_err("torn").kind(),
            ] {
                assert_eq!(err, ErrorKind::NotFound, "{} bytes", torn.len());
            }
            assert!(store.load_usable_manifest().is_empty(), "aligned again");
            assert_eq!(store.load_manifest().len(), 1, "the record itself is kept");
        }
    }

    #[test]
    fn store_writes_masters_previews_and_manifest() {
        let dir = tempfile::tempdir().expect("tmp");
        let store = FrameStore::new(dir.path(), "abc");
        assert!(store.root().ends_with("frames/abc"));
        let e = store.write("p1", "k1", &rendered()).expect("write");
        assert!(store.has_master("p1", "k1"));
        assert!(!store.has_master("p1", "k2"));
        // A master a power loss cut short (or zero-filled) is not reused.
        let master = store.master_path("p1", "k1");
        let whole = std::fs::read(&master).expect("master");
        std::fs::write(&master, &whole[..whole.len() / 2]).expect("cut");
        assert!(!store.has_master("p1", "k1"), "cut short");
        std::fs::write(&master, vec![0u8; whole.len()]).expect("zeros");
        assert!(!store.has_master("p1", "k1"), "zero-filled");
        std::fs::write(&master, &whole).expect("restore");
        for w in PREVIEW_WIDTHS {
            assert!(store.preview_path("p1", "k1", w).is_file());
        }
        assert!(store.load_manifest().is_empty());
        let mut m = Manifest::default();
        m.insert(e.clone());
        m.insert(entry("p2", "k9"));
        m.reference_stats = Some(FaceStats::from_array([1.0; 6]));
        store.save_manifest(&m).expect("manifest");
        let back = store.load_manifest();
        assert_eq!(back, m);
        assert_eq!(back.len(), 2);
        assert_eq!(back.current("p1", "k1"), Some(&e));
        assert!(back.current("p1", "other").is_none());
        assert_eq!(
            back.get("p1")
                .and_then(ManifestEntry::stats)
                .map(|s| s.mean[0]),
            Some(0.5)
        );
        assert_eq!(back.entries().count(), 2);
        // Only frames with a whole master are usable: p2 has no master.
        let usable = store.load_usable_manifest();
        assert_eq!(
            (usable.len(), usable.current("p1", "k1")),
            (1, Some(&e)),
            "a frame without its master counts as not aligned"
        );
        // A newer render of the same photo replaces its entry.
        m.insert(entry("p1", "k2"));
        assert_eq!(
            (m.len(), m.get("p1").map(|e| e.frame_key.as_str())),
            (2, Some("k2"))
        );
        assert!(
            store
                .look_preview_path("lh", "p1", "k1", Some(320))
                .ends_with("look-lh/p1-k1-320.jpg")
        );
        assert!(
            store
                .look_preview_path("lh", "p1", "k1", None)
                .ends_with("look-lh/p1-k1-full.jpg")
        );
        // Corrupt and foreign manifests are ignored.
        std::fs::write(store.root().join(MANIFEST_FILE), b"junk").expect("corrupt");
        assert!(store.load_manifest().is_empty());
        let old = postcard::to_stdvec(&ManifestFile {
            version: 1,
            reference_stats: None,
            entries: vec![entry("p1", "k1")],
        })
        .expect("enc");
        std::fs::write(store.root().join(MANIFEST_FILE), old).expect("old");
        assert!(store.load_manifest().is_empty(), "other version");
    }

    #[test]
    fn view_bytes_and_look_loading() {
        let dir = tempfile::tempdir().expect("tmp");
        let store = FrameStore::new(dir.path(), "abc");
        store.write("p1", "k1", &rendered()).expect("write");
        let master = store.master_path("p1", "k1");
        let plain = load_master(&master, None).expect("plain");
        assert_eq!(plain.size(), Size::new(96, 64));
        let full = view_bytes(&plain, None).expect("full");
        let small = view_bytes(&plain, Some(32)).expect("small");
        assert!(small.len() < full.len());
        let stats = rendered().face_stats.expect("stats");
        let look = FrameLook {
            frame: stats,
            reference: FaceStats {
                mean: [0.7, 0.01, 0.02],
                ..stats
            },
            settings: LookSettings {
                normalize: NormalizeMode::Exposure,
                strength: 1.0,
            },
        };
        let lit = load_master(&master, Some(&look)).expect("look");
        let mean = |i: &RgbImage| {
            i.as_raw().iter().map(|&v| f64::from(v)).sum::<f64>() / i.as_raw().len() as f64
        };
        assert!(mean(&lit) > mean(&plain) + 10.0);
        assert!(load_master(&dir.path().join("none.jpg"), None).is_err());
    }

    pub(crate) fn set_age(path: &Path, days: u64) {
        let when = std::time::SystemTime::now() - std::time::Duration::from_secs(days * 86_400);
        std::fs::File::open(path)
            .and_then(|f| f.set_modified(when))
            .expect("set mtime");
    }

    #[test]
    fn prune_keeps_current_newest_and_brand_new_folders() {
        let dir = tempfile::tempdir().expect("tmp");
        // Explicit ages (no sleeps): a is current but the oldest.
        for (fp, days) in [("a", 40), ("b", 30), ("c", 20), ("d", 10)] {
            let s = FrameStore::new(dir.path(), fp);
            s.save_manifest(&Manifest::default()).expect("manifest");
            set_age(&s.root().join(MANIFEST_FILE), days);
        }
        // A fingerprint whose first frames are being rendered right now: no
        // manifest yet, but the folder is fresh.
        std::fs::create_dir_all(root(dir.path()).join("new/m")).expect("mkdir");
        assert!(FrameStore::new(dir.path(), "a").others_exist());
        // Current + the 2 most recently used others survive (new, d).
        assert_eq!(prune_fingerprints(dir.path(), "a", 3), 2);
        assert!(root(dir.path()).join("a").is_dir(), "current never pruned");
        assert!(!root(dir.path()).join("b").exists() && !root(dir.path()).join("c").exists());
        assert!(root(dir.path()).join("d").is_dir());
        // Keeping only the current one still spares the in-progress folder.
        assert_eq!(prune_fingerprints(dir.path(), "a", 1), 1);
        assert!(!root(dir.path()).join("d").exists());
        assert!(
            root(dir.path()).join("new").is_dir(),
            "in-progress folder kept"
        );
        assert_eq!(prune_fingerprints(&dir.path().join("none"), "a", 1), 0);
        let lonely = tempfile::tempdir().expect("tmp");
        assert!(!FrameStore::new(lonely.path(), "x").others_exist());
        assert!(
            !FrameStore {
                root: PathBuf::from("/")
            }
            .others_exist()
        );
    }

    #[test]
    fn prune_looks_keeps_the_current_look() {
        let dir = tempfile::tempdir().expect("tmp");
        let store = FrameStore::new(dir.path(), "fp");
        for d in ["look-aa", "look-bb", "m", "p"] {
            std::fs::create_dir_all(store.root().join(d)).expect("mkdir");
        }
        assert_eq!(store.prune_looks("aa"), 1);
        assert!(store.root().join("look-aa").is_dir());
        assert!(store.root().join("m").is_dir());
        assert_eq!(FrameStore::new(dir.path(), "none").prune_looks("aa"), 0);
    }
}
