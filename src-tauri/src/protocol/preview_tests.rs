//! The `preview` route (v1.7): Review candidates' aligned frames, rendered on
//! demand without touching the frame store.

use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::{Mutex, mpsc};
use std::time::Duration;

use tauri::http::{Response, header};

use super::{Request, serve_blocking};
use crate::ipc::{AspectPreset, PhotoDetail, PhotoQuery, PhotoSummary, Rect, Resolution};
use crate::testutil::TestCore;

const IMMUTABLE: &str = "public, max-age=31536000, immutable";

fn scanned() -> TestCore {
    let t = TestCore::new();
    t.setup();
    t.scan();
    // 64×48 reference, free crop ⇒ 960×720 frames.
    t.core.session.write().p.render.resolution = Resolution::P720;
    t
}

fn photo(t: &TestCore, name: &str) -> PhotoSummary {
    crate::commands::review::photos(&t.core, &PhotoQuery { statuses: None })
        .expect("photos")
        .into_iter()
        .find(|p| p.file_name.contains(name))
        .expect("photo")
}

fn detail(t: &TestCore, id: &str) -> PhotoDetail {
    crate::commands::review::photo(&t.core, id).expect("detail")
}

fn get(t: &TestCore, id: &str, query: &str) -> Response<Vec<u8>> {
    serve_blocking(&t.core, "GET", &format!("/preview/{id}"), Some(query))
}

fn cache_control(r: &Response<Vec<u8>>) -> &str {
    r.headers()
        .get(header::CACHE_CONTROL)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
}

fn dims(r: &Response<Vec<u8>>) -> (u32, u32) {
    let img = face_engine::decode::decode(
        r.body(),
        Path::new("body.jpg"),
        1,
        face_engine::decode::DecodeTarget::Full,
    )
    .expect("jpeg body")
    .image;
    (img.width(), img.height())
}

fn files_under(dir: &Path) -> usize {
    std::fs::read_dir(dir).map_or(0, |rd| {
        rd.flatten()
            .map(|e| {
                let p = e.path();
                if p.is_dir() { files_under(&p) } else { 1 }
            })
            .sum()
    })
}

fn renders(t: &TestCore) -> usize {
    t.engine.render_calls.load(Ordering::SeqCst)
}

#[test]
fn a_candidate_renders_without_a_master_or_the_frame_store() {
    let t = scanned();
    let p = photo(&t, "unsure");
    let v = detail(&t, &p.id).preview_version.expect("a face to align");
    let r = get(&t, &p.id, &format!("w=640&v={v}"));
    assert_eq!((r.status().as_u16(), cache_control(&r)), (200, IMMUTABLE));
    assert_eq!(dims(&r), (640, 480));
    let big = get(&t, &p.id, &format!("w=2000&v={v}"));
    assert_eq!(
        dims(&big),
        (960, 720),
        "1280 bucket, never above the frame size"
    );
    assert_eq!(dims(&get(&t, &p.id, "w=10")), (640, 480), "640 bucket");
    assert_eq!(renders(&t), 2, "one render per width");
    assert_eq!(
        get(&t, &p.id, &format!("w=640&v={v}")).body(),
        r.body(),
        "served from the preview cache"
    );
    assert_eq!(renders(&t), 2);
    let frames_root = face_engine::frames::root(&t.core.paths.cache_dir);
    assert_eq!(files_under(&frames_root), 0, "no master, no manifest");
    assert!(t.core.session.read().frames.manifest.get(&p.id).is_none());
    assert_eq!(files_under(&t.core.paths.preview_dir()), 2);
}

#[test]
fn the_version_follows_the_crop() {
    let t = scanned();
    let p = photo(&t, "IMG_20140815_100000");
    let before = detail(&t, &p.id).preview_version.expect("version");
    assert_eq!(
        cache_control(&get(&t, &p.id, &format!("w=640&v={before}"))),
        IMMUTABLE
    );
    let crop = Rect {
        x: 4.0,
        y: 2.0,
        width: 56.0,
        height: 42.0,
    };
    crate::commands::reference::set_crop(&t.core, crop, AspectPreset::Free).expect("crop");
    let after = detail(&t, &p.id).preview_version.expect("version");
    assert_ne!(after, before, "a new crop is a new preview");
    let stale = get(&t, &p.id, &format!("w=640&v={before}"));
    assert_eq!(
        (stale.status().as_u16(), cache_control(&stale)),
        (200, "no-store")
    );
    assert_eq!(
        cache_control(&get(&t, &p.id, &format!("w=640&v={after}"))),
        IMMUTABLE
    );
}

#[test]
fn no_face_no_reference_or_unknown_ids_are_404() {
    let t = scanned();
    let noface = photo(&t, "noface");
    assert_eq!(detail(&t, &noface.id).preview_version, None);
    assert_eq!(get(&t, &noface.id, "w=640").status(), 404);
    assert_eq!(get(&t, "ffffffffffffffff", "w=640").status(), 404);
    let p = photo(&t, "IMG_20140815_100000");
    assert_eq!(get(&t, &p.id, "").status(), 400, "w is required");
    assert_eq!(get(&t, &p.id, "w=abc").status(), 400);
    let faceless = t.write_reference("noface_ref.jpg");
    crate::commands::reference::set_photo(&t.core, &faceless.to_string_lossy()).expect("set");
    assert_eq!(detail(&t, &p.id).preview_version, None, "no reference face");
    assert_eq!(get(&t, &p.id, "w=640").status(), 404);
    assert_eq!(renders(&t), 0);
}

#[test]
fn previews_need_no_models() {
    let t = scanned().restart_without_models();
    let p = photo(&t, "IMG_20140815_100000");
    let v = detail(&t, &p.id).preview_version.expect("version");
    assert_eq!(get(&t, &p.id, &format!("w=640&v={v}")).status(), 200);
}

#[test]
fn concurrent_requests_for_one_preview_render_once() {
    let t = scanned();
    let p = photo(&t, "IMG_20140815_120000");
    let v = detail(&t, &p.id).preview_version.expect("version");
    t.engine.render_delay_ms.store(300, Ordering::SeqCst);
    let (tx, rx) = mpsc::channel();
    for i in 0..6 {
        let tx = Mutex::new(tx.clone());
        t.core.protocol.dispatch(
            Request {
                method: "GET".into(),
                path: format!("/preview/{}", p.id),
                query: Some(format!("w=1280&v={v}")),
                origin: None,
            },
            Box::new(move |r: Response<Vec<u8>>| {
                let _ = tx.lock().expect("tx").send((i, r.status().as_u16()));
            }),
        );
    }
    let mut got: Vec<_> = (0..6)
        .map(|_| rx.recv_timeout(Duration::from_secs(20)).expect("response"))
        .collect();
    got.sort_unstable();
    assert_eq!(got, (0..6).map(|i| (i, 200)).collect::<Vec<_>>());
    assert_eq!(renders(&t), 1, "one render for six requests");
}

/// Sets a file's modification time `secs` seconds into the past (access
/// time left alone: the bound must not depend on it).
fn age(path: &Path, secs: u64) {
    let then = std::time::SystemTime::now() - Duration::from_secs(secs);
    std::fs::File::options()
        .write(true)
        .open(path)
        .and_then(|f| f.set_modified(then))
        .expect("age");
}

fn modified(path: &Path) -> std::time::SystemTime {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .expect("mtime")
}

#[test]
fn the_preview_cache_stays_bounded_least_recently_used_first() {
    let dir = tempfile::tempdir().expect("tmp");
    let old = dir.path().join("a-000000000000-640.jpg");
    let new = dir.path().join("b-000000000000-640.jpg");
    std::fs::write(&old, vec![0u8; 600]).expect("write");
    std::fs::write(&new, vec![0u8; 600]).expect("write");
    age(&old, 3600);
    assert_eq!(
        super::preview::prune_dir(dir.path(), 2000, 1000),
        0,
        "under the bound"
    );
    assert_eq!(
        super::preview::prune_dir(dir.path(), 1000, 700),
        600,
        "the least recently used first"
    );
    assert!(!old.exists() && new.exists());
    assert_eq!(super::preview::prune_dir(&dir.path().join("none"), 1, 0), 0);
}

#[test]
fn an_in_flight_temp_file_survives_a_prune() {
    let dir = tempfile::tempdir().expect("tmp");
    // What `write_atomic_cache` writes before its rename.
    let temp = dir.path().join(".c-000000000000-640.jpg.4242-1.tmp");
    std::fs::write(&temp, vec![0u8; 5000]).expect("write");
    age(&temp, 7200);
    let done = dir.path().join("c-000000000000-640.jpg");
    std::fs::write(&done, vec![0u8; 600]).expect("write");
    assert_eq!(super::preview::prune_dir(dir.path(), 100, 0), 600);
    assert!(temp.exists(), "never counted, never deleted");
}

#[test]
fn a_hit_marks_the_preview_recently_used() {
    let t = scanned();
    let p = photo(&t, "IMG_20140815_100000");
    let v = detail(&t, &p.id).preview_version.expect("version");
    assert_eq!(get(&t, &p.id, &format!("w=640&v={v}")).status(), 200);
    let file = t.core.paths.preview_file(&p.id, &v, 640);
    age(&file, 3600);
    let before = modified(&file);
    assert_eq!(get(&t, &p.id, &format!("w=640&v={v}")).status(), 200);
    assert!(modified(&file) > before, "touched on the hit");
    assert_eq!(renders(&t), 1, "a hit, not a render");
}
