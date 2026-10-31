# Integration notes (src-tauri)

> Owner: INTEGRATION. Companion to `ARCHITECTURE.md` (binding) and `DESIGN.md`.
> Records how the Tauri shell meets the engine and video crates, what is still
> interim, the decisions taken where the docs left room, and how the UI hooks up.

## 1. Shell at a glance

| Item | Value |
|---|---|
| Tauri | `tauri 2.12.5` (`macos-private-api` feature), `tauri-build 2.7.4`, CLI `@tauri-apps/cli 2.12.4` |
| Plugins (Rust-side only, no JS permissions) | `tauri-plugin-dialog 2.8.3`, `tauri-plugin-opener 2.7.2`, `tauri-plugin-window-state 2.5.0` |
| Identifier | `io.github.gingerman960.facetimelapse` (ARCHITECTURE §5/§14, same as the legacy appId) |
| Contract | `src/ipc.rs` = verbatim §7.4 (types v1.7, commands v1.7, events v1.6, behaviour v1.6 — §7.7; `#[rustfmt::skip]`, drift-tested; `ui/src/ipc/contract.ts` = verbatim §7.3, drift-tested too) |
| Commands | all 31 of §7.2, in `src/commands/*.rs`; `invoke_handler()` and `context()` in `src/lib.rs` |
| ACL | `build.rs` `AppManifest::commands` (31) + `capabilities/main.json` (31 `allow-*` + event listen/unlisten, window show/start-dragging/internal-toggle-maximize/set-theme). No fs/shell/http/dialog/opener permissions. |
| Window | `main`, created in `setup` after state is managed (`"create": false`), 1440×900, min 960×640, hidden until the UI calls `show()` (fallback 3 s), overlay title bar, hidden title, traffic lights at (22, 24), drag-drop enabled. macOS: transparent + `sidebar` vibrancy (`FollowsWindowActiveState`); Windows/Linux: opaque, background `#0f0f0e` / `#f9f8f6` by system theme. |

Module map: `engine/` (the model seam: `mod.rs` trait over what needs the ONNX models — `PhotoAnalyzer`, `FrameRenderer`, reference detection — `real.rs` = `face-engine`, `fake.rs` = name-driven test double), `convert.rs` (IPC contract types ⇄ engine types, field mapping only), `session/` (persisted model + v1→v2 migration, library + matching state, derivations, the frame state of the current fingerprint, reference plumbing), `jobs/` (registry, throttle, the four job wrappers), `protocol/` (`ftimg` routing, bounded LIFO pool with its own rayon pool, coalescing, panic-safe answers), `commands/`, `grants.rs` (path grants), `navigation.rs` (navigation allow-list), `quit.rs` (quitting: both last run-loop events stop the job), `look.rs`, `paths.rs`, `ids.rs` (id validation only), `logging.rs`, `startup.rs`, `prune.rs`, `devhooks.rs`.

## 2. One implementation per concern

The engine owns domain logic and pure building blocks; the shell owns IPC,
session state, the single-job model, channels/throttling, persistence, the
protocol's HTTP concerns and dialogs. The shell calls the engine directly for
everything that needs no models (in tests too); only model-backed work goes
through the `engine::Engine` seam so tests run on the fake.

| Concern | Owner (implementation) | Shell side |
|---|---|---|
| Ids / versions / folder key | `walk::{photo_id, photo_version, folder_key, file_stamp}` (hash the canonical path as given: no per-file `realpath`, two links to one file never share an id) | `ids.rs`: validation of ids/versions from URLs |
| Walk | `walk::walk` | — |
| Analysis cache | `cache::AnalysisCache::{load, lookup, …}`, `cache::entry_count`, `cache::prune`; fingerprint `analysis::analysis_fingerprint` (before the models load) | — |
| Matching | `scan::match_photo` (`matching::match_faces` + `Calibration`) | `session::MatchInfo` view |
| Days | `days::{group_days, diff, DayDecisions}` | per-folder decisions (string keys in `session.json`) converted on the fly; manual adds count at noon of their day |
| Scan loop | `scan::scan_folder` (+ `PhotoAnalyzer`) | `jobs/scan.rs`: started/hits/progress/`recent` tiles, summary, apply |
| Align loop | `frames::{align_frames, render_item}` (+ `FrameRenderer`) | `jobs/align.rs`: items of the active days, progress/`recent`, recording frames (flush 2 s); `set_frame_adjustment` = `render_item` |
| Frame store / keys | `frames::{FrameStore, Manifest, render_fingerprint (RENDER_VERSION), frame_key, prune_fingerprints, load_master, view_bytes}` | `session/frames.rs`: in-memory `Manifest` (opened with `load_usable_manifest`: frames whose master is missing or cut short count as not aligned) + `FrameSummary.version` |
| Look | `color::{FrameLook, LookSettings::cache_key, face_stats, look_delta}` | `look.rs`: reference statistics cached per fingerprint |
| Export naming / loop | `export::{export_images, NamePlanner, write_image}` (stops at the first failing file) | `jobs/export_images.rs`: validation, progress, summary |
| Video frames | `frames::{FrameSequence, FrameSpec}` (LUT built on the encoder's workers) | `jobs/export_video.rs`: `FrameSource` adapter, options |
| Thumbnails | `thumbs::{path, render_uncached, prune}` (bucket < 320 derived from the cached scan thumbnail, else EXIF fast path, else DCT decode) | protocol plans/caches/coalesces |
| Reference crop rules | `reference::{default_crop, check_crop, rotation_ok, rotated_image, crop_frame}` | friendly messages, protocol versions |
| Images / codecs / atomic writes | `image::RgbImage`, `encode`, `decode`, `cache::write_atomic` (fsynced: analysis cache, manifests, session), `cache::write_atomic_cache` + `is_whole_jpeg` (image caches: not fsynced, a torn file is rebuilt) | — |
| Thread pool | engine loops run on the current rayon pool | `state::init_work_pool`: the global pool = cores − 1 (the only pool for heavy work; the video crate's prep pool is sized the same and only lives during an export) |

The `face_engine::Engine` facade stays as the library's API for the
example/tests/benches; each of its methods delegates to the functions above
(no second copy of any loop).

## 3. Remaining gaps

None. G1 (reading the analysis cache) is `AnalysisCache::load` + `lookup`
(the shell's private mirror of the file layout is gone), G2 is
`analysis::analysis_fingerprint` (fingerprint before the models load), G3 is
`thumbs::render_uncached` in the protocol's miss path.

## 4. Decisions taken (docs left room)

- **Width semantics**: every `ftimg` route fits the image inside `w × w` (long edge = bucket), never upscales; aligned `w` absent ⇒ master size.
- **Protocol statuses**: malformed or unknown ids ⇒ 404; non-numeric/missing required `w` ⇒ 400; non-`GET` (incl. `HEAD`) ⇒ 405; source file vanished ⇒ 404; decode failure ⇒ 500 (plain text). Non-hex `v` is ignored (served `no-store`).
- **Known ids**: walked-but-not-yet-analyzed files are servable as `thumb/{id}` (scan mosaic), but only analyzed photos are listed by `get_photos`.
- **Reference without a face in the crop**: state with `detection: null`; matching keeps the last embedding of the *same* reference photo so days don't vanish while dragging, and that embedding is persisted (`reference.matchEmbedding`) so a restart matches the same way; a different photo without a face clears matching.
- **Reference analysis is cached in `session.json`** (sizes, face, detection, embedding, file version, engine fingerprint) so a restored session is complete before the models load; it is re-analyzed when the file or engine changed.
- **`autoRotationDeg`** is absolute (relative to the EXIF-oriented photo), from the engine.
- **`reset_session`** clears reference, folder, per-folder decisions and settings; keeps recents, `outputs` and caches.
- **`add_photo_to_day`** with a photo that is part of the folder = confirmed review + day move — refused with `noFaceDetected` when its status is `noFace`/`failed`, and analyzed first (result kept in the library and the analysis cache) when the scan has not reached it; an outside photo is analyzed, must have a face, and is stored with its analysis in `session.json` (restores without models). One add is analyzed at a time, after a busy check.
- **`move_photo_to_day`** back to the capture day removes the move; moved photos report `dateSource: 'manual'` (time badge hidden).
- **`set_review_decision`** rejects `confirmed` on `noFace`/`failed` photos (`invalidArgument`); `pending` = undo.
- **`faceBox`** = matched face bounds; without a reference the largest face; `null` for noFace/failed.
- **`lookDelta`** needs the reference look stats; `get_frames`/`set_look`/`set_frame_adjustment` compute them lazily (one reference decode per fingerprint) when the look is on.
- **Video resolution** larger than the masters is clamped to `source` ("never larger than the masters").
- **Progress**: ≤ 20 events/s; a final forced `progress` is sent before the terminal event whenever something (counts, `recent` tiles) was throttled away. The job slot is released *before* the terminal event.
- **Ids** hash the canonical path as given (`walk` root is canonical, user-picked files are canonicalized once): no per-file `realpath` on restore, unchanged ids for existing sessions.
- **`session.json` v2** stores analyses and the reference cache in the engine's serde shapes; v1 files are migrated losslessly on load (`session/persist.rs`), anything newer or malformed is set aside.
- **Frames re-render once after this upgrade**: the render fingerprint now mixes in `face_engine::frames::RENDER_VERSION` (2) and the manifest format is v2, so old masters show as `stale` and are pruned later.
- **`session-changed`** (§7.4 v1.2, no payload) is emitted after the dev autoload, after a stale restored reference was re-analyzed once the models loaded (waiting for a running job first), and when a restore slower than the 3 s `get_session` waits for lands.
- **`models-changed`** (§7.4 v1.6, no payload) is emitted once by the `ft-models` startup thread (`commands::app::load_models_and_notify`) after the load's outcome is recorded: `AppInfo.modelsReady`, or `AppInfo.modelsError` with the engine's user-facing message. It comes before the stale-reference re-analysis and its `session-changed`. `modelsError` stays set for the run. An on-demand load by a command that later succeeds (not expected: models do not appear mid-run) makes `get_app_info` report ready with a null error, and emits no second event. The capability grants `listen`/`unlisten` only, so the webview cannot emit it (mock-IPC test `the_webview_cannot_emit_app_events`).
- **Read-only restore without the models** (QA N5; ARCHITECTURE §5): `Core::engine_fingerprint()` is the engine's own fingerprint while the model files are present and pinned (`face_engine::model::MODELS_FINGERPRINT`). It is remembered as `session.json` `lastEngineFingerprint`. `RealEngine` remembers a failed fingerprint per (length, mtime) of the model files, so altered models are hashed once, not on every `render_key`. Otherwise it is the remembered one: the analysis cache, the library, the days and the frame store restore as with the models. Detection paths call `require_models` first and answer `modelUnavailable`. Nothing is written under the remembered value, and pruning still judges no analysis cache without loaded models. A session that was never opened with the models (including those saved before this field) remembers nothing, so it still restores empty without them. Tests: `commands/tests/models_missing.rs`, and the last restart of `tests/pipeline_real.rs`. On a clone of QA's `data-cachesafe` (opened once with the models), a start without them restores 3,591 photos, 3,588 confirmed, 3,578 days and frames `complete` 3,578, the same as with the models.
- **`open_path`** (v1.7, `commands::export::{check_open, open_output, open_path}`): the path must equal a session output exactly, end in `.mp4` and not be a remote/UNC spelling. That is decided with no disk access. It must then still be a regular file (`symlink_metadata`: a link is never followed), and the canonical path goes to `tauri-plugin-opener`'s Rust `open_path`. Every refusal is `notFound` with one message. Permission `allow-open-path`; the opener still has no JS permission and `open_js_links_on_click(false)`. Tests: `commands/tests/exports.rs` (opener stubbed), `ipc_tests.rs` (ACL).
- **`preview` route** (v1.7, `protocol/preview.rs`): `PhotoDetail.previewVersion` and the route share one `candidate()`: align's item (matched face, nudge), `render_key` and the frame key. The render is `Engine::render_preview` → `face_engine::align::render_frame_unrefined` (analysis landmarks, no models) at `out.fit_within(w)`, then `preview_bytes`. Nothing is written under `frames/`; files go to `previews/`: an LRU by mtime (`read_cached` touches a hit when `Plan.lru`), bounded 256 → 192 MB by `prune.rs` at startup and then by the `ft-prune` thread every `PRUNE_EVERY` (5 min, holding only a `Weak<Core>`). Never inside a render, and `.`-prefixed in-flight temp files are skipped. It goes through the same miss pool, so the 16-hex ids, width buckets, decode budget, render pool, bounded queue, panic answers, CORS and 404/503 all apply. Tests: `protocol/preview_tests.rs`.
- **Path grants** (v1.3, `grants.rs`): dialog results and OS drops (recorded in `on_window_event`/`on_webview_event` — Tauri forwards the drop to the webview first and runs these in the same main-thread callback; commands are dispatched on the main thread, so none can run before the grant exists) plus the session's own paths. Read grants cover a folder's contents; export grants are exact. Two steps: the spelling must lie inside a grant as spelled (otherwise `permissionDenied` without touching the disk), then the resolved path must lie inside the resolved grant (a directory symlink inside a granted folder cannot lead out). Dialog grants are recorded on the blocking pool (they resolve the path). Test cores grant their temp root; after a restart only the session's canonical spellings are granted.
- **Timeouts**: mutation gate 2 s ⇒ `busy`; `get_session`/mutations wait ≤ 3 s for the startup restore; quitting waits ≤ 5 s for a cancelled job. A newer `set_source_folder` supersedes a slower one (`cancelled`).
- **Exports**: a video replaces an existing file only if `pick_video_path` showed exactly that name (the save dialog asked) or it is one of our outputs; `.mp4` appended by us to a dialog name never counts as confirmed. Without that confirmation the encoder never replaces anything: a file appearing at the path during the encode is kept and the video lands at `{name}_1.mp4` (`VideoSummary.path`). Only a finished video joins `outputs` (with the path actually written). Exports in progress are recorded in `session.json` (`pendingOutputs`) and their temporary files deleted at the next start, after the library restore (records of folders unreadable at that moment are kept, at most 64). `outputs` keeps the 200 most recent.
- **Quit**: `quit::on_run_event` stops the running job (cancel + ≤ 5 s wait) on both `ExitRequested` and `Exit`; on macOS Cmd+Q / Dock Quit / logout only `Exit` arrives. `Core::shutdown` is idempotent.
- **`reveal_path`**: only paths spelled inside an output are looked at on disk; anything else is `invalidArgument` whether or not it exists.
- **`ftimg`**: no wildcard CORS (`Access-Control-Allow-Origin` only echoes the app origin); ≤ 4,096 queued misses, served newest first (past that the oldest ⇒ 503; a year of Days thumbnails, ~400 misses, always loads — `<img>` retry on 503 stays good practice); a panicking render answers 500 to its waiters.
- **Env in release builds**: `FT_DATA_DIR` stays (it only relocates the app's own data, which the same user can edit anyway); `FT_MODELS_DIR` and the repository models fallback are debug-only, and the models' SHA-256 is verified at load.
- **Window position** (macOS): the main window is created without Tauri's centring (`center` is cleared in `setup`); AppKit then centres it itself on whole points (slightly above centre). Tauri halves the work area in pixels, which gave a half-point origin on a 1009-pt-high work area and a 1440 × 901 window (QA); measured now: frame 1440 × 900. The window-state plugin still restores a saved frame.
- **Session floats** (fix pass 5): `serde_json` is built with `float_roundtrip`. Without it about 12 % of floats read back from `session.json` were one ULP off, so reference anchors and a levelling angle computed in the session hashed to a different render fingerprint after a restart and every frame went stale (QA N1). The fingerprint itself now hashes fixed units (whole-pixel crop, micro-units of the crop for anchors, micro-degrees), and crops are snapped to whole pixels where they are set.
- **Window open animation** (macOS, `no_open_animation` in `lib.rs`, testable part in `window_mac.rs`): the main window's `animationBehavior` is `None`, set in `setup` before the UI can show it. AppKit's zoom-in from ~90 % never completes when the window is first shown while the session is locked or the display asleep, which left a 1296 × 811 window in a 1440 × 900 frame (QA #14). Verified with `CGWindowListCopyWindowInfo` sampled every 5 ms from launch: the previous build passes through 1416 × 884 … 1442 × 902 before settling, this one is 1440 × 900 from the first sample.
- **WebKit memory and `ftimg` caching** (fix pass 3, measured natively on the WebKit processes of the real app, aligned 3,577-frame session): the real player playing ~215 frames took WebKit from 145 MB to 277–280 MB, and a page loop decoding 400 aligned masters one after another (`new Image()` + draw, no references kept) peaked at 1.64 GB and fell back to 459 MB within 15 s (garbage awaiting collection, not cache). Answering images ≥ 640 px with `Cache-Control: no-store` instead of `immutable` changed neither (277 → 278 MB; 1.69 GB peak, 484 MB after 15 s), so `ftimg` keeps `immutable` for every current version. WKWebView has no public knob for its memory cache (the process pool's cache model is private API) and none is used. What bounds WebKit is the page keeping few decoded images alive (the UI's player buffer).
- **App Nap** (macOS, `jobs/keep_awake.rs`): every job and add-photo analysis holds a user-initiated `NSProcessInfo` activity (`pmset -g assertions` lists it as `PreventUserIdleSystemSleep` named "FaceTimelapse is working on your photos"), so an occluded or screen-locked app keeps its priority while it works.
- **Window state** persistence is disabled when `FT_DATA_DIR` is set (tests/smoke runs don't touch the user's window state). `VISIBLE` is never restored (the UI shows the window).
- **Logging**: own `log` backend, `facetimelapse.log` 5 MB × 3 in the log dir, stderr in debug builds or with `FT_LOG_STDERR=1`; level via `FT_LOG`.
- **Windows/Linux bundles**: NSIS (`currentUser`), AppImage and deb are configured (schema-validated by tauri-build); only the macOS `.app` was built here.

## 5. UI hookup (DESIGN/UI agent)

1. **Scripts**: Tauri runs `npm run dev` / `npm run build` in `ui/` (`beforeDevCommand`/`beforeBuildCommand`), dev URL `http://localhost:1420`, output `ui/dist` (ignored by the root `dist/` rule). Run with `npx @tauri-apps/cli@2.12.4 dev` (or `cargo tauri dev`) from the repo root or `src-tauri/`. Port 1420 (Tauri convention) was chosen to avoid clashing with other local Vite servers on 5173.
2. **Images**: build every URL from `get_app_info().imageBaseUrl` (`ftimg://localhost/` on macOS/Linux, `http://ftimg.localhost/` on Windows) with the §7.3 `imageUrl()` helper. Load them with `<img>`/`new Image()` and draw them on canvases freely (no CORS needed; the current UI does exactly this). `Access-Control-Allow-Origin` is sent only to the app origin (no `*`), so CORS `fetch`/`createImageBitmap` from the app still works, but never read canvas pixels back from an image loaded without `crossOrigin`.
3. **Show the window** once after the first render: `getCurrentWindow().show()`. Do **not** wait on `requestAnimationFrame` alone: in the hidden macOS window rAF never fires (verified in the smoke run). Race it, e.g. `await Promise.race([new Promise(r => requestAnimationFrame(r)), new Promise(r => setTimeout(r, 50))])`, then `show()`. Without a call the shell shows the window after 3 s and logs a warning.
4. **Drag and drop**: `getCurrentWebview().onDragDropEvent(cb)` (permitted). `drop` payload paths are absolute; image ⇒ `set_reference_photo`, directory ⇒ `set_source_folder` (backend answers `invalidArgument` for anything else). HTML5 DnD is disabled by the native handler (D14). The backend grants dropped paths itself (v1.3), so pass the payload paths unchanged; a path the UI builds or edits itself is refused with `permissionDenied`.
5. **Title bar / vibrancy**: overlay title bar, traffic lights at (22, 24); mark drag areas with `data-tauri-drag-region` (dragging and double-click maximize are permitted). On macOS the window is transparent with the `sidebar` material behind the webview: paint every opaque surface (canvas, toolbar, inspector) explicitly, leave the sidebar background transparent/translucent where the material should show, and fall back to opaque `--chrome` under `prefers-reduced-transparency`. Windows/Linux windows are opaque.
6. **Jobs**: `new Channel<…Event>()` from `@tauri-apps/api/core` as `onEvent`; treat `finished | failed | cancelled` as the end, then re-query. `cancel_job(jobId)` is always allowed.
7. **Contract drift fixtures** (§7.6): `contract.samples.{json,ts,test.ts}` live in `ui/src/ipc/` next to `contract.ts` (one source of truth); `npm test` runs the TS half, `cargo test -p facetimelapse --test contract` the Rust half and checks that `contract.ts` / `src/ipc.rs` are the verbatim §7.3 / §7.4 blocks. Regenerate the samples after an accepted contract change with `FT_WRITE_CONTRACT_SAMPLES=1 cargo test -p facetimelapse --test contract`.
8. **`session-changed`** (§7.4 `SESSION_CHANGED_EVENT`, v1.2): `listen('session-changed', …)` (permitted by `core:event:allow-listen`) and invalidate `['session']` plus the queries derived from it; no payload. Sent when the backend changed the session on its own (dev autoload, stale reference re-analyzed after the models loaded).
9. **Theme**: `getCurrentWindow().setTheme('light' | 'dark' | null)` is permitted (`core:window:allow-set-theme`) so the native window material follows an explicit in-app Light/Dark choice.
10. **CSP**: no remote origins; images only from `ftimg:`/`http://ftimg.localhost`/`blob:`/`data:`; scripts `'self'` only in production (dev CSP adds inline scripts and the Vite websocket); styles may be inline. The webview cannot navigate away from the app and cannot open windows (links to the web need a Rust command, none exists today).
11. **v1.3 (behaviour only, no required UI change)**: dialogs, drops and recents keep working as before — pass their paths exactly as received (the UI does). Optional polish: treat `cancelled` from `set_source_folder` as silent (a newer folder choice replaced it); show `cancelled` from `add_photo_to_day` as its message ("The folder changed while the photo was being read. Add it again."); show the `busy` message ("…still applying your previous change…") like any other busy toast; reveal the exported video with `VideoSummary.path` (it may be `{name}_1.mp4` when a file appeared at the chosen path during the encode).
12. **v1.4**: `PhotoSummary.timeKnown` and `FrameSummary.timeKnown` say whether `takenAt` has a real time of day (EXIF, or a file name with a time such as `20120901_111216`). When false — file-system dates, date-only names (`takenAt` at 00:00), hand-added photos (12:00) — show the date only, never "00:00". The mock backend fills it (`timeKnown: dateSource !== 'fileTime'`, false for hand-added photos).
13. **v1.6 (models loading vs failed)**: `AppInfo.modelsError: string | null`, with app event `models-changed` (`MODELS_CHANGED_EVENT` in `ui/src/ipc/events.ts`, no payload). Subscribe first, then call `get_app_info`, and re-read it on each `models-changed`. `modelsReady` means ready; a non-null `modelsError` means failed (show the message, scan/align stay unavailable); both false/null means still loading. The mock (`models=missing`) answers with the message from the start and emits `models-changed` one tick after install; `window.__FT_MOCK__.emitModelsChanged()` emits it on demand.
14. **v1.6 behaviour (QA N5)**: with `modelsError` set, the restored library, days and current frames are the same as with the models (read-only), so the Timelapse player and the exports keep working, and so do reviews, day choices and looks. Scan, Re-align, frame nudges, reference changes and adding a photo the scan never read answer `modelUnavailable`. The notice "Watching and exporting the frames you have still work" is true once the session has been opened with the models at least once. A session that never had them restores empty, so `modelsError` comes with no frames; the copy may want to allow for that.
15. **v1.7**: `open_path({ path })` opens a finished video in its default app. Pass `VideoSummary.path` (or a video path from the session's outputs) unchanged; anything else answers `notFound` with a message for a toast. Allowed while a job runs. Review previews: `imageUrl(base, { kind: 'preview', photoId, version: detail.previewVersion, width })` with `width` 640 or 1280 (`PREVIEW_WIDTHS`), only when `previewVersion` is non-null. Read `get_photo` again after a reference, crop, rotation, render-setting or nudge change: the version changes with them. The mock answers `previewVersion` for matched photos, serves `preview/{id}` with the aligned stand-in, and opens only `.mp4` outputs of its own exports.

## 6. Running and verifying

```sh
source $HOME/.cargo/env
cargo test -p facetimelapse                       # unit + mock-IPC + contract + real-photo pipeline (skips if photos/models absent)
cargo clippy -p facetimelapse --all-targets -- -D warnings
cargo fmt -p facetimelapse --check
FT_PHOTOS_DIR=/nonexistent cargo llvm-cov -p facetimelapse \
  --ignore-filename-regex '(src-tauri/src/(main|lib)\.rs|crates/|/benches/)' --summary-only
(cd ui && npm test)                               # TS half of the drift guard (contract.samples.test.ts)
FT_DATA_DIR=/tmp/ft FT_TRACE_STARTUP=1 FT_LOG_STDERR=1 \
  FT_DEV_AUTOLOAD="reference=/path/ref.jpg;folder=/path/photos" cargo run -p facetimelapse   # debug smoke
```

Env vars: `FT_DATA_DIR` (relocate data/cache/logs to `X/{data,cache/v1,logs}`), `FT_MODELS_DIR` (debug builds only), `FT_TRACE_STARTUP=1` (`startup.ms` milestones incl. `window shown by UI`), `FT_DEV_AUTOLOAD` (debug builds only), `FT_LOG`, `FT_LOG_STDERR`, `FT_PHOTOS_DIR`/`FT_REFERENCE_PHOTO`/`FT_PIPELINE_PHOTOS` (real-photo test), `FT_WRITE_CONTRACT_SAMPLES`. macOS: `MallocLargeCache` is set by the app itself (one relaunch at startup, see `main.rs`); setting it beforehand, to any value, skips the relaunch (`MallocLargeCache=1` = the system default, for A/B measurements).

## 7. Measurements (Apple M3 Max, 2026-10-24)

| What | Result |
|---|---|
| Line coverage, `src-tauri` (no real photos) | 94.3 % after the engine consolidation (was 93.2 %); `face-engine` 97.6 % (was 97.4 %), `timelapse-video` 96.7 % (unchanged) |
| Release binary (`strip = "debuginfo"`) | 34.0 MiB; 28.7 MiB with symbols stripped (suggest `strip = "symbols"` in the workspace release profile, owned by ENGINE) |
| `.app` bundle | 71.3 MiB (SFace model 36.9 MiB) |
| Cold start, release `.app`, restored session | process start → window created ≈ 205 ms, models ready ≈ 330 ms, UI `show()` ≈ 370–390 ms, first `get_session` ≈ 385 ms (first launch of a freshly built binary: 1.32 s, ~0.9 s of it before `main`, i.e. macOS assessment of the new unsigned binary) |
| Real photos, 50-photo sample, debug shell | reference 406 ms, crop update 142 ms, scan 89 photos/s, align 75 frames/s (720p), video ok. After the consolidation, on a machine at load 14–18 (other agents building): reference 566 ms, crop update 221 ms, scan 68 photos/s, align 59 frames/s — same code paths (the engine's loops), load-bound numbers |
| Extended backdrop (default) vs `dimmed`, 1080p | compose 5.0 vs 15.3 ms; full frame single-threaded 121–125 vs 125–126 ms (`crates/face-engine/BENCHMARKS.md` §5) |

## 8. Upgrading from an earlier build

What a session made with a build before fix pass 5 (Oct 2026) goes through once:

- **Re-align once.** The reference is re-analysed when the models load (`REFERENCE_VERSION` 2: landmarks from the framing ensemble on the unrotated photo), and the render fingerprint now hashes fixed units (fix pass 5). Either way the existing aligned frames no longer match: Timelapse shows them as stale until the next align (`Re-align` renders every day; the old frames are pruned with the other fingerprints). After that, restarts keep the frames, including after crop edits.
- **Rescan once.** `ANALYSIS_VERSION` 2 is part of the analysis fingerprint, so every folder's analysis cache is rebuilt by the next scan (~25 s for 3,600 photos); old cache files are deleted at the next startup prune, also for remembered folders. Thumbnails are keyed by the photo, not the analysis, and are kept.
- Day choices, moves, reviews, crops (carried over by rotation since v1.4) and exports are untouched.
