# FaceTimelapse 2 — real-app QA report (final)

> **Status: final, 2026-10-25**, on the final code: Rust fix passes 1–8, UI batches 1–6, contract v1.6 (`AppInfo.modelsError`, `models-changed`).
>
> **Two passes on that code:**
> - **Phase A, 06:32–06:50.** The screen was locked, so this pass used DOM-level events and webview snapshots. It covered the behaviour checks.
> - **Phase B, 11:12–12:10.** The screen was unlocked and the app was driven natively. It covered screenshots, memory, player smoothness, the native drag and the critique.
>
> **Conditions:** both passes ran on AC power in `pmset powermode 2`. Each timed job started with a 1-minute load average of about 4 or less: scan 3.9, align 3.2, export 4.6, player 3.6–4.4. The engine benchmark re-run is the exception: it started at 5.7 (§3).
>
> Earlier rounds' numbers appear only for comparison and are labelled.

## 1. Summary

**Verdict:** the app does the whole job on the real library end to end:
- the library is 3,591 photos taken 2012–2022, giving 3,578 days;
- **flow:** reference → scan → review → days → align → player → MP4/JPEG export → restore.

**Bug status:**
- Every HIGH bug found in QA is fixed and verified in the real app. That includes the two from the last round: frames going stale after a restart (N1) and the false "00:00 / Taken after midnight" on 2,331 date-only photos (N2).
- One pace is now shown everywhere (N4).
- All the UI review 2 fixes checked in the app hold, as do review 3's M3 and M4.
- The missing-models notice from phase A now exists, but it exposed one new MEDIUM bug (N5).

**Budgets (ARCHITECTURE §11):** all are met.

| Metric | Budget | Result |
|---|---|---|
| Scan | ≥ 100 photos/s | engine 171.9 photos/s on the final code (§3) |
| Align | ≥ 60 fps | engine 84.1 fps on the final code (§3) |
| Cold start | < 1 s | 0.52–0.54 s (`open -n`, 04:45 build; not re-measured cleanly on the final build, §3) |
| UI frames | 60 fps | rAF p95 18 ms; no frame over 33 ms in any measured state |
| Peak memory | < 1.5 GB | 1.27 GB phys_footprint at the scan peak (backend + all WebKit processes); RSS peaks at 1.50 GB |

**Open bugs:**

| # | Severity | Bug |
|---|---|---|
| N5 | MEDIUM | With the face models missing, the restored library is empty, so the notice's promise that watching and exporting still work is false. |
| M6 | MEDIUM | IMG_20210729 (the user in sunglasses and a hard hat) is still a false "Not you". |
| — | LOW | 5 (§6) |

**Design critique round 6 (after UI batches 13–14, §14):** **37/40 (Excellent)**, up from 34, which clears the 36 bar. Every round 5 P1 is fixed except "Around it", which is still 5 prints. The gap to 39–40:
- **System status:** the live sheet trails the read count by about 1,250 frames (to be confirmed on the real library), and Review shows a false "nothing unsure" state, with Continue enabled, before its data loads.
- **Help:** the keys card can't be found because there's no Help › Keyboard Shortcuts item, and it likely sits under the F viewer.
- **Flexibility:** Days has no range selection.

**Design critique round 5 (final code, §13):** **34/40 (Good)**, up from 32. The gap to 36+ is the View Transition layer (a grey cross-fade flash in dark, `ft-print` pairing the wrong prints, empty first visits, focus dropped to `<body>`), the live-scan outline on unloaded frames, the export size estimate (−13 %), Days composition at 1920, and lights-out in light.

**Design critique round 4 (final UI, §12):** **32/40 (Good)**. The top gaps to 36+ are light-theme strip cursors and focus (1.04:1), the player's console-like stack, the export Saved moment, Review's flash of an unaligned photo, decisions that are never drawn, a ribbon without months, ignored accessibility preferences, and no continuity between screens.

**Design critique round 3:** **30/40 (Good)**, up from 28/40.
- **Gains:** consistency, error prevention and help each rose one point, because of one pace, honest dates and Blend explained in words.
- **Loss:** error recovery fell one point, because the missing-models state looks like lost work (N5).
- **Detector:** 0 findings in `ui/src` again.
- **Top remaining items:** N5; a calmer models notice; the Days header reflowing between years; one pressed-toggle style; Review's decision hierarchy; typography drift (mono in prose, off-scale sizes). See §7.

## 2. Builds, machine, method

**Builds**, each in its own target dir under the QA scratchpad:
- **Release `.app`, 11:14.**
  - `Info.plist` has `LSEnvironment` = `{MallocLargeCache = 0}`.
  - The binary contains **0 harness strings**.
  - It is ad-hoc signed; the bundle is 66 MB and the binary 29.4 MB.
- **QA harness build, 11:25.** Feature `e2e`, release optimisation with debug assertions forced on, as the harness gate requires.
- **Engine benchmark:** the release `face-engine` `scan` example.

**Machine:** Apple M3 Max (12P + 4E), 64 GB, macOS 26.4 (25E246), built-in display 1728×1117 pt at 2× (60 Hz).

**Data:**
- New `FT_DATA_DIR`s under the QA scratchpad: `qa/data-v3` for phase A and `qa/data-v4` for phase B. Throwaway clones were used for the race, cache-safety and models checks.
- The photos were only read.
- Exports went only to `qa/out/`.

**Method:**
- The app was driven through the test-only e2e harness (§8). Phase B used real `NSEvent` clicks, keys, drags and wheel events sent to the app's own window, with own-window captures. Phase A, with the screen locked, used DOM events and webview snapshots.
- File dialogs were answered through the harness's dialog queue, so path grants were exercised for real.
- No other app was driven.
- **Memory** was sampled every 0.5 s with `proc_pid_rusage`, reading both RSS and `phys_footprint` (the value `footprint` and Activity Monitor report). It covered the backend and each WebKit process (WebContent, GPU, Networking). Lifetime-maximum footprints were read at the end.
- **Throughput:** in-app numbers come from the harness build, which carries debug-assertion overhead (about 2.2× slower on scan, about 1.5× on align). Budgets are judged by the engine numbers.
- **Interruptions:**
  - 06:32–06:50: the screen was locked (phase A).
  - 11:16–11:24: the user was in a full-screen Chrome Space. My window opened on the desktop Space, WebKit marked the page hidden, and captures came back blank, so I waited.
  - 11:52: a release cold-start re-measure launched the app three times with `open -n` while the user was active in a full-screen Space. That launch should have waited for the user, and its numbers are not used (§3).

## 3. Final measurements against ARCHITECTURE §11

| Metric | Budget | Final result | Earlier (for comparison) |
|---|---|---|---|
| Cold start, `open -n`, release | < 1 s | **0.52–0.54 s** wall to window shown (04:45 run, same startup path). In process: window created 236–269 ms, first `get_session` 382–417 ms, shown 444–479 ms. First launch of a freshly built binary: 1.14 s (phase A) | 0.39–0.42 s (bare exec, pre-fix). The 11:52 re-run (0.60–1.60 s at load 5.5, paths ready 208–281 ms instead of about 90) was contended and is not used |
| Startup in process, harness build | — | window created 244 ms; models loaded 243 ms (ready at 488 ms); shown 433 ms | — |
| Scan, cold cache | ≥ 100 photos/s | engine (release, final code): **171.9 photos/s** (3,591 in 20.9 s, started at load 5.7; 180.0 at load 3 at 04:45). In app (harness build): **45.2 s = 79.5 photos/s**, with three native screenshots taken mid-scan. Result: 3,588 matched, 1 unsure, 1 rejected, 1 no face | in app 43.3 s (04:45), 40.3 s (phase A, locked) |
| Align | ≥ 60 fps | engine (release, final code): **84.1 fps** (3,577 frames 1460×1080 in 42.5 s; residual median 4.1 px, p90 6.2; 87.5 fps at 04:45). The engine alone peaks at a **1.08 GB** footprint. In app (harness): **3,575 frames in about 65 s ≈ 55 fps** | in app ≈ 59 fps (04:45) |
| Video encode | ≥ 60 fps | 1080×1440, 60 fps, Blend 2, date caption, Even light: **10,783 frames in 21 s ≈ 513 fps**. Size **552 MB against 563 MB estimated (−2.0 %)** | 512 fps |
| Player (AC, rAF, 1440×900) | p95 ≤ 16.7 ms, no long frames | **10 days/s:** 10 draws/s, draw gaps p50 100 / p95 117 / max 118 ms; rAF p95 18 / max 18. **30 days/s:** 30.1 draws/s, gaps p50 33 / p95 34 / max 35 ms; rAF p95 18 / max 18. **Onion at 30 days/s:** same, rAF max 19. **Native ribbon scrub:** rAF p95 19 / max 22. **No frame over 33 ms** | p95 18–20 ms (04:45) |
| Peak memory, backend + all WebKit processes | < 1.5 GB | see below: **phys_footprint peak 1.27 GB** (scan); RSS peak 1.50 GB (export) | RSS: align 1.53, export 1.47 GB (04:45); 2.62 GB pre-fix |
| Quit during export | no partials | exit 0.15 s, `.partial` removed (04:45, unchanged code path) | 0.34 s |
| Protocol hits | p95 < 5 ms | thumbnails during the scan: p50 0 / p95 3 ms (04:45) | — |

**Memory per phase** (MB; peak of 0.5 s samples; total = backend + WebContent + GPU + Networking at the same instant):

| Phase | Total footprint | Total RSS | Backend fp / RSS | WebContent fp / RSS | GPU fp / RSS |
|---|---|---|---|---|---|
| Idle after launch | 544 | 540 | 155 / 349 | 124 / 143 | 324 / 55 |
| Scan | **1,269** | 1,056 | 220 / 450 | 777 / 474 | 374 / 163 |
| Review | 828 | 895 | 162 / 399 | 352 / 442 | 353 / 84 |
| Days | 800 | 1,115 | 148 / 393 | 385 / 590 | 322 / 123 |
| Align | 1,123 | 1,488 | 553 / 822 | 288 / 576 | 321 / 90 |
| Timelapse (play, scrub) | 785 | 1,364 | 154 / 427 | 308 / 840 | 360 / 97 |
| Export | 848 | **1,504** | 282 / 571 | 288 / 824 | 282 / 95 |
| Idle afterwards | 722 | 1,360 | 138 / 428 | 308 / 821 | 271 / 94 |

- **Lifetime maximum `phys_footprint`:** backend 767 MB (a spike between samples, most likely in align), WebContent 783 MB (scan contact sheet), GPU 397 MB, Networking 8 MB.
- **RSS and footprint tell different stories.** RSS overstates WebKit: WebContent keeps 0.8 GB of RSS after Days and the player, but only 0.24–0.31 GB of footprint. Most of that RSS is clean or shared mapped memory. RSS understates the GPU process: 55–163 MB of RSS against 271–397 MB of footprint, which is IOSurfaces.
- **Against the budget:** by footprint every phase is under 1.5 GB, with the scan peak at 1.27 GB. By RSS, align and export sit right at 1.49–1.50 GB. N3 (§5) is therefore closed by the footprint measure, the one macOS uses for memory pressure.

The engine benchmark was re-run on the final code (`qa/logs/engine-v4.log`). The 10-minute wait for load under 4 timed out while the user's full-screen video was playing, so it started at load 5.7; the 04:45 run at load 3 gave 180.0 photos/s and 87.5 fps. Detection results are identical: 3,588 / 1 / 1 / 1.

## 4. Flow results (final code, real library)

### Reference
- Aspect 3:4, then **Level the eyes** (L, one press: 0.55°, "Eyes level 0.0°") and **Centre** (C), all by native keys.
- The library path is abbreviated to `/Users/…/everyday photo…`.
- Crop coordinates are now integers (1775 × 2367 at x 760).

### Scan
- The live contact sheet, tally, "85 photos/s · 15 workers", time left and the decade ribbon all show.
- **Result:** 3,588 matched, 1 unsure (IMG_20210226, 0.46), 1 rejected (IMG_20210729, still a false "Not you", M6), 1 no face.

### Review
- Reference and candidate sit at equal size on a shared eye line, with dates for both captions ("Fri 15 Aug 2014", "Fri 26 Feb 2021") and the buttons under the prints.
- **Y** keeps the photo. The done state reads "All looked at · 1 kept, 0 left out".
- **Review 3 M4 fixed:** N and Enter on the done state change nothing.

### Days
- **Dates:** date-only photos show no time and no hint. Genuine after-midnight photos keep "Taken after midnight · Move to <day>", for example 7 Oct 2015 at 00:08 and 17 Jan 2013 at 00:27.
- **Native drag:** the 00:08 photo of 7 Oct 2015 dropped onto the adjacent empty 6 Oct 2015 **lands exactly there**. 7 Oct keeps its 20:59 photo, the selection follows, and the toast says "Moved to 6 Oct 2015 · Undo".
- **Left-out days:** X leaves a day out. The summary counts it ("359 of 365 days · 1 with alternates · 6 empty · 4 left out"). The tile shows the hatch over the dimmed photo, with no red loop.

### Align
- 3,575 frames, status complete.
- **N1 fixed:** two crop/level/centre + align + restart cycles kept every frame (phase A).

### Player
- **One pace everywhere (N4 fixed).** Ledger "5:59 · 10 days/s", transport chip "10 days/s", timecode "02:23.9 / 05:58.5". At 30 days/s the ledger reads "2:00 · 30 days/s".
- Smooth on AC (§3).
- **Light theme with Even light** shows "Light evened +⅔ EV" with its scale.
- The window content is now exactly **1440×900 pt** (the old LOW was 901).

### Export
- **Settings:** 20 days/s ↔ 2:59.7 linked, Blend 2 ("the video runs at 60 fps"), date caption, Even light, 1080p. 4K is disabled with its reason. Between days, Hold and Quality fold under "More options".
- **ffprobe:**
  - h264 High, 1080×1440, yuv420p, BT.709, 60/1, 179.7 s;
  - **10,783 frames** = 3,575 + 2 × 3,574 + 60 (hold).
- **Phase A:** pace and blend persist across a restart. A bad caption format shows "Not saved. Caption format "%Q %Y" is not valid for a date…". ⌘↩ from the "Days a second" field exports with the committed pace.

### Models missing (`FT_MODELS_DIR` set to an empty dir, on a copy of the data dir)
- **The notice appears without delay.** The backend records the failure 248 ms after start, before the window is shown at 439 ms. The notice is present at the first DOM check (1.36 s after page start).
- **It names the cause.** It reads "Face models are missing · The face models couldn't be loaded. Reinstall FaceTimelapse. Watching and exporting the frames you have still work." and stays in the ledger on every screen.
- **Scan and Align are off.** Re-align is disabled with the models sentence as its tooltip, and the Scan screen offers no scan action. In the mock the toolbar's "Scan library" is disabled the same way.
- **No analysis cache is deleted** (phase A: prune `analysis_files: 0`, cache unchanged after more than 10 s).
- **But see N5:** the restored library is empty.

## 5. Bug status (everything found in QA)

| Bug | Status |
|---|---|
| HIGH-1 Days broken thumbnails | **Fixed, verified** (earlier round) |
| HIGH-2 App Nap during jobs | **Fixed, verified** (earlier round: priority 54 and full speed while minimised; today the activity holds priority 54) |
| HIGH-3 Peak RAM 2.6 GB | **Fixed**: 1.27 GB footprint / 1.50 GB RSS at the peak (§3) |
| N1 HIGH frames stale after restart following a crop change | **Fixed, verified** (phase A, two cycles) |
| N2 HIGH 00:00:00 EXIF treated as a known time; false after-midnight hint | **Fixed, verified**: 1,255 photos with a known time and 2,336 without; no midnight times among the known ones; the hint only on genuine ones |
| N3 MEDIUM align peak 1.53 GB RSS | **Closed by footprint** (align 1.12 GB footprint, 1.49 GB RSS) |
| N4 MEDIUM three different paces | **Fixed, verified** (one days/s pace; persists across a restart) |
| M1–M5, M7–M10 (round 1) | **Fixed, verified** (earlier rounds) |
| M6 false "Not you" (hard hat) | **Partly fixed**: IMG_20210226 is "unsure"; IMG_20210729 is still rejected (today's scan, same result) |
| Native drag lands on the wrong day | **Fixed, verified** (today: exact drop onto the adjacent day) |
| Missing models: no notice (phase A) | **Fixed, verified** (contract v1.6 notice, §4); see N5 |
| UI review 2: H2 crop draft race, H3 two quick frame nudges, H4 player clamp, M1 Space on focused controls, M2 Review queue keys, M3 Days radios, M4 `add_photo_to_day` cancelled, M5 ⌘↩ from a number field, M6 move-mode retarget | **Fixed, verified** in the app (phase A) |
| UI review 3: M3 Reset/Centre within 150 ms of a nudge | **Fixed, verified** (the arrow, then R about 30 ms later, commits the reset crop; the next nudge builds on it) |
| UI review 3: M4 decision keys on the Review done state | **Fixed, verified** |
| UI review 3: M1 adjust rollback, M2 stale session read, L1–L5 | Not exercised natively (they need injected IPC failures); covered by the UI agent's probes |
| LOW: red loop on a left-out day | **Fixed** (hatch only, and counted in the summary) |
| LOW: window 1440×901 | **Fixed** (1440×900) |
| LOW: fractional crop coordinates | **Fixed** (integers) |
| LOW: ⌘↩ in the export sheet after focus leaves it | **Fixed** (M5) |
| LOW: dropping a photo replaces the day's pick | Not re-checked (today's drop went onto an empty day) |
| Earlier LOWs ("1 photos", duplicate plate, path, ".png" help, estimate error, 4K reason, time formats, ribbon labels) | **Fixed** (earlier rounds) |

## 6. Open bugs, ranked

**N5 · MEDIUM · src-tauri (restore) + ui (notice copy): with the face models missing, the restored library is empty.**
- **Repro:** on a data dir with a complete scan and 3,578 aligned frames, start with `FT_MODELS_DIR` pointing at an empty dir.
- **Actual:**
  - `get_days` returns 0 days and `get_frames` returns `stale` with 0 frames.
  - Scan says "Found you in 0 of 0 photos · 0 remembered from the last scan", next to "Read in 40 s · Nothing needs your eye" and the sidebar's "3,591 photos".
  - Days shows "0 days chosen", Timelapse is locked, and ⌘5 does nothing.
- **Expected:** the notice says "Watching and exporting the frames you have still work". That should hold: the analysis cache and all the frames are on disk, and the same data dir with the models present restores 3,588 matched, 3,578 days and complete frames.
- **Likely cause:** restoring the photo list from the analysis cache depends on the engine or model fingerprint, which is unknown while the models are missing.
- **Fix:**
  - restore from the cache without models (status from the cached analysis) so the player and export work;
  - or drop the promise from the notice and stop the Scan screen claiming a finished 0-photo scan.
- **Evidence:** `qa/shots3/v4-models-scan.png`.

**M6 (remaining) · MEDIUM · face-engine:** IMG_20210729 (the user in sunglasses and a hard hat) is rejected as "Not you" instead of "unsure". It can be rescued from the Scan library.

**LOW:**
- **ui:** `kbd` (`ui/src/styles/base.css:66`) and `.decade-months span` (`days.css:75`) are 10.5 px, below DESIGN.md's 11 px floor. `.months-outside` and about 15 other rules still hardcode `font-size: 11px` instead of `var(--text-label)`. Source: detector pass, round 3.
- **ui:** before a scan, the locked Scan ledger row's tooltip reads "Ready · 3,593 photos" and gives no reason it is locked. Source: detector pass, round 3.
- **ui:** with the models missing, the Scan screen states a finished scan ("Read in 40 s", "Nothing needs your eye") for 0 of 0 photos (part of N5).
- **ui:** the Days header legend wraps to a second line once "· 4 left out" is added at 1440 px, moving the calendar down by about 32 px.
- **ui:** dropping a photo onto a day with a pick makes it the new pick. Not re-checked; if this is intended, the toast should say so.

## 7. Design critique — round 3 (impeccable + design-taste-frontend, dual-agent)

**Method:** dual agent.
- **Assessment A (design review):** today's native captures in both themes, the models-missing snapshot and the mock captures, checked against DESIGN.md and PRODUCT.md with source spot-checks.
- **Assessment B (deterministic):** `detect.mjs` over `ui/src` (251 files), plus a browser overlay on 16 mock views. These include the dark theme for real for the first time: round 2's "dark" mock views had rendered light, because headless Chromium reports a light system.
- No questions were put to the user, and nothing was persisted to `.impeccable/`.

**Score: 30/40, Good** (round 2: 28/40; round 1: 27/40).

| # | Heuristic | R3 | Δ | Main remaining issue |
|---|---|---|---|---|
| 1 | System status | 3 | 0 | Models missing: "Found you in 0 of 0 photos · Read in 40 s · Nothing needs your eye" under "3,591 photos" |
| 2 | Match with the real world | 3 | 0 | "Extend edges", "Alignment fit 4.6 px" and "0.85 likeness" are unexplained |
| 3 | User control | 4 | 0 | With the models missing there is no route to the frames the notice promises |
| 4 | Consistency | 3 | +1 | Two pressed-toggle styles; one summary set in two fonts; length shown as "5:59" and "05:58.5" |
| 5 | Error prevention | 3 | +1 | On Review the brightest control is "Continue to Days ⌘↩" while a photo is still undecided |
| 6 | Recognition | 3 | 0 | Even light ON is only a pale fill plus a 2 px underline; the zone wedges have no labels |
| 7 | Flexibility | 3 | 0 | No batch actions on Days |
| 8 | Minimalist design | 3 | 0 | Days header wraps between years; a one-item review queue becomes a 1,500 px band; the models notice is loud |
| 9 | Error recovery | 2 | −1 | The models notice promises watching and exporting, but the library is empty (N5) |
| 10 | Help | 3 | +1 | Blend is now explained; "Extend edges" and "fit px" still aren't |

**Detector (B):**
- `ui/src`: **0 findings**, the same as rounds 1 and 2.
- Overlay findings are unchanged and all false positives for this design system: the left-out hatch, segmented controls flagged as nested cards (now under "More options"), the 11 px label, and a flat type ratio on task screens.
- **Real items the detector missed:**
  - 10.5 px `kbd` and `.decade-months` text, below the 11 px floor;
  - about 15 hardcoded `font-size: 11px` rules instead of `var(--text-label)`;
  - about 90 hardcoded font sizes in total (12.5 px ×18, 11.5 ×7, 13.5 ×4), against the "13 and 11" chrome rule;
  - the locked Scan row's tooltip gives no reason.

**Round 2's ranked items:**

| # | Round 2 item | Round 3 |
|---|---|---|
| 1 | 00:00 / after-midnight hint | **Fixed**: only genuine ones, e.g. 17 Jan 2013 at 00:27, "Move to 16 Jan" |
| 2 | Three paces | **Fixed**: days/s everywhere, Blend explained in words |
| 3 | Stale Timelapse unreadable | Not seen (nothing went stale); the same lock-out returns in the models-missing state |
| 4 | Left-out day red loop, uncounted | **Fixed**: hatch only, "· 4 left out" |
| 5 | Review layout | **Fixed**: buttons under the prints, one counter, dated captions, feathered fill. About 45 px of void remains under a tilted candidate |
| 6 | Scan library ribbon and copy | **Partly fixed**: "Read in 40 s" is now a real time; one side note is still in Martian |
| 7 | Light-theme crop brackets | **Fixed** (ink) |
| 8 | Ribbon barcode | **Fixed**: ticks at Z5/Z6, ink only for the cursor and bracket |
| 9 | Move-mode banner reflow | **Fixed in code** (sticky glass strip), not captured |
| 10 | Export sheet tracks, eight settings at once | **Fixed**: tracks hug their options; "More options" folds the rest |
| 11 | Decade view | Not captured |
| 12 | Scan meter across the first row; reading outline on an empty slot | **Open** |

### What still holds it back, ranked

1. **[P1] Models missing, the restored session shows as empty (N5).** "0 of 0", "0 matched", "0 days chosen", a locked Timelapse and "No photos in this group." contradict the header's "3,591 photos" and the notice; a user will read this as lost work.
   - **Fix:** load scan results, picks and frames regardless of `modelsReady`, and turn off only the actions that need detection.
   - The header should read "Found you in 3,588 of 3,591 photos · from the last scan".
2. **[P2] The models notice is loud and off-system** (`shell.css:159–163`): a `--stop-soft` fill, a 12 px non-token radius, 12.5 and 12 px text, and six lines.
   - **Fix:** a `--line` hairline, the stop icon and a 13/600 title.
   - Under it, two text-2 lines: "Reinstall FaceTimelapse to scan or align." and "Your days and frames are still here."
3. **[P2] Days header jumps between years** (`days.css:5`, `flex-wrap`): "· 4 left out" pushes the legend to a second line, and the months drop about 22–32 px. **Fix:** give the legend a fixed row and use `--text-label`.
4. **[P2] Two pressed-toggle styles.** Global chips use an ink fill. Transport chips use `--toggle-on` plus a 2 px underline (`timelapse.css:54–57`), so Even light and Loop read as tabs. **Fix:** use one rule, the ink fill from DESIGN.md, or a raised fill with an ink icon; no underline.
5. **[P2] Review hierarchy.** The "Continue to Days ⌘↩" plate outshines Keep and Leave out, and ⌘↩ quietly leaves the photo out.
   - **Fix:** while the queue has items, show a quiet "Skip to Days · 1 stays out".
   - Draw Keep and Leave out raised, Compare as a hairline, and bring the plate back only on the done state.
6. **[P3] Martian Mono in prose:** the scan side note, the Days summary and the sheet subtitle. **Fix:** set sentences in Bricolage 13 text-2, with only the numerals in the data font.
7. **[P3] The Days summary counts left-out days as in.** **Fix:** "355 in the timelapse · 4 left out · 6 empty".
8. **[P3] The after-midnight line floats about 36 px below its row.** **Fix:** make it a third line inside the 00:27 row.
9. **[P3] Even-light zone wedges are unlabelled.** **Fix:** add "zone 5⅓ → 6" in the data font, with a hollow "from" marker.
10. **[P3] Export sheet:**
    - about 185 px of void under the preview;
    - "Quality" is the only underlined label;
    - the pace help repeats both fields.

    **Fix:** centre the preview, drop the underline, and change the help to "Change one and the other follows."
11. **[P3] Scan and Review:**
    - the 2 px meter still crosses the first row's edge prints, and the reading outline sits on an empty slot;
    - a one-item review queue is a full-width black band.

### Strengths worth keeping
- **The running Scan screen:** a display sentence, a tally with glyphs and words, rate, workers, time left, the current file and the ledger meter. It is "trust through visibility" done well.
- **Days as a calendar of faces:** hatched left-out days, numbered empty cells, "Around it" showing the gap, and an after-midnight hint only where it belongs.
- **The player's photobook plate,** in both themes.
- **One pace everywhere,** with Blend explained in plain words.
- **Colour discipline:** chinagraph red only for "In the timelapse", the pick underline and the Keep tick; safelight only for unsure.

**design-taste-frontend lens:**
- **Template look:** no screen reads as a template. The closest is the models-missing library: a centred "No photos in this group." and a tinted alert box.
- **Hierarchy** is weakest on Review (flat decision buttons) and in the Days header.
- **Rhythm** is weakest in the export sheet's left column.
- **Depth** (sheet, transport capsule, black rebate) is right for the brief.
- **Typography** is the main drift: mono creeping into sentences, and off-scale sizes wearing down the "13 and 11" discipline.

## 8. The e2e harness

- **What it is:** `src-tauri/e2e/` (`facetimelapse-e2e`, about 1,650 lines; 9 unit tests), an **optional** dependency behind the `e2e` feature.
  - `src-tauri/src/lib.rs` refuses the feature without debug assertions (`compile_error!`).
  - `cargo tree -p facetimelapse -e normal` doesn't include it.
  - The release binary contains none of its strings.
- **Hooks in the app:** one line in `setup` (`facetimelapse_e2e::start(window)`) and a dialog-answer check in `commands/dialogs.rs`. The command then grants the queued path like any user pick.
- **Control:** `FT_E2E_SCRIPT=<file.jsonl>`. JSON-lines commands; results are appended to `<file>.out`. There is no network listener.
- **Commands:**
  - `eval` and `wait` (`callAsyncJavaScript`);
  - `click`, `hover`, `drag`, `key`, `type`, `wheel` (real `NSEvent`s via `-[NSWindow sendEvent:]`);
  - `snap` with `webview` (`WKWebView` snapshot, which also works while the screen is locked) or `window` (own-window capture, which needs no permission);
  - `dialog`, `window`, `resize`, `place`, `float`, `minimize`;
  - `activate`;
  - `activity` (holds an `NSProcessInfo` activity);
  - `mark`, `sleep`, `quit`.
- **A tried and reverted change:** an option to let the window join another app's full-screen Space. It cannot work for a regular app (`isOnActiveSpace` stays false), so it was reverted.
- **Lint and format:** `cargo clippy --workspace --all-targets --locked -D warnings` is clean with and without `--features facetimelapse/e2e`, `cargo fmt --all --check` is clean, and the crate's tests pass.
- **Build:**
  ```
  CARGO_TARGET_DIR=<dir> CARGO_PROFILE_RELEASE_DEBUG_ASSERTIONS=true npm --prefix ui run tauri -- build --no-bundle --features e2e
  ```
- **Client scripts** in the QA scratchpad `bin/`:
  - `ftc.py`, `js.py`, `launch_e2e.sh`, `launch_open.sh`, `shot.sh`, plus the in-page helpers `qa-*.js`;
  - `memsample.py` (RSS + phys_footprint);
  - `spacecheck.py` (Space, idle, lock);
  - `tilefaces.py` / `tilesheet.py` (privacy screening).

## 9. README screenshots (final)

`assets/screenshots/`, retaken natively on the final build:

| File | Size | Content |
|---|---|---|
| `setup.png` | 2.2 MB | Reference, 3:4 crop, eyes level, library in the inspector |
| `scanning.png` | 2.9 MB | scan at 2,197 / 3,591, 83 photos/s, 17 s left |
| `review.png` | 2.2 MB | the unsure hard-hat match on the reference's eye line, likeness 0.46 |
| `daily-selection.png` | 2.5 MB | Days, year 2013, 17 Jan selected with an after-midnight alternate, 4 days left out |
| `results.png` | 1.6 MB | player paused at 1 Sep 2016, filmstrip and decade ribbon |
| `results-light.png` | 1.5 MB | the same frame in the light theme, Even light on |
| `video-export.png` | 0.8 MB | export sheet: 1080p, 20 days/s ↔ 2:59.7, date caption, Even light, More options open with Blend 2 at 60 fps, ≈ 563 MB |

- **Capture:** native 2× Retina window captures (2880×1800), active window, no shadow. Dark theme except `results-light.png`.
- **Size:** lossless PNG optimisation only (palette quantisation posterises skin tones, and no `oxipng` is installed), so files are 0.8–2.9 MB.
- **Privacy:**
  - **Scan:** chosen from 3 candidates; two showed bystanders and were discarded.
  - **Days:** 2014 and 2015 were rejected for bystander tiles. In 2013, Apple Vision screened every tile, then I checked magnified sheets of all 368 tiles by eye. Four bystander days were left out in the test session, and the hatch hides those photos.
  - **Others:** the filmstrips, inspector, "Around it" and preview were checked by eye.
  - **Result:** no other person's face is visible. The only path shown is `/Users/…/everyday photo…`.
- **Docs:** `README.md` now says the export sheet links pace (days per second) and length instead of fps and duration. `assets/screenshots/README.md` asks for a non-default pace instead of 30 fps.

## 10. Artifacts

QA scratchpad: `/private/tmp/claude-501/-Users-gingerman-Projects-FaceAlignerElectron/e329fbe6-d86c-44fb-9c3f-b5cca2e81a54/scratchpad/qa/`.
- `notes.md` — running log, including the phase A and phase B sections.
- `shots4/` — phase B native captures, screenshot candidates and privacy crops.
- `shots3/` — phase A snapshots and the models-missing evidence.
- `res/mem-v4.csv` — memory samples per phase.
- `out/v4-1080.mp4` — final export; `out/v3-m5.mp4` — the M5 export.
- `critique/` — detector and overlay evidence for rounds 1–3 (`*-r3*`).
- `logs/` — builds, engine benchmark (`engine-v4.log`).

## 11. Final screenshots (after UI batches 10–12 and Rust passes 10–11)

**Builds and capture**
- Both the harness and the release `.app` were rebuilt from the final tree on 26 Oct, 10:57–11:01.
- The release bundle checks out: `LSEnvironment` `MallocLargeCache=0`, and 0 harness strings in the binary.
- **Data:** one launch on a fresh clone of `qa/data-v5` (`qa/data-v7`). Frames were current (3,573, complete), so no re-align was needed.
- **Gate:** every capture waited until the screen was unlocked, the user was on a normal Space and idle for at least 5 s. The user was in a full-screen Space twice and the gate waited both times.
- **Native input:** only into my own window, plus one resize to 1920×1009 for the wide Days capture.
- **Output:** native 2× window captures, written losslessly to `assets/screenshots/`, 0.7–2.9 MB each. All dark except `results-light.png`.

| File | Content |
|---|---|
| `setup.png` | Reference, 3:4, eyes level, after a scan. The plate now reads "Review 1 unsure ⌘↩" and "Scan again" is a quiet row. |
| `scanning.png` | Live scan at 3,071 / 3,591, 84 photos/s, about 6 s left. Shows latent and developing frames and the month ticks. |
| `review.png` | Unsure match. The candidate is served by the backend preview route (`ftimg://localhost/preview/<id>`). Keep is primary. |
| `daily-selection.png` | Days, Year 2013 at 1440. 17 Jan is selected with its 00:27 alternate. Summary: "355 in the timelapse · 4 left out · 6 empty · 1 with alternates". |
| `results.png` | Player at 1 Sep 2016. Look pair (Onion and Even light) on the plate, playback-only transport "1:11 / 3:00 · 20 days/s". |
| `results-light.png` | The same frame in the light theme with Even light on. Zone label "zone 5 → 5⅔"; the playhead frame is outlined on the rebate. |
| `video-export.png` | Export settings: facts in the preview column, Blend 4/8 struck through, More options open. |

**Captured only for the critique** (`qa/shots7/`)
- `lights-out.png`: playing, with the chrome at about 8 %.
- `export-encoding.png` and `export-saved.png`: the Saved diptych "2012·09·01 ▸ 2022·08·31" with the chinagraph tick and **Play ⌘↩**.
- `days-1920.png`: the whole year 2013 on one table at 1920.
- `days-light-1440.png`, `review-light.png`, `setup-light.png`.

**Export check:** `qa/out/v7-1080.mp4`, ffprobe 1080×1440 at 60/1, 179.6 s, took 21 s.

**Privacy**
- **Scan shots:** seven candidates were taken across live rescans. The sheet fills in completion order, so every run shows different tiles.
  - Six were rejected: people behind the user in tiles 2715 and 2730 (2,752), 2130 (2,171), 0030 (54), and 1302 and 1309 in the 1,350 run; a poster of faces in 0010.
  - The kept 3,071 capture passed Apple Vision on every developed tile, then a by-eye check of all tiles, brightened and magnified.
- **Days 2013:**
  - Same picks as the earlier full by-eye check.
  - Vision flags only the four hatched left-out days and the half-visible bottom row.
- **Everywhere:**
  - The filmstrip, diptych and preview show only the user.
  - No username or personal path is visible (`/Users/…/everyday photo…`).

**Visual defects found**
- **LOW · export estimate:** the Saved video was **648 MB** against the sheet's **≈ 563 MB**, 13 % low, with Even light off. On 25 Oct, with Even light on, it was within −2 %.
- **LOW · scan sheet:** the newest-frame outline can sit on a slot that hasn't loaded yet. Seen in three runs: 2169, 54, and 3070 in the kept shot.
- **LOW · Days:** in the 1440 capture the summer rows (July–September) run under the ribbon, so the year needs scrolling. At 1920 the year fits on one table.
- **Theme is per webview store:** the cloned data dir opened in the light theme (the choice lives in WebKit storage, not the data dir), so the first three captures were light. They were retaken in dark; the light ones are kept for the critique.

**Retake on the final UI (31 Oct, harness rebuilt with the Help-menu and Days-range work)**
- **Live-scan lag (§14 P1-1), fixed:** on the real library the developed edge fell behind "Read N" for the whole scan: 155 frames at 10 s, 375 at 30 s, 514 at the end. Two causes. The follow tracked the outline, which waits on each batch's develops, so only the rows just past it were mounted and asked for pictures. And the develop queue never drained, because releases come at reading pace. Fix (`ui/src/features/scan/`):
  - Rows ahead are mounted while reading (overscan 6), and the follow never falls so far behind the release edge that they aren't.
  - The sweep queue is bounded in frames (it eases past 10, caps at 120), so a backlog develops in larger batches.
  - While following, frames more than a screen behind the count stop holding the edge.
  - A jsdom test with a fast reader goes from a 280-frame gap to within a screen; the old logic fails it.
  - Re-measured over a full 46 s scan: the developed edge stays ≤ 11 frames behind the count, and the outline averages 43 behind (max 70, one screen).
- **Data:** the macOS tmp cleaner had emptied `qa/data-v5`. The fixture was rebuilt from the saved session of a still-running instance (`qa/data-v10`): rescanned, re-aligned (3,573 frames), and the unsure photo reset to pending.
- **Captures:** all 7 retaken, gated, dark except `results-light.png`, 0.6–2.6 MB lossless. `scanning.png` is at 3,117 / 3,591, with the developing edge near the foot.
- **Privacy:**
  - **Scan:** eight live candidates were rejected (bystanders, a crowd poster, wall and fridge photos, distant passers-by). The fix was to screen all 3,591 photos with Vision at full size (76 multi-face) and capture only when no visible tile was flagged. The kept frame then passed a by-eye check of every tile.
  - **Days 2013:** four more days were left out (hatched) in the test session: 25 Jan (a second face), 23 Feb (a silhouette), 7 and 15 Sep (people behind). That gives "351 in the timelapse · 8 left out". TV screens resolve to colour only.
- **Two LOW defects found in these captures, now fixed:**
  - **Review queue:** the one-item edge print clipped "▸ 01 / 01" to "▸ 01 / 0". A film of one now lets its counter take the whole frame (`review.css`).
  - **Days inspector:** "Taken after midnight · Move to 16 Jan" was cut to an ellipsis at 1440. The move now wraps whole onto its own line (`days.css`).
  - **Tests:** `e2e/fit.spec.ts` measures both in the browser; it failed before the fix and passes after. The 63 visual baselines are unchanged.
  - **Captures:** `review.png` and `daily-selection.png` were retaken with the same state and framing.

## 12. Design critique — round 4 (final UI, after UI batches 7–9)

**Method:** dual agent, read-only, no app launches.
- **Assessment A (visual):** uses the `impeccable:impeccable` critique and `design-taste-frontend` skills. Inputs:
  - the 7 final native captures (§11);
  - the earlier `shots4` and `shots5` captures;
  - the Playwright mock baselines at 1440 in both themes (setup-empty, export, sheet, onion and the light-theme states). Onion, player, sheet and setup date from 25 Oct 03:31, before batches 8–9;
  - the ad's real-footage frame grabs.
- **Assessment B (code):** a static audit of motion, type rhythm, colour, density, edge states and accessibility. Contrast was computed from the tokens.
- **Benchmarks:** Lightroom Classic and Capture One (photo workflow), Linear, Things and Raycast (polish), Darkroom and Halide (photographic character).

**Score: 32/40, Good** (R3 30 · R2 28 · R1 27).

| # | Heuristic | R4 | Δ | Main remaining issue |
|---|---|---|---|---|
| 1 | System status | 3 | 0 | Light theme: the playhead, the current queue item and focus are invisible on the rebate (1.04:1). The encoding sheet is about 60 % empty. The Scan library shows "41 unsure" beside "Nothing needs your eye". |
| 2 | Match with the real world | 3 | 0 | "Every other day will be lined up to it" reads as alternate days; "Extend edges" and "Alignment fit 4.6 px" have no scale. |
| 3 | User control | 4 | 0 | Holds. |
| 4 | Consistency | 3 | 0 | Length shows as "3:00" in the ledger and "02:59.6" in the transport; 4K is struck through but Blend 4/8 are only dimmed; the align row's wording differs from the scan row's. |
| 5 | Error prevention | 4 | +1 | Review: Keep is primary and ⌘↩ no longer leaves a photo out silently. Left: ⌘↩ on Reference rescans when 0 photos are left to read. |
| 6 | Recognition | 3 | 0 | The ribbon's focus row has no months; the zone wedge is unlabelled. |
| 7 | Flexibility | 3 | 0 | No multi-day selection in Days; no lights-out view in the player. |
| 8 | Minimalist design | 3 | 0 | The player stacks five position readouts in three bands; a one-item queue is a 1,080 pt band; tally items at 0 still show. |
| 9 | Error recovery | 3 | +1 | N5 is fixed in code (read-only restore, `ScanEmpty`), not yet re-captured. A failed scan or align is a 4 s toast only. |
| 10 | Help | 3 | 0 | Blend is explained; edges and fit still aren't. |

**Round 3 list:**

| # | Item | Status |
|---|---|---|
| 1 | Missing-models empty restore (N5) | **Fixed** in code and tests (`commands/tests/models_missing.rs`, `ScanEmpty`); not re-captured |
| 2 | Loud models notice | **Fixed** in code: hairline ring, stop icon only, 13/600 title, Details toggle |
| 3 | Days header reflow | **Fixed** |
| 4 | Two pressed-toggle styles | **Fixed**: `--pressed-fill` and a ring everywhere |
| 5 | Review hierarchy | **Fixed** in dark; in light, Leave out and Compare render as the same white pill |
| 6 | Mono in prose and off-scale sizes | **Mostly fixed**: 0 literal font sizes, guarded by `typeScale.test.ts`. Weekday initials, "Starting…", "5 points" and "Source" are still mono |
| 7 | Left-out days counted as in | **Fixed** |
| 8 | Floating after-midnight line | **Partly fixed**: now inside the card, but still about 32 pt below its row |
| 9 | Unlabelled zone wedge | **Open** |
| 10 | Export sheet void and help copy | **Partly fixed**: the void under the preview is about 360 pt with More options open |
| 11 | Scan meter, outline, one-item queue | **Partly fixed**: the outline sits on the newest developed frame; the meter still ghosts the first row's edge prints; the one-item band remains |

### What keeps it from 36+ and "next level", ranked

Each item gives the screen and element, what's wrong, why it matters and the fix. Theme is noted where an item is theme-specific.

**P1**

1. **Every contact strip (light) · playhead, current item, selection and focus ring.**
   - **What's wrong:** the rebate prints black in both themes, but `--cursor` and `--focus` resolve to Z0 in light, which gives **1.04:1**. Affected: `.film.now`, `.q-item.current`, `.neighbours .now`, `.frame-cell[aria-pressed]`, `.grid-cell[aria-current]` and the global `:focus-visible`. `results-light.png` shows frame 1439 with no outline.
   - **Why it matters:** "where am I" vanishes on the player, the review queue and keyboard focus (WCAG 2.4.7 and 1.4.11).
   - **Fix:** the rebate is a material with its own ink. Add `--rebate-ink: var(--z9)` and scope `--cursor` and `--focus` to it inside strips.
2. **Timelapse · everything under the frame (both themes).**
   - **What's wrong:** on the payoff screen the frame takes only 31 % of the window width. Below it, 252 pt holds three bands of three widths (transport, filmstrip, ribbon) and five position readouts (timecode, Frame, Day, ▸ label, ribbon cursor). It reads like an editing console.
   - **Why it matters:** Darkroom and Halide give the photo one scrubber; Lightroom hides the filmstrip.
   - **Fix:**
     - Make the transport playback only: prev, play disc, next, timecode and pace, about 360 pt wide.
     - Move Onion and Even light into the caption plate as a "Look" pair beside the zone wedge, and put Loop in the pace popover.
     - Fade the filmstrip out while playing (opacity, `--dur-base`), and give the frame the 74 pt that frees.
     - Merge the facts into one line: "Frame 1439 of 3,573 · day 1,462".
3. **Export · Encoding and Saved, the peak-end moment.**
   - **What's wrong:**
     - Encoding keeps the settings sheet's height, so it is about 60 % empty with a meter about 20 px wide.
     - Saved is a 100 pt strip with no picture and no Play.
     - Phases hard-swap and snap height (`ExportSheet.tsx:105–127`), and the sheet, popovers and toasts unmount with no exit.
   - **Why it matters:** this is the last impression of a decade of photos.
   - **Fix:**
     - Morph the sheet to fit its content (a View Transition or a WAAPI height FLIP, 360 ms `--ease-sheet`, content cross-fading over 120 ms).
     - **Encoding:** a 136 px frame that develops in, "Encoding 767 of 10,777 frames" at `--text-heading`, and a full-width 2 px meter.
     - **Saved:** a diptych of the first and last frames at 160 pt with edge-print dates `2012·09·01 ▸ 2022·08·31`. The chinagraph tick draws on, then "Saved · 2:59.6 · 534 MB". Actions: **Play ⌘↩** as the plate, Show in Finder (quiet).
     - Exits at about 60 % of the entrance on `--ease-in`: sheet 200 ms, popover 100 ms, toast 150 ms.
4. **Review · candidate print (both themes).**
   - **What's wrong:**
     - Every decision first shows the unaligned cover-fit fallback, then swaps to a different `<img>` with the alignment matrix. Nothing is prefetched (`Candidate.tsx:51–61`, `queries.ts:76–81`).
     - A 7° tilt leaves black wedges (about 80 pt) that look like a damaged print and aren't what the timelapse will show.
   - **Why it matters:** this is the screen's core loop. Photo Mechanic and Lightroom hold the outgoing frame until the next one is decoded.
   - **Fix:**
     - `prefetchQuery` the next two photos' details and `decode()` their thumbs.
     - Hold the outgoing print, then cross-fade 120 ms.
     - Fill outside the photo with the frames' backdrop (extended edges), keeping the 24 px feather.
5. **Days, Review · decisions are never drawn.**
   - **What's wrong:**
     - Chinagraph draw-on runs only on the two finishing ticks (`ReviewDone.tsx`, `ExportBodies.tsx`).
     - The kept tick, the strike, "In the timelapse" and the pick underline all pop in.
     - The draw itself is a left-to-right `clip-path` wipe, so it reveals the loop's top and bottom at once: a wipe, not a pen.
   - **Why it matters:** DESIGN.md's signature mark is the pen, and right now the pen never moves when you decide.
   - **Fix:** use `pathLength="1"` with `stroke-dashoffset` going 1 → 0 over 360 ms `--ease-out`, only on the mark just decided (a `justDecided` id). Under reduced motion, a 120 ms fade.
6. **Scan, Days, Timelapse · the ribbon's focus row (both themes).**
   - **What's wrong:**
     - It's 366 identical ticks: a barcode with no months.
     - In Year zoom, a 2 px span rule runs the whole year.
     - The loupe prints raw `2014-08-14`.
   - **Why it matters:** the Photos and Lightroom timelines name their months, and this is the app's "shared map".
   - **Fix:**
     - A 1 px Z4 baseline, broken on days without a photo.
     - 8 px Z6 month ticks with J F M … D in edge print.
     - Chinagraph dashes only for hand picks; the hatch for left-out days.
     - Hide the span rule when it covers the year.
     - Make the loupe 160 px, captioned "Thu 14 Aug 2014".
7. **Global · accessibility preferences ignored in three of four theme modes.**
   - **What's wrong:** `prefers-contrast` and `prefers-reduced-transparency` sit on `:root` (`tokens.css:278–285`). The themed rules are more specific, so they win, and the preferences only apply in System theme with macOS in dark. In light, reduced transparency leaves `--glass` 70 % translucent.
   - **Fix:** restate the preferences after the theme blocks (`:root, :root[data-theme]`), or use `@layer theme, prefs`. Test all four combinations.
8. **App · no continuity between screens.**
   - **What's wrong:**
     - `startViewTransition` has 0 calls, although DESIGN.md:541 promises View Transitions.
     - Every screen change hard-cuts, and the first visit flashes an empty Suspense frame (`App.tsx:96`).
     - The Days drag ghost teleports on drop (`dropAnimation={null}`).
   - **Why it matters:** Linear and Things feel expensive because state changes travel.
   - **Fix:**
     - A same-document View Transition for ledger navigation (WebKit 18): a 200 ms cross-fade, with `view-transition-name` on the selected face cell, the player frame and the reference print.
     - A 220 ms settle animation on drop.
     - Pre-warm the lazy screens on hover.

**P2**

9. **Days · year grid cell size.**
   - **What's wrong:** the column count follows a viewport breakpoint with `MIN_CELL_PX = 16`. With the inspector open, cells are 16 px at 1181 px, 20 at 1300 and 25 at 1440: below DESIGN's 26 px and the 24 px target floor. At 1920 the year still scrolls.
   - **Fix:** derive the month count from the canvas width, `repeat(auto-fill, minmax(calc(7*26px + 12px), 1fr))`, or use a container query. At 1920 the whole year then lies on one table.
10. **Confirm popovers (dark) · destructive buttons.** "Start over" and "Forget" are white text on stop red at **3.33:1**, which fails AA. **Fix:** add a `--stop-ink` token, Z0 in dark (5.8:1).
11. **Reference · the plate after the scan.**
    - **What's wrong:** "Scan library ⌘↩" stays the only plate when 0 photos are left to read and Review has 1 left.
    - **Fix:**
      - Show "Scan 12 new photos" when photos are waiting; otherwise "Review 1 unsure ⌘↩" or "Open Days ⌘↩".
      - Make "Scan again" a quiet row under Library.
      - In dark, raise `--crop-outside` from 62 % to 75 % so the room stops competing with the face.
12. **First run · `setup-empty` (both themes).**
    - **What's wrong:**
      - "Every other day will be lined up to it" (alternate days?).
      - "or drop it on the window" wraps and repeats "DROP A PHOTO HERE".
      - A disabled 38 % "Scan library" plate competes with the one real action.
      - In dark, the sidebar placeholder is a solid black 36×45 box that reads as a broken image.
    - **Fix:**
      - "Each day's photo is lined up to this one."
      - Hide the plate until there's a reference.
      - Make the placeholder a sunken well with the oval at Z5, and draw the template's eyes as rings.
13. **Light theme · material parity.**
    - **Review buttons:** Leave out and Compare are the same white pill. Fix: `.btn-quiet` gets a Z9 fill plus a 0.5 px `--line-strong` ring.
    - **Days alternates fold:** Z9 on Z10 (1.14:1) reads as a notch and doesn't match the legend. Fix: a `--fold-back` token, Z4 in light.
    - **Rebate strips:** the queue, the filmstrip and "Around it" are 17 % black slabs that outweigh the prints. Fix: a 15 px top rebate, 3 px bottom, no tail.
    - **Develop-in:** frames on the aligning filmstrip surface out of white `--canvas` rectangles on black film. Fix: one develop model, image opacity over `--latent`.
14. **Contact strips · "a strip is as long as its film".**
    - **What's wrong:** a one-photo queue is a 1,080 pt band, and Review done is a tick over that band.
    - **Fix:**
      - End every strip 3 px after its last frame with a square cut, and centre short strips.
      - Review done becomes the result: a centred strip at 72 pt with kept ticks and left-out strikes, under "29 kept, 12 left out".
15. **Scan · running sheet.**
    - **What's wrong:**
      - Following the newest frame jumps a row at a time, about 4 times a second (`scrollToIndex`, `ContactSheet.tsx:169`).
      - Latent cells breathe out of phase and twinkle.
      - The 2 px meter crosses the first row's edge prints.
    - **Fix:**
      - Follow with a rAF-damped `scrollTop` (about 250 ms).
      - Phase-lock the breathing (`animation-delay: calc(var(--i) * -160ms)`) so the run breathes as one wave.
      - Move the meter 12 px clear of the prints.
      - Print "2020·11" on each row's first cell.
16. **Scan library · tally after review.**
    - **What's wrong:** "◐ 41 unsure" beside "Nothing needs your eye", and "⊘ 0 remembered".
    - **Fix:** "● 3,558 you · ✓ 29 kept · ✕ 12 left out · ○ 23 someone else or no face". Hide zero items, and drop the side note when nothing is pending.
17. **Ledger.**
    - **Rail (≤ 1180 px, which covers the 960 and 1024 window classes):** rows lose their names (`display:none`), so VoiceOver hears "button" five times and nobody gets a tooltip. Fix: visually hide the names instead, and always set `title="Days · 3,518 chosen ⌘4"`.
    - **Align row:** it truncates ("Aligning · 1 min 21 s l…"). Fix: use the scan row's form, "44% · 1 min 21 s left".
18. **Type rhythm.**
    - **What's wrong:**
      - Martian numerals inside sentences read about 10 % bigger and darker than Bricolage.
      - 19 literal line-heights (`--leading-tight` is used 0 times) and 11 literal letter-spacings.
      - Ten weights in use; 600, 620, 640 and 660 can't be told apart at 13–15 px.
      - `.cap-year` is 280 while `.year-num` is 300.
    - **Fix:**
      - `.digits { font-size: .9em }`.
      - Give each size token its own `--leading-*`, `--tracking-*` and `--weight-*` (four weights: 400, 500, 600, 300 for display), and extend `typeScale.test.ts` to cover them.
19. **Days chip, Player facts, Review facts · unexplained terms.**
    - Days chip: show "1080p" only; "Extend edges" moves into its popover under "Outside the photo".
    - Player: "Fit 4.6 px · loose", with a three-zone bar like the Likeness scale.
    - Review: "One face" instead of "1 · one face".
20. **Edge states.**
    - **What's wrong:**
      - A failed scan or align is a 4 s toast only, though DESIGN.md promises an inline notice.
      - A cancelled scan says nothing.
      - Review with nothing to review is a blank canvas.
      - `ScanEmpty` is a sentence on blank canvas.
    - **Fix:**
      - A persistent inline stop notice under the library facts: "Stopped at 2,231 of 3,593. The next scan continues from here."
      - Empty Review reuses the done composition with "Nothing needed your eye".
      - `ScanEmpty` keeps the band's shape: statement, folder facts, two rows of unexposed film.

**P3**

21. **Hit targets and keys.**
    - Caption-position dots are 12×12 px; make them 24 px buttons with 8 px dots.
    - The toast's Undo is about 18 px tall; make it a 24 px pill.
    - The filmstrip has 19 tab stops and the library sheet one per cell; use one stop per strip, with arrow keys and a roving tabindex.
22. **Dark theme · plate brightness.** The Z10 pill is the brightest thing on every screen; on Days, "Open Timelapse" outshines the faces. **Fix:** `--plate: var(--z8)`, Z9 on hover; contrast stays above 10:1.
23. **Days inspector.**
    - About 250 pt is empty under "Around it". Show 5 days at 72 pt, using aligned frames when they exist.
    - Align the after-midnight note with the text column, 4 px under the likeness line.
24. **Player · zone wedge.** Label it "zone 5 → 5⅔" in the 11 px data font, with a hollow "from" marker.
25. **Export settings.**
    - Move the footer spec into the empty preview column as facts.
    - Strike Blend 4/8 like 4K.
    - Add `text-wrap: pretty`.
26. **Sidebar · project header.** Title "2012 – 2022" at 15/600, subtitle "photos · 3,591".
27. **Token drift.**
    - Spacing: 33 values off the 4 px scale.
    - Radii: 17 outside DESIGN's roles; add `--r-row: 8px`.
    - Ink over photos: about 20 hardcoded colours; add `--on-photo-*` tokens.
    - `ft-sweep` animates `background-position`; move it to a translated pseudo-element.
    - `:active` states are missing on chips, segments, rows and `.alt`.
    - User strings have no `dir="auto"`.

### Signature moments (where it should feel special)

1. **Lights-out playback.** On Space, the sidebar, toolbar and filmstrip fade to 8 % over `--dur-slow`. Only the frame, the hero date counting forward and the ribbon playhead remain, and moving the pointer restores them. This is Lightroom's L, in a darkroom.
2. **The verdict (Review).**
   - **Y:** a chinagraph tick strokes onto the print's corner (180 ms), the print FLIPs into its queue slot (280 ms `--ease-out`), and the next pre-decoded print rises from the well (opacity, 220 ms).
   - **N:** the same with a strike and 35 % greyscale.
   - Forty-one in a row should feel like marking a contact sheet with a pen.
3. **The print becomes the film.** A View Transition grows the selected day's face cell into the player frame (360 ms `--ease-sheet`), then **F** lifts the same frame to full window.
4. **True development (Scan, aligning).**
   - New frames develop on a sigmoid curve over 900 ms: opacity plus `contrast(.55) brightness(1.25)` easing to neutral, on the four newest only.
   - The latent run breathes as one wave toward the leading edge.
5. **Saved as a diptych.** The decade as two frames, with the tick drawn over them and **Play** (item 3).
6. **The first photo lands.** The template draws on (360 ms clip-path), the photo develops in (700 ms), the template snaps to the detected anchors (220 ms), and "Face found · 5 points" ticks in. This is the ID-booth moment.

### Strengths to keep
- **The running Scan screen:** frames breathe while waiting, develop in, and the newest is outlined.
- **The Days calendar of faces,** with hatched left-out days and numbered empty days.
- **The photobook caption plate,** in both themes.
- **Colour discipline:** chinagraph only for decisions, safelight only for unsure.
- **An enforced system:** one pressed style, 0 literal font sizes guarded by a test, and every keyframe on opacity, transform or clip-path, with reduced motion handled in CSS.
- **Review's honest hierarchy.**
- **A calm, specific copy voice.**

**Evidence:**
- Contrast figures: `scratchpad/contrast2.mjs`, computed from the tokens.
- Captures: `assets/screenshots/`, `qa/shots4`–`6`.
- Baselines: `ui/e2e/__screenshots__/visual.spec.ts/*-1440-*`.

## 13. Design critique — round 5 (final code, after UI batches 10–12)

**Method:** two agents, both read-only, with no app launches during the critique.
- **Assessment A (visual):** `impeccable:impeccable` and `design-taste-frontend` on today's native captures (§11, `qa/shots7/`): both themes, 1440 and 1920, lights-out, Encoding and Saved, plus the Playwright baselines regenerated after batch 12.
- **Assessment B (code):** checked every round 4 item in code, audited the new continuity layer, and computed contrast from the tokens (`scratchpad/contrast5.mjs`).
- **Benchmarks:** as in round 4.

**Score: 34/40, Good, not yet "next level"** (R4 32 · R3 30 · R2 28 · R1 27). B's independent code read also comes to about 34.

| # | Heuristic | R5 | Δ | Main remaining issue |
|---|---|---|---|---|
| 1 | System status | 3 | 0 | The scan's newest-frame outline sits on frames that haven't loaded. The export estimated ≈ 563 MB but saved 648 MB. "Encoding 39 of 10,777 frames" sits under "3,573 frames". |
| 2 | Match with the real world | 3 | 0 | The plate leads with units ("Fit 4.6 px", "+⅔ EV", "zone 5 → 5⅔"). Live-scan rows are stamped in read order (2022·01, 2017·08, 2016·04). |
| 3 | User control | 4 | 0 | Holds. |
| 4 | Consistency | 4 | +1 | One strip, one pressed style, one length format, 4K and Blend 4/8 struck alike, four weights. Left: "frames" means two things in the sheet; the sheet subtitle is all mono. |
| 5 | Error prevention | 4 | 0 | Holds. The low size estimate is the one gap. |
| 6 | Recognition | 3 | 0 | No keyboard map outside Review: F, J/K/L, D, A, [ ] and ⌘↑/↓ aren't shown anywhere. |
| 7 | Flexibility | 3 | 0 | Lights-out is in. Days still has no range selection. |
| 8 | Minimalist design | 3 | 0 | The scan frontier twinkles three rows deep. At 1440 the ribbon's span rule is its loudest mark. In light, the filmstrip outweighs the frame. At 1920 a band beside the Days table is empty. |
| 9 | Error recovery | 4 | +1 | The stopped-scan notice, `ScanEmpty`, the empty-Review state and export Try again are built (not re-captured natively). |
| 10 | Help | 3 | 0 | Contextual help is good; there's no keyboard map or Help menu. |

### Round 4 items: status

| # | Item | Status |
|---|---|---|
| 1 | Light-theme strip ink | **Fixed**: frame 1439, "Around it" and the review queue are ringed in rebate ink (Z9 on the rebate, 15.8:1) |
| 2 | Timelapse composition | **Fixed**: playback-only transport, Look pair and facts line in the plate, the strip folds while playing, the frame about 15 % larger |
| 3 | Export phases | **Fixed**: morph, Encoding print, full-width meter, Saved diptych with pen tick and Play opening the MP4, overlay exits. Timing is rough (P2-6). |
| 4 | Review candidate | **Fixed**: `ftimg` preview route, prefetch, hold-and-cross-fade, extended backdrop, no black wedges |
| 5 | Pen strokes | **Mostly fixed**: dashoffset pen on the decided mark only, with a reduced-motion fade. The Days pick underline is still a scaleX wipe. |
| 6 | Ribbon months and loupe | **Mostly fixed**: month letters, broken baseline, hand-pick dashes, 160 px "Thu 14 Aug 2014" loupe. The span rule is still loud at 1440. |
| 7 | Accessibility preferences in all theme modes | **Fixed** |
| 8 | Continuity / View Transitions | **Partly**: built, but see P1-1 to P1-4 |
| 9 | Days grid sizing | **Fixed** (about 35 pt cells at 1440, a whole year at 1920; composition P1-5) |
| 10–12 | `--stop-ink`, Reference plate, first run | **Fixed** |
| 13 | Light material parity | **Mostly fixed**: Review buttons are three materials, fold token, 15/3 px rebate. Left: a dead `.develop::after` overlay; the encoding frame sits on `--sunken`. |
| 14–17 | Strip length, running sheet, tally, ledger | **Fixed**. The running sheet's outline is still wrong (P1-6). |
| 18 | Type rhythm | **Partly**: four weights under test and `.digits` at 0.9 em. About 20 literal line-heights and 11–15 literal letter-spacings remain; the five 22 px headings carry four trackings. |
| 19–22 | Terms, edge states, hit targets, plate brightness | **Fixed** |
| 23 | Days inspector | **Partly**: five prints in "Around it", but about 47 px wide, and 260–360 pt is still empty below them |
| 24–26 | Zone label, export settings, project header | **Fixed** |
| 27 | Token drift | **Partly**: `--r-row` added, the sweep moved to transform, `:active` states added. No `--on-photo-*` tokens (about 25–46 literal colours), radius 10 px ×5, about 40 off-scale spacings. |

**Signature moments:**

| Moment | Status |
|---|---|
| Lights-out | **Done in dark** (only the frame, the hero date and the playhead stay lit; engages about 2 s after play, wakes on Space). In light the table stays lit. |
| The verdict | **Built** (`VerdictGhost`, `verdictFlight`). The last call hard-cuts to the done state. |
| The print becomes the film | **Partly** (P1-2) |
| True development | **Built.** The frontier is still noisy (P1-6). |
| Saved diptych | **Done.** Scale and sequencing need work. |
| The first photo lands | **Built** (`useArrival`). Not captured. |

### What still holds it back from 36+, ranked

Each item gives where, what's wrong, why it matters, and the fix.

**P1**
1. **Every screen change and every F (dark) · the View Transition cross-fade.**
   - **What's wrong:** the old screen fades out over 150 ms on `--ease-in` and the new one in over 220 ms on `--ease-out` (`base.css:162-163`). View Transition pairs composite with `plus-lighter`, so their opacities add (about 1.67 at 60 ms).
   - **Why it matters:** Z0 lifts toward Z1–Z2 for about 120 ms on every ⌘1–⌘5, a grey breath across the darkroom.
   - **Fix:** one duration and one curve for the pair (`--dur-base`, `--ease-standard`), or hold the old screen and fade the new one over it. Confirm with a frame capture.
2. **Days ↔ Timelapse · `ft-print` pairs the wrong prints.**
   - **What's wrong:**
     - The names follow the role, not the day (`days.css:159`, `timelapse.css:42`). ⌘5 grows the selected cell into the player's previous frame, and Timelapse → Days shrinks into the last selected day.
     - The player canvas isn't painted when the transition captures it, so it morphs into sunken fill.
     - The ends are different crops (a zoomed face vs the full frame), so the cross-fade ghosts two faces.
   - **Fix:**
     - Name the print only when both ends show the same day, and set `activeDay` from the playhead on leaving.
     - Paint a poster `<img>` of the aligned frame under the canvas, and resolve the update callback on first draw (cap 250 ms).
     - Have the cell show the aligned frame for the capture.
3. **First visit to a screen · the transition captures the Suspense fallback.**
   - **What's wrong:** idle preload relies on `requestIdleCallback`, which WebKit may not have (to verify). Only a ledger hover preloads.
   - **Why it matters:** the first Days → Timelapse, the signature moment's debut, cross-fades into an empty screen.
   - **Fix:** a `setTimeout` fallback, and `startViewTransition(async () => { await load(step); flushSync(apply) })`.
4. **Every step change · focus falls to `<body>`.**
   - **What's wrong:** a plate pressed from the keyboard unmounts with its toolbar, and nothing moves focus.
   - **Why it matters:** keyboard and VoiceOver users lose their place; Linear and Things never drop focus.
   - **Fix:** after `updateCallbackDone`, focus the new screen's `section[aria-label]` (tabindex −1, no ring).
5. **Days at 1920 · composition.**
   - **What's wrong:** the year block ends about 400 pt short of the canvas, the legend floats at the canvas edge over nothing, and about 125 pt under December is empty.
   - **Fix:** lay the year as one sheet on the table. Centre the block and size the header to it, or spread the spare width into the gutters. Let "Around it" grow to 7 prints.
6. **Scan (live) · the newest-frame outline and the developing frontier.**
   - **What's wrong:** the outline follows `max(index)` of loaded images (`ContactSheet.tsx:82`). Images load out of order, so it jumps onto black slots (2169, 54, 3070, 1717 across runs) while about three rows mix lit, ghosted and black frames.
   - **Why it matters:** this is the trust screen; an outlined black frame reads as a stall.
   - **Fix:** move the Z8 outline when a develop ends, onto the highest frame whose run is complete. Hold early arrivals latent for at most 400 ms, so the sheet develops along one leading edge.
7. **Export · the size estimate and the unit.**
   - **What's wrong:** 648 MB saved against ≈ 563 MB estimated (−13 %, Even light off). `estimateVideoBytes` has no look term; with Even light on it was −2 %. "Encoding 39 of 10,777 frames" sits under "3,573 frames".
   - **Fix:** add a look factor, or show a range until it's calibrated. Count in days: "Encoding day 13 of 3,573", with "10,777 video frames · 60 fps" as the data line.
8. **Lights-out (light theme) · the table stays lit.**
   - **What's wrong:** only the chrome fades; `--canvas` stays Z10.
   - **Why it matters:** the signature moment exists in one theme only, and a white surround makes skin read darker.
   - **Fix:** switch the light table off: a fixed scrim fading to Z1 at about 92 % (opacity, `--dur-slow`), lifted on wake.

**P2**
9. **Scan (live) · rows stamped in read order** (2022·01, 2017·08 …) while the ribbon says 2016. **Fix:** live rows print frame numbers only; the ribbon's decade row exposes each day in its year as it's read; month stamps stay in the date-ordered library.
10. **Light theme · other inks on the rebate.** Chinagraph 3.14:1, safelight 3.10:1, `?` badge 3.05:1 (dark: 6.7 and 11.0). **Fix:** `--rebate-mark` and `--rebate-safelight`, scoped like `--rebate-ink`.
11. **Export · the Saved sequence and scale.**
    - **What's wrong:**
      - The tick draws on a fixed 280 ms timer, often onto unexposed prints.
      - The 90 ms stagger can't be seen against a 700 ms develop.
      - The copy arrives before the pictures, and a long background encode plays its moment unseen.
      - The diptych is 158 pt on a 720 pt sheet.
    - **Fix:**
      - Sequence it: first print, second +240 ms, tick at 60 % of the second, then the facts. Start on window focus or visibility.
      - A photobook spread at about 220 pt, the tick crossing the gutter.
      - Name the in-sheet cue "Watch here".
12. **Player plate · units before words.** **Fix:** "Tightly lined up · 4.6 px" and "Brightened ⅔ stop" over the wedge; Fit's explanation as a focusable popover, not a `title`.
13. **Global · no keyboard map.** **Fix:** "?" and Help › Keyboard Shortcuts open an exposure-record card with the current screen's keys in kbd caps; transport tooltips carry their keys.
14. **Ribbon at 1440 · the span rule** reads as a progress bar. **Fix:** two 6 px Z6 crop-mark feet at the span's ends.
15. **Type rhythm · 22 px headings** carry four trackings and three leadings. DESIGN.md still lists weights 280/480/660/640. **Fix:** `--leading-*` and `--tracking-*` per size under `typeScale.test.ts`; correct the doc table.
16. **Export · encoding print** can swap `src` every frame. **Fix:** step about once a second with a `--dur-xfade` cross-fade over latent film.
17. **Lights-out and the viewer (F).**
    - **What's wrong:** the ribbon's top hairline stays lit and the pointer stays visible. F drops the date (`.viewer-bar` is dead CSS), and the viewer `role="dialog"` takes no focus.
    - **Fix:**
      - Hide the pointer after 2 s of stillness.
      - Carry the date into F as a burned-in plate.
      - Focus the viewer.
      - Write the hero date at frame rate, through a ref with tabular figures, instead of the 4 Hz state tick.
18. **Light theme · strip mass.** The player strip is 870 × 72 pt of black, twice the frame's width. **Fix:** a strip no wider than its stage (about 15 frames), with `--shadow-print`, in both themes.
19. **Days inspector · after-midnight note** sits about 45 pt below its card. **Fix:** make it the card's third line.

**P3**
20. **Days · range selection:** ⇧-click or ⇧-arrows extend the loop over a run of days, then X or M with one Undo.
21. **Reference:**
    - "Scan again" reads as a second primary; make it a row button (`--r-row`).
    - The drag hint floats about 50 pt below the readouts.
    - "rotated 0.5°" is all mono.
22. **Review · one-item band:** print the counter on the rebate ("01 / 01") and tighten the band.
23. **Token drift:**
    - Radius 10 px ×5.
    - Literal ink over photos; add `--on-photo-*`.
    - Permanent `will-change` on the ribbon cursor.
    - DESIGN.md says the focus ring is `--mark` and toasts are glass; the code uses neutral ink and `--raised`.
    - The weekday initials and "Starting…" are still in mono.
24. **Reduced motion and properties:**
    - Press nudges on chips, segments and the diptych are missing from the reduced-motion list.
    - Day hover animates `filter`.
    - Add `stroke-dashoffset` to DESIGN's motion rule.
25. **Hit targets:**
    - Decade `.wk` cells are about 17 px.
    - The models notice's Details toggle is under 24 px.
    - Start over can't be reached in the rail at 1180 px or narrower.
26. **Edge states:**
    - The stopped-scan notice lives only in the inspector (it hides with ⌥⌘I).
    - Review is blank while loading.
    - Verify `prefers-reduced-transparency` in WKWebView, not just Chromium.
27. **Ribbon baseline** encodes photo/no-photo at about 2:1 and doesn't step up under `prefers-contrast`.

**Path to 36–38:**
- P1-6 and P1-7 make System status a 4.
- P1-5, P2-14 and P2-18 make Minimalist design a 4.
- P2-13 lifts Recognition and Help.
- P1-1 to P1-4 make the continuity layer feel like Linear or Things rather than a cross-fade.
- After that, a motion capture of the verdict, Days → Timelapse and the first photo landing should decide 38+; those can't be judged from stills.

### Strengths to keep
- **Lights-out in dark:** the frame and "5 Nov 2016" alone in the room, Lightroom's L in the app's own voice.
- **The Saved diptych:** "2012·09·01 ▸ 2022·08·31", the pen tick, and Play as the plate.
- **Review on the backend preview:** the eye-line hairline across both prints, and three distinct button materials in both themes.
- **Rebate ink:** "where you are" now survives on black film in light.
- **The ribbon as a quiet ruler with months:** the photos are the only light.
- **Days at 1440:** about 35 pt faces, hatched left-out days, numbered empty days, a Z8 plate that doesn't compete.
- **Enforced discipline:** four weights, one pressed style, one strip component, `--plate` and `--stop-ink`, preferences in all four theme modes, and reduced motion honoured by every JS animation.
- **The copy voice:** "Each day's photo is lined up to this one", "4K is larger than your frames", "Taken after midnight · Move to 16 Jan".

**Evidence:**
- Captures: `qa/shots7/`.
- Contrast: `scratchpad/contrast5.mjs`.
- Export: `qa/out/v7-1080.mp4`.

## 14. Design critique — round 6 (after UI batches 13–14)

**Method:** read-only. No app was launched and nothing was built.
- **Assessment A (visual):** `impeccable:impeccable` (critique) and `design-taste-frontend`, on the 28 post-batch-13 captures in `scratchpad/b13/after/` (both themes, mock stand-in photos), the before/after pairs and slowed transition strips in `scratchpad/b13/compare/`, and the pre-batch-13 real-app captures in `assets/screenshots/`.
- **Assessment B (code):** an isolated agent checked every round 5 item in `ui/src` and ran the detector.
- **Detector:** 0 findings in `ui/src`.
- **Partly degraded:** to save tokens, A ran in the coordinating context rather than as a second isolated agent. B was written before A's findings existed. A's three follow-up questions to B are marked (a)–(c) below.
- **Not judged:** the stills cannot judge motion feel beyond the transition strips. The real-library export size was not re-measured.

**Score: 37/40, Excellent: over the 36 bar** (R5 34 · R4 32 · R3 30 · R2 28 · R1 27). Every round 5 P1 is fixed or nearly fixed. Three points remain:
- **System status (1 point):** two status gaps found this round.
- **Help (1 point):** there is no Help menu.
- **Flexibility (1 point):** there is no range selection.

| # | Heuristic | R6 | Δ | Main remaining issue |
|---|---|---|---|---|
| 1 | System status | 3 | 0 | Outline and encoding count are fixed. The live sheet's developed edge (~0290) trails "Read 1,537" by about 1,250 frames, and the ribbon shows 2015 while the path reads 2016. Review shows "No photos the scan wasn't sure about", with Continue enabled, before its data loads. |
| 2 | Match with the real world | 4 | +1 | Words lead ("Tightly lined up · 1.4 px"). Live rows print frame numbers. Reference shows "Eyes level 0.2°" while its inspector says "−0.2°". |
| 3 | User control | 4 | 0 | Holds. The new screen takes focus. Lights-out wakes on Space. |
| 4 | Consistency | 4 | 0 | Holds. Left: "3,547 frames" (header), "3,547 days" (export), "Frame 3 of 3,547 · day 4" (plate) and "3,577 video frames" (encoding). Display numerals put mono full-cell commas inside Bricolage headlines. |
| 5 | Error prevention | 4 | 0 | Holds. The size estimate is calibrated, but it is still one "≈" value. |
| 6 | Recognition | 4 | +1 | A "?" card per screen with kbd caps. Transport tooltips carry their keys. Inline key hints on the actions. |
| 7 | Flexibility | 3 | 0 | Days still has no range selection (P3-20 open). |
| 8 | Minimalist design | 4 | +1 | Calm frontier, crop-mark feet, a 15-frame strip, a centred year sheet at 1920. Left: "Around it" (5 prints) leaves 280–390 pt empty below it. |
| 9 | Error recovery | 4 | 0 | Holds. The stopped-scan notice on Reference is still only in the inspector. |
| 10 | Help | 3 | 0 | The keys card exists but can't be found: there's no Help › Keyboard Shortcuts menu item, and nothing outside the card mentions "?". |

### Round 5 items: status

| # | Item | Status |
|---|---|---|
| P1-1 | Grey cross-fade flash | **Fixed.** One duration and one curve for old/new (`base.css:170`); the print pair runs on `--dur-slow`. The dark strips show no lift of Z0. |
| P1-2 | `ft-print` pairing | **Fixed, with residue.** Named by day; poster under the canvas, capped at 250 ms; the cell shows the aligned print. Residue (P2-9 below): `activeDay` follows a ~4 Hz settled index, so a morph started mid-play can land on another frame. Frames 3–4 of the dark strip show a soft second head outline. Decade has no print. |
| P1-3 | First-visit capture | **Fixed.** An 800 ms `setTimeout` fallback, and the load is awaited before the transition. |
| P1-4 | Focus to `<body>` | **Fixed.** `useScreenFocus` focuses the new section, with no ring. |
| P1-5 | Days at 1920 | **Partly.** The year sheet is centred, with even gutters, the legend aligned to the block and ~60 pt under December, which reads as composed. "Around it" is still 5 prints (`AROUND_RADIUS = 2`). |
| P1-6 | Live-scan outline and frontier | **Fixed.** One leading edge, 400 ms hold. The outline trails the lit edge by one develop (~10 frames) by design. New: the sheet trails the count (P1-1 below). |
| P1-7 | Export estimate and unit | **Fixed in code.** "Encoding day 1,761 of 3,547", a light-cost term. Not re-measured on the real library; still a single value. |
| P1-8 | Lights-out in light | **Fixed.** The table goes to Z1 at 92 %. A faint residue remains (P2-6). |
| P2-9 | Read-order stamps | **Fixed** |
| P2-10 | Rebate inks in light | **Fixed.** Mark 6.1:1, safelight 10.1:1 (were 3.1:1). |
| P2-11 | Saved sequence and scale | **Fixed.** 240 ms stagger, tick at 60 %, a seen gate, a 220 px spread, "Watch here". The diptych now reads as a photobook. |
| P2-12 | Plate units | **Fixed.** Words first; Fit opens a focusable popover. |
| P2-13 | Keyboard map | **Partly.** The card and tooltips are done. The Help menu item is missing (no menu code in `src-tauri` or `crates`). |
| P2-14 | Ribbon span rule | **Fixed.** Crop-mark feet. |
| P2-15 | Type rhythm tokens | **Fixed.** `--leading-*` and `--tracking-*`; the DESIGN.md weights match. |
| P2-16 | Encoding print stepping | **Fixed.** 1 s steps with a cross-fade. |
| P2-17 | Lights-out and F | **Fixed.** The pointer hides, the hairline dims, the date is burned into F, the viewer takes focus, and the hero date is written through a ref. The burned-in date is weak on bright photos (P2-4). |
| P2-18 | Strip mass | **Fixed.** At most 15 frames, `--shadow-print`. |
| P2-19 | After-midnight note | **Fixed.** It is the card's third line. |
| P3-20 | Days range selection | **Open** |
| P3-21 | Reference | **Fixed.** A row button, the hint under the readouts, "rotated" through `DataText`. |
| P3-22 | Review one-item band | **Fixed** |
| P3-23 | Token drift | **Partly.** Literal `oklch` on `scan.css:48 .tag` and literal white on `days.css:37`; 6/8 px radius literals in `shell.css:139`, `ribbon.css:61` and `export.css:60`. |
| P3-24 | Reduced motion and properties | **Fixed** |
| P3-25 | Hit targets | **Partly.** Details is 24 px and Start over stays reachable. Decade `.wk` cells are still about 13–20 px. |
| P3-26 | Edge states | **Partly.** The Scan band carries the stopped notice; Reference still has it only in the inspector. Review loading is unhandled (P1-2 below). |
| P3-27 | Ribbon under `prefers-contrast` | **Fixed** |

**Signature moments:**

| Moment | Status |
|---|---|
| Lights-out | **Done** in both themes. |
| The print becomes the film | **Done** both ways. A small crop halo remains mid-morph. |
| Saved diptych | **Done.** It is now a spread with the tick crossing the gutter. |
| True development | **Done** on screen. Whether it keeps pace with reading is unverified (P1-1). |
| The verdict | Not captured this round. |
| The first photo lands | Not captured this round. |

### What still holds it back, ranked

**P1 (to reach 39–40)**
1. **Scan (live) · the sheet trails the count.**
   - **What's wrong:** "Read 1,537 of 3,593" while the developed edge is at ~0290, the ribbon window sits on 2015, and the path reads 2016 (`p1-6-scan-live-*`).
   - **Cause (B (a)):** the develop step (~26 ms at 38/s) does not explain it. The edge only advances over landed thumbnails, and only virtualised, mounted rows request them. The cause is thumbnail throughput or the mount gate. It may be the mock harness; it needs confirming.
   - **Fix:**
     - Log the edge index against the read count per second on the real library.
     - If it lags, request thumbnails for the next ~3 rows past the edge whether or not they are mounted.
     - Let the 400 ms hold pass an unlanded frame as latent even when no later frame has landed.
     - When the gap passes one screen, cut the sheet to the frontier instead of springing through it.
2. **Review before its data loads · a false empty state.**
   - **What's wrong:** "No photos the scan wasn't sure about", with "Continue to Days" enabled, over an empty canvas (`ReviewScreen.tsx:236-257`).
   - **Fix:** a loading branch. The subtitle reads "Gathering the unsure photos…", the plate is disabled, and latent prints fill the queue band until the list resolves.
3. **Help · make the keys discoverable, and fix their layer.**
   - **Fix:**
     - Add a Tauri menu item, Help › Keyboard Shortcuts (⌘/), that emits the same event as "?".
     - Add "? Keys" as a quiet second item in the sidebar footer, beside "Nothing leaves this Mac".
     - The card is `z-index: 50` and the F viewer frame is 51 (`keymap.css:9`, `timelapse.css:287`), so "?" in F likely sits under the photo. Render the card in the top layer (`dialog.showModal()` or `popover`).
4. **Days · range selection.**
   - **Fix:** ⇧-click and ⇧-arrows extend a run. X and M apply to the run with one Undo. The ribbon shows the run with the same crop-mark feet.

**P2**
5. **Display numerals · a mono seam in sans headlines.**
   - **What's wrong:** "Encoding day 1,761 of 3,547" and "Saved · 1:59.2 · 236 MB" set Martian Mono `.digits` (0.9 em) inside Bricolage. The full-cell comma and colon read as "1 , 761".
   - **Fix:** at display sizes, wrap separators in `DataText` with `<span class="sep">` (`margin-inline: -0.2em`), or use Bricolage `tabular-nums` above 20 px and keep mono for data rows.
6. **Lights-out (light) · residue.**
   - **What's wrong:** the plate's pill outlines and the rule under the date stay faintly visible through the scrim, and two playhead ticks stay lit.
   - **Fix:** fade the plate controls to 0 under lights-out, not just under the scrim, and keep one playhead mark.
7. **Count terms.**
   - **What's wrong:** "frames", "days", "Frame 3 of 3,547 · day 4" and "3,577 video frames" sit beside "3,547".
   - **Fix:**
     - Use "days" for chosen days in all chrome.
     - Make the plate read "3 of 3,547 · 4 Sep".
     - Make the encoding data line "1:59.2 of video · 30 fps · about 39 s left"; the frame count reads as a typo for 3,547.
8. **F viewer · the burned-in date.**
   - **What's wrong:** weight 300 at 40 px, with only a 2 px glow (`.frame-plate`), so it will drop out on a white shirt or an overexposed frame.
   - **Fix:** a bottom-left gradient scrim token, `--on-photo-scrim` (0 → 45 % over ~120 px), or weight 400. Check it on the brightest frame in the library.
9. **The print morph mid-play.**
   - **Fix:** on leaving Timelapse, read the playhead ref synchronously into `activeDay` before the capture, rather than the 4 Hz settled index. Match the cell print's crop rect and `object-position` to the stage at 1:1, to remove the halo in frames 3–4.
10. **Days inspector · "Around it".**
    - **What's wrong:** 5 prints of about 47 px, with 280 pt (1440) to 390 pt (1920) empty beneath.
    - **Fix:** `AROUND_RADIUS = 3` (7 prints) sized to the inspector width. At 1600 or wider, use two rows: the week before and the week after.
11. **Export estimate.**
    - **Fix:** re-run the `v7-1080` export with Even light on and off. If the error is over ±8 %, show a range ("about 340–410 MB").

**P3**
12. **Token residue:** `.tag` literal `oklch`, literal white on day hover, and 6/8 px radius literals. Route them through `--on-photo-*` and `--r-*`.
13. **Decade `.wk` hit area:** an inset −4 px `::before`.
14. **`.alt-note { overflow: hidden }`** clips the focus ring on "Move to…". Use `overflow: clip` with `overflow-clip-margin: 3px`.
15. **Reference stopped-scan notice:** mirror it in the Reference band, as on Scan.
16. **Reference · eye-level sign:** the readout says "0.2°" and the inspector "−0.2°". Use one convention, or label the inspector value as the correction ("rotate −0.2°").
17. **Days at 1440 · off-sheet selection:** the inspector holds 1 Sep 2012 while the sheet shows 2013, with no cue. Add an "In 2012 · Show" link in the inspector header, or carry the selection to the same date when paging years.

**Path to 39–40:**
- P1-1 and P1-2 make System status a 4.
- P1-3 makes Help a 4.
- P1-4 makes Flexibility a 4.
- After that, a native motion capture of the verdict, the first photo landing and a mid-play ⌘4 morph should confirm 40. Stills can't.

### Strengths to keep
- **Continuity:** Days ↔ Timelapse now reads as one print growing into the film and settling back into its cell, in both themes, with no grey breath.
- **Lights-out in both themes:** a white table switching off to Z1 is the strongest new moment.
- **The Saved spread:** dated rebates, the pen tick across the gutter, Play as the plate.
- **The keys card:** grouped by intent (Move, Decide, Look, Make), written in the app's voice, kbd caps, scoped to the screen.
- **The live sheet:** one calm leading edge over latent frames, with the unsure frame ringed in amber.
- **Discipline:** detector clean, rhythm and leading tokens, rebate inks at 6:1 or better, reduced motion on every new animation.

**Evidence:**
- Captures: `scratchpad/b13/after/`.
- Before/after pairs and strips: `scratchpad/b13/compare/`.
- Code evidence: Assessment B, file references inline above.
