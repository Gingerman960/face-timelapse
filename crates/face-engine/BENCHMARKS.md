# face-engine benchmarks

Machine: Apple M3 Max (16 cores: 12 performance + 4 efficiency), 64 GB, macOS 26.4,
Rust 1.99, release profile (`lto = "thin"`, `codegen-units = 1`). Data: the
reference library (3,591 JPEGs, 8–12 MP, 2.2 MB average, 7.9 GB). Other agents
were compiling on the same machine during parts of the session; numbers below
were taken on an idle machine unless marked.

## 1. ONNX runtime choice: `tract` (pure Rust)

Spike (`rt_bench`), random input, one session per thread, single-threaded intra-op:

| Model / input | tract 0.23.9 | ort 2.0.0-rc.15 CPU (ORT 1.31) | ort + CoreML EP |
|---|---|---|---|
| YuNet 640×640, 1 thread | 16.2 ms | **1.75 ms** | 1.20 ms |
| YuNet 640×640, 16 threads | 508 inf/s | **1,907 inf/s** | 1,655 inf/s (4 threads) |
| YuNet 640×480 (dynamic shape) | 11.8 ms / 707 inf/s | ✗ model input fixed at 640×640 | ✗ |
| YuNet 320×256 | 3.5 ms / 3,106 inf/s | ✗ | ✗ |
| SFace 112×112, 1 thread | **18.3 ms** | 26.8 ms (15.7 ms with 4 intra threads) | 9.6 ms |
| SFace, 16 threads | **581 inf/s** | 305 inf/s (316 with flush-to-zero) | 332 inf/s (4 threads; ANE/GPU-bound) |
| Build | `cargo build`, nothing else | downloads a prebuilt ORT at build time | + needs `-lclang_rt.osx` link hack and `MACOSX_DEPLOYMENT_TARGET ≥ 13.4` |
| Shipping | static, pure Rust | bundle/sign/notarize the ORT dylib per platform | same |

Decision: **tract**. SFace (the per-face cost every photo pays) is ~1.9× faster
in parallel on tract; YuNet is slower on tract but accepts any input shape (ORT
would force 640×640 letterboxing) and is not the bottleneck; tract needs no
native runtime, no build-time download, no linker workarounds, and builds
unchanged on macOS/Windows/Linux. Weights are shared (`Arc` plan, pooled states).

## 2. JPEG decode

100 real photos (220.8 MB), per image:

| Decoder | 1 thread | 16 threads |
|---|---|---|
| `jpeg-decoder` 0.3, DCT 1/8 (≥ 300 px) | 23.0 ms | 433 img/s |
| `jpeg-decoder` 0.3, DCT 1/4 (≥ 600 px) | 24.2 ms | 419 img/s |
| `jpeg-decoder` 0.3, full | 55.8 ms | 167 img/s |
| `zune-jpeg` 0.5, full | 30.4 ms | 387 img/s |
| `mozjpeg` (libjpeg-turbo, C), 1/8 | 15.5 ms | 787 img/s |
| `mozjpeg`, full | 23.7 ms | 492 img/s |

Entropy decoding dominates (scaled decodes barely beat full ones). libjpeg-turbo
would make the scan ~20 % faster end to end, at the price of a C build
(nasm for x86 SIMD) and error handling by unwinding through C; not worth it with
the scan already at 1.7× its budget. Chosen: `jpeg-decoder` for DCT-scaled
decodes, `zune-jpeg` for full decodes (and as the lenient fallback).

## 3. Per-stage (criterion, `cargo bench -p face-engine`, single photo 3200×2368)

| Stage | Time | Note |
|---|---|---|
| `decode/jpeg_dct_scaled_640` (→ 800×592) | 20.8 ms | budget 12 ms not met (entropy decode bound, see §2) |
| `decode/jpeg_full` | 25.1 ms | zune-jpeg |
| `models/yunet_640` (640×474) | 12.5 ms | budget 8 ms not met |
| `models/sface_embed` | 18.4 ms | budget 6 ms not met |
| `models/sface_align_crop` | 0.31 ms | |
| `pipeline/analyze_photo` (read, EXIF, decode, detect, embed, 320 thumb) | **56 ms** | |
| `pipeline/render_frame_1080p` (no refinement) | 51 ms | |
| `pipeline/render_frame_1080p_refined` (TTA refinement) | **92 ms** | |
| `warp/bilinear_1080p_from_12mp` | 2.4 ms | rows in parallel |
| `warp/dimmed_backdrop_1080p` | 13.1 ms | cover resample of the full image |
| `compose_1080p/{covered,partial}/dimmed` (backdrop + warp + composite, `benches/backdrop.rs`) | 15.3 / 15.0 ms | load ≈ 6 |
| `compose_1080p/{covered,partial}/extended` | **5.0 / 5.1 ms** | reduced-canvas clamp warp + 2 blurs + one fused composite pass |
| `compose_1080p/{covered,partial}/blurred` · `black` | 17.1 / 17.1 · 1.5 / 1.2 ms | |
| `warp/look_lut_build` (33³) | 0.37 ms | budget ~3 ms |
| `warp/look_lut_apply_1080p` | 1.7 ms | rows in parallel; budget ~8 ms/MP |
| `rematch_3600` | 0.19 ms | in-memory re-match of a 3,600-photo library |
| `reference/crop_update_detect_embed_rematch` | **129 ms** | budget < 150 ms p95 |
| `reference/load_reference_full` | 79 ms | decode + whole-image face |

The per-stage budgets of ARCHITECTURE §11 (decode 12, detect 8, embed 6 ms) are
not reachable with pure-Rust decoders and tract on this CPU; the end-to-end
gates they were meant to guarantee are met with margin (§4).

## 4. End to end (release, 15 worker threads)

| Metric | Result | Budget |
|---|---|---|
| Full scan, 3,591 photos, warm OS cache, no app cache | **168 photos/s** (21.4 s); 165–185 across runs | ≥ 100 |
| Same, machine shared with other agents' builds (load ≈ 25) | 82–115 photos/s | — |
| First scan of the session (OS cache state unknown, machine busy) | 154 photos/s | — |
| Rescan with valid analysis cache | **74,000–108,000 photos/s** (≈ 35 ms) | ≥ 5,000 |
| 300-photo subset, cold app cache | 1.8 s (≈ 170 photos/s) | — |
| Align, 1460×1080 masters, TTA refinement, 399 frames | **93 frames/s** (idle) / 63 (busy) | ≥ 60 |
| Align all 3,577 days at 1460×1080 (+ masters + previews written) | 65–80 frames/s (busy machine) | — |
| Peak RSS, full scan + align of all 3,577 days | **0.98 GB** | < 1.5 GB (backend share) |

Cold vs warm: the scan is CPU-bound (≈ 56 ms CPU per photo vs ≈ 2.2 MB read);
the whole library is 7.9 GB, i.e. ≈ 1.5–3 s of SSD time on this machine, spread
over 21 s of compute, so a cold page cache costs at most ~10 %. A true cold
measurement needs `sudo purge`, which was not available to the agent; the first
scan of the session (154 photos/s, under load) is the closest data point.

Peak memory was 1.72 GB before two fixes: landmark refinement now samples a
512 px patch instead of cropping the full-resolution face region (twice, for the
mirror), and the full-resolution decode is dropped as soon as the antialiased
warp source exists.

### Fix pass 3: the fsync regression and the allocator (Oct 25)

QA measured align at 35–51 frames/s and scan at 118 photos/s after fix pass 2.
An interleaved A/B of this example under the same load (two rounds, load
15–60 from other agents; 3,591-photo cold scan, 1,200 frames at 1460×1080)
against the morning baseline and the fix-pass-2 snapshot:

| Build | Scan | Align, dimmed | Align, extended (default) |
|---|---|---|---|
| Baseline (before fix pass 1) | 166–169 photos/s | 87–92 frames/s | — (no extended backdrop yet) |
| Fix pass 2 | 149–152 | 59 | 59–60 |
| Fix pass 3 before the fix | 150–152 | 51–58 | 58–59 |
| Fix pass 3, image caches not fsynced | **174–176** | **85–88** | — |

The regression came from fix pass 2's crash-safe `cache::write_atomic`: every
scan thumbnail, master and preview was fsynced (`F_FULLFSYNC` on macOS, a full
drive-cache flush) plus its directory. Rebuildable image caches now use
`cache::write_atomic_cache` (exclusive temporary + rename, no fsync; a file a
power loss cut short fails `is_whole_jpeg` and is rebuilt); the analysis cache,
manifests and the session stay fsynced. The extended backdrop costs about a
third of the dimmed frame rate on its own; in the shell (all 3,577 frames at
1080×1440, extended) align now runs at 77–81 frames/s (56.7 before the fix).

Memory of the shell's jobs in one process (`ri_resident_size` /
`ri_phys_footprint` peaks; scan → align 1080×1440 extended → video):

| Allocator | Scan | Align | Video |
|---|---|---|---|
| macOS default | 0.72–0.92 / 0.71–0.76 GB | 1.20–1.75 / 1.17–1.41 GB | 0.93–1.41 / 0.81–0.88 GB |
| `MallocLargeCache=0` (the app's setting) | 0.39–0.53 / 0.19–0.23 GB | 0.70–1.04 / 0.53–0.70 GB | 0.41–0.59 / 0.23 GB |

libmalloc's large-block cache kept up to 64 freed buffers dirty (`vmmap`:
846 MB "MALLOC_LARGE (empty)" against 82 MB live after one burst of 15 parallel
detections); `malloc_zone_pressure_relief` released none of it. The app
relaunches itself once with the cache off (`lean_malloc` in the app's `main.rs`; first window
0.40–0.45 s with or without the relaunch); align was 5 % slower without the
cache in the one comparable round.

## 5. Landmark refinement (alignment stability)

80 photos, 1440×1080 frames, eyes re-measured on each aligned frame with the
TTA protocol; jitter = RMS spread of eye positions across frames, as a fraction
of the reference inter-pupillary distance (IPD ≈ 214 px). Cost per frame per
core measured with other builds running (relative values are what matter):

| Source anchors | Eye jitter | Cost |
|---|---|---|
| Scan (YuNet on the whole photo at 640) | 4.8 % (10.2 px) | 0 |
| Re-detect once (384) | 3.6 % | ~45 ms |
| + mirror (384) | 2.7 % | ~65 ms |
| **384 + 512, each + mirror (default)** | **2.3 % (4.8 px)** | ~114 ms busy / ~40 ms idle |
| 320 + 416 + 512, + mirror | 2.3 % | ~144 ms |
| 512 + 640 + 800, + mirror | 1.7 % | ~272 ms |

A single re-detection at 640 px on a crop (the ARCHITECTURE wording) measured no
better than the scan anchors — YuNet's landmark noise, not resolution, limits
precision — so the default averages 4 runs (2 sizes × mirror). `test
real_alignment` gates it: 60 frames, jitter 2.0 % IPD (4.1 px) refined vs 4.1 %
from scan anchors, bias 1.3 %.

## 6. Visual checks

`cargo run --release -p face-engine --example scan -- <photos> <reference> --out DIR --align all`
writes a contact sheet of 48 evenly spaced frames, the pixel mean of 600 frames
(sharp eyes/nose/mouth ⇒ stable alignment) and six full-size masters.

## 5. Extended backdrop (2026-10-24)

`extended` (default since contract v1.2) vs the legacy `dimmed`, same 48
evenly spaced days, 1460×1080, TTA refinement, release, `--threads 1`
(decode + refine + warp + backdrop + stats + master/preview encode), load ≈ 5:

| Mode | Per frame (2 runs) |
|---|---|
| `dimmed` | 126 / 125 ms |
| `extended` | 125 / 121 ms |

The extended backdrop costs nothing extra end to end (its compose step is
~10 ms cheaper than the full-image cover resample of `dimmed`); the budget was
≤ +25 %. Reproduce: `cargo bench -p face-engine --bench backdrop`, and
`cargo run --release -p face-engine --example scan -- <photos> <ref> --align 48
--threads 1 --backdrop extended|dimmed` (fresh `--cache` frames each time).

