//! Image export (ARCHITECTURE §9.7, LEGACY-SPEC §4.12).
//!
//! - name `YYYYMMDD.{png|jpg}`; a name already used in this batch — or
//!   present on disk when `overwrite` is false — gets `_1`, `_2`, … before
//!   the extension (legacy suffix style);
//! - files are written to an exclusive hidden `.{name}.{pid}-{n}.tmp` in the
//!   target folder, fsynced, then moved into place (never replacing a file
//!   unless `overwrite`, never following a planted symlink);
//! - pixels = master + look; JPEG q95 without look is a byte copy of the master.
//!
//! [`export_images`] is the one export loop (the [`crate::Engine`] facade and
//! the app's job runner both call it).

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use chrono::{Datelike, NaiveDate};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};

use crate::color::FrameLook;
use crate::encode;
use crate::error::{EngineError, Result};
use crate::progress::{CancelToken, ProgressSink, Throughput};

/// Exported file format.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ImageFormat {
    /// PNG (lossless, fast deflate).
    #[default]
    Png,
    /// JPEG (4:4:4).
    Jpeg,
}

impl ImageFormat {
    /// File extension without the dot.
    #[must_use]
    pub fn extension(self) -> &'static str {
        match self {
            Self::Png => "png",
            Self::Jpeg => "jpg",
        }
    }
}

/// Export settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageExportSettings {
    /// Format.
    pub format: ImageFormat,
    /// JPEG quality 50–100.
    pub jpeg_quality: u8,
    /// Replace files that already exist in the folder.
    pub overwrite: bool,
}

impl Default for ImageExportSettings {
    fn default() -> Self {
        Self {
            format: ImageFormat::Png,
            jpeg_quality: 95,
            overwrite: false,
        }
    }
}

impl ImageExportSettings {
    /// Checks the quality range.
    ///
    /// # Errors
    /// [`EngineError::InvalidArgument`].
    pub fn validate(&self) -> Result<()> {
        if (50..=100).contains(&self.jpeg_quality) {
            Ok(())
        } else {
            Err(EngineError::InvalidArgument(
                "JPEG quality must be between 50 and 100".into(),
            ))
        }
    }
}

/// Quality of aligned masters; a JPEG export at this quality without look
/// is a byte copy.
pub const MASTER_QUALITY: u8 = 95;

/// Picks `YYYYMMDD.ext`, or the first free `YYYYMMDD_n.ext` (n = 1, 2, …)
/// for which `taken` is false. Returns the name and whether a suffix was added.
#[must_use]
pub fn file_name(day: NaiveDate, ext: &str, taken: impl Fn(&str) -> bool) -> (String, bool) {
    let base = format!("{:04}{:02}{:02}", day.year(), day.month(), day.day());
    let first = format!("{base}.{ext}");
    if !taken(&first) {
        return (first, false);
    }
    (1u32..)
        .map(|n| format!("{base}_{n}.{ext}"))
        .find(|name| !taken(name))
        .map_or((first, false), |name| (name, true))
}

/// Assigns names for a batch, remembering names used so far.
#[derive(Debug, Clone)]
pub struct NamePlanner {
    dir: PathBuf,
    overwrite: bool,
    used: HashSet<String>,
}

impl NamePlanner {
    /// Planner for `dir`.
    #[must_use]
    pub fn new(dir: &Path, overwrite: bool) -> Self {
        Self {
            dir: dir.to_path_buf(),
            overwrite,
            used: HashSet::new(),
        }
    }

    /// Next name for `day`; returns `(path, renamed)`.
    pub fn next(&mut self, day: NaiveDate, format: ImageFormat) -> (PathBuf, bool) {
        let (name, renamed) = file_name(day, format.extension(), |n| {
            self.used.contains(n) || (!self.overwrite && self.dir.join(n).exists())
        });
        self.used.insert(name.clone());
        (self.dir.join(name), renamed)
    }
}

/// Writes one exported image from a master JPEG and returns where it went
/// (`look`'s LUT is built here, on the calling worker; a no-op look counts as
/// no look).
///
/// The bytes go to an exclusive hidden temporary file (never an existing
/// file or a planted symlink) and are fsynced; then, with `overwrite`, the
/// temporary file is renamed over `dest`. Without it, `dest` is created only
/// if it still does not exist — a file that appeared since the names were
/// planned is never replaced; the next free `_n` name is used instead.
///
/// # Errors
/// Decode/encode/I/O errors (the temporary file is removed on failure).
pub fn write_image(
    master: &Path,
    dest: &Path,
    settings: &ImageExportSettings,
    look: Option<&FrameLook>,
) -> Result<PathBuf> {
    use std::io::Write as _;
    let lut = look.and_then(FrameLook::lut);
    let io = |e| EngineError::io(format!("writing {}", dest.display()), e);
    let bytes = if settings.format == ImageFormat::Jpeg
        && lut.is_none()
        && settings.jpeg_quality == MASTER_QUALITY
    {
        // The master's own bytes, checked whole: a master a power loss cut
        // short must never reach the user's folder.
        crate::frames::whole_master(master)?
    } else {
        encode_from_master(master, settings, lut.as_ref())?
    };
    let (tmp, mut file) =
        crate::cache::create_exclusive(crate::cache::temp_names(dest)).map_err(io)?;
    let written = file.write_all(&bytes).and_then(|()| file.sync_all());
    drop(file);
    let placed = written.map_err(io).and_then(|()| {
        if settings.overwrite {
            std::fs::rename(&tmp, dest)
                .map_err(io)
                .map(|()| dest.to_path_buf())
        } else {
            place_new(&tmp, &bytes, dest, |from, to| std::fs::hard_link(from, to))
        }
    });
    let _ = std::fs::remove_file(&tmp);
    if let Ok(final_path) = &placed {
        crate::cache::sync_dir(final_path.parent().unwrap_or_else(|| Path::new(".")));
    }
    placed
}

/// Puts `tmp` (holding `bytes`) at `dest` or, if that exists by now, at the
/// first free `{stem}_n.{ext}` — never replacing anything. Uses a hard link
/// (atomic, no replace); where links are unsupported (FAT, some shares) it
/// creates the name exclusively and copies.
fn place_new(
    tmp: &Path,
    bytes: &[u8],
    dest: &Path,
    link: impl Fn(&Path, &Path) -> std::io::Result<()>,
) -> Result<PathBuf> {
    use std::io::Write as _;
    let stem = dest
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let ext = dest
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    let candidates = std::iter::once(dest.to_path_buf())
        .chain((1u32..10_000).map(|n| dest.with_file_name(format!("{stem}_{n}{ext}"))));
    let io = |e| EngineError::io(format!("writing {}", dest.display()), e);
    let mut links = true;
    for candidate in candidates {
        if links {
            match link(tmp, &candidate) {
                Ok(()) => return Ok(candidate),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(_) => links = false,
            }
        }
        match crate::cache::create_exclusive(std::iter::once(candidate.clone())) {
            Ok((path, mut file)) => {
                let written = file.write_all(bytes).and_then(|()| file.sync_all());
                if let Err(e) = written {
                    drop(file);
                    let _ = std::fs::remove_file(&path);
                    return Err(io(e));
                }
                return Ok(path);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(io(e)),
        }
    }
    Err(EngineError::InvalidArgument(format!(
        "no free file name for {}",
        dest.display()
    )))
}

fn encode_from_master(
    master: &Path,
    settings: &ImageExportSettings,
    lut: Option<&crate::color::Lut3d>,
) -> Result<Vec<u8>> {
    let mut img = crate::frames::load_master(master, None)?;
    if let Some(lut) = lut {
        lut.apply(&mut img);
    }
    match settings.format {
        ImageFormat::Png => encode::png(&img),
        ImageFormat::Jpeg => encode::jpeg(&img, settings.jpeg_quality),
    }
}

/// One image to export.
#[derive(Debug, Clone)]
pub struct ExportItem {
    /// Master JPEG.
    pub master: PathBuf,
    /// Day (file name).
    pub day: NaiveDate,
    /// Look, if normalization is on.
    pub look: Option<FrameLook>,
}

/// Export progress: one event per finished file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportProgress {
    /// Files finished (written or failed).
    pub done: usize,
    /// Files in the job.
    pub total: usize,
    /// File just finished.
    pub current_file: Option<String>,
    /// Estimated time left (ms).
    pub eta_ms: Option<u64>,
}

/// Result of [`export_images`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportReport {
    /// Written files, in item order.
    pub files: Vec<PathBuf>,
    /// How many got a `_n` suffix.
    pub renamed: usize,
    /// False when cancelled.
    pub complete: bool,
    /// Wall time.
    pub duration_ms: u64,
}

fn ms(d: std::time::Duration) -> u64 {
    u64::try_from(d.as_millis()).unwrap_or(u64::MAX)
}

/// Exports masters (+ look) as PNG/JPEG into `dir` with `YYYYMMDD` names, in
/// parallel on the current rayon pool. Names are planned up front
/// ([`NamePlanner`]); the first failing file stops the remaining ones (files
/// already written stay) and is returned as the error.
///
/// # Errors
/// Invalid settings, a missing folder, or the first per-file error.
pub fn export_images(
    items: &[ExportItem],
    dir: &Path,
    settings: &ImageExportSettings,
    sink: &dyn ProgressSink<ExportProgress>,
    cancel: &CancelToken,
) -> Result<ExportReport> {
    settings.validate()?;
    if !dir.is_dir() {
        return Err(EngineError::InvalidArgument(format!(
            "{} is not a folder",
            dir.display()
        )));
    }
    let clock = Throughput::start();
    let mut planner = NamePlanner::new(dir, settings.overwrite);
    let planned: Vec<(PathBuf, bool)> = items
        .iter()
        .map(|i| planner.next(i.day, settings.format))
        .collect();
    let renamed = planned.iter().filter(|p| p.1).count();
    let (done, failed) = (AtomicUsize::new(0), AtomicBool::new(false));
    let total = items.len();
    crate::decode::assert_no_share_held("image export loop");
    let results: Vec<Option<Result<PathBuf>>> = items
        .par_iter()
        .zip(planned.par_iter())
        .map(|(item, (dest, _))| {
            if cancel.is_cancelled() || failed.load(Ordering::Relaxed) {
                return None;
            }
            let r = write_image(&item.master, dest, settings, item.look.as_ref());
            if r.is_err() {
                failed.store(true, Ordering::Relaxed);
            }
            let d = done.fetch_add(1, Ordering::Relaxed) + 1;
            sink.report(ExportProgress {
                done: d,
                total,
                current_file: dest.file_name().map(|n| n.to_string_lossy().into_owned()),
                eta_ms: clock.eta(d, total - d).map(ms),
            });
            Some(r)
        })
        .collect();
    let mut files = Vec::new();
    for r in results.into_iter().flatten() {
        files.push(r?);
    }
    // Names that collided with a file created after planning were bumped.
    let bumped = files
        .iter()
        .zip(&planned)
        .filter(|(f, (p, renamed))| f != &p && !renamed)
        .count();
    Ok(ExportReport {
        files,
        renamed: renamed + bumped,
        complete: !cancel.is_cancelled(),
        duration_ms: ms(clock.elapsed()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::decode::tests::{jpeg_bytes, pattern};
    use crate::decode::{self, DecodeTarget};

    fn d(y: i32, m: u32, day: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, day).expect("date")
    }

    #[test]
    fn names_use_legacy_suffixes() {
        assert_eq!(
            file_name(d(2014, 8, 5), "png", |_| false),
            ("20140805.png".into(), false)
        );
        let taken: HashSet<&str> = ["20140805.png", "20140805_1.png"].into_iter().collect();
        assert_eq!(
            file_name(d(2014, 8, 5), "png", |n| taken.contains(n)),
            ("20140805_2.png".into(), true)
        );
        assert_eq!(ImageFormat::Jpeg.extension(), "jpg");
    }

    #[test]
    fn planner_checks_batch_and_disk() {
        let dir = tempfile::tempdir().expect("tmp");
        std::fs::write(dir.path().join("20140805.png"), b"old").expect("write");
        let mut p = NamePlanner::new(dir.path(), false);
        let (a, ra) = p.next(d(2014, 8, 5), ImageFormat::Png);
        assert_eq!(
            a.file_name().and_then(|n| n.to_str()),
            Some("20140805_1.png")
        );
        assert!(ra);
        let (b, _) = p.next(d(2014, 8, 5), ImageFormat::Png);
        assert_eq!(
            b.file_name().and_then(|n| n.to_str()),
            Some("20140805_2.png")
        );
        let (c, rc) = p.next(d(2014, 8, 6), ImageFormat::Jpeg);
        assert_eq!(c.file_name().and_then(|n| n.to_str()), Some("20140806.jpg"));
        assert!(!rc);
        // Overwrite ignores the disk but not the batch.
        let mut o = NamePlanner::new(dir.path(), true);
        assert_eq!(
            o.next(d(2014, 8, 5), ImageFormat::Png)
                .0
                .file_name()
                .and_then(|n| n.to_str()),
            Some("20140805.png")
        );
        assert_eq!(
            o.next(d(2014, 8, 5), ImageFormat::Png)
                .0
                .file_name()
                .and_then(|n| n.to_str()),
            Some("20140805_1.png")
        );
    }

    #[test]
    fn writes_copies_and_reencodes() {
        let dir = tempfile::tempdir().expect("tmp");
        let master = dir.path().join("m.jpg");
        let src = pattern(64, 48);
        let master_bytes = jpeg_bytes(&src);
        std::fs::write(&master, &master_bytes).expect("write");

        let copy = dir.path().join("a.jpg");
        write_image(
            &master,
            &copy,
            &ImageExportSettings {
                format: ImageFormat::Jpeg,
                jpeg_quality: 95,
                overwrite: false,
            },
            None,
        )
        .expect("copy");
        assert_eq!(std::fs::read(&copy).expect("read"), master_bytes);
        // A master a power loss cut short (or emptied) never reaches the
        // user's folder, by byte copy or re-encode.
        for torn in [&master_bytes[..master_bytes.len() / 2], &[][..]] {
            let cut = dir.path().join("cut.jpg");
            std::fs::write(&cut, torn).expect("tear");
            for (dest, quality) in [("c95.jpg", 95), ("c80.jpg", 80)] {
                let settings = ImageExportSettings {
                    format: ImageFormat::Jpeg,
                    jpeg_quality: quality,
                    overwrite: false,
                };
                let err = write_image(&cut, &dir.path().join(dest), &settings, None)
                    .expect_err("torn master");
                assert_eq!(err.kind(), crate::error::ErrorKind::NotFound);
                assert!(!dir.path().join(dest).exists());
            }
        }

        let png = dir.path().join("a.png");
        write_image(&master, &png, &ImageExportSettings::default(), None).expect("png");
        let back = decode::decode_file(&png, DecodeTarget::Full).expect("decode");
        assert_eq!(back.image.size(), src.size());

        let jpg80 = dir.path().join("b.jpg");
        write_image(
            &master,
            &jpg80,
            &ImageExportSettings {
                format: ImageFormat::Jpeg,
                jpeg_quality: 80,
                overwrite: false,
            },
            None,
        )
        .expect("jpeg");
        assert_ne!(std::fs::read(&jpg80).expect("read"), master_bytes);

        let missing = write_image(
            &dir.path().join("none.jpg"),
            &dir.path().join("x.png"),
            &ImageExportSettings::default(),
            None,
        );
        assert!(missing.is_err());
        assert!(!dir.path().join("x.png.tmp").exists());
        assert!(
            ImageExportSettings {
                jpeg_quality: 40,
                ..ImageExportSettings::default()
            }
            .validate()
            .is_err()
        );
        assert!(ImageExportSettings::default().validate().is_ok());
    }

    #[test]
    fn files_appearing_after_planning_are_never_overwritten() {
        let dir = tempfile::tempdir().expect("tmp");
        let master = dir.path().join("m.jpg");
        std::fs::write(&master, jpeg_bytes(&pattern(16, 16))).expect("write");
        let dest = dir.path().join("20140805.jpg");
        // Someone creates the planned name between planning and writing.
        std::fs::write(&dest, b"theirs").expect("race");
        let jpeg = ImageExportSettings {
            format: ImageFormat::Jpeg,
            ..ImageExportSettings::default()
        };
        let written = write_image(&master, &dest, &jpeg, None).expect("write");
        assert_eq!(written, dir.path().join("20140805_1.jpg"));
        assert_eq!(std::fs::read(&dest).expect("read"), b"theirs");
        // With overwrite the planned name is replaced.
        let over = ImageExportSettings {
            overwrite: true,
            ..jpeg
        };
        assert_eq!(
            write_image(&master, &dest, &over, None).expect("over"),
            dest
        );
        assert_ne!(std::fs::read(&dest).expect("read"), b"theirs");
        let leftovers = std::fs::read_dir(dir.path())
            .expect("ls")
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .count();
        assert_eq!(leftovers, 0, "no temp files left behind");
    }

    #[test]
    fn without_hard_links_new_files_are_created_exclusively_and_copied() {
        let dir = tempfile::tempdir().expect("tempdir");
        let dest = dir.path().join("20200101.png");
        std::fs::write(&dest, b"old").expect("write");
        let tmp = dir.path().join(".tmp");
        std::fs::write(&tmp, b"new").expect("write");
        let no_links = |_: &Path, _: &Path| {
            Err(std::io::Error::new(
                std::io::ErrorKind::Unsupported,
                "no hard links here",
            ))
        };
        let placed = place_new(&tmp, b"new", &dest, no_links).expect("placed");
        assert_eq!(placed, dir.path().join("20200101_1.png"));
        assert_eq!(std::fs::read(&placed).expect("read"), b"new");
        assert_eq!(
            std::fs::read(&dest).expect("read"),
            b"old",
            "never replaced"
        );
        #[cfg(unix)]
        {
            let victim = dir.path().join("victim.txt");
            std::fs::write(&victim, b"precious").expect("write");
            std::os::unix::fs::symlink(&victim, dir.path().join("20200101_2.png")).expect("plant");
            let placed = place_new(&tmp, b"new", &dest, no_links).expect("placed");
            assert_eq!(placed, dir.path().join("20200101_3.png"));
            assert_eq!(std::fs::read(&victim).expect("read"), b"precious");
        }
        // A folder that cannot be written reports the I/O error.
        let missing = dir.path().join("gone/20200101.png");
        assert!(place_new(&tmp, b"new", &missing, no_links).is_err());
        // Every name taken: a clear error instead of an endless search.
        let taken =
            |_: &Path, _: &Path| Err(std::io::Error::from(std::io::ErrorKind::AlreadyExists));
        let err = place_new(&tmp, b"new", &dest, taken).expect_err("no free name");
        assert!(err.to_string().contains("no free file name"), "{err}");
    }

    #[cfg(unix)]
    #[test]
    fn planted_symlinks_are_never_written_through() {
        let dir = tempfile::tempdir().expect("tmp");
        let master = dir.path().join("m.jpg");
        std::fs::write(&master, jpeg_bytes(&pattern(16, 16))).expect("write");
        let victim = dir.path().join("victim.txt");
        std::fs::write(&victim, b"precious").expect("victim");
        let dest = dir.path().join("20140805.png");
        // Both the final name and the legacy temp name point at the victim.
        std::os::unix::fs::symlink(&victim, &dest).expect("symlink");
        std::os::unix::fs::symlink(&victim, dir.path().join("20140805.png.tmp")).expect("symlink");
        let written =
            write_image(&master, &dest, &ImageExportSettings::default(), None).expect("write");
        assert_eq!(written, dir.path().join("20140805_1.png"));
        assert_eq!(std::fs::read(&victim).expect("read"), b"precious");
    }

    #[test]
    fn export_loop_names_reports_and_stops_on_errors() {
        let dir = tempfile::tempdir().expect("tmp");
        let master = dir.path().join("m.jpg");
        std::fs::write(&master, jpeg_bytes(&pattern(32, 24))).expect("write");
        let out = dir.path().join("out");
        std::fs::create_dir_all(&out).expect("mkdir");
        let item = |day: u32| ExportItem {
            master: master.clone(),
            day: d(2014, 8, day),
            look: None,
        };
        let items = vec![item(5), item(5), item(6)];
        let jpeg = ImageExportSettings {
            format: ImageFormat::Jpeg,
            ..ImageExportSettings::default()
        };
        let events = std::sync::Mutex::new(Vec::new());
        let sink = |p: ExportProgress| events.lock().expect("lock").push(p);
        let r = export_images(&items, &out, &jpeg, &sink, &CancelToken::new()).expect("export");
        let names: Vec<_> = r
            .files
            .iter()
            .filter_map(|f| f.file_name()?.to_str().map(str::to_owned))
            .collect();
        assert_eq!(names, ["20140805.jpg", "20140805_1.jpg", "20140806.jpg"]);
        assert_eq!((r.renamed, r.complete), (1, true));
        assert_eq!(
            std::fs::read(&r.files[0]).expect("copy"),
            std::fs::read(&master).expect("m")
        );
        let events = events.into_inner().expect("events");
        assert_eq!(events.len(), 3);
        assert!(
            events
                .iter()
                .all(|e| e.total == 3 && e.current_file.is_some())
        );
        // Second batch never overwrites.
        let again = export_images(&items, &out, &jpeg, &crate::NoProgress, &CancelToken::new())
            .expect("again");
        assert_eq!(again.renamed, 3);
        // The first failing file is the job's error.
        let mut broken = items.clone();
        broken[1].master = dir.path().join("missing.jpg");
        let err = export_images(
            &broken,
            &out,
            &ImageExportSettings::default(),
            &crate::NoProgress,
            &CancelToken::new(),
        )
        .expect_err("missing master");
        assert_eq!(err.kind(), crate::ErrorKind::NotFound);
        // Cancelled before starting: nothing written, incomplete.
        let cancel = CancelToken::new();
        cancel.cancel();
        let none = export_images(&items, &out, &jpeg, &crate::NoProgress, &cancel).expect("cancel");
        assert!(none.files.is_empty() && !none.complete);
        assert!(
            export_images(
                &items,
                &dir.path().join("nope"),
                &jpeg,
                &crate::NoProgress,
                &cancel
            )
            .is_err()
        );
        let bad = ImageExportSettings {
            jpeg_quality: 10,
            ..jpeg
        };
        assert!(export_images(&items, &out, &bad, &crate::NoProgress, &cancel).is_err());
    }
}
