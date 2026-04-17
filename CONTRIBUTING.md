# Contributing to face-timelapse

Thanks for considering a contribution. This project is small and focused — PRs that keep it that way are appreciated.

## Development setup

```bash
git clone https://github.com/Gingerman960/face-timelapse.git
cd face-timelapse
npm install
npm run download-models
npm run dev
```

First-time `npm install` runs `electron-rebuild` for `canvas` and `sharp`. If the rebuild fails, install your platform's build tools (Xcode Command Line Tools on macOS, MSVC Build Tools on Windows, `build-essential` on Linux) and rerun `npm install`.

## Running tests

### Unit tests (pure logic, fast)

```bash
npm test           # one-shot
npm run test:watch # watch mode
```

Covers `alignment`, `faceEmbedding`, `exportService` — 23 tests, no native deps.

### Integration tests (real face-api pipeline)

Gated by an environment variable so they skip cleanly when prerequisites aren't met:

```bash
FACETIMELAPSE_INTEGRATION_PHOTOS=/path/to/photos/of/one/person npm test
```

Requirements:
1. `npm run download-models` has been run (so `./models/` is populated).
2. The directory at `FACETIMELAPSE_INTEGRATION_PHOTOS` contains ≥2 photos of the same person.
3. `@napi-rs/canvas` ships prebuilt binaries for every supported platform — no rebuild step needed.

The test photos never enter git — they stay local. Do not commit them.

## Making a change

1. Fork and create a branch off `main`.
2. Keep the change focused. One concept per PR.
3. Add a test if you touch pure logic.
4. Run `npm test` locally before opening the PR.
5. Describe the user-visible effect in the PR body, not just "updates X".

## Reporting bugs

Open an issue at <https://github.com/Gingerman960/face-timelapse/issues> with:
- OS and Electron version
- Steps to reproduce
- Expected vs actual behavior
- A redacted sample image if the bug is image-specific

## Code style

- Match the style of the file you're editing.
- No new dependencies without a clear justification in the PR.
- Renderer is React 18 + Zustand. Main-process services are plain Node modules.
