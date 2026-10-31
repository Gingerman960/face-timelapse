# FaceTimelapse — Legacy Behavioral Spec (Electron v1.2.1)

> Status: reference document for the Tauri rewrite. Owner: ARCHITECT.
> Source of truth: `electron/main.js`, `electron/preload.js`, `electron/services/*`,
> `renderer/src/**`, `tests/**`, `README.md`, `docs/BUILD.md`, `assets/screenshots/*`.
> Everything below describes what the legacy app **does**, including its bugs.
> What the rewrite keeps, changes or drops is decided in `ARCHITECTURE.md`; this
> file only says where legacy behavior is intentionally *not* preserved (§11).

---

## 1. Runtime and platform

| Item | Legacy value |
|---|---|
| Shell | Electron 31, `contextIsolation: true`, `nodeIntegration: false`, `sandbox: false` |
| Window | 1200×800, min 900×600, `backgroundColor #1a1a1a`, single window; macOS keeps app alive when all windows close |
| Dev | Vite on `http://localhost:5173`, DevTools auto-open |
| UI | React 18, Zustand 5, plain CSS (`renderer/src/index.css`, Inter via Google Fonts `@import`) |
| Detection | `@vladmandic/face-api` 1.7.15 (SSD MobileNet v1 + 68-point landmark net), tfjs backend chosen at runtime: `FACE_API_BACKEND` env (`gpu`/`node`/`wasm`) → tfjs-node-gpu → tfjs-node → WASM (always last). Models from `./models` (dev) or `resources/models` (packaged) |
| Image I/O | `sharp` (decode, EXIF auto-orient, resize, crop, rotate, JPEG/PNG encode), `@napi-rs/canvas` (warp/compose) |
| EXIF | `exifr` |
| Video | `fluent-ffmpeg` + `ffmpeg-static` (libx264) |
| Updates | `electron-updater`, packaged builds only, auto-download, install on quit, errors only logged |
| Startup | delete temp files (§9.7) → prune scan caches older than 30 days → register `safe-file://` → load models (failure only logged) → create window → auto-update check |
| Packaging | electron-builder: appId `io.github.gingerman960.facetimelapse`, productName `FaceTimelapse`; mac dmg x64+arm64, win nsis x64, linux AppImage x64; models as extraResources |

---

## 2. Workflow, steps and navigation

Steps (header stepper labels): `1. Setup` → `2. Scan` → `3. Confirm` → `4. Select` → `5. Align` → `6. Results`.
Store key `step` ∈ `setup | scanning | confirm | dailySelection | aligning | results` (default `setup`).

Stepper rules (`App.jsx`):
- Badge classes: `active` for every step ≤ current, `current` for the current one.
- A step is clickable only if it is **before** the current step **and** not transient (`scanning`, `aligning`). Clickable badges render as `<button>` (`aria-label "Go back to {label}"`), others as `<span>`; current has `aria-current="step"`.
- Clicking jumps directly (`setStep`), no confirmation, no state reset.
- Forward navigation via the stepper is impossible.

Transitions:

| From | Trigger | To | Side effects |
|---|---|---|---|
| setup | Start Scan (needs `referenceEmbedding` && `sourceFolderPath`) | scanning | — |
| scanning | scan resolves, ≥1 `uncertain` | confirm | `candidates = results` |
| scanning | scan resolves, 0 `uncertain` (incl. 0 results) | dailySelection | `dailyGroups = groupByDay(results)` |
| scanning | Cancel | setup | immediately; promise later resolves and routes to setup again |
| scanning | scan rejects | setup | error banner |
| confirm | last uncertain decided (auto) / "Done Reviewing" | dailySelection | `dailyGroups = groupByDay(candidates)` — **rebuilds groups, discarding moves/selections/added photos** |
| dailySelection | Back | setup | (skips confirm) |
| dailySelection | Align N Photos | aligning → results | `alignedResults = results.filter(r => r.outputPath)` |
| aligning | batch rejects | dailySelection | error banner |
| aligning | Cancel | results (partial) then **dailySelection 1.5 s later** (bug B6) | |
| results | Back | dailySelection | |
| any | stepper click on earlier non-transient step | that step | e.g. results → Confirm with nothing pending immediately auto-advances and **re-groups** (bug B19) |

Global error banner (`role="alert"`): shows `store.error`, dismiss "×" clears it. Errors are raw `err.message` strings.

---

## 3. Screens

### 3.1 Setup (`SetupView.jsx`) — split view, left "Reference Photo", right "Source Folder" + "Ready to Scan"

Reference photo:
- **Choose Reference Photo** → native open dialog, filter `Images: jpg jpeg png heic tiff webp` (note: no `tif`). Sets `referenceImagePath`, remembers it as the *original* path, clears `cropParams`.
- Path shown in a monospace box. Image displayed via `safe-file://{path}` (Chromium applies EXIF orientation; `naturalWidth/Height` are oriented).
- Crop canvas: preview width `pw = min(380, naturalWidth)`, `ph = round(pw / ratio)` (only the width is capped — portraits get taller than 380 px).
- Initial crop on every image load: `computeARCrop(center, aspect)` = largest rect of the target aspect centered in the preview (full image for `free`/unknown).
- Overlay: 4 dark panels outside the box, bordered box, 8 square handles (10 px visual, 18 px hit box) `nw n ne e se s sw w` with matching resize cursors; rule-of-thirds grid only while dragging; cursor `move` inside, `grabbing` while moving.
- Drag inside = move. Handle drag = resize. Min box 30 preview px. `clampBox` keeps it inside the preview.
- Aspect-locked resize: corner → width from dx drives height (`h = round(w/AR)`), recomputed back to keep AR, anchored at the opposite corner; e/w edge → width drives height, vertical center kept; n/s edge → height drives width, horizontal center kept. `clampBox` afterwards clamps w and h independently, which can break the aspect lock at image edges (bug B38).
- Free resize: each edge moves independently, min 30.
- Keyboard: ArrowKeys nudge the box 1 px (Shift: 10 px) only when `document.activeElement` is `<body>`; Escape ends a drag (does not restore the pre-drag box).
- Controls row (when image loaded): **↻ Align Face** (label `Aligning…` while busy), **⊙ Center Face** (`Detecting…`), **Reset**. Hint: "Drag handles to resize · drag inside to reposition".
- **Align Face** (straighten): always on the *original* file. `face:detectBounds` (1024 px fit-inside JPEG q85) → eye centers = centroid of landmarks 36–41 (image-left) and 42–47 (image-right); `angle = −atan2(dy, dx)·180/π` with `d = rightEye − leftEye`. If `|angle| > 0.3°` → `image:straighten` writes `os.tmpdir()/facetimelapse-straightened-{ts}.jpg` (EXIF auto-orient, then `rotate(angle)` with black fill, **canvas expands**, JPEG q92) and that temp path becomes `referenceImagePath`. Else, if currently on a temp file, revert to the original. Failures are silent.
- **Center Face**: `face:detectBounds` on the current image → `faceBox` = bounding box of all 68 landmarks (1024-space) → mapped to preview. New size = current size, shrunk only if it does not fit with the face exactly centered (`maxW = 2·min(cx, pw−cx)`, `maxH` likewise; aspect-locked shrink keeps AR); box centered on the face, clamped. Failures silent.
- **Reset**: if on a straightened temp → revert to the original file (crop re-inits on load); else crop = `computeARCrop(center)`.
- **Output Aspect Ratio** buttons: `free 1:1 4:3 16:9 9:16 3:4`. Store default is `'original'` (no button highlighted; behaves like `free`). Changing aspect reshapes the box around its current center.
- **Auto "set reference"**: whenever path/crop/aspect changes and no drag is in progress, after a **500 ms debounce** call `face:setReference` with `cropParams` = preview box scaled by `raw/preview` per axis and rounded, or `null` if the box covers the whole preview (within 2 px on each dimension). Hint "Detecting face…" while running. Errors → global banner (e.g. "No face detected in reference photo"); `referenceEmbedding` keeps its previous value.

Source folder:
- **Choose Folder** → native directory dialog → `sourceFolderPath`, path shown.
- **Rescan from scratch** (ghost button, only when folder && embedding): `window.confirm("Clear the cached scan results for this folder and reference photo? The next scan will re-process every photo from scratch.")` → `face:clearScanCache`. No success feedback.

Ready to Scan: hints "Set a reference photo first." / "Choose a source folder."; **Start Scan** disabled until both exist.

### 3.2 Scanning (`ScanningView.jsx`)
- Title "Scanning Photos…", progress bar `index/total` (never reaches 100% because `index` max is `total−1`), status "Scanning {filename} ({index+1} / {total})" or "Starting…".
- Counters: Confirmed (green), Uncertain (amber), "From cache" (muted, only if > 0). **Cancel** (danger).
- Live mosaic: base64 100×100 thumbnails of newly *analyzed* (not cached) photos, including rejected/no-face ones; only the **last 65** kept (grid `minmax(72px,1fr)`).
- Empty folder → resolves `[]` instantly → dailySelection with an empty calendar (no "nothing found" message).

### 3.3 Confirm (`ConfirmView.jsx`)
- Shows `uncertain` candidates one at a time, in candidates order (score desc).
- Title "Review Uncertain Matches" + `uncertain` badge; subtitle "Press → or Enter to confirm, ← or Backspace to reject"; counter "{min(i+1,total)} of {total} uncertain photos".
- Card: **full-resolution** source as base64 (`image:getBase64` without `maxDim`; LRU of 30), "Loading…" placeholder; filename; "{round(score·100)}% similarity" colored `≥0.60 #00cc66`, `≥0.40 #f0a030`, else `#cc3333`; date `toLocaleDateString()`; buttons **Confirm (→)** / **Reject (←)**.
- Keys (window-level, regardless of focus): `ArrowRight`/`Enter` confirm, `ArrowLeft`/`Backspace` reject. No undo.
- **Done Reviewing** + hint "You can stop reviewing early — remaining uncertain photos will be excluded." Remaining stay `uncertain` and are excluded by `groupByDay`.
- When no uncertain remain → auto-advance (re-groups).

### 3.4 Daily selection (`DailySelectionView.jsx`)
Layout: left calendar sidebar, right day panel, bottom footer (see `assets/screenshots/daily-selection.png`).
- Sidebar title "Calendar ({days} days)", legend `1 photo` (green) / `multiple` (amber).
- Months rendered for **every** month from first to last photo date (≈130 months for the test set; not virtualized). Header `toLocaleDateString(undefined, {year:'numeric', month:'long'})`, weekday header `Su Mo Tu We Th Fr Sa` (Sunday first).
- Day cells are `<button>` with `aria-label "{Month Year} {d} — {n} photo(s)"` or "… — no photo, click to add", `aria-pressed` when active; classes `has-single`, `has-multi`, `active`, `drag-over`.
- Click day with photos → activate. Click empty day → **add photo**: native file dialog → appended group `{date, photos:[{filePath, filename, similarityScore: 1.0, status:'confirmed', creationDate: local noon of that day, embedding:null}], selectedIndex:0}`. No face check until alignment.
- Initial active day: first day with > 1 photo, else first day.
- Day panel title: `toLocaleDateString(undefined,{weekday:'short', year, month:'long', day})` + " — Auto-selected" (1 photo) or " — Pick one (N photos)".
- Photo grid (`role=radiogroup`, `minmax(130px,1fr)`): card = thumbnail (**full-res base64**, concurrency 4, LRU 300), `Selected` badge, time badge `HH:MM` (`en-GB`, 24 h) only when the day has > 1 photo and the time is not exactly 12:00:00 (moved/added photos are stamped at noon), score badge `{pct}%`. Click selects.
- Drag a photo (only when the day has > 1 photo — a single photo cannot be moved) onto a calendar day → `movePhotoToDate`: photo gets `creationDate = local noon of target`; removed from source (selection index adjusted: before → −1; the selected one removed → `min(sel, len−1)`; after → unchanged); merged into target sorted by score desc (target keeps its `selectedIndex`) or a new group is created; empty groups dropped; groups re-sorted by date; target day becomes active. Title tooltip: "…Not saved across rescans."
- "Selected: {filename} · {HH:MM}".
- Footer: **Back** (→ setup), "{N} photo(s) to align", **Align {N} Photos** (disabled when 0 or running; `setError('No photos selected')` guard).

### 3.5 Aligning (`AligningView.jsx`)
- Title "Aligning Photos…", progress `current/total`, "Processing {filename} ({current} / {total})", counter "Aligned", **Cancel** → `Cancelling…`.
- Preview mosaic of the last 65 aligned outputs (loads each **full PNG** as base64).
- Cancel: `face:cancelAlign`, then unconditional `setTimeout(setStep('dailySelection'), 1500)` (bug B6).

### 3.6 Results (`ResultsView.jsx`)
- Title "{N} Aligned Photos". Grid `minmax(160px,1fr)` of all results (**not virtualized**); each card lazy-loads via one shared `IntersectionObserver` (rootMargin 200 px), FIFO queue concurrency 6 (skips requests whose card left the viewport), global LRU of 250 resident thumbnails (evicts only off-screen ones). Thumb = `image:getBase64(outputPath, {maxDim: 400})` (decoded and re-encoded JPEG q82 on every request; no disk cache). Date badge `toLocaleDateString()`. Card is a button (`aria-label "View photo from {date}"`), Enter/Space open.
- Fullscreen viewer (`role=dialog`): image at `maxDim 2400` turned into a `blob:` URL (revoked on change/unmount); top bar "i / N", date `toLocaleString()`, close ×; left/right nav zones; keys Esc / ← / →; backdrop click closes; focus moves to close button.
- Export progress block: "Exporting… {filename}" + bar; disappears when done (no success message).
- Footer: **Back** (→ dailySelection), **Save to Folder** (disabled while exporting or 0 results), **Create Video** (disabled when < 2), "{N} photos".

### 3.7 Video export modal (`VideoExportModal.jsx`)
- Title "Create Timelapse Video". FPS slider `1..60 step 1`, default **10**, label `{fps.toFixed(1)} FPS`. Duration slider `1..120 step 1`, default `count/10`, label `{duration.toFixed(1)}s`.
- Coupling: FPS change → `duration = count/fps`; duration change → `fps = count/duration` (fps may become fractional or exceed 60; the duration may exceed 120 — the slider thumbs then pin at their ends while labels show the real value).
- **Export MP4** → save dialog, default name `facetimelapse_{Date.now()}.mp4`, filter mp4 → `video:export` with `fps = Number(fps.toFixed(2))`, `totalDuration = Number(duration.toFixed(2))`.
- Progress "Encoding… {pct}%" → "Export complete!". Cancel button disabled during encode (no real cancel exists); after completion it reads **Close** and Export disappears.
- Esc and overlay click close only when not exporting; focus trap (Tab/Shift-Tab wrap); initial focus on the FPS slider. Disabled when `count < 2`.

---

## 4. Algorithms and exact constants

### 4.1 File discovery (`photoScanner.listImageFiles`)
- Recursive `readdirSync`; skip any entry whose name starts with `.`; recurse into real directories only (symlinked directories are *not* followed); accept regular files **and file symlinks** whose lowercase extension ∈ `{.jpg, .jpeg, .png, .heic, .tiff, .tif, .webp}`. Read errors silently yield nothing. Order = `readdir` order (not sorted).
- HEIC is listed but sharp's prebuilt libvips cannot decode HEVC-HEIC → such files fail to decode and are silently skipped.

### 4.2 Per-photo scan (`scanWorker.js`)
1. Thumbnail: `sharp(path).rotate().resize(100,100,{fit:'cover'}).jpeg({quality:60})` → base64 (failure ignored).
2. Scan buffer: `sharp(path).rotate().resize(400,400,{fit:'inside'}).jpeg({quality:85})`. Failure → `skipped`.
3. Detect (§4.3) on the 400 px buffer. None → `skipped`.
4. Embedding (§4.5) → similarity vs reference (§4.6) → category. `rejected` → `skipped` (not returned).
5. Date (§4.8) only for kept photos.
6. Result `{filePath, filename, embedding[45], similarityScore, status, creationDate (ISO UTC string)}`.
Final list sorted by `similarityScore` desc; rejected / no-face / undecodable photos are absent.

### 4.3 Face detection (`faceDetection.js`)
- `SsdMobilenetv1Options({ minConfidence: 0.3 })` + `faceLandmark68Net`; all faces detected; the **largest bounding-box area** wins.
- Input: an encoded image buffer drawn onto a canvas at native size of that buffer.
- Resolutions used: scan 400 px fit-inside; reference = the whole cropped reference (full resolution); `detectBounds` 1024 px fit-inside; alignment = **full-resolution PNG** of the source.
- Output: `landmarks68` (face-api index map: contour 0–16, left brow 17–21, right brow 22–26, nose bridge 27–30, nose base 31–35, left eye 36–41, right eye 42–47, outer lips 48–59, inner lips 60–67; "left/right" = image left/right), `alignmentPoints`, `imageSize {w,h}`.

### 4.4 The 5 alignment anchors (in this order)
`[centroid(L36..41), centroid(L42..47), L30 (nose tip = last nose-bridge point), L48 (mouth corner, image-left), L54 (mouth corner, image-right)]`.

### 4.5 45-feature geometric embedding (`faceEmbedding.generateEmbedding`)
Notation: `L` = 68 landmarks; `LE=L36..41`, `RE=L42..47`, `LB=L17..21`, `RB=L22..26`, `NB=L27..30`, `NS=L31..35`, `OL=L48..59`, `IL=L60..67`, `C=L0..16`; `c()` centroid, `w()`/`h()` x/y extent, `d()` Euclidean distance; `IPD = d(c(LE),c(RE))`, `R = IPD>0 ? IPD : 1`; `EM` = midpoint of eye centroids; `NT = L30`; `MC = c(OL)`; `NC = c(NS)`; `top = min y(C)`, `bot = max y(C)`, `V = bot − top`. Ratios with a zero denominator yield 0.

| # | Feature | # | Feature | # | Feature |
|---|---|---|---|---|---|
| 1 | w(LE)/R | 16 | w(NB)/R | 31 | (bot − MC.y)/V |
| 2 | h(LE)/R | 17 | h(NB)/R | 32 | IPD/V (raw IPD) |
| 3 | w(RE)/R | 18 | d(NT,EM)/R | 33 | d(C4,C12)/R |
| 4 | h(RE)/R | 19 | w(OL)/R | 34 | d(C1,C15)/R |
| 5 | h(LE)/w(LE) | 20 | h(OL)/R | 35 | d(C4,C12)/d(C1,C15) |
| 6 | h(RE)/w(RE) | 21 | h(OL)/w(OL) | 36 | atan2(C4−C8) (radians, y then x) |
| 7 | w(LB)/R | 22 | w(IL)/R | 37 | atan2(C12−C8) |
| 8 | w(RB)/R | 23 | h(IL)/R | 38 | #36 + #37 |
| 9 | h(LB)/R | 24 | h(IL)/w(IL) | 39 | d(C8, mid(C4,C12))/R |
| 10 | h(RB)/R | 25 | d(MC,NC)/R | 40 | d(EM,NT)/R |
| 11 | d(c(LB),c(LE))/R | 26 | d(L48,L54)/R | 41 | d(NT,MC)/R |
| 12 | d(c(RB),c(RE))/R | 27 | w(C)/h(C) (1.0 if h=0) | 42 | d(MC, ((C0.x+C16.x)/2, bot))/R |
| 13 | w(NS)/R | 28 | (EM.y − top)/V | 43 | d(EM,MC)/R |
| 14 | h(NS)/R | 29 | (NT.y − EM.y)/V | 44 | (NC.x − EM.x)/R |
| 15 | h(NS)/w(NS) | 30 | (bot − NT.y)/V | 45 | (MC.x − EM.x)/R |

If `V ≤ 0` after feature 27, the vector is zero-padded to 45. (Jaw indices: `C[floor(17/2)=8]` chin, `C[floor(17/4)=4]`, `C[floor(51/4)=12]`, `C[1]`, `C[15]`.)

### 4.6 Similarity and categories
- `similarity(a,b) = exp(−‖a − b‖₂ / 1.5)`; `0` if either is null or lengths differ. (Called "Gaussian" in docs; it is actually a Laplacian kernel `e^(−d/σ)`, σ = 1.5.)
- Thresholds (`THRESHOLDS`): **confirmed ≥ 0.60**, **uncertain ≥ 0.40**, else rejected. The doc comment in the same file saying 0.75 / 0.55 is stale — code and tests use 0.60 / 0.40.
- UI shows `round(score·100)%` and colors with the same 0.60/0.40 cut-offs.

### 4.7 Reference setup (`face:setReference`)
`sharp(path).rotate()` (EXIF) → optional `rotate(rotationAngle, black)` if `|angle| > 0.01` (never sent by the UI) → optional `extract(round(x), round(y), round(w), round(h))` → `toBuffer()` (re-encoded in the input format, JPEG default q80) → `outputSize = {w,h}` of that buffer (**the crop's exact pixel size**) → detect (§4.3) on that buffer, throws `"No face detected in reference photo"` → embedding → `previewBase64` (512 px fit-inside, JPEG q80, **never displayed**). Returns `{embedding, landmarks68, alignmentPoints, imageSize, outputSize, previewBase64}`.

### 4.8 Capture date (scan worker)
Order: EXIF `DateTimeOriginal` → EXIF `CreateDate` (tag 0x9004 DateTimeDigitized) → EXIF `ModifyDate` (0x0132 DateTime) → filesystem `birthtime` → `new Date()`. Filenames are **never** parsed. exifr returns local-time `Date`s (EXIF has no zone); stored as ISO **UTC** strings; grouping converts back with local getters, so the effective day is the naive EXIF date as long as the machine's time zone does not change.
(The user's library contains `fix_photo_dates.py`, which rewrote EXIF/mtime from filenames — evidence that filename dates are the reliable source for this data set. Filename shapes seen in the 3,593-photo set: `IMG_YYYYMMDD.jpg` (1,847), `IMG_YYYYMMDD_HHMMSS.jpg` (820), `IMG_YYYYMMDD.JPG` (485), `YYYYMMDD_HHMMSS.jpg` (421), `YYYYMMDD_HHMMSS_LLS*.jpg`, `IMG_YYYYMMDD_ HHMMSS.jpg` (space), `YYYYMMDD_HHMMSS(n).jpg`. Photos are 8–12 MP JPEGs, ~2.2 MB avg, no EXIF orientation flags.)

### 4.9 Daily grouping and best pick (`alignmentStore.groupByDay`)
- Only `status === 'confirmed'` candidates (uncertain left unreviewed are excluded).
- Day key = `YYYY-MM-DD` from local getters of `creationDate`.
- Within a day: sort by `similarityScore` desc; `selectedIndex = 0` ⇒ **best pick = highest similarity** (ties: stable sort order).
- Days sorted ascending. `getSelectedPhotos` = selected photo of each day, sorted by `creationDate` ascending → this is the alignment/export/video order.

### 4.10 Procrustes similarity transform (`alignment.computeProcrustesTransform`, port of Swift)
Inputs `src` (photo anchors), `ref` (target anchors), equal weights.
1. Fallback identity `{a:1,b:0,c:0,d:1,tx:0,ty:0}` if either missing, lengths differ, or `n < 3`.
2. Centroids `s̄`, `r̄`; centered points.
3. `σs = sqrt(Σ|s−s̄|²/n)`, `σr` likewise; identity if either is 0. **`scale = σr/σs`** (RMS ratio, not the least-squares optimal scale).
4. Normalize both by their σ. `H00=Σ rx·sx`, `H01=Σ rx·sy`, `H10=Σ ry·sx`, `H11=Σ ry·sy`.
5. `θ = atan2(H10 − H01, H00 + H11)`.
6. `a = s·cosθ, b = s·sinθ, c = −s·sinθ, d = s·cosθ`, `tx = −s(cosθ·s̄x − sinθ·s̄y) + r̄x`, `ty = −s(sinθ·s̄x + cosθ·s̄y) + r̄y`.
Mapping source → output: `x' = a·x + c·y + tx`, `y' = b·x + d·y + ty` (canvas `setTransform(a,b,c,d,tx,ty)`).

### 4.11 Warp, crop, output size, backdrop (`alignment.alignImage`, `alignmentWorker.js`)
- Source decoded as full-res PNG with EXIF orientation; face re-detected on it (largest face — may differ from the face matched during the scan; failure → `error: 'No face detected'`, dropped silently).
- Target anchors = reference anchors scaled from `referenceImageSize` to `outputSize` per axis (`x·outW/refW`, `y·outH/refH`); both equal the crop size, so this is an identity.
- **Output size = exact pixel size of the reference crop** (e.g. 3200×2368 with no crop). `OUTPUT_SIZES` (512-px presets) and `getOutputSize` in `SetupView` are dead code.
- Canvas `outW×outH`: (1) backdrop = the *untransformed* source scaled to **cover** (`max(outW/w, outH/h)`), centered; (2) fill `rgba(0,0,0,0.55)` over everything (→ backdrop × 0.45); **no blur**; (3) draw the source with the Procrustes transform (Skia default smoothing ≈ bilinear, anti-aliased edges) on top; area the warped photo does not reach shows the dimmed backdrop.
- Encoded **PNG**, written to `os.tmpdir()/facetimelapse/aligned_{Date.now()}_{index}.png`. Result = candidate spread + `{outputPath, error}`.

### 4.12 Export to folder (`exportService`)
- `mkdir -p`; for each result with `outputPath` (in order): name = `generateFilename(creationDate)` → `YYYYMMDD.png` from **local** date parts of the ISO string (invalid/null → today); collisions within the batch → `YYYYMMDD_1.png`, `_2`, … (suffix starts at 1). Files already on disk are **not** checked → overwritten. `copyFileSync`; copy errors logged and skipped. Progress `{current: i+1, total, filename}` per item. Returns written paths.

### 4.13 Video (`videoExport.createVideo`)
- `frameDuration = totalDuration / N`; ffmpeg concat list in `os.tmpdir()/facetimelapse_concat_{ts}.txt`: `file '{path with / separators}'` + `duration {frameDuration.toFixed(6)}`; the **last image gets 2 × frameDuration**. Paths are not quote-escaped.
- `ffmpeg -f concat -safe 0 -i list -c:v libx264 -r {fps} -pix_fmt yuv420p -preset fast -crf 23 -vf scale=trunc(iw/2)*2:trunc(ih/2)*2 -movflags +faststart out.mp4` (even dims by flooring).
- Progress: parse `timemark` `HH:MM:SS.xx` → `percent = secs/totalDuration·100`, clamped 0–100. No cancel. Errors → `FFmpeg error: …`.

### 4.14 Scan cache (`scanCache.js`)
- Dir `{userData}/scans/` (userData = `~/Library/Application Support/<app name>` on macOS). File `{key}.json`, `key = sha256(folderPath ‖ JSON.stringify(referenceEmbedding)).hex[0..16]` ⇒ **any reference/crop change invalidates the whole cache**.
- Payload: `{version: 1, folderPath, referenceEmbeddingHash: key, createdAt, updatedAt, entries: {absPath: {mtimeMs, result}}}`.
- Hit iff `stat.mtimeMs === entry.mtimeMs` (exact float equality); hits emit one progress event each (`cached: true`, no thumbnail).
- Only `result` messages (confirmed/uncertain) are recorded ⇒ rejected / no-face / failed photos are **re-analyzed on every scan**.
- Flushed every 25 new entries and when the scan ends (done/cancel/error); atomic via `{file}.tmp` + rename. Version mismatch or corrupt JSON → empty cache (warning logged).
- Startup prune: delete `*.json` with file mtime older than **30 days**. `face:clearScanCache` deletes the file for the current key.

### 4.15 Worker pools
- Scan and align each spawn `min(max(1, cpus − 1), tasks)` `worker_threads`; every worker loads the face-api models itself; 30 s "ready" watchdog (`WORKER_READY_TIMEOUT_MS`) fails the batch with "…did not initialize within 30s. Check that models are present (run "npm run download-models")."
- Pull model: one task per worker at a time. Cancel tokens are checked only when a worker reports back.
- Scan: a worker crash counts as one completed task and the worker is never replaced (possible hang, bug B21). Align: any worker crash fails the whole batch.
- Progress IPC throttled to ≥ 50 ms between messages (last one always sent).

### 4.16 Temp files
`os.tmpdir()/facetimelapse/*` (aligned PNGs) and `os.tmpdir()/facetimelapse-straightened-*` are deleted at startup and on `will-quit` ⇒ aligned results never survive a restart.

---

## 5. IPC surface (preload `window.electronAPI`)

| API | Channel | Payload | Returns |
|---|---|---|---|
| `setReference(p)` | `face:setReference` | `{imagePath, cropParams: {x,y,width,height}\|null, aspectRatio, rotationAngle?}` | `{embedding[45], landmarks68[], alignmentPoints[5], imageSize{w,h}, outputSize{w,h}, previewBase64}` |
| `startScan(p)` | `face:startScan` | `{folderPath, referenceEmbedding}` | `PhotoCandidate[]` (score desc) |
| `cancelScan()` | `face:cancelScan` | — | — |
| `clearScanCache(p)` | `face:clearScanCache` | `{folderPath, referenceEmbedding}` | `boolean` |
| `onScanProgress(cb)` | event `scan:progress` | `{index, total, filename, thumbnailBase64\|null, status:'scanning', cached, cachedHits, confirmed, uncertain}` | unsubscribe fn |
| `alignBatch(p)` | `face:alignBatch` | `{candidates, referenceAlignmentPoints, referenceImageSize, outputSize}` | results (partial on cancel) |
| `cancelAlign()` | `face:cancelAlign` | — | — |
| `onAlignProgress(cb)` | event `align:progress` | `{current, total, outputPath, filename}` | unsubscribe fn |
| `exportVideo(p)` | `video:export` | `{imagePaths[], outputPath, fps, totalDuration}` | `{success:true}` |
| `onVideoProgress(cb)` | event `video:progress` | `{percent, timemark}` | unsubscribe fn |
| `exportToFolder(p)` | `export:toFolder` | `{alignedResults, outputFolder}` | `string[]` |
| `onExportProgress(cb)` | event `export:progress` | `{current, total, filename}` | unsubscribe fn |
| `getImageBase64(path, {maxDim})` | `image:getBase64` | `{filePath, maxDim?}` | base64 (raw file, or JPEG q82 scaled to `maxDim` long edge) |
| `detectFaceBounds(path)` | `face:detectBounds` | `{imagePath}` | `{faceBox{x,y,w,h}, leftEye, rightEye, imageSize}` \| `null` |
| `straightenImage(p)` | `image:straighten` | `{imagePath, angleDegrees}` | `{filePath}` (temp JPEG) |
| `chooseFolder()` | `dialog:chooseFolder` | — | path \| `null` |
| `chooseFile(filters?)` | `dialog:chooseFile` | `{filters}` | path \| `null` |
| `savePath(p)` | `dialog:savePath` | `{defaultName, filters}` | path \| `null` |

Plus the privileged `safe-file://` scheme: `safe-file:///abs/path` → reads **any** file (host+pathname reassembled), MIME by extension.

`PhotoCandidate = {filePath, filename, embedding: number[45] | null, similarityScore, status: 'confirmed'|'uncertain'|'rejected', creationDate: ISO string}`; aligned result = candidate + `{outputPath: string|null, error: string|null}`.

---

## 6. Zustand store (`alignmentStore.js`)

```js
{
  step: 'setup',                    // setup|scanning|confirm|dailySelection|aligning|results
  referenceImagePath: null, referencePreviewBase64: null, referenceLandmarks68: null,
  referenceAlignmentPoints: null, referenceImageSize: null, referenceEmbedding: null,
  referenceOutputSize: null, cropParams: null, aspectRatio: 'original',
  sourceFolderPath: null,
  scanProgress: null, candidates: [],
  dailyGroups: [],                  // [{date:'YYYY-MM-DD', photos: PhotoCandidate[], selectedIndex}]
  alignProgress: null, alignedResults: [],
  videoProgress: null,
  error: null,
  // actions: setStep, setAspectRatio, setCropParams, setReferenceResult, setReferenceImagePath,
  // setSourceFolderPath, setScanProgress, setCandidates, setCandidateStatus(index,status),
  // setDailyGroups, setDailyGroupSelection(g,p), movePhotoToDate(g,p,dateKey),
  // setAlignProgress, setAlignedResults, setVideoProgress, setError, clearError, reset()
}
```
Pure helpers: `groupByDay(candidates)`, `getSelectedPhotos(dailyGroups)`. Nothing is persisted.

---

## 7. Visual identity (for reference only — the rewrite replaces it)
Dark warm-stone theme: `--bg-main #1C1917`, panels `rgba(41,37,36,.7)` with 12 px backdrop blur, amber accent `#F59E0B` (hover `#D97706`), text `#D6D3D1` / bright `#FAFAF9` / muted `#A8A29E`, danger `#FF4136`, warning `#FF851B`, success `#2ECC40`; radii 6/10/16; Inter 400–700 from Google Fonts. Screens: `assets/screenshots/{setup,scanning,daily-selection,results,video-export}.png` (captured at 1440×900 by `scripts/capture-screenshots.js`, which stride-samples 250 photos into a temp dir and overrides the dialog IPC handlers).

---

## 8. Tests that exist
Vitest (`npm test`): Procrustes identity/translation/scale/degenerate cases and `scalePoints`; embedding length 45, finite, scale invariant; `compareFaces` identity = 1, mismatch/null = 0, monotonic; `categorize` thresholds; `generateFilename` pattern/collisions/invalid dates; scan cache key/roundtrip/corrupt/version/prune/validate; backend priority list; `movePhotoToDate` (8 cases incl. selection index rules); renderer smoke tests (App stepper + banner, ConfirmView render/advance, DailySelectionView calendar buttons, ResultsView count/labels/Create Video disabled). Integration tests gated by `FACETIMELAPSE_INTEGRATION_PHOTOS` (detection returns 68 landmarks + 5 anchors, determinism, same-person pair not rejected). CI: unit tests on ubuntu/macos/windows × Node 18/20.

---

## 9. Known bugs, limitations, awkward spots

| ID | Area | Issue |
|---|---|---|
| B1 | matching | Stale threshold comment (0.75/0.55) vs code (0.60/0.40); "Gaussian" is a Laplacian kernel. The 45-feature geometry mixes raw radians (#36–38) with ratios and signed pose-dependent offsets (#44–45): it is pose-sensitive and weakly identity-discriminative. |
| B2 | cache | Rejected / no-face / failed photos are never cached → fully re-analyzed every scan. |
| B3 | cache | Cache key includes the reference embedding → any crop tweak or new reference invalidates all work. |
| B4 | align | Re-detects the *largest* face at full resolution: may align a different person than the one matched; detection may fail at that resolution → photo silently dropped. |
| B5 | align | Failed alignments are filtered out without telling the user. |
| B6 | align | Cancel: an uncleared 1.5 s timer moves the user from Results back to Daily Select; cancel only takes effect on the next worker message. |
| B7 | scan | Cancel only checked between tasks; cancelled results are discarded (cache keeps flushed entries). |
| B8 | export | Overwrites existing files in the destination; copy errors only logged; no success feedback; no cancel. |
| B9 | video | No cancel; modal locked during encode; FPS/duration can leave slider ranges; concat paths unescaped; ffmpeg binary must be unpacked from asar. |
| B10 | memory | Daily Select and Confirm load **full-resolution originals as base64** (LRU of 300 ⇒ hundreds of MB); Aligning mosaic loads full PNGs. |
| B11 | storage | Aligned outputs are full-crop-size PNGs (~10 MB each at 3200×2368 ⇒ tens of GB for 3,600) in the OS temp dir, deleted on startup/quit; nothing about a session persists. |
| B12 | security | `safe-file://` serves any absolute path; `image:getBase64` reads any path; `sandbox: false`. |
| B13 | waste | `previewBase64` generated but unused; `referenceLandmarks68` unused; `OUTPUT_SIZES` dead. |
| B14 | reference | Straighten writes a re-encoded temp JPEG (q92) instead of passing `rotationAngle`; the rotation expands the canvas with black corners that end up inside crops. |
| B15 | setup | Initial aspect `'original'` highlights no button; `reset()` once set `'free'` (fixed). |
| B16 | setup | Crop preview capped at 380 px width only; tiny on large screens; huge for portraits. |
| B17 | setup | Every crop change runs a full sharp pipeline + detection on the full-resolution crop; "No face" errors pop the global banner while editing. |
| B18 | setup | Keyboard nudge only when focus is on `<body>`; Escape doesn't restore the pre-drag box. |
| B19 | navigation | Re-entering Confirm (or rescanning) silently rebuilds `dailyGroups`, losing moves, selections and added photos. |
| B20 | scan UI | Progress never reaches 100%; no "no matches" empty state; mosaic shows rejected faces too. |
| B21 | scan | Worker crash: task lost, worker not replaced; if workers die the scan can hang. |
| B22 | dates | No filename parsing; fallback is fs `birthtime` (reset by copies) then "now". |
| B23 | dates | Day keys depend on the machine time zone at view time (ISO UTC storage). |
| B24 | days | Moves/added photos are not persisted; added photos are not face-checked until alignment. |
| B25 | days | Calendar renders all months (not virtualized); a day's only photo cannot be moved; HTML5 DnD only (no keyboard alternative). |
| B26 | results | Grid not virtualized (3,600 buttons); every thumb is decoded + re-encoded per request; no disk cache. |
| B27 | errors | Raw technical messages in a global banner (e.g. worker watchdog text). |
| B28 | HEIC | Advertised but undecodable. |
| B29 | perf | Detection at 400 px during scan (small faces missed), full-resolution detection for reference and alignment (slow). |
| B30 | misc | Auto-update needs signed builds that are not configured; Google Fonts fetched at runtime (offline app). |
| B31 | reference | AR-locked resize can lose the exact aspect at image borders (independent clamps). |

---

## 10. Constants cheat-sheet

| Constant | Value |
|---|---|
| Supported extensions | `.jpg .jpeg .png .heic .tiff .tif .webp` (case-insensitive) |
| Dialog image filter | `jpg jpeg png heic tiff webp` |
| Scan thumbnail | 100×100 cover, JPEG q60 |
| Scan detection buffer | 400 px fit-inside, JPEG q85 |
| detectBounds buffer | 1024 px fit-inside, JPEG q85 |
| SSD minConfidence | 0.3; pick largest box |
| Similarity | `exp(−d/1.5)`; confirmed ≥ 0.60; uncertain ≥ 0.40 |
| Straighten threshold | 0.3°; temp JPEG q92, black fill |
| Reference preview | 512 fit-inside, JPEG q80 (unused) |
| Crop preview | width ≤ 380 px; min box 30 px; handle 10 px / hit 18 px; nudge 1 px / Shift 10 px |
| Auto set-reference debounce | 500 ms |
| Aspect presets | free, 1:1, 4:3, 16:9, 9:16, 3:4 (default state `original`) |
| Backdrop | cover-scaled source, black overlay α 0.55, no blur |
| Output | crop's exact pixel size, PNG |
| Export name | `YYYYMMDD.png`, `_1`, `_2`… within batch |
| Video | default 10 fps, duration N/10 s; sliders 1–60 fps, 1–120 s; libx264 crf 23 preset fast yuv420p +faststart, even dims by floor; last frame ×2 |
| Default video name | `facetimelapse_{epochMs}.mp4` |
| Progress throttle | 50 ms |
| Workers | `max(1, cpus−1)`, 30 s ready watchdog |
| Scan cache | v1 JSON, flush every 25, prune > 30 days |
| UI caps | scan/align mosaics 65; Confirm LRU 30; Daily LRU 300 (concurrency 4); Results LRU 250 (concurrency 6, maxDim 400, rootMargin 200 px); viewer maxDim 2400 |
| Window | 1200×800, min 900×600 |

---

## 11. Legacy behavior the rewrite deliberately does NOT keep
(Details and rationale in `ARCHITECTURE.md` §1 and §10.)
1. The 45-feature geometric embedding and `exp(−d/1.5)` score → replaced by SFace 128-d embeddings + cosine, **calibrated to the same 0–1 display scale with the same 0.60 / 0.40 cut-offs**.
2. Largest-face selection → best-matching face (scan) and the *same* face at alignment.
3. Output = crop pixel size → output resolution presets (default 1080p); legacy behavior remains available as `source`.
4. Reference-dependent cache, uncached rejects, temp-dir outputs → reference-independent analysis cache + persistent frame cache + persisted session.
5. Date order gains filename parsing; "now" fallback removed; days are naive local dates (no time-zone round trip).
6. Export never overwrites unless asked; video gains cancel, crossfade, captions, holds, resolution and quality.
7. Moving a day's selected photo out falls back to the day's automatic best pick (legacy fell back to "whatever now occupies that index").
8. HEIC is reported as unsupported instead of silently skipped.
