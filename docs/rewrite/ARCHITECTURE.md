# FaceTimelapse 2 — Architecture and Binding IPC Contract

> Status: **binding** for ENGINE, VIDEO, INTEGRATION and DESIGN agents. Owner: ARCHITECT.
> Companion docs: `LEGACY-SPEC.md` (what v1 does), `PRODUCT.md` / `DESIGN.md` (DESIGN agent).
> Change process: edit this file first, then `ui/src/ipc/contract.ts` and `src-tauri/src/ipc.rs`
> in the same change; the contract drift test (§7.6) must stay green.

---

## 1. Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | Tauri 2, latest 2.x (≥ 2.11.1 for the IPC-ACL fixes); Cargo workspace `crates/*` + `src-tauri`; UI in `ui/` | Given. Small binary, Rust core, native webview. |
| D2 | **Backend owns session state** (reference, library, decisions, frames, settings); frontend owns view state only | Given. One source of truth; restore on relaunch is a backend concern. |
| D3 | Commands = `snake_case` Rust fns, `camelCase` args/fields; long jobs return a `JobId` immediately and stream typed events over `tauri::ipc::Channel<T>`; `cancel_job` cancels | Given. No long-held invoke promises; cancel needs the id up front. |
| D4 | **One job at a time.** While a job runs every mutating command returns `busy`; reads and `cancel_job` always work | Removes every race the legacy app had (B6, B19) at negligible UX cost. |
| D5 | Images only over the `ftimg` async URI-scheme protocol, ids not paths, disk-cached, immutable URLs (`?v=`) | Given; also closes legacy arbitrary-file-read holes (B12). |
| D6 | Errors: one `IpcError { kind, message }`; `message` is friendly and safe to show | Given. |
| D7 | Persist the last session automatically (single session + MRU recents). **No multi-project UI in v1** | Given; answers PRODUCT.md's open question. Recents give the "welcome back" affordance cheaply. |
| D8 | Identity = **SFace 128-d cosine** on YuNet 5-point faces, **calibrated to the legacy 0–1 score scale** (confirmed ≥ 0.60, uncertain ≥ 0.40) | Legacy geometry embedding is pose-sensitive (B1); keeping the display scale keeps the UX and color semantics. |
| D9 | **Analysis is reference-independent and cached per photo** (faces + landmarks + embeddings + date); matching against the reference is a cheap in-memory pass | Changing the reference/crop never forces a rescan (fixes B2/B3); rescans are incremental. |
| D10 | Aligned frames are **persistent masters** (JPEG q95, 4:4:4) keyed by a render fingerprint; color normalization ("look") is applied **on read** | Survives restarts (fixes B11); toggling normalization needs no re-render. |
| D11 | Output size = `Resolution` preset with the VIDEO crate's bounding-box semantics; default **1080p**; `source` = crop pixel size (legacy) | Legacy produced 10 MB PNGs per frame; presets are what video needs anyway. |
| D12 | Dates: EXIF DateTimeOriginal → DateTimeDigitized → **filename** → EXIF DateTime → file time; naive local date-times, no time-zone conversion | The user's own library needed `fix_photo_dates.py`; fixes B22/B23. |
| D13 | Export never overwrites unless `overwrite: true`; video is cancellable and written via `*.partial` + rename | Fixes B8/B9. |
| D14 | Day-to-day photo moves use pointer/keyboard DnD (`@dnd-kit/core`), **not HTML5 DnD** | Tauri's native file-drop handler (needed for D-n-D of reference/folder) disables HTML5 DnD on Windows; also gives a keyboard path. |
| D15 | Server state in the UI via **TanStack Query**, view state via **Zustand**, grids via **TanStack Virtual** | Matches the user's global rules (server state ≠ client store). |
| D16 | Dialogs are opened **by Rust commands** (`pick_*`); the webview gets no dialog/fs permissions | Least privilege. |
| D17 | HEIC unsupported in v1 on all platforms, but counted and reported | No pure-Rust HEVC decoder; legacy silently failed anyway (B28). |
| D18 | No auto-updater in v1 (needs updater signing keys + release pipeline) | Recorded deferral; legacy updater only worked for signed builds. |
| D19 | No network access at runtime; fonts bundled; CSP forbids remote origins | Local-first product principle. |

---

## 2. Repository and module map

```
Cargo.toml                    workspace: members = ["crates/*", "src-tauri"], resolver = "2"
crates/
  face-engine/                pure Rust, no Tauri (ENGINE agent)
    src/ walk.rs              folder walk, extensions, file identity (size, mtime)
         decode.rs            EXIF orientation, DCT-scaled JPEG decode, other formats
         dates.rs             capture date: EXIF + filename patterns + file time
         detect.rs            YuNet (5 landmarks)
         recognize.rs         SFace align-crop 112×112 + 128-d embedding
         matching.rs          cosine, calibration → score, categorize, best face
         analysis.rs          analyze_photo(): decode → detect → embed → thumb (one pass)
         align.rs             Procrustes, refine, warp, backdrop, feather, residual
         color.rs             Oklab face-region stats, transfer → 3D LUT
         days.rs              grouping, auto best pick
         cache.rs             per-folder analysis cache file
         thumbs.rs            resize + JPEG encode buckets
         export.rs            YYYYMMDD naming, conflict policy
    benches/, tests/ (real-photo tests gated by FT_PHOTOS_DIR)
  timelapse-video/            pure Rust MP4/H.264 (openh264) encoder (VIDEO agent)
src-tauri/                    Tauri shell (INTEGRATION agent)
  build.rs                    tauri_build with AppManifest listing every command (§13)
  tauri.conf.json, capabilities/main.json, icons/
  src/ main.rs                → facetimelapse_lib::run()
       lib.rs                 builder: plugins, state, protocol, commands, setup
       ipc.rs                 contract types (verbatim §7.4)
       error.rs               internal AppError → IpcError (friendly messages, logging)
       paths.rs               AppPaths (FT_DATA_DIR override; 0700 dirs)
       grants.rs              path grants: dialog/drop/session paths the commands may use (§7.1, §13)
       navigation.rs          webview navigation allow-list (§13)
       state.rs               AppState { session, jobs, engine, paths, grants }; mutation gate, restore,
                              quit; sizes the work pool
       engine/{mod,real,fake}.rs  seam over what needs the models (analysis, render, reference detection)
       convert.rs             contract types ⇄ engine types (field mapping only)
       session/{model,derive,persist,frames,reference}.rs   decisions, derivations, session.json (+migration)
       jobs/{mod,scan,align,export_images,export_video}.rs   registry, cancel, throttled channels; thin
                              wrappers over the engine's loops (scan_folder, align_frames, export_images)
       commands/{app,reference,folder,review,days,frames,export}.rs
       protocol/{mod,route}.rs  ftimg router, disk cache, bounded LIFO miss pool (own rayon pool),
                              coalescing, panic-safe answers
ui/                           React 19 + TS strict + Vite (DESIGN agent visuals, INTEGRATION wiring)
  src/ ipc/contract.ts        verbatim §7.3
       ipc/client.ts          typed invoke wrapper, job helper (channel lifecycle), error narrowing
       ipc/images.ts          URL builder + width buckets
       ipc/mock/              fakeBackend.ts (in-memory contract impl), install.ts (mockIPC), fixtures
       state/                 queries.ts (TanStack Query keys/hooks), view.ts, jobs.ts, player.ts (Zustand)
       features/{setup,scan,review,days,align,timelapse,export}/
       components/ui/, hooks/, lib/{crop,video,dates,steps}.ts, styles/
  e2e/                        Playwright specs, fixtures (synthetic images), screenshot baselines
docs/rewrite/                 LEGACY-SPEC.md, ARCHITECTURE.md, PRODUCT.md, DESIGN.md
scripts/                      fetch-models.sh (pinned SHA-256), third-party-notices.py (bundle licences)
.github/workflows/            ci.yml (Rust + UI + Tauri build smoke), release.yml (bundles)
(the legacy Electron app — electron/, renderer/, tests/ — has been removed; LEGACY-SPEC.md documents it)
```

Dependency direction: `ui` ⟶(IPC)⟶ `src-tauri` ⟶ `face-engine`, `timelapse-video`. The two crates never depend on each other or on Tauri.

Integration seams `src-tauri` needs from `face-engine` (names are ENGINE's call; INTEGRATION adapts):
`walk(folder) → [FileEntry{path,size,mtime}]`, `analyze_photo(path, opts) → Analysis{oriented_size, taken_at, date_source, faces[≤3]{bounds, landmarks5, score, embedding}, thumb320_jpeg}`, `analyze_reference(path, rotation, crop) → {detection, embedding, whole-image face}`, `match_faces(ref_emb, faces) → (idx, cosine)`, `calibrate(cos) → score`, `categorize(score)`, `render_frame(source, src_landmarks, target_anchors, out_size, backdrop, adjust, refine) → {rgb, residual_px, face_stats}`, `color::lut(src_stats, ref_stats, mode, strength)`, `color::look_delta(src_stats, ref_stats, mode, strength) → Option<(exposure_ev, color_shift)>`, `AnalysisCache::{load,save}`, `thumbs::encode(img, bucket)`, `export::file_name(day, used, exists)`.

---

## 3. Runtime model

**Threads**
| Thread / pool | Size | Work |
|---|---|---|
| Tauri main | 1 | event loop, window, never blocks |
| Tokio (Tauri async runtime) | default | command handlers; anything > 1 ms goes to `spawn_blocking` or a job |
| `work` rayon pool | `max(1, available_parallelism − 1)` (15 on M3 Max) | scan analysis, align render, image export, look LUTs, warps. It is the **global** rayon pool, sized once at startup; the engine's loops run on whatever pool calls them, so there is no second pool. The video crate's frame-prep pool (alive only during an export, when the work pool is idle) gets the same size. |
| `protocol` pool | `clamp(cores/4, 2, 4)` workers + a private rayon pool of the same size | thumbnail/preview cache misses, **LIFO** queue (newest request = most likely visible) bounded at 4,096 (`MAX_QUEUED_MISSES`; past it the oldest queued request is answered 503 — a safety valve only: one Days year is ~365 misses, and a year's first visit must load every cell). Renders run inside the private pool's `install`, so their nested parallel work (rotations, LUTs, warps) never waits behind a scan or align on the work pool; read commands with parallel work (`get_frames`' reference look statistics) use it too. A panicking render answers 500 to every waiter and the worker lives on. |
| job driver | 1 per running job | owns cancel token, feeds the pool through a bounded queue (`2 × workers`), throttles events. On macOS it holds a user-initiated `NSProcessInfo` activity for the whole job (`jobs/keep_awake.rs`; add-photo analysis too), so App Nap does not drop an occluded or screen-locked app to background priority mid-job; the guard is a local of the job thread and ends on every path. No-op elsewhere. |

**Jobs**: `JobRegistry` holds at most one `RunningJob { id, kind, cancel: Arc<AtomicBool> }`. Workers check the token between photos (and between pipeline stages for big images). Events are throttled to **≤ 20/s (50 ms)**; `started` and the terminal event are always sent (a job that fails or is cancelled before it could count its work sends `started{total: 0}` first). Quitting cancels the running job and waits up to 5 s for it to stop, so its temporary files are gone before the process exits. Both last run-loop events do this (`src-tauri/src/quit.rs`): `ExitRequested` (last window closed) and `Exit` — on macOS, Cmd+Q, the app menu's Quit, the Dock's Quit and logout reach only `Exit`. Panics in workers are caught (`catch_unwind`) and become a per-item failure (align/export) or `JobFailed{internal}` (scan). Profile builds use `panic = "unwind"`.

**State**: `parking_lot::RwLock<Session>`. Jobs copy their inputs under a read lock, compute without locks, apply results under short write locks. The session is never locked across I/O: frame manifests are snapshotted under the lock and written outside it (a late, older snapshot never replaces a newer one), and opening the frame store of a new render fingerprint (manifest read, folder listing) happens outside it, re-checked before it is installed.

**Mutation gate**: mutating commands and job starts take one gate, waiting at most **2 s** before answering `busy` — short enough that no command thread is pinned behind a long change, long enough that quick overlapping changes (a crop drag, keyboard review) never see a spurious `busy`. `set_source_folder` walks the folder and loads its cache **before** taking the gate; if a newer folder choice (or a reset) started meanwhile, the older one is discarded (`cancelled`). One hand-added photo (`add_photo_to_day`) is analyzed at a time, after a busy check.

**Persistence**: every mutation marks the session dirty; a writer thread debounces **300 ms** (but never delays a write more than **2 s** while changes keep coming), writes it atomically (exclusively created temporary file, fsync, rename, fsync of the folder; the temporary file is removed on failure). On a parse or read failure the file is moved to `session.corrupt-{ts}.json` and a fresh session starts (logged, not shown); if it cannot be moved aside, nothing is saved this run rather than overwrite it. An export is recorded in the session (`pendingOutputs`, written at once, before its first temporary file) until it ends; it joins `outputs` only when it finished.

**Startup** (target: interactive < 1 s)
1. `run()`: resolve `AppPaths`, init `tracing` (file + stderr), empty `tmp/`.
2. Load `session.json` (sync, KBs). On a background thread: load the folder's analysis cache (≈2–5 MB, < 20 ms) and rebuild the library + matching in memory; then delete the temporary files of exports that never ended (`pendingOutputs`: only names this app makes, with the recorded pid, next to the recorded target; a record whose folder is unreadable right now is kept for the next start, at most 64). Commands wait for the library at most **3 s** (a stale network folder can take minutes), and once one wait has timed out the others do not wait at all: they answer without the library and the restore emits `session-changed` when it lands. It applies only what no newer command replaced meanwhile (a folder chosen again — even the same one — keeps its newer library), and releases its waiters even if it panics.
3. Create window with `visible: false`; the UI calls `getCurrentWindow().show()` after its first paint (fallback: Rust shows it after 3 s). No white flash.
4. Load ONNX models on a background thread after the window exists — release builds only from the bundle's resources, each file checked against its pinned SHA-256 — `modelsReady` flips; commands that need them await readiness (≤ 2 s) else `modelUnavailable`. A restored reference whose file or engine changed is then re-analyzed (waiting for a running job to end first) and `session-changed` is emitted. When the load ends, successfully or not, the backend records the outcome (`AppInfo.modelsReady`, or `AppInfo.modelsError` with the user-facing message) and then emits `models-changed` once (v1.6), before any re-analysis. The UI subscribes first and then reads `get_app_info`, so a load that ended before the subscription is not missed.
5. Prune caches (§5) on a low-priority thread 10 s after startup.

---

## 4. Data flow

```
 Setup ──set_reference_photo/crop──► reference (detection + embedding, in memory)
   │   ──set_source_folder─────────► FolderInfo (walk + cache hit count)
   ▼
 Scan (job) walk ─► partition by (size, mtime) vs analysis cache
                    hits ──────────────────────────────┐
                    misses ─► analyze_photo (pool) ─► cache (batched) + thumb320
                                                       ▼
                    match all faces vs reference ─► score/status per photo ─► days
   ▼
 Review  set_review_decision (uncertain → confirmed/rejected, undoable)
   ▼
 Days    groups by dayKey (+moves, +manual adds), auto best pick, selections, excluded days
   ▼
 Align (job) for each active day's selected photo:
           frame key = fingerprint ⊕ photo version ⊕ adjust → reuse master or render
           render: decode (DCT-scaled) → refine landmarks → Procrustes → warp + backdrop + feather
                   → face stats → master q95 + preview 640 + thumb 320
   ▼
 Timelapse  player/grid read `aligned/{id}?w=` (look applied on read), onion skin vs reference frame
   ▼
 Export  images (PNG/JPEG from masters + look) │ video (masters + look → resize → crossfade/caption → H.264)
```

### 4.1 Scan (incremental)
1. Walk (§9.1), natural-sort by relative path. Emit `started{total}`.
2. Load `analysis/{folderKey}.bin`. Discard it entirely if `formatVersion` or `engineFingerprint` differ.
3. Hit ⇔ same relative path, `size` and `mtime` (ns) equal. One `progress` event covers all hits (`fromCache`).
4. Misses → pool → `analyze_photo`. Results (including **noFace and failed**) go into the cache; flush every 2 s or 500 entries and on finish/cancel/fail (atomic rename).
5. On *complete* scans, entries for vanished files are dropped.
6. Matching + categorization + days are recomputed in memory (≈ 5 ms for 3,600 photos).
7. Cancel keeps everything analyzed so far (resumable); `scan.status = partial`.

### 4.2 What invalidates what

| Change | Analysis cache | Matching/status | Days | Frames (masters) | Look previews |
|---|---|---|---|---|---|
| Photo file edited (size/mtime) | entry | that photo | maybe | that frame | that frame |
| Reference photo / rotation / crop | — | **recomputed instantly** | recomputed | fingerprint → all stale | — |
| Render settings (resolution, backdrop, refine) | — | — | — | fingerprint → all stale | — |
| Frame adjust (nudge) | — | — | — | that frame | that frame |
| Day selection / move / exclude / review | — | — | that day | frames status may become `partial` | — |
| Look (normalize mode/strength) | — | — | — | — | all (lazy) |
| Engine version / models / detect params | **whole file** | all | all | fingerprint → all stale | — |

`fingerprint = blake3(RENDER_VERSION, engine fingerprint, reference.path, reference file version, rotationDeg, crop, aspect, detection anchors, outputSize, backdrop, refineLandmarks)[..16 hex]` (`face_engine::frames::render_fingerprint`; bumping `RENDER_VERSION` re-renders every frame).
`frameKey = blake3(fingerprint, photo version, adjust)[..12 hex]` (`frames::frame_key`); `FrameSummary.version = blake3(frameKey, lookKey)[..12 hex]` with `lookKey = LookSettings::cache_key` (`"off"` when the look is off).

### 4.3 User decisions (persisted, per source folder)
`reviews: PhotoId → ReviewDecision`, `dayMoves: PhotoId → DayKey`, `manualPhotos: [{path, dayKey}]`, `daySelections: DayKey → PhotoId`, `excludedDays: Set<DayKey>`, `adjusts: PhotoId → FrameAdjust`. Stored under `folders[canonicalFolderPath]` in `session.json`, so switching folders and back restores them. A selection pointing at a photo no longer in that day falls back to the day's auto pick (legacy fell back to "whatever is at that index").

---

## 5. On-disk layout

Tauri dirs (macOS shown; identifier `io.github.gingerman960.facetimelapse`), each created `0700` on Unix (they hold photo paths, face embeddings and thumbnails). `FT_DATA_DIR=X` relocates all three to `X/{data,cache,logs}` (tests, smoke runs). It is honoured in release builds too: it only moves the app's own data, and anyone who can set the app's environment can already read and write those files as the same user.

```
~/Library/Application Support/io.github.gingerman960.facetimelapse/   (app_data_dir)
  session.json                     user session (schema below), atomic writes
~/Library/Caches/io.github.gingerman960.facetimelapse/v1/               (app_cache_dir)
  analysis/{folderKey}.bin         postcard: {magic "FTAC", formatVersion, engineFingerprint, folder,
                                   entries[{relPath, size, mtimeNs, outcome: Analyzed{orientedSize, takenAt,
                                   dateSource, faces[≤3]{bounds, landmarks5 (normalized f32), score,
                                   embedding [f32;128] L2-normalized}} | NoFace{…} | Failed{kind}}]}
  thumbs/{id[0..2]}/{id}-{photoVersion}-{w}.jpg           source thumbs (q80 ≤640, q85 above)
  previews/{id}-{previewVersion}-{w}.jpg                    v1.7 `preview` route (LRU: >256 MB ⇒ 192 MB)
  reference/{refVersion}-{w}.jpg, reference/frame-{refStateVersion}-{w}.jpg
  frames/{fingerprint}/manifest.bin                         postcard v2: per photo {frameKey, residualPx, faceStats[6]} + reference look stats
  frames/{fingerprint}/m/{photoId}-{frameKey}.jpg           master (q95, 4:4:4, output size)
  frames/{fingerprint}/p/{photoId}-{frameKey}-{w}.jpg       previews 160/320/640/1280 (look off)
  frames/{fingerprint}/look-{lookKey}/{photoId}-{frameKey}-{w|full}.jpg   look-applied views (lazy)
  tmp/                             emptied at startup
~/Library/Logs/io.github.gingerman960.facetimelapse/facetimelapse.log  (tracing, 5 MB × 3 rotation)
```

Keys: `PhotoId = hex(blake3(canonical absolute path))[0..16]`; `photoVersion = hex(blake3(size ‖ mtimeNs))[0..8]`; `folderKey = hex(blake3(canonical folder path))[0..16]`.

Pruning (startup + 10 s; `face_engine::cache::prune`): no analysis file modified in the last 10 minutes is touched, and each is re-inspected right before it is deleted (a scan may be replacing it); unreadable or other-format files go; a file of **another analysis fingerprint** (models, detector settings, `ANALYSIS_VERSION`) goes only after 30 days without use, whatever its folder — so two builds sharing one cache folder (a dev build next to the installed app, a beta next to stable) leave each other's caches alone — and only once this launch's models have loaded (with missing or unreadable models no file is judged by fingerprint); other analysis files unused for 90 days (loading or a hit-only rescan refreshes a file's age; the caches of the current folder, of folders with remembered decisions and of recent folders are never pruned); keep the **3 most recent fingerprints** under `frames/` (never the current one, nor one younger than an hour); `thumbs/` LRU down to 1.5 GB when above 2 GB; `look-*` dirs older than the current look are deleted; `reference/` files of other reference versions are deleted.
Sizes for 3,593 photos @1080p: analysis ≈ 3 MB, thumbs ≈ 90 MB, masters ≈ 1.4 GB per fingerprint.

`session.json` (internal, versioned):
```jsonc
{ "version": 2,
  "reference": { "path": "...", "rotationDeg": 0, "crop": {"x":0,"y":0,"width":3200,"height":2368}, "aspect": "free" },
  "folder": "/abs/folder",
  "render": { "resolution": "1080p", "backdrop": "extended", "refineLandmarks": true },
  "look": { "normalize": "off", "strength": 0.7 },
  "imageExport": { "format": "png", "jpegQuality": 95, "overwrite": false },
  "video": { /* VideoSettings */ },
  "lastScan": { "folder": "...", "at": "2026-10-24T10:00:00", "summary": { /* ScanSummary */ } },
  "folders": { "/abs/folder": { "reviews": {}, "dayMoves": {}, "manualPhotos": [], "daySelections": {}, "excludedDays": [], "adjusts": {} } },
  "recents": { "references": [], "folders": [] },
  "outputs": [ "/abs/exported/dir", "/abs/video.mp4" ],          // most recent first, ≤ 200
  "pendingOutputs": [ { "path": "/abs/video.mp4", "video": true, "pid": 4242 } ],
  "lastEngineFingerprint": "3f064c952c22cc3a" }                  // null until a start had the models
// reference.matchEmbedding (optional): the embedding matching uses while the
// crop holds no face — the last detected crop's of the same photo.
```

**Starting without the models (read-only restore, QA N5).** Analysis caches and frame stores are keyed by the engine fingerprint (`engineFingerprint` above; the render fingerprint mixes it in). The engine has a fingerprint only while its model files are present *and* are the pinned files (`face_engine::model::MODELS_FINGERPRINT`, a blake3 prefix that is cheaper than the SHA-256 check the load does). An altered file therefore counts as missing. A failed fingerprint is remembered per (length, mtime) of the two files, so an unchanged broken set is not hashed again on every call. Every start that has one remembers it in `session.json` as `lastEngineFingerprint`. A start without readable models uses the remembered value instead, so the restore loads that folder's analysis cache (read-only), derives the same library and days, and opens the same frame store. Current frames stay current and can be watched, adjusted for look and exported. Day choices, reviews and moving an analyzed folder photo to a day still work: they need no detection. Everything that needs detection answers `modelUnavailable`, because it calls `require_models` before touching anything: scan, align, a frame nudge, a new reference or crop/rotation change, and adding a photo the folder's cache does not hold. Nothing is written with the remembered value: no analysis cache is saved without the models. Pruning judges no analysis cache by fingerprint without loaded models (as before). A remembered value from another engine validates nothing: caches are only read when their header's fingerprint equals it exactly. With the models present, the live fingerprint is used and remembered, whatever was remembered before. A session saved before this field existed, or never opened with the models, has nothing remembered: a start without models then shows an empty library, as before. One start with the models fixes that.

---

## 6. Image protocol `ftimg`

Registered with `register_asynchronous_uri_scheme_protocol("ftimg", …)`. Base URL is `AppInfo.imageBaseUrl`: `ftimg://localhost/` on macOS/Linux, `http://ftimg.localhost/` on Windows (never hard-code it in the UI).

| Route | Serves | `w` buckets | Generated |
|---|---|---|---|
| `thumb/{photoId}?w=&v={photoVersion}` | source photo, EXIF-oriented, fit inside w×w | 160, 320, 640, 1280, 2048 | 320 during scan; others on demand |
| `aligned/{photoId}?w=&v={frameVersion}` | aligned frame for the current fingerprint with the current look; no `w` ⇒ master size | 160, 320, 640, 1280, (none) | 320/640 at align; others on demand |
| `reference?w=&v={reference.image.version}` | rotated reference image (whole) | 320, 640, 1280, 2048 | on demand |
| `reference/frame?w=&v={reference.version}` | reference crop rendered at output aspect (onion skin base) | 160, 320, 640, 1280 | on demand |
| `preview/{photoId}?w=&v={PhotoDetail.previewVersion}` (v1.7) | the aligned frame the photo would get now (Review candidates), look off; `w` required | 640, 1280 | on demand into `previews/` |

Rules
- `photoId` must match `^[0-9a-f]{16}$` and be known to the session (library or manual adds); unknown ⇒ **404**. No file paths ever appear in URLs.
- `w` is rounded **up** to the next bucket (max bucket if larger); non-numeric ⇒ **400**. Only `GET`; other methods ⇒ **405**.
- `v` equal to the current version ⇒ `Cache-Control: public, max-age=31536000, immutable`; missing/different ⇒ current content with `Cache-Control: no-store`.
- Headers always: `Content-Type: image/jpeg`, `X-Content-Type-Options: nosniff`, `Vary: Origin`. `Access-Control-Allow-Origin` is sent only to the app's own origin (`tauri://localhost`, `http(s)://tauri.localhost`, and the dev server in debug builds), echoed back — never `*`. The UI loads images with `<img>` and draws them on canvases without reading pixels back, which needs no CORS at all.
- `aligned` for a photo without a frame ⇒ **404** (UI shows placeholder). Decode failure ⇒ **500**, plain-text body, logged.
- `preview` (v1.7) renders any analysed photo with a matched face against the current reference, crop, render settings (backdrop: `extended` by default) and the photo's nudge — align's geometry, at the preview size (`out.fit_within(w)`, never above the frame size). It differs from align in only two ways. It uses the analysis landmarks as they are: no re-detection, so it needs no models and works in the read-only restore of §5. And it decodes only what the preview needs. It never writes a master, a manifest entry or anything under `frames/`. Results go to `previews/`, an LRU by mtime (a hit touches the file). The prune thread bounds it at startup and every 5 minutes, never inside a render: above 256 MB, down to 192 MB, never counting or deleting in-flight temporary files (`.…tmp`). The version is the frame key align would use (render fingerprint, photo version, nudge). A crop, rotation, reference, render-setting or nudge change therefore gives a new `PhotoDetail.previewVersion`. No matched face, no reference face, or an unknown id ⇒ **404**; a missing `w` ⇒ **400**. It shares the miss pool, coalescing, decode budget, render pool, 503 and CORS rules below.
- Hits are served from disk directly in the handler thread (< 5 ms). Misses go to the `protocol` pool (LIFO, ≤ 4,096 queued — a queued miss is a request handle, not pixels; past that the oldest is answered **503**) with **in-flight coalescing** (one render per cache key; concurrent requests await it). Every request is answered exactly once: a panicking render answers **500** to all its waiters (the next request renders again), a request lost on shutdown **503**. Writes are atomic (exclusive tmp + rename) but not fsynced — like every rebuildable image cache (scan thumbnails, aligned masters and previews: `face_engine::cache::write_atomic_cache`); on macOS each fsync is a full drive-cache flush, and syncing every file had cost the scan 13 % and align 35 % of their throughput (fix pass 3 A/B, same load: 151 → 175 photos/s, 58 → 87 frames/s). A hit that a power loss left cut short (no JPEG SOI…EOI) is treated as a miss and rendered again, and a 160/320 thumbnail is never derived from a cut-short scan thumbnail. A master cut short counts as missing everywhere: the frame list drops it when the session opens (`FrameStore::load_usable_manifest`), align renders it again (`has_master`), `load_master` and the image export's byte copy answer `notFound` (never a decode with a filled-in tail), and the full-size `aligned` route — whose cache file is the master itself — answers 404 instead of rendering over it. The analysis cache, frame manifests and `session.json` stay fsynced (`cache::write_atomic`).
- UI chooses `w = bucket(cssWidth × devicePixelRatio)`; `<img decoding="async" loading="lazy">` with fixed aspect boxes (no CLS).

---

## 7. Binding IPC contract

### 7.1 Conventions
- `invoke(name, args)`; `name` is the Rust fn name (`snake_case`), arg keys and all JSON fields are `camelCase`.
- Every command is `async` on the Rust side and returns `Result<T, IpcError>`; the JS promise rejects with an `IpcError` object (never a string).
- `Option<T>` ⇄ `T | null`; fields are always present (no `skip_serializing_if`, no missing keys). Integers are `u32` (counts, pixels) or `u64` (bytes, ms) ⇄ `number`. Floats are `f64`.
- Geometry: everything is **normalized to [0,1]** of the image it belongs to, **except** `ReferenceState.crop` (pixels of `ReferenceImage.size`) and `Size` (pixels).
- Anchor order everywhere: `[leftEye, rightEye, noseTip, mouthLeft, mouthRight]`, left/right = **image** left/right (subject's right eye first).
- Jobs: `start_*` validates, returns `JobId`, then events on the channel: `started` → `progress`* → exactly one of `finished` | `failed` | `cancelled`. The UI must treat the terminal event as the end of the job, then re-query (`get_session`, etc.).
- Busy rule (D4): while `activeJob != null`, all mutating commands reject with `busy`. Read commands: `get_app_info`, `get_session`, `get_photos`, `get_photo`, `get_days`, `get_frames`; plus `cancel_job`, `reveal_path`, `open_path` (v1.7).
- `pick_*` commands return `null` when the user cancels the dialog (not an error).
- **Path grants (v1.3)**: commands take only paths the user chose. `set_reference_photo`, `set_source_folder` and `add_photo_to_day(path)` accept a path picked in a native dialog, dropped onto the window (OS drag-and-drop — Tauri forwards the drop to the webview and then runs the app's handler in the same main-thread callback, and commands are dispatched on the main thread, so the grant exists before any command can use it), inside such a folder, or one of the session's own paths (current/recent reference and folder, folders with remembered decisions, hand-added photos — so recents keep working across restarts). `start_export_images` takes exactly a folder picked with `pick_export_folder` or one exported to before; `start_export_video` exactly a path from `pick_video_path` or an earlier finished video. A path is checked in two steps: its **spelling** must lie inside a grant as spelled — otherwise `permissionDenied` with no file-system access at all (no existence oracle; on Windows no UNC/WebDAV/`\\?\GLOBALROOT` path nobody chose is ever opened) — and then the path and that grant are **resolved** (symlinks followed) and the resolved path must still lie inside the resolved grant, so a directory symlink inside a granted folder cannot lead elsewhere. Pass paths exactly as the dialog, the drop or the session gave them (the UI does). `reveal_path` follows the same rule with the session's outputs as the grants.
- `busy` also answers a mutation that waited 2 s for another change to finish (§3, message "…still applying your previous change…").
- App event `session-changed` (§7.4 `SESSION_CHANGED_EVENT`, no payload, v1.2): the backend changed session state on its own, not in answer to a command (dev autoload; a stale restored reference re-analyzed once the models load). The UI re-queries `get_session` and the queries derived from it. Startup restore emits nothing when it finishes within the 3 s that `get_session` waits for it; a slower one emits `session-changed` when it lands (v1.3).
- App event `models-changed` (§7.4 `MODELS_CHANGED_EVENT`, no payload, v1.6): the startup model load ended, successfully or not. It is emitted once per run, after the outcome is recorded. The UI re-reads `get_app_info`: `modelsReady` true means ready, `modelsError` non-null means the load failed, and both false/null means it is still loading. Ordering: subscribe first, then call `get_app_info`. A load that ended before the subscription is then seen in that read, and a later event only repeats the outcome. `modelsError` stays set for the rest of the run. Commands that need the models still retry loading on demand. If such a retry ever succeeds (unsupported: models do not appear mid-run), `modelsReady` turns true and `modelsError` null, with no second event. The UI cannot emit app events: the capability grants `listen`/`unlisten` only, not `emit`/`emit_to` (§13).
- App event `show-keys` (§7.4 `SHOW_KEYS_EVENT`, no payload, v1.8): the user chose Help › Keyboard Shortcuts (⌘/) in the native menu bar (`src-tauri/src/menu.rs`: Tauri's default menu with that item appended to its Help submenu; on macOS that submenu is the app's Help menu). The UI lays its Keys card over the current screen (it opens it; a second choice keeps it open). Emitted only by the shell's menu handler; like the other app events it is listen-only for the webview, so no new permission.

### 7.2 Commands

| # | Command | Args | Returns | Errors (besides `internal`) |
|---|---|---|---|---|
| 1 | `get_app_info` | — | `AppInfo` | — |
| 2 | `get_session` | — | `SessionSnapshot` | — |
| 3 | `reset_session` | — | `SessionSnapshot` (empty; caches kept) | busy |
| 4 | `pick_reference_photo` | — | `ReferenceState \| null` | busy, unsupportedFormat, decodeFailed, modelUnavailable |
| 5 | `set_reference_photo` | `path` (granted, §7.1) | `ReferenceState` (default crop, detection run) | busy, notFound, permissionDenied, unsupportedFormat, decodeFailed, modelUnavailable |
| 6 | `set_reference_rotation` | `rotationDeg` ∈ [−45, 45] | `ReferenceState` (the crop follows the photo: same part framed, same size; nudged inside, or shrunk with its aspect, only when the new canvas requires; never re-centred) | busy, notReady, invalidArgument |
| 7 | `set_reference_crop` | `crop`, `aspect` | `ReferenceState`; re-matches library in memory | busy, notReady, invalidArgument |
| 8 | `pick_source_folder` | — | `FolderInfo \| null` | busy, permissionDenied |
| 9 | `set_source_folder` | `path` (granted, §7.1) | `FolderInfo` | busy, notFound, invalidArgument (not a dir), permissionDenied, cancelled (a newer folder choice replaced it) |
| 10 | `clear_scan_cache` | `scope` | `ClearCacheResult` | busy, io |
| 11 | `start_scan` | `onEvent: Channel<ScanEvent>` | `JobId` | busy, notReady (no folder), noFaceInReference, modelUnavailable |
| 12 | `cancel_job` | `jobId` | `null` (unknown/finished id is a no-op) | — |
| 13 | `get_photos` | `query: PhotoQuery` | `PhotoSummary[]` (relPath order) | notReady |
| 14 | `get_photo` | `photoId` | `PhotoDetail` | notFound |
| 15 | `set_review_decision` | `photoIds`, `decision` (any status: also rescues a false `rejected`) | `LibraryCounts` | busy, notFound, invalidArgument (`confirmed` on a `noFace`/`failed` photo) |
| 16 | `get_days` | — | `DayGroup[]` (dayKey asc) | notReady |
| 17 | `select_day_photo` | `dayKey`, `photoId` | `DayGroup` | busy, notFound, invalidArgument (photo not in day) |
| 18 | `move_photo_to_day` | `photoId`, `dayKey` | `DaysPatch` | busy, notFound, invalidArgument (bad dayKey) |
| 19 | `add_photo_to_day` | `dayKey`, `path \| null` (null ⇒ native dialog; a path must be granted, §7.1) | `DaysPatch \| null`. A photo of the folder becomes a confirmed move (analyzed first if the scan has not reached it; the analysis is cached like a scan's); a photo from elsewhere is added by hand. | busy, notFound, permissionDenied, unsupportedFormat, decodeFailed, noFaceDetected (also for a folder photo whose status is `noFace`/`failed`), cancelled (the folder changed while the photo was being read) |
| 20 | `set_day_excluded` | `dayKey`, `excluded` | `DayGroup` | busy, notFound |
| 21 | `start_align` | `render: RenderSettings`, `onEvent: Channel<AlignEvent>` | `JobId` | busy, notReady (no active days), noFaceInReference |
| 22 | `get_frames` | — | `FramesView` | — |
| 23 | `set_frame_adjustment` | `photoId`, `adjust` | `FrameSummary` (re-rendered synchronously, ≤ 150 ms) | busy, notFound, invalidArgument |
| 24 | `set_look` | `look` | `FramesView` | busy, invalidArgument |
| 25 | `pick_export_folder` | — | `string \| null` | busy |
| 26 | `start_export_images` | `dir` (from `pick_export_folder`, or an earlier export folder), `settings`, `onEvent: Channel<ExportImagesEvent>` | `JobId` | busy, notReady (no frames), invalidArgument, permissionDenied |
| 27 | `pick_video_path` | `suggestedName` | `string \| null` (ensures `.mp4`) | busy |
| 28 | `start_export_video` | `path` (from `pick_video_path`, or an earlier finished video), `settings`, `onEvent: Channel<ExportVideoEvent>` | `JobId`. An existing file is replaced only if the save dialog confirmed exactly that name or the app wrote it; otherwise a file that appears there during the encode is kept and the video goes to `{name}_1.mp4` (`VideoSummary.path` reports where). | busy, notReady (< 2 frames), permissionDenied, invalidArgument (incl. infeasible pace, an unconfirmed existing file, a caption format that cannot format a date such as `%H`) |
| 29 | `reveal_path` | `path` (must be an output written by this app) | `null` | notFound (an output of ours that is gone), invalidArgument (anything else — the same answer whether or not it exists) |
| 30 | `set_video_settings` (v1.5) | `settings: VideoSettings` | `VideoSettings` (as saved). Validates like `start_export_video` minus the frame-dependent checks (enough frames, a duration the holds fit in) and saves `session.video` (debounced), so pace, crossfade and caption survive a restart without an export. A light change: no mutation gate, works while a job runs (a running export keeps the settings it started with); no `session-changed`. | invalidArgument (pace, crossfade, holds, quality or caption out of range; a caption format that cannot format a date such as `%H`) |
| 31 | `open_path` (v1.7) | `path` (a finished video export: an `.mp4` in the session's outputs, spelled exactly as recorded) | `null`. Opens it in the default app (`tauri-plugin-opener` from Rust); allowed while a job runs. Decided without touching the disk for anything else (relative, remote/UNC spelling, other extension, not an output). The output must still be a regular file (a link is never followed). | notFound (every refusal, a deleted video included: one answer, no existence oracle) |

Validation highlights: paths must be absolute, granted (§7.1) and exist; reference must have a supported extension; `crop` must lie within the image (1 px tolerance), be ≥ 32×32 px, and match the aspect within 1 % unless `free`; `dir` must be an existing writable directory; video `path` must end in `.mp4` with an existing parent; `adjust`: `|dx|,|dy| ≤ 0.25`, `scale ∈ [0.5, 2]`, `|rotationDeg| ≤ 20`; `look.strength ∈ [0,1]`; `jpegQuality ∈ [50,100]`; video settings are validated with the VIDEO crate's rules (fps 1–60, duration 1–120 s, crossfade ≤ 30 frames, holds ≤ 10 s, caption size 0.01–0.2, strftime format).

Friendly messages (examples; `message` must never contain stack traces):

| kind | example message |
|---|---|
| noFaceInReference | "No face found inside the crop. Widen the crop or pick another reference photo." |
| noFaceDetected | "No face found in IMG_2014.jpg, so it can't be added to this day." |
| notFound | "This file is no longer there: /…/IMG_20140815.jpg" |
| unsupportedFormat | "HEIC photos aren't supported yet. Export them as JPEG first." |
| busy | "Another task is running. Wait for it to finish or cancel it." |
| notReady | "Choose a source folder first." / "Align at least one day first." |
| permissionDenied | "FaceTimelapse isn't allowed to read that folder. Grant access in System Settings › Privacy & Security." / not granted (§7.1): "FaceTimelapse can only use files and folders you choose or drop onto its window." |
| diskFull | "The disk is full. Free some space and try again." |
| modelUnavailable | "The face models couldn't be loaded. Reinstall FaceTimelapse." |

### 7.3 TypeScript — copy verbatim to `ui/src/ipc/contract.ts`

```ts
// ui/src/ipc/contract.ts
// BINDING IPC CONTRACT — copied verbatim from docs/rewrite/ARCHITECTURE.md §7.3.
// Rust mirror: src-tauri/src/ipc.rs. Change the doc first, then both files.
import type { Channel } from '@tauri-apps/api/core'

/* ───────────────────────── Scalars ───────────────────────── */
/** 16 lowercase hex chars: blake3(canonical absolute path). Stable across launches. */
export type PhotoId = string
/** Opaque job id, unique per app run. */
export type JobId = string
/** Calendar day 'YYYY-MM-DD'. */
export type DayKey = string
/** Wall-clock local time without offset: 'YYYY-MM-DDTHH:MM:SS'. */
export type LocalDateTime = string
/** Opaque cache-busting token (lowercase hex). */
export type Version = string

export interface Point { x: number; y: number }
/** Pixel size. */
export interface Size { width: number; height: number }
export interface Rect { x: number; y: number; width: number; height: number }

/* ───────────────────────── Errors ───────────────────────── */
export type ErrorKind =
  | 'noFaceInReference'
  | 'noFaceDetected'
  | 'notFound'
  | 'invalidArgument'
  | 'unsupportedFormat'
  | 'decodeFailed'
  | 'permissionDenied'
  | 'diskFull'
  | 'io'
  | 'busy'
  | 'cancelled'
  | 'notReady'
  | 'modelUnavailable'
  | 'encodeFailed'
  | 'internal'

/** Every command rejects with exactly this shape. `message` is user-facing. */
export interface IpcError { kind: ErrorKind; message: string }

/* ───────────────────────── App ───────────────────────── */
export type Platform = 'macos' | 'windows' | 'linux'

export interface AppInfo {
  version: string
  platform: Platform
  /** Image protocol base, ends with '/': 'ftimg://localhost/' or 'http://ftimg.localhost/' (Windows). */
  imageBaseUrl: string
  modelsReady: boolean
  /** v1.6: why the background model load failed (user-facing); null while loading and once ready. */
  modelsError: string | null
  /** Worker threads used by jobs. */
  parallelism: number
  dataDir: string
  cacheDir: string
}

/* ───────────────────────── Reference ───────────────────────── */
export type AspectPreset = 'free' | '1:1' | '4:3' | '3:4' | '4:5' | '16:9' | '9:16'

/** Normalized [0,1] to its image. anchors: [leftEye, rightEye, noseTip, mouthLeft, mouthRight] (image left/right). */
export interface FaceGeometry {
  bounds: Rect
  anchors: Point[]
  confidence: number
}

export interface ReferenceImage {
  path: string
  fileName: string
  /** Clockwise degrees applied after EXIF orientation, [-45, 45]; canvas expands, black fill. */
  rotationDeg: number
  /** Rotation that levels the eyes (-atan2(dy, dx) in degrees); null if no face. Apply only if |v| > 0.3. */
  autoRotationDeg: number | null
  /** Pixel size after orientation + rotation; crop coordinates live in this space. */
  size: Size
  /** Largest face in the whole rotated image (for "Center face"); normalized to `size`. */
  face: FaceGeometry | null
  /** Version for the `reference` image route. */
  version: Version
}

export interface ReferenceDetection {
  /** 5 anchors normalized to the crop. */
  anchors: Point[]
  /** Face bounds normalized to the crop. */
  faceBox: Rect
  confidence: number
}

export interface ReferenceState {
  image: ReferenceImage
  /** Pixels in `image.size` space. */
  crop: Rect
  aspect: AspectPreset
  /** null ⇒ no face inside the crop: show an inline hint; scan/align are disabled. */
  detection: ReferenceDetection | null
  /** Version for the `reference/frame` route (changes with rotation/crop). */
  version: Version
}

/* ───────────────────────── Folder & library ───────────────────────── */
export interface FolderInfo {
  path: string
  name: string
  /** Supported image files found (recursive). */
  imageCount: number
  /** Files with a valid cached analysis. */
  analyzedCount: number
  /** Files skipped for their format (e.g. .heic). */
  unsupportedCount: number
}

export type CacheScope = 'folder' | 'all'
export interface ClearCacheResult { removedEntries: number; freedBytes: number }

export type MatchStatus = 'confirmed' | 'uncertain' | 'rejected' | 'noFace' | 'failed'
export type ReviewDecision = 'pending' | 'confirmed' | 'rejected'
export type DateSource = 'exif' | 'filename' | 'fileTime' | 'manual'

export interface PhotoSummary {
  id: PhotoId
  fileName: string
  /** Relative to the source folder; absolute for manually added photos outside it. */
  relPath: string
  takenAt: LocalDateTime
  dateSource: DateSource
  /** v1.4: takenAt has a real time of day (EXIF, or a file name with a time). False for file times, date-only names and hand-added photos: show the date only. */
  timeKnown: boolean
  /** Effective day (after user moves). */
  dayKey: DayKey
  /** Calibrated [0,1]; >= 0.60 confirmed, >= 0.40 uncertain. 0 for noFace/failed. */
  score: number
  status: MatchStatus
  review: ReviewDecision
  /** In the day pool: review === 'confirmed' || (review === 'pending' && status === 'confirmed'). */
  included: boolean
  /** Oriented pixel size. */
  size: Size
  /** Bounds of the matched face, normalized [0,1] to the oriented image; null for noFace/failed. */
  faceBox: Rect | null
  version: Version
}

export interface PhotoDetail {
  summary: PhotoSummary
  path: string
  /** Up to 3 faces, normalized to the photo. */
  faces: FaceGeometry[]
  /** Index into `faces` of the face matched to the reference. */
  matchedFace: number | null
  /** Raw cosine similarity of the matched face. */
  rawSimilarity: number | null
  /** v1.7: `v` of the preview route (the aligned frame this photo would get now); null without a matched face or a reference face. */
  previewVersion: Version | null
}

export interface PhotoQuery {
  /** null ⇒ all photos. */
  statuses: MatchStatus[] | null
}

export interface LibraryCounts {
  total: number
  confirmed: number
  uncertain: number
  rejected: number
  noFace: number
  failed: number
  /** Uncertain photos still awaiting a decision. */
  reviewPending: number
  included: number
  /** Day groups, including excluded days. */
  days: number
  /** Non-excluded days = frames to align. */
  activeDays: number
}

/* ───────────────────────── Jobs (shared) ───────────────────────── */
export type JobKind = 'scan' | 'align' | 'exportImages' | 'exportVideo'
export interface ActiveJob { jobId: JobId; kind: JobKind }
export interface JobStarted { jobId: JobId; total: number }
export interface JobFailed { jobId: JobId; error: IpcError }
export interface JobCancelled { jobId: JobId; done: number }

/* ───────────────────────── Scan ───────────────────────── */
export interface ScanProgress {
  jobId: JobId
  done: number
  total: number
  fromCache: number
  analyzed: number
  confirmed: number
  uncertain: number
  rejected: number
  noFace: number
  failed: number
  currentFile: string | null
  photosPerSecond: number
  etaMs: number | null
  /** Confirmed/uncertain photos finished since the previous event (max 64), for the live mosaic. */
  recent: ScanRecent[]
}

/** Enough to render a mosaic tile without a round trip: thumb URL = thumb/{id}?v={version}. */
export interface ScanRecent {
  id: PhotoId
  /** Photo version (thumb route). */
  version: Version
  dayKey: DayKey
  status: 'confirmed' | 'uncertain'
}

export interface ScanSummary {
  jobId: JobId
  total: number
  fromCache: number
  analyzed: number
  confirmed: number
  uncertain: number
  rejected: number
  noFace: number
  failed: number
  durationMs: number
}

export type ScanEvent =
  | ({ type: 'started' } & JobStarted)
  | ({ type: 'progress' } & ScanProgress)
  | ({ type: 'finished' } & ScanSummary)
  | ({ type: 'failed' } & JobFailed)
  | ({ type: 'cancelled' } & JobCancelled)

/* ───────────────────────── Days ───────────────────────── */
export interface DayGroup {
  dayKey: DayKey
  /** Included photos of the day, score desc, then takenAt asc. Never empty. */
  photoIds: PhotoId[]
  selectedId: PhotoId
  autoSelectedId: PhotoId
  /** True when selectedId was chosen by the user. */
  manualSelection: boolean
  excluded: boolean
}

export interface DaysPatch { upserted: DayGroup[]; removed: DayKey[] }

/* ───────────────────────── Align & frames ───────────────────────── */
/** Bounding-box presets shared with timelapse-video: fit inside 3840×2160 / 1920×1080 / 1280×720, oriented like the crop. */
export type Resolution = 'source' | '2160p' | '1080p' | '720p'
export type BackdropMode = 'dimmed' | 'blurred' | 'black' | 'extended'

export interface RenderSettings {
  resolution: Resolution
  backdrop: BackdropMode
  /** Re-detect landmarks around the matched face at render time. */
  refineLandmarks: boolean
}

export interface AlignProgress {
  jobId: JobId
  done: number
  total: number
  reused: number
  failed: number
  currentPhotoId: PhotoId | null
  framesPerSecond: number
  etaMs: number | null
  /** Frames finished since the previous event (max 64). */
  recent: AlignRecent[]
}

/** Enough to render an aligned tile: aligned URL = aligned/{id}?v={version}. */
export interface AlignRecent {
  id: PhotoId
  /** Frame version (aligned route). */
  version: Version
  dayKey: DayKey
}

export interface AlignFailure { photoId: PhotoId; error: IpcError }

export interface AlignSummary {
  jobId: JobId
  total: number
  rendered: number
  reused: number
  failed: AlignFailure[]
  outputSize: Size
  durationMs: number
}

export type AlignEvent =
  | ({ type: 'started' } & JobStarted)
  | ({ type: 'progress' } & AlignProgress)
  | ({ type: 'finished' } & AlignSummary)
  | ({ type: 'failed' } & JobFailed)
  | ({ type: 'cancelled' } & JobCancelled)

/** Post-Procrustes correction in output space. Identity: { dx: 0, dy: 0, scale: 1, rotationDeg: 0 }. */
export interface FrameAdjust {
  /** Fraction of output width. */
  dx: number
  /** Fraction of output height. */
  dy: number
  scale: number
  rotationDeg: number
}

export interface FrameSummary {
  photoId: PhotoId
  dayKey: DayKey
  takenAt: LocalDateTime
  /** v1.4: as `PhotoSummary.timeKnown`. */
  timeKnown: boolean
  /** Version for the `aligned` route (geometry + look). */
  version: Version
  /** RMS anchor error after alignment, output pixels. */
  residualPx: number
  adjust: FrameAdjust
  /** What the current look does to this frame's face region (§9.6). null when look is off or stats are missing. */
  lookDelta: LookDelta | null
}

export interface LookDelta {
  /** Face-region exposure change in stops: 3·log2(L_out / L_in) on Oklab mean L. Positive = brightened. */
  exposureEv: number
  /** Face-region chroma (white-balance) shift: 100 × Oklab (a,b) mean distance moved. 0 in 'exposure' mode; ≈2 ≈ just noticeable. */
  colorShift: number
}

export type FramesStatus = 'none' | 'stale' | 'partial' | 'complete'
export type NormalizeMode = 'off' | 'exposure' | 'exposureAndColor'
export interface LookSettings { normalize: NormalizeMode; strength: number }

export interface FramesView {
  status: FramesStatus
  outputSize: Size | null
  render: RenderSettings
  look: LookSettings
  /** Reference anchors normalized to the output frame (anchor overlay). */
  referenceAnchors: Point[] | null
  /** Existing frames of the current fingerprint for active days, chronological. */
  frames: FrameSummary[]
}

/* ───────────────────────── Export: images ───────────────────────── */
export type ImageFormat = 'png' | 'jpeg'
export interface ImageExportSettings {
  format: ImageFormat
  /** 50..100, used for 'jpeg'. */
  jpegQuality: number
  /** false ⇒ never overwrite: YYYYMMDD_1.ext, _2, ... */
  overwrite: boolean
}

export interface ExportProgress {
  jobId: JobId
  done: number
  total: number
  currentFile: string | null
  etaMs: number | null
}

export interface ExportImagesSummary {
  jobId: JobId
  dir: string
  written: number
  /** Files that got a _n suffix because the name was taken. */
  renamed: number
  durationMs: number
}

export type ExportImagesEvent =
  | ({ type: 'started' } & JobStarted)
  | ({ type: 'progress' } & ExportProgress)
  | ({ type: 'finished' } & ExportImagesSummary)
  | ({ type: 'failed' } & JobFailed)
  | ({ type: 'cancelled' } & JobCancelled)

/* ───────────────────────── Export: video (mirrors timelapse-video options) ───────────────────────── */
export type Pace = { mode: 'fps'; fps: number } | { mode: 'duration'; seconds: number }
export type VideoQuality = 'low' | 'medium' | 'high' | 'max' | { bitrate: { kbps: number } }
export type Easing = 'linear' | 'easeInOut'
export interface Crossfade { frames: number; easing: Easing }
export type CaptionPosition =
  | 'topLeft' | 'topCenter' | 'topRight'
  | 'bottomLeft' | 'bottomCenter' | 'bottomRight'
export interface CaptionOptions {
  position: CaptionPosition
  /** Text em-height as a fraction of output height, 0.01..0.2. */
  size: number
  /** chrono strftime, e.g. '%b %-d, %Y'. */
  format: string
}

export interface VideoSettings {
  pace: Pace
  /** 'source' = master frame size. Never larger than the masters. */
  resolution: Resolution
  quality: VideoQuality
  crossfade: Crossfade
  /** null ⇒ no caption. */
  caption: CaptionOptions | null
  holdFirstSecs: number
  holdLastSecs: number
}

export interface VideoProgress {
  jobId: JobId
  framesDone: number
  framesTotal: number
  encodeFps: number
  etaMs: number | null
}

export interface VideoSummary {
  jobId: JobId
  path: string
  frames: number
  durationSecs: number
  bytes: number
  elapsedMs: number
}

export type ExportVideoEvent =
  | ({ type: 'started' } & JobStarted)
  | ({ type: 'progress' } & VideoProgress)
  | ({ type: 'finished' } & VideoSummary)
  | ({ type: 'failed' } & JobFailed)
  | ({ type: 'cancelled' } & JobCancelled)

/* ───────────────────────── Session ───────────────────────── */
export type ScanStatus = 'none' | 'partial' | 'complete'
export interface ScanInfo {
  status: ScanStatus
  lastSummary: ScanSummary | null
  scannedAt: LocalDateTime | null
}

export interface FramesInfo {
  status: FramesStatus
  /** Frames existing for the current fingerprint and active days. */
  count: number
  /** Active days. */
  expected: number
  outputSize: Size | null
}

export interface Recents { references: string[]; folders: string[] }

export interface SessionSnapshot {
  reference: ReferenceState | null
  folder: FolderInfo | null
  scan: ScanInfo
  counts: LibraryCounts
  render: RenderSettings
  look: LookSettings
  frames: FramesInfo
  imageExport: ImageExportSettings
  video: VideoSettings
  activeJob: ActiveJob | null
  recents: Recents
}

/* ───────────────────────── Commands ───────────────────────── */
export type NoArgs = Record<string, never>

export interface CommandMap {
  get_app_info: { args: NoArgs; result: AppInfo }
  get_session: { args: NoArgs; result: SessionSnapshot }
  reset_session: { args: NoArgs; result: SessionSnapshot }
  pick_reference_photo: { args: NoArgs; result: ReferenceState | null }
  set_reference_photo: { args: { path: string }; result: ReferenceState }
  set_reference_rotation: { args: { rotationDeg: number }; result: ReferenceState }
  set_reference_crop: { args: { crop: Rect; aspect: AspectPreset }; result: ReferenceState }
  pick_source_folder: { args: NoArgs; result: FolderInfo | null }
  set_source_folder: { args: { path: string }; result: FolderInfo }
  clear_scan_cache: { args: { scope: CacheScope }; result: ClearCacheResult }
  start_scan: { args: { onEvent: Channel<ScanEvent> }; result: JobId }
  cancel_job: { args: { jobId: JobId }; result: null }
  get_photos: { args: { query: PhotoQuery }; result: PhotoSummary[] }
  get_photo: { args: { photoId: PhotoId }; result: PhotoDetail }
  set_review_decision: { args: { photoIds: PhotoId[]; decision: ReviewDecision }; result: LibraryCounts }
  get_days: { args: NoArgs; result: DayGroup[] }
  select_day_photo: { args: { dayKey: DayKey; photoId: PhotoId }; result: DayGroup }
  move_photo_to_day: { args: { photoId: PhotoId; dayKey: DayKey }; result: DaysPatch }
  add_photo_to_day: { args: { dayKey: DayKey; path: string | null }; result: DaysPatch | null }
  set_day_excluded: { args: { dayKey: DayKey; excluded: boolean }; result: DayGroup }
  start_align: { args: { render: RenderSettings; onEvent: Channel<AlignEvent> }; result: JobId }
  get_frames: { args: NoArgs; result: FramesView }
  set_frame_adjustment: { args: { photoId: PhotoId; adjust: FrameAdjust }; result: FrameSummary }
  set_look: { args: { look: LookSettings }; result: FramesView }
  pick_export_folder: { args: NoArgs; result: string | null }
  start_export_images: {
    args: { dir: string; settings: ImageExportSettings; onEvent: Channel<ExportImagesEvent> }
    result: JobId
  }
  pick_video_path: { args: { suggestedName: string }; result: string | null }
  start_export_video: {
    args: { path: string; settings: VideoSettings; onEvent: Channel<ExportVideoEvent> }
    result: JobId
  }
  reveal_path: { args: { path: string }; result: null }
  /** v1.5: validates and saves `session.video` without exporting; allowed while a job runs. */
  set_video_settings: { args: { settings: VideoSettings }; result: VideoSettings }
  /** v1.7: opens a finished exported video (an `.mp4` in the session's outputs) in its default app. */
  open_path: { args: { path: string }; result: null }
}

export type CommandName = keyof CommandMap

/* ───────────────────────── Image protocol ───────────────────────── */
export const THUMB_WIDTHS = [160, 320, 640, 1280, 2048] as const
export const ALIGNED_WIDTHS = [160, 320, 640, 1280] as const
export const REFERENCE_WIDTHS = [320, 640, 1280, 2048] as const
export const REFERENCE_FRAME_WIDTHS = [160, 320, 640, 1280] as const
/** v1.7: widths of the preview route. */
export const PREVIEW_WIDTHS = [640, 1280] as const

export type ImageRoute =
  | { kind: 'thumb'; photoId: PhotoId; version: Version; width: number }
  /** width null ⇒ full master size. */
  | { kind: 'aligned'; photoId: PhotoId; version: Version; width: number | null }
  | { kind: 'reference'; version: Version; width: number }
  | { kind: 'referenceFrame'; version: Version; width: number }
  /** v1.7: a photo's aligned frame rendered on demand; version = PhotoDetail.previewVersion. */
  | { kind: 'preview'; photoId: PhotoId; version: Version; width: number }

/** Builds a protocol URL; `base` is AppInfo.imageBaseUrl. Width is sent as given; the server rounds up to a bucket. */
export function imageUrl(base: string, route: ImageRoute): string {
  switch (route.kind) {
    case 'thumb':
      return `${base}thumb/${route.photoId}?w=${route.width}&v=${route.version}`
    case 'aligned':
      return route.width === null
        ? `${base}aligned/${route.photoId}?v=${route.version}`
        : `${base}aligned/${route.photoId}?w=${route.width}&v=${route.version}`
    case 'reference':
      return `${base}reference?w=${route.width}&v=${route.version}`
    case 'referenceFrame':
      return `${base}reference/frame?w=${route.width}&v=${route.version}`
    case 'preview':
      return `${base}preview/${route.photoId}?w=${route.width}&v=${route.version}`
  }
}

/** Score cut-offs (legacy semantics, used for colors/badges). */
export const SCORE_CONFIRMED = 0.6
export const SCORE_UNCERTAIN = 0.4
```

### 7.4 Rust — copy verbatim to `src-tauri/src/ipc.rs`

```rust
//! src-tauri/src/ipc.rs
//! BINDING IPC CONTRACT — copied verbatim from docs/rewrite/ARCHITECTURE.md §7.4.
//! TypeScript mirror: ui/src/ipc/contract.ts. Change the doc first, then both files.
#![allow(clippy::module_name_repetitions)]

use serde::{Deserialize, Serialize};

// ───────────────────────── Scalars ─────────────────────────
/// 16 lowercase hex chars: blake3(canonical absolute path).
pub type PhotoId = String;
/// Opaque job id, unique per app run.
pub type JobId = String;
/// Calendar day `YYYY-MM-DD`.
pub type DayKey = String;
/// Wall-clock local time without offset: `YYYY-MM-DDTHH:MM:SS`.
pub type LocalDateTime = String;
/// Opaque cache-busting token (lowercase hex).
pub type Version = String;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

/// Pixel size.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Size {
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

// ───────────────────────── Errors ─────────────────────────
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorKind {
    NoFaceInReference,
    NoFaceDetected,
    NotFound,
    InvalidArgument,
    UnsupportedFormat,
    DecodeFailed,
    PermissionDenied,
    DiskFull,
    Io,
    Busy,
    Cancelled,
    NotReady,
    ModelUnavailable,
    EncodeFailed,
    Internal,
}

/// Every command rejects with exactly this shape. `message` is user-facing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, thiserror::Error)]
#[serde(rename_all = "camelCase")]
#[error("{message}")]
pub struct IpcError {
    pub kind: ErrorKind,
    pub message: String,
}

impl IpcError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self { kind, message: message.into() }
    }
}

// ───────────────────────── App ─────────────────────────
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Macos,
    Windows,
    Linux,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub platform: Platform,
    /// Ends with '/': `ftimg://localhost/` or `http://ftimg.localhost/` (Windows).
    pub image_base_url: String,
    pub models_ready: bool,
    /// v1.6: why the background model load failed (user-facing); `None` while
    /// loading and once ready.
    pub models_error: Option<String>,
    pub parallelism: u32,
    pub data_dir: String,
    pub cache_dir: String,
}

// ───────────────────────── Reference ─────────────────────────
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum AspectPreset {
    #[serde(rename = "free")]
    Free,
    #[serde(rename = "1:1")]
    Square,
    #[serde(rename = "4:3")]
    Landscape4x3,
    #[serde(rename = "3:4")]
    Portrait3x4,
    #[serde(rename = "4:5")]
    Portrait4x5,
    #[serde(rename = "16:9")]
    Landscape16x9,
    #[serde(rename = "9:16")]
    Portrait9x16,
}

/// Normalized [0,1] to its image. Anchors: [leftEye, rightEye, noseTip, mouthLeft, mouthRight].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FaceGeometry {
    pub bounds: Rect,
    pub anchors: Vec<Point>,
    pub confidence: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceImage {
    pub path: String,
    pub file_name: String,
    /// Clockwise degrees after EXIF orientation, [-45, 45].
    pub rotation_deg: f64,
    pub auto_rotation_deg: Option<f64>,
    /// Pixel size after orientation + rotation (crop space).
    pub size: Size,
    pub face: Option<FaceGeometry>,
    pub version: Version,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceDetection {
    /// Normalized to the crop.
    pub anchors: Vec<Point>,
    /// Normalized to the crop.
    pub face_box: Rect,
    pub confidence: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceState {
    pub image: ReferenceImage,
    /// Pixels in `image.size` space.
    pub crop: Rect,
    pub aspect: AspectPreset,
    pub detection: Option<ReferenceDetection>,
    pub version: Version,
}

// ───────────────────────── Folder & library ─────────────────────────
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderInfo {
    pub path: String,
    pub name: String,
    pub image_count: u32,
    pub analyzed_count: u32,
    pub unsupported_count: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CacheScope {
    Folder,
    All,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearCacheResult {
    pub removed_entries: u32,
    pub freed_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MatchStatus {
    Confirmed,
    Uncertain,
    Rejected,
    NoFace,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReviewDecision {
    Pending,
    Confirmed,
    Rejected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DateSource {
    Exif,
    Filename,
    FileTime,
    Manual,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotoSummary {
    pub id: PhotoId,
    pub file_name: String,
    pub rel_path: String,
    pub taken_at: LocalDateTime,
    pub date_source: DateSource,
    /// v1.4: taken_at has a real time of day (EXIF, or a file name with a time).
    pub time_known: bool,
    pub day_key: DayKey,
    /// Calibrated [0,1]; >= 0.60 confirmed, >= 0.40 uncertain.
    pub score: f64,
    pub status: MatchStatus,
    pub review: ReviewDecision,
    pub included: bool,
    pub size: Size,
    /// Matched-face bounds, normalized to the oriented image; None for noFace/failed.
    pub face_box: Option<Rect>,
    pub version: Version,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotoDetail {
    pub summary: PhotoSummary,
    pub path: String,
    pub faces: Vec<FaceGeometry>,
    pub matched_face: Option<u32>,
    pub raw_similarity: Option<f64>,
    /// v1.7: `v` of the `preview` route (the aligned frame this photo would get
    /// now); `None` without a matched face or a reference face.
    pub preview_version: Option<Version>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotoQuery {
    pub statuses: Option<Vec<MatchStatus>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryCounts {
    pub total: u32,
    pub confirmed: u32,
    pub uncertain: u32,
    pub rejected: u32,
    pub no_face: u32,
    pub failed: u32,
    pub review_pending: u32,
    pub included: u32,
    pub days: u32,
    pub active_days: u32,
}

// ───────────────────────── Jobs (shared) ─────────────────────────
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum JobKind {
    Scan,
    Align,
    ExportImages,
    ExportVideo,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveJob {
    pub job_id: JobId,
    pub kind: JobKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobStarted {
    pub job_id: JobId,
    pub total: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobFailed {
    pub job_id: JobId,
    pub error: IpcError,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobCancelled {
    pub job_id: JobId,
    pub done: u32,
}

// ───────────────────────── Scan ─────────────────────────
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    pub job_id: JobId,
    pub done: u32,
    pub total: u32,
    pub from_cache: u32,
    pub analyzed: u32,
    pub confirmed: u32,
    pub uncertain: u32,
    pub rejected: u32,
    pub no_face: u32,
    pub failed: u32,
    pub current_file: Option<String>,
    pub photos_per_second: f64,
    pub eta_ms: Option<u64>,
    /// Max 64 entries.
    pub recent: Vec<ScanRecent>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ScanRecentStatus {
    Confirmed,
    Uncertain,
}

/// Mosaic tile: thumb URL = `thumb/{id}?v={version}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanRecent {
    pub id: PhotoId,
    /// Photo version (thumb route).
    pub version: Version,
    pub day_key: DayKey,
    pub status: ScanRecentStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanSummary {
    pub job_id: JobId,
    pub total: u32,
    pub from_cache: u32,
    pub analyzed: u32,
    pub confirmed: u32,
    pub uncertain: u32,
    pub rejected: u32,
    pub no_face: u32,
    pub failed: u32,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ScanEvent {
    Started(JobStarted),
    Progress(ScanProgress),
    Finished(ScanSummary),
    Failed(JobFailed),
    Cancelled(JobCancelled),
}

// ───────────────────────── Days ─────────────────────────
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DayGroup {
    pub day_key: DayKey,
    pub photo_ids: Vec<PhotoId>,
    pub selected_id: PhotoId,
    pub auto_selected_id: PhotoId,
    pub manual_selection: bool,
    pub excluded: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DaysPatch {
    pub upserted: Vec<DayGroup>,
    pub removed: Vec<DayKey>,
}

// ───────────────────────── Align & frames ─────────────────────────
/// Same wire values and semantics as `timelapse_video::geometry::Resolution`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Resolution {
    #[serde(rename = "source")]
    Source,
    #[serde(rename = "2160p")]
    P2160,
    #[serde(rename = "1080p")]
    P1080,
    #[serde(rename = "720p")]
    P720,
}

/// `extended` (v1.2, default): the photo's own edges continued outward, blurred and darkened.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BackdropMode {
    Dimmed,
    Blurred,
    Black,
    Extended,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderSettings {
    pub resolution: Resolution,
    pub backdrop: BackdropMode,
    pub refine_landmarks: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignProgress {
    pub job_id: JobId,
    pub done: u32,
    pub total: u32,
    pub reused: u32,
    pub failed: u32,
    pub current_photo_id: Option<PhotoId>,
    pub frames_per_second: f64,
    pub eta_ms: Option<u64>,
    /// Max 64 entries.
    pub recent: Vec<AlignRecent>,
}

/// Aligned tile: URL = `aligned/{id}?v={version}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignRecent {
    pub id: PhotoId,
    /// Frame version (aligned route).
    pub version: Version,
    pub day_key: DayKey,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignFailure {
    pub photo_id: PhotoId,
    pub error: IpcError,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignSummary {
    pub job_id: JobId,
    pub total: u32,
    pub rendered: u32,
    pub reused: u32,
    pub failed: Vec<AlignFailure>,
    pub output_size: Size,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AlignEvent {
    Started(JobStarted),
    Progress(AlignProgress),
    Finished(AlignSummary),
    Failed(JobFailed),
    Cancelled(JobCancelled),
}

/// Post-Procrustes correction in output space. Identity = { 0, 0, 1, 0 }.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameAdjust {
    /// Fraction of output width.
    pub dx: f64,
    /// Fraction of output height.
    pub dy: f64,
    pub scale: f64,
    pub rotation_deg: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameSummary {
    pub photo_id: PhotoId,
    pub day_key: DayKey,
    pub taken_at: LocalDateTime,
    /// v1.4: as `PhotoSummary::time_known`.
    pub time_known: bool,
    pub version: Version,
    pub residual_px: f64,
    pub adjust: FrameAdjust,
    /// None when look is off or stats are missing (§9.6).
    pub look_delta: Option<LookDelta>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LookDelta {
    /// 3·log2(L_out / L_in) on the face-region Oklab mean L; positive = brightened.
    pub exposure_ev: f64,
    /// 100 × Oklab (a,b) mean distance moved; 0 in `exposure` mode.
    pub color_shift: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FramesStatus {
    #[serde(rename = "none")]
    Missing,
    Stale,
    Partial,
    Complete,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NormalizeMode {
    Off,
    Exposure,
    ExposureAndColor,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LookSettings {
    pub normalize: NormalizeMode,
    pub strength: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FramesView {
    pub status: FramesStatus,
    pub output_size: Option<Size>,
    pub render: RenderSettings,
    pub look: LookSettings,
    pub reference_anchors: Option<Vec<Point>>,
    pub frames: Vec<FrameSummary>,
}

// ───────────────────────── Export: images ─────────────────────────
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ImageFormat {
    Png,
    Jpeg,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageExportSettings {
    pub format: ImageFormat,
    /// 50..=100.
    pub jpeg_quality: u8,
    pub overwrite: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportProgress {
    pub job_id: JobId,
    pub done: u32,
    pub total: u32,
    pub current_file: Option<String>,
    pub eta_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportImagesSummary {
    pub job_id: JobId,
    pub dir: String,
    pub written: u32,
    pub renamed: u32,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ExportImagesEvent {
    Started(JobStarted),
    Progress(ExportProgress),
    Finished(ExportImagesSummary),
    Failed(JobFailed),
    Cancelled(JobCancelled),
}

// ───────────────────────── Export: video (mirrors timelapse-video options) ─────────────────────────
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum Pace {
    Fps { fps: f64 },
    Duration { seconds: f64 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VideoQuality {
    Low,
    Medium,
    High,
    Max,
    Bitrate { kbps: u32 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Easing {
    Linear,
    EaseInOut,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Crossfade {
    pub frames: u32,
    pub easing: Easing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CaptionPosition {
    TopLeft,
    TopCenter,
    TopRight,
    BottomLeft,
    BottomCenter,
    BottomRight,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionOptions {
    pub position: CaptionPosition,
    /// Em-height as a fraction of output height, 0.01..=0.2.
    pub size: f64,
    /// chrono strftime.
    pub format: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoSettings {
    pub pace: Pace,
    pub resolution: Resolution,
    pub quality: VideoQuality,
    pub crossfade: Crossfade,
    pub caption: Option<CaptionOptions>,
    pub hold_first_secs: f64,
    pub hold_last_secs: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoProgress {
    pub job_id: JobId,
    pub frames_done: u32,
    pub frames_total: u32,
    pub encode_fps: f64,
    pub eta_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoSummary {
    pub job_id: JobId,
    pub path: String,
    pub frames: u32,
    pub duration_secs: f64,
    pub bytes: u64,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ExportVideoEvent {
    Started(JobStarted),
    Progress(VideoProgress),
    Finished(VideoSummary),
    Failed(JobFailed),
    Cancelled(JobCancelled),
}

// ───────────────────────── Session ─────────────────────────
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ScanStatus {
    #[serde(rename = "none")]
    Missing,
    Partial,
    Complete,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanInfo {
    pub status: ScanStatus,
    pub last_summary: Option<ScanSummary>,
    pub scanned_at: Option<LocalDateTime>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FramesInfo {
    pub status: FramesStatus,
    pub count: u32,
    pub expected: u32,
    pub output_size: Option<Size>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Recents {
    pub references: Vec<String>,
    pub folders: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSnapshot {
    pub reference: Option<ReferenceState>,
    pub folder: Option<FolderInfo>,
    pub scan: ScanInfo,
    pub counts: LibraryCounts,
    pub render: RenderSettings,
    pub look: LookSettings,
    pub frames: FramesInfo,
    pub image_export: ImageExportSettings,
    pub video: VideoSettings,
    pub active_job: Option<ActiveJob>,
    pub recents: Recents,
}

// ───────────────────────── Image protocol ─────────────────────────
pub const IMAGE_SCHEME: &str = "ftimg";
pub const THUMB_WIDTHS: [u32; 5] = [160, 320, 640, 1280, 2048];
pub const ALIGNED_WIDTHS: [u32; 4] = [160, 320, 640, 1280];
pub const REFERENCE_WIDTHS: [u32; 4] = [320, 640, 1280, 2048];
pub const REFERENCE_FRAME_WIDTHS: [u32; 4] = [160, 320, 640, 1280];
/// v1.7: widths of the `preview` route.
pub const PREVIEW_WIDTHS: [u32; 2] = [640, 1280];

/// Parsed `ftimg` request path. Grammar (query order irrelevant, unknown keys ignored):
///   /thumb/{id}?w={u32}&v={hex}  /aligned/{id}[?w={u32}][&v={hex}]
///   /reference?w={u32}&v={hex}   /reference/frame?w={u32}&v={hex}
///   /preview/{id}?w={u32}&v={hex}   (v1.7; v = PhotoDetail.previewVersion)
/// `id` = `^[0-9a-f]{16}$`. `width` is already rounded up to the route's bucket.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ImageRoute {
    Thumb { photo_id: PhotoId, width: u32, version: Option<Version> },
    Aligned { photo_id: PhotoId, width: Option<u32>, version: Option<Version> },
    Reference { width: u32, version: Option<Version> },
    ReferenceFrame { width: u32, version: Option<Version> },
    /// v1.7: the photo's aligned frame rendered on demand (never stored as a frame).
    Preview { photo_id: PhotoId, width: u32, version: Option<Version> },
}

/// Score cut-offs (legacy semantics).
pub const SCORE_CONFIRMED: f64 = 0.60;
pub const SCORE_UNCERTAIN: f64 = 0.40;

/// App event, no payload (v1.2): the backend changed session state on its own,
/// not in answer to a command (dev autoload, re-analysis of a stale reference once
/// the models load). Listen with `listen('session-changed', …)` and re-query
/// `get_session` and the queries derived from it.
pub const SESSION_CHANGED_EVENT: &str = "session-changed";

/// App event, no payload (v1.6): the background model load finished, successfully
/// or not; re-read `get_app_info` (`modelsReady`, `modelsError`). Emitted once, after
/// the outcome is recorded: subscribe first, then read `get_app_info`, so a load that
/// finished before the subscription is not missed.
pub const MODELS_CHANGED_EVENT: &str = "models-changed";

/// App event, no payload (v1.8): Help › Keyboard Shortcuts (⌘/) in the native menu
/// was chosen; the UI lays its Keys card over the current screen (as "?" does).
/// Emitted by the shell only: the webview can listen but not emit (§13).
pub const SHOW_KEYS_EVENT: &str = "show-keys";
```

### 7.5 Command signatures (`src-tauri/src/commands/*.rs`)

```rust
use tauri::{ipc::Channel, AppHandle, State};
use crate::{ipc::*, state::AppState};

#[tauri::command] pub async fn get_app_info(state: State<'_, AppState>) -> Result<AppInfo, IpcError>;
#[tauri::command] pub async fn get_session(state: State<'_, AppState>) -> Result<SessionSnapshot, IpcError>;
#[tauri::command] pub async fn reset_session(state: State<'_, AppState>) -> Result<SessionSnapshot, IpcError>;
#[tauri::command] pub async fn pick_reference_photo(app: AppHandle, state: State<'_, AppState>) -> Result<Option<ReferenceState>, IpcError>;
#[tauri::command] pub async fn set_reference_photo(state: State<'_, AppState>, path: String) -> Result<ReferenceState, IpcError>;
#[tauri::command] pub async fn set_reference_rotation(state: State<'_, AppState>, rotation_deg: f64) -> Result<ReferenceState, IpcError>;
#[tauri::command] pub async fn set_reference_crop(state: State<'_, AppState>, crop: Rect, aspect: AspectPreset) -> Result<ReferenceState, IpcError>;
#[tauri::command] pub async fn pick_source_folder(app: AppHandle, state: State<'_, AppState>) -> Result<Option<FolderInfo>, IpcError>;
#[tauri::command] pub async fn set_source_folder(state: State<'_, AppState>, path: String) -> Result<FolderInfo, IpcError>;
#[tauri::command] pub async fn clear_scan_cache(state: State<'_, AppState>, scope: CacheScope) -> Result<ClearCacheResult, IpcError>;
#[tauri::command] pub async fn start_scan(state: State<'_, AppState>, on_event: Channel<ScanEvent>) -> Result<JobId, IpcError>;
#[tauri::command] pub async fn cancel_job(state: State<'_, AppState>, job_id: JobId) -> Result<(), IpcError>;
#[tauri::command] pub async fn get_photos(state: State<'_, AppState>, query: PhotoQuery) -> Result<Vec<PhotoSummary>, IpcError>;
#[tauri::command] pub async fn get_photo(state: State<'_, AppState>, photo_id: PhotoId) -> Result<PhotoDetail, IpcError>;
#[tauri::command] pub async fn set_review_decision(state: State<'_, AppState>, photo_ids: Vec<PhotoId>, decision: ReviewDecision) -> Result<LibraryCounts, IpcError>;
#[tauri::command] pub async fn get_days(state: State<'_, AppState>) -> Result<Vec<DayGroup>, IpcError>;
#[tauri::command] pub async fn select_day_photo(state: State<'_, AppState>, day_key: DayKey, photo_id: PhotoId) -> Result<DayGroup, IpcError>;
#[tauri::command] pub async fn move_photo_to_day(state: State<'_, AppState>, photo_id: PhotoId, day_key: DayKey) -> Result<DaysPatch, IpcError>;
#[tauri::command] pub async fn add_photo_to_day(app: AppHandle, state: State<'_, AppState>, day_key: DayKey, path: Option<String>) -> Result<Option<DaysPatch>, IpcError>;
#[tauri::command] pub async fn set_day_excluded(state: State<'_, AppState>, day_key: DayKey, excluded: bool) -> Result<DayGroup, IpcError>;
#[tauri::command] pub async fn start_align(state: State<'_, AppState>, render: RenderSettings, on_event: Channel<AlignEvent>) -> Result<JobId, IpcError>;
#[tauri::command] pub async fn get_frames(state: State<'_, AppState>) -> Result<FramesView, IpcError>;
#[tauri::command] pub async fn set_frame_adjustment(state: State<'_, AppState>, photo_id: PhotoId, adjust: FrameAdjust) -> Result<FrameSummary, IpcError>;
#[tauri::command] pub async fn set_look(state: State<'_, AppState>, look: LookSettings) -> Result<FramesView, IpcError>;
#[tauri::command] pub async fn pick_export_folder(app: AppHandle, state: State<'_, AppState>) -> Result<Option<String>, IpcError>;
#[tauri::command] pub async fn start_export_images(state: State<'_, AppState>, dir: String, settings: ImageExportSettings, on_event: Channel<ExportImagesEvent>) -> Result<JobId, IpcError>;
#[tauri::command] pub async fn pick_video_path(app: AppHandle, state: State<'_, AppState>, suggested_name: String) -> Result<Option<String>, IpcError>;
#[tauri::command] pub async fn start_export_video(state: State<'_, AppState>, path: String, settings: VideoSettings, on_event: Channel<ExportVideoEvent>) -> Result<JobId, IpcError>;
#[tauri::command] pub async fn reveal_path(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<(), IpcError>;
#[tauri::command] pub async fn set_video_settings(state: State<'_, AppState>, settings: VideoSettings) -> Result<VideoSettings, IpcError>;
#[tauri::command] pub async fn open_path(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<(), IpcError>; // v1.7
```
Notes: dialogs via `tauri-plugin-dialog` from Rust (use the callback API + `oneshot`, never block the main thread); `reveal_path` via `tauri-plugin-opener` `reveal_item_in_dir`, `open_path` via its Rust `open_path` (v1.7). `pick_video_path` default name: `FaceTimelapse {firstYear}–{lastYear}.mp4`. Contracts v1.1, v1.4 and v1.6 (§7.7) changed payload types only; v1.5 added `set_video_settings`, v1.7 `open_path`; the other signatures are unchanged. `get_photo` fills `PhotoDetail.previewVersion` (v1.7) via `protocol::preview::version`. `get_frames` / `set_look` / `set_frame_adjustment` fill `FrameSummary.lookDelta` from the frame manifest's face stats and the reference stats via `face_engine::color::look_delta` (§9.6); `get_photos` fills `PhotoSummary.faceBox` from the matched face of the cached analysis.

Defaults (fresh session): `render = {1080p, extended, refineLandmarks: true}` (v1.2; was `dimmed`), `look = {off, 0.7}`, `imageExport = {png, 95, overwrite: false}`, `video = {pace: {fps, 10}, resolution: 'source', quality: 'high', crossfade: {0, easeInOut}, caption: null, holdFirstSecs: 0, holdLastSecs: 1}`, `aspect = 'free'`.

### 7.6 Contract drift guard
- `ui/src/ipc/contract.samples.json` holds one realistic sample per type (keyed by type name, all event variants included).
- `src-tauri/tests/contract.rs`: `src/ipc.rs` and `ui/src/ipc/contract.ts` must equal the §7.4 / §7.3 blocks verbatim; deserializes each sample into its Rust type and re-serializes; JSON must be **identical** (key order-insensitive).
- `ui/src/ipc/contract.samples.test.ts`: declares the same samples as TS literals checked with `satisfies <Type>` (compile-time) and asserts deep equality with the JSON (run time).
- Image-route constants (`THUMB_WIDTHS` … `PREVIEW_WIDTHS`) are checked in `image_protocol_constants`; `PhotoDetail` has a sample with and one without a `previewVersion` (v1.7).
- `src-tauri/tests/contract.rs` also checks that the app event names (`SESSION_CHANGED_EVENT`, `MODELS_CHANGED_EVENT`, `SHOW_KEYS_EVENT` (v1.8), §7.4) equal the constants in `ui/src/ipc/events.ts`, and `ipc_tests.rs` that the webview cannot emit any of them and that only Help › Keyboard Shortcuts emits `show-keys`. Events carry no payload, so they have no samples.
- A PR that changes either contract file without updating samples fails one of the two.

### 7.7 Contract changelog

| Version | Change | Requested by |
|---|---|---|
| 1.0 | Initial contract (29 commands, 4 job event channels, 4 image routes). | ARCHITECT |
| 1.1 (P1) | `ScanProgress.recent: PhotoId[]` → `ScanRecent[]` with `{ id, version, dayKey, status: 'confirmed' \| 'uncertain' }` (Rust `ScanRecent`, `ScanRecentStatus`), so mosaic tiles need no extra query. | DESIGN, accepted |
| 1.1 (P2) | `AlignProgress.recent: PhotoId[]` → `AlignRecent[]` with `{ id, version, dayKey }` (`version` = frame version). | DESIGN, accepted |
| 1.1 (P3) | `PhotoSummary.faceBox: Rect \| null` — matched-face bounds normalized to the oriented image (face-centred crops in grids). | DESIGN, accepted |
| 1.1 (P4) | `AspectPreset` gains `'4:5'` (Rust `Portrait4x5`); 1080p ⇒ 1080×1350. | DESIGN, accepted |
| 1.1 (P5) | `FrameSummary.lookDelta: LookDelta \| null` with `{ exposureEv, colorShift }`, defined in §9.6. | DESIGN, accepted |
| 1.1 | `set_review_decision` documents rescuing `rejected` photos and rejects `confirmed` on `noFace`/`failed` (`invalidArgument`); supports P6. | ARCHITECT |
| 1.1 (P6, P7) | Frontend-only: `scan` step doubles as the post-scan library view; extra shortcuts (§8). No wire change. | DESIGN, accepted |
| 1.2 | `BackdropMode` gains `'extended'` (Rust `Extended`) — the warped photo's own edges extended outward, blurred and gently darkened, so no rectangle shows at the photo border (§9.5); it is the **default** render setting of new sessions. `dimmed`, `blurred`, `black` unchanged. | ORCHESTRATOR (quality), accepted |
| 1.2 | App event `session-changed` (`SESSION_CHANGED_EVENT`, no payload; §7.1): backend-initiated session changes (dev autoload, stale reference re-analysis). | ORCHESTRATOR, accepted |
| 1.3 | Behaviour only — no type, field or command changes (§7.3/§7.4 unchanged). Fix pass 2 adds: a path must be granted *as spelled* (no resolving of other spellings) and must stay inside its grant once resolved (symlinks); `reveal_path` gives the same `invalidArgument` for any non-output, existing or not; `add_photo_to_day` may answer `cancelled` when the folder changed while the photo was being read; a video export that fails or is cancelled no longer becomes an output; with no confirmed replace, a file appearing at the video path during the encode is kept and the video is saved as `{name}_1.mp4` (reported in `VideoSummary.path`). Path grants (§7.1): `set_reference_photo`, `set_source_folder`, `add_photo_to_day(path)`, `start_export_images`, `start_export_video` answer `permissionDenied` for paths the user did not choose (dialog, drop, session paths). `set_source_folder` may answer `cancelled` when a newer folder choice replaced it. Mutations answer `busy` after waiting 2 s for another change. `start_export_video` refuses (`invalidArgument`) to replace an existing file the save dialog did not confirm; caption formats that cannot format a date are `invalidArgument`. `add_photo_to_day` refuses folder photos without a face (`noFaceDetected`). Jobs ending before `started` still send `started{total: 0}` first. A restore slower than 3 s emits `session-changed`. ftimg: no `*` CORS, 503 on queue overflow. | SECURITY + RUST REVIEW, accepted |
| 1.4 | `PhotoSummary.timeKnown: boolean` and `FrameSummary.timeKnown: boolean` (Rust `time_known`): `takenAt` carries a real time of day — from EXIF, or from a file name that contains a valid time (`20120901_111216`). False for file-system times, date-only file names (`IMG_20220827`, `takenAt` at 00:00) and hand-added photos (`takenAt` at 12:00): show the date only. Additive; no command changes. | UI (QA LOW: Review showed "00:00"), accepted |
| 1.4 (behaviour) | `timeKnown` is also false for a time of exactly 00:00:00 (EXIF or file name): cameras without a clock time write it — 2,331 of the 3,591 test photos. Reference crops are stored, and returned by `set_reference_crop` / `set_reference_rotation` / `set_reference_photo`, on whole pixels (`face_engine::reference::snap_crop`; a fractional crop from Level or Centre is rounded edge by edge). No type changes. | QA N1/N2, accepted |
| 1.5 | Command 30 `set_video_settings(settings: VideoSettings) → VideoSettings`: saves `session.video` without exporting (the UI's single pace, in days per second, and the blend survive a restart). Validation as `start_export_video` without the frame-dependent checks; works while a job runs. No type changes. | UI (one pace), accepted |
| 1.6 | `AppInfo.modelsError: string \| null` (Rust `models_error: Option<String>`): the user-facing reason the startup model load failed. It is null while loading and once ready, so the UI can tell "still loading" from "failed". New app event `models-changed` (`MODELS_CHANGED_EVENT`, no payload; §7.1). It is emitted once when the startup load ends, successfully or not, after the outcome is recorded; subscribe, then read `get_app_info`. Listen-only: no new permission. Additive; no command changes. | UI (models loading vs failed), accepted |
| 1.6 (behaviour) | Starting without the face models restores the session read-only from the caches and frames of the last engine whose models were present (`session.json` `lastEngineFingerprint`, §5): the same library, days and current frames as with the models. Watching and exporting work; scan, align, frame nudges, reference changes and adding unanalyzed photos still answer `modelUnavailable`. Altered model files count as missing. No type or command changes. | QA N5, accepted |
| 1.7 | Command 31 `open_path(path) → null`: opens a finished exported video (an `.mp4` output, exactly as recorded, still a regular file) in its default app; one `notFound` for every refusal; allowed while a job runs; new permission `allow-open-path` (§13). Image route `preview/{photoId}?w={640\|1280}&v=` (`PREVIEW_WIDTHS`, `ImageRoute::Preview`, TS `{ kind: 'preview' }` in `imageUrl`): a Review candidate's aligned frame rendered on demand, never stored as a frame (§6). `PhotoDetail.previewVersion: Version \| null` is its `v`. | UI (critique round 4: Saved diptych ⌘↩, Review previews), accepted |
| 1.8 | App event `show-keys` (`SHOW_KEYS_EVENT`, no payload; §7.1): Help › Keyboard Shortcuts (⌘/) in the native menu bar asks the UI to show its Keys card. Listen-only (no new permission); additive, no type or command changes, so §7.3 (`contract.ts`) is unchanged and the constant lives in §7.4 and `ui/src/ipc/events.ts`. Days range selection (critique round 6, P1-4) needs no wire change: it loops `set_day_excluded`. | UI (critique round 6, P1-3 Help), accepted |

---

## 8. Frontend architecture (`ui/`)

- Stack: React 19, TypeScript `strict` + `noUncheckedIndexedAccess`, Vite, Zustand (view state), TanStack Query v5 (backend reads), TanStack Virtual v3 (grids, calendar months, review strip), `@dnd-kit/core` (day moves; pointer + keyboard sensors), `@tauri-apps/api` v2. No CSS framework mandate (DESIGN decides); fonts self-hosted.
- `ipc/client.ts`: `call<K extends CommandName>(cmd, args)` → typed promise, rejects with `IpcError` (normalize unknown throws to `{kind:'internal'}`); `runJob(kind, start)` creates the `Channel`, routes events into `state/jobs.ts`, resolves on the terminal event, and invalidates queries (`session`, then the kind-specific ones).
- Query keys: `['appInfo']` (staleTime ∞), `['session']`, `['photos', statuses]`, `['photo', id]`, `['days']`, `['frames']`. Mutations write returned data with `setQueryData` and invalidate `['session']`.
- View state (Zustand, not persisted except where noted): `step`, `setup.cropDraft/dragging`, `review.cursor/undoStack`, `days.activeDay`, `timelapse.mode('grid'|'player')/viewerIndex/onion/anchors`, `player.index/playing/loop/speed`, `modals`, `jobs` progress, `theme ('system'|'light'|'dark')` — `theme` and `lastStep` in `localStorage` (try/catch).
- Steps (`lib/steps.ts`, matches DESIGN screens): `setup | scan | review | days | align | timelapse`. Reachability from `SessionSnapshot`:

| Step | Reachable when | Auto-enter |
|---|---|---|
| setup | always | first run; scan cancelled/failed |
| scan | `activeJob?.kind === 'scan' \|\| scan.status !== 'none'` | `start_scan` |
| review | `scan.status === 'complete' && counts.uncertain > 0` | scan finished with `reviewPending > 0` |
| days | `scan.status === 'complete'` | scan finished with no pending. After the last pending photo is decided Review stays open on its done state and Days opens on Continue (no automatic advance). |
| align (transient) | `activeJob.kind === 'align'` | `start_align` |
| timelapse | `frames.count > 0` | align finished (failures listed, dismissible) |

Back/forward between reachable steps is free (fixes B19: nothing is recomputed by navigation). Cancelled align → `days` with a toast "Aligned 1,204 of 3,012 — Align again to continue". Startup: `lastStep` if reachable, else the furthest reachable of `timelapse → days → setup`.
- **Scan step = live job, then library (P6).** While `activeJob.kind === 'scan'` it shows live progress and the mosaic (tiles from `ScanProgress.recent`, URL `thumb/{id}?v={version}`, grouped/labelled by `dayKey`, tinted by `status`). Once `scan.status !== 'none'` it stays reachable as a library view of `get_photos({ statuses })` with a status filter (all / confirmed / uncertain / rejected / noFace / failed) and face-centred tiles from `PhotoSummary.faceBox`. A wrongly rejected photo ("Not you") is rescued with `set_review_decision([id], 'confirmed')` (undo = `'pending'`); `noFace`/`failed` photos show no rescue action (the command rejects them with `invalidArgument`). After a rescue, invalidate `['photos']`, `['days']`, `['session']`.
- Align progress tiles use `AlignProgress.recent` (`aligned/{id}?v={version}`); the timelapse grid can show `FrameSummary.lookDelta` (e.g. "+0.4 EV · shift 3") when the look is on.
- Setup crop editor: aspect presets `free, 1:1, 4:3, 3:4, 4:5, 16:9, 9:16`; pure TS in `lib/crop.ts` ports legacy `computeARCrop`, `clampBox` (fixed to keep the aspect at borders), AR-locked handle math, Center-face math (from `reference.image.face.bounds`), nudge 1/10 px; preview fills the available panel (not 380 px). Commit with `set_reference_crop` 150 ms after drag end/keyboard idle; "no face" is an inline state, not a banner.
- Drag-and-drop: `getCurrentWebview().onDragDropEvent` — `enter/over` show a full-window drop overlay; `drop` with one path: image extension → `set_reference_photo`, directory → `set_source_folder` (backend decides via `invalidArgument` if neither; the UI shows the message); multiple paths → first image as reference + first directory as folder.
- Grids: fixed row height, overscan 2 rows, `content-visibility: auto` on cells, `<img decoding="async">` with width bucket; never more than ~200 `<img>` mounted.
- Player (`features/timelapse/player`): plays `aligned/{id}?w=640|1280` at `pace` fps; ring buffer of decoded `ImageBitmap`s (±48 frames, `createImageBitmap(await fetch(url).blob())`) drawn to a `<canvas>`; crossfade preview = canvas `globalAlpha` blend with the same frame plan as the VIDEO crate (`lib/video.ts` ports `TimelineSpec`, `duration_for_fps`, `fps_for_duration`, `feasible_duration_range` with JS `toFixed(2)`); scrubber with day/year ticks; keys below. Onion skin: second layer = `reference/frame` or previous frame at 0–100 % opacity, or `difference` blend; anchor overlay = `FramesView.referenceAnchors` dots.
- Keyboard map (all scoped to the active screen, ignored while typing in inputs):

| Screen | Keys |
|---|---|
| global | ⌘1–⌘5 jump to ledger rows (setup, scan, review, days, timelapse; unreachable rows ignored), ⌃⌘S toggle sidebar, ⌥⌘I toggle inspector, ⌘O reference, ⇧⌘O folder, ⌘↩ primary action, Esc close/cancel drag, ⌘. cancel running job |
| setup | arrows nudge crop (⇧ ×10), L level eyes, C center face, R reset |
| review | → / ↩ / Y confirm, ← / N reject (Backspace kept as legacy alias), U or ⌘Z undo, Space compare with reference, ⇧A confirm all remaining |
| days | ←/→ previous/next day, ↑/↓ previous/next photo, [ / ] previous/next year, ⌘↑/⌘↓ zoom calendar in/out, 1–9 pick photo n, X exclude day, M move photo (keyboard DnD) |
| timelapse | Space play/pause, ←/→ frame, ⇧←/⇧→ ±10, ⌥←/⌥→ jump a year, Home/End, J/K/L shuttle, O onion skin, D difference, A anchors, F fullscreen viewer, ⌘E export |

- Mocking: `ui/src/ipc/mock/fakeBackend.ts` implements every command/event of §7 in memory (deterministic synthetic library of 3,600 photos, 10 years) and is installed with `mockIPC(fakeBackend.handle, { shouldMockEvents: true })` + `mockWindows('main')` when `import.meta.env.VITE_FT_MOCK === '1'` (dead-code-eliminated in production). Channel events are delivered by calling the received `Channel` instance's `onmessage(event)` (verify against the installed `@tauri-apps/api`; fallback `window.__TAURI_INTERNALS__.runCallback(channel.id, { index, message })`). `get_app_info().imageBaseUrl` = `/__mock/img/`, served by a Vite dev plugin from `ui/e2e/fixtures/img/` (synthetic, non-personal images generated by a script).

---

## 9. Algorithms and constants for the rewrite

### 9.1 Files (ENGINE)
Recursive walk; skip names starting with `.`; do not follow directory symlinks; accept file symlinks; extensions (case-insensitive) `.jpg .jpeg .png .tif .tiff .webp` supported, `.heic .heif` **counted as unsupported**. Natural sort by relative path. Dialog filter: `jpg jpeg png tif tiff webp`.

### 9.2 Capture date (ENGINE)
1. EXIF `DateTimeOriginal` (0x9003) → 2. EXIF `DateTimeDigitized` (0x9004) → 3. **filename** → 4. EXIF `DateTime` (0x0132) → 5. file creation time (birthtime where available, else mtime) converted to local time. Never "now".
Filename patterns, tried in order on the file stem; a match must form a valid calendar date with year 1990–2100 (and time 00–23:00–59:00–59 if present):
- `(?:^|\D)((?:19|20)\d{2})(\d{2})(\d{2})(?:[_\- ]{1,2}(\d{2})(\d{2})(\d{2}))?(?:\D|$)` — `IMG_20140815_142326`, `20120901_111216`, `IMG_20220827`, `IMG_20140815_ 142326`, `20130323_170145_LLS`, `IMG-20140815-WA0001` (date only).
- `(?:^|\D)((?:19|20)\d{2})-(\d{2})-(\d{2})[ _T](\d{2})[.:\-](\d{2})[.:\-](\d{2})` — `2014-08-15 14.23.26`.
EXIF values are naive (`YYYY:MM:DD HH:MM:SS`); keep them naive. `dayKey` = date part of `takenAt`.

### 9.3 Detection, recognition, matching (ENGINE)
- Decode: EXIF orientation first. JPEG via DCT scaling to the smallest scale with long edge ≥ 640, then resize to **640 long edge** for detection; other formats full decode + resize.
- YuNet (`face_detection_yunet_2023mar.onnx`): score ≥ **0.6**, NMS IoU **0.3**, top-k 50; drop faces whose short side < 24 px at 640; keep the **3 largest** faces with area ≥ 10 % of the largest.
- Anchors from YuNet's 5 points mapped to the order above. **Invariant test**: on the reference photo `anchors[0].x < anchors[1].x`, `anchors[3].x < anchors[4].x`, eyes above nose above mouth.
- SFace (`face_recognition_sface_2021dec.onnx`): standard 112×112 similarity alignCrop from the 5 points (ArcFace template), 128-d, L2-normalized. Share one model instance across workers if the runtime's `run` is `&self`-safe; otherwise per-thread instances with the pool capped so RAM stays < 1.5 GB.
- Match: per photo, `cos = max over faces(ref · face)`; `matchedFace` = argmax (fixes "largest face" B4). `PhotoSummary.faceBox` = that face's `bounds` (normalized to the oriented image, as stored in the analysis cache); `null` for `noFace`/`failed`. It is recomputed with matching, so it can change when the reference changes in multi-face photos.
- Calibration `score = f(cos)` with `C = COS_CONFIRMED`, `U = COS_UNCERTAIN`, `Z = 2U − C` (continuous, monotonic):
  `cos ≥ C → 0.60 + 0.40·(cos − C)/(1 − C)`; `U ≤ cos < C → 0.40 + 0.20·(cos − U)/(C − U)`; `Z ≤ cos < U → 0.40·(cos − Z)/(U − Z)`; `cos < Z → 0`.
  Starting values **C = 0.363** (OpenCV's published SFace cosine threshold), **U = 0.20**. ENGINE calibrates on the 3,593-photo set (target: ≥ 95 % confirmed, a visually checked sample of rejects contains no true matches) and records final values + histogram in the crate README.
- Status: no faces → `noFace`; decode error → `failed`; else `score ≥ 0.60` confirmed, `≥ 0.40` uncertain, else rejected.
- Reference: detect on the crop (downscaled so the crop's long edge ≤ 1280), largest face; `ReferenceImage.face` from detection on the whole rotated image at ≤ 1024 px.
  - The photo's main face is measured once per photo version on the *unrotated* (EXIF-oriented) photo: landmarks = mean of 25 TTA-refined detections over framings of its box (scales 0.8–1.25 × shifts ±10 %), since YuNet's 5 points move with the framing (eye line ±0.7° on a real selfie; the mean is stable to ±0.13°); SFace embedding on those landmarks. When the crop's face is that face (IoU ≥ 0.3), its anchors are these landmarks mapped through the rotation and its embedding is this one, so matching depends on neither the crop nor the rotation. Another face in the crop gets its own ensemble.
  - `autoRotationDeg` is absolute (relative to the unrotated photo): `−atan2(dy, dx)` of the ensemble eye line, re-measured once on the face's neighbourhood rotated by that estimate. It depends only on the photo, so one `L` press levels the eyes (residual < 0.2° on the real reference) and a second press changes nothing.
  - `face_engine::reference::REFERENCE_VERSION` (now 2) is part of the stored reference's analysis tag; a bump re-analyzes a restored reference without invalidating scan caches.

### 9.4 Days (ENGINE `days`, SESSION)
Pool = `included` photos (+ manual adds). Group by effective `dayKey`. Auto pick = max `score`, tie → earliest `takenAt`, tie → `relPath`. Days ascending; frames are rendered/exported in that order.

### 9.5 Alignment render (ENGINE `align`)
- Target anchors in output pixels: reference anchors (crop-normalized) × `(outW, outH)` (independent axes, legacy `scalePoints`).
- Output size: `Resolution` bounding-box rule shared with VIDEO (`timelapse_video::geometry::Resolution::output_size(crop_w, crop_h)`): fit inside 3840×2160 / 1920×1080 / 1280×720 oriented like the crop, even dims, ≥ 16 px; `source` = crop size capped to 3840×2160. Masters sample the full-resolution source photos, so presets larger than the crop are fine. Examples at 1080p: 1:1 → 1080×1080, 4:3 → 1440×1080, 3:4 → 1080×1440, **4:5 → 1080×1350**, 16:9 → 1920×1080, 9:16 → 1080×1920.
- Procrustes: **exactly the legacy formula** (LEGACY-SPEC §4.10 — RMS-ratio scale, `atan2(H10−H01, H00+H11)`, identity fallback), source anchors from the matched face, refined when `refineLandmarks` (re-run YuNet on a crop around the matched face bounds padded 50 % each side, resized so the crop's long edge = 640; take the detection with max IoU; fall back to scan anchors). Then compose `FrameAdjust` (rotate/scale about the output center, then translate `dx·outW`, `dy·outH`).
- Decode: JPEG DCT scale factor `f ∈ {1, ½, ¼, ⅛}` = smallest with `f ≥ 1.25 · s` (`s` = Procrustes scale full-res → output); transform adjusted by `1/f`.
- Warp: inverse mapping, bilinear, SIMD-friendly rows; outside the source → backdrop.
- Backdrop: `extended` (**default**, v1.2) = the **warped** source sampled clamp-to-edge, so the colours at the photo's border continue outward under the same transform, blurred with a σ that grows with the distance outside the photo — 1.5 % of the output long edge at the border, 4 % from 8 % of the long edge away — while the brightness falls smoothly from 1 to × 0.75 over the same distance (smoothstep): no brightness step and no rectangle where the photo ends, so nothing jumps between frames. Cheap: the photo is pre-shrunk and warped onto a reduced canvas (near σ = 2 px there), both blurs run at that size, the output samples the two layers bilinearly in one pass fused with the composite. `dimmed` (legacy) = untransformed source scaled to **cover**, centered, × 0.45, no blur; `blurred` = same cover image, Gaussian σ = 1.5 % of output long edge (downscale-blur-upscale), × 0.6; `black`.
- Feather: foreground alpha ramps to 0 at the warped source boundary over `max(2 px, 2.5 % of output long edge)` for `extended`, `max(2 px, 0.4 %)` for the other modes.
- `residualPx` = RMS distance between transformed source anchors and target anchors.
- Face stats for the look: Oklab mean/std (L, a, b) over region R (§9.6) of the un-normalized frame.
- Encode master JPEG q95 4:4:4 + previews 640 and 320 (q85/q80).

### 9.6 Look: exposure / white-balance normalization (ENGINE `color`)
- Region R (output-normalized, identical for every frame because faces are aligned): with eyes `eL, eR`, mouth corners `mL, mR`, `IPD = |eR − eL|`, `eyeY = mean(eL.y, eR.y)`, `mouthY = mean(mL.y, mR.y)`: `x ∈ [min(eL.x, mL.x) − 0.35·IPD, max(eR.x, mR.x) + 0.35·IPD]`, `y ∈ [eyeY − 0.45·IPD, mouthY + 0.35·IPD]` (cheeks, nose, mouth, lower forehead; little hair/background).
- Stats: pixels in R (stride 2) → linear sRGB → **Oklab**; keep pixels with L within [P2, P98]; mean μ and std σ per channel. Reference stats from the reference frame (`reference/frame` at output size) over the same R.
- Transfer per channel: `x' = (x − μs)·g + μr`, `g = clamp(σr/σs, 0.67, 1.5)` for L and `clamp(σr/σs, 0.5, 2.0)` for a/b; blend `x'' = x + strength·(x' − x)`. `exposure` = L only (chroma untouched); `exposureAndColor` = L, a, b (white balance via a/b mean shift). Applied to the whole frame, gamut-clipped in linear RGB.
- Implementation: per-frame 33³ RGB→RGB 3D LUT (trilinear), built in ~3 ms, applied in ~8 ms/MP. Oklab instead of CIELAB: perceptually uniform, no piecewise function, cheaper.
- Default `off` (legacy parity); UI offers an A/B toggle in the player.
- **`FrameSummary.lookDelta`** (`color::look_delta`, pure, computed from stats only — no pixels): with frame face stats `μs` and reference stats `μr` (Oklab means over R, as above) and `α = strength`, the post-look face-region means are `μ'_c = μs_c + α·(μr_c − μs_c)` for each transferred channel (the gain `g` scales deviations, so it does not move the mean).
  - `exposureEv = 3 · log2(μ'_L / μs_L)` — Oklab L ≈ Y^(1/3), so the luminance ratio is `(μ'_L/μs_L)^3`; positive = brightened. If `μs_L ≤ 0.01` → `lookDelta = null`.
  - `colorShift = 100 · α · hypot(μr_a − μs_a, μr_b − μs_b)` in `exposureAndColor` mode, `0` in `exposure` mode (chroma untouched). Unit: Oklab ΔE × 100 (≈ 2 is just noticeable).
  - `null` when `look.normalize = 'off'`, or the frame/reference stats are missing (e.g. manifest from an older engine, empty region). Round both to 2 decimals on the wire.

### 9.7 Export (ENGINE `export`, INTEGRATION job)
- Name `{dayKey without dashes}.{png|jpg}`; if taken in this batch **or on disk** and `overwrite == false` → `_1`, `_2`, … (legacy suffix style). Written as `name.tmp` in the target dir, then renamed.
- Pixels = master + look. `jpeg` with look off and quality 95 = byte copy of the master; otherwise decode → look → encode. PNG via `png` crate (fast compression).
- Video: frames = masters + look, resized to the video `Resolution` (≤ master; `source` = master) with `fast_image_resize`, fed to the VIDEO crate; caption text = `strftime(format)` of the frame's dayKey; written to a unique, exclusively created `{path}.{pid}-{n}.partial` then renamed (an existing `.partial` of anyone else is never touched); cancel/failure deletes it, and after a crash the next start does (§3).

### 9.8 Constants the agents must not get wrong (legacy traps)
| Topic | Correct value |
|---|---|
| Score cut-offs | **0.60 / 0.40** (the 0.75/0.55 comment in `faceEmbedding.js` is stale) |
| Legacy output size | the crop's **exact pixel size**, not 512 px (`OUTPUT_SIZES` is dead code) |
| Backdrop (legacy = `dimmed`) | cover-scaled, black overlay α **0.55** (= ×0.45), **no blur**; the rewrite defaults to `extended` (§9.5) |
| Procrustes scale | RMS ratio σr/σs, not least squares |
| Anchors | eye **centroids** (legacy) / YuNet eye points (new), order image-left first |
| Export suffix | `_1` first (not `_0`, not `(1)`), before the extension |
| Video legacy | default 10 fps, duration = N/10; sliders 1–60 fps, 1–120 s; two-decimal rounding; libx264 CRF 23 |
| Straighten | `angle = −atan2(dy,dx)`, applied only when the absolute angle exceeds 0.3°, clockwise-positive, canvas expands, black fill |
| Moved/added photo time | legacy stamped local **noon**; the rewrite stores `dateSource = 'manual'` instead (UI hides the time badge for `manual`) |
| Dates | naive local; never convert EXIF to UTC |

---

## 10. Product upgrades over legacy (priority order)

| # | Upgrade | Priority | Notes |
|---|---|---|---|
| U1 | Session persistence + instant restore, recents | **Must** | D7; reopen on the last reachable step |
| U2 | Reference-independent analysis cache; incremental rescans; rejects/no-face cached; changing the crop never rescans | **Must** | D9; warm rescan of 3,593 < 1 s |
| U3 | SFace matching, best face in multi-face photos, align that same face | **Must** | D8; fixes B1/B4 |
| U4 | **In-app timelapse player/scrubber** (play/pause, speed = video pace, scrub with year ticks, frame step, loop, crossfade preview) | **Must** | §8 |
| U5 | Video options: crossfade (frames + easing), date caption (format, position, size), resolution presets, quality presets/bitrate, first/last holds, cancel, ETA | **Must** | VIDEO crate; legacy coupling preserved |
| U6 | Exposure / white-balance normalization (Oklab mean/std on the face region, strength, A/B) | **Must** | §9.6; default off |
| U7 | Drag-and-drop of reference photo / folder onto the window | **Must** | §8 |
| U8 | Filename date fallback + visible date source | **Must** | D12 |
| U9 | Cancel + ETA + throughput on every job; partial work kept | **Must** | D3/D4 |
| U10 | Export safety: never overwrite (opt-in), completion summary, Reveal in Finder | **Must** | D13 |
| U11 | Output resolution presets for aligned frames (default 1080p, `source` = legacy) | **Must** | D11 |
| U12 | Keyboard-first batch review: filmstrip + focus view, Y/N/U, undo stack, side-by-side with reference, confirm-all | Should | §8 keys |
| U13 | Onion-skin overlay (reference or previous frame, opacity, difference blend) + anchor overlay | Should | player + viewer |
| U14 | Manual per-frame nudge (dx, dy, scale, rotation) with live re-render | Should | `set_frame_adjustment` |
| U15 | Alignment quality flags: sort/filter by `residualPx`, highlight outliers (> 3× median) | Should | |
| U16 | Exclude a day from the timelapse | Should | `set_day_excluded` |
| U17 | Backdrop modes (extended (default) / dimmed / blurred / black) + feathered edge | Should | §9.5 |
| U18 | Window size/position persistence (`tauri-plugin-window-state`) | Should | |
| U19 | Smart daily pick (sharpness + frontality + score) | Could | needs ENGINE metrics |
| U20 | "Day starts at" hour for after-midnight selfies | Could | session setting |
| U21 | Dock/taskbar progress (`Window::set_progress_bar`) and notification when a long job ends unfocused | Could | |
| U22 | HEIC via macOS ImageIO | Could | D17 |
| U23 | GIF / WebM export | Could | |
| U24 | Auto-update (`tauri-plugin-updater`) | Could | D18 |

---

## 11. Performance budget and measurement

Machine: Apple M3 Max (16 cores), 64 GB, release build, test set = 3,593 photos (7.9 GB).

| Metric | Budget | How it is measured |
|---|---|---|
| Scan, cold app cache, warm OS page cache | **≥ 100 photos/s** (≤ 36 s total) | `cargo test -p face-engine --release --test real_scan -- --ignored --nocapture` (run twice; 2nd run = warm OS cache); prints photos/s; asserts ≥ 100 |
| Rescan with valid analysis cache | ≥ 5,000 photos/s (< 1 s) | same test, second scan pass |
| Per-stage | decode 640 ≤ 12 ms, detect ≤ 8 ms, embed ≤ 6 ms per photo per core | criterion `benches/analyze.rs` |
| Reference crop update (detect + embed + rematch 3,600) | < 150 ms p95 | criterion `benches/reference.rs` |
| Align (1080p masters) | ≥ 60 frames/s | `real_align` ignored test |
| Protocol | hit < 5 ms p95; miss (thumb 320 from cache-less source) < 40 ms | `src-tauri/benches/protocol.rs` |
| Video encode 1080×1080 | ≥ 60 frames/s | VIDEO `benches/encode.rs` |
| Cold start → interactive | **< 1 s** (process start → first `get_session` served → UI `show()`) | `FT_TRACE_STARTUP=1` logs `startup.ms` milestones; smoke run asserts |
| UI | **60 fps**: p95 frame ≤ 16.7 ms, no long task > 50 ms while flinging a 3,600-item grid and calendar | Playwright perf spec (Chromium, mocked IPC): rAF sampling + `PerformanceObserver('longtask')` |
| Peak RAM | **< 1.5 GB** (backend RSS + WebView processes) during full scan + align of 3,593 | smoke script samples `ps -o rss` of the app and its WebKit children every 250 ms. macOS: the app relaunches itself once at startup with `MallocLargeCache=0` (`lean_malloc` in `main.rs`, constants in `startup.rs`): libmalloc's large-block cache otherwise keeps up to 64 freed decode/inference/warp buffers dirty (≈ 0.85 GB on a 64 GB Mac) and the backend stays near its highest peak for the session |
| JS | < 300 KB gz initial, < 50 KB CSS | `vite build` report gate |

Rules that make the budget reachable: DCT-scaled decode, one decode per photo per stage, bounded queues (`2 × workers`), shared model weights, thumbs written during scan, no base64 anywhere, LIFO protocol pool, virtualization everywhere.

---

## 12. Testing strategy

Rust
- `face-engine`: unit tests per module — date parsing (every filename shape in LEGACY-SPEC §4.8, invalid dates, precedence), walk (dotfiles, symlinks, extensions), Procrustes (port the legacy test vectors + rotation recovery), calibration monotonicity/continuity, best pick ties, export naming incl. on-disk conflicts, cache round-trip / corruption / fingerprint invalidation, warp/backdrop/feather on synthetic images, look transfer (result μ/σ within 2 % of target on synthetic patches, strength 0 = identity).
- Real-photo integration tests: `FT_PHOTOS_DIR` (default `/Users/gingerman/Projects/everyday photos/photos` when it exists) and `FT_REFERENCE_PHOTO` (default `…/reference/IMG_20140815_142326.jpg`); if missing, print `skipped: <reason>` and pass. Never copy, modify or commit these photos; outputs go to `tempfile` dirs; no golden images derived from them are committed. Throughput tests are `#[ignore]` and run with `--release`.
- `timelapse-video`: timing parity with legacy rounding, MP4 structure (frame count, timescale, dims), encode/cancel.
- `src-tauri`: session derivations (counts, days, moves, selection fallback, per-folder decisions), persistence (round-trip, corrupt/unreadable recovery, debounce schedule as a pure function), job registry (busy rule, cancel, terminal event exactly once, `started` first), path grants, quit during a job, crash leftovers, protocol routing/headers/buckets/404/405/CORS with a fake engine plus the miss pool (renders counted for coalescing, panicking render, queue overflow, shutdown), contract drift test (§7.6), `smoke_pipeline` (real photos, 200 stride-sampled: scan → auto-review → days → align → export images + video into a temp `FT_DATA_DIR`).
- Benches: criterion in each crate (§11).
- Coverage: `cargo llvm-cov --workspace --fail-under-lines 80 --ignore-filename-regex '(src-tauri/src/(main|lib)\.rs|/benches/)'` **without** real photos (CI value); real-photo runs only add coverage.

Frontend
- Vitest + Testing Library (jsdom): `lib/` (crop math incl. legacy cases, video coupling vs legacy `toFixed(2)`, steps reachability, dates), `ipc/client` (error narrowing, job lifecycle), every feature screen against `fakeBackend` via `mockIPC` (setup crop + inline no-face, review keyboard + undo, days select/move/exclude/add, timelapse player controls, export modals and coupling, DnD overlay via mocked `tauri://drag-drop` events). Coverage (v8) ≥ 80 % lines and branches.
- Playwright E2E against the Vite dev server with `VITE_FT_MOCK=1`: full happy path, cancel paths, error paths (busy, noFaceInReference, permissionDenied), first-run and restored-session starts. Screenshots of setup, scan, review, days, timelapse (grid, player, onion skin), export video modal at **1024×768, 1440×900, 1920×1080** in **light and dark** (`colorScheme` emulation), animations disabled, `maxDiffPixelRatio 0.01`, baselines per platform (CI = Linux). `@axe-core/playwright`: zero serious/critical violations per screen. Perf spec per §11.
- Final real-app smoke (INTEGRATION, local macOS): `cargo tauri build --debug`; run with a temp `FT_DATA_DIR`, `FT_TRACE_STARTUP=1` and the debug-only `FT_DEV_AUTOLOAD="reference=<ref>;folder=<photos>"`; drive scan → review → days → align → player → export (computer-use or manual), capture window screenshots (`screencapture -l<windowid>`), check the log for errors and startup timing, sample RSS; store artifacts outside the repo (they contain personal photos).

CI (GitHub Actions, `.github/workflows/ci.yml`; releases in `release.yml`): `cargo fmt --all --check`; on macOS, Linux and Windows `cargo clippy --workspace --all-targets --locked -- -D warnings` and `cargo test --workspace --locked`; Rust coverage on Linux (`cargo llvm-cov --workspace`, gate ≥ 80 % lines); UI `npm ci && npm run typecheck && npm run lint && npm run test:coverage` + Playwright E2E (Linux) and visual baselines (macOS); a Tauri build smoke on macOS (`npm --prefix ui run tauri -- build --debug --no-bundle`). ONNX models are fetched by script with pinned SHA-256 and cached. `Cargo.lock` is committed (`--locked`).

---

## 13. Security

- **Capabilities** (`src-tauri/capabilities/main.json`, window `main`, `local: true`, no `remote`):
  `core:event:allow-listen`, `core:event:allow-unlisten` (drag-drop, `session-changed`, `models-changed` and `show-keys` events; no `allow-emit`/`allow-emit-to`, so the webview cannot fake backend events), `core:window:allow-show`, `core:window:allow-start-dragging` + `core:window:allow-internal-toggle-maximize` (custom title bar), `core:window:allow-set-theme` (native theme/material follows an explicit in-app Light/Dark choice), plus one `allow-<command>` per command in §7.2 generated by `tauri_build::AppManifest::new().commands(&[...])` in `build.rs` (all 31, `allow-open-path` included since v1.7; verify identifiers in `gen/schemas`). No `fs`, `shell`, `http`, `dialog` or `opener` JS permissions — those plugins are used from Rust only (`reveal_item_in_dir` for `reveal_path`, `open_path` for `open_path`); `open_js_links_on_click` stays off.
- **CSP** (`app.security.csp`):
  `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' ftimg: http://ftimg.localhost blob: data:; connect-src ipc: http://ipc.localhost ftimg: http://ftimg.localhost; font-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'`
  (`'unsafe-inline'` for styles only, because React writes `style` attributes; scripts get Tauri's nonces/hashes.) `withGlobalTauri: false`, `freezePrototype: true`, `assetProtocol.enable: false`, `dangerousDisableAssetCspModification: false`.
- **Protocol scope**: ids only (hex regex), only ids registered in the session, `GET` only, fixed width buckets, no directory listing, no path segments from the request reach the filesystem. The `preview` route (v1.7) renders only from the session's own library entry (its path and cached landmarks) and writes only into `previews/`.
- **Path grants** (§7.1, `src-tauri/src/grants.rs`): the webview can only name paths the user chose — dialog results, OS drops (recorded in `on_window_event`/`on_webview_event`; Tauri emits the drop to the webview first, but commands are dispatched on the main thread, which is busy recording the grant until it exists), and the session's own paths. A path whose spelling lies inside no grant is refused without any file-system access (no existence oracle; on Windows no UNC/device/WebDAV/`GLOBALROOT` spelling is opened unless it was chosen); a granted spelling is resolved and must stay inside its resolved grant (directory symlinks cannot lead out). Exports write only into the picked folder / to the picked file (or an earlier finished output); `reveal_path` applies the same two-step rule to the outputs.
- **Navigation**: the webview may only show the bundled UI (`on_navigation`: `tauri://localhost`, `http(s)://tauri.localhost`, `about:blank`, and in debug the dev server); every new-window request is denied. The opener plugin's injected link-click handler is disabled (`open_js_links_on_click(false)`); it is used from Rust only (reveal).
- **Untrusted images**: every decode is bounded before allocating — any side > 16,384 px, > 150 MP or a file > 256 MiB is refused (`decodeFailed`), JPEG decoders get a buffer cap, other formats explicit `image` limits — and full-resolution buffers share a global 400 MP budget: a share is taken before the decoder allocates (for jpeg-decoder its planes plus the RGB output, plus a progressive/lossless file's full-resolution coefficient planes whatever output size is asked for) and stays with the decoded image until it is dropped or released. The budget cannot deadlock: no thread runs parallel (rayon) work while holding a share — the scan shrinks large decodes to its working size before detecting, align releases before compositing, the reference before rotating, the 112×112 face crop is warped on the calling thread, and every parallel loop asserts the rule in debug builds — and a thread that holds a share never waits for another (flagged in debug builds), while waiting requests are served first-in, first-out (a whole-budget request cannot starve). A few-hundred-byte "bomb" costs at most one budget's worth of memory however many workers decode at once (measured: a 623-byte progressive 144 MP bomb peaks at 1.3 GB with 1, 4 or 8 threads). The video crate's `decode_image` applies the same side/pixel limits.
- **Files we write**: temporary, probe and partial files are created exclusively (`O_CREAT|O_EXCL`; unique `pid`-sequence names), so a planted symlink or an existing file is never followed, truncated or deleted; image exports place results with a no-replace hard link (or exclusive create + copy), so a file appearing meanwhile is never overwritten. App data/cache/log folders are `0700` on Unix.
- **Models**: release builds load the ONNX models only from the bundle's resources (`FT_MODELS_DIR` and the repository fallback are debug-only); each file is read once, checked against its pinned SHA-256, and the models are built from those same bytes (no second read, no swap window).
- **Command input validation** (§7.2): granted absolute paths, existence/type checks, extension allow-list, numeric ranges, `reveal_path` restricted to outputs this app wrote (`session.outputs`), `open_path` (v1.7) restricted to exactly those outputs that are `.mp4` regular files (no remote spellings, no links, one `notFound` for every refusal), video path must end in `.mp4`.
- **Process**: no network clients compiled in; no telemetry; never image bytes in logs. Logs do contain user file paths at `warn`/`error` (e.g. a photo that failed to decode) — they stay in the user's own `0700` log folder and are needed to diagnose real failures.
- **macOS**: hardened runtime, not App-Sandboxed (arbitrary user folders); Info.plist usage strings `NSDesktopFolderUsageDescription`, `NSDocumentsFolderUsageDescription`, `NSDownloadsFolderUsageDescription`, `NSRemovableVolumesUsageDescription`, `NSNetworkVolumesUsageDescription`. Supply chain: `cargo deny` (licenses: MIT/Apache/BSD/OFL/ISC/Zlib; openh264 BSD-2), `cargo audit`, `npm audit --omit=dev` in CI.

---

## 14. Packaging

`tauri.conf.json`: `productName "FaceTimelapse"`, `identifier "io.github.gingerman960.facetimelapse"`, `version "2.0.0"`; `bundle.macOS.minimumSystemVersion "13.0"` (the UI uses `oklch()` and `color-mix()`, which need the system WebKit at Safari 16.2+; macOS 13 Ventura is the oldest release where that is the norm rather than an optional Safari update, so it is the floor we promise — on an older WebKit those colours would silently not render); window `main`: 1280×832, min 960×640, `visible: false`, `titleBarStyle: "Overlay"` + `hiddenTitle: true` on macOS (DESIGN reserves ~78 px for traffic lights and marks drag regions with `data-tauri-drag-region`), `dragDropEnabled: true`, `theme: null` (follow system). Bundle: macOS `.app` + `.dmg` (aarch64 and x86_64), Windows NSIS, Linux AppImage + deb; `bundle.resources` = the ONNX models (location defined by ENGINE) + `licenses/` (`THIRD-PARTY-NOTICES.txt` generated by `scripts/third-party-notices.py` from `cargo metadata` and the UI's production npm packages, plus the YuNet MIT / SFace Apache-2.0 notices, the OpenH264 BSD-2 text with its H.264 patent caveat, and the Bricolage Grotesque + Martian Mono OFL 1.1 texts — UI fonts ship in `ui/`, the caption font is embedded in `timelapse-video`). Icons generated from `assets/icon.png` via `tauri icon`. Workspace profiles: `[profile.release] lto = "thin", codegen-units = 1, strip = "debuginfo"`; `[profile.dev.package."*"] opt-level = 2` (image code is unusably slow at `-O0`). Linux build deps: `libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf`.

---

## 15. Risks and open items

| Risk | Mitigation |
|---|---|
| SFace thresholds on a 10-year single-person set | ENGINE calibration step (§9.3); uncertain band + keyboard review absorbs error |
| ONNX runtime choice (pure-Rust `tract` vs `ort`) affects speed and packaging | ENGINE decides and documents; budget §11 is the acceptance test; if `ort`, bundle its dylib per platform |
| openh264 encode speed at 2160p | VIDEO bench; `quality` presets use QP; `videotoolbox` feature stays experimental |
| Windows: custom-scheme origin `http://ftimg.localhost` | Always build URLs from `imageBaseUrl`; CSP lists both forms |
| HTML5 DnD disabled on Windows by native file drop | D14 (`@dnd-kit`) |
| `@tauri-apps/api/mocks` channel delivery details | Isolated in `ipc/mock`; fallback documented in §8 |
