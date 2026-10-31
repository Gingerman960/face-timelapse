//! Capture date resolution (ARCHITECTURE §9.2, D12).
//!
//! Order: EXIF `DateTimeOriginal` → EXIF `DateTimeDigitized` → **file name**
//! → EXIF `DateTime` → file creation time (birthtime, else mtime). All values
//! are naive local wall-clock times; nothing is ever converted to UTC and
//! "now" is never used.

use chrono::{Datelike, Local, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Timelike};
use serde::{Deserialize, Serialize};

/// Where a photo's capture time came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DateSource {
    /// One of the EXIF date tags.
    Exif,
    /// Parsed from the file name.
    Filename,
    /// File system creation/modification time.
    FileTime,
    /// Assigned by the user (never produced by the engine itself).
    Manual,
}

/// The three EXIF date tags the resolver looks at.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ExifDates {
    /// `DateTimeOriginal` (0x9003).
    pub original: Option<NaiveDateTime>,
    /// `DateTimeDigitized` (0x9004).
    pub digitized: Option<NaiveDateTime>,
    /// `DateTime` (0x0132), usually the last modification.
    pub modified: Option<NaiveDateTime>,
}

/// Capture time plus its provenance.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureTime {
    /// Naive local date-time.
    pub taken_at: NaiveDateTime,
    /// Provenance.
    pub source: DateSource,
}

impl CaptureTime {
    /// Calendar day (`dayKey`).
    #[must_use]
    pub fn day(&self) -> NaiveDate {
        self.taken_at.date()
    }
}

const MIN_YEAR: i32 = 1990;
const MAX_YEAR: i32 = 2100;

/// Applies the precedence rules. `file_time` is the file-system fallback.
#[must_use]
pub fn resolve(exif: &ExifDates, file_name: &str, file_time: NaiveDateTime) -> CaptureTime {
    let exif_first = exif.original.or(exif.digitized);
    if let Some(taken_at) = exif_first {
        return CaptureTime {
            taken_at,
            source: DateSource::Exif,
        };
    }
    if let Some(taken_at) = parse_filename(file_name) {
        return CaptureTime {
            taken_at,
            source: DateSource::Filename,
        };
    }
    if let Some(taken_at) = exif.modified {
        return CaptureTime {
            taken_at,
            source: DateSource::Exif,
        };
    }
    CaptureTime {
        taken_at: file_time,
        source: DateSource::FileTime,
    }
}

/// Parses an EXIF date value such as `2014:08:15 14:23:26` (also accepts `-`
/// date separators, a `T` separator, sub-seconds and trailing NULs/spaces).
/// Zeroed or blank placeholders return `None`.
#[must_use]
pub fn parse_exif_datetime(raw: &str) -> Option<NaiveDateTime> {
    let s = raw.trim_matches(|c: char| c == '\0' || c.is_whitespace());
    let b = s.as_bytes();
    if b.len() < 19 {
        return None;
    }
    let date_sep_ok = |c: u8| c == b':' || c == b'-';
    if !(date_sep_ok(b[4]) && date_sep_ok(b[7]) && (b[10] == b' ' || b[10] == b'T'))
        || b[13] != b':'
        || b[16] != b':'
    {
        return None;
    }
    let year = digits(&b[0..4])?;
    let month = digits(&b[5..7])?;
    let day = digits(&b[8..10])?;
    let hour = digits(&b[11..13])?;
    let minute = digits(&b[14..16])?;
    let second = digits(&b[17..19])?;
    #[allow(clippy::cast_possible_wrap)]
    make_datetime(year as i32, month, day, Some((hour, minute, second)))
}

/// Extracts a capture date-time from a file name (the extension is ignored).
///
/// Patterns, tried in order on the stem (ARCHITECTURE §9.2):
/// 1. `YYYYMMDD` with an optional `HHMMSS` after 1–2 of `_`, `-`, space —
///    `IMG_20140815_142326`, `20120901_111216`, `IMG_20220827`,
///    `IMG_20140815_ 142326`, `20130323_170145_LLS`, `IMG-20140815-WA0001`.
/// 2. `YYYY-MM-DD[ _T]HH[.:-]MM[.:-]SS` — `2014-08-15 14.23.26`.
///
/// The date must not be glued to other digits, must be a real calendar date
/// with a year in 1990–2100, and a time (when present) must be valid; an
/// invalid time degrades to the date at midnight.
#[must_use]
pub fn parse_filename(file_name: &str) -> Option<NaiveDateTime> {
    parse_filename_timed(file_name).map(|(t, _)| t)
}

/// [`parse_filename`] plus whether the name gave a (valid) time of day —
/// `false` when the date stands alone or its time was invalid (midnight).
#[must_use]
pub fn parse_filename_timed(file_name: &str) -> Option<(NaiveDateTime, bool)> {
    let stem = file_name
        .rsplit_once('.')
        .map_or(file_name, |(stem, _)| stem);
    let b = stem.as_bytes();
    (0..b.len())
        .find_map(|i| compact_at(b, i))
        .or_else(|| (0..b.len()).find_map(|i| dashed_at(b, i).map(|t| (t, true))))
}

/// Whether `taken_at`, a capture time of `source` for a photo named
/// `file_name`, has a real time of day: an EXIF time does, a file-name date
/// only when the name contains a valid time; file-system times and manual
/// dates do not. A time of exactly 00:00:00 never counts: cameras without a
/// clock time write it (65 % of the real library, e.g. a Canon EOS 70D), and
/// a real capture at that very second is rarer than the placeholder.
#[must_use]
pub fn time_known(source: DateSource, taken_at: NaiveDateTime, file_name: &str) -> bool {
    let timed = match source {
        DateSource::Exif => true,
        DateSource::Filename => parse_filename_timed(file_name).is_some_and(|(_, timed)| timed),
        DateSource::FileTime | DateSource::Manual => false,
    };
    timed && taken_at.time() != NaiveTime::MIN
}

/// Pattern 1 at byte offset `i` (and whether it had a valid time).
fn compact_at(b: &[u8], i: usize) -> Option<(NaiveDateTime, bool)> {
    if i > 0 && b[i - 1].is_ascii_digit() {
        return None;
    }
    let date = b.get(i..i + 8)?;
    if !(date.starts_with(b"19") || date.starts_with(b"20")) {
        return None;
    }
    let (year, month, day) = (
        digits(&date[0..4])?,
        digits(&date[4..6])?,
        digits(&date[6..8])?,
    );
    let after = i + 8;
    if b.get(after).is_some_and(u8::is_ascii_digit) {
        return None;
    }
    #[allow(clippy::cast_possible_wrap)]
    let year = year as i32;
    compact_time(b, after)
        .and_then(|time| make_datetime(year, month, day, Some(time)))
        .map(|t| (t, true))
        .or_else(|| make_datetime(year, month, day, None).map(|t| (t, false)))
}

/// Optional `[_\- ]{1,2}HHMMSS(\D|$)` starting at `start`.
fn compact_time(b: &[u8], start: usize) -> Option<(u32, u32, u32)> {
    let is_sep = |c: &u8| matches!(c, b'_' | b'-' | b' ');
    let mut j = start;
    while j < b.len() && j - start < 2 && is_sep(&b[j]) {
        j += 1;
    }
    if j == start {
        return None;
    }
    let t = b.get(j..j + 6)?;
    if b.get(j + 6).is_some_and(u8::is_ascii_digit) {
        return None;
    }
    Some((digits(&t[0..2])?, digits(&t[2..4])?, digits(&t[4..6])?))
}

/// Pattern 2 at byte offset `i`.
fn dashed_at(b: &[u8], i: usize) -> Option<NaiveDateTime> {
    if i > 0 && b[i - 1].is_ascii_digit() {
        return None;
    }
    let s = b.get(i..i + 19)?;
    if !(s.starts_with(b"19") || s.starts_with(b"20")) {
        return None;
    }
    let time_sep = |c: u8| matches!(c, b'.' | b':' | b'-');
    if s[4] != b'-' || s[7] != b'-' || !matches!(s[10], b' ' | b'_' | b'T') {
        return None;
    }
    if !time_sep(s[13]) || !time_sep(s[16]) {
        return None;
    }
    let time = (
        digits(&s[11..13])?,
        digits(&s[14..16])?,
        digits(&s[17..19])?,
    );
    #[allow(clippy::cast_possible_wrap)]
    make_datetime(
        digits(&s[0..4])? as i32,
        digits(&s[5..7])?,
        digits(&s[8..10])?,
        Some(time),
    )
}

fn digits(b: &[u8]) -> Option<u32> {
    if b.is_empty() || !b.iter().all(u8::is_ascii_digit) {
        return None;
    }
    Some(b.iter().fold(0u32, |acc, d| acc * 10 + u32::from(d - b'0')))
}

fn make_datetime(
    year: i32,
    month: u32,
    day: u32,
    time: Option<(u32, u32, u32)>,
) -> Option<NaiveDateTime> {
    if !(MIN_YEAR..=MAX_YEAR).contains(&year) {
        return None;
    }
    let date = NaiveDate::from_ymd_opt(year, month, day)?;
    let time = match time {
        Some((h, m, s)) => NaiveTime::from_hms_opt(h, m, s)?,
        None => NaiveTime::MIN,
    };
    Some(date.and_time(time))
}

/// File-system fallback: birthtime where available, else mtime, as local
/// wall-clock time truncated to whole seconds.
#[must_use]
pub fn file_time(meta: &std::fs::Metadata) -> Option<NaiveDateTime> {
    let t = meta.created().or_else(|_| meta.modified()).ok()?;
    let dt: chrono::DateTime<Local> = t.into();
    dt.naive_local().with_nanosecond(0)
}

/// Converts nanoseconds since the epoch to a local naive date-time (whole seconds).
#[must_use]
pub fn local_from_unix_ns(ns: i64) -> NaiveDateTime {
    let secs = ns.div_euclid(1_000_000_000);
    Local
        .timestamp_opt(secs, 0)
        .earliest()
        .map_or_else(epoch, |dt| dt.naive_local())
}

fn epoch() -> NaiveDateTime {
    NaiveDate::from_ymd_opt(1970, 1, 1)
        .unwrap_or_default()
        .and_time(NaiveTime::MIN)
}

/// `YYYY-MM-DD` key of a date.
#[must_use]
pub fn day_key(date: NaiveDate) -> String {
    format!("{:04}-{:02}-{:02}", date.year(), date.month(), date.day())
}

/// Parses a `YYYY-MM-DD` day key.
#[must_use]
pub fn parse_day_key(key: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(key, "%Y-%m-%d").ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dt(y: i32, mo: u32, d: u32, h: u32, mi: u32, s: u32) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(y, mo, d)
            .and_then(|d| d.and_hms_opt(h, mi, s))
            .expect("valid test date")
    }

    #[test]
    fn every_filename_shape_in_the_real_set() {
        let cases = [
            ("IMG_20140815.jpg", dt(2014, 8, 15, 0, 0, 0)),
            ("IMG_20220829.JPG", dt(2022, 8, 29, 0, 0, 0)),
            ("IMG_20140815_142326.jpg", dt(2014, 8, 15, 14, 23, 26)),
            ("20120901_111216.jpg", dt(2012, 9, 1, 11, 12, 16)),
            ("20120901_111216.JPG", dt(2012, 9, 1, 11, 12, 16)),
            ("20130323_170145_LLS.jpg", dt(2013, 3, 23, 17, 1, 45)),
            ("IMG_20140815_ 142326.jpg", dt(2014, 8, 15, 14, 23, 26)),
            ("20120915_210032(1).jpg", dt(2012, 9, 15, 21, 0, 32)),
            ("20120915_210032_1.jpg", dt(2012, 9, 15, 21, 0, 32)),
            ("20130323_170145_LLS 1.jpg", dt(2013, 3, 23, 17, 1, 45)),
            ("20130323_170145_LLS (2).jpg", dt(2013, 3, 23, 17, 1, 45)),
            ("20130323_170145_LLS_1.jpg", dt(2013, 3, 23, 17, 1, 45)),
            ("IMG-20140815-WA0001.jpg", dt(2014, 8, 15, 0, 0, 0)),
            ("2014-08-15 14.23.26.jpg", dt(2014, 8, 15, 14, 23, 26)),
            (
                "Photo 2019-12-31_23:59:58.png",
                dt(2019, 12, 31, 23, 59, 58),
            ),
            ("PXL_20210704-101112.jpg", dt(2021, 7, 4, 10, 11, 12)),
            ("19991231.jpg", dt(1999, 12, 31, 0, 0, 0)),
        ];
        for (name, expected) in cases {
            assert_eq!(parse_filename(name), Some(expected), "{name}");
        }
    }

    #[test]
    fn a_time_of_day_is_known_from_exif_or_a_timed_file_name_only() {
        for (name, timed) in [
            ("IMG_20140815_142326.jpg", true),
            ("20120901_111216.jpg", true),
            ("2014-08-15 14.23.26.png", true),
            ("IMG_20220827.jpg", false),
            ("IMG-20140815-WA0001.jpg", false),
            ("IMG_20140815_256100.jpg", false),
        ] {
            let taken = parse_filename(name).expect("dated");
            assert_eq!(
                time_known(DateSource::Filename, taken, name),
                timed,
                "{name}"
            );
            assert_eq!(parse_filename_timed(name).map(|(_, t)| t), Some(timed));
        }
        let at = |h, m, s| dt(2016, 6, 15, h, m, s);
        assert!(time_known(DateSource::Exif, at(14, 23, 26), "photo.jpg"));
        assert!(time_known(DateSource::Exif, at(0, 0, 1), "photo.jpg"));
        assert!(!time_known(
            DateSource::Filename,
            at(14, 23, 26),
            "photo.jpg"
        ));
        assert!(!time_known(
            DateSource::FileTime,
            at(14, 23, 26),
            "IMG_20140815_142326.jpg"
        ));
        assert!(!time_known(
            DateSource::Manual,
            at(12, 0, 0),
            "IMG_20140815_142326.jpg"
        ));
    }

    #[test]
    fn a_time_of_exactly_midnight_is_a_date_without_a_time() {
        // Cameras without a clock time (Canon EOS 70D here) write 00:00:00.
        let midnight = dt(2016, 6, 15, 0, 0, 0);
        assert!(!time_known(DateSource::Exif, midnight, "IMG_20160615.JPG"));
        // So does a file name whose time is 000000.
        let name = "20160615_000000.jpg";
        let taken = parse_filename(name).expect("dated");
        assert_eq!(taken, midnight);
        assert!(!time_known(DateSource::Filename, taken, name));
        // A second later is a real time of day.
        assert!(time_known(
            DateSource::Exif,
            dt(2016, 6, 15, 0, 0, 1),
            "x.jpg"
        ));
    }

    #[test]
    fn rejects_invalid_or_ambiguous_names() {
        for name in [
            "IMG_1234.jpg",
            "DSC_0001.JPG",
            "120140815.jpg",    // glued to a preceding digit
            "201408151.jpg",    // glued to a following digit
            "IMG_20141332.jpg", // month 13
            "IMG_20140230.jpg", // Feb 30
            "IMG_18991231.jpg", // year out of range (pattern needs 19xx/20xx anyway)
            "IMG_21010101.jpg",
            "2014-08-15.jpg", // dashed form requires a time
            "2014-08-15 25.00.00.jpg",
            "",
            "noextension",
        ] {
            assert_eq!(parse_filename(name), None, "{name}");
        }
    }

    #[test]
    fn invalid_time_degrades_to_midnight_and_later_dates_are_found() {
        assert_eq!(
            parse_filename("20140815_996060.jpg"),
            Some(dt(2014, 8, 15, 0, 0, 0))
        );
        assert_eq!(
            parse_filename("x_99999999_20200102.jpg"),
            Some(dt(2020, 1, 2, 0, 0, 0))
        );
        assert_eq!(
            parse_filename("a.b.20200102.jpg"),
            Some(dt(2020, 1, 2, 0, 0, 0))
        );
    }

    #[test]
    fn exif_values() {
        assert_eq!(
            parse_exif_datetime("2014:08:15 14:23:26"),
            Some(dt(2014, 8, 15, 14, 23, 26))
        );
        assert_eq!(
            parse_exif_datetime("2014-08-15T14:23:26.123\0"),
            Some(dt(2014, 8, 15, 14, 23, 26))
        );
        for bad in [
            "0000:00:00 00:00:00",
            "    :  :     :  :  ",
            "2014:08:15",
            "2014:13:15 14:23:26",
            "2014:08:15 24:00:00",
            "2014/08/15 14:23:26",
            "2014:08:15 14-23-26",
            "abcd:08:15 14:23:26",
        ] {
            assert_eq!(parse_exif_datetime(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn precedence_follows_the_architecture() {
        let file = dt(2001, 1, 1, 0, 0, 0);
        let all = ExifDates {
            original: Some(dt(2014, 1, 1, 1, 0, 0)),
            digitized: Some(dt(2014, 1, 2, 1, 0, 0)),
            modified: Some(dt(2014, 1, 3, 1, 0, 0)),
        };
        let name = "IMG_20200505_101010.jpg";
        let r = resolve(&all, name, file);
        assert_eq!(
            (r.taken_at, r.source),
            (dt(2014, 1, 1, 1, 0, 0), DateSource::Exif)
        );

        let no_original = ExifDates {
            original: None,
            ..all
        };
        assert_eq!(
            resolve(&no_original, name, file).taken_at,
            dt(2014, 1, 2, 1, 0, 0)
        );

        let only_modified = ExifDates {
            modified: all.modified,
            ..ExifDates::default()
        };
        let r = resolve(&only_modified, name, file);
        assert_eq!(
            (r.taken_at, r.source),
            (dt(2020, 5, 5, 10, 10, 10), DateSource::Filename)
        );
        let r = resolve(&only_modified, "IMG_1.jpg", file);
        assert_eq!(
            (r.taken_at, r.source),
            (dt(2014, 1, 3, 1, 0, 0), DateSource::Exif)
        );

        let r = resolve(&ExifDates::default(), "IMG_1.jpg", file);
        assert_eq!((r.taken_at, r.source), (file, DateSource::FileTime));
        assert_eq!(r.day(), NaiveDate::from_ymd_opt(2001, 1, 1).expect("date"));
    }

    #[test]
    fn day_keys_and_file_times() {
        let d = NaiveDate::from_ymd_opt(2014, 8, 5).expect("date");
        assert_eq!(day_key(d), "2014-08-05");
        assert_eq!(parse_day_key("2014-08-05"), Some(d));
        assert_eq!(parse_day_key("2014-8-5x"), None);

        let dir = tempfile::tempdir().expect("tempdir");
        let f = dir.path().join("a.jpg");
        std::fs::write(&f, b"x").expect("write");
        let meta = std::fs::metadata(&f).expect("meta");
        let t = file_time(&meta).expect("file time");
        assert_eq!(t.nanosecond(), 0);
        let local = local_from_unix_ns(crate::walk::mtime_ns(&meta));
        assert!((local - t).num_seconds().abs() <= 2);
        assert_eq!(local_from_unix_ns(999_999_999), local_from_unix_ns(0));
    }
}
