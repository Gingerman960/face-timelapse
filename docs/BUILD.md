# Build & distribute

This document covers building installers for macOS, Windows, and Linux, plus the signing work required to ship them to other users.

## Prerequisites

- Node.js 18+
- Platform build tools for the native deps (`canvas`, `sharp`):
  - **macOS:** `xcode-select --install`
  - **Windows:** [Visual Studio Build Tools](https://visualstudio.microsoft.com/downloads/) with the "Desktop development with C++" workload
  - **Linux:** `sudo apt-get install build-essential libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev`

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

## CI builds

The repo's GitHub Actions workflow (`.github/workflows/ci.yml`) runs unit tests on Linux only. To build release installers in CI, add platform-specific jobs that run on `macos-latest` and `windows-latest` with the signing env vars wired up via GitHub Secrets.
