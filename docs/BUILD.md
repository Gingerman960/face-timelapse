# Build & distribute

This document covers building installers for macOS, Windows, and Linux, plus the signing work required to ship them to other users.

## Prerequisites

- Node.js 18+
- Platform build tools for `sharp` (the only remaining native dep; `@napi-rs/canvas` ships prebuilt):
  - **macOS:** `xcode-select --install`
  - **Windows:** [Visual Studio Build Tools](https://visualstudio.microsoft.com/downloads/) with the "Desktop development with C++" workload
  - **Linux:** `sudo apt-get install build-essential`

Then:

```bash
npm install
npm run download-models
```

## Unsigned builds (for local testing)

These just work — no developer account needed.

```bash
npm run build         # current platform
npm run build:mac     # macOS DMG (x64 + arm64)
npm run build:win     # Windows NSIS installer (x64)
```

Output lands in `release/`. Other users who download these will see security warnings:

- **macOS** will refuse to open the `.dmg` because it's from an unidentified developer. Workaround for users: right-click → Open.
- **Windows SmartScreen** will warn that the `.exe` is unrecognized. Workaround: "More info" → "Run anyway".
- **Linux AppImage** runs without signing; just `chmod +x` it.

Unsigned is fine for your own machine or sharing among trusted people. For public distribution, sign.

## Signed builds

### macOS — Developer ID + notarization

You need an **Apple Developer Program** membership ($99/year).

1. Create a "Developer ID Application" certificate in the Apple Developer portal, then download and install it into your login keychain.
2. Create an app-specific password for your Apple ID at <https://appleid.apple.com>.
3. Export the following environment variables before running `npm run build:mac`:

   ```bash
   export APPLE_ID="you@example.com"
   export APPLE_APP_SPECIFIC_PASSWORD="abcd-efgh-ijkl-mnop"
   export APPLE_TEAM_ID="XXXXXXXXXX"          # your 10-char team ID
   export CSC_NAME="Developer ID Application: Your Name (XXXXXXXXXX)"
   ```

4. Add a `mac.notarize: true` block to `electron-builder.yml`:

   ```yaml
   mac:
     # ...existing config...
     hardenedRuntime: true
     gatekeeperAssess: false
     notarize: true
     entitlements: build/entitlements.mac.plist
     entitlementsInherit: build/entitlements.mac.plist
   ```

5. Create `build/entitlements.mac.plist` (minimum for a non-sandboxed app):

   ```xml
   <?xml version="1.0" encoding="UTF-8"?>
   <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTD/PropertyList-1.0.dtd">
   <plist version="1.0">
   <dict>
     <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
     <true/>
     <key>com.apple.security.cs.disable-library-validation</key>
     <true/>
   </dict>
   </plist>
   ```

6. Run `npm run build:mac`. Notarization adds ~5–15 minutes.

### Windows — Authenticode

You need a **code signing certificate** from a CA like Sectigo, DigiCert, or SSL.com ($100–400/year). Options are "OV" (cheap, gets SmartScreen warnings for a while) or "EV" (pricier, instant SmartScreen trust, requires a USB dongle).

For file-based certificates:

```bash
set CSC_LINK=C:\path\to\cert.pfx
set CSC_KEY_PASSWORD=your-cert-password
npm run build:win
```

For EV certs, electron-builder needs `signtool` and the appropriate hardware integration — see [electron-builder's code signing docs](https://www.electron.build/code-signing).

### Linux — optional

AppImage doesn't require signing. If you want to ship a `.deb` or `.rpm`, you can sign with GPG; electron-builder will pick up the key from your GPG agent.

## Auto-update

This project doesn't ship an auto-updater. Adding one is straightforward:

1. Install `electron-updater`: `npm i electron-updater`
2. Host the built artifacts somewhere HTTPS (GitHub Releases works).
3. Wire `autoUpdater.checkForUpdatesAndNotify()` into `main.js`.

See [electron-updater docs](https://www.electron.build/auto-update) for details. Auto-updates require signed builds on macOS.

## Faster face detection (optional)

By default the app runs face detection on WASM, which works everywhere but is CPU-only. If you care about speed on large libraries, install one of these native backends and the app will pick it up automatically at startup. The backend chosen is logged at startup (`Face detection models loaded (backend: gpu|node|wasm)`).

### Native CPU (recommended for Mac + fallback elsewhere)

Faster than WASM, works on macOS, Windows, and Linux:

```bash
npm install --save-optional @tensorflow/tfjs-node
```

On macOS this is the best option available today — Apple-silicon CPU inference is already very fast, and there's no clean Core ML path for face-api.js. A Core ML bridge is tracked for a future release.

### CUDA GPU (Linux and Windows with NVIDIA hardware)

Requires a working CUDA + cuDNN install. See the [tfjs-node-gpu docs](https://github.com/tensorflow/tfjs/tree/master/tfjs-node) for supported versions.

```bash
npm install --save-optional @tensorflow/tfjs-node-gpu
```

### Forcing a specific backend

Useful for testing. Set `FACE_API_BACKEND` to `gpu`, `node`, or `wasm` before launching:

```bash
FACE_API_BACKEND=wasm npm run dev
```

The WASM fallback always works even if you try to force a backend that isn't installed.

## CI builds

Two workflows live in `.github/workflows/`:

- **`ci.yml`** — runs unit tests on Ubuntu + macOS + Windows × Node 18/20 on every push and PR
- **`release.yml`** — triggered by tag push (`v*`), builds + publishes signed installers on macOS/Windows/Linux, uploads to GitHub Releases

## Publishing a release

1. Bump `package.json` version.
2. Commit: `git commit -am "chore: release v1.2.0"`
3. Tag: `git tag v1.2.0`
4. Push: `git push origin main --tags`

GitHub Actions will build on all three platforms in parallel and create a **draft** GitHub Release with artifacts attached. Review the draft, then publish it. Users of prior versions will auto-update on next launch (see `autoUpdater.checkForUpdatesAndNotify()` in `electron/main.js`).

### Required GitHub Secrets (for signed releases)

Add these in the repo settings (Settings → Secrets and variables → Actions). All are optional — if absent, the workflow produces unsigned builds.

| Secret | For | Contents |
|---|---|---|
| `APPLE_ID` | macOS notarization | Apple ID email |
| `APPLE_APP_SPECIFIC_PASSWORD` | macOS notarization | App-specific password from appleid.apple.com |
| `APPLE_TEAM_ID` | macOS notarization | 10-char team ID |
| `CSC_LINK` | macOS signing | Base64-encoded .p12 certificate |
| `CSC_KEY_PASSWORD` | macOS signing | .p12 password |
| `WIN_CSC_LINK` | Windows signing | Base64-encoded .pfx certificate |
| `WIN_CSC_KEY_PASSWORD` | Windows signing | .pfx password |

`GITHUB_TOKEN` is auto-provided by Actions; no need to set it manually.

## Auto-update

The app calls `autoUpdater.checkForUpdatesAndNotify()` at startup in packaged builds only. It reads from `electron-builder.yml`'s `publish` block (configured for GitHub Releases). When a newer tagged release is published, users get the update downloaded in the background and installed on next quit.

Auto-update only works for macOS if the app is signed + notarized. Unsigned macOS builds can still check for updates but won't apply them.
