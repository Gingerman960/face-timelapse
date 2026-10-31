//! `session.json` persistence (ARCHITECTURE.md §3): every mutation marks the
//! session dirty; a writer thread debounces 300 ms (but never delays a write
//! more than 2 s) and writes it atomically (exclusive temporary file, fsync,
//! rename; see [`save`]). A
//! corrupt or unreadable file is moved to `session.corrupt-{ts}.json` and a
//! fresh session starts (logged, not shown); if it cannot be moved, nothing
//! is saved this run rather than overwrite it. Older schema versions are
//! migrated in place (see [`migrate`]); unknown newer ones are set aside.

use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::time::{Duration, Instant};

use super::model::{PersistedSession, SESSION_VERSION};

/// Debounce window.
pub const DEBOUNCE: Duration = Duration::from_millis(300);
/// Longest a change waits for its write while changes keep coming.
pub const MAX_WAIT: Duration = Duration::from_secs(2);

/// When a pending write is due: [`DEBOUNCE`] after the latest change, but at
/// most [`MAX_WAIT`] after the first unsaved one.
#[must_use]
pub fn due(first_change: Instant, last_change: Instant) -> Instant {
    (last_change + DEBOUNCE).min(first_change + MAX_WAIT)
}

/// Loads the session; never fails (missing ⇒ default, corrupt or
/// unreadable ⇒ moved aside + default).
#[must_use]
pub fn load(file: &Path) -> PersistedSession {
    load_checked(file).0
}

/// [`load`], plus whether saving is safe: false when an unreadable file
/// could not be moved aside (saving would destroy it).
#[must_use]
pub fn load_checked(file: &Path) -> (PersistedSession, bool) {
    let bytes = match std::fs::read(file) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return (PersistedSession::default(), true);
        }
        Err(e) => {
            log::error!("cannot read {}: {e}; setting it aside", file.display());
            let moved = set_aside(file);
            if !moved {
                log::error!("the session will not be saved this run (it would overwrite it)");
            }
            return (PersistedSession::default(), moved);
        }
    };
    let parsed = serde_json::from_slice::<serde_json::Value>(&bytes)
        .map_err(|e| e.to_string())
        .and_then(migrate)
        .and_then(|v| serde_json::from_value::<PersistedSession>(v).map_err(|e| e.to_string()));
    match parsed {
        Ok(s) => (s, true),
        Err(e) => {
            log::warn!("session.json unusable ({e}); starting fresh");
            let moved = set_aside(file);
            (PersistedSession::default(), moved)
        }
    }
}

/// Brings a parsed `session.json` to [`SESSION_VERSION`].
///
/// v1 → v2: the cached reference analysis and the analyses of manual photos
/// were stored in the shell's private shapes (`[x, y, w, h]` arrays,
/// snake_case keys, `{"Faces": […]}`); v2 stores the engine's own types.
/// Values are converted losslessly, so no user decision is lost.
///
/// # Errors
/// An unknown (newer) version or a malformed v1 document.
pub fn migrate(mut v: serde_json::Value) -> Result<serde_json::Value, String> {
    let version = v
        .get("version")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(u64::from(SESSION_VERSION));
    match version {
        1 => {
            v1::upgrade(&mut v)?;
            v["version"] = SESSION_VERSION.into();
            Ok(v)
        }
        n if n == u64::from(SESSION_VERSION) => Ok(v),
        n => Err(format!("version {n} unsupported")),
    }
}

/// The v1 shapes and their conversion.
mod v1 {
    use serde_json::{Value, json};

    fn num(v: &Value) -> Result<f64, String> {
        v.as_f64()
            .ok_or_else(|| format!("expected a number, got {v}"))
    }

    fn pair(v: &Value) -> Result<(f64, f64), String> {
        match v.as_array().map(Vec::as_slice) {
            Some([a, b]) => Ok((num(a)?, num(b)?)),
            _ => Err(format!("expected [a, b], got {v}")),
        }
    }

    fn rect(v: &Value) -> Result<Value, String> {
        match v.as_array().map(Vec::as_slice) {
            Some([x, y, w, h]) => Ok(json!({
                "x": num(x)?, "y": num(y)?, "width": num(w)?, "height": num(h)?
            })),
            _ => Err(format!("expected [x, y, w, h], got {v}")),
        }
    }

    fn points(v: &Value) -> Result<Value, String> {
        v.as_array()
            .ok_or_else(|| format!("expected points, got {v}"))?
            .iter()
            .map(|p| pair(p).map(|(x, y)| json!({"x": x, "y": y})))
            .collect::<Result<Vec<_>, _>>()
            .map(Value::Array)
    }

    fn size(v: &Value) -> Result<Value, String> {
        let dim = |d: &Value| {
            d.as_u64()
                .ok_or_else(|| format!("expected a size, got {v}"))
        };
        match v.as_array().map(Vec::as_slice) {
            Some([w, h]) => Ok(json!({"width": dim(w)?, "height": dim(h)?})),
            _ => Err(format!("expected [w, h], got {v}")),
        }
    }

    fn image(v: &Value) -> Result<Value, String> {
        let face = match &v["face"] {
            Value::Null => Value::Null,
            f => json!({
                "bounds": rect(&f["bounds"])?,
                "anchors": points(&f["anchors"])?,
                "confidence": f["confidence"],
            }),
        };
        Ok(json!({
            "size": size(&v["size"])?,
            "face": face,
            "autoRotationDeg": v["auto_rotation_deg"],
        }))
    }

    fn detection(v: &Value) -> Result<Value, String> {
        if v.is_null() {
            return Ok(Value::Null);
        }
        Ok(json!({
            "anchors": points(&v["anchors"])?,
            "faceBox": rect(&v["face_box"])?,
            "confidence": v["confidence"],
            "embedding": v["embedding"],
        }))
    }

    fn failure_kind(kind: &Value) -> &'static str {
        match kind.as_str() {
            Some("unsupportedFormat") => "unsupportedFormat",
            Some("decodeFailed") => "decodeFailed",
            Some("io" | "notFound" | "permissionDenied" | "diskFull") => "io",
            _ => "internal",
        }
    }

    fn analysis(v: &Value) -> Result<Value, String> {
        let outcome = match &v["outcome"] {
            Value::String(s) if s == "NoFace" => json!("noFace"),
            Value::Object(o) if o.contains_key("Faces") => {
                let faces = o["Faces"]
                    .as_array()
                    .ok_or("expected faces")?
                    .iter()
                    .map(|f| {
                        Ok(json!({
                            "bounds": rect(&f["bounds"])?,
                            "landmarks": points(&f["landmarks"])?,
                            "score": f["score"],
                            "embedding": f["embedding"],
                        }))
                    })
                    .collect::<Result<Vec<_>, String>>()?;
                json!({"faces": {"faces": faces}})
            }
            Value::Object(o) if o.contains_key("Failed") => {
                json!({"failed": {"kind": failure_kind(&o["Failed"]), "message": ""}})
            }
            other => return Err(format!("unknown outcome {other}")),
        };
        Ok(json!({
            "orientedSize": size(&v["oriented_size"])?,
            "takenAt": v["taken_at"],
            "dateSource": v["date_source"],
            "outcome": outcome,
        }))
    }

    /// Converts every v1-shaped value of `session` in place.
    pub fn upgrade(session: &mut Value) -> Result<(), String> {
        if let Some(r) = session.get_mut("reference").filter(|r| !r.is_null()) {
            r["image"] = image(&r["image"])?;
            r["detection"] = detection(&r["detection"])?;
        }
        if let Some(folders) = session.get_mut("folders").and_then(Value::as_object_mut) {
            for decisions in folders.values_mut() {
                let Some(manual) = decisions
                    .get_mut("manualPhotos")
                    .and_then(Value::as_array_mut)
                else {
                    continue;
                };
                for m in manual {
                    m["analysis"] = analysis(&m["analysis"])?;
                }
            }
        }
        Ok(())
    }
}

/// Moves `file` to `session.corrupt-{ts}.json`; true if it is out of the way.
fn set_aside(file: &Path) -> bool {
    let ts = chrono::Local::now().format("%Y%m%d-%H%M%S%.3f");
    let target = file.with_file_name(format!("session.corrupt-{ts}.json"));
    match std::fs::rename(file, &target) {
        Ok(()) => true,
        Err(e) => {
            log::error!("could not move the session aside: {e}");
            false
        }
    }
}

/// Writes the session crash-safely with the engine's atomic write: an
/// exclusively created temporary file, fsync, rename, fsync of the folder
/// (so a power cut never leaves an empty file); the temporary file is removed
/// on any failure.
///
/// # Errors
/// Serialization or I/O errors.
pub fn save(file: &Path, session: &PersistedSession) -> std::io::Result<()> {
    let bytes = serde_json::to_vec_pretty(session).map_err(std::io::Error::other)?;
    face_engine::cache::write_atomic(file, &bytes).map_err(std::io::Error::other)
}

enum Msg {
    Dirty,
    Flush(Sender<()>),
}

/// Produces the current persisted state (or `None` when the app is gone).
pub type SnapshotFn = Box<dyn Fn() -> Option<PersistedSession> + Send>;

/// Debounced background writer.
pub struct Persister {
    tx: parking_lot::Mutex<Sender<Msg>>,
}

impl Persister {
    /// Starts the writer thread; with `enabled = false` (see
    /// [`load_checked`]) nothing is ever written.
    #[must_use]
    pub fn spawn(file: PathBuf, enabled: bool, snapshot: SnapshotFn) -> Self {
        let (tx, rx) = mpsc::channel();
        let spawned = std::thread::Builder::new()
            .name("ft-persist".into())
            .spawn(move || writer_loop(&file, enabled, &snapshot, &rx));
        if let Err(e) = spawned {
            log::error!("could not start the session writer: {e}");
        }
        Self {
            tx: parking_lot::Mutex::new(tx),
        }
    }

    /// Schedules a debounced write.
    pub fn mark_dirty(&self) {
        let _ = self.tx.lock().send(Msg::Dirty);
    }

    /// Writes now and waits (≤ 2 s) for completion.
    pub fn flush(&self) {
        let (ack_tx, ack_rx) = mpsc::channel();
        if self.tx.lock().send(Msg::Flush(ack_tx)).is_ok() {
            let _ = ack_rx.recv_timeout(Duration::from_secs(2));
        }
    }
}

fn writer_loop(file: &Path, enabled: bool, snapshot: &SnapshotFn, rx: &Receiver<Msg>) {
    let write = || {
        if !enabled {
            return;
        }
        if let Some(s) = snapshot()
            && let Err(e) = save(file, &s)
        {
            log::error!("could not save the session: {e}");
        }
    };
    while let Ok(msg) = rx.recv() {
        match msg {
            Msg::Flush(ack) => {
                write();
                let _ = ack.send(());
            }
            Msg::Dirty => {
                let first = Instant::now();
                let mut last = first;
                loop {
                    let wait = due(first, last).saturating_duration_since(Instant::now());
                    match rx.recv_timeout(wait) {
                        Ok(Msg::Dirty) => last = Instant::now(),
                        Ok(Msg::Flush(ack)) => {
                            write();
                            let _ = ack.send(());
                            break;
                        }
                        Err(RecvTimeoutError::Timeout) => {
                            write();
                            break;
                        }
                        Err(RecvTimeoutError::Disconnected) => {
                            write();
                            return;
                        }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn a_failed_save_leaves_no_temporary_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        // A folder where the file should be: the final rename fails.
        let file = dir.path().join("session.json");
        std::fs::create_dir_all(file.join("inner")).expect("mkdir");
        assert!(save(&file, &PersistedSession::default()).is_err());
        let names: Vec<String> = std::fs::read_dir(dir.path())
            .expect("dir")
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            names,
            vec!["session.json".to_owned()],
            "only the folder itself"
        );
    }

    #[test]
    fn floats_survive_a_save_and_load_bit_for_bit() {
        // serde_json's default parser reads these back one ULP off; values
        // computed in a session (reference anchors, a levelling angle) feed
        // the render fingerprint, so they must come back exactly.
        let dir = tempfile::tempdir().expect("tempdir");
        let file = dir.path().join("session.json");
        let mut s = PersistedSession::default();
        s.video.hold_first_secs = 9.358_281_489_029_741;
        s.look.strength = 0.212_918_907_267_134_58;
        save(&file, &s).expect("save");
        let back = load(&file);
        assert_eq!(
            back.video.hold_first_secs.to_bits(),
            s.video.hold_first_secs.to_bits()
        );
        assert_eq!(back.look.strength.to_bits(), s.look.strength.to_bits());
    }

    #[test]
    fn round_trip_and_corrupt_recovery() {
        let dir = tempfile::tempdir().expect("tempdir");
        let file = dir.path().join("session.json");
        assert_eq!(load(&file), PersistedSession::default());
        let s = PersistedSession {
            folder: Some("/photos".into()),
            outputs: vec!["/out".into()],
            ..PersistedSession::default()
        };
        save(&file, &s).expect("save");
        assert_eq!(load(&file), s);
        std::fs::write(&file, b"{not json").expect("corrupt");
        assert_eq!(load(&file), PersistedSession::default());
        assert!(!file.exists(), "corrupt file moved aside");
        let aside: Vec<_> = std::fs::read_dir(dir.path())
            .expect("dir")
            .flatten()
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("session.corrupt-")
            })
            .collect();
        assert_eq!(aside.len(), 1);
        std::fs::write(&file, br#"{"version": 99}"#).expect("future");
        assert_eq!(load(&file), PersistedSession::default());
    }

    /// A v1 file as the previous shell wrote it (reference + a manual photo).
    const V1: &str = r#"{
      "version": 1,
      "reference": {
        "path": "/r/ref.jpg", "rotationDeg": 2.0,
        "crop": {"x": 0.0, "y": 0.0, "width": 64.0, "height": 48.0}, "aspect": "free",
        "fileVersion": "abcd1234", "engine": "e",
        "image": {"size": [64, 48],
                  "face": {"bounds": [0.4, 0.35, 0.2, 0.3],
                           "anchors": [[0.45,0.45],[0.55,0.45],[0.5,0.5],[0.46,0.56],[0.54,0.56]],
                           "confidence": 0.97},
                  "auto_rotation_deg": 1.5},
        "detection": {"anchors": [[0.3,0.4],[0.7,0.4],[0.5,0.55],[0.35,0.7],[0.65,0.7]],
                      "face_box": [0.1, 0.2, 0.3, 0.4], "confidence": 0.96, "embedding": [1.0, 0.0]}
      },
      "folder": "/p",
      "folders": {"/p": {"reviews": {"0123456789abcdef": "confirmed"},
        "manualPhotos": [
          {"path": "/x/a.jpg", "dayKey": "2014-09-02", "size": 10, "mtimeNs": 5,
           "analysis": {"oriented_size": [40, 30], "taken_at": "2014-08-15T14:23:26",
             "date_source": "filename",
             "outcome": {"Faces": [{"bounds": [0.3,0.3,0.4,0.4],
               "landmarks": [[0.4,0.4],[0.6,0.4],[0.5,0.5],[0.42,0.6],[0.58,0.6]],
               "score": 0.95, "embedding": [1.0, 0.0]}]}}},
          {"path": "/x/b.jpg", "dayKey": "2014-09-03", "size": 1, "mtimeNs": 1,
           "analysis": {"oriented_size": [0, 0], "taken_at": "2014-08-15T00:00:00",
             "date_source": "fileTime", "outcome": "NoFace"}},
          {"path": "/x/c.jpg", "dayKey": "2014-09-04", "size": 1, "mtimeNs": 1,
           "analysis": {"oriented_size": [0, 0], "taken_at": "2014-08-15T00:00:00",
             "date_source": "exif", "outcome": {"Failed": "notFound"}}}
        ]}}
    }"#;

    #[test]
    fn v1_sessions_are_migrated_without_losing_decisions() {
        use face_engine::analysis::{FailureKind, Outcome};
        let dir = tempfile::tempdir().expect("tempdir");
        let file = dir.path().join("session.json");
        std::fs::write(&file, V1).expect("v1");
        let s = load(&file);
        assert_eq!(s.version, SESSION_VERSION);
        assert!(file.exists(), "a migrated file is not set aside");
        let r = s.reference.expect("reference");
        assert_eq!((r.image.size.width, r.image.size.height), (64, 48));
        assert_eq!(r.image.auto_rotation_deg, Some(1.5));
        let face = r.image.face.expect("face");
        assert_eq!((face.bounds.width, face.anchors[1].x), (0.2, 0.55));
        let det = r.detection.expect("detection");
        assert_eq!(
            (det.face_box.y, det.anchors[4].y, det.embedding.0.len()),
            (0.2, 0.7, 2)
        );
        let d = &s.folders["/p"];
        assert_eq!(d.reviews.len(), 1);
        let m = &d.manual_photos;
        assert_eq!(m.len(), 3);
        assert_eq!(m[0].analysis.faces().len(), 1);
        assert_eq!(m[0].analysis.faces()[0].landmarks[1].x, 0.6);
        assert_eq!(m[0].analysis.oriented_size.width, 40);
        assert_eq!(m[1].analysis.outcome, Outcome::NoFace);
        assert!(matches!(
            m[2].analysis.outcome,
            Outcome::Failed {
                kind: FailureKind::Io,
                ..
            }
        ));
        // Round trip in the new shape.
        save(
            &file,
            &PersistedSession {
                reference: None,
                ..load(&file)
            },
        )
        .expect("save");
        assert_eq!(load(&file).folders["/p"].manual_photos.len(), 3);
    }

    #[test]
    fn migration_rejects_malformed_v1_and_keeps_minimal_files() {
        let minimal = migrate(serde_json::json!({"version": 1, "folder": "/p"})).expect("min");
        assert_eq!(minimal["version"], SESSION_VERSION);
        let unversioned = migrate(serde_json::json!({"folder": "/p"})).expect("none");
        assert_eq!(unversioned["folder"], "/p");
        for bad in [
            serde_json::json!({"version": 1, "reference": {"image": {"size": [1]}}}),
            serde_json::json!({"version": 1, "reference": {"image": {"size": [1, 2], "face": {"bounds": [1]}}}}),
            serde_json::json!({"version": 1, "reference": {"image": {"size": [1, 2], "face": {"bounds": [0, 0, 1, 1], "anchors": [[0.5]]}}}}),
            serde_json::json!({"version": 1, "folders": {"/p": {"manualPhotos": [{"analysis": {"outcome": 7}}]}}}),
            serde_json::json!({"version": 1, "folders": {"/p": {"manualPhotos": [{"analysis": {"oriented_size": ["a", 1], "outcome": "NoFace"}}]}}}),
            serde_json::json!({"version": 1, "folders": {"/p": {"manualPhotos": [{"analysis": {"oriented_size": [1, 1], "outcome": {"Faces": 3}}}]}}}),
        ] {
            assert!(migrate(bad.clone()).is_err(), "{bad}");
        }
        let skip = migrate(serde_json::json!({"version": 1, "folders": {"/p": {"reviews": {}}}}));
        assert!(skip.is_ok(), "folders without manual photos");
        let dir = tempfile::tempdir().expect("tempdir");
        let file = dir.path().join("session.json");
        std::fs::write(
            &file,
            br#"{"version": 1, "reference": {"image": {"size": "x"}}}"#,
        )
        .expect("bad v1");
        assert_eq!(load(&file), PersistedSession::default());
        assert!(!file.exists(), "malformed file set aside");
    }

    #[test]
    fn debounce_waits_for_a_pause_but_never_longer_than_max_wait() {
        let t0 = std::time::Instant::now();
        assert_eq!(due(t0, t0), t0 + DEBOUNCE);
        let ms = Duration::from_millis;
        assert_eq!(due(t0, t0 + ms(100)), t0 + ms(100) + DEBOUNCE);
        // Rapid changes keep pushing the write back — up to MAX_WAIT.
        assert_eq!(due(t0, t0 + ms(1900)), t0 + MAX_WAIT);
        assert_eq!(due(t0, t0 + ms(5000)), t0 + MAX_WAIT);
    }

    #[test]
    fn writes_happen_on_flush_and_after_a_pause() {
        let dir = tempfile::tempdir().expect("tempdir");
        let file = dir.path().join("data/session.json");
        let writes = Arc::new(AtomicUsize::new(0));
        let w = Arc::clone(&writes);
        let p = Persister::spawn(
            file.clone(),
            true,
            Box::new(move || {
                w.fetch_add(1, Ordering::SeqCst);
                Some(PersistedSession::default())
            }),
        );
        for _ in 0..20 {
            p.mark_dirty();
        }
        p.flush();
        let after_flush = writes.load(Ordering::SeqCst);
        assert!(after_flush >= 1 && file.exists(), "flush wrote the marks");
        p.flush();
        assert!(
            writes.load(Ordering::SeqCst) > after_flush,
            "every flush writes"
        );
        // A lone change is written on its own once the debounce elapses.
        let before = writes.load(Ordering::SeqCst);
        p.mark_dirty();
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        while writes.load(Ordering::SeqCst) == before {
            assert!(
                std::time::Instant::now() < deadline,
                "debounced write never came"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[cfg(unix)]
    #[test]
    fn an_unreadable_session_is_set_aside_never_overwritten() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().expect("tempdir");
        let file = dir.path().join("session.json");
        std::fs::write(&file, br#"{"version": 2, "folder": "/precious"}"#).expect("write");
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o000)).expect("chmod");
        let (session, writable) = load_checked(&file);
        assert_eq!(session, PersistedSession::default());
        assert!(writable, "moved aside, so saving is safe");
        let aside = std::fs::read_dir(dir.path())
            .expect("dir")
            .flatten()
            .find(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("session.corrupt-")
            })
            .expect("set aside")
            .path();
        std::fs::set_permissions(&aside, std::fs::Permissions::from_mode(0o600)).expect("chmod");
        assert!(
            std::fs::read_to_string(&aside)
                .expect("read")
                .contains("/precious")
        );
    }

    #[cfg(unix)]
    #[test]
    fn an_unreadable_session_that_cannot_be_moved_disables_saving() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().expect("tempdir");
        let data = dir.path().join("data");
        std::fs::create_dir_all(&data).expect("mkdir");
        let file = data.join("session.json");
        std::fs::write(&file, br#"{"version": 2, "folder": "/precious"}"#).expect("write");
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o000)).expect("chmod");
        std::fs::set_permissions(&data, std::fs::Permissions::from_mode(0o500)).expect("chmod");
        let (_, writable) = load_checked(&file);
        assert!(!writable);
        // Saving would now succeed (and replace the file) if it were attempted.
        std::fs::set_permissions(&data, std::fs::Permissions::from_mode(0o700)).expect("chmod");
        let p = Persister::spawn(
            file.clone(),
            writable,
            Box::new(|| Some(PersistedSession::default())),
        );
        p.mark_dirty();
        p.flush();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).expect("chmod");
        assert!(
            std::fs::read_to_string(&file)
                .expect("read")
                .contains("/precious")
        );
    }
}
