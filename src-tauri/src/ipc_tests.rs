//! IPC tests through Tauri's mock runtime with the real context (the
//! capability file and the AppManifest ACL). They check that every one of the
//! 31 commands is registered and permitted for the `main` window, accepts its
//! camelCase arguments and rejects with an `IpcError {kind, message}`, and
//! that the command lists stay in sync.

use std::sync::Arc;

use serde_json::{Value, json};
use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
use tauri::test::{INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder};
use tauri::webview::InvokeRequest;
use tauri::{App, WebviewWindow, WebviewWindowBuilder};

use crate::ipc::JobKind;
use crate::testutil::TestCore;

fn app(t: &TestCore) -> (App<MockRuntime>, WebviewWindow<MockRuntime>) {
    let app = mock_builder()
        .invoke_handler(crate::invoke_handler())
        .manage(Arc::clone(&t.core))
        .build(crate::context())
        .expect("mock app");
    let window = WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .expect("window");
    (app, window)
}

/// The app's own origin, which the capability's `local` URLs mean.
const APP_URL: &str = if cfg!(target_os = "windows") {
    "http://tauri.localhost"
} else {
    "tauri://localhost"
};

fn invoke(w: &WebviewWindow<MockRuntime>, cmd: &str, args: Value) -> Result<Value, Value> {
    let request = InvokeRequest {
        cmd: cmd.into(),
        callback: CallbackFn(0),
        error: CallbackFn(1),
        url: APP_URL.parse().expect("url"),
        body: InvokeBody::Json(args),
        headers: Default::default(),
        invoke_key: INVOKE_KEY.to_string(),
    };
    get_ipc_response(w, request).map(|body| match body {
        InvokeResponseBody::Json(s) => serde_json::from_str(&s).expect("json response"),
        InvokeResponseBody::Raw(b) => json!(b.len()),
    })
}

fn kind(r: &Result<Value, Value>) -> String {
    match r {
        Err(e) => e
            .get("kind")
            .and_then(Value::as_str)
            .map_or_else(|| format!("not an IpcError: {e}"), str::to_owned),
        Ok(v) => format!("ok: {v}"),
    }
}

#[test]
fn all_mutating_commands_are_registered_permitted_and_busy_while_a_job_runs() {
    let t = TestCore::new();
    let photo = t.write_reference("ref.jpg");
    let dir = t.root.path().canonicalize().expect("dir");
    // As if picked in the export dialogs.
    t.core.grants.grant(crate::grants::Access::ExportDir, &dir);
    t.core
        .grants
        .grant(crate::grants::Access::ExportFile, &dir.join("v.mp4"));
    let (_app, w) = app(&t);
    let job = t.core.jobs.start(JobKind::Scan).expect("job");
    let channel = "__CHANNEL__:7";
    let video = serde_json::to_value(crate::session::model::default_video()).expect("video");
    let calls: Vec<(&str, Value)> = vec![
        ("reset_session", json!({})),
        ("pick_reference_photo", json!({})),
        ("set_reference_photo", json!({ "path": photo })),
        ("set_reference_rotation", json!({ "rotationDeg": 5.0 })),
        (
            "set_reference_crop",
            json!({ "crop": { "x": 0.0, "y": 0.0, "width": 40.0, "height": 40.0 }, "aspect": "4:5" }),
        ),
        ("pick_source_folder", json!({})),
        ("set_source_folder", json!({ "path": dir })),
        ("clear_scan_cache", json!({ "scope": "folder" })),
        ("start_scan", json!({ "onEvent": channel })),
        (
            "set_review_decision",
            json!({ "photoIds": ["0123456789abcdef"], "decision": "confirmed" }),
        ),
        (
            "select_day_photo",
            json!({ "dayKey": "2014-08-15", "photoId": "0123456789abcdef" }),
        ),
        (
            "move_photo_to_day",
            json!({ "photoId": "0123456789abcdef", "dayKey": "2014-08-15" }),
        ),
        (
            "add_photo_to_day",
            json!({ "dayKey": "2014-08-15", "path": null }),
        ),
        (
            "set_day_excluded",
            json!({ "dayKey": "2014-08-15", "excluded": true }),
        ),
        (
            "start_align",
            json!({ "render": { "resolution": "1080p", "backdrop": "blurred", "refineLandmarks": false }, "onEvent": channel }),
        ),
        (
            "set_frame_adjustment",
            json!({ "photoId": "0123456789abcdef", "adjust": { "dx": 0.0, "dy": 0.0, "scale": 1.0, "rotationDeg": 0.0 } }),
        ),
        (
            "set_look",
            json!({ "look": { "normalize": "exposure", "strength": 0.5 } }),
        ),
        ("pick_export_folder", json!({})),
        (
            "start_export_images",
            json!({ "dir": dir, "settings": { "format": "png", "jpegQuality": 95, "overwrite": false }, "onEvent": channel }),
        ),
        (
            "pick_video_path",
            json!({ "suggestedName": "FaceTimelapse.mp4" }),
        ),
        (
            "start_export_video",
            json!({ "path": dir.join("v.mp4"), "settings": video, "onEvent": channel }),
        ),
    ];
    for (cmd, args) in calls {
        assert_eq!(kind(&invoke(&w, cmd, args)), "busy", "{cmd}");
    }

    // Reads, cancel and the video settings keep working during a job.
    let mut settings = crate::session::model::default_video();
    settings.crossfade.frames = 3;
    let saved = invoke(
        &w,
        "set_video_settings",
        json!({ "settings": serde_json::to_value(&settings).expect("settings") }),
    )
    .expect("video settings during a job");
    assert_eq!(saved["crossfade"]["frames"], json!(3));
    assert_eq!(t.core.session.read().p.video, settings);
    let info = invoke(&w, "get_app_info", json!({})).expect("app info");
    assert_eq!(info["imageBaseUrl"], json!(t.core.meta.image_base_url));
    let session = invoke(&w, "get_session", json!({})).expect("session");
    assert_eq!(
        session["activeJob"],
        json!({ "jobId": job.id, "kind": "scan" })
    );
    assert_eq!(
        kind(&invoke(
            &w,
            "get_photos",
            json!({ "query": { "statuses": null } })
        )),
        "notReady"
    );
    assert_eq!(
        kind(&invoke(
            &w,
            "get_photo",
            json!({ "photoId": "0123456789abcdef" })
        )),
        "notFound"
    );
    assert_eq!(kind(&invoke(&w, "get_days", json!({}))), "notReady");
    assert_eq!(
        invoke(&w, "get_frames", json!({})).expect("frames")["status"],
        "none"
    );
    assert_eq!(
        kind(&invoke(&w, "reveal_path", json!({ "path": "/etc/hosts" }))),
        "invalidArgument"
    );
    assert_eq!(
        kind(&invoke(&w, "open_path", json!({ "path": "/etc/hosts" }))),
        "notFound",
        "registered and permitted; anything but an exported video is refused"
    );
    assert_eq!(
        invoke(&w, "cancel_job", json!({ "jobId": "job-unknown" })),
        Ok(Value::Null)
    );
    assert_eq!(
        invoke(&w, "cancel_job", json!({ "jobId": job.id })),
        Ok(Value::Null)
    );
    assert!(
        job.cancel.load(std::sync::atomic::Ordering::Acquire),
        "cancel reached the job"
    );
}

#[test]
fn snake_case_or_missing_args_are_rejected_before_the_command_runs() {
    let t = TestCore::new();
    let (_app, w) = app(&t);
    let wrong = invoke(&w, "set_reference_rotation", json!({ "rotation_deg": 5.0 }));
    assert!(wrong.as_ref().is_err_and(Value::is_string), "{wrong:?}");
    let missing = invoke(&w, "get_photos", json!({}));
    assert!(missing.as_ref().is_err_and(Value::is_string), "{missing:?}");
    let unknown = invoke(&w, "delete_everything", json!({}));
    assert!(unknown.is_err(), "unregistered commands are refused");
}

#[test]
fn session_changed_event_reaches_listeners() {
    use tauri::Listener;
    let t = TestCore::new();
    let (app, _window) = app(&t);
    let (tx, rx) = std::sync::mpsc::channel();
    app.listen_any(crate::ipc::SESSION_CHANGED_EVENT, move |e| {
        let _ = tx.send(e.payload().to_owned());
    });
    crate::commands::app::notify_session_changed(app.handle());
    let payload = rx
        .recv_timeout(std::time::Duration::from_secs(5))
        .expect("event delivered");
    assert_eq!(payload, "null", "no payload");
}

fn menu_event(id: &str) -> tauri::menu::MenuEvent {
    tauri::menu::MenuEvent {
        id: tauri::menu::MenuId::new(id),
    }
}

#[test]
fn help_keyboard_shortcuts_emits_show_keys_and_other_items_emit_nothing() {
    use tauri::Listener;
    let t = TestCore::new();
    let (app, _window) = app(&t);
    let (tx, rx) = std::sync::mpsc::channel();
    app.listen_any(crate::ipc::SHOW_KEYS_EVENT, move |e| {
        let _ = tx.send(e.payload().to_owned());
    });
    crate::menu::on_menu_event(app.handle(), &menu_event("about"));
    assert!(
        rx.recv_timeout(std::time::Duration::from_millis(200))
            .is_err(),
        "a predefined item is not ours"
    );
    crate::menu::on_menu_event(
        app.handle(),
        &menu_event(crate::menu::KEYBOARD_SHORTCUTS_ID),
    );
    let payload = rx
        .recv_timeout(std::time::Duration::from_secs(5))
        .expect("show-keys delivered");
    assert_eq!(payload, "null", "no payload");
}

/// Listens for `MODELS_CHANGED_EVENT`; the receiver yields each payload.
fn models_changed_listener(app: &App<MockRuntime>) -> std::sync::mpsc::Receiver<String> {
    use tauri::Listener;
    let (tx, rx) = std::sync::mpsc::channel();
    app.listen_any(crate::ipc::MODELS_CHANGED_EVENT, move |e| {
        let _ = tx.send(e.payload().to_owned());
    });
    rx
}

#[test]
fn a_failed_model_load_sets_models_error_and_emits_models_changed() {
    let t = TestCore::new();
    t.engine
        .models_missing
        .store(true, std::sync::atomic::Ordering::Relaxed);
    let (app, w) = app(&t);
    let rx = models_changed_listener(&app);
    let loading = invoke(&w, "get_app_info", json!({})).expect("info");
    assert_eq!(loading["modelsReady"], json!(false));
    assert_eq!(
        loading["modelsError"],
        Value::Null,
        "still loading: no error"
    );

    assert!(!crate::commands::app::load_models_and_notify(
        &t.core,
        app.handle()
    ));
    let payload = rx
        .recv_timeout(std::time::Duration::from_secs(5))
        .expect("models-changed delivered");
    assert_eq!(payload, "null", "no payload");

    let failed = invoke(&w, "get_app_info", json!({})).expect("info");
    assert_eq!(failed["modelsReady"], json!(false));
    assert_eq!(
        failed["modelsError"],
        json!(crate::error::msg::MODEL_UNAVAILABLE),
        "the engine's user-facing message"
    );

    // A later command-triggered retry that succeeds wins: ready, no error.
    t.engine
        .models_missing
        .store(false, std::sync::atomic::Ordering::Relaxed);
    let recovered = invoke(&w, "get_app_info", json!({})).expect("info");
    assert_eq!(recovered["modelsReady"], json!(true));
    assert_eq!(recovered["modelsError"], Value::Null);
}

#[test]
fn a_successful_model_load_emits_models_changed_with_models_ready() {
    let t = TestCore::new();
    let (app, w) = app(&t);
    let rx = models_changed_listener(&app);
    assert!(crate::commands::app::load_models_and_notify(
        &t.core,
        app.handle()
    ));
    let payload = rx
        .recv_timeout(std::time::Duration::from_secs(5))
        .expect("models-changed delivered");
    assert_eq!(payload, "null", "no payload");
    let info = invoke(&w, "get_app_info", json!({})).expect("info");
    assert_eq!(info["modelsReady"], json!(true));
    assert_eq!(info["modelsError"], Value::Null);
}

#[test]
fn the_webview_cannot_emit_app_events() {
    let t = TestCore::new();
    let (app, w) = app(&t);
    let rx = models_changed_listener(&app);
    for (cmd, args) in [
        (
            "plugin:event|emit",
            json!({"event": crate::ipc::MODELS_CHANGED_EVENT, "payload": null}),
        ),
        (
            "plugin:event|emit_to",
            json!({
                "target": {"kind": "Any"},
                "event": crate::ipc::MODELS_CHANGED_EVENT,
                "payload": null
            }),
        ),
        (
            "plugin:event|emit",
            json!({"event": crate::ipc::SESSION_CHANGED_EVENT, "payload": null}),
        ),
        (
            "plugin:event|emit",
            json!({"event": crate::ipc::SHOW_KEYS_EVENT, "payload": null}),
        ),
    ] {
        let denied = invoke(&w, cmd, args);
        let reason = denied.expect_err("must be refused");
        assert!(
            reason.as_str().is_some_and(|r| r.contains("not allowed")),
            "{cmd} refused by the ACL, not for another reason: {reason}"
        );
    }
    assert!(
        rx.recv_timeout(std::time::Duration::from_millis(200))
            .is_err(),
        "nothing reached listeners"
    );
}

#[test]
fn command_lists_build_rs_and_capability_agree() {
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let build_rs = std::fs::read_to_string(manifest.join("build.rs")).expect("build.rs");
    let caps: Value = serde_json::from_str(
        &std::fs::read_to_string(manifest.join("capabilities/main.json")).expect("caps"),
    )
    .expect("json");
    let lib_rs = std::fs::read_to_string(manifest.join("src/lib.rs")).expect("lib.rs");
    let permissions: Vec<&str> = caps["permissions"]
        .as_array()
        .expect("array")
        .iter()
        .filter_map(Value::as_str)
        .collect();
    for name in crate::commands::COMMAND_NAMES {
        assert!(
            build_rs.contains(&format!("\"{name}\"")),
            "{name} missing from build.rs AppManifest"
        );
        assert!(
            permissions.contains(&format!("allow-{}", name.replace('_', "-")).as_str()),
            "{name} not granted in capabilities/main.json"
        );
        assert!(
            lib_rs.contains(&format!("::{name},")),
            "{name} not in invoke_handler()"
        );
    }
    let app_perms = permissions.iter().filter(|p| !p.contains(':')).count();
    assert_eq!(app_perms, 31, "exactly the 31 app commands are granted");
    let core: Vec<&str> = permissions
        .iter()
        .copied()
        .filter(|p| p.contains(':'))
        .collect();
    assert_eq!(
        core,
        [
            "core:event:allow-listen",
            "core:event:allow-unlisten",
            "core:window:allow-show",
            "core:window:allow-start-dragging",
            "core:window:allow-internal-toggle-maximize",
            "core:window:allow-set-theme",
        ],
        "only the documented core permissions (ARCHITECTURE.md §13)"
    );
    for forbidden in [
        "fs:",
        "shell:",
        "http:",
        "dialog:",
        "opener:",
        "core:default",
    ] {
        assert!(
            !permissions.iter().any(|p| p.starts_with(forbidden)),
            "{forbidden} must not be granted to the webview"
        );
    }
}
