//! Source-photo thumbnails with an on-disk cache (ARCHITECTURE §5, §6).
//!
//! Layout: `{cache_dir}/thumbs/{id[0..2]}/{id}-{photoVersion}-{w}.jpg`.
//! Widths are bucketed (160, 320, 640, 1280, 2048); the image fits inside
//! `w × w`. Quality: q80 up to 640 px, q85 above.
//!
//! Fast paths: the scan writes the 320 bucket from the image it already
//! decoded; smaller buckets are derived from that cached 320 thumbnail (no
//! source read at all); otherwise for the 160 bucket the EXIF thumbnail is
//! used when its aspect ratio matches the photo (no black bars) — often a
//! zero-decode byte copy; else the photo is decoded with DCT scaling just
//! above the bucket size.

use std::path::{Path, PathBuf};

use crate::analysis::encode_thumbnail;
use crate::cache::{is_whole_jpeg, write_atomic_cache};
use crate::decode::{self, DecodeTarget};
use crate::error::Result;
use crate::image::Filter;

/// Thumbnail width buckets.
pub const THUMB_WIDTHS: [u32; 5] = [160, 320, 640, 1280, 2048];
/// Bucket written during scans.
pub const SCAN_THUMB_WIDTH: u32 = 320;

/// Rounds `w` up to the next bucket (largest bucket if above).
#[must_use]
pub fn bucket(w: u32) -> u32 {
    THUMB_WIDTHS
        .iter()
        .copied()
        .find(|&b| b >= w)
        .unwrap_or(THUMB_WIDTHS[THUMB_WIDTHS.len() - 1])
}

/// `{cache_dir}/thumbs`.
#[must_use]
pub fn dir(cache_dir: &Path) -> PathBuf {
    cache_dir.join("thumbs")
}

/// Cache path of a thumbnail.
#[must_use]
pub fn path(cache_dir: &Path, id: &str, version: &str, w: u32) -> PathBuf {
    let shard = id.get(..2).unwrap_or("00");
    dir(cache_dir)
        .join(shard)
        .join(format!("{id}-{version}-{w}.jpg"))
}

/// Returns the JPEG thumbnail of `photo` for bucket `bucket(w)`, reading the
/// disk cache when possible and filling it on a miss (if `cache_dir` is set).
///
/// # Errors
/// I/O, decode and encode failures.
pub fn thumbnail(
    cache_dir: Option<&Path>,
    photo: &Path,
    id: &str,
    version: &str,
    w: u32,
) -> Result<Vec<u8>> {
    let w = bucket(w);
    let Some(cache_dir) = cache_dir else {
        return render(photo, w);
    };
    let cached = path(cache_dir, id, version, w);
    if let Some(bytes) = std::fs::read(&cached).ok().filter(|b| is_whole_jpeg(b)) {
        return Ok(bytes);
    }
    let bytes = render_uncached(cache_dir, photo, id, version, w)?;
    if let Err(e) = write_atomic_cache(&cached, &bytes) {
        log::debug!("thumbnail cache write failed: {e}");
    }
    Ok(bytes)
}

/// Renders bucket `bucket(w)` without reading or writing its own cache file
/// (for callers that manage the file themselves, e.g. an image protocol with
/// in-flight coalescing): buckets below the scan's 320 are derived from the
/// cached 320 thumbnail when present, else [`render`] from the photo.
///
/// # Errors
/// I/O, decode and encode failures.
pub fn render_uncached(
    cache_dir: &Path,
    photo: &Path,
    id: &str,
    version: &str,
    w: u32,
) -> Result<Vec<u8>> {
    let w = bucket(w);
    if w < SCAN_THUMB_WIDTH {
        let scan = path(cache_dir, id, version, SCAN_THUMB_WIDTH);
        if let Some(img) = std::fs::read(&scan)
            .ok()
            .filter(|b| is_whole_jpeg(b))
            .and_then(|b| decode::decode(&b, &scan, 1, DecodeTarget::Full).ok())
        {
            return encode_thumbnail(&img.image, w);
        }
    }
    render(photo, w)
}

/// Renders a thumbnail without touching any cache.
///
/// # Errors
/// I/O, decode and encode failures.
pub fn render(photo: &Path, w: u32) -> Result<Vec<u8>> {
    let bytes = decode::read_file(photo)?;
    render_bytes(&bytes, photo, w)
}

/// [`render`] for a file already in memory (`photo` is only used in errors).
/// Uses the EXIF thumbnail for `w ≤ 160` when it fits, else a DCT-scaled
/// decode just above `w`. Output fits inside `w × w` (q80 ≤ 640, q85 above).
///
/// # Errors
/// Decode and encode failures.
pub fn render_bytes(bytes: &[u8], photo: &Path, w: u32) -> Result<Vec<u8>> {
    let exif = decode::read_exif(bytes);
    if let Some(t) = (w <= THUMB_WIDTHS[0])
        .then(|| exif_thumbnail(bytes, &exif, photo, w))
        .flatten()
    {
        return Ok(t);
    }
    let decoded = decode::decode(bytes, photo, exif.orientation, DecodeTarget::MinLongEdge(w))?;
    encode_thumbnail(&decoded.image, w)
}

/// Uses the embedded EXIF JPEG when it is big enough and has the photo's
/// aspect ratio (±1 %).
fn exif_thumbnail(bytes: &[u8], exif: &decode::ExifInfo, photo: &Path, w: u32) -> Option<Vec<u8>> {
    let range = exif.thumbnail.clone()?;
    let thumb = bytes.get(range)?;
    let full = decode::probe_size(bytes, photo, exif.orientation).ok()?;
    let t = decode::decode(thumb, photo, exif.orientation, DecodeTarget::Full).ok()?;
    let size = t.image.size();
    let aspect = |s: crate::geometry::Size| f64::from(s.width) / f64::from(s.height.max(1));
    if (aspect(size) / aspect(full) - 1.0).abs() > 0.01
        || size.long_edge() < w.min(full.long_edge())
    {
        return None;
    }
    if exif.orientation == 1 && size.long_edge() <= w {
        return Some(thumb.to_vec());
    }
    let fitted = t.image.fit_within(w, Filter::CatmullRom).ok()?;
    crate::encode::jpeg_with(&fitted, 80, crate::encode::Chroma::Subsampled).ok()
}

/// Removes thumbnails (oldest first) until the folder is below `target_bytes`,
/// but only if it currently exceeds `trigger_bytes`. Returns bytes freed.
#[must_use]
pub fn prune(cache_dir: &Path, trigger_bytes: u64, target_bytes: u64) -> u64 {
    let root = dir(cache_dir);
    let mut files: Vec<(std::time::SystemTime, u64, PathBuf)> = Vec::new();
    for shard in std::fs::read_dir(&root).into_iter().flatten().flatten() {
        for f in std::fs::read_dir(shard.path())
            .into_iter()
            .flatten()
            .flatten()
        {
            if let Ok(meta) = f.metadata() {
                let used = meta.accessed().or_else(|_| meta.modified());
                if let Ok(t) = used {
                    files.push((t, meta.len(), f.path()));
                }
            }
        }
    }
    let mut total: u64 = files.iter().map(|f| f.1).sum();
    if total <= trigger_bytes {
        return 0;
    }
    files.sort_by_key(|f| f.0);
    let mut freed = 0;
    for (_, len, p) in files {
        if total <= target_bytes {
            break;
        }
        if std::fs::remove_file(&p).is_ok() {
            total -= len;
            freed += len;
        }
    }
    freed
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::decode::tests::{jpeg_bytes, pattern};
    use crate::geometry::Size;

    #[test]
    fn buckets_round_up() {
        assert_eq!(bucket(0), 160);
        assert_eq!(bucket(160), 160);
        assert_eq!(bucket(161), 320);
        assert_eq!(bucket(700), 1280);
        assert_eq!(bucket(9999), 2048);
    }

    #[test]
    fn paths_are_sharded() {
        let p = path(Path::new("/c"), "abcdef0123456789", "deadbeef", 320);
        assert_eq!(
            p,
            Path::new("/c/thumbs/ab/abcdef0123456789-deadbeef-320.jpg")
        );
        assert_eq!(
            path(Path::new("/c"), "a", "v", 1),
            Path::new("/c/thumbs/00/a-v-1.jpg")
        );
    }

    #[test]
    fn renders_and_caches() {
        let dir = tempfile::tempdir().expect("tmp");
        let photo = dir.path().join("p.jpg");
        std::fs::write(&photo, jpeg_bytes(&pattern(1200, 900))).expect("write");
        let cache = dir.path().join("cache");
        let a = thumbnail(Some(&cache), &photo, "abcd", "v1", 300).expect("thumb");
        let cached = path(&cache, "abcd", "v1", 320);
        assert!(cached.is_file());
        let d = decode::decode(&a, Path::new("t.jpg"), 1, DecodeTarget::Full).expect("decode");
        assert_eq!(d.image.size(), Size::new(320, 240));
        // Second call is served from disk (even if the photo disappears).
        std::fs::remove_file(&photo).expect("rm");
        let b = thumbnail(Some(&cache), &photo, "abcd", "v1", 320).expect("cached");
        assert_eq!(a, b);
        // A cached file a power loss cut short is not served: rendered again.
        std::fs::write(&photo, jpeg_bytes(&pattern(1200, 900))).expect("write");
        std::fs::write(&cached, &a[..a.len() / 2]).expect("cut");
        let c = thumbnail(Some(&cache), &photo, "abcd", "v1", 320).expect("again");
        assert!(crate::cache::is_whole_jpeg(&c));
        assert_eq!(std::fs::read(&cached).expect("rewritten"), c);
        std::fs::remove_file(&photo).expect("rm");
        assert!(thumbnail(None, &photo, "abcd", "v1", 320).is_err());
        let small = render(&dir.path().join("missing.jpg"), 160);
        assert!(small.is_err());
    }

    #[test]
    fn small_buckets_derive_from_the_scan_thumbnail() {
        let dir = tempfile::tempdir().expect("tmp");
        let photo = dir.path().join("p.jpg");
        std::fs::write(&photo, jpeg_bytes(&pattern(1200, 900))).expect("write");
        let cache = dir.path().join("cache");
        // No 320 yet: rendered from the photo.
        let direct = render_uncached(&cache, &photo, "abcd", "v1", 100).expect("direct");
        assert!(!path(&cache, "abcd", "v1", 160).exists(), "uncached");
        let scan = thumbnail(Some(&cache), &photo, "abcd", "v1", 320).expect("320");
        assert!(!scan.is_empty());
        // With the 320 cached the photo is not needed any more.
        std::fs::remove_file(&photo).expect("rm");
        let derived = render_uncached(&cache, &photo, "abcd", "v1", 100).expect("derived");
        let d = decode::decode(&derived, Path::new("t.jpg"), 1, DecodeTarget::Full).expect("dec");
        assert_eq!(d.image.size(), Size::new(160, 120));
        // A 320 a power loss cut short (or emptied) is not a source: without
        // the photo there is nothing to derive from.
        let scan_file = path(&cache, "abcd", "v1", SCAN_THUMB_WIDTH);
        for torn in [&scan[..scan.len() / 2], &[][..]] {
            std::fs::write(&scan_file, torn).expect("tear");
            assert!(render_uncached(&cache, &photo, "abcd", "v1", 100).is_err());
        }
        std::fs::write(&photo, jpeg_bytes(&pattern(1200, 900))).expect("photo back");
        let again = render_uncached(&cache, &photo, "abcd", "v1", 100).expect("from the photo");
        assert_eq!(again, direct);
        std::fs::remove_file(&photo).expect("rm");
        std::fs::write(&scan_file, &scan).expect("whole again");
        assert!(!direct.is_empty());
        assert!(
            render_uncached(&cache, &photo, "abcd", "v1", 640).is_err(),
            "needs the photo"
        );
        assert_eq!(dir_of(&cache), cache.join("thumbs"));
    }

    fn dir_of(cache: &Path) -> PathBuf {
        super::dir(cache)
    }

    #[test]
    fn small_bucket_without_exif_thumbnail_decodes() {
        let dir = tempfile::tempdir().expect("tmp");
        let photo = dir.path().join("p.jpg");
        std::fs::write(&photo, jpeg_bytes(&pattern(640, 480))).expect("write");
        let t = render(&photo, 160).expect("render");
        let d = decode::decode(&t, Path::new("t.jpg"), 1, DecodeTarget::Full).expect("decode");
        assert_eq!(d.image.size(), Size::new(160, 120));
    }

    #[test]
    fn prune_frees_oldest_until_target() {
        let dir = tempfile::tempdir().expect("tmp");
        for i in 0..4 {
            let p = path(dir.path(), &format!("{i:02}xx"), "v", 160);
            write_atomic_cache(&p, &[0u8; 100]).expect("write");
        }
        assert_eq!(prune(dir.path(), 1000, 100), 0, "below trigger");
        assert_eq!(prune(dir.path(), 300, 200), 200);
        assert_eq!(prune(&dir.path().join("none"), 0, 0), 0);
    }
}
