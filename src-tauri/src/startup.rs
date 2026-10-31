//! Process start: the macOS allocator setting (applied by `main`) and startup
//! milestones (ARCHITECTURE.md §11): `FT_TRACE_STARTUP=1` logs
//! `startup.ms <milestone>=<ms since process start>` at info level (debug
//! otherwise). The clock starts at the first call of [`init`].

use std::collections::HashSet;
use std::sync::OnceLock;
use std::time::Instant;

use parking_lot::Mutex;

static START: OnceLock<Instant> = OnceLock::new();
static SEEN: OnceLock<Mutex<HashSet<&'static str>>> = OnceLock::new();

/// The macOS malloc setting the app runs with: `MallocLargeCache=0`.
///
/// macOS's allocator keeps freed large blocks (decoded photos, network
/// activations, warp buffers) cached and dirty for reuse — on a 64 GB Mac up
/// to 64 of them: one parallel burst of 15 face detections left 846 MB of
/// such free blocks resident against 82 MB live, and a scan + align kept the
/// app near its highest peak for the rest of the session. Without the cache
/// freed blocks go back to the system at once (same burst: 143 MB
/// resident). libmalloc reads it once at process start, so `main`
/// relaunches.
pub const LEAN_MALLOC_VAR: &str = "MallocLargeCache";
/// Value of [`LEAN_MALLOC_VAR`]: the large cache off.
pub const LEAN_MALLOC_VALUE: &str = "0";

/// Whether `main` should relaunch to apply [`LEAN_MALLOC_VAR`]: on macOS,
/// unless it is already set (also by the user, to any value).
#[must_use]
pub fn wants_lean_malloc_relaunch(macos: bool, already_set: bool) -> bool {
    macos && !already_set
}

/// The command `main` replaces the process with on macOS: `exe` with the
/// same arguments and [`LEAN_MALLOC_VAR`] set.
#[must_use]
pub fn relaunch_command(
    exe: &std::path::Path,
    args: impl IntoIterator<Item = std::ffi::OsString>,
) -> std::process::Command {
    let mut command = std::process::Command::new(exe);
    command.args(args).env(LEAN_MALLOC_VAR, LEAN_MALLOC_VALUE);
    command
}

/// Starts the clock (call first thing in `main`).
pub fn init() {
    let _ = START.get_or_init(Instant::now);
}

/// Milliseconds since [`init`].
#[must_use]
pub fn elapsed_ms() -> u128 {
    START.get_or_init(Instant::now).elapsed().as_millis()
}

/// True when `FT_TRACE_STARTUP=1`.
#[must_use]
pub fn traced() -> bool {
    std::env::var_os("FT_TRACE_STARTUP").is_some_and(|v| v == "1")
}

/// Logs a milestone.
pub fn mark(milestone: &str) {
    let ms = elapsed_ms();
    if traced() {
        log::info!("startup.ms {milestone}={ms}");
    } else {
        log::debug!("startup.ms {milestone}={ms}");
    }
}

/// Logs a milestone only the first time it is reached.
pub fn mark_once(milestone: &'static str) {
    let first = SEEN
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .insert(milestone);
    if first {
        mark(milestone);
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn relaunches_once_and_only_on_macos() {
        assert!(super::wants_lean_malloc_relaunch(true, false));
        assert!(!super::wants_lean_malloc_relaunch(true, true), "once");
        assert!(!super::wants_lean_malloc_relaunch(false, false));
    }

    #[test]
    fn the_relaunch_keeps_the_arguments_and_turns_the_large_cache_off() {
        let args = ["--flag".into(), "a b".into()];
        let c = super::relaunch_command(std::path::Path::new("/Applications/X.app/x"), args);
        assert_eq!(c.get_program(), "/Applications/X.app/x");
        assert_eq!(c.get_args().collect::<Vec<_>>(), ["--flag", "a b"]);
        let envs: Vec<_> = c.get_envs().collect();
        assert_eq!(
            envs,
            [(
                std::ffi::OsStr::new(super::LEAN_MALLOC_VAR),
                Some(std::ffi::OsStr::new("0"))
            )]
        );
    }

    #[test]
    fn marks_do_not_panic_and_clock_runs() {
        super::init();
        super::mark("test");
        super::mark_once("test-once");
        super::mark_once("test-once");
        assert!(super::elapsed_ms() < 10 * 60 * 1000);
    }
}
