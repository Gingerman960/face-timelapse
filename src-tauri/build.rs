//! Generates the Tauri context and the ACL manifest for the app's own commands.
//!
//! Listing the commands in `AppManifest::commands` makes Tauri generate one
//! `allow-<command>` / `deny-<command>` permission per command and, crucially,
//! stops unlisted commands from being callable at all. `capabilities/main.json`
//! then grants exactly these 31 permissions to the `main` window (§13).

/// Every IPC command of ARCHITECTURE.md §7.2, in table order.
/// Keep in sync with `tauri::generate_handler!` in `src/lib.rs`
/// (the `commands_are_registered_and_permitted` test checks both).
const COMMANDS: &[&str] = &[
    "get_app_info",
    "get_session",
    "reset_session",
    "pick_reference_photo",
    "set_reference_photo",
    "set_reference_rotation",
    "set_reference_crop",
    "pick_source_folder",
    "set_source_folder",
    "clear_scan_cache",
    "start_scan",
    "cancel_job",
    "get_photos",
    "get_photo",
    "set_review_decision",
    "get_days",
    "select_day_photo",
    "move_photo_to_day",
    "add_photo_to_day",
    "set_day_excluded",
    "start_align",
    "get_frames",
    "set_frame_adjustment",
    "set_look",
    "pick_export_folder",
    "start_export_images",
    "pick_video_path",
    "start_export_video",
    "reveal_path",
    "set_video_settings",
    "open_path",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS))
            .windows_attributes(windows_attributes()),
    )
    .expect("failed to run tauri-build");
}

/// Windows (MSVC): the application manifest (Common Controls v6, which the
/// dialogs need) is embedded by the linker into every executable of this
/// package, test binaries included. tauri-build's own copy reaches only the
/// app, and a test binary without it does not start
/// (`STATUS_ENTRYPOINT_NOT_FOUND`: `TaskDialogIndirect` is not in comctl32 v5).
fn windows_attributes() -> tauri_build::WindowsAttributes {
    let target = |key: &str| std::env::var(key).unwrap_or_default();
    if target("CARGO_CFG_TARGET_OS") != "windows" || target("CARGO_CFG_TARGET_ENV") != "msvc" {
        return tauri_build::WindowsAttributes::new();
    }
    let manifest =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("windows-app-manifest.xml");
    println!("cargo:rerun-if-changed={}", manifest.display());
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    tauri_build::WindowsAttributes::new_without_app_manifest()
}
