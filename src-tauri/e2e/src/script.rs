//! The harness script language (pure, platform-independent).
//!
//! A script is a JSON Lines file. Each line is one command, for example
//! `{"id":"s1","cmd":"click","target":{"sel":"button","text":"Scan library"}}`.
//! Blank lines and lines starting with `#` or `//` are ignored. The harness
//! appends one JSON result line per command to the output file.

use serde::{Deserialize, Serialize};

use crate::recording::RecordCodec;

/// Default time limit for `eval`/`wait`, in milliseconds.
pub const DEFAULT_TIMEOUT_MS: u64 = 10_000;
/// Default polling interval for `wait`, in milliseconds.
pub const DEFAULT_INTERVAL_MS: u64 = 50;
/// Default number of intermediate pointer moves of a `drag`.
pub const DEFAULT_DRAG_STEPS: u32 = 12;
/// Default frame rate of `record_start`.
pub const DEFAULT_RECORD_FPS: u32 = 60;
/// Default safety limit of a recording, in seconds.
pub const DEFAULT_RECORD_MAX_S: u64 = 120;

/// One script line: an optional id echoed in the result, plus the command.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Line {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(flatten)]
    pub cmd: Command,
}

/// What a gesture aims at: a CSS selector (optionally filtered by visible
/// text, aria-label or title, and the n-th match), or viewport coordinates in
/// CSS pixels. `fx`/`fy` pick the point inside the element (0..1, default the
/// centre) and `dx`/`dy` offset it.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Target {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sel: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub index: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub y: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fx: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fy: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dx: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dy: Option<f64>,
}

/// Keyboard modifiers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mod {
    Cmd,
    Shift,
    Alt,
    Ctrl,
}

/// Mouse buttons.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Button {
    #[default]
    Left,
    Right,
}

/// What `snap` captures.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SnapMode {
    /// The webview's own snapshot (`WKWebView takeSnapshot…`).
    #[default]
    Webview,
    /// The app's own window as the window server composes it (title bar,
    /// traffic lights, vibrancy), if the OS allows it without a permission.
    Window,
}

/// One harness command.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub enum Command {
    /// Runs `js` as the body of an async function in the page and returns
    /// its JSON-serialised result (`return …`; `await` allowed).
    Eval {
        js: String,
        #[serde(default = "default_timeout")]
        timeout_ms: u64,
    },
    /// Polls `js` (an async function body) until it returns something
    /// truthy, then returns that value; fails after `timeout_ms`.
    Wait {
        js: String,
        #[serde(default = "default_timeout")]
        timeout_ms: u64,
        #[serde(default = "default_interval")]
        interval_ms: u64,
    },
    /// Native mouse click(s) at a target.
    Click {
        target: Target,
        #[serde(default)]
        button: Button,
        #[serde(default = "one")]
        count: u32,
        #[serde(default)]
        mods: Vec<Mod>,
    },
    /// Native mouse move (hover) to a target.
    Hover { target: Target },
    /// Native press-and-drag from one target to another.
    Drag {
        from: Target,
        to: Target,
        #[serde(default = "default_steps")]
        steps: u32,
        /// Pause after pressing, before moving (lets drag sensors arm).
        #[serde(default)]
        hold_ms: u64,
        /// Pause between moves.
        #[serde(default = "default_step_ms")]
        step_ms: u64,
    },
    /// Native key press (`key` as in [`key_spec`]) with modifiers.
    Key {
        key: String,
        #[serde(default)]
        mods: Vec<Mod>,
        /// Holds the key down this long before releasing it.
        #[serde(default)]
        hold_ms: u64,
    },
    /// Types literal text, one native key press per character.
    Type { text: String },
    /// Native scroll-wheel event at a target, in pixels (positive `dy`
    /// scrolls the content down, like dragging two fingers up).
    Wheel {
        target: Target,
        #[serde(default)]
        dx: f64,
        #[serde(default)]
        dy: f64,
    },
    /// Writes a PNG snapshot.
    Snap {
        path: String,
        #[serde(default)]
        mode: SnapMode,
    },
    /// Records a timestamped label in the output (for timings).
    Mark { label: String },
    /// Sleeps on the harness thread.
    Sleep { ms: u64 },
    /// Queues the answer of the next native file dialog: a path (granted
    /// exactly like a dialog result) or `null` (the user cancelled).
    Dialog { path: Option<String> },
    /// Reports the native window, content and screen geometry.
    Window,
    /// Sets the window's content size in points (in process).
    Resize { width: f64, height: f64 },
    /// Moves the window's top-left corner to (`x`, `y`) points, measured
    /// from the main screen's top-left corner (in process).
    Place { x: f64, y: f64 },
    /// Keeps the window above other apps' windows without activating it
    /// (`on: false` restores the normal level), so WebKit never treats it
    /// as occluded while the harness drives it.
    Float { on: bool },
    /// Activates the app and makes the window key (only when a test needs
    /// the active-window look).
    Activate,
    /// Holds (`on: true`) or releases a user-initiated process activity, so
    /// App Nap cannot demote the app while its window is hidden.
    Activity { on: bool },
    /// Miniaturizes the window into the Dock (`on: true`) or restores it.
    Minimize { on: bool },
    /// Reports the app's current `NSCursor` (what WebKit last set): whether
    /// it is the arrow, and its image size (WebKit's `cursor: none` is a
    /// blank 1×1 image).
    Cursor,
    /// Starts recording the app's own window into a constant-frame-rate
    /// video (`ffmpeg` encodes it); keeps running while later commands
    /// execute, until `record_stop`, `quit` or `max_s`.
    RecordStart {
        path: String,
        #[serde(default = "default_record_fps")]
        fps: u32,
        #[serde(default)]
        codec: RecordCodec,
        /// Backing-store pixels (2× on Retina) instead of points.
        #[serde(default = "yes")]
        retina: bool,
        /// The `ffmpeg` executable (default: the one on `PATH`).
        #[serde(default = "default_ffmpeg")]
        ffmpeg: String,
        /// Stops by itself after this many seconds.
        #[serde(default = "default_record_max_s")]
        max_s: u64,
    },
    /// Stops the recording and reports its frame statistics.
    RecordStop,
    /// Quits the app through Tauri's normal exit path.
    Quit,
}

fn default_timeout() -> u64 {
    DEFAULT_TIMEOUT_MS
}
fn default_interval() -> u64 {
    DEFAULT_INTERVAL_MS
}
fn default_steps() -> u32 {
    DEFAULT_DRAG_STEPS
}
fn default_step_ms() -> u64 {
    16
}
fn one() -> u32 {
    1
}
fn yes() -> bool {
    true
}
fn default_record_fps() -> u32 {
    DEFAULT_RECORD_FPS
}
fn default_record_max_s() -> u64 {
    DEFAULT_RECORD_MAX_S
}
fn default_ffmpeg() -> String {
    "ffmpeg".to_owned()
}

impl Command {
    /// The command's name as written in scripts.
    #[must_use]
    pub fn name(&self) -> &'static str {
        match self {
            Self::Eval { .. } => "eval",
            Self::Wait { .. } => "wait",
            Self::Click { .. } => "click",
            Self::Hover { .. } => "hover",
            Self::Drag { .. } => "drag",
            Self::Key { .. } => "key",
            Self::Type { .. } => "type",
            Self::Wheel { .. } => "wheel",
            Self::Snap { .. } => "snap",
            Self::Mark { .. } => "mark",
            Self::Sleep { .. } => "sleep",
            Self::Dialog { .. } => "dialog",
            Self::Window => "window",
            Self::Resize { .. } => "resize",
            Self::Place { .. } => "place",
            Self::Float { .. } => "float",
            Self::Activate => "activate",
            Self::Cursor => "cursor",
            Self::Activity { .. } => "activity",
            Self::Minimize { .. } => "minimize",
            Self::RecordStart { .. } => "record_start",
            Self::RecordStop => "record_stop",
            Self::Quit => "quit",
        }
    }
}

/// Parses one script line; `Ok(None)` for blank lines and comments.
///
/// # Errors
/// A message naming the problem when the line is not a valid command.
pub fn parse_line(line: &str) -> Result<Option<Line>, String> {
    let t = line.trim();
    if t.is_empty() || t.starts_with('#') || t.starts_with("//") {
        return Ok(None);
    }
    serde_json::from_str::<Line>(t)
        .map(Some)
        .map_err(|e| format!("bad command line: {e}"))
}

/// Splits complete lines off a buffer that grows as the script file is
/// appended to; an unterminated last line stays in the buffer.
pub fn take_complete_lines(buf: &mut String) -> Vec<String> {
    let Some(end) = buf.rfind('\n') else {
        return Vec::new();
    };
    let rest = buf.split_off(end + 1);
    let done = std::mem::replace(buf, rest);
    done.lines().map(str::to_owned).collect()
}

/// A native key: macOS virtual key code, the characters it produces with
/// the given modifiers, and the characters ignoring modifiers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeySpec {
    pub code: u16,
    pub chars: String,
    pub chars_ignoring_mods: String,
}

/// macOS virtual key codes for printable keys (ANSI layout).
const KEYCODES: &[(char, u16)] = &[
    ('a', 0),
    ('s', 1),
    ('d', 2),
    ('f', 3),
    ('h', 4),
    ('g', 5),
    ('z', 6),
    ('x', 7),
    ('c', 8),
    ('v', 9),
    ('b', 11),
    ('q', 12),
    ('w', 13),
    ('e', 14),
    ('r', 15),
    ('y', 16),
    ('t', 17),
    ('1', 18),
    ('2', 19),
    ('3', 20),
    ('4', 21),
    ('6', 22),
    ('5', 23),
    ('=', 24),
    ('9', 25),
    ('7', 26),
    ('-', 27),
    ('8', 28),
    ('0', 29),
    (']', 30),
    ('o', 31),
    ('u', 32),
    ('[', 33),
    ('i', 34),
    ('p', 35),
    ('l', 37),
    ('j', 38),
    ('\'', 39),
    ('k', 40),
    (';', 41),
    ('\\', 42),
    (',', 43),
    ('/', 44),
    ('n', 45),
    ('m', 46),
    ('.', 47),
    (' ', 49),
    ('`', 50),
];

/// Shifted characters and the key that produces them.
const SHIFTED: &[(char, char)] = &[
    ('!', '1'),
    ('@', '2'),
    ('#', '3'),
    ('$', '4'),
    ('%', '5'),
    ('^', '6'),
    ('&', '7'),
    ('*', '8'),
    ('(', '9'),
    (')', '0'),
    ('_', '-'),
    ('+', '='),
    ('{', '['),
    ('}', ']'),
    ('|', '\\'),
    (':', ';'),
    ('"', '\''),
    ('<', ','),
    ('>', '.'),
    ('?', '/'),
    ('~', '`'),
];

/// Named keys: (name, code, the character AppKit reports).
const NAMED: &[(&str, u16, char)] = &[
    ("Enter", 36, '\r'),
    ("Return", 36, '\r'),
    ("Tab", 48, '\t'),
    ("Space", 49, ' '),
    ("Backspace", 51, '\u{7f}'),
    ("Delete", 117, '\u{f728}'),
    ("Escape", 53, '\u{1b}'),
    ("ArrowLeft", 123, '\u{f702}'),
    ("ArrowRight", 124, '\u{f703}'),
    ("ArrowDown", 125, '\u{f701}'),
    ("ArrowUp", 126, '\u{f700}'),
    ("Home", 115, '\u{f729}'),
    ("End", 119, '\u{f72b}'),
    ("PageUp", 116, '\u{f72c}'),
    ("PageDown", 121, '\u{f72d}'),
];

/// Resolves a key name (`"a"`, `"A"`, `"?"`, `"Enter"`, `"ArrowLeft"`…)
/// with modifiers into what a real keyboard would send. Returns the key
/// spec and whether Shift is implied by the character (`"A"`, `"?"`).
///
/// # Errors
/// Unknown key names.
pub fn key_spec(key: &str, mods: &[Mod]) -> Result<(KeySpec, bool), String> {
    if let Some(&(_, code, ch)) = NAMED.iter().find(|(n, _, _)| *n == key) {
        let s = ch.to_string();
        return Ok((
            KeySpec {
                code,
                chars: s.clone(),
                chars_ignoring_mods: s,
            },
            false,
        ));
    }
    let mut it = key.chars();
    let (Some(c), None) = (it.next(), it.next()) else {
        return Err(format!("unknown key {key:?}"));
    };
    let (base, implied_shift) = if c.is_ascii_uppercase() {
        (c.to_ascii_lowercase(), true)
    } else if let Some(&(_, b)) = SHIFTED.iter().find(|(s, _)| *s == c) {
        (b, true)
    } else {
        (c, false)
    };
    let &(_, code) = KEYCODES
        .iter()
        .find(|(k, _)| *k == base)
        .ok_or_else(|| format!("unknown key {key:?}"))?;
    let shift = implied_shift || mods.contains(&Mod::Shift);
    let shown = if shift { shifted(base) } else { base };
    // Control turns letters into control characters, as AppKit reports them.
    let chars = if mods.contains(&Mod::Ctrl) && base.is_ascii_lowercase() {
        char::from(base as u8 - b'a' + 1).to_string()
    } else {
        shown.to_string()
    };
    Ok((
        KeySpec {
            code,
            chars,
            chars_ignoring_mods: shown.to_string(),
        },
        implied_shift,
    ))
}

fn shifted(base: char) -> char {
    if base.is_ascii_lowercase() {
        return base.to_ascii_uppercase();
    }
    SHIFTED
        .iter()
        .find(|(_, b)| *b == base)
        .map_or(base, |(s, _)| *s)
}

/// Wraps an async function body so its result comes back as a JSON string
/// (`undefined` ⇒ `null`).
#[must_use]
pub fn eval_body(js: &str) -> String {
    format!(
        "const __ft_v = await (async () => {{\n{js}\n}})();\n\
         return JSON.stringify(__ft_v === undefined ? null : __ft_v);"
    )
}

/// An async function body that polls `js` until it is truthy or the time
/// limit passes (then it throws).
#[must_use]
pub fn wait_body(js: &str, timeout_ms: u64, interval_ms: u64) -> String {
    format!(
        "const __ft_end = Date.now() + {timeout_ms};\n\
         let __ft_last = null;\n\
         for (;;) {{\n\
           let __ft_v;\n\
           try {{ __ft_v = await (async () => {{\n{js}\n}})(); }} catch (e) {{ __ft_last = String(e); __ft_v = undefined; }}\n\
           if (__ft_v) return JSON.stringify(__ft_v === true ? true : __ft_v);\n\
           if (Date.now() > __ft_end) throw new Error('wait timed out after {timeout_ms} ms' + (__ft_last ? ' (last error: ' + __ft_last + ')' : ''));\n\
           await new Promise((r) => setTimeout(r, {interval_ms}));\n\
         }}"
    )
}

/// An async function body that resolves a [`Target`] to viewport
/// coordinates (scrolling the element into view first) and reports what is
/// actually under that point.
///
/// # Errors
/// If the target cannot be serialised (never for valid targets).
pub fn target_body(target: &Target) -> Result<String, String> {
    let t = serde_json::to_string(target).map_err(|e| e.to_string())?;
    Ok(format!(
        "const t = {t};\n{RESOLVE_JS}\nreturn JSON.stringify(__ft_resolve(t));"
    ))
}

const RESOLVE_JS: &str = r#"function __ft_resolve(t) {
  const label = (e) => ((e.innerText || e.textContent || '') + ' ' + (e.getAttribute('aria-label') || '') + ' ' + (e.getAttribute('title') || '')).toLowerCase();
  let el = null, x, y;
  if (t.sel) {
    const all = [...document.querySelectorAll(t.sel)];
    const shown = all.filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
    const hits = t.text == null ? shown : shown.filter((e) => label(e).includes(String(t.text).toLowerCase()));
    el = hits[t.index || 0] || null;
    if (!el) throw new Error('no element for ' + t.sel + (t.text != null ? ' with text "' + t.text + '"' : '') + ' (' + all.length + ' match the selector, ' + hits.length + ' after filters)');
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const r = el.getBoundingClientRect();
    x = r.left + (t.fx ?? 0.5) * r.width + (t.dx || 0);
    y = r.top + (t.fy ?? 0.5) * r.height + (t.dy || 0);
  } else {
    x = (t.x ?? 0) + (t.dx || 0);
    y = (t.y ?? 0) + (t.dy || 0);
  }
  const describe = (e) => e ? e.tagName.toLowerCase() + (typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\s+/).join('.') : '') + (e.getAttribute && e.getAttribute('aria-label') ? '[' + e.getAttribute('aria-label') + ']' : '') : null;
  const at = document.elementFromPoint(x, y);
  return { x, y, el: describe(el), at: describe(at), hit: el ? (at === el || el.contains(at)) : null, vw: window.innerWidth, vh: window.innerHeight };
}"#;

/// Where a resolved target is, as reported by [`target_body`].
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct Resolved {
    pub x: f64,
    pub y: f64,
    #[serde(default)]
    pub el: Option<String>,
    #[serde(default)]
    pub at: Option<String>,
    #[serde(default)]
    pub hit: Option<bool>,
}

/// Linear points of a drag, excluding the start, including the end.
#[must_use]
pub fn drag_path(from: (f64, f64), to: (f64, f64), steps: u32) -> Vec<(f64, f64)> {
    let n = steps.max(1);
    (1..=n)
        .map(|i| {
            let t = f64::from(i) / f64::from(n);
            (from.0 + (to.0 - from.0) * t, from.1 + (to.1 - from.1) * t)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_commands_with_defaults() {
        let l = parse_line(r#"{"id":"a","cmd":"eval","js":"return 1"}"#)
            .expect("ok")
            .expect("some");
        assert_eq!(l.id.as_deref(), Some("a"));
        assert_eq!(
            l.cmd,
            Command::Eval {
                js: "return 1".into(),
                timeout_ms: DEFAULT_TIMEOUT_MS
            }
        );
        let l = parse_line(r#"{"cmd":"click","target":{"sel":"button","text":"Scan"}}"#)
            .expect("ok")
            .expect("some");
        assert_eq!(l.id, None);
        let Command::Click {
            target,
            button,
            count,
            mods,
        } = l.cmd
        else {
            panic!("click expected");
        };
        assert_eq!(target.sel.as_deref(), Some("button"));
        assert_eq!(target.text.as_deref(), Some("Scan"));
        assert_eq!((button, count, mods.len()), (Button::Left, 1, 0));
        let l = parse_line(r#"{"cmd":"key","key":"1","mods":["cmd"]}"#)
            .expect("ok")
            .expect("some");
        assert_eq!(l.cmd.name(), "key");
        let l = parse_line(r#"{"cmd":"dialog","path":null}"#)
            .expect("ok")
            .expect("some");
        assert_eq!(l.cmd, Command::Dialog { path: None });
        for (src, name) in [
            (r#"{"cmd":"window"}"#, "window"),
            (r#"{"cmd":"quit"}"#, "quit"),
            (r#"{"cmd":"activate"}"#, "activate"),
            (r#"{"cmd":"cursor"}"#, "cursor"),
            (r#"{"cmd":"activity","on":true}"#, "activity"),
            (r#"{"cmd":"minimize","on":true}"#, "minimize"),
            (r#"{"cmd":"float","on":true}"#, "float"),
            (r#"{"cmd":"resize","width":960,"height":640}"#, "resize"),
            (r#"{"cmd":"place","x":40,"y":60}"#, "place"),
            (
                r#"{"cmd":"snap","path":"/tmp/x.png","mode":"window"}"#,
                "snap",
            ),
            (r#"{"cmd":"mark","label":"scan start"}"#, "mark"),
            (
                r#"{"cmd":"record_start","path":"/tmp/r.mov"}"#,
                "record_start",
            ),
            (r#"{"cmd":"record_stop"}"#, "record_stop"),
            (r#"{"cmd":"sleep","ms":5}"#, "sleep"),
            (r#"{"cmd":"hover","target":{"x":1,"y":2}}"#, "hover"),
            (r#"{"cmd":"type","text":"2014"}"#, "type"),
            (
                r#"{"cmd":"wheel","target":{"x":1,"y":2},"dy":120}"#,
                "wheel",
            ),
            (
                r#"{"cmd":"wait","js":"return true","timeout_ms":5}"#,
                "wait",
            ),
            (
                r#"{"cmd":"drag","from":{"x":1,"y":2},"to":{"sel":"a"},"hold_ms":200}"#,
                "drag",
            ),
        ] {
            let l = parse_line(src).expect(src).expect(src);
            assert_eq!(l.cmd.name(), name, "{src}");
        }
    }

    #[test]
    fn parses_recordings_with_defaults() {
        let l = parse_line(r#"{"cmd":"record_start","path":"/tmp/r.mov"}"#)
            .expect("ok")
            .expect("some");
        assert_eq!(
            l.cmd,
            Command::RecordStart {
                path: "/tmp/r.mov".into(),
                fps: DEFAULT_RECORD_FPS,
                codec: RecordCodec::Prores4444,
                retina: true,
                ffmpeg: "ffmpeg".into(),
                max_s: DEFAULT_RECORD_MAX_S,
            }
        );
        let l = parse_line(
            r#"{"cmd":"record_start","path":"a.mp4","fps":30,"codec":"h264","retina":false,"ffmpeg":"/opt/ff","max_s":5}"#,
        )
        .expect("ok")
        .expect("some");
        let Command::RecordStart {
            fps,
            codec,
            retina,
            ffmpeg,
            max_s,
            ..
        } = l.cmd
        else {
            panic!("record_start expected");
        };
        assert_eq!(
            (fps, codec, retina, ffmpeg.as_str(), max_s),
            (30, RecordCodec::H264, false, "/opt/ff", 5)
        );
        let l = parse_line(r#"{"cmd":"record_start","path":"a.bgra","codec":"raw"}"#)
            .expect("ok")
            .expect("some");
        assert!(matches!(
            l.cmd,
            Command::RecordStart {
                codec: RecordCodec::Raw,
                ..
            }
        ));
        assert!(parse_line(r#"{"cmd":"record_start","path":"a","codec":"gif"}"#).is_err());
        assert!(parse_line(r#"{"cmd":"record_start"}"#).is_err());
    }

    #[test]
    fn skips_blank_and_comment_lines_and_reports_errors() {
        assert_eq!(parse_line("   ").expect("ok"), None);
        assert_eq!(parse_line("# note").expect("ok"), None);
        assert_eq!(parse_line("// note").expect("ok"), None);
        assert!(parse_line(r#"{"cmd":"fly"}"#).is_err());
        assert!(parse_line(r#"{"cmd":"eval"}"#).is_err());
        assert!(parse_line("not json").is_err());
    }

    #[test]
    fn keeps_unterminated_lines_for_later() {
        let mut buf = String::from("a\nb\nc");
        assert_eq!(take_complete_lines(&mut buf), vec!["a", "b"]);
        assert_eq!(buf, "c");
        buf.push_str("d\n");
        assert_eq!(take_complete_lines(&mut buf), vec!["cd"]);
        assert!(buf.is_empty());
        assert!(take_complete_lines(&mut buf).is_empty());
    }

    #[test]
    fn maps_keys_like_a_keyboard() {
        let (k, implied) = key_spec("a", &[]).expect("a");
        assert_eq!((k.code, k.chars.as_str(), implied), (0, "a", false));
        let (k, implied) = key_spec("A", &[]).expect("A");
        assert_eq!((k.code, k.chars.as_str(), implied), (0, "A", true));
        let (k, _) = key_spec("a", &[Mod::Shift]).expect("shift a");
        assert_eq!(k.chars, "A");
        let (k, implied) = key_spec("?", &[]).expect("?");
        assert_eq!((k.code, k.chars.as_str(), implied), (44, "?", true));
        let (k, _) = key_spec("Enter", &[Mod::Cmd]).expect("enter");
        assert_eq!((k.code, k.chars.as_str()), (36, "\r"));
        let (k, _) = key_spec("ArrowLeft", &[]).expect("left");
        assert_eq!((k.code, k.chars.as_str()), (123, "\u{f702}"));
        let (k, _) = key_spec("s", &[Mod::Ctrl, Mod::Cmd]).expect("ctrl s");
        assert_eq!(
            (k.chars.as_str(), k.chars_ignoring_mods.as_str()),
            ("\u{13}", "s")
        );
        let (k, _) = key_spec("1", &[Mod::Cmd]).expect("cmd 1");
        assert_eq!((k.code, k.chars.as_str()), (18, "1"));
        let (k, _) = key_spec("[", &[]).expect("[");
        assert_eq!(k.code, 33);
        let (k, _) = key_spec("Space", &[]).expect("space");
        assert_eq!((k.code, k.chars.as_str()), (49, " "));
        assert!(key_spec("F13", &[]).is_err());
        assert!(key_spec("é", &[]).is_err());
    }

    #[test]
    fn builds_js_bodies() {
        let e = eval_body("return 1 + 1");
        assert!(e.contains("return 1 + 1"));
        assert!(e.contains("JSON.stringify"));
        let w = wait_body("return document.body", 1500, 25);
        assert!(w.contains("Date.now() + 1500"));
        assert!(w.contains("setTimeout(r, 25)"));
        assert!(w.contains("wait timed out after 1500 ms"));
        let t = target_body(&Target {
            sel: Some("button".into()),
            text: Some("Scan \"library\"".into()),
            ..Target::default()
        })
        .expect("target");
        assert!(t.starts_with("const t = {\"sel\":\"button\",\"text\":\"Scan \\\"library\\\"\"}"));
        assert!(t.contains("__ft_resolve(t)"));
    }

    #[test]
    fn resolved_targets_parse() {
        let r: Resolved = serde_json::from_str(
            r#"{"x":10.5,"y":20,"el":"button","at":"span","hit":true,"vw":1,"vh":2}"#,
        )
        .expect("resolved");
        assert_eq!((r.x, r.y, r.hit), (10.5, 20.0, Some(true)));
    }

    #[test]
    fn drags_in_even_steps() {
        let p = drag_path((0.0, 0.0), (10.0, 20.0), 4);
        assert_eq!(p, vec![(2.5, 5.0), (5.0, 10.0), (7.5, 15.0), (10.0, 20.0)]);
        assert_eq!(drag_path((1.0, 1.0), (2.0, 2.0), 0), vec![(2.0, 2.0)]);
    }
}
