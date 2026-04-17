# face-timelapse

[![CI](https://github.com/Gingerman960/face-timelapse/actions/workflows/ci.yml/badge.svg)](https://github.com/Gingerman960/face-timelapse/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

A cross-platform desktop app that aligns a face across many photos and exports the result as a smooth timelapse video. Built with Electron + React + face-api.js.

> Pick a reference photo, point it at a folder of photos, and the app finds every photo of that person, aligns their face to the reference position, and strings the result into an MP4.

## Features

- **Reference-based matching** — geometric face embeddings (45 features from 68 landmarks) find the same person across thousands of photos, independent of lighting or color.
- **Procrustes alignment** — translates, rotates, and scales each face so that eyes, nose, and mouth land in the same pixel positions as the reference.
- **Daily deduplication** — when you have multiple photos per day, the app groups them by date and picks the best match by default (editable).
- **Parallel workers** — detection, embedding, and alignment run on a worker per CPU core.
- **Local-first** — nothing leaves your machine. No accounts, no API calls.
- **Video export** — configurable fps and total duration via bundled ffmpeg.

## Screenshots

Add screenshots to `assets/` and link them here once the UI is captured:

```
assets/
├── screenshot-setup.png
├── screenshot-scan.png
└── screenshot-result.gif
```

## Install

Requires Node.js 18+ and platform build tools (Xcode CLT on macOS, MSVC Build Tools on Windows, `build-essential` on Linux) for the native dependencies (`canvas`, `sharp`).

```bash
git clone https://github.com/Gingerman960/face-timelapse.git
cd face-timelapse
npm install
npm run download-models
```

`npm install` triggers `electron-rebuild` for `canvas` and `sharp` so they load in the Electron runtime. `npm run download-models` copies the face-api weights out of `node_modules/@vladmandic/face-api/model/` into `./models/` (they're bundled with the package — no network fetch).

## Run in development

```bash
npm run dev
```

Vite serves the renderer on `http://localhost:5173` and Electron opens a window pointing at it. DevTools open automatically.

## Build distributables

```bash
npm run build         # current platform
npm run build:mac     # macOS DMG (x64 + arm64)
npm run build:win     # Windows NSIS installer (x64)
```

Output lands in `release/`. Builds are unsigned by default — see [docs/BUILD.md](./docs/BUILD.md) for Apple Developer ID notarization, Windows Authenticode, and distribution notes.

## How alignment works

The app ports the core algorithm from a prior Swift implementation:

1. **Detect** the largest face in the reference image with `ssdMobilenetv1` (WASM-backed) and extract 68 landmarks with `faceLandmark68Net`.
2. **Extract 5 alignment anchors** from the 68-point array: left eye center, right eye center, nose tip, mouth left corner, mouth right corner.
3. **Generate a 45-feature geometric embedding** describing person-specific proportions (inter-pupillary distance normalized, eyebrow/nose/mouth/jaw ratios). Because it's pure geometry, it's invariant to lighting and color.
4. **Scan the folder** in parallel worker threads. For each photo: detect the biggest face, embed it, compare to the reference via Gaussian-distance similarity, and categorize as confirmed / uncertain / rejected.
5. **Compute the Procrustes transform** (translation + rotation + uniform scale) that maps each photo's 5 anchors onto the reference's, and render the aligned output at the reference's resolution.
6. **Export** either as images (`YYYYMMDD.png` naming with collision suffixes) or as an MP4 via `ffmpeg`.

## Project structure

```
electron/              # Main process
  main.js              # BrowserWindow + IPC handlers
  preload.js           # contextBridge surface
  services/
    faceDetection.js   # face-api.js wrapper
    faceEmbedding.js   # geometric 45-feature embedding + similarity
    alignment.js       # Procrustes transform + image warp
    photoScanner.js    # folder walk + worker pool
    scanWorker.js      # per-photo detect + embed (worker thread)
    alignmentWorker.js # per-photo align + write (worker thread)
    exportService.js   # copy aligned PNGs to destination folder
    videoExport.js     # ffmpeg concat demuxer → MP4

renderer/              # React + Zustand UI
  src/
    App.jsx            # Top-level step routing
    store/             # Zustand state (mirrors old Swift ViewModel)
    views/             # One per wizard step (Setup → Results)
    components/        # Shared UI (VideoExportModal)

scripts/
  download-models.js   # Copies face-api weights into ./models/

tests/                 # Vitest — pure-logic smoke tests
```

## Testing

```bash
npm test
```

Current coverage is intentionally minimal (Stage A): pure-logic modules only. Native-dependent modules (face detection, workers, ffmpeg) are not unit-tested.

## Roadmap

Things not in this release that are worth doing:

- Playwright E2E for the scan → align → export happy path
- GitHub Actions CI (lint + test on Linux, test on macOS/Windows)
- Integration tests that actually load the models and run detection
- Code-signing & notarization docs for macOS/Windows distribution
- Incremental/resumable scans for large libraries
- GPU-accelerated detection (tfjs-node-gpu)

PRs welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md).

## Credits

- [@vladmandic/face-api](https://github.com/vladmandic/face-api) — MIT, provides both the detection/landmark models and the WASM runtime used in Electron
- [TensorFlow.js](https://github.com/tensorflow/tfjs) — Apache 2.0, the runtime underlying face-api
- [sharp](https://github.com/lovell/sharp) — Apache 2.0, fast image I/O and transforms
- [canvas (node-canvas)](https://github.com/Automattic/node-canvas) — MIT, native Canvas API used by face-api in Node
- [fluent-ffmpeg](https://github.com/fluent-ffmpeg/node-fluent-ffmpeg) — MIT, wrapper around bundled `ffmpeg-static` (LGPL ffmpeg binaries)
- [exifr](https://github.com/MikeKovarik/exifr) — MIT, EXIF parsing for photo creation dates
- [Electron](https://www.electronjs.org/), [React](https://react.dev/), [Vite](https://vitejs.dev/), [Zustand](https://github.com/pmndrs/zustand)

## License

MIT © 2026 Artem Kichihin — see [LICENSE](./LICENSE).
