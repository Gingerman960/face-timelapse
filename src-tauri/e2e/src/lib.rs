//! Test-only GUI harness for the FaceTimelapse window (QA, ARCHITECTURE.md §12).
//!
//! The app links this crate only with its `e2e` cargo feature, which refuses
//! to compile without debug assertions, so release bundles never contain it.
//! It stays idle unless `FT_E2E_SCRIPT` names a script file: the harness
//! follows that file as it grows (JSON Lines, see [`script`]), runs each
//! command against the real webview (JavaScript, native mouse/key/wheel
//! events, snapshots) and appends one JSON result per command to
//! `FT_E2E_OUT` (default: the script path plus `.out`). There is no network
//! listener; whoever can write the script file already runs as the user.
//!
//! Native file dialogs cannot be driven, so a `dialog` command queues the
//! answer the next dialog returns ([`take_dialog_answer`]); the app grants it
//! exactly like a path the user picked.

pub mod recording;
pub mod script;

#[cfg(target_os = "macos")]
mod capture;
#[cfg(target_os = "macos")]
mod native;

use std::collections::VecDeque;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use serde_json::{Value, json};
use tauri::{Manager, Runtime, WebviewWindow};

use crate::script::{Command, Line};

/// Environment variable naming the script file.
pub const SCRIPT_ENV: &str = "FT_E2E_SCRIPT";
/// Environment variable naming the results file.
pub const OUT_ENV: &str = "FT_E2E_OUT";
/// How often the script file is checked for new lines.
const POLL: Duration = Duration::from_millis(25);
/// Pause between the parts of a gesture (press/release, key down/up), so
/// WebKit sees them as separate input like a person's.
#[cfg(target_os = "macos")]
const GESTURE_GAP: Duration = Duration::from_millis(24);

static DIALOG_ANSWERS: Mutex<VecDeque<Option<PathBuf>>> = parking_lot::const_mutex(VecDeque::new());

/// Queues what the next native file dialog returns (`None` = cancelled).
pub fn queue_dialog_answer(answer: Option<PathBuf>) {
    DIALOG_ANSWERS.lock().push_back(answer);
}

/// The queued answer for a dialog about to open, if the harness queued one:
/// `Some(answer)` replaces the dialog, `None` lets the real dialog open.
#[must_use]
pub fn take_dialog_answer() -> Option<Option<PathBuf>> {
    DIALOG_ANSWERS.lock().pop_front()
}

/// Starts the harness thread when `FT_E2E_SCRIPT` is set; otherwise does
/// nothing.
pub fn start<R: Runtime>(window: WebviewWindow<R>) {
    let Some(script) = std::env::var_os(SCRIPT_ENV).map(PathBuf::from) else {
        return;
    };
    let out = std::env::var_os(OUT_ENV).map_or_else(
        || PathBuf::from(format!("{}.out", script.display())),
        PathBuf::from,
    );
    log::warn!(
        "e2e harness active: script {} → results {}",
        script.display(),
        out.display()
    );
    let spawned =
        std::thread::Builder::new()
            .name("ft-e2e".into())
            .spawn(move || match Runner::new(window, &out) {
                Ok(mut r) => r.run(&script),
                Err(e) => log::error!("e2e harness: cannot open {}: {e}", out.display()),
            });
    if let Err(e) = spawned {
        log::error!("e2e harness: cannot start: {e}");
    }
}

fn unix_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis())
}

struct Runner<R: Runtime> {
    window: WebviewWindow<R>,
    out: File,
    started: Instant,
    #[cfg(target_os = "macos")]
    recording: Option<capture::Recording>,
}

impl<R: Runtime> Runner<R> {
    fn new(window: WebviewWindow<R>, out: &Path) -> std::io::Result<Self> {
        let out = OpenOptions::new().create(true).append(true).open(out)?;
        Ok(Self {
            window,
            out,
            started: Instant::now(),
            #[cfg(target_os = "macos")]
            recording: None,
        })
    }

    fn emit(&mut self, v: &Value) {
        if let Err(e) = writeln!(self.out, "{v}").and_then(|()| self.out.flush()) {
            log::error!("e2e harness: cannot write a result: {e}");
        }
    }

    /// Follows the script file; returns after `quit`.
    fn run(&mut self, script: &Path) {
        let mut offset = 0_u64;
        let mut buf = String::new();
        self.emit(&json!({"event": "ready", "t": unix_ms(), "pid": std::process::id()}));
        loop {
            if let Err(e) = read_new(script, &mut offset, &mut buf) {
                // A missing script is fine: it may be created later.
                if e.kind() != std::io::ErrorKind::NotFound {
                    log::warn!("e2e harness: reading {}: {e}", script.display());
                }
            }
            for raw in script::take_complete_lines(&mut buf) {
                match script::parse_line(&raw) {
                    Ok(None) => {}
                    Err(e) => {
                        self.emit(&json!({"ok": false, "error": e, "line": raw, "t": unix_ms()}))
                    }
                    Ok(Some(line)) => {
                        let quit = line.cmd == Command::Quit;
                        self.exec(line);
                        if quit {
                            return;
                        }
                    }
                }
            }
            std::thread::sleep(POLL);
        }
    }

    fn exec(&mut self, line: Line) {
        let name = line.cmd.name();
        let t0 = Instant::now();
        let res = self.dispatch(line.cmd);
        let ms = t0.elapsed().as_secs_f64() * 1000.0;
        let mut v = json!({
            "id": line.id,
            "cmd": name,
            "ms": (ms * 10.0).round() / 10.0,
            "t": unix_ms(),
            "since_start_ms": self.started.elapsed().as_millis(),
        });
        match res {
            Ok(value) => {
                v["ok"] = json!(true);
                v["value"] = value;
            }
            Err(e) => {
                v["ok"] = json!(false);
                v["error"] = json!(e);
            }
        }
        self.emit(&v);
    }

    fn dispatch(&mut self, cmd: Command) -> Result<Value, String> {
        match cmd {
            Command::Eval { js, timeout_ms } => self.js(script::eval_body(&js), timeout_ms),
            Command::Wait {
                js,
                timeout_ms,
                interval_ms,
            } => self.js(
                script::wait_body(&js, timeout_ms, interval_ms),
                timeout_ms + 5_000,
            ),
            Command::Mark { label } => Ok(json!({"label": label})),
            Command::Sleep { ms } => {
                std::thread::sleep(Duration::from_millis(ms));
                Ok(Value::Null)
            }
            Command::Dialog { path } => {
                queue_dialog_answer(path.map(PathBuf::from));
                Ok(Value::Null)
            }
            Command::Quit => {
                #[cfg(target_os = "macos")]
                self.finish_recording();
                self.window.app_handle().exit(0);
                Ok(Value::Null)
            }
            other => self.native(other),
        }
    }

    /// Finishes a running recording, so its file is complete before exit.
    #[cfg(target_os = "macos")]
    fn finish_recording(&mut self) {
        if let Some(r) = self.recording.take()
            && let Err(e) = r.stop()
        {
            log::error!("e2e harness: recording failed: {e}");
        }
    }

    fn js(&self, body: String, timeout_ms: u64) -> Result<Value, String> {
        let raw = call_js(
            &self.window,
            body,
            Duration::from_millis(timeout_ms + 1_000),
        )?;
        Ok(serde_json::from_str(&raw).unwrap_or(Value::String(raw)))
    }

    /// Where a target is on screen; only the native gestures need it.
    #[cfg(target_os = "macos")]
    fn resolve(&self, target: &script::Target) -> Result<script::Resolved, String> {
        let raw = call_js(
            &self.window,
            script::target_body(target)?,
            Duration::from_secs(10),
        )?;
        serde_json::from_str(&raw).map_err(|e| format!("bad target answer {raw}: {e}"))
    }

    #[cfg(not(target_os = "macos"))]
    fn native(&mut self, cmd: Command) -> Result<Value, String> {
        Err(format!("`{}` is only implemented on macOS", cmd.name()))
    }

    #[cfg(target_os = "macos")]
    fn native(&mut self, cmd: Command) -> Result<Value, String> {
        use native::Mouse;
        let w = &self.window;
        match cmd {
            Command::Click {
                target,
                button,
                count,
                mods,
            } => {
                let at = self.resolve(&target)?;
                let p = (at.x, at.y);
                native::mouse(w, Mouse::Moved, p, button, 0, mods.clone())?;
                for n in 1..=count.max(1) {
                    native::mouse(w, Mouse::Down, p, button, n, mods.clone())?;
                    std::thread::sleep(GESTURE_GAP);
                    native::mouse(w, Mouse::Up, p, button, n, mods.clone())?;
                    std::thread::sleep(GESTURE_GAP);
                }
                Ok(json!(at))
            }
            Command::Hover { target } => {
                let at = self.resolve(&target)?;
                native::mouse(
                    w,
                    Mouse::Moved,
                    (at.x, at.y),
                    script::Button::Left,
                    0,
                    Vec::new(),
                )?;
                Ok(json!(at))
            }
            Command::Drag {
                from,
                to,
                steps,
                hold_ms,
                step_ms,
            } => {
                let a = self.resolve(&from)?;
                let start = (a.x, a.y);
                native::mouse(w, Mouse::Moved, start, script::Button::Left, 0, Vec::new())?;
                native::mouse(w, Mouse::Down, start, script::Button::Left, 1, Vec::new())?;
                std::thread::sleep(Duration::from_millis(hold_ms).max(GESTURE_GAP));
                // Resolve the end only now: pressing may have changed the layout.
                let b = self.resolve(&to)?;
                for p in script::drag_path(start, (b.x, b.y), steps) {
                    native::mouse(w, Mouse::Dragged, p, script::Button::Left, 0, Vec::new())?;
                    std::thread::sleep(Duration::from_millis(step_ms));
                }
                std::thread::sleep(GESTURE_GAP);
                native::mouse(
                    w,
                    Mouse::Up,
                    (b.x, b.y),
                    script::Button::Left,
                    1,
                    Vec::new(),
                )?;
                Ok(json!({"from": a, "to": b}))
            }
            Command::Key { key, mods, hold_ms } => {
                let (spec, implied_shift) = script::key_spec(&key, &mods)?;
                let mut mods = mods;
                if implied_shift && !mods.contains(&script::Mod::Shift) {
                    mods.push(script::Mod::Shift);
                }
                native::key(w, spec.clone(), mods.clone(), true)?;
                std::thread::sleep(Duration::from_millis(hold_ms).max(GESTURE_GAP));
                native::key(w, spec, mods, false)?;
                Ok(Value::Null)
            }
            Command::Type { text } => {
                for c in text.chars() {
                    let key = if c == ' ' {
                        "Space".to_owned()
                    } else {
                        c.to_string()
                    };
                    let (spec, implied_shift) = script::key_spec(&key, &[])?;
                    let mods = if implied_shift {
                        vec![script::Mod::Shift]
                    } else {
                        Vec::new()
                    };
                    native::key(w, spec.clone(), mods.clone(), true)?;
                    native::key(w, spec, mods, false)?;
                    std::thread::sleep(GESTURE_GAP);
                }
                Ok(Value::Null)
            }
            Command::Wheel { target, dx, dy } => {
                let at = self.resolve(&target)?;
                native::wheel(w, (at.x, at.y), dx, dy)?;
                Ok(json!(at))
            }
            Command::Snap { path, mode } => {
                let path = PathBuf::from(path);
                match mode {
                    script::SnapMode::Webview => native::snapshot_webview(w, path),
                    script::SnapMode::Window => native::snapshot_window(w, path),
                }
            }
            Command::Window => native::window_info(w),
            Command::Resize { width, height } => native::resize(w, width, height),
            Command::Place { x, y } => native::place(w, x, y),
            Command::Float { on } => native::float(w, on),
            Command::Activate => native::activate(w),
            Command::Cursor => native::cursor(w),
            Command::Activity { on } => native::activity(w, on),
            Command::Minimize { on } => native::minimize(w, on),
            Command::RecordStart {
                path,
                fps,
                codec,
                retina,
                ffmpeg,
                max_s,
            } => {
                if self.recording.is_some() {
                    return Err("a recording is already running; send record_stop first".into());
                }
                let spec = capture::Spec {
                    path: PathBuf::from(path),
                    fps,
                    codec,
                    retina,
                    ffmpeg,
                    max: Duration::from_secs(max_s),
                };
                let (recording, info) = capture::start(w, spec)?;
                self.recording = Some(recording);
                Ok(info)
            }
            Command::RecordStop => self
                .recording
                .take()
                .ok_or_else(|| "no recording is running".to_owned())?
                .stop(),
            other => Err(format!("`{}` is not a native command", other.name())),
        }
    }
}

#[cfg(target_os = "macos")]
fn call_js<R: Runtime>(
    w: &WebviewWindow<R>,
    body: String,
    limit: Duration,
) -> Result<String, String> {
    native::call_js(w, body, limit)
}

#[cfg(not(target_os = "macos"))]
fn call_js<R: Runtime>(
    _w: &WebviewWindow<R>,
    _body: String,
    _limit: Duration,
) -> Result<String, String> {
    Err("JavaScript evaluation with results is only implemented on macOS".into())
}

/// Appends whatever was added to `path` since `offset` to `buf`.
fn read_new(path: &Path, offset: &mut u64, buf: &mut String) -> std::io::Result<()> {
    let mut f = File::open(path)?;
    let len = f.metadata()?.len();
    if len < *offset {
        // The script was truncated: start over.
        *offset = 0;
        buf.clear();
    }
    if len == *offset {
        return Ok(());
    }
    f.seek(SeekFrom::Start(*offset))?;
    let mut bytes = Vec::new();
    f.read_to_end(&mut bytes)?;
    *offset += bytes.len() as u64;
    buf.push_str(&String::from_utf8_lossy(&bytes));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dialog_answers_are_first_in_first_out() {
        assert_eq!(take_dialog_answer(), None);
        queue_dialog_answer(Some(PathBuf::from("/tmp/a.mp4")));
        queue_dialog_answer(None);
        assert_eq!(
            take_dialog_answer(),
            Some(Some(PathBuf::from("/tmp/a.mp4")))
        );
        assert_eq!(take_dialog_answer(), Some(None));
        assert_eq!(take_dialog_answer(), None);
    }

    #[test]
    fn follows_a_growing_and_truncated_script() {
        let dir = std::env::temp_dir().join(format!("ft-e2e-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("dir");
        let path = dir.join("script.jsonl");
        let (mut offset, mut buf) = (0_u64, String::new());
        assert!(
            read_new(&path, &mut offset, &mut buf).is_err(),
            "missing file"
        );
        std::fs::write(&path, "{\"cmd\":\"window\"}\n{\"cmd\":").expect("write");
        read_new(&path, &mut offset, &mut buf).expect("read");
        assert_eq!(
            script::take_complete_lines(&mut buf),
            vec!["{\"cmd\":\"window\"}"]
        );
        let mut f = OpenOptions::new().append(true).open(&path).expect("open");
        f.write_all(b"\"quit\"}\n").expect("append");
        read_new(&path, &mut offset, &mut buf).expect("read");
        assert_eq!(
            script::take_complete_lines(&mut buf),
            vec!["{\"cmd\":\"quit\"}"]
        );
        std::fs::write(&path, "{\"cmd\":\"activate\"}\n").expect("truncate");
        read_new(&path, &mut offset, &mut buf).expect("read");
        assert_eq!(
            script::take_complete_lines(&mut buf),
            vec!["{\"cmd\":\"activate\"}"]
        );
        std::fs::remove_dir_all(&dir).expect("cleanup");
    }
}
