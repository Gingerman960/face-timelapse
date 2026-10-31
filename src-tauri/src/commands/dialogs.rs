//! Native dialogs opened from Rust (D16): callback API + oneshot, so neither
//! the main thread nor a runtime worker is ever blocked. Sheets attach to the
//! main window when it exists.

use std::path::PathBuf;

use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_dialog::{DialogExt, FileDialogBuilder, FilePath};

/// Extensions offered by photo dialogs (§9.1).
pub const PHOTO_EXTENSIONS: [&str; 6] = ["jpg", "jpeg", "png", "tif", "tiff", "webp"];

fn builder<R: Runtime>(app: &AppHandle<R>, title: &str) -> FileDialogBuilder<R> {
    let b = app.dialog().file().set_title(title);
    match app.get_webview_window("main") {
        Some(w) => b.set_parent(&w),
        None => b,
    }
}

fn to_path(p: Option<FilePath>) -> Option<PathBuf> {
    p.and_then(|p| p.into_path().ok())
}

async fn run<R: Runtime>(
    b: FileDialogBuilder<R>,
    open: impl FnOnce(FileDialogBuilder<R>, Box<dyn FnOnce(Option<FilePath>) + Send>),
) -> Option<PathBuf> {
    // QA harness only: a queued answer stands in for the user's choice and
    // is granted by the caller exactly like a dialog result.
    #[cfg(feature = "e2e")]
    if let Some(answer) = facetimelapse_e2e::take_dialog_answer() {
        return answer;
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    open(
        b,
        Box::new(move |p| {
            let _ = tx.send(to_path(p));
        }),
    );
    rx.await.ok().flatten()
}

/// Open-file dialog for one photo.
pub async fn pick_photo<R: Runtime>(app: &AppHandle<R>, title: &str) -> Option<PathBuf> {
    let b = builder(app, title).add_filter("Photos", &PHOTO_EXTENSIONS);
    run(b, |b, done| b.pick_file(done)).await
}

/// Folder dialog.
pub async fn pick_folder<R: Runtime>(app: &AppHandle<R>, title: &str) -> Option<PathBuf> {
    let b = builder(app, title).set_can_create_directories(true);
    run(b, |b, done| b.pick_folder(done)).await
}

/// Save dialog for an MP4.
pub async fn save_video<R: Runtime>(app: &AppHandle<R>, file_name: &str) -> Option<PathBuf> {
    let b = builder(app, "Save the timelapse video")
        .add_filter("MP4 video", &["mp4"])
        .set_file_name(file_name);
    run(b, |b, done| b.save_file(done)).await
}
