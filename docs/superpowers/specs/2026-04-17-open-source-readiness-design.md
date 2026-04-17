# face-timelapse — Open-Source Readiness (Stage A)

**Date:** 2026-04-17
**Author:** Artem Kichihin (via Claude)
**Status:** Approved

## Goal

Prepare the existing Electron + React face-alignment app (currently named `face-aligner` in-tree) for publication as an open-source repository at `https://github.com/Gingerman960/face-timelapse`. This is Stage A of a two-stage plan. Stage B (thorough test coverage, CI, cross-platform build verification) is deliberately deferred.

## Rename

`face-aligner` → `face-timelapse` in:
- `package.json` `name`
- `electron-builder.yml` `productName` (`FaceAligner` → `FaceTimelapse`)
- `electron-builder.yml` `appId` (`com.yourname.facealigner` → `io.github.gingerman960.facetimelapse`)
- UI title in `App.jsx`
- README and all docs

The local directory name (`FaceAlignerElectron`) stays — users will clone into whatever they want.

## Deliverables

### 1. Open-source files

| File | Purpose |
|---|---|
| `README.md` | Overview, screenshots pointer, features, install, dev, build, how alignment works (Procrustes on 5 landmarks), attribution for face-api/tfjs/ffmpeg |
| `LICENSE` | MIT, (c) 2026 Artem Kichihin |
| `CONTRIBUTING.md` | Fork → branch → `npm test` → PR flow |

### 2. Package metadata (`package.json`)

Add:
- `"author": "Artem Kichihin"`
- `"license": "MIT"`
- `"repository": { "type": "git", "url": "https://github.com/Gingerman960/face-timelapse.git" }`
- `"homepage": "https://github.com/Gingerman960/face-timelapse"`
- `"bugs": { "url": "https://github.com/Gingerman960/face-timelapse/issues" }`
- `"keywords": ["electron", "react", "face-detection", "timelapse", "face-alignment", "procrustes"]`
- `"engines": { "node": ">=18" }`
- `"scripts.test": "vitest run"`

### 3. `.gitignore` additions

Add: `release/`, `.env`, `.env.*`, `.idea/`, `.vscode/`, `coverage/`, `*.log`

### 4. `electron-builder.yml`

Rename `productName` and `appId` as above.

### 5. Bug fixes (surgical, behavior-preserving)

| File | Fix |
|---|---|
| `electron/main.js` | Drop unused `loadImageAsBase64` import. Convert `image:getBase64` handler to `fs.promises.readFile`. Remove redundant inner `require('os')` in `face:alignBatch`. |
| `renderer/src/store/alignmentStore.js` | `reset()` sets `aspectRatio: 'free'` but initial is `'original'` — align to `'original'`. |
| `electron/services/exportService.js` | Docstring says `YYYYMMDD.jpg`, code writes `.png` — fix doc. |
| `electron/services/videoExport.js` | Guard `typeof ffmpegStatic === 'string'` before `.includes()` call. |
| `electron/services/photoScanner.js` | Worker `error` handler currently increments `completed` but doesn't propagate task index; add defensive logging so scan cannot silently deadlock. |

### 6. Smoke tests (Vitest)

Pure-logic modules only. No native deps, no models, no Electron.

| Test file | Covers |
|---|---|
| `tests/alignment.test.js` | `computeProcrustesTransform` identity case, `scalePoints` arithmetic |
| `tests/faceEmbedding.test.js` | `compareFaces(a, a) ≈ 1`, `categorize` thresholds (0.60/0.40), `generateEmbedding` returns length 45 for synthetic 68-pt input |
| `tests/exportService.test.js` | `generateFilename` produces `YYYYMMDD.png`, collision → `_1`, `_2` |

Add `vitest` as devDependency, `"test": "vitest run"` script.

### 7. Secrets & publication safety

- Grep the tree for: email addresses, `API_KEY`, `SECRET`, `TOKEN`, absolute `/Users/` paths outside node_modules
- Document model provenance in README (face-api.js models, Apache 2.0 via @vladmandic/face-api)

### 8. Git

- `git init`
- Single initial commit: `chore: initial public release`
- Tag: `v1.0.0`
- **Do not push.** User pushes after reviewing locally.

## Out of scope (Stage B candidates)

- E2E tests with Playwright
- Tests that require native modules (sharp/canvas) or model weights
- GitHub Actions CI
- Cross-platform build verification (only confirmed on macOS in-tree)
- Code-signing guidance for macOS/Windows
- Accessibility audit, perf audit
- Architectural refactoring

## Risks

1. **Tests may reveal behavioral bugs** in the pure-logic modules that aren't purely cosmetic. If so, fix minimally and note in commit message.
2. **`npm install` on a fresh checkout** is required for `download-models` to copy from `node_modules/@vladmandic/face-api/model`. README must make this ordering explicit.
3. **Native rebuild** (`canvas`, `sharp`) is Electron-version-sensitive; documented in README, relies on existing `postinstall` script.

## Acceptance

- `npm test` passes locally
- `git log --oneline` shows one clean commit
- `README.md` renders correctly on GitHub
- No personal data in diff besides the author name in LICENSE/package.json
