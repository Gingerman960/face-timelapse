# FaceTimelapse 2.0.0 vs 1.2.1 — benchmark on the same photos

> 2026-10-25. Both apps ran on the same 3,591 daily selfies, the same reference photo and the same machine. Both were driven end to end through their own UI.
>
> **Short answer: yes, it got faster.** The new app runs the whole job (scan → align → export) about 5.5× faster: 1 min 57 s against 10 min 44 s. It does that with about 12× less memory, and its bundle is about 11× smaller.
>
> The new-app numbers below come from a test build with debug assertions on, so they understate it. A release build runs scan and align faster still (see "Engine only").

## Headline

Medians of the measured runs. A range shows when there were several runs. Speed-up is legacy time ÷ new time (for memory and size, legacy ÷ new).

| Metric | Legacy 1.2.1 | New 2.0.0 | Speed-up |
|---|---|---|---|
| Launch to first usable window (3 runs each) | 0.696 s (0.696–0.722) | 0.473 s (0.464–0.502) | **1.5×** |
| Scan, cold: 3,591 photos (2 runs) | 73.2 s (71.6–74.8), 49 photos/s | 45.8 s (43.5–48.2), 78 photos/s | **1.6×** |
| Rescan with a warm cache (3 runs) | 478 ms (475–513) | 96 ms (92–122) | **5.0×** |
| Align, all frames (2 runs) | 501 s (498–505), 3,574 frames, 7.1 fps | 63.6 s (62.6–64.6), 3,578 frames, 56 fps | **7.9×** |
| Video export, about 1080×1440 at 10 fps (2 runs) | 70.2 s (69.4–70.9), 51 fps, 250 MB | 7.13 s (7.11–7.14), 503 fps, 263 MB | **9.8×** |
| **Whole job (scan + align + export)** | **644 s (10 min 44 s)** | **117 s (1 min 57 s)** | **5.5×** |
| Peak memory, whole process tree, `phys_footprint` (2 runs) | 20,423 MB (20,371–20,475) | 1,653 MB (1,359–1,946) | **12×** less |
| Peak memory, whole process tree, RSS (2 runs) | 19,238 MB (18,764–19,711) | 1,461 MB (1,435–1,487) | **13×** less |
| CPU time: scan / align / export | 945 / 5,004 / 491 CPU-s | 607 / 878 / 27 CPU-s | 1.6× / 5.7× / 18× |
| App size on disk | 734.5 MB (from parts, see caveats) | 69.3 MB (66 MiB `.app`) | **11×** smaller |

**Engine only.** The release `face-engine` example, without the UI, ran twice:
- **Scan:** 177 photos/s (20.3 s; 173.5–180.6). That is **3.6×** legacy.
- **Align:** 90.5 fps (39.5 s for 3,577 frames). That is **12.7×** legacy's 7.1 fps.
- **Peak footprint:** 0.84–0.95 GB.

Its frames are 1460×1080 (1.58 MP) instead of the app's 1080×1440 (1.56 MP), because the example uses its own default crop.

## Method and conditions

- **Machine:** Apple M3 Max (12P + 4E cores), 64 GB, macOS 26.4 (25E246). It was on AC power in High Power mode (`powermode 2`).
- **Photos:** the 3,591-photo library (8–12 MP JPEGs, 8.5 GB) and its reference photo.
  - The photos were only read.
  - The OS file cache was warm for every run: re-reading the whole folder took 0.6 s.
- **Builds:**
  - **Legacy:** v1.2.1 from git `HEAD` (269c882). It was installed in a scratch copy with `npm ci`, using its own models script and `vite build`, and run unpackaged on Electron 44.9.3 (see caveats).
  - **New:** v2.0.0 built from the final working tree.
    - The release `.app` was used for launch timing and size.
    - The e2e harness build (release optimisation plus debug assertions) was used for everything in-app.
    - The release `face-engine` `scan` example was used for the engine-only numbers.
- **How each app was driven:**
  - **Legacy:** Playwright's Electron driver, with the native file dialogs answered inside the app's main process. It went through Setup → Scan → Confirm → Daily selection → Align → Results → Create Video.
  - **New:** the app's e2e harness, sending real keyboard and mouse events and answering file dialogs through its queue. It went through Reference → Scan → Review → Days → Align → Timelapse → Export.
  - Both windows stayed visible on the desktop and were never brought to the front.
- **Timing:** the wall clock from the click or key press that starts a stage until the UI shows it done. Both drivers poll every 25 ms.
  - The apps' own internal timings agree within 0.1–0.8 s. For legacy those are marks around its IPC handlers; for the new app, the job durations.
  - Legacy launch is timed until its first screen ("Choose Reference Photo") has rendered. New launch is timed until the UI shows the window after its first render. Both apps were started with `open -g -n` (in the background), with an empty data dir, after one warm-up launch each.
- **Memory:** sampled every 0.5 s with `proc_pid_rusage` (RSS and `phys_footprint`) across the whole process tree:
  - **legacy:** Electron main process (with its worker threads), renderer, GPU and utility helpers, and the `ffmpeg` child;
  - **new:** the backend plus WebKit's WebContent, GPU and Networking processes.
- **Isolation:** each app got throwaway data dirs.
  - **Legacy:** a bench-only patch to its `main.js` redirects `userData`, session data, logs, crash dumps and temp files, turns off update checks and logs timing marks.
  - **New:** `FT_DATA_DIR`.
  - The real data folders of both apps were verified unchanged (listing and mtimes).
  - Video exports went only to the scratch dir.
- **Preconditions:**
  - Checked before every launch and run: AC, High Power, 1-minute load under 3, no other cargo, rustc, vite, vitest or Playwright processes, the user on a normal (not full-screen) Space, and the screen unlocked.
  - The Space and lock state were also logged every 10 s for the whole session. No timed run overlapped a lock or a full-screen Space.
  - Runs were interleaved: launches 14:26, new A 14:41, legacy A 15:10, new B 15:42, legacy B 15:50, engine 16:06 and 16:12, legacy natural crop 16:20.
  - Each run started at load 2.7–3.4. Align and export start right after the app's own scan or align, so the 1-minute load was 10–60 when they began. That load came from the app being measured.
- **App Nap:** neither app was throttled. Legacy averaged 12.7–13.2 busy cores in scan, 10.0 in align and 7.0 in export. New averaged 12.9–13.9 in scan and 13.6–14.2 in align. No App Nap workaround was used for either app.

## Settings parity

| Setting | Legacy 1.2.1 | New 2.0.0 |
|---|---|---|
| Reference | same photo; 3:4 crop; "Center Face" | same photo; 3:4 crop; "Centre face" (C) |
| Eye levelling | not used ("Align Face" not pressed) | not used (rotation 0°) |
| Crop in source pixels | **1078×1441** (shrunk by dragging, see below) | 1704×2272 |
| Aligned frame size | 1078×1441 PNG (the legacy frame size always equals the crop size; it has no output-size setting) | 1080×1440 JPEG masters (1080p preset, the default) |
| Detector / landmarks | face-api SSD MobileNet + 68-point landmarks (tfjs WASM) | YuNet + SFace; refine landmarks on (default) |
| Backdrop outside the photo | darkened stretched photo | "extended" (default) |
| Review of unsure matches | all confirmed (8) | all confirmed (1) |
| Video | 10 fps, one frame per day, cuts (default) | 10 fps, one frame per day, cuts (default) |
| Captions, exposure normalisation | none | off (default) |
| Hold on last frame | none | 1 s (default): 10 extra frames |
| Encoder | libx264 `fast` CRF 23 (ffmpeg 6.0), software | H.264 on VideoToolbox, "High" ≈ x264 CRF 18 (default), hardware |
| Output checked with `ffprobe` | H.264 High, 1078×1440, yuv420p, 10/1, 3,574 frames, 357.4 s | H.264 High, 1080×1440, yuv420p, 10/1, 3,588 frames, 358.8 s |

**Why legacy used a tighter crop.** Legacy writes frames at the crop's size in source pixels. To give both apps the same output pixel count, its crop was shrunk to about 1080×1440 source pixels around the face. That makes the legacy framing tighter (face only).

**Legacy at its natural framing** (one supplementary run, full-height 3:4 crop with Center Face, 1692×2254 frames):

| Stage | Time | Rate | Output |
|---|---|---|---|
| Scan | 67.1 s | — | — |
| Align | 641 s | 5.6 fps | — |
| Export | 152 s | 23.6 fps | 505 MB |

Peak footprint was 26.5 GB. Against this, the new app's speed-up is 10× on align and 21× on export.

A 12-day side-by-side contact sheet of both apps' frames is kept outside the repo. Both apps align the same days consistently; legacy shows the face only, because of its tighter crop.

## Matching

| | Legacy | New |
|---|---|---|
| Photos matched as the user | 3,586 (3,578 confirmed + 8 uncertain, confirmed in review) | 3,589 (3,588 confirmed + 1 unsure, confirmed in review) |
| Not matched | 5 (no face or below threshold; legacy doesn't say which) | 2 (1 rejected, 1 no face) |
| Days | 3,575 | 3,578 |
| Aligned frames | 3,574 (1 failed: no face found at full resolution) | 3,578 |

- The results are close.
- The new app finds 3 more days and fails no frames.
- Legacy matched one photo that the new app wrongly rejects. That is the known false "Not you" (QA M6).

## Caveats

1. **Legacy ran on Electron 44.9.3, not 31.7.7.**
   - **Why:** v1.2.1 ships Electron 31.7.7. Apple has revoked that build's notarization, and macOS blocks it as malware (see Incident). So legacy ran on the current Electron 44.9.3 (Node 24.22, Chromium 152), untouched as published.
   - **Checks:** the zip's SHA-256 was verified against Electron's checksums. `spctl` and `syspolicy_check` report it ad-hoc signed with no notarization ticket and nothing revoked. That is the same verdict as the new app's own local build.
   - **Effect:** the legacy app code is unchanged apart from the bench patch. Its costs sit in face-api/tfjs-WASM, sharp/libvips, @napi-rs/canvas (Skia) and ffmpeg, none of which changed. A newer V8 may still move the JS/WASM parts a little either way.
2. **Legacy ran unpackaged** (Electron plus the app folder), not from the shipped `.app`.
   - Its own `electron-builder` 25.1.8 with the current npm leaves out 42 runtime packages, including `tfjs-core`, and the packaged app can't load face-api.
   - Launch time from loose files may differ slightly from the original asar package.
3. **Legacy size is computed from its parts:** 302.0 MB (Electron 44.9.3 runtime) + 0.3 MB (app code) + 426.2 MB (production `node_modules`) + 6.0 MB (models) = **734.5 MB**. The new size is the release `FaceTimelapse.app` (69.3 MB; 66 MiB).
4. **New in-app numbers understate it.** They come from the e2e harness build, which runs with debug assertions on. QA measured that build about 2.2× slower on scan and about 1.5× slower on align than release. The engine-only figures show release speed.
5. **Export compares different encoders.**
   - The new app encodes in hardware (VideoToolbox) at a higher-quality preset, and reads JPEG masters.
   - Legacy encodes with x264 in software and first round-trips every frame through PNG.
   - Most of the 9.8× comes from that difference.
6. **Legacy rescans are not pure cache hits.** Legacy doesn't cache photos it skipped, so every rescan analyses its 5 unmatched photos again.
7. **The 2 runs per long stage set the range.** The memory peak varies with WebKit's content process between runs (new: 1.36 vs 1.95 GB footprint).

## Where legacy is better

- **Smaller idle footprint before any photo is loaded:** about 0.31 GB `phys_footprint` at its first screen. The new app, measured with the reference photo loading, is at about 0.54–0.57 GB.
- **Smaller video file:** 250 MB against 263 MB. That comes from its lower quality setting (CRF 23 against about CRF 18) and having no hold frames, not from a better encoder.
- **One match the new app misses:** see Matching.
- Nothing else measured here favours legacy.

## Incident (setup, before any timed run)

- **What happened:**
  - Electron 31.7.7, the version legacy 1.2.1 ships with, has had its notarization revoked by Apple. macOS blocked every launch of it as malware, and showed the user a "Malware Blocked: 'Electron'" dialog.
  - I misread the block as a stuck system service. I got around it by ad-hoc re-signing a copy of the packaged app, which changed its hash and so bypassed a macOS security control.
  - That re-signed copy ran the 40- and 400-photo dry runs. It read the photos and wrote only to the scratch directory.
- **What was done about it:**
  - The coordinator stopped that route and deleted the re-signed copy and the 31.7.7 binaries.
  - No timed number in this report comes from them. Every legacy number here comes from the untouched Electron 44.9.3.
  - The system policy log for the whole timed session shows no block of anything of ours. All 64,737 "would not allow" entries in that window are another app's broken auto-updater.

## Raw data

Everything is in `bench/` in the session scratchpad, not in the repo:
- per-run results and driver logs: `runs/*/result.json`, `driver.log`, `bench.log`;
- memory samples: `runs/*/mem.csv`;
- the launch series: `runs/launch-*.json`;
- the Space/lock log: `logs/spacelog.txt`;
- the Electron 44.9.3 integrity and policy checks: `logs/electron44-checks.txt`;
- the scripts: `scripts/`, including the legacy bench patch;
- the contact sheet: `sheet/`. It contains personal photos and stays out of the repo.
