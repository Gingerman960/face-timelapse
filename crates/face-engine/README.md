# face-engine

Pure-Rust engine of FaceTimelapse 2: folder walk, EXIF/dates, fast decode,
YuNet face detection, SFace identity matching, a reference-independent analysis
cache, daily grouping, face alignment (legacy Procrustes + antialiased warp +
backdrop + feather), exposure/white-balance normalization, thumbnails, frame
store and export. No Tauri types; every long job reports progress and honours a
cancel token. Binding behaviour: `docs/rewrite/ARCHITECTURE.md` §9 (deviations
are listed at the end of this file). Measurements: [`BENCHMARKS.md`](BENCHMARKS.md).

## Models

Not committed. `scripts/fetch-models.sh [dir]` downloads them (pinned opencv_zoo
commits, SHA-256 verified, idempotent) into `<repo>/models/`:

| File | Model | Licence |
|---|---|---|
| `face_detection_yunet_2023mar.onnx` | YuNet face detector (5 landmarks) | MIT |
| `face_recognition_sface_2021dec.onnx` | SFace 128-d face recognizer | Apache-2.0 |

The app passes the folder at init (`EngineConfig::models_dir`; bundle both files
as resources). Tests/benches/examples read `FT_MODELS_DIR`, else `<repo>/models`.
Loading reads each file once, checks it against its pinned SHA-256
(`model::{YUNET_SHA256, SFACE_SHA256}`, the script's values;
`ModelPaths::read_verified`) and builds the models from those same bytes
(`Analyzer::from_verified`), so a swapped or corrupt model is reported instead
of run — there is no second read to swap the file under. `analysis_fingerprint`
(the fingerprint before loading) is only given for the pinned files: it checks
their blake3 prefix against `model::MODELS_FINGERPRINT`, which is cheaper than
SHA-256. So a fingerprint means the models would load, and an app can treat altered
files like missing ones. Update `MODELS_FINGERPRINT` with the pins; a test
checks it against `<repo>/models`.

## Public API (summary)

The engine owns the domain logic and every loop; an app composes the module
functions (the Tauri shell does, with its own job model) or uses the `Engine`
facade (the example, tests, benches). Each facade method delegates to the
module function, so there is exactly one implementation of each loop. Heavy
work runs on the **caller's rayon pool** (the global pool unless the caller
`install`s another) — an app sizes that one pool; `EngineConfig::threads =
Some(n)` gives the facade a dedicated pool instead.

```rust
// Facade (all methods &self, Send + Sync)
Engine::new(EngineConfig { models_dir, cache_dir, threads: Option<usize>, detector, calibration }) -> Result<Engine>
engine.fingerprint() / walk / analyze_photo / load_reference / detect_reference / render_frame / thumbnail / frame_store
engine.scan(folder, &Embedding, ScanOptions, &dyn ProgressSink<ScanEvent>, &CancelToken)   // = scan::scan_folder
engine.align(&AlignJob { spec: AlignSpec, items }, sink, cancel)                            // = frames::align_frames + manifest save
engine.export_images(&[ExportItem], dir, &ImageExportSettings, sink, cancel)                // = export::export_images

// Loops (run on the current rayon pool, report every item, honour a CancelToken)
scan::{scan_folder(&ScanContext { analyzer: &dyn PhotoAnalyzer, cache_dir, reference, calibration, options }, folder, sink, cancel)
       -> ScanReport { root, files, photos, unsupported, counts, complete, duration_ms },
       ScanEvent::{Started { counts, unsupported }, Progress { counts, photo: ScanItem, photos_per_second, eta_ms }},
       match_photo, rematch, ScannedPhoto::{matched_face, face_box}}
frames::{align_frames(&dyn FrameRenderer, &FrameStore, &AlignSpec, &[AlignItem], &Manifest, sink, cancel) -> AlignReport,
         render_item(renderer, store, spec, item) -> ManifestEntry}           // one re-render (frame nudge)
export::{export_images(items, dir, settings, sink, cancel) -> ExportReport}   // stops at the first failing file

// Seams for callers' test doubles (implemented by the real models)
analysis::PhotoAnalyzer { fingerprint, analyze }   for Analyzer
frames::FrameRenderer { render }                   for Detector

// Building blocks
walk::{walk, photo_id, photo_version, folder_key, file_stamp, entry_for, natural_cmp, classify}
dates::{resolve, parse_filename, parse_filename_timed, time_known(source, taken_at, file_name), parse_exif_datetime, day_key}
analysis::{Analyzer::{load, analyze, fingerprint, detector, recognizer}, analysis_fingerprint(models_dir, &DetectorConfig),
           encode_thumbnail, PhotoAnalysis { oriented_size, taken_at, date_source, outcome: Outcome::{Faces{faces}, NoFace, Failed{kind, message}} }}
cache::{AnalysisCache::{load, empty, lookup, insert, entries, into_entries, retain_paths, fingerprint, save, delete}, dir, entry_count,
       prune(cache_dir, max_age, keep_folders, Option<fingerprint>) + OTHER_ENGINE_GRACE, RECENT_WRITE, write_atomic, write_atomic_cache, is_whole_jpeg, file_is_whole_jpeg,
       create_exclusive, is_temp_name}
matching::{calibrate(cos), Calibration::score, categorize(score), match_faces, COS_CONFIRMED, COS_UNCERTAIN}
reference::{ReferenceImage::{load, detect_crop, render_frame, image, size, face, auto_rotation_deg, eye_tilt_deg, info}, ReferenceInfo,
            rotated_image, crop_frame, AspectPreset, default_crop, aspect_crop, center_on_face, rotate_crop, snap_crop(crop, image, aspect), check_crop -> CropProblem,
            validate_crop, rotation_ok, eye_level_angle, ensemble_detection, level_rotation, REFERENCE_VERSION}
align::{render_frame(&Detector, &FrameRequest) -> RenderedFrame { image, residual_px, face_stats, transform, .. }, render_frame_unrefined(&FrameRequest) (analysis landmarks as they are, no models: previews),
        Resolution::output_size, FrameAdjust, RenderSettings, RenderTarget::from_crop_anchors, key_hash}
color::{face_stats, face_region, Lut3d::for_frame, apply_look, look_delta, FrameLook::{lut, apply, delta},
        LookSettings::cache_key, NormalizeMode}
days::{group_days, timeline, diff, DayDecisions::{with_move, with_selection, without_selection, with_excluded}}
export::{file_name, NamePlanner, write_image, ImageExportSettings}
frames::{FrameStore::{new, master_path, preview_path, look_preview_path, write, has_master, load_manifest, load_usable_manifest, save_manifest, others_exist, prune_looks},
         Manifest, ManifestEntry, render_fingerprint (RENDER_VERSION), frame_key, prune_fingerprints, root,
         load_master, whole_master, preview_bytes, view_bytes, FrameSequence::into_loaders -> FrameLoader → RgbFrame}
thumbs::{thumbnail, render, render_bytes, render_uncached, bucket, path, dir, prune}
decode::{decode, decode_file, read_file, probe_size, check_dimensions, read_exif, MAX_SIDE, MAX_PIXELS, MAX_FILE_BYTES},
encode::{jpeg, jpeg_with, png}, warp::{rotate_expand, backdrop, warp_bilinear}
```

Ids hash the **canonical path as given** (`walk` roots are canonicalized;
callers canonicalize user-picked files once): no per-file `realpath`, and two
symlinks to one file get two ids (library ids never collide).

`FrameSequence::into_loaders()` yields `Box<dyn FnOnce() -> Result<RgbFrame> + Send>`
where `RgbFrame { width, height, rgb, date }` has the shape of
`timelapse_video::Frame`; the shell maps each loader 1:1 (errors →
`VideoError::Source`). A frame's look LUT is built inside its loader (on the
encoder's worker), never up front. The crates never depend on each other.

Errors are one `EngineError` (`thiserror`) with `kind() -> ErrorKind` mirroring
the IPC `ErrorKind`; it serializes as `{ kind, message }`.

## Pipeline and algorithms

- **Walk** — recursive, skips dot names, no directory symlinks, file symlinks
  accepted; `.jpg .jpeg .png .tif .tiff .webp` analyzed, `.heic .heif` counted;
  natural sort. Ids: `blake3(canonical path)[..16]`, version `blake3(size‖mtimeNs)[..8]`.
- **Dates** — EXIF `DateTimeOriginal` → `DateTimeDigitized` → file name
  (`YYYYMMDD[_ -]{1,2}HHMMSS`, `YYYY-MM-DD HH.MM.SS`, year 1990–2100, glued digits
  rejected; every shape of the real set is unit-tested) → EXIF `DateTime` →
  birthtime/mtime. Naive local times, never "now". EXIF parsing keeps partial
  results (Samsung files carry a stray "next IFD" pointer that makes strict
  parsers drop the whole block — including orientation).
- **Decode** — EXIF orientation applied to pixels. JPEG below full size:
  `jpeg-decoder` DCT scaling (1/2, 1/4, 1/8); full size: `zune-jpeg`; files with
  a truncated tail fall back to lenient `zune-jpeg` (2 such photos in the real set
  that libjpeg/PIL reject). PNG/WebP/TIFF via `image`.
- **Detection** — YuNet re-implemented from OpenCV `FaceDetectorYN`: BGR float
  input padded to 32, 3 strides, `score = √(cls·obj)`, greedy NMS 0.3, score ≥ 0.6,
  top-k 50; faces < 24 px (at 640) dropped; 3 largest with area ≥ 10 % kept.
  Verified against `cv2.FaceDetectorYN` on the reference photo (boxes and
  landmarks within 1 px). Landmark order = YuNet's = image-left first.
- **Recognition** — SFace re-implemented from `cv2.FaceRecognizerSF`:
  least-squares similarity onto the ArcFace 112×112 template, bilinear crop
  (antialiased pre-shrink when the face is > 2× the template), RGB float input,
  L2-normalized output. Same crop → cosine 0.998 vs OpenCV's own features.
- **Matching** — per photo `cos = max over faces`; the arg-max face is the one
  aligned later (fixes legacy "largest face"; two real photos have the user as
  the *second* face). Calibrated to the legacy 0–1 scale (below).
- **Analysis cache** — `analysis/{folderKey}.bin`, postcard, magic `FTAC`,
  format version + engine fingerprint (`analysis_fingerprint`), entries keyed by
  rel path + size + mtime ns, including no-face/failed photos; flushed every 2 s /
  500 entries and at the end (atomic rename); vanished files dropped on complete
  scans. Reference-independent: crop changes re-match in memory (~1 ms for 3,600).
- **Reference** — full decode, rotation with expanded black canvas (sharp
  semantics), whole-image face at ≤ 1024 px, `autoRotationDeg = r − atan2(dy,dx)`
  (absolute), crop face at ≤ 1280 px letterboxed into square inputs (plans stay
  bounded while dragging), anchors then refined with the TTA protocol below so
  target and frame anchors share one landmark protocol.
- **Alignment** — legacy Procrustes exactly (RMS-ratio scale, `atan2(H10−H01,
  H00+H11)`, identity fallback) from the matched face's anchors onto the reference
  anchors × output size; `FrameAdjust` composed after. DCT decode factor ≥ 1.25·s.
  **Landmark refinement** (default on): the face is re-detected on a 512 px square
  patch around it at 384 and 512 px, plain and mirrored (4 YuNet runs) and the
  landmarks averaged — eye jitter across frames drops from 4.1 % to 2.0 % of the
  inter-pupillary distance (BENCHMARKS.md). Warp: inverse-mapped bilinear on rows
  in parallel; when the warp would shrink by > 1.25× the visible region is first
  resampled with an antialiasing filter. Backdrops: `extended` (default: the
  warped photo continued clamp-to-edge, blurred σ 1.5 % → 4 % of the long edge
  and darkened 1 → × 0.75 with distance outside the photo, smoothstep over 8 %;
  feather 2.5 % — no rectangle at the photo border), `dimmed` (legacy cover ×
  0.45, no blur), `blurred` (σ = 1.5 % long edge, × 0.6), `black`; other modes
  feather `max(2 px, 0.4 %)`. Residual = RMS anchor error after Procrustes.
- **Look** — Oklab mean/std over face region R (§9.6), P2–P98 trimmed, clamped
  gains, strength blend, 33³ LUT, gamut clip in linear RGB; `look_delta` per §9.6.
- **Frames** — masters JPEG q95 4:4:4 + previews 640/320 under
  `frames/{fingerprint}/`, postcard manifest (v2: the current frame of each
  photo with residual + face stats, plus the reference look stats). The render
  fingerprint mixes in `RENDER_VERSION` (bump it whenever pixels or keys
  change for the same inputs); `prune_fingerprints` keeps the current one plus
  the most recently used others.
- **Export** — `YYYYMMDD.png|jpg`, `_1`, `_2`… for batch or on-disk clashes
  unless overwrite; written to an exclusively created `.{name}.{pid}-{n}.tmp`
  (never follows a planted link), fsynced, then placed with a no-replace hard
  link (or exclusive create + copy where links are unsupported) — a file that
  appears meanwhile gets the next `_n` instead of being overwritten; with
  overwrite, renamed over. JPEG q95 without look = byte copy.
- **Untrusted input** — every decode is bounded before it allocates: files
  > 256 MiB, any side > 16,384 px or > 150 MP are refused (`decodeFailed`,
  "image too large"); JPEG decoders get a buffer cap, other formats explicit
  `image` limits; full-resolution buffers share a 400 MP pixel budget across
  threads. The share is taken before a decoder allocates (jpeg-decoder: its
  planes + the RGB output, plus a progressive / lossless file's full-size
  coefficient planes) and stays with the `Decoded` image until it is dropped,
  `into_image()` or `release_budget()`. Never run rayon work while holding
  one (every parallel loop asserts it in debug builds): the scan shrinks
  large decodes before detecting, `align` releases before compositing,
  `reference` before rotating, and the 112×112 face crop warps on the calling
  thread. A thread holding a share never waits for another, and waiting
  requests are served FIFO, so the budget can neither deadlock nor starve a
  large request. Transient failures (`io`, `internal`) are never cached, so an
  offline network folder is re-analyzed once it is back. Loading a cache file
  refreshes its age for `prune`. YuNet plans for new input shapes are built
  outside the plan-cache lock (once per shape); scan inputs are padded to
  128 px multiples so few shapes exist.

## Calibration (SFace cosine → legacy score)

`score = f(cos)` is the §9.3 piecewise-linear map with anchors **C = 0.363**
(→ 0.60, confirmed) and **U = 0.20** (→ 0.40, uncertain), `Z = 2U − C = 0.037`
(→ 0). Calibrated on all 3,591 decodable photos of the reference library
(2012–2022, one person, reference `IMG_20140815_142326.jpg`, free crop):

```
cosine       matched face (n = 3,590)                       other faces in multi-face photos (n = 39)
-0.15..0.20  0                                              33  ##########################
 0.20..0.25  1  (sunglasses)                                 5  ####
 0.25..0.30  1  (safety goggles)                             1  # (another person, 0.284)
 0.30..0.40  1                                               0
 0.40..0.50  7                                               0
 0.50..0.55  12                                              0
 0.55..0.60  63  #                                           0
 0.60..0.65  282 #####                                       0
 0.65..0.70  800 ################                            0
 0.70..0.75  1181 ########################                   0
 0.75..0.80  726 ###############                             0
 0.80..0.85  318 ######                                      0
 0.85..0.90  164 ###                                         0
 0.90..1.00  34                                              0
percentiles of matched faces: p0.1 0.422 · p0.5 0.533 · p1 0.573 · p5 0.624 · median 0.726
```

Result with C = 0.363 / U = 0.20: **3,588 confirmed (99.94 %), 2 uncertain, 0
rejected, 1 no face** (an all-black photo). Both uncertain photos were checked
visually: the user wearing sunglasses (0.209) and safety goggles under a hard hat
(0.264) — exactly what the review step is for. No other person reaches 0.29
(highest: a friend in a group selfie, 0.284), so C keeps a 0.08 margin and OpenCV's
published threshold is retained; U = 0.20 sends occluded selfies (and strangers
that resemble the user) to review instead of rejecting them. Background patches
shaped like the template reach 0.28 at most (test `real_detection`), never
"confirmed". Before the EXIF fix, 184 sideways (orientation 6/8) photos scored
≈ 0 — the calibration above is with correct orientation.

Reproduce: `cargo run --release -p face-engine --example scan -- <photos> <reference> --tsv scan.tsv`.

## Tests

```sh
scripts/fetch-models.sh
cargo test -p face-engine                                   # unit + synthetic + real-photo (skips cleanly)
cargo test -p face-engine --release --test real_scan -- --ignored --nocapture   # throughput gates
cargo llvm-cov -p face-engine --summary-only                # coverage
cargo bench -p face-engine                                  # criterion: analyze, reference
```

Real-photo tests read `FT_PHOTOS_DIR` / `FT_REFERENCE_PHOTO` (defaulting to the
developer's library when present), print `skipped: <reason>` otherwise, never
modify or copy photos (a 300-photo subset is a temp folder of symlinks).

| Test | Checks |
|---|---|
| `real_reference` | anchor order invariant (left eye/mouth image-left, eyes > nose > mouth), every aspect preset, empty crop, Center Face, one `L` press levels the eyes (< 0.2° residual by the framing ensemble) and a second changes nothing, the matching embedding is the same for every crop and rotation (cos > 0.995), rotation bounds |
| `real_detection` | ≥ 98 % detection on a 200-photo stride sample (100 %), same-person p5 > C, other faces < C, background patches < C |
| `real_alignment` | 60 frames at 1440×1080 re-measured: eye jitter ≤ 3.5 % IPD (measured 2.0 %), bias < 3 % (1.3 %), refinement never worse |
| `real_scan` | 300-photo end-to-end: scan, thumbnails, cached rescan, days, align, reuse, export naming + `_1` suffixes, video frame loaders; ignored gates: full-library scan ≥ 100 photos/s and cached ≥ 5,000/s, align ≥ 60 frames/s at 1080p |
| `engine_synthetic` | models only: no-face/failed/HEIC caching, change/vanish invalidation, cancellation, cache clear, thumbnails, reference without face, align/export/look/frames on synthetic photos, missing-source failures |

The loops are also unit-tested without models (`frames::align_frames` with a
flat renderer incl. failures/panics/reuse/cancel; `export::export_images`;
`thumbs::render_uncached`), and the Tauri shell drives `scan_folder` /
`align_frames` / `export_images` end to end through its fake analyzer/renderer.

## Upgrading

- `analysis_fingerprint` errs for model files that are not the pinned ones (`model::MODELS_FINGERPRINT`), as `Analyzer::load` already did. The value for the pinned files is unchanged, so no cache is rebuilt.
- `render_fingerprint` hashes fixed units since fix pass 5 (whole-pixel crop, micro-units for anchors and rotation), so a value read back from a file one ULP off no longer changes it; fingerprints of earlier builds differ once.
- `REFERENCE_VERSION` (now 2) versions the reference analysis. A caller that stores a reference (the app's session) re-analyses it when the version changes. The new anchors change `render_fingerprint`, so aligned frames of an earlier build are stale: align once again.
- `ANALYSIS_VERSION` (now 2: PNG/TIFF/WebP analysed at working size) is part of `analysis_fingerprint`, so every analysis cache is rebuilt by the next scan. `cache::prune(cache_dir, max_age, keep, fingerprint)` deletes a cache of another fingerprint only after `OTHER_ENGINE_GRACE` (30 days) without use, kept folders included, and only when given an authoritative fingerprint (`Some`, models loaded; `None` judges nothing by fingerprint). Two builds sharing one cache folder therefore keep each other's caches while both are in use. Unreadable or other-format files go once they are older than `RECENT_WRITE` (10 minutes); every file is re-inspected right before deletion.

## Deviations from ARCHITECTURE.md / LEGACY-SPEC (and why)

1. **Landmark refinement uses TTA** (2 sizes × mirror on a square patch) instead
   of one 640 px detection: the single re-detection measured *no* better than the
   scan anchors (selfie faces are already ~300 px at 640), TTA halves the jitter.
   The reference crop anchors use the same protocol so frames carry no bias.
2. **Reference crop detection letterboxes into square inputs** (edge rounded up
   to 128, ≤ 1280, then 640/320 fallbacks) so dragging the crop never builds a new
   model plan per pixel size.
3. **Truncated JPEGs decode** (lenient fallback) instead of failing.
4. **Geometry in the cache is `f64`** (`Rect`/`Point`), not `f32` (~60 bytes more
   per face, ~2.2 MB total).
5. **`top_k` applies after NMS** (OpenCV applies it before): dense anchor hits on
   a big face could otherwise hide a second face.
6. Coordinates use the pixel-corner convention throughout (pixel *i* covers
   `[i, i+1)`), so landmarks scale exactly between decode sizes.
