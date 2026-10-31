// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    lean_malloc();
    facetimelapse_lib::startup::init();
    facetimelapse_lib::run();
}

/// macOS: replaces this process (same pid and arguments) with the same binary
/// run without the allocator's large-block cache
/// (`startup::LEAN_MALLOC_VAR`), once, before anything else starts. If that
/// fails the app runs with the default allocator.
fn lean_malloc() {
    use facetimelapse_lib::startup::{LEAN_MALLOC_VAR, wants_lean_malloc_relaunch};
    let already_set = std::env::var_os(LEAN_MALLOC_VAR).is_some();
    if !wants_lean_malloc_relaunch(cfg!(target_os = "macos"), already_set) {
        return;
    }
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::process::CommandExt;
        let error = match std::env::current_exe() {
            Ok(exe) => {
                facetimelapse_lib::startup::relaunch_command(&exe, std::env::args_os().skip(1))
                    .exec()
            }
            Err(e) => e,
        };
        eprintln!("FaceTimelapse: running with the default allocator ({error})");
    }
}
