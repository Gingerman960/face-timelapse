// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "macos")]
    lean_malloc();
    facetimelapse_lib::startup::init();
    facetimelapse_lib::run();
}

/// macOS: replaces this process (same pid and arguments) with the same binary
/// run without the allocator's large-block cache
/// (`startup::LEAN_MALLOC_VAR`), once, before anything else starts. If that
/// fails the app runs with the default allocator.
#[cfg(target_os = "macos")]
fn lean_malloc() {
    use std::os::unix::process::CommandExt;

    use facetimelapse_lib::startup::{LEAN_MALLOC_VAR, wants_lean_malloc_relaunch};
    let already_set = std::env::var_os(LEAN_MALLOC_VAR).is_some();
    if !wants_lean_malloc_relaunch(true, already_set) {
        return;
    }
    let error = match std::env::current_exe() {
        Ok(exe) => {
            facetimelapse_lib::startup::relaunch_command(&exe, std::env::args_os().skip(1)).exec()
        }
        Err(e) => e,
    };
    eprintln!("FaceTimelapse: running with the default allocator ({error})");
}
