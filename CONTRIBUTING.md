# Contributing to FaceTimelapse

Thanks for considering a contribution. The app is small and opinionated: one person, one folder of daily photos, one aligned timelapse, all on the local machine. PRs that keep it that way are very welcome.

## Development setup

Install the prerequisites for your OS from [docs/BUILD.md](docs/BUILD.md#prerequisites) (Rust via rustup, which installs the toolchain pinned in `rust-toolchain.toml`; Node 24 LTS; platform libraries), then:

```bash
git clone https://github.com/Gingerman960/face-timelapse.git
cd face-timelapse
scripts/fetch-models.sh        # ONNX models into models/ (needed by every cargo build of src-tauri)
npm --prefix ui ci
```

Two ways to work:

| Loop | Command | When |
|---|---|---|
| UI in a browser, fake backend | `npm --prefix ui run dev`, open <http://localhost:1420/?mock=aligned> | screens, interaction, styling. The in-memory fake backend (`ui/src/ipc/mock/`) implements every command over a synthetic 3,600-photo library; `?mock=fresh\|ready\|scanned\|reviewed\|aligned` picks the starting state and `&speed=instant\|fast\|normal` the job speed. |
| Real app | `npm --prefix ui run app:dev` | anything that touches Rust, the IPC contract, images or real photos. `FT_DATA_DIR=/tmp/ft` keeps your real session and caches untouched. |

The npm scripts `tauri`, `app:dev` and `app:build` run the Tauri CLI from the repository root, so they work from the root (`npm --prefix ui run …`) and from `ui/` (`npm run …`).

Debugging on macOS: the app re-execs itself once at startup to run with `MallocLargeCache=0` (the allocator setting it ships with; [docs/BUILD.md](docs/BUILD.md#development-build)). LLDB stops on that `exec`, so add `MallocLargeCache=0` to your debug launch environment; with the variable present the app starts directly.

## Repository map

| Path | What | Depends on |
|---|---|---|
| `crates/face-engine` | pure Rust: walk, dates, decode, YuNet + SFace (tract), matching, analysis cache, days, alignment, colour look, export | no Tauri |
| `crates/timelapse-video` | pure Rust H.264/MP4 encoder (VideoToolbox + openh264), crossfade, captions | no Tauri |
| `src-tauri` | Tauri 2 shell: IPC commands, jobs, `ftimg` image protocol, session persistence | both crates |
| `ui` | React 19 + TypeScript + Vite frontend | `src-tauri` over IPC only |

The two crates never depend on each other. The binding design is in [`docs/rewrite/ARCHITECTURE.md`](docs/rewrite/ARCHITECTURE.md) (contract, algorithms, performance budgets) and [`docs/rewrite/DESIGN.md`](docs/rewrite/DESIGN.md) (design system); [`docs/rewrite/INTEGRATION-NOTES.md`](docs/rewrite/INTEGRATION-NOTES.md) records how the shell meets the crates. Read the relevant part before changing behaviour.

## Tests

### Rust

```bash
cargo test --workspace                     # everything that runs without real photos
cargo test -p face-engine                  # one crate: face-engine | timelapse-video | facetimelapse
cargo bench -p face-engine                 # criterion benches (analyze, reference)
cargo bench -p timelapse-video --bench encode
```

- Synthetic tests need only the models. `timelapse-video` integration tests additionally check output with `ffprobe`/`ffmpeg` when they are installed, and test VideoToolbox when a hardware session can be created; otherwise those checks skip.
- **Real-photo tests** read `FT_PHOTOS_DIR` (a folder of selfies of one person) and `FT_REFERENCE_PHOTO` (one reference photo of that person); `FT_PIPELINE_PHOTOS` sets the sample size of the shell's end-to-end pipeline test (default 50). When the variables or files are missing, the tests print `skipped: <reason>` and pass, which is what happens in CI. They never copy, modify or commit photos, and write output only to temporary folders.
- Throughput gates are `#[ignore]` and need a release build: `cargo test -p face-engine --release --test real_scan -- --ignored --nocapture` (≥ 100 photos/s scan, ≥ 5,000 photos/s cached rescan, ≥ 60 frames/s align) and `cargo test -p timelapse-video --release --test real_photos -- --ignored --nocapture`.

### UI (run in `ui/`, or prefix with `npm --prefix ui`)

```bash
npm test                   # Vitest + Testing Library (jsdom), every screen against the fake backend
npm run test:watch
npm run test:coverage      # v8 coverage → ui/coverage/
npx playwright install chromium   # once
npm run test:e2e           # Playwright: flows, axe checks, screenshot baselines, then the perf project
npm run test:e2e:update    # re-record screenshot baselines (see below)
```

- E2E runs against the Vite dev server with the fake backend on port 1420 (reused if one is already running; `FT_E2E_PORT=1431` picks another port).
- **Screenshot baselines** live in `ui/e2e/__screenshots__/visual.spec.ts/` and are named per platform (`*-darwin.png`). Record them on macOS only, from the synthetic stand-ins, and review every changed image before committing. `npx playwright test --project=chromium --grep-invert '(light|dark) [0-9]+×[0-9]+'` runs everything except the pixel comparisons (that is what Linux CI does).
- The `perf` project measures frame times while flinging the 3,600-item grid and calendar (p95 ≤ 16.7 ms, no long task > 50 ms). It needs a quiet machine, so it runs locally and not in CI: `npx playwright test --project=perf`.
- `FT_SHOOT_STATES=1 npx playwright test --grep 'job states'` captures the running-job screens into `ui/e2e/__screenshots__/states/` (reference images, not compared).

## Coverage

Every layer keeps **at least 80 % line coverage**. Current values (without real photos): face-engine ≈ 95 %, timelapse-video ≈ 97 %, src-tauri ≈ 93 %, ui ≈ 97 %. New code comes with tests that keep its layer above the bar; CI fails the Rust job below 80 % workspace line coverage and uploads both reports.

```bash
cargo llvm-cov -p face-engine --summary-only        # per crate (cargo install cargo-llvm-cov)
cargo llvm-cov --workspace --ignore-filename-regex '(src-tauri/src/(main|lib)\.rs|/benches/)' --summary-only
cargo llvm-cov --workspace --ignore-filename-regex '(src-tauri/src/(main|lib)\.rs|/benches/)' --html --open
npm --prefix ui run test:coverage                   # ui/coverage/
```

`src-tauri/src/main.rs` and `lib.rs` (process start-up and window wiring) are excluded because they only run inside a real webview; the end-to-end pipeline test and the manual smoke run cover them.

## Formatting and lint

```bash
cargo fmt --all                                            # check: cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
npm --prefix ui run typecheck
npm --prefix ui run lint                                   # ESLint, zero warnings allowed
```

- Rust: edition 2024. Each crate declares its lints in its `Cargo.toml`, and CI turns warnings into errors: `unsafe` is forbidden in `face-engine` and `src-tauri` (`timelapse-video` needs it for the OpenH264 and VideoToolbox FFI and must document every block), `clippy::unwrap_used` is on in `face-engine` and `src-tauri`, and both crates under `crates/` require docs on public items. Errors are `thiserror` enums that map to the IPC `IpcError` with a friendly message.
- TypeScript: `strict` + `noUncheckedIndexedAccess`. Backend data goes through TanStack Query, view state through Zustand; never copy server state into a store. Styling uses the tokens in `ui/src/styles/tokens.css` and the rules in DESIGN.md.
- No new dependency without a reason in the PR description (bundle size, licence, maintenance). Licences must be compatible with MIT distribution (MIT, Apache-2.0, BSD, ISC, Zlib, OFL for fonts). `cargo deny check` enforces the crate licence allow-list, RustSec advisories and crates.io-only sources ([`deny.toml`](deny.toml)); an advisory exception needs an entry there with the ID, why it does not affect the app, and when it can be dropped.
- The Rust toolchain is pinned in `rust-toolchain.toml`. To move to a newer Rust, change it together with `RUST_TOOLCHAIN` in `.github/workflows/ci.yml` and `release.yml` (CI fails if they differ) and fix any new clippy findings in the same PR.

## Changing the IPC contract

The contract between `ui/` and `src-tauri/` is binding and guarded by drift tests (ARCHITECTURE.md §7.6). To change a command, type or event:

1. Edit **ARCHITECTURE.md first**: the command table (§7.2), the TypeScript block (§7.3), the Rust block (§7.4), the signatures (§7.5) if needed, and add a row to the changelog (§7.7).
2. Copy §7.3 verbatim to `ui/src/ipc/contract.ts` and §7.4 verbatim to `src-tauri/src/ipc.rs`, in the same change. The Rust test `ipc_rs_is_verbatim_architecture_7_4` fails if `ipc.rs` differs from the document.
3. Update the samples built in `src-tauri/tests/contract/samples.rs` (one realistic value per type, every enum value and event variant), then regenerate the shared fixtures:

   ```bash
   FT_WRITE_CONTRACT_SAMPLES=1 cargo test -p facetimelapse --test contract
   ```

   This rewrites `ui/src/ipc/contract.samples.json` and `contract.samples.ts`. Commit them.
4. Implement both sides: the command in `src-tauri/src/commands/`; for a new command also its entry in `COMMANDS` in `src-tauri/build.rs`, `allow-<command>` in `src-tauri/capabilities/main.json` and the invoke handler in `src-tauri/src/lib.rs`; the client call and the fake backend in `ui/src/ipc/mock/` (so browser dev, Vitest and Playwright keep working).
5. Run `cargo test -p facetimelapse` (contract round trip, registration and busy-rule tests) and `npm --prefix ui test` (the TypeScript half checks every sample with `satisfies` and deep equality).

## Privacy

FaceTimelapse handles photos of people's faces. Never commit real photos, crops, thumbnails, aligned frames, videos or logs made from them, including your own. Test fixtures, screenshot baselines and mock images are synthetic; real-photo tests read from paths outside the repository. Screenshots for the README must show only people who agreed to be shown publicly (see [assets/screenshots/README.md](assets/screenshots/README.md)).

## Making a change

1. Fork, branch off `main`, keep one concept per PR.
2. Write the test first when you fix a bug or add behaviour, then make it pass.
3. Run the checks for every layer you touched (format, clippy, tests, typecheck, lint, E2E for UI changes).
4. Commit messages follow `<type>: <description>` (`feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`).
5. In the PR, describe the user-visible effect and how you verified it; include before/after screenshots for UI changes.

## Continuous integration

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every pull request and on pushes to `main`:

| Job | Runner | Checks |
|---|---|---|
| Supply chain | ubuntu (also weekly) | `cargo deny check` (advisories, licences, bans, sources per `deny.toml`), `npm audit --omit=dev --audit-level=high` in `ui/` |
| Rust format | ubuntu | toolchain pin check, `cargo fmt --all --check` |
| Rust clippy + tests | macOS, Ubuntu, Windows | fetch models (cached by the script's hash), `cargo clippy --workspace --all-targets -D warnings`, `cargo test --workspace` |
| Rust coverage | ubuntu | `cargo llvm-cov`, ≥ 80 % lines, lcov + HTML artifact |
| UI | ubuntu | `npm ci`, typecheck, lint, Vitest with coverage (artifact), Playwright flows + axe on Chromium |
| UI visual regression | macOS | Playwright screenshot comparisons against the `*-darwin.png` baselines (advisory; diffs are uploaded) |
| Tauri build smoke | macOS | `tauri build --debug --no-bundle` (UI production build + app binary) |

Releases are described in [docs/BUILD.md](docs/BUILD.md#releasing).

## Reporting bugs

Open an issue at <https://github.com/Gingerman960/face-timelapse/issues> with:

- OS and version, and the app version
- steps to reproduce, expected and actual behaviour
- the relevant part of `facetimelapse.log` (location in [docs/BUILD.md](docs/BUILD.md#troubleshooting)); it contains file paths only at debug level and never image data
- a sample image only if you are comfortable sharing it publicly

Security issues: please don't open a public issue. Report them privately through the repository's Security tab (private vulnerability reporting).
