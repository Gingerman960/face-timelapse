//! macOS side of the harness: everything runs in the app's own process on
//! the main thread, against the app's own `WKWebView` and `NSWindow`.
//!
//! - JavaScript: `callAsyncJavaScript:…` in the page world (results come
//!   back as JSON strings).
//! - Gestures: `NSEvent`s built with AppKit's constructors and handed to
//!   the window with `-[NSWindow sendEvent:]`, so WebKit receives them as
//!   real (trusted) mouse, key and wheel input. Nothing is posted to the
//!   window server (no `CGEventPost`), so no Accessibility permission is
//!   involved and no other app can receive these events.
//! - Snapshots: `-[WKWebView takeSnapshotWithConfiguration:…]`; the window
//!   route asks the window server for this app's own window only.

use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{AnyThread, MainThreadMarker};
use objc2_app_kit::{
    NSApplication, NSBitmapImageFileType, NSBitmapImageRep, NSEvent, NSEventModifierFlags,
    NSEventType, NSImage, NSResponder, NSView, NSWindow,
};
use objc2_core_foundation::{CGPoint, CGRect, CGSize};
use objc2_core_graphics::{
    CGEvent, CGEventField, CGImage, CGScrollEventUnit, CGWindowImageOption, CGWindowListOption,
};
use objc2_foundation::{NSDictionary, NSError, NSPoint, NSProcessInfo, NSRect, NSSize, NSString};
use objc2_web_kit::{WKContentWorld, WKSnapshotConfiguration, WKWebView};
use serde_json::{Value, json};
use tauri::{Runtime, WebviewWindow};

use crate::script::{Button, KeySpec, Mod};

/// How long a main-thread operation may take before the harness gives up.
const MAIN_THREAD_LIMIT: Duration = Duration::from_secs(20);
/// `kCGFloatingWindowLevel`.
const FLOATING_LEVEL: isize = 3;

type Reply<T> = mpsc::Sender<Result<T, String>>;

/// Runs `f` on the main thread with the window's live `WKWebView` and
/// `NSWindow`; `f` answers through the sender (possibly later, from a
/// completion handler). Waits up to `limit` for the answer.
fn on_main<R, T, F>(window: &WebviewWindow<R>, limit: Duration, f: F) -> Result<T, String>
where
    R: Runtime,
    T: Send + 'static,
    F: FnOnce(&WKWebView, &NSWindow, MainThreadMarker, Reply<T>) + Send + 'static,
{
    let (tx, rx) = mpsc::channel();
    window
        .with_webview(move |pw| {
            let Some(mtm) = MainThreadMarker::new() else {
                let _ = tx.send(Err("with_webview did not run on the main thread".into()));
                return;
            };
            let wv = pw.inner().cast::<WKWebView>();
            let win = pw.ns_window().cast::<NSWindow>();
            if wv.is_null() || win.is_null() {
                let _ = tx.send(Err("the webview or its window is gone".into()));
                return;
            }
            // SAFETY: wry hands out pointers to its live WKWebView and
            // NSWindow; they are only used on the main thread, inside this
            // closure, while wry keeps both alive.
            let (wv, win) = unsafe { (&*wv, &*win) };
            f(wv, win, mtm, tx);
        })
        .map_err(|e| format!("with_webview failed: {e}"))?;
    rx.recv_timeout(limit)
        .map_err(|_| format!("no answer from the main thread within {limit:?}"))?
}

fn describe_error(err: &NSError) -> String {
    let info = err.userInfo();
    let detail = |key: &str| {
        info.objectForKey(&NSString::from_str(key)).map(|v| {
            v.downcast_ref::<NSString>()
                .map_or_else(|| format!("{v:?}"), ToString::to_string)
        })
    };
    let mut out = err.localizedDescription().to_string();
    if let Some(m) = detail("WKJavaScriptExceptionMessage") {
        out.push_str(": ");
        out.push_str(&m);
    }
    if let Some(line) = detail("WKJavaScriptExceptionLineNumber") {
        out.push_str(&format!(" (line {line})"));
    }
    out
}

/// Runs an async function body in the page world; returns the JSON string
/// the body returns (see [`crate::script::eval_body`]).
pub fn call_js<R: Runtime>(
    window: &WebviewWindow<R>,
    body: String,
    limit: Duration,
) -> Result<String, String> {
    on_main(window, limit, move |wv, _win, mtm, tx| {
        let block = RcBlock::new(move |res: *mut AnyObject, err: *mut NSError| {
            let out = if !err.is_null() {
                // SAFETY: WebKit passes a valid NSError when non-null.
                Err(describe_error(unsafe { &*err }))
            } else if res.is_null() {
                Ok("null".to_owned())
            } else {
                // SAFETY: WebKit passes a valid object when non-null.
                let obj = unsafe { &*res };
                match obj.downcast_ref::<NSString>() {
                    Some(s) => Ok(s.to_string()),
                    None => Ok(serde_json::to_string(&format!("{obj:?}")).unwrap_or_default()),
                }
            };
            let _ = tx.send(out);
        });
        let world = unsafe { WKContentWorld::pageWorld(mtm) };
        // SAFETY: no arguments dictionary is passed; the block matches the
        // completion handler's signature.
        unsafe {
            wv.callAsyncJavaScript_arguments_inFrame_inContentWorld_completionHandler(
                &NSString::from_str(&body),
                None,
                None,
                &world,
                Some(&block),
            );
        }
    })
}

fn write_png(rep: &NSBitmapImageRep, path: &Path) -> Result<(), String> {
    // SAFETY: an empty properties dictionary is valid for PNG.
    let data = unsafe {
        rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new())
    }
    .ok_or("PNG encoding failed")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    std::fs::write(path, data.to_vec()).map_err(|e| format!("{}: {e}", path.display()))
}

fn rep_from_cg(img: &CGImage) -> Retained<NSBitmapImageRep> {
    NSBitmapImageRep::initWithCGImage(NSBitmapImageRep::alloc(), img)
}

/// True when every sampled byte of the bitmap is zero (a capture the window
/// server refused comes back fully transparent).
fn looks_blank(rep: &NSBitmapImageRep) -> bool {
    let data = rep.bitmapData();
    let row = usize::try_from(rep.bytesPerRow()).unwrap_or(0);
    let h = usize::try_from(rep.pixelsHigh()).unwrap_or(0);
    if data.is_null() || row == 0 || h == 0 {
        return true;
    }
    for sy in 0..32 {
        let y = sy * (h - 1) / 31;
        for sx in 0..32 {
            let x = sx * (row - 1) / 31;
            // SAFETY: (x, y) is inside the bitmap's rows × bytesPerRow buffer.
            if unsafe { *data.add(y * row + x) } != 0 {
                return false;
            }
        }
    }
    true
}

fn size_of(rep: &NSBitmapImageRep) -> (isize, isize) {
    (rep.pixelsWide(), rep.pixelsHigh())
}

/// `WKWebView takeSnapshotWithConfiguration` → PNG (after pending updates).
pub fn snapshot_webview<R: Runtime>(
    window: &WebviewWindow<R>,
    path: PathBuf,
) -> Result<Value, String> {
    on_main(window, MAIN_THREAD_LIMIT, move |wv, _win, mtm, tx| {
        let cfg = unsafe { WKSnapshotConfiguration::new(mtm) };
        unsafe { cfg.setAfterScreenUpdates(true) };
        let block = RcBlock::new(move |img: *mut NSImage, err: *mut NSError| {
            let out = if !err.is_null() {
                // SAFETY: WebKit passes a valid NSError when non-null.
                Err(describe_error(unsafe { &*err }))
            } else if img.is_null() {
                Err("no snapshot image".to_owned())
            } else {
                // SAFETY: WebKit passes a valid NSImage when non-null.
                let img = unsafe { &*img };
                let size = img.size();
                // SAFETY: a null proposed rect means the image's own size.
                match unsafe {
                    img.CGImageForProposedRect_context_hints(std::ptr::null_mut(), None, None)
                } {
                    None => Err("snapshot has no bitmap".to_owned()),
                    Some(cg) => {
                        let rep = rep_from_cg(&cg);
                        let (pw, ph) = size_of(&rep);
                        write_png(&rep, &path).map(|()| {
                            json!({"path": path, "route": "webview", "points": [size.width, size.height], "pixels": [pw, ph]})
                        })
                    }
                }
            };
            let _ = tx.send(out);
        });
        // SAFETY: the configuration and block outlive the call (WebKit copies the block).
        unsafe { wv.takeSnapshotWithConfiguration_completionHandler(Some(&cfg), &block) };
    })
}

/// The app's own window as the window server composes it. macOS may refuse
/// (a blank image) unless the app has the screen-recording permission; the
/// harness never asks for it and reports `blank: true` instead.
pub fn snapshot_window<R: Runtime>(
    window: &WebviewWindow<R>,
    path: PathBuf,
) -> Result<Value, String> {
    on_main(window, MAIN_THREAD_LIMIT, move |_wv, win, _mtm, tx| {
        let id = u32::try_from(win.windowNumber()).unwrap_or(0);
        let null_rect = CGRect::new(
            CGPoint::new(f64::INFINITY, f64::INFINITY),
            CGSize::new(0.0, 0.0),
        );
        #[allow(deprecated)]
        let img = objc2_core_graphics::CGWindowListCreateImage(
            null_rect,
            CGWindowListOption::OptionIncludingWindow,
            id,
            CGWindowImageOption::BoundsIgnoreFraming | CGWindowImageOption::BestResolution,
        );
        let out = match img {
            None => Err("the window server returned no image".to_owned()),
            Some(img) => {
                let rep = rep_from_cg(&img);
                let blank = looks_blank(&rep);
                let (pw, ph) = size_of(&rep);
                write_png(&rep, &path)
                    .map(|()| json!({"path": path, "route": "window", "pixels": [pw, ph], "blank": blank}))
            }
        };
        let _ = tx.send(out);
    })
}

fn uptime() -> f64 {
    NSProcessInfo::processInfo().systemUptime()
}

fn flags(mods: &[Mod]) -> NSEventModifierFlags {
    let mut f = NSEventModifierFlags::empty();
    for m in mods {
        f |= match m {
            Mod::Cmd => NSEventModifierFlags::Command,
            Mod::Shift => NSEventModifierFlags::Shift,
            Mod::Alt => NSEventModifierFlags::Option,
            Mod::Ctrl => NSEventModifierFlags::Control,
        };
    }
    f
}

/// Viewport CSS pixels → window coordinates (points, bottom-left origin).
fn to_window(wv: &WKWebView, x: f64, y: f64) -> NSPoint {
    let view: &NSView = wv;
    let b = view.bounds();
    let p = if view.isFlipped() {
        NSPoint::new(x, y)
    } else {
        NSPoint::new(x, b.size.height - y)
    };
    view.convertPoint_toView(p, None)
}

/// Mouse phases the harness sends.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mouse {
    Down,
    Up,
    Dragged,
    Moved,
}

/// Sends one native mouse event at viewport point (`x`, `y`).
pub fn mouse<R: Runtime>(
    window: &WebviewWindow<R>,
    phase: Mouse,
    (x, y): (f64, f64),
    button: Button,
    clicks: u32,
    mods: Vec<Mod>,
) -> Result<(), String> {
    on_main(window, MAIN_THREAD_LIMIT, move |wv, win, _mtm, tx| {
        let kind = match (phase, button) {
            (Mouse::Down, Button::Left) => NSEventType::LeftMouseDown,
            (Mouse::Up, Button::Left) => NSEventType::LeftMouseUp,
            (Mouse::Down, Button::Right) => NSEventType::RightMouseDown,
            (Mouse::Up, Button::Right) => NSEventType::RightMouseUp,
            (Mouse::Dragged, _) => NSEventType::LeftMouseDragged,
            (Mouse::Moved, _) => NSEventType::MouseMoved,
        };
        if phase == Mouse::Moved {
            win.setAcceptsMouseMovedEvents(true);
        }
        let loc = to_window(wv, x, y);
        let pressure = if matches!(phase, Mouse::Down | Mouse::Dragged) {
            1.0
        } else {
            0.0
        };
        let clicks = if matches!(phase, Mouse::Down | Mouse::Up) {
            clicks.max(1)
        } else {
            0
        };
        let ev = NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
            kind,
            loc,
            flags(&mods),
            uptime(),
            win.windowNumber(),
            None,
            0,
            isize::try_from(clicks).unwrap_or(1),
            pressure,
        );
        let out = match ev {
            Some(ev) => {
                win.sendEvent(&ev);
                Ok(())
            }
            None => Err("AppKit refused to build the mouse event".to_owned()),
        };
        let _ = tx.send(out);
    })
}

/// Sends one native key event (down or up) to the webview.
pub fn key<R: Runtime>(
    window: &WebviewWindow<R>,
    spec: KeySpec,
    mods: Vec<Mod>,
    down: bool,
) -> Result<(), String> {
    on_main(window, MAIN_THREAD_LIMIT, move |wv, win, _mtm, tx| {
        let view: &NSView = wv;
        let responder: &NSResponder = view;
        if win
            .firstResponder()
            .is_none_or(|r| !std::ptr::eq(&*r, responder))
        {
            win.makeFirstResponder(Some(responder));
        }
        let ev = NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(
            if down { NSEventType::KeyDown } else { NSEventType::KeyUp },
            NSPoint::new(0.0, 0.0),
            flags(&mods),
            uptime(),
            win.windowNumber(),
            None,
            &NSString::from_str(&spec.chars),
            &NSString::from_str(&spec.chars_ignoring_mods),
            false,
            spec.code,
        );
        let out = match ev {
            Some(ev) => {
                win.sendEvent(&ev);
                Ok(())
            }
            None => Err("AppKit refused to build the key event".to_owned()),
        };
        let _ = tx.send(out);
    })
}

/// Sends a native pixel-precise scroll-wheel event at viewport point
/// (`x`, `y`); positive `dy` scrolls the content down.
pub fn wheel<R: Runtime>(
    window: &WebviewWindow<R>,
    (x, y): (f64, f64),
    dx: f64,
    dy: f64,
) -> Result<(), String> {
    on_main(window, MAIN_THREAD_LIMIT, move |wv, win, mtm, tx| {
        let out = (|| {
            let in_window = to_window(wv, x, y);
            let on_screen = win.convertPointToScreen(in_window);
            let main_h =
                objc2_app_kit::NSScreen::mainScreen(mtm).map_or(0.0, |s| s.frame().size.height);
            #[allow(clippy::cast_possible_truncation)]
            let ev = CGEvent::new_scroll_wheel_event2(
                None,
                CGScrollEventUnit::Pixel,
                2,
                -dy.round() as i32,
                -dx.round() as i32,
                0,
            )
            .ok_or("CoreGraphics refused to build the wheel event")?;
            CGEvent::set_location(Some(&ev), CGPoint::new(on_screen.x, main_h - on_screen.y));
            let n = i64::try_from(win.windowNumber()).unwrap_or(0);
            CGEvent::set_integer_value_field(
                Some(&ev),
                CGEventField::MouseEventWindowUnderMousePointer,
                n,
            );
            CGEvent::set_integer_value_field(
                Some(&ev),
                CGEventField::MouseEventWindowUnderMousePointerThatCanHandleThisEvent,
                n,
            );
            let ns = NSEvent::eventWithCGEvent(&ev).ok_or("AppKit refused the wheel event")?;
            win.sendEvent(&ns);
            Ok(())
        })();
        let _ = tx.send(out);
    })
}

fn rect(r: NSRect) -> Value {
    json!([r.origin.x, r.origin.y, r.size.width, r.size.height])
}

/// Window, content, webview and screen geometry plus key/occlusion state.
pub fn window_info<R: Runtime>(window: &WebviewWindow<R>) -> Result<Value, String> {
    on_main(window, MAIN_THREAD_LIMIT, move |wv, win, _mtm, tx| {
        let view: &NSView = wv;
        let screen = win.screen();
        let out = json!({
            "frame": rect(win.frame()),
            "content": win.contentView().map(|v| rect(v.frame())),
            "webview": rect(view.frame()),
            "webviewFlipped": view.isFlipped(),
            "screen": screen.as_ref().map(|s| rect(s.frame())),
            "visibleScreen": screen.as_ref().map(|s| rect(s.visibleFrame())),
            "scale": win.backingScaleFactor(),
            "key": win.isKeyWindow(),
            "level": win.level(),
            "occlusionVisible": win.occlusionState().0 & 2 != 0,
            "windowNumber": win.windowNumber(),
        });
        let _ = tx.send(Ok(out));
    })
}

/// The window's number, frame size in points and backing scale (for the
/// recorder, which captures off the main thread).
pub fn window_geometry<R: Runtime>(
    window: &WebviewWindow<R>,
) -> Result<(u32, f64, f64, f64), String> {
    on_main(window, MAIN_THREAD_LIMIT, move |_wv, win, _mtm, tx| {
        let f = win.frame();
        let out = u32::try_from(win.windowNumber())
            .map_err(|_| "the window has no window-server number".to_owned())
            .map(|id| (id, f.size.width, f.size.height, win.backingScaleFactor()));
        let _ = tx.send(out);
    })
}

/// Sets the content size (points); AppKit applies the window's min size.
pub fn resize<R: Runtime>(
    window: &WebviewWindow<R>,
    width: f64,
    height: f64,
) -> Result<Value, String> {
    on_main(window, MAIN_THREAD_LIMIT, move |_wv, win, _mtm, tx| {
        win.setContentSize(NSSize::new(width, height));
        let _ = tx.send(Ok(rect(win.frame())));
    })
}

/// Moves the window's top-left corner to (`x`, `y`) points from the main
/// screen's top-left corner (in process; AppKit keeps it on a screen).
pub fn place<R: Runtime>(window: &WebviewWindow<R>, x: f64, y: f64) -> Result<Value, String> {
    on_main(window, MAIN_THREAD_LIMIT, move |_wv, win, mtm, tx| {
        let main_h =
            objc2_app_kit::NSScreen::mainScreen(mtm).map_or(0.0, |s| s.frame().size.height);
        win.setFrameTopLeftPoint(NSPoint::new(x, main_h - y));
        let _ = tx.send(Ok(rect(win.frame())));
    })
}

thread_local! {
    /// The `activity` command's assertion (main thread only).
    static ACTIVITY: std::cell::RefCell<Option<Retained<objc2::runtime::ProtocolObject<dyn objc2_foundation::NSObjectProtocol>>>> =
        const { std::cell::RefCell::new(None) };
}

/// Holds (or releases) a user-initiated `NSProcessInfo` activity, which
/// keeps App Nap from demoting the process while the window is hidden. QA
/// uses it to tell App Nap effects apart from real slowness.
pub fn activity<R: Runtime>(window: &WebviewWindow<R>, on: bool) -> Result<Value, String> {
    on_main(window, MAIN_THREAD_LIMIT, move |_wv, _win, _mtm, tx| {
        let info = NSProcessInfo::processInfo();
        ACTIVITY.with(|a| {
            let mut a = a.borrow_mut();
            if let Some(old) = a.take() {
                // SAFETY: `old` was returned by beginActivityWithOptions_reason.
                unsafe { info.endActivity(&old) };
            }
            if on {
                *a = Some(info.beginActivityWithOptions_reason(
                    objc2_foundation::NSActivityOptions::UserInitiatedAllowingIdleSystemSleep,
                    &NSString::from_str("FaceTimelapse QA harness"),
                ));
            }
        });
        let _ = tx.send(Ok(json!({"activity": on})));
    })
}

/// Miniaturizes the window into the Dock (`on: true`) or restores it.
pub fn minimize<R: Runtime>(window: &WebviewWindow<R>, on: bool) -> Result<Value, String> {
    on_main(window, MAIN_THREAD_LIMIT, move |_wv, win, _mtm, tx| {
        if on {
            win.miniaturize(None);
        } else {
            win.deminiaturize(None);
        }
        let _ = tx.send(Ok(json!({"miniaturized": win.isMiniaturized()})));
    })
}

/// Floating level on/off (never activates the app).
pub fn float<R: Runtime>(window: &WebviewWindow<R>, on: bool) -> Result<Value, String> {
    on_main(window, MAIN_THREAD_LIMIT, move |_wv, win, _mtm, tx| {
        win.setLevel(if on { FLOATING_LEVEL } else { 0 });
        win.orderFrontRegardless();
        let _ = tx.send(Ok(json!({"level": win.level()})));
    })
}

/// The app's current cursor: whether it is the arrow or the I-beam, and its
/// image size in points (WebKit's `cursor: none` sets a blank 1×1 image).
pub fn cursor<R: Runtime>(window: &WebviewWindow<R>) -> Result<Value, String> {
    on_main(window, MAIN_THREAD_LIMIT, move |_wv, _win, _mtm, tx| {
        let current = objc2_app_kit::NSCursor::currentCursor();
        let arrow = objc2_app_kit::NSCursor::arrowCursor();
        let ibeam = objc2_app_kit::NSCursor::IBeamCursor();
        let size = current.image().size();
        let _ = tx.send(Ok(json!({
            "isArrow": Retained::as_ptr(&current) == Retained::as_ptr(&arrow),
            "isIBeam": Retained::as_ptr(&current) == Retained::as_ptr(&ibeam),
            "imageSize": [size.width, size.height],
        })));
    })
}

/// Activates the app and makes the window key.
pub fn activate<R: Runtime>(window: &WebviewWindow<R>) -> Result<Value, String> {
    on_main(window, MAIN_THREAD_LIMIT, move |_wv, win, mtm, tx| {
        #[allow(deprecated)]
        NSApplication::sharedApplication(mtm).activateIgnoringOtherApps(true);
        win.makeKeyAndOrderFront(None);
        let _ = tx.send(Ok(json!({"key": win.isKeyWindow()})));
    })
}
