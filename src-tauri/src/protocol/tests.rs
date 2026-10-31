//! `ftimg` routing, validation, headers, caching and coalescing.

use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, Weak, mpsc};
use std::time::Duration;

use super::{Plan, ProtocolRuntime, Responder, pool_threads, serve_blocking};
use crate::ipc::{LookSettings, NormalizeMode, PhotoQuery, PhotoSummary};
use crate::testutil::TestCore;
use tauri::http::{Response, header};

fn scanned() -> TestCore {
    let t = TestCore::new();
    t.setup();
    t.scan();
    t
}

fn confirmed(t: &TestCore) -> PhotoSummary {
    crate::commands::review::photos(
        &t.core,
        &PhotoQuery {
            statuses: Some(vec![crate::ipc::MatchStatus::Confirmed]),
        },
    )
    .expect("photos")
    .remove(0)
}

fn get(t: &TestCore, path: &str, query: &str) -> Response<Vec<u8>> {
    serve_blocking(&t.core, "GET", path, Some(query))
}

fn h(r: &Response<Vec<u8>>, name: header::HeaderName) -> &str {
    r.headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
}

fn dims(r: &Response<Vec<u8>>) -> (u32, u32) {
    let img = face_engine::decode::decode(
        r.body(),
        std::path::Path::new("body.jpg"),
        1,
        face_engine::decode::DecodeTarget::Full,
    )
    .expect("jpeg body")
    .image;
    (img.width(), img.height())
}

#[test]
fn thumbs_have_headers_and_version_caching() {
    let t = scanned();
    let p = confirmed(&t);
    let r = get(
        &t,
        &format!("/thumb/{}", p.id),
        &format!("w=320&v={}", p.version),
    );
    assert_eq!(r.status(), 200);
    assert_eq!(h(&r, header::CONTENT_TYPE), "image/jpeg");
    assert_eq!(
        h(&r, header::ACCESS_CONTROL_ALLOW_ORIGIN),
        "",
        "no wildcard CORS"
    );
    assert_eq!(h(&r, header::X_CONTENT_TYPE_OPTIONS), "nosniff");
    assert_eq!(
        h(&r, header::CACHE_CONTROL),
        "public, max-age=31536000, immutable"
    );
    let stale = get(&t, &format!("/thumb/{}", p.id), "w=320&v=00000000");
    assert_eq!(
        (stale.status().as_u16(), h(&stale, header::CACHE_CONTROL)),
        (200, "no-store")
    );
    let unversioned = get(&t, &format!("/thumb/{}", p.id), "w=320");
    assert_eq!(h(&unversioned, header::CACHE_CONTROL), "no-store");
    // 160 is derived from the scan's 320 thumb; 2048 never upscales the 48×36 source.
    assert_eq!(
        dims(&get(&t, &format!("/thumb/{}", p.id), "w=100")),
        (48, 36)
    );
    assert_eq!(
        dims(&get(&t, &format!("/thumb/{}", p.id), "w=5000")),
        (48, 36)
    );
    assert!(
        face_engine::thumbs::path(&t.core.paths.cache_dir, &p.id, &p.version, 2048).is_file(),
        "miss written to the disk cache"
    );
}

#[test]
fn hits_are_served_from_disk() {
    let t = scanned();
    let p = confirmed(&t);
    let first = get(&t, &format!("/thumb/{}", p.id), "w=640");
    assert_eq!(first.status(), 200);
    std::fs::remove_file(t.photos().join(&p.rel_path)).expect("rm source");
    let second = get(&t, &format!("/thumb/{}", p.id), "w=640");
    assert_eq!(
        (second.status().as_u16(), second.body()),
        (200, first.body())
    );
    let gone = get(&t, &format!("/thumb/{}", p.id), "w=1280");
    assert_eq!(gone.status(), 404, "source vanished");
    std::fs::write(t.photos().join(&p.rel_path), b"garbage").expect("corrupt");
    let broken = get(&t, &format!("/thumb/{}", p.id), "w=1280");
    assert_eq!(broken.status(), 500, "decode failure");
    assert!(h(&broken, header::CONTENT_TYPE).starts_with("text/plain"));
}

#[test]
fn rejects_unknown_ids_bad_widths_methods_and_traversal() {
    let t = scanned();
    let p = confirmed(&t);
    assert_eq!(
        get(&t, "/thumb/ffffffffffffffff", "w=320").status(),
        404,
        "well-formed but unknown"
    );
    assert_eq!(get(&t, "/thumb/../../etc/passwd", "w=320").status(), 404);
    assert_eq!(
        get(&t, &format!("/thumb/{}/..", p.id), "w=320").status(),
        404
    );
    assert_eq!(get(&t, &format!("/thumb/{}", p.id), "w=big").status(), 400);
    assert_eq!(
        serve_blocking(&t.core, "POST", &format!("/thumb/{}", p.id), Some("w=320")).status(),
        405
    );
    assert_eq!(
        get(&t, &format!("/aligned/{}", p.id), "w=320").status(),
        404,
        "no frame yet"
    );
}

#[test]
fn a_cache_file_cut_short_is_rendered_again() {
    let t = scanned();
    let p = confirmed(&t);
    let (route, query) = (format!("/thumb/{}", p.id), format!("w=640&v={}", p.version));
    assert_eq!(get(&t, &route, &query).status(), 200);
    let file = face_engine::thumbs::path(&t.core.paths.cache_dir, &p.id, &p.version, 640);
    let whole = std::fs::read(&file).expect("cached");
    // Cache files are not fsynced: a power loss may cut one short.
    std::fs::write(&file, &whole[..whole.len() / 2]).expect("cut");
    let again = get(&t, &route, &query);
    assert_eq!(again.status(), 200);
    assert_eq!(again.body(), &whole, "rendered again, not the torn file");
    assert_eq!(std::fs::read(&file).expect("rewritten"), whole);
}

#[test]
fn a_master_cut_short_is_never_served_rendered_over_or_listed() {
    let t = scanned();
    t.core.session.write().p.render.resolution = crate::ipc::Resolution::P720;
    t.align();
    let f = crate::commands::frames::view(&t.core).frames[0].clone();
    let master = {
        let s = t.core.session.read();
        let e = s.library.get(&f.photo_id).expect("photo");
        let key = crate::session::frames::frame_key(
            &s.frames.fingerprint,
            &e.version,
            &crate::session::derive::adjust_of(&s, &f.photo_id),
        );
        s.frames
            .store()
            .expect("store")
            .master_path(&f.photo_id, &key)
    };
    let whole = std::fs::read(&master).expect("master");
    let route = format!("/aligned/{}", f.photo_id);
    for torn in [whole[..whole.len() / 2].to_vec(), Vec::new()] {
        std::fs::write(&master, &torn).expect("tear");
        let full = get(&t, &route, &format!("v={}", f.version));
        assert_eq!(full.status(), 404, "{} bytes", torn.len());
        assert_eq!(
            std::fs::read(&master).expect("kept"),
            torn,
            "never written over"
        );
        // A preview not rendered yet cannot be made from it either.
        assert_eq!(
            get(&t, &route, &format!("w=1280&v={}", f.version)).status(),
            404
        );
    }
    // After a restart the frame counts as not aligned, so align renders it again.
    let t = t.restart();
    let listed = crate::commands::frames::view(&t.core).frames;
    assert!(listed.iter().all(|x| x.photo_id != f.photo_id), "dropped");
    t.align();
    assert!(
        face_engine::cache::file_is_whole_jpeg(&master),
        "rendered again"
    );
}

#[test]
fn aligned_and_reference_routes() {
    let t = scanned();
    t.core.session.write().p.render.resolution = crate::ipc::Resolution::P720;
    t.align();
    let view = crate::commands::frames::view(&t.core);
    let f = &view.frames[0];
    let r = get(
        &t,
        &format!("/aligned/{}", f.photo_id),
        &format!("w=320&v={}", f.version),
    );
    assert_eq!(
        (r.status().as_u16(), h(&r, header::CACHE_CONTROL)),
        (200, "public, max-age=31536000, immutable")
    );
    assert_eq!(dims(&r), (320, 240));
    assert_eq!(
        dims(&get(&t, &format!("/aligned/{}", f.photo_id), "w=100")),
        (160, 120)
    );
    assert_eq!(
        dims(&get(&t, &format!("/aligned/{}", f.photo_id), "")),
        (960, 720),
        "no w ⇒ master"
    );
    crate::commands::frames::look(
        &t.core,
        LookSettings {
            normalize: NormalizeMode::ExposureAndColor,
            strength: 1.0,
        },
    )
    .expect("look");
    let looked = get(
        &t,
        &format!("/aligned/{}", f.photo_id),
        &format!("w=320&v={}", f.version),
    );
    assert_eq!(
        (looked.status().as_u16(), h(&looked, header::CACHE_CONTROL)),
        (200, "no-store"),
        "old version after look change"
    );
    assert_ne!(looked.body(), r.body());
    assert!(
        t.core
            .session
            .read()
            .frames
            .manifest
            .reference_stats
            .is_some(),
        "reference stats computed lazily"
    );

    let state = crate::commands::app::snapshot(&t.core)
        .reference
        .expect("reference");
    let rr = get(
        &t,
        "/reference",
        &format!("w=320&v={}", state.image.version),
    );
    assert_eq!((rr.status().as_u16(), dims(&rr)), (200, (64, 48)));
    let rf = get(
        &t,
        "/reference/frame",
        &format!("w=160&v={}", state.version),
    );
    assert_eq!(rf.status(), 200);
    assert_eq!(
        h(&rf, header::CACHE_CONTROL),
        "public, max-age=31536000, immutable"
    );
    crate::commands::app::reset(&t.core).expect("reset");
    assert_eq!(get(&t, "/reference", "w=320").status(), 404);
}

// ---- async miss pool -------------------------------------------------------

const WAIT: Duration = Duration::from_secs(20);

/// A gate the test opens to let blocked renders finish.
#[derive(Clone, Default)]
struct Gate(Arc<(parking_lot::Mutex<bool>, parking_lot::Condvar)>);

impl Gate {
    fn wait(&self) {
        let (open, cv) = &*self.0;
        let mut open = open.lock();
        while !*open {
            cv.wait(&mut open);
        }
    }
    fn open(&self) {
        *self.0.0.lock() = true;
        self.0.1.notify_all();
    }
}

/// A plan for `cache` whose render counts itself, reports that it started,
/// waits for `gate` and then returns `body` (or panics when `body` is None).
fn plan_with(
    cache: PathBuf,
    renders: &Arc<AtomicUsize>,
    started: &mpsc::Sender<PathBuf>,
    gate: &Gate,
    body: Option<&'static [u8]>,
) -> Plan {
    let (renders, started, gate) = (Arc::clone(renders), started.clone(), gate.clone());
    Plan {
        cache: cache.clone(),
        current: true,
        lru: false,
        render: Box::new(move |_| {
            renders.fetch_add(1, Ordering::SeqCst);
            let _ = started.send(cache);
            gate.wait();
            match body {
                Some(b) => Ok(b.to_vec()),
                None => panic!("decoder blew up"),
            }
        }),
    }
}

/// A responder reporting `(tag, status)`.
fn responder(tag: usize, tx: &mpsc::Sender<(usize, u16)>) -> Responder {
    let tx = Mutex::new(tx.clone());
    Box::new(move |r: Response<Vec<u8>>| {
        let _ = tx.lock().expect("tx").send((tag, r.status().as_u16()));
    })
}

fn collect(rx: &mpsc::Receiver<(usize, u16)>, n: usize) -> Vec<(usize, u16)> {
    let mut got: Vec<_> = (0..n)
        .map(|_| rx.recv_timeout(WAIT).expect("response"))
        .collect();
    got.sort_unstable();
    got
}

#[test]
fn concurrent_misses_for_one_file_render_once() {
    let t = TestCore::new();
    let cache = t.root.path().join("coalesce.jpg");
    let (renders, gate) = (Arc::new(AtomicUsize::new(0)), Gate::default());
    let (started_tx, started) = mpsc::channel();
    let (tx, rx) = mpsc::channel();
    for i in 0..6 {
        let plan = plan_with(cache.clone(), &renders, &started_tx, &gate, Some(b"jpeg"));
        t.core.protocol.submit(plan, responder(i, &tx), None);
    }
    started.recv_timeout(WAIT).expect("render started");
    gate.open();
    assert_eq!(
        collect(&rx, 6),
        (0..6).map(|i| (i, 200)).collect::<Vec<_>>()
    );
    assert_eq!(
        renders.load(Ordering::SeqCst),
        1,
        "one render for six requests"
    );
    assert_eq!(std::fs::read(&cache).expect("cached"), b"jpeg");
}

#[test]
fn a_panicking_render_answers_every_waiter_and_keeps_the_pool_alive() {
    let t = TestCore::new();
    let renders = Arc::new(AtomicUsize::new(0));
    let (started_tx, started) = mpsc::channel();
    let (tx, rx) = mpsc::channel();
    let cache = t.root.path().join("panics.jpg");
    // More panics than workers: a dead worker would leave the last ones hanging.
    for round in 0..=pool_threads() {
        let gate = Gate::default();
        for i in 0..3 {
            let plan = plan_with(cache.clone(), &renders, &started_tx, &gate, None);
            t.core
                .protocol
                .submit(plan, responder(round * 10 + i, &tx), None);
        }
        started.recv_timeout(WAIT).expect("render started");
        gate.open();
        let got = collect(&rx, 3);
        assert!(got.iter().all(|&(_, status)| status == 500), "{got:?}");
    }
    assert_eq!(renders.load(Ordering::SeqCst), pool_threads() + 1);
    // The in-flight entry was cleared: the same file renders again, fine this time.
    let gate = Gate::default();
    gate.open();
    let plan = plan_with(cache.clone(), &renders, &started_tx, &gate, Some(b"ok"));
    t.core.protocol.submit(plan, responder(99, &tx), None);
    assert_eq!(collect(&rx, 1), vec![(99, 200)]);
    assert!(t.core.protocol.idle(), "no in-flight entries left");
}

#[test]
fn a_year_of_thumbnails_requested_at_once_all_load() {
    // Opening a year in Days asks for ~365 thumbnails in one go, all misses.
    let t = TestCore::new();
    let renders = Arc::new(AtomicUsize::new(0));
    let (started_tx, started) = mpsc::channel();
    let (tx, rx) = mpsc::channel();
    let busy = Gate::default();
    let workers = pool_threads();
    for i in 0..workers {
        let cache = t.root.path().join(format!("busy{i}.jpg"));
        let plan = plan_with(cache, &renders, &started_tx, &busy, Some(b"b"));
        t.core.protocol.submit(plan, responder(i, &tx), None);
    }
    for _ in 0..workers {
        started.recv_timeout(WAIT).expect("worker busy");
    }
    let free = Gate::default();
    free.open();
    for i in 0..400 {
        let cache = t.root.path().join(format!("day{i}.jpg"));
        let plan = plan_with(cache, &renders, &started_tx, &free, Some(b"t"));
        t.core.protocol.submit(plan, responder(1000 + i, &tx), None);
    }
    busy.open();
    let all = collect(&rx, workers + 400);
    let failed: Vec<_> = all.iter().filter(|&&(_, status)| status != 200).collect();
    assert!(
        failed.is_empty(),
        "{} of {} failed: {failed:?}",
        failed.len(),
        all.len()
    );
}

#[test]
fn queue_overflow_answers_the_oldest_waiting_requests_with_503() {
    const CAP: usize = 16;
    let t = TestCore::new();
    t.core.protocol.set_queue_cap(CAP);
    let renders = Arc::new(AtomicUsize::new(0));
    let (started_tx, started) = mpsc::channel();
    let (tx, rx) = mpsc::channel();
    let busy = Gate::default();
    // Occupy every worker.
    let workers = pool_threads();
    for i in 0..workers {
        let plan = plan_with(
            t.root.path().join(format!("busy{i}.jpg")),
            &renders,
            &started_tx,
            &busy,
            Some(b"b"),
        );
        t.core.protocol.submit(plan, responder(i, &tx), None);
    }
    for _ in 0..workers {
        started.recv_timeout(WAIT).expect("worker busy");
    }
    // Queue two more than fit: the two oldest are dropped with 503 at once.
    let free = Gate::default();
    free.open();
    let base = 1000;
    for i in 0..CAP + 2 {
        let plan = plan_with(
            t.root.path().join(format!("q{i}.jpg")),
            &renders,
            &started_tx,
            &free,
            Some(b"q"),
        );
        t.core.protocol.submit(plan, responder(base + i, &tx), None);
    }
    assert_eq!(collect(&rx, 2), vec![(base, 503), (base + 1, 503)]);
    busy.open();
    let rest = collect(&rx, workers + CAP);
    assert!(rest.iter().all(|&(_, status)| status == 200), "{rest:?}");
    assert_eq!(renders.load(Ordering::SeqCst), workers + CAP);
}

#[test]
fn requests_after_shutdown_get_503() {
    let rt = Arc::new(ProtocolRuntime::new(Weak::new()));
    let (tx, rx) = mpsc::channel();
    rt.dispatch(
        super::Request {
            method: "GET".into(),
            path: "/thumb/0123456789abcdef".into(),
            query: Some("w=320".into()),
            origin: None,
        },
        responder(1, &tx),
    );
    let (renders, gate) = (Arc::new(AtomicUsize::new(0)), Gate::default());
    gate.open();
    let (started_tx, _started) = mpsc::channel();
    let dir = tempfile::tempdir().expect("tempdir");
    rt.submit(
        plan_with(
            dir.path().join("x.jpg"),
            &renders,
            &started_tx,
            &gate,
            Some(b"x"),
        ),
        responder(2, &tx),
        None,
    );
    assert_eq!(collect(&rx, 2), vec![(1, 503), (2, 503)]);
    assert_eq!(
        renders.load(Ordering::SeqCst),
        0,
        "nothing renders without a core"
    );
}

#[test]
fn cors_is_granted_only_to_the_app_origin() {
    let t = scanned();
    let p = confirmed(&t);
    let (tx, rx) = mpsc::channel::<Response<Vec<u8>>>();
    let send = |origin: Option<&str>| {
        let tx = Mutex::new(tx.clone());
        t.core.protocol.dispatch(
            super::Request {
                method: "GET".into(),
                path: format!("/thumb/{}", p.id),
                query: Some("w=320".into()),
                origin: origin.map(str::to_owned),
            },
            Box::new(move |r| {
                let _ = tx.lock().expect("tx").send(r);
            }),
        );
        rx.recv_timeout(WAIT).expect("response")
    };
    let app = if cfg!(target_os = "windows") {
        "http://tauri.localhost"
    } else {
        "tauri://localhost"
    };
    let ok = send(Some(app));
    assert_eq!(ok.status(), 200);
    assert_eq!(h(&ok, header::ACCESS_CONTROL_ALLOW_ORIGIN), app);
    assert_eq!(h(&ok, header::VARY), "Origin");
    let evil = send(Some("https://evil.example"));
    assert_eq!(
        evil.status(),
        200,
        "the image itself is still served (no-cors <img>)"
    );
    assert_eq!(h(&evil, header::ACCESS_CONTROL_ALLOW_ORIGIN), "");
    assert_eq!(h(&send(None), header::ACCESS_CONTROL_ALLOW_ORIGIN), "");
}
