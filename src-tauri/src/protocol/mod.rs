//! `ftimg` image protocol (ARCHITECTURE.md §6).
//!
//! Requests are parsed and planned off the main thread. Cache hits are read
//! from disk on Tauri's blocking pool; misses go to a small LIFO pool (newest
//! request = most likely visible) with in-flight coalescing (one render per
//! cache file; concurrent requests share it). Writes are atomic.
//!
//! Routes: `thumb`, `aligned`, `reference`, `reference/frame` and (v1.7)
//! `preview` ([`preview`]).
//!
//! Robustness: every request is answered exactly once — a [`Reply`] that is
//! dropped unanswered (panic, lost task) answers 500; a panicking render is
//! caught, answers all its waiters and leaves the worker alive. The miss
//! queue is bounded as a safety valve: past [`MAX_QUEUED_MISSES`] (4,096 —
//! far more than any screen of cells) the oldest queued request (least
//! likely still on screen) is answered 503. Renders run inside the
//! protocol's own small rayon pool so their nested parallel work never waits
//! behind a scan or align on the global pool.

pub mod preview;
pub mod route;

use std::collections::{HashMap, VecDeque};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock, Weak};

use face_engine as fe;
use face_engine::color::FrameLook;
use face_engine::geometry::Size;
use parking_lot::{Condvar, Mutex};
use tauri::http::{Response, StatusCode, header};

use crate::error::{AppResult, from_engine};
use crate::ipc::{ErrorKind, ImageRoute, IpcError, NormalizeMode};
use crate::session::frames::{frame_key, frame_version, look_key};
use crate::session::{derive, reference};
use crate::state::Core;

/// Renders a cache file's bytes on a miss.
type RenderFn = Box<dyn FnOnce(&Core) -> AppResult<Vec<u8>> + Send>;
/// Delivers a response (Tauri's `UriSchemeResponder` in the app).
pub type Responder = Box<dyn FnOnce(Response<Vec<u8>>) + Send>;

/// Most misses waiting for a worker; beyond it the oldest is answered 503.
///
/// A safety valve, not a browsing limit: opening a year in Days requests
/// ~365 thumbnails at once and a fast grid scroll a few hundred more, all of
/// which must load. 4,096 queued requests is ten years of day cells; each
/// entry is a cache path and a small closure (well under 1 KB), so the
/// bound costs at most a few MB. Past it the *oldest* request goes first —
/// under LIFO it is the one least likely to still be on screen.
pub const MAX_QUEUED_MISSES: usize = 4096;

/// How a request will be served.
pub struct Plan {
    /// Cache file holding the image.
    pub cache: PathBuf,
    /// `v` matched the current version ⇒ immutable caching.
    pub current: bool,
    /// A hit marks the file as used (the `previews/` LRU, [`preview::mark_used`]).
    pub lru: bool,
    pub render: RenderFn,
}

fn not_found() -> IpcError {
    IpcError::new(ErrorKind::NotFound, "not found")
}

/// Resolves a route against the session (under a short read lock).
///
/// # Errors
/// `notFound` for unknown ids / missing frames / no reference.
pub fn plan(core: &Core, route: &ImageRoute) -> AppResult<Plan> {
    let s = core.session.read();
    match route {
        ImageRoute::Thumb {
            photo_id,
            width,
            version,
        } => {
            let e = s.library.get(photo_id).ok_or_else(not_found)?;
            let (w, src, id, ver) = (*width, e.path.clone(), e.id.clone(), e.version.clone());
            Ok(Plan {
                lru: false,
                cache: fe::thumbs::path(&core.paths.cache_dir, &id, &ver, w),
                current: version.as_deref() == Some(ver.as_str()),
                render: Box::new(move |core| {
                    fe::thumbs::render_uncached(&core.paths.cache_dir, &src, &id, &ver, w)
                        .map_err(|e| from_engine(&e))
                }),
            })
        }
        ImageRoute::Aligned {
            photo_id,
            width,
            version,
        } => {
            let e = s.library.get(photo_id).ok_or_else(not_found)?;
            let key = frame_key(
                &s.frames.fingerprint,
                &e.version,
                &derive::adjust_of(&s, photo_id),
            );
            let rec = s.frames.current(photo_id, &key).ok_or_else(not_found)?;
            let store = s.frames.store().ok_or_else(not_found)?;
            let master = store.master_path(photo_id, &key);
            let current = version.as_deref() == Some(frame_version(&key, &s.p.look).as_str());
            let (look, w, stats) = (s.p.look, *width, rec.stats());
            let cache = match (look.normalize, w) {
                (NormalizeMode::Off, None) => master.clone(),
                (NormalizeMode::Off, Some(w)) => store.preview_path(photo_id, &key, w),
                (_, w) => store.look_preview_path(&look_key(&look), photo_id, &key, w),
            };
            // The full-size view *is* the master: a miss on it means the master
            // is missing or was cut short, so it is 404 and never rendered
            // (which would write a re-encoded copy over the master itself).
            let serves_master = cache == master;
            Ok(Plan {
                lru: false,
                cache,
                current,
                render: Box::new(move |core| {
                    if serves_master || !master.is_file() {
                        return Err(not_found());
                    }
                    let frame_look = match (look.normalize, stats) {
                        (NormalizeMode::Off, _) | (_, None) => None,
                        (_, Some(frame)) => Some(FrameLook {
                            frame,
                            reference: crate::look::reference_stats(core)?,
                            settings: crate::convert::look(look),
                        }),
                    };
                    let img = fe::frames::load_master(&master, frame_look.as_ref())
                        .map_err(|e| from_engine(&e))?;
                    fe::frames::view_bytes(&img, w).map_err(|e| from_engine(&e))
                }),
            })
        }
        ImageRoute::Preview {
            photo_id,
            width,
            version,
        } => preview::plan(core, &s, photo_id, *width, version.as_deref()),
        ImageRoute::Reference { width, version } => {
            let r = s.p.reference.as_ref().ok_or_else(not_found)?;
            let v = reference::image_version(r);
            let (path, rot, w) = (PathBuf::from(&r.path), r.rotation_deg, *width);
            Ok(Plan {
                lru: false,
                cache: core.paths.reference_file(&v, w),
                current: version.as_deref() == Some(v.as_str()),
                render: Box::new(move |_| {
                    let img =
                        fe::reference::rotated_image(&path, rot).map_err(|e| from_engine(&e))?;
                    fe::analysis::encode_thumbnail(&img, w).map_err(|e| from_engine(&e))
                }),
            })
        }
        ImageRoute::ReferenceFrame { width, version } => {
            let r = s.p.reference.as_ref().ok_or_else(not_found)?;
            let v = reference::state_version(r);
            let w = *width;
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            let size = Size::new(
                r.crop.width.round().max(1.0) as u32,
                r.crop.height.round().max(1.0) as u32,
            )
            .fit_within(w);
            let (path, rot, crop) = (PathBuf::from(&r.path), r.rotation_deg, r.crop);
            Ok(Plan {
                lru: false,
                cache: core.paths.reference_frame_file(&v, w),
                current: version.as_deref() == Some(v.as_str()),
                render: Box::new(move |_| {
                    let img = crate::look::reference_frame(&path, rot, crop, size)?;
                    fe::frames::view_bytes(&img, None).map_err(|e| from_engine(&e))
                }),
            })
        }
    }
}

/// Origins of the app's own webview (and, in debug builds, the dev server).
/// Only these get `Access-Control-Allow-Origin`; `<img>` loads need no CORS,
/// so a page the webview was somehow navigated to cannot read pixels.
#[must_use]
pub fn is_app_origin(origin: &str) -> bool {
    matches!(
        origin,
        "tauri://localhost" | "http://tauri.localhost" | "https://tauri.localhost"
    ) || (cfg!(debug_assertions) && origin == "http://localhost:1420")
}

/// Builds a response with the protocol's fixed headers (no CORS grant; see
/// [`is_app_origin`]).
#[must_use]
pub fn respond(status: u16, body: Vec<u8>, current: bool) -> Response<Vec<u8>> {
    let ok = status == 200;
    let builder = Response::builder()
        .status(StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR))
        .header(
            header::CONTENT_TYPE,
            if ok {
                "image/jpeg"
            } else {
                "text/plain; charset=utf-8"
            },
        )
        .header(header::VARY, "Origin")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(
            header::CACHE_CONTROL,
            if ok && current {
                "public, max-age=31536000, immutable"
            } else {
                "no-store"
            },
        );
    builder
        .body(body)
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

fn error_response(err: &IpcError) -> Response<Vec<u8>> {
    if err.kind == ErrorKind::NotFound {
        respond(404, b"not found".to_vec(), false)
    } else {
        log::warn!("ftimg render failed: {} ({:?})", err.message, err.kind);
        respond(500, b"image could not be rendered".to_vec(), false)
    }
}

/// A cache hit: the file, unless a power loss left it cut short (cache files
/// are not fsynced, see `face_engine::cache::write_atomic_cache`) — then it
/// is a miss and is rendered again.
fn read_cached(plan: &Plan) -> Option<Vec<u8>> {
    let bytes = std::fs::read(&plan.cache)
        .ok()
        .filter(|b| fe::cache::is_whole_jpeg(b))?;
    if plan.lru {
        preview::mark_used(&plan.cache);
    }
    Some(bytes)
}

/// Renders a plan's bytes and stores them atomically in the cache.
fn render_and_store(core: &Core, cache: &Path, render: RenderFn) -> AppResult<Vec<u8>> {
    let bytes = render(core)?;
    if let Err(e) = fe::cache::write_atomic_cache(cache, &bytes) {
        log::warn!("ftimg cache write failed: {e}");
    }
    Ok(bytes)
}

/// Serves a request synchronously (tests, and the body of async dispatch).
#[must_use]
pub fn serve_blocking(
    core: &Core,
    method: &str,
    path: &str,
    query: Option<&str>,
) -> Response<Vec<u8>> {
    let route = match route::parse(method, path, query) {
        Ok(r) => r,
        Err(e) => return respond(e.status(), Vec::new(), false),
    };
    let plan = match plan(core, &route) {
        Ok(p) => p,
        Err(e) => return error_response(&e),
    };
    if let Some(bytes) = read_cached(&plan) {
        return respond(200, bytes, plan.current);
    }
    match render_and_store(core, &plan.cache, plan.render) {
        Ok(bytes) => respond(200, bytes, plan.current),
        Err(e) => error_response(&e),
    }
}

/// A request as the scheme handler received it.
#[derive(Debug, Clone)]
pub struct Request {
    pub method: String,
    pub path: String,
    pub query: Option<String>,
    /// The `Origin` header, if any.
    pub origin: Option<String>,
}

/// One-shot answer channel. Answers 500 if dropped unanswered, so a request
/// can never hang (panicking planner/render, task lost on shutdown).
struct Reply {
    tx: Option<Responder>,
    /// `v` matched the current version ⇒ immutable caching.
    current: bool,
    /// The request's origin when it is the app's own.
    cors: Option<String>,
}

impl Reply {
    fn new(tx: Responder, origin: Option<&str>) -> Self {
        Self {
            tx: Some(tx),
            current: false,
            cors: origin.filter(|o| is_app_origin(o)).map(str::to_owned),
        }
    }

    fn send(mut self, response: Response<Vec<u8>>) {
        self.deliver(response);
    }

    fn deliver(&mut self, mut response: Response<Vec<u8>>) {
        let Some(tx) = self.tx.take() else { return };
        if let Some(value) = self
            .cors
            .as_deref()
            .and_then(|o| header::HeaderValue::from_str(o).ok())
        {
            response
                .headers_mut()
                .insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, value);
        }
        tx(response);
    }
}

impl Drop for Reply {
    fn drop(&mut self) {
        if self.tx.is_some() {
            self.deliver(respond(500, b"image could not be rendered".to_vec(), false));
        }
    }
}

/// Why a queued miss produced no image.
enum Failure {
    /// The render returned an error (404 for `notFound`, else 500).
    Error(IpcError),
    /// The app is shutting down or the queue overflowed.
    Unavailable,
}

/// A planned miss waiting for a worker.
struct Miss {
    cache: PathBuf,
    render: RenderFn,
}

/// State shared by the runtime and its workers.
struct Shared {
    core: Weak<Core>,
    queue: Mutex<VecDeque<Miss>>,
    ready: Condvar,
    /// Waiters per cache file being rendered.
    inflight: Mutex<HashMap<PathBuf, Vec<Reply>>>,
    shutdown: AtomicBool,
    workers: AtomicUsize,
    /// [`MAX_QUEUED_MISSES`] (smaller in tests).
    queue_cap: AtomicUsize,
    /// Pool for renders' nested parallel work (`None` if it could not start).
    pool: OnceLock<Option<rayon::ThreadPool>>,
}

impl Shared {
    fn install<R: Send>(&self, f: impl FnOnce() -> R + Send) -> R {
        match self.pool.get().and_then(Option::as_ref) {
            Some(pool) => pool.install(f),
            None => f(),
        }
    }

    /// Renders one miss (panics caught) and answers its waiters.
    fn run(&self, miss: Miss) {
        let Miss { cache, render } = miss;
        let result = match self.core.upgrade() {
            None => Err(Failure::Unavailable),
            Some(core) => catch_unwind(AssertUnwindSafe(|| {
                self.install(|| render_and_store(&core, &cache, render))
            }))
            .unwrap_or_else(|_| Err(IpcError::internal("image render panicked")))
            .map_err(Failure::Error),
        };
        self.complete(&cache, &result);
    }

    /// Removes the in-flight entry and answers every waiter.
    fn complete(&self, cache: &Path, result: &Result<Vec<u8>, Failure>) {
        let waiters = self.inflight.lock().remove(cache).unwrap_or_default();
        for reply in waiters {
            let response = match result {
                Ok(bytes) => respond(200, bytes.clone(), reply.current),
                Err(Failure::Error(e)) => error_response(e),
                Err(Failure::Unavailable) => respond(503, Vec::new(), false),
            };
            reply.send(response);
        }
    }

    /// Worker loop: newest miss first; exits on shutdown.
    fn work(&self) {
        loop {
            let miss = {
                let mut q = self.queue.lock();
                loop {
                    if let Some(m) = q.pop_back() {
                        break Some(m);
                    }
                    if self.shutdown.load(Ordering::Acquire) {
                        break None;
                    }
                    self.ready.wait(&mut q);
                }
            };
            let Some(miss) = miss else { return };
            // `run` catches render panics; this guards the answering itself.
            if catch_unwind(AssertUnwindSafe(|| self.run(miss))).is_err() {
                log::error!("ftimg worker recovered from a panic while answering");
            }
        }
    }
}

/// LIFO miss pool + in-flight coalescing.
pub struct ProtocolRuntime {
    shared: Arc<Shared>,
    started: std::sync::Once,
}

/// Miss-pool size: `clamp(cores / 4, 2, 4)`.
#[must_use]
pub fn pool_threads() -> usize {
    (std::thread::available_parallelism().map_or(4, |n| n.get()) / 4).clamp(2, 4)
}

impl ProtocolRuntime {
    #[must_use]
    pub fn new(core: Weak<Core>) -> Self {
        Self {
            shared: Arc::new(Shared {
                core,
                queue: Mutex::new(VecDeque::new()),
                ready: Condvar::new(),
                inflight: Mutex::new(HashMap::new()),
                shutdown: AtomicBool::new(false),
                workers: AtomicUsize::new(0),
                queue_cap: AtomicUsize::new(MAX_QUEUED_MISSES),
                pool: OnceLock::new(),
            }),
            started: std::sync::Once::new(),
        }
    }

    fn start(&self) {
        self.started.call_once(|| {
            let threads = pool_threads();
            let pool = rayon::ThreadPoolBuilder::new()
                .num_threads(threads)
                .thread_name(|i| format!("ft-ftimg-par-{i}"))
                .build()
                .map_err(|e| log::error!("cannot start the ftimg render pool: {e}"))
                .ok();
            let _ = self.shared.pool.set(pool);
            for i in 0..threads {
                let shared = Arc::clone(&self.shared);
                let spawned = std::thread::Builder::new()
                    .name(format!("ft-ftimg-{i}"))
                    .spawn(move || shared.work());
                match spawned {
                    Ok(_) => {
                        self.shared.workers.fetch_add(1, Ordering::Release);
                    }
                    Err(e) => log::error!("cannot start ftimg worker: {e}"),
                }
            }
        });
    }

    /// Runs `f` on the protocol's render pool, so nested rayon work in a
    /// read path (image renders, look statistics) does not queue behind a
    /// running job on the global pool.
    pub fn install<R: Send>(&self, f: impl FnOnce() -> R + Send) -> R {
        self.start();
        self.shared.install(f)
    }

    /// Overrides [`MAX_QUEUED_MISSES`] (tests exercise the safety valve
    /// without queueing thousands of renders).
    pub fn set_queue_cap(&self, cap: usize) {
        self.shared.queue_cap.store(cap.max(1), Ordering::Relaxed);
    }

    /// True when no render is in flight and nothing is queued.
    #[must_use]
    pub fn idle(&self) -> bool {
        self.shared.inflight.lock().is_empty() && self.shared.queue.lock().is_empty()
    }

    /// Serves a request asynchronously: planning and hits on a blocking
    /// thread, misses on the LIFO pool (coalesced per cache file).
    pub fn dispatch(self: &Arc<Self>, request: Request, responder: Responder) {
        let this = Arc::clone(self);
        tauri::async_runtime::spawn_blocking(move || {
            let reply = Reply::new(responder, request.origin.as_deref());
            this.serve(&request, reply);
        });
    }

    /// Plans a request and answers hits; misses go to [`Self::submit`].
    /// A panic here drops `reply`, which answers 500.
    fn serve(&self, request: &Request, mut reply: Reply) {
        let Some(core) = self.shared.core.upgrade() else {
            return reply.send(respond(503, Vec::new(), false));
        };
        let route = match route::parse(&request.method, &request.path, request.query.as_deref()) {
            Ok(r) => r,
            Err(e) => return reply.send(respond(e.status(), Vec::new(), false)),
        };
        let plan = match plan(&core, &route) {
            Ok(p) => p,
            Err(e) => return reply.send(error_response(&e)),
        };
        drop(core);
        if let Some(bytes) = read_cached(&plan) {
            return reply.send(respond(200, bytes, plan.current));
        }
        reply.current = plan.current;
        self.enqueue(plan, reply);
    }

    /// Queues a planned miss for `responder` (coalesced with any render of
    /// the same cache file already in flight). `origin` is the request's
    /// `Origin` header.
    pub fn submit(&self, plan: Plan, responder: Responder, origin: Option<&str>) {
        let mut reply = Reply::new(responder, origin);
        reply.current = plan.current;
        self.enqueue(plan, reply);
    }

    fn enqueue(&self, plan: Plan, reply: Reply) {
        if self.shared.core.strong_count() == 0 {
            return reply.send(respond(503, Vec::new(), false));
        }
        {
            let mut inflight = self.shared.inflight.lock();
            if let Some(waiters) = inflight.get_mut(&plan.cache) {
                waiters.push(reply);
                return;
            }
            inflight.insert(plan.cache.clone(), vec![reply]);
        }
        let miss = Miss {
            cache: plan.cache,
            render: plan.render,
        };
        self.start();
        if self.shared.workers.load(Ordering::Acquire) == 0 {
            // No worker could be started: render on this (blocking) thread.
            return self.shared.run(miss);
        }
        let dropped = {
            let mut q = self.shared.queue.lock();
            q.push_back(miss);
            if q.len() > self.shared.queue_cap.load(Ordering::Relaxed) {
                q.pop_front()
            } else {
                None
            }
        };
        self.shared.ready.notify_one();
        if let Some(old) = dropped {
            self.shared.complete(&old.cache, &Err(Failure::Unavailable));
        }
    }
}

impl Drop for ProtocolRuntime {
    /// Stops the workers once the queue is empty; queued misses then find no
    /// core and are answered 503.
    fn drop(&mut self) {
        // Under the queue lock, so no worker misses the wake-up between its
        // check and its wait.
        let _queue = self.shared.queue.lock();
        self.shared.shutdown.store(true, Ordering::Release);
        self.shared.ready.notify_all();
    }
}

#[cfg(test)]
mod preview_tests;
#[cfg(test)]
mod tests;
