//! FaceTimelapse Tauri shell: plugins, state, the `ftimg` protocol, the 31
//! commands, the menu bar and startup (ARCHITECTURE.md §2, §3).

// The QA harness drives the window from a local script; it must never ship.
#[cfg(all(feature = "e2e", not(debug_assertions)))]
compile_error!(
    "the `e2e` feature is a test-only GUI harness: build it with debug assertions, never for release"
);

pub mod commands;
pub mod convert;
pub mod devhooks;
pub mod engine;
pub mod error;
pub mod grants;
pub mod ids;
// Verbatim copy of ARCHITECTURE.md §7.4 (drift-tested): never reformat.
#[rustfmt::skip]
pub mod ipc;
#[cfg(test)]
mod ipc_tests;
pub mod jobs;
pub mod logging;
pub mod look;
pub mod menu;
pub mod navigation;
pub mod paths;
pub mod protocol;
pub mod prune;
pub mod quit;
pub mod session;
pub mod startup;
pub mod state;
#[cfg(test)]
pub mod testutil;
#[cfg(target_os = "macos")]
mod window_mac;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use tauri::webview::NewWindowResponse;
use tauri::{DragDropEvent, Manager, Runtime, WebviewEvent, WebviewWindowBuilder, WindowEvent};

use crate::engine::real::{RealEngine, YUNET_FILE};
use crate::paths::AppPaths;
use crate::state::{AppMeta, AppState, Core};

/// Fallback: show the window if the UI never called `show()`.
const SHOW_FALLBACK: Duration = Duration::from_secs(3);
/// Cache pruning runs this long after startup.
const PRUNE_DELAY: Duration = Duration::from_secs(10);

/// Finds the ONNX models. Release builds load them only from the bundle's
/// resources; debug builds also honour `FT_MODELS_DIR` and fall back to the
/// repository's `models/`. The engine verifies their SHA-256 either way.
fn models_dir(app: &tauri::App) -> PathBuf {
    let bundled = app.path().resource_dir().map(|d| d.join("models"));
    #[cfg(debug_assertions)]
    {
        if let Some(dir) = std::env::var_os("FT_MODELS_DIR") {
            return PathBuf::from(dir);
        }
        if let Some(dir) = bundled
            .as_ref()
            .ok()
            .filter(|d| d.join(YUNET_FILE).is_file())
        {
            return dir.clone();
        }
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("models")
    }
    #[cfg(not(debug_assertions))]
    {
        let dir = bundled.unwrap_or_else(|e| {
            log::error!("no resource directory: {e}");
            PathBuf::from("models")
        });
        if !dir.join(YUNET_FILE).is_file() {
            log::error!("bundled face models missing in {}", dir.display());
        }
        dir
    }
}

/// Grants the paths of an OS drop onto the window. Tauri forwards the drop
/// to the webview first and then runs this handler in the same main-thread
/// callback; the webview's commands are dispatched on the main thread too,
/// so none can be handled before the grant exists.
fn grant_drop<R: Runtime>(app: &tauri::AppHandle<R>, event: &DragDropEvent) {
    if let DragDropEvent::Drop { paths, .. } = event
        && let Some(core) = app.try_state::<AppState>()
    {
        for p in paths {
            core.grants.grant_as_spelled(grants::Access::Read, p);
        }
    }
}

fn resolve_paths(app: &tauri::App) -> Result<AppPaths, Box<dyn std::error::Error>> {
    let p = app.path();
    Ok(AppPaths::from_platform(
        p.app_data_dir()?,
        &p.app_cache_dir()?,
        p.app_log_dir()?,
        models_dir(app),
    ))
}

fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let paths = resolve_paths(app)?;
    paths.prepare()?;
    logging::init(Some(&paths.log_file()));
    startup::mark("paths ready");
    log::info!("FaceTimelapse {} starting", app.package_info().version);
    let engine = Arc::new(RealEngine::new(paths.models_dir.clone()));
    let core = Core::new(
        paths,
        engine,
        AppMeta::current(&app.package_info().version.to_string()),
    );
    startup::mark("session loaded");
    core.set_session_notifier(Box::new({
        let handle = app.handle().clone();
        move || commands::app::notify_session_changed(&handle)
    }));
    app.manage(Arc::clone(&core));

    // State is managed before the webview exists, so neither IPC nor `ftimg`
    // can observe a missing state.
    #[cfg_attr(not(target_os = "macos"), allow(unused_mut))]
    let mut config = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == "main")
        .cloned()
        .ok_or("main window config missing")?;
    // macOS: AppKit centres a window created without a position itself, on
    // whole points. Tauri's centring halves the work area in pixels, which
    // gives a half-point origin on some screens, and AppKit then grows the
    // window to 1440 × 901 (QA). The window-state plugin still restores a
    // saved position either way.
    #[cfg(target_os = "macos")]
    {
        config.center = false;
    }
    let window = window_chrome(WebviewWindowBuilder::from_config(app.handle(), &config)?)
        .on_navigation(|url| {
            let allowed = navigation::is_app_url(url);
            if !allowed {
                log::warn!("blocked navigation to a {} URL", url.scheme());
            }
            allowed
        })
        .on_new_window(|url, _| {
            log::warn!("blocked a new window for a {} URL", url.scheme());
            NewWindowResponse::Deny
        })
        .build()?;
    #[cfg(target_os = "macos")]
    no_open_animation();
    #[cfg(not(target_os = "macos"))]
    theme_background(&window);
    startup::mark("window created");
    #[cfg(feature = "e2e")]
    facetimelapse_e2e::start(window.clone());

    spawn("ft-restore", {
        let core = Arc::clone(&core);
        move || {
            core.restore();
            startup::mark("session restored");
        }
    });
    spawn("ft-models", {
        let core = Arc::clone(&core);
        let handle = app.handle().clone();
        move || {
            let mut changed = false;
            if commands::app::load_models_and_notify(&core, &handle) {
                startup::mark("models ready");
                core.wait_restored_fully();
                changed |= commands::reference::refresh_when_idle(&core);
            }
            changed |= devhooks::autoload(&core);
            if changed {
                commands::app::notify_session_changed(&handle);
            }
        }
    });
    spawn("ft-show-fallback", move || {
        // With FT_TRACE_STARTUP=1, poll so the moment the UI shows the window is logged.
        let deadline = std::time::Instant::now() + SHOW_FALLBACK;
        while startup::traced() && std::time::Instant::now() < deadline {
            if window.is_visible().unwrap_or(false) {
                startup::mark("window shown by UI");
                return;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        std::thread::sleep(deadline.saturating_duration_since(std::time::Instant::now()));
        if !window.is_visible().unwrap_or(true) {
            log::warn!("UI did not call show() within {SHOW_FALLBACK:?}; showing the window");
            let _ = window.show();
        }
    });
    spawn("ft-prune", move || {
        std::thread::sleep(PRUNE_DELAY);
        prune::run(&core);
        // `previews/` grows while Review is browsed: keep its bound off the
        // render path, without keeping the core alive.
        let core = Arc::downgrade(&core);
        loop {
            std::thread::sleep(protocol::preview::PRUNE_EVERY);
            let Some(core) = core.upgrade() else { return };
            protocol::preview::prune(&core);
        }
    });
    Ok(())
}

/// macOS: transparent window + `sidebar` vibrancy (DESIGN.md "Tauri window
/// configuration"); the UI paints every opaque surface itself and leaves the
/// sidebar transparent where the material should show.
#[cfg(target_os = "macos")]
fn window_chrome<'a, R: Runtime, M: Manager<R>>(
    b: WebviewWindowBuilder<'a, R, M>,
) -> WebviewWindowBuilder<'a, R, M> {
    use tauri::window::{Effect, EffectState, EffectsBuilder};
    b.transparent(true).effects(
        EffectsBuilder::new()
            .effect(Effect::Sidebar)
            .state(EffectState::FollowsWindowActiveState)
            .build(),
    )
}

/// The real window behind [`window_mac::Animated`].
#[cfg(target_os = "macos")]
impl window_mac::Animated for objc2_app_kit::NSWindow {
    fn set_animation_behavior(&self, behavior: objc2_app_kit::NSWindowAnimationBehavior) {
        self.setAnimationBehavior(behavior);
    }
}

/// macOS: the main window opens without AppKit's zoom animation (see
/// `window_mac.rs`). Runs in `setup`, on the main thread, after the window is
/// built and before the UI can show it, while it is the app's only window.
#[cfg(target_os = "macos")]
fn no_open_animation() {
    let Some(mtm) = objc2::MainThreadMarker::new() else {
        log::warn!("window setup ran off the main thread; keeping the open animation");
        return;
    };
    let windows: Vec<_> = objc2_app_kit::NSApplication::sharedApplication(mtm)
        .windows()
        .iter()
        .collect();
    window_mac::without_open_animation(windows.iter().map(|w| &**w));
}

/// Other platforms keep an opaque window (no vibrancy material to show through).
#[cfg(not(target_os = "macos"))]
fn window_chrome<'a, R: Runtime, M: Manager<R>>(
    b: WebviewWindowBuilder<'a, R, M>,
) -> WebviewWindowBuilder<'a, R, M> {
    b
}

/// Z0 darkroom / Z10 light table (DESIGN.md) behind the webview, by system theme.
#[cfg(not(target_os = "macos"))]
fn theme_background<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    let color = match window.theme() {
        Ok(tauri::Theme::Light) => tauri::window::Color(0xf9, 0xf8, 0xf6, 0xff),
        _ => tauri::window::Color(0x0f, 0x0f, 0x0e, 0xff),
    };
    let _ = window.set_background_color(Some(color));
}

fn spawn(name: &str, f: impl FnOnce() + Send + 'static) {
    if let Err(e) = std::thread::Builder::new().name(name.to_owned()).spawn(f) {
        log::error!("cannot start {name}: {e}");
    }
}

/// The invoke handler with all 31 commands of ARCHITECTURE.md §7.2
/// (also used by the mock-runtime IPC tests).
pub fn invoke_handler<R: Runtime>() -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static
{
    tauri::generate_handler![
        commands::app::get_app_info,
        commands::app::get_session,
        commands::app::reset_session,
        commands::reference::pick_reference_photo,
        commands::reference::set_reference_photo,
        commands::reference::set_reference_rotation,
        commands::reference::set_reference_crop,
        commands::folder::pick_source_folder,
        commands::folder::set_source_folder,
        commands::folder::clear_scan_cache,
        commands::review::start_scan,
        commands::review::cancel_job,
        commands::review::get_photos,
        commands::review::get_photo,
        commands::review::set_review_decision,
        commands::days::get_days,
        commands::days::select_day_photo,
        commands::days::move_photo_to_day,
        commands::days::add_photo_to_day,
        commands::days::set_day_excluded,
        commands::frames::start_align,
        commands::frames::get_frames,
        commands::frames::set_frame_adjustment,
        commands::frames::set_look,
        commands::export::pick_export_folder,
        commands::export::start_export_images,
        commands::export::pick_video_path,
        commands::export::start_export_video,
        commands::export::reveal_path,
        commands::export::set_video_settings,
        commands::export::open_path,
    ]
}

/// The generated context (config, ACL, icons). Generic so the mock-runtime
/// tests run against the real capabilities; expanded exactly once per crate.
#[must_use]
pub fn context<R: Runtime>() -> tauri::Context<R> {
    tauri::generate_context!()
}

/// Builds and runs the app.
///
/// # Panics
/// If the Tauri runtime cannot start (no display, broken bundle).
pub fn run() {
    startup::mark("run");
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // No JS permissions are granted for the opener; also stop it from
        // opening clicked links itself (reveal and open run from Rust only).
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        );
    // Window geometry persistence, except in relocated test/smoke runs. The
    // window starts hidden and is shown by the UI, so VISIBLE is never restored.
    if std::env::var_os(paths::DATA_DIR_ENV).is_none() {
        use tauri_plugin_window_state::StateFlags;
        builder = builder.plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE)
                .build(),
        );
    }
    let app = builder
        .register_asynchronous_uri_scheme_protocol(ipc::IMAGE_SCHEME, |ctx, request, responder| {
            let Some(core) = ctx.app_handle().try_state::<AppState>() else {
                responder.respond(protocol::respond(503, Vec::new(), false));
                return;
            };
            let uri = request.uri();
            core.protocol.dispatch(
                protocol::Request {
                    method: request.method().as_str().to_owned(),
                    path: uri.path().to_owned(),
                    query: uri.query().map(str::to_owned),
                    origin: request
                        .headers()
                        .get(tauri::http::header::ORIGIN)
                        .and_then(|v| v.to_str().ok())
                        .map(str::to_owned),
                },
                Box::new(move |response| responder.respond(response)),
            );
        })
        .invoke_handler(invoke_handler())
        .menu(menu::build)
        .on_menu_event(|app, event| menu::on_menu_event(app, &event))
        .setup(setup)
        .on_window_event(|window, event| match event {
            WindowEvent::Focused(true) => startup::mark_once("window focused (shown)"),
            WindowEvent::DragDrop(drop) => grant_drop(window.app_handle(), drop),
            _ => {}
        })
        .on_webview_event(|webview, event| {
            if let WebviewEvent::DragDrop(drop) = event {
                grant_drop(webview.app_handle(), drop);
            }
        })
        .build(context())
        .expect("error while building FaceTimelapse");
    // Quit while a job runs: cancel it and give it a moment to remove its
    // temporary files (a half-written video can be gigabytes); see `quit`.
    app.run(|handle, event| {
        let core = handle.try_state::<AppState>();
        quit::on_run_event(core.as_deref().map(Arc::as_ref), &event);
    });
}
