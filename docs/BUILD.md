# Build and distribute

How to build FaceTimelapse from source, produce installable bundles for macOS, Windows and Linux, sign and notarize them, and cut a release. For day-to-day development (tests, coverage, formatting) see [CONTRIBUTING.md](../CONTRIBUTING.md).

The app is a Tauri 2 project: a Cargo workspace (`crates/face-engine`, `crates/timelapse-video`, `src-tauri`) plus a Vite/React frontend in `ui/`. The Tauri CLI (`@tauri-apps/cli` 2.12.4) is a devDependency of `ui/`. Its npm scripts (`tauri`, `app:dev`, `app:build`) change to the repository root before running the CLI, because the CLI looks for `src-tauri/` below its working directory. Use them from the root with `npm --prefix ui run …` or from `ui/` with `npm run …`; any CLI command works this way (`npm --prefix ui run tauri -- <command>`). If you prefer the Rust CLI, `cargo install tauri-cli --version '^2.12' --locked` and run `cargo tauri <command>` from the repository root.

## Prerequisites

### All platforms

| Tool | Version | Notes |
|---|---|---|
| Rust | via [rustup](https://rustup.rs); `rust-toolchain.toml` pins 1.99.1, which rustup installs on first use | the crates' minimum is 1.88 (`rust-version`) |
| Node.js + npm | 24 LTS (22.22 or later works) | the UI test stack (jsdom 30) requires `^22.22 \|\| ^24.15 \|\| >=26` |
| curl or wget, and shasum, sha256sum or openssl | any | used by `scripts/fetch-models.sh` |

Then, from the repository root:

```bash
scripts/fetch-models.sh   # downloads the two ONNX models into models/ (~39 MB, SHA-256 verified, idempotent)
npm --prefix ui ci        # UI dependencies + Tauri CLI
```

### macOS

- Xcode Command Line Tools: `xcode-select --install` (full Xcode is not needed).
- The app targets **macOS 13 Ventura or later** (`bundle.macOS.minimumSystemVersion` in `src-tauri/tauri.conf.json`; the Tauri CLI exports it as `MACOSX_DEPLOYMENT_TARGET` for the Rust build).
- To build the Intel bundle on an Apple-silicon Mac: `rustup target add x86_64-apple-darwin`. Optionally `brew install nasm` so OpenH264 gets its x86 SIMD kernels (without nasm it falls back to plain C, which is slower but correct; macOS uses VideoToolbox by default anyway).

### Windows

- [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with the "Desktop development with C++" workload (MSVC + Windows SDK), and the Rust `x86_64-pc-windows-msvc` toolchain (rustup's default on Windows).
- **WebView2** runtime: preinstalled on Windows 11 and current Windows 10. The NSIS installer downloads it on machines that lack it.
- **Git for Windows** (for Git Bash, which runs `scripts/fetch-models.sh`). Clone with LF line endings: `git config --global core.autocrlf false` before cloning, otherwise bash fails on the script (see [Troubleshooting](#troubleshooting)).
- Optional: [NASM](https://www.nasm.us) on `PATH` so OpenH264 (the Windows video encoder) is built with its SIMD kernels; without it, encoding is noticeably slower.

### Linux

WebKitGTK **4.1** and its companions (ARCHITECTURE.md §14). Debian 12+ / Ubuntu 22.04+:

```bash
sudo apt update
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev \
  libayatana-appindicator3-dev librsvg2-dev patchelf nasm
```

On Ubuntu 22.04, `libappindicator3-dev` can replace `libayatana-appindicator3-dev`. Fedora: `sudo dnf install webkit2gtk4.1-devel openssl-devel curl wget file libxdo-devel librsvg2-devel nasm` plus `sudo dnf group install c-development`. Arch: `sudo pacman -S webkit2gtk-4.1 base-devel curl wget file openssl xdotool librsvg nasm`. `patchelf` is only needed to build the AppImage; `nasm` is optional (OpenH264 SIMD).

Ubuntu 20.04 and other distributions without WebKitGTK 4.1 cannot build or run Tauri 2 apps.

## Development build

```bash
npm --prefix ui run app:dev
```

The CLI runs `beforeDevCommand` (`npm run dev` in `ui/`, Vite on `http://localhost:1420`), builds the `facetimelapse` binary in the dev profile (dependencies at `opt-level = 3`, workspace crates at `opt-level = 1`, so image code runs at realistic speed) and opens the window. Rust changes rebuild and relaunch; UI changes hot-reload.

Useful environment variables (see [INTEGRATION-NOTES.md §6](rewrite/INTEGRATION-NOTES.md#6-running-and-verifying)):

| Variable | Effect |
|---|---|
| `FT_DATA_DIR=/tmp/ft` | keep session, caches and logs under `/tmp/ft/{data,cache,logs}` instead of the user's app folders (and don't touch saved window state) |
| `FT_MODELS_DIR=…` | debug builds only: load the ONNX models from another folder (they must still match the pinned SHA-256) |
| `FT_LOG=debug`, `FT_LOG_STDERR=1` | log level; mirror the log to stderr |
| `FT_TRACE_STARTUP=1` | log `startup.ms` milestones |
| `FT_DEV_AUTOLOAD="reference=/path/ref.jpg;folder=/path/photos"` | debug builds only: preload a reference and folder |
| `MallocLargeCache=0` | macOS: the allocator setting the app runs with (it keeps freed large buffers from staying resident). Bundles get it from `Info.plist` (`LSEnvironment`) when launched from Finder, the Dock or `open`; any other launch without it makes `main` re-exec the binary once with it set. **Set it in your debugger's environment**: LLDB (and Xcode, VS Code's CodeLLDB) stops on that `exec`. When the variable is already present, with any value, there is no re-exec. |

## Release bundles

```bash
npm --prefix ui run app:build
```

This runs `beforeBuildCommand` (`npm run build` in `ui/`: type-check + Vite production build into `ui/dist`), compiles the release binary (thin LTO, one codegen unit, symbols stripped), embeds `ui/dist`, and bundles the targets listed in `bundle.targets` that apply to the host OS:

| Host | Bundles | Output (relative to the repo root) |
|---|---|---|
| macOS | `FaceTimelapse.app`, `FaceTimelapse_<version>_<arch>.dmg` | `target/release/bundle/macos/`, `target/release/bundle/dmg/` |
| Windows | NSIS installer `FaceTimelapse_<version>_x64-setup.exe` (per-user install) | `target/release/bundle/nsis/` |
| Linux | `FaceTimelapse_<version>_amd64.AppImage`, `FaceTimelapse_<version>_amd64.deb` | `target/release/bundle/appimage/`, `target/release/bundle/deb/` |

Variations (everything after `--` goes to `tauri build`):

```bash
npm --prefix ui run app:build -- --bundles dmg                           # only some bundle types
npm --prefix ui run app:build -- --target x86_64-apple-darwin            # Intel Mac bundle (output under target/x86_64-apple-darwin/)
npm --prefix ui run app:build -- --target universal-apple-darwin         # one universal .app/.dmg (needs both rustup targets)
npm --prefix ui run app:build -- --debug --no-bundle                     # quick smoke build: target/debug/facetimelapse
```

Windows and Linux bundles must be built on those systems (or in CI); Tauri does not cross-bundle them. A macOS bundle is about 71 MiB, most of it the SFace model (37 MiB).

### Bundled models and licences

`bundle.resources` in `src-tauri/tauri.conf.json` copies `models/face_detection_yunet_2023mar.onnx` and `models/face_recognition_sface_2021dec.onnx` into the bundle's `models/` resource folder, and `src-tauri/resources/licenses/` into `licenses/`. At run time a release build loads the models only from the bundled resources; a debug build looks in `FT_MODELS_DIR`, then the bundled resources, then the repository's `models/`. Either way each file must match its pinned SHA-256 (`face_engine::model::{YUNET_SHA256, SFACE_SHA256}`, the same values as the script), or the models are reported unavailable.

`tauri-build` checks that every resource exists at compile time, so **any** `cargo build`, `cargo test` or `cargo clippy` of `src-tauri` fails until `scripts/fetch-models.sh` has run. The model URLs are pinned to opencv_zoo commits and their SHA-256 sums live in the script and in `crates/face-engine/src/model.rs`; updating a model means changing all three. The engine's analysis fingerprint hashes the model files, so users' cached analyses are rebuilt automatically after a model change.

## Code signing

Without signing, the bundles work but users see security prompts. Everything below is optional, and the release workflow falls back to unsigned builds when the secrets are missing.

### macOS: Developer ID and notarization

Requires an [Apple Developer Program](https://developer.apple.com/programs/) membership.

1. Create a **Developer ID Application** certificate (Certificates, Identifiers & Profiles, or Xcode › Settings › Accounts › Manage Certificates) and install it in your login keychain. `security find-identity -v -p codesigning` lists it as `Developer ID Application: Your Name (TEAMID)`.
2. Choose a notarization credential:
   - **Apple ID:** an [app-specific password](https://support.apple.com/102654) for your Apple account, plus your 10-character team ID.
   - **App Store Connect API key** (recommended for CI): Users and Access › Integrations › Team Keys, role Developer. Note the issuer ID and key ID and download `AuthKey_<KEYID>.p8` (it can only be downloaded once).
3. Build with the environment variables the Tauri bundler reads:

   ```bash
   export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
   # Apple ID notarization …
   export APPLE_ID="you@example.com" APPLE_PASSWORD="abcd-efgh-ijkl-mnop" APPLE_TEAM_ID="TEAMID"
   # … or API-key notarization
   export APPLE_API_ISSUER="<issuer uuid>" APPLE_API_KEY="<KEYID>" APPLE_API_KEY_PATH="$HOME/keys/AuthKey_<KEYID>.p8"
   npm --prefix ui run app:build
   ```

   Tauri signs every binary with the hardened runtime (`bundle.macOS.hardenedRuntime: true`; the app is not App-Sandboxed because it reads arbitrary user folders), submits the app to the notary service with `notarytool`, waits, and staples the ticket. Notarization usually takes a few minutes.
4. Without a login keychain (a headless machine, or the release workflow), provide the certificate itself: export it from Keychain Access as a `.p12` with a password and pass `APPLE_CERTIFICATE` (single-line base64: `openssl base64 -A -in cert.p12 -out cert.txt`) and `APPLE_CERTIFICATE_PASSWORD`. Both the Tauri bundler and `scripts/release/macos-sign.sh` import it into a temporary keychain; `APPLE_SIGNING_IDENTITY` is then optional. The release workflow signs after the build instead of during it; see [Releasing](#releasing).
5. Verify:

   ```bash
   codesign --verify --deep --strict --verbose=2 target/release/bundle/macos/FaceTimelapse.app
   spctl --assess --type execute --verbose target/release/bundle/macos/FaceTimelapse.app   # "source=Notarized Developer ID"
   xcrun stapler validate target/release/bundle/dmg/FaceTimelapse_*.dmg
   ```

**Unsigned builds.** Apple silicon refuses to run code without any signature, so unsigned releases are **ad-hoc signed** (the release workflow does this when no certificate is configured; locally, `APPLE_SIGNING_IDENTITY=-`). On first launch users must open the app with right-click › Open, or allow it in System Settings › Privacy & Security › Open Anyway. A downloaded app that macOS calls "damaged" has a quarantine flag on an ad-hoc signature; `xattr -dr com.apple.quarantine /Applications/FaceTimelapse.app` clears it.

### Windows: Authenticode

You need a code-signing certificate (OV or EV) from a CA such as SSL.com, Sectigo or DigiCert, or a cloud signing service.

**Certificate file (`.pfx`):** import it into the current user's store and point the bundler at its thumbprint. Keep the settings out of `tauri.conf.json` with a config overlay:

```powershell
Import-PfxCertificate -FilePath cert.pfx -CertStoreLocation Cert:\CurrentUser\My `
  -Password (ConvertTo-SecureString -String $env:PFX_PASSWORD -Force -AsPlainText)
# windows-signing.json:
# { "bundle": { "windows": { "certificateThumbprint": "<THUMBPRINT>", "digestAlgorithm": "sha256",
#                            "timestampUrl": "http://timestamp.digicert.com" } } }
npm --prefix ui run app:build -- --config windows-signing.json
```

The bundler signs the app binary and the NSIS installer with `signtool` (set `TAURI_WINDOWS_SIGNTOOL_PATH` if it is not found). Use your CA's timestamp server.

**EV certificates on hardware tokens or cloud HSMs** (Azure Trusted Signing, SSL.com eSigner, …) cannot be imported as a `.pfx`; set `bundle.windows.signCommand` in the overlay to the vendor's signing CLI instead (Tauri substitutes `%1` with the file to sign).

SmartScreen still warns about a new OV-signed app until it has built up reputation; EV-signed apps are trusted immediately.

### Linux

The AppImage and `.deb` are not signed. Distribute checksums (`shasum -a 256 *.AppImage *.deb`) with the release if you want users to verify downloads.

## Releasing

The [`release.yml`](../.github/workflows/release.yml) workflow builds, signs and checksums every bundle on a tag push and attaches them to a **draft** GitHub release.

1. Bump the app version in `src-tauri/tauri.conf.json` (`version`; this is the version users see) and keep `ui/package.json` in step. The Cargo workspace version (`Cargo.toml`, `0.1.0`) versions the crates, not the app.
2. Commit, then tag and push: `git tag v2.0.1 && git push origin v2.0.1`. The tag must be `v` + the `tauri.conf.json` version, and `RUST_TOOLCHAIN` in the workflows must equal `rust-toolchain.toml`, or the preflight job stops.
3. Wait for the pipeline, download and smoke-test the artifacts, write the release notes, and publish the draft by hand.

To rebuild an existing tag, run the workflow manually (Actions › Release › Run workflow) with the tag name; a re-run replaces the assets of the draft and refuses to touch a published release.

### Pipeline

Signing keys never meet third-party build code. The jobs that run npm install scripts, Vite plugins and the `build.rs` of every crate have a read-only token, no persisted git credentials and no secrets; the signing jobs run only Apple's or Microsoft's signing tools on downloaded artifacts, with the secrets in that one step's environment; and only the last job can write to the repository.

| Job | Runner | Secrets | Does |
|---|---|---|---|
| `preflight` | ubuntu | none | tag = `v` + app version; toolchain pin matches |
| `build` (× 4) | `macos-latest` (`aarch64-apple-darwin`, and `x86_64-apple-darwin` cross-compiled), `ubuntu-22.04` (glibc 2.35 baseline), `windows-latest` | none | `tauri build --no-sign`: macOS `.app` (archived), Linux `.AppImage` + `.deb` (final), Windows `facetimelapse.exe` (no installer yet) |
| `sign-macos` (× 2) | `macos-latest` | Apple | [`scripts/release/macos-sign.sh`](../scripts/release/macos-sign.sh): codesign (hardened runtime), notarize + staple the app, build the `.dmg` with `hdiutil`, sign + notarize + staple the `.dmg` |
| `sign-windows-exe` | `windows-latest` | Windows | [`scripts/release/windows-sign.ps1`](../scripts/release/windows-sign.ps1): `signtool` on the exe |
| `bundle-windows` | `windows-latest` | none | `tauri bundle --bundles nsis --no-binary-patching` around the signed exe (so the installed program is signed too) |
| `sign-windows-installer` | `windows-latest` | Windows | `signtool` on the `-setup.exe` |
| `publish` | ubuntu | `contents: write`, attestations | `SHA256SUMS.txt`, a SLSA build-provenance attestation for every file, then create or update the draft release |

Assets: `FaceTimelapse_<version>_aarch64.dmg` / `_x64.dmg` (plus the `.app.tar.gz` of each), `FaceTimelapse_<version>_x64-setup.exe`, `FaceTimelapse_<version>_amd64.AppImage` / `.deb`, and `SHA256SUMS.txt`. Users can check a download with `shasum -a 256 -c SHA256SUMS.txt --ignore-missing` or `gh attestation verify <file> --repo Gingerman960/face-timelapse`.

Reproducibility and supply chain: the Rust toolchain is pinned in `rust-toolchain.toml` (1.99.1), npm and Cargo installs are locked (`npm ci`, `Cargo.lock`), release builds restore no Rust build cache, the models are SHA-256 checked, NASM for the Windows build is the official 2.16.03 zip checked against a pinned SHA-256 (Linux uses Ubuntu's signed package; macOS needs none because VideoToolbox is its default encoder), and every action is pinned to a commit.

The macOS `.dmg` made by `hdiutil` contains the app and an Applications link, without Tauri's custom window layout. Tauri's own signing (the `APPLE_*` variables during `tauri build`) still works for local builds; the workflow does not use it because it would expose the keys to the build.

### Release secrets (all optional)

Store them in the `release` environment (Settings › Environments › `release`; the workflow creates it on first use). Restricting that environment to `v*` tags, and optionally adding required reviewers, keeps the keys away from every other workflow run. Repository secrets work too.

| Secret | Purpose |
|---|---|
| `APPLE_CERTIFICATE` | Developer ID Application `.p12`, single-line base64 (`openssl base64 -A -in cert.p12`) |
| `APPLE_CERTIFICATE_PASSWORD` | password of that `.p12` |
| `APPLE_SIGNING_IDENTITY` | optional; default: the first "Developer ID Application" identity in the `.p12` |
| `APPLE_API_KEY`, `APPLE_API_ISSUER`, `APPLE_API_KEY_P8` | notarization with an App Store Connect API key (key ID, issuer ID, contents of `AuthKey_<id>.p8`); preferred |
| `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | notarization with an Apple ID and app-specific password, used when no API key is set |
| `WINDOWS_CERTIFICATE` | Authenticode `.pfx`, base64 |
| `WINDOWS_CERTIFICATE_PASSWORD` | password of that `.pfx` |

Without `APPLE_CERTIFICATE` the macOS app is ad-hoc signed and not notarized; with a certificate but no notarization credentials it is signed but not notarized; without `WINDOWS_CERTIFICATE` the Windows files are unsigned. The jobs print a warning in each case. Repository variable `WINDOWS_TIMESTAMP_URL` overrides the default timestamp server (`http://timestamp.digicert.com`). EV certificates on hardware tokens or cloud HSMs need a different signing step (the vendor's CLI in `windows-sign.ps1`).

The macOS script also runs locally on an unsigned app archive, which is handy for checking credentials before tagging: `scripts/release/macos-sign.sh FaceTimelapse.app.tar.gz out/ FaceTimelapse_test` (archive the `.app` with `tar -czf`).

### Auto-update

Not included (ARCHITECTURE.md D18). Adding `tauri-plugin-updater` needs an update signing key pair (`TAURI_SIGNING_PRIVATE_KEY`), signed platform bundles and a `latest.json` asset in the release workflow.

## Continuous integration

[`ci.yml`](../.github/workflows/ci.yml) runs on pushes to `main` and on pull requests. It checks the dependency graph (`cargo deny check` against [`deny.toml`](../deny.toml): RustSec advisories, licences, sources; `npm audit` for the UI's runtime dependencies, also weekly on a schedule), formats and lints the Rust code, runs the workspace tests on macOS, Linux and Windows, gates Rust line coverage at 80 %, runs the UI type check, lint, Vitest (with coverage) and Playwright suites, and makes a debug Tauri build on macOS. [Dependabot](../.github/dependabot.yml) proposes Cargo, npm and Actions updates weekly, two weeks after each release. [CONTRIBUTING.md](../CONTRIBUTING.md#continuous-integration) lists the jobs.

## Troubleshooting

| Symptom | Fix |
|---|---|
| ``resource path `../models/face_detection_yunet_2023mar.onnx` doesn't exist`` (any cargo command) | Run `scripts/fetch-models.sh`. `tauri-build` checks bundled resources at compile time. |
| `Couldn't recognize the current folder as a Tauri project` | You ran the Tauri CLI from `ui/` or another folder without `src-tauri/` below it. Use the npm scripts (they change to the repo root) or run `cargo tauri …` from the root. |
| `Port 1420 is already in use` during `app:dev` | Another Vite server (or a Playwright run) holds the port; stop it. The port is fixed because `devUrl` points at it. |
| `checksum mismatch` from `fetch-models.sh` | The download was corrupted or intercepted (proxy, captive portal); rerun. The script never keeps a file whose SHA-256 differs. |
| Windows: `scripts/fetch-models.sh: line 15: set: -` / `invalid option` | The script was checked out with CRLF endings. Strip them in Git Bash (`sed -i 's/\r$//' scripts/fetch-models.sh`), or set `git config --global core.autocrlf false` and clone again. |
| Linux: `Package webkit2gtk-4.1 was not found in the pkg-config search path` | Install the [Linux prerequisites](#linux); WebKitGTK 4.0 is not enough. |
| Linux: blank or flickering window (often NVIDIA + Wayland) | Run with `WEBKIT_DISABLE_DMABUF_RENDERER=1` (a WebKitGTK compositing issue, not specific to this app). |
| macOS: "FaceTimelapse can't be opened because Apple cannot check it" / "is damaged" | The build is unsigned or not notarized; see [unsigned builds](#macos-developer-id-and-notarization). |
| macOS: no photos found in Desktop/Documents/Downloads or on an external drive | The app was denied folder access. Allow it in System Settings › Privacy & Security › Files and Folders, then rescan. |
| Video export uses OpenH264 on a Mac | VideoToolbox could not create a hardware session (e.g. in a VM). The app falls back automatically and logs the reason; the result is equivalent, only slower. |
| macOS: the debugger stops right after launch with `exec` / "process exited", or a profiler shows two launches | The app re-execs itself once to apply `MallocLargeCache=0` (see [Development build](#development-build)). Set `MallocLargeCache=0` in the debug environment and it starts directly. |
| First build is slow | The first compile builds tract, image codecs, OpenH264 and Tauri; later builds are incremental. In CI, `Swatinem/rust-cache` keeps them warm. |
| `npm warn EBADENGINE … jsdom` | Node is older than 22.22 (or an odd release outside the supported ranges); switch to Node 24 LTS. |

**Logs and app data.** The log is `facetimelapse.log` (5 MB × 3) in the app log folder: `~/Library/Logs/io.github.gingerman960.facetimelapse/` on macOS, `%LOCALAPPDATA%\io.github.gingerman960.facetimelapse\logs\` on Windows, `~/.local/share/io.github.gingerman960.facetimelapse/logs/` on Linux. The session lives in the app data folder and analysis caches, thumbnails and aligned frames in the app cache folder (ARCHITECTURE.md §5); deleting the cache folder forces a full rescan and re-align, deleting `session.json` starts fresh.
