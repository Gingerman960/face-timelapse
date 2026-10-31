//! Minimal `log` backend: `facetimelapse.log` with size rotation (5 MB × 3)
//! plus stderr in debug builds. Level from `FT_LOG` (`error`…`trace`),
//! default `info`. Captures `face-engine`'s `log` records too. Never logs
//! image bytes; paths only at `debug` (§13).

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use parking_lot::Mutex;

/// Rotate when the file exceeds this size.
pub const MAX_BYTES: u64 = 5 * 1024 * 1024;
/// Rotated files kept (`.1` … `.3`).
pub const KEEP: u32 = 3;

struct FileSink {
    path: PathBuf,
    file: Option<File>,
    written: u64,
}

impl FileSink {
    fn open(path: &Path) -> Self {
        let file = OpenOptions::new().create(true).append(true).open(path).ok();
        let written = file
            .as_ref()
            .and_then(|f| f.metadata().ok())
            .map_or(0, |m| m.len());
        Self {
            path: path.to_path_buf(),
            file,
            written,
        }
    }

    fn write_line(&mut self, line: &str) {
        if self.written + line.len() as u64 > MAX_BYTES {
            self.rotate();
        }
        if let Some(f) = self.file.as_mut()
            && f.write_all(line.as_bytes()).is_ok()
        {
            self.written += line.len() as u64;
        }
    }

    fn rotate(&mut self) {
        self.file = None;
        rotate_files(&self.path, KEEP);
        *self = Self::open(&self.path);
    }
}

/// Shifts `log` → `log.1` → … → `log.{keep}` (the oldest is dropped).
pub fn rotate_files(path: &Path, keep: u32) {
    let numbered = |n: u32| PathBuf::from(format!("{}.{n}", path.display()));
    let _ = std::fs::remove_file(numbered(keep));
    for n in (1..keep).rev() {
        let _ = std::fs::rename(numbered(n), numbered(n + 1));
    }
    let _ = std::fs::rename(path, numbered(1));
}

struct Logger {
    level: log::LevelFilter,
    stderr: bool,
    file: Option<Mutex<FileSink>>,
}

impl log::Log for Logger {
    fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
        metadata.level() <= self.level
    }

    fn log(&self, record: &log::Record<'_>) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let line = format!(
            "{} {:<5} {} {}\n",
            chrono::Local::now().format("%Y-%m-%dT%H:%M:%S%.3f"),
            record.level(),
            record.target(),
            record.args()
        );
        if self.stderr {
            eprint!("{line}");
        }
        if let Some(f) = &self.file {
            f.lock().write_line(&line);
        }
    }

    fn flush(&self) {
        if let Some(f) = &self.file
            && let Some(file) = f.lock().file.as_mut()
        {
            let _ = file.flush();
        }
    }
}

/// Parses `FT_LOG`.
#[must_use]
pub fn level_from_env(value: Option<&str>) -> log::LevelFilter {
    value
        .and_then(|v| v.parse().ok())
        .unwrap_or(log::LevelFilter::Info)
}

/// Installs the logger (no-op if one is already installed).
pub fn init(log_file: Option<&Path>) {
    let level = level_from_env(std::env::var("FT_LOG").ok().as_deref());
    let logger = Logger {
        level,
        stderr: cfg!(debug_assertions) || std::env::var_os("FT_LOG_STDERR").is_some(),
        file: log_file.map(|p| Mutex::new(FileSink::open(p))),
    };
    if log::set_boxed_logger(Box::new(logger)).is_ok() {
        log::set_max_level(level);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rotation_keeps_three() {
        let dir = tempfile::tempdir().expect("tempdir");
        let p = dir.path().join("a.log");
        for i in 0..5 {
            std::fs::write(&p, format!("gen{i}")).expect("write");
            rotate_files(&p, KEEP);
        }
        assert!(!p.exists());
        assert_eq!(
            std::fs::read_to_string(dir.path().join("a.log.1")).expect("1"),
            "gen4"
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join("a.log.3")).expect("3"),
            "gen2"
        );
        assert!(!dir.path().join("a.log.4").exists());
    }

    #[test]
    fn sink_rotates_on_size() {
        let dir = tempfile::tempdir().expect("tempdir");
        let p = dir.path().join("b.log");
        let mut s = FileSink::open(&p);
        s.written = MAX_BYTES - 1;
        s.write_line("hello\n");
        assert!(dir.path().join("b.log.1").exists());
        assert_eq!(std::fs::read_to_string(&p).expect("log"), "hello\n");
        let logger = Logger {
            level: log::LevelFilter::Info,
            stderr: false,
            file: Some(Mutex::new(s)),
        };
        log::Log::log(
            &logger,
            &log::Record::builder()
                .level(log::Level::Info)
                .args(format_args!("x"))
                .build(),
        );
        log::Log::log(
            &logger,
            &log::Record::builder()
                .level(log::Level::Trace)
                .args(format_args!("hidden"))
                .build(),
        );
        log::Log::flush(&logger);
        let text = std::fs::read_to_string(&p).expect("log");
        assert!(text.contains("INFO") && !text.contains("hidden"));
    }

    #[test]
    fn level_parsing() {
        assert_eq!(level_from_env(Some("debug")), log::LevelFilter::Debug);
        assert_eq!(level_from_env(Some("nonsense")), log::LevelFilter::Info);
        assert_eq!(level_from_env(None), log::LevelFilter::Info);
    }
}
