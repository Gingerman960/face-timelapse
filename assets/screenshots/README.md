# Screenshot shot list

Drop PNG/JPG screenshots here using the filenames below. `README.md` already references them — once the files exist the repo's README gallery fills in automatically.

## Required

| Filename | Which view | What to capture |
|---|---|---|
| `setup.png` | SetupView (step 1) | Reference photo loaded with crop box visible, aspect ratio buttons showing, source folder chosen. Best with a real portrait. |
| `scanning.png` | ScanningView (step 2) | Mid-scan with progress bar partway, confirmed/uncertain counters populated, a few thumbnails in the grid. |
| `daily-selection.png` | DailySelectionView (step 4) | Calendar sidebar with several active days, one day expanded with 2–3 photos in the main panel, one marked Selected. |
| `results.png` | ResultsView (step 6) | Grid of aligned photos, ~8–20 visible. This is the money shot — pick a timelapse with visible progression. |
| `video-export.png` | VideoExportModal (from Results → Create Video) | Modal open over the results grid. Both sliders visible with non-default values (e.g., 10 FPS / 30s). Either idle-before-encode **or** mid-encode with the progress bar partially filled — mid-encode is preferred because it shows the live progress UI. |

## Optional

| Filename | When |
|---|---|
| `confirm.png` | ConfirmView with one uncertain photo and the score percentage visible |

## Capture tips

- **Size**: native resolution, at least 1440×900. README displays will downscale via markdown width hints.
- **Format**: PNG preferred for UI. JPG is fine if you need file size < 300KB.
- **Privacy**: make sure any face visible is yours, a willing friend with consent for public OSS repo, or a model-release stock image. See discussion in CONTRIBUTING.md about biometric data.
- **OS chrome**: trim the macOS/Windows window title bar if you want a cleaner look, or leave it — both are common.
- **No dev tools**: close DevTools before capturing. `Cmd+Alt+I` to toggle.

## Once you've added them

Run `git add assets/screenshots/ && git commit -m "docs: add UI screenshots"`. No code changes needed — the README already points at these paths.
