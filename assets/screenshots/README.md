# Screenshot shot list

The repository README shows the PNGs in this folder. The file names predate the Tauri rewrite and are kept so links stay stable; each one now shows the screen named below.

| File | Screen (ledger row) | What to show |
|---|---|---|
| `setup.png` | **Reference** (⌘1) | Reference photo loaded, crop and alignment template visible, an aspect preset other than Free (4:5 or 3:4), the library folder chosen in the inspector. |
| `scanning.png` | **Scan** (⌘2) | A scan in progress: the status sentence ("Read 2,231 of 3,593 photos"), the tally line, throughput and time left, and the live contact sheet filling in. |
| `daily-selection.png` | **Days** (⌘4) | Year view with a selected day, the day inspector showing two or three alternates, ideally one moved or excluded day. |
| `results.png` | **Timelapse** (⌘5) | Player paused on a frame with the photobook caption, filmstrip and decade ribbon. Pick a frame that shows how much time has passed. |
| `video-export.png` | **Export** sheet (`E` in Timelapse) | Video format, a non-default pace (for example 20 days/s), a crossfade, the date caption on; idle, or mid-encode with the meter partly filled. |
| `review.png` | **Review** (⌘3) | The keyboard review of an unsure match next to the reference, with the likeness scale. |
| `results-light.png` | **Timelapse** (⌘5), light theme | The same player as `results.png` in the light theme (the only light shot; the rest of the set is dark). |

## Option A: the real app (preferred for the README)

1. Build and run the app with throwaway app data, so the capture session never touches your own:

   ```bash
   npm --prefix ui run app:build -- --debug --no-bundle
   FT_DATA_DIR="$(mktemp -d)" \
   FT_DEV_AUTOLOAD="reference=/path/to/reference.jpg;folder=/path/to/photos" \
     target/debug/facetimelapse
   ```

   `FT_DEV_AUTOLOAD` (debug builds only) preloads the reference and folder; without it, pick them in the app.
2. Keep the window at its default 1440×900, choose the theme with the Appearance button at the bottom of the sidebar, and walk through scan → review → days → align → export.
3. Capture only the window, without its shadow: `screencapture -o -iW assets/screenshots/setup.png`, then click the window. (Or ⌘⇧4, Space, and Option-click the window.)
4. Optionally shrink the files losslessly (for example with `oxipng -o 4`, `brew install oxipng`) and keep each under about 1 MB.

## Option B: synthetic data from the Playwright visual specs

The UI's visual regression suite renders every screen against the in-memory fake backend with synthetic stand-in portraits (no real faces) at 1024×768, 1440×900 and 1920×1080, in light and dark. Its baselines are ready-made screenshots:

```bash
cd ui
npx playwright install chromium                                     # once
npx playwright test --project=chromium --grep '(light|dark) 1440×900'   # make sure the baselines are current
cp e2e/__screenshots__/visual.spec.ts/setup-1440-dark-darwin.png            ../assets/screenshots/setup.png
cp e2e/__screenshots__/visual.spec.ts/days-1440-dark-darwin.png             ../assets/screenshots/daily-selection.png
cp e2e/__screenshots__/visual.spec.ts/timelapse-player-1440-dark-darwin.png ../assets/screenshots/results.png
cp e2e/__screenshots__/visual.spec.ts/export-1440-dark-darwin.png           ../assets/screenshots/video-export.png
```

A live scan is not a stable baseline, so it is captured on request: `FT_SHOOT_STATES=1 npx playwright test --project=chromium --grep 'job states'` writes `e2e/__screenshots__/states/scan-live-1440-<theme>.png` (and the aligning state), which can become `scanning.png`. Other baselines: `review-*`, `scan-library-*`, `timelapse-onion-*`, `timelapse-sheet-*`, `setup-empty-*`.

These images show the UI faithfully but not real photos, so prefer Option A for the README once you have photos you can publish.

## Rules

- **Privacy:** every face in a published screenshot must be yours, someone who agreed to appear in a public open-source repository, or a model-released stock image. Never capture someone else's photo library, and never commit the photos themselves. This folder holds screenshots only.
- **Size:** native Retina captures of a 1440×900 window are fine; the README scales them down.
- **Format:** PNG for UI. Use one theme across the set (dark matches the social preview); `results-light.png` is the one deliberate light-theme shot.
- **Clean state:** no DevTools, no debug overlays, no personal paths visible in the caption line or inspector, if possible.

When the files are in place, commit them together, for example with `docs: update screenshots for FaceTimelapse 2`. The README already points at these paths.
