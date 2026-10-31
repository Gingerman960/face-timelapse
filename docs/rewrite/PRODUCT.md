# Product

<!-- impeccable:product-schema 1 -->

> Provenance: written during the Tauri rewrite (phase 1, design lead). The user
> instructed "don't ask the user questions — make the calls yourself", so no
> interview round ran. Facts marked **[repo]** come from the legacy codebase and
> README; facts marked **[brief]** come from the user's rewrite brief as relayed
> by the orchestrator; facts marked **[inferred]** are the design lead's
> reasoned assumptions and should be confirmed or corrected by the user.

## Platform

web

(Rendered in a desktop webview: Tauri 2 shell, macOS first — Apple Silicon,
Retina — with Windows and Linux builds kept working. "web" is the closest
impeccable platform value; the design language targets a native-feeling macOS
desktop app, not a website.) **[brief]**

## Stack

Tauri 2 (Rust core: `crates/face-engine`, `crates/timelapse-video`,
`src-tauri`), UI in `ui/` with React 19 + TypeScript strict + Vite + Zustand.
Fonts self-hosted and bundled; the app must work fully offline. **[brief]**

## Users

- Primary: one person who has taken a selfie (roughly) every day for years and
  wants to see the years pass as a single aligned face. The reference user has
  3,593 daily selfies from 2012–2022 in one folder. **[repo + brief]**
- They run the app occasionally (once a year, or when a milestone hits), at a
  desk, on a laptop or desktop Mac, and spend a long focused session: pick a
  reference, scan thousands of photos, review uncertain matches, pick one photo
  per day, align, preview, export. **[inferred]**
- Secondary: people who share the resulting video on social media (the repo
  ships a social-preview card and a "threads" export). **[repo]**

## Product Purpose

Align one person's face across thousands of photos so that eyes, nose and mouth
land in the same pixels in every frame, then export the sequence as an image
folder or an MP4 timelapse. Success: a smooth, stable timelapse of a decade of
a face, produced locally, with the user's judgement applied where the machine
is unsure. **[repo]**

## Positioning

- Local-first: nothing leaves the machine, no accounts, no network. **[repo]**
- Reference-based identity matching, so one person is picked out of a camera
  roll that contains other people. The rewrite uses SFace face-recognition
  embeddings on YuNet-detected faces, calibrated to the legacy 0–1 score scale
  (≥ 0.60 match, ≥ 0.40 unsure); legacy used a pose-sensitive geometric
  landmark embedding. **[ARCHITECTURE.md D8]**
- Day-granular curation: one photo per calendar day, chosen by best match,
  overridable by the user, with drag-to-reassign between days. **[repo]**
- Built for scale: thousands of photos, parallel workers, scan cache. **[repo]**

## Operating Context

- Workflow: Setup (reference photo + crop + aspect ratio + source folder) →
  Scan (live progress, cancel) → Confirm uncertain matches (keyboard
  accept/reject) → Daily selection (calendar, one photo per day, drag to
  reassign, add photo for empty day) → Align (progress, cancel) → Results
  (grid, full-screen viewer, save to folder, create video). **[repo]**
- Planned additions: in-app timelapse player with scrubber; onion-skin overlay
  to check alignment; exposure/white-balance normalization toggle; richer video
  export (fps/duration coupling, crossfade, date caption, resolution presets,
  quality); drag-and-drop of reference photo or folder onto the window;
  keyboard-driven review; progress with cancel for every long job. **[brief]**
- Long jobs are real: scanning 3,600 photos, aligning a few thousand, encoding
  an MP4. The user leaves the window and comes back. **[inferred]**

## Capabilities and Constraints

- Inputs: JPEG/HEIC-era phone photos with EXIF dates; filenames like
  `20120901_111216.jpg` or `IMG_20140815_142326.jpg`. **[repo]**
- Similarity buckets: confirmed / uncertain / rejected. **[repo]**
- Legacy output size is the crop's exact pixel size (the 512 px presets in the
  legacy code are dead code). The rewrite offers resolution presets
  (720p / 1080p / 2160p bounding boxes, default 1080p; `source` = legacy
  behaviour). **[ARCHITECTURE.md D11, §9.8]**
- Frontend budget: < 300 kB gzipped JS; compositor-only animation;
  virtualized grids for 3,600+ items. **[brief]**
- Sessions: the app auto-restores the last session on launch and keeps
  recent reference photos and folders; there is no multi-project UI in v1.
  **[ARCHITECTURE.md D7]**
- One long job at a time (scan, align, export); while it runs, mutating
  actions are unavailable but every screen stays readable. **[ARCHITECTURE.md D4]**

## Brand Commitments

- Name: FaceTimelapse. MIT licence, author Artem Kichihin. **[repo]**
- Existing icon `assets/icon.svg`; it may be redrawn to match the new world.
  **[inferred]**
- No binding palette or typeface: the legacy amber-on-charcoal look is
  explicitly being replaced ("upgraded interface", "next level"). **[brief]**

## Evidence on Hand

- Real photo library for local judging only (never committed, never copied
  into the repo): `/Users/gingerman/Projects/everyday photos/photos`
  (3,593 files) and the reference
  `/Users/gingerman/Projects/everyday photos/reference/IMG_20140815_142326.jpg`.
- Legacy screenshots: `assets/screenshots/*.png`; social card
  `assets/social-preview.jpg`.
- No testimonials, user counts, benchmarks or press exist. Do not invent them.

## Product Principles

1. The face is the content. Every screen should put photographs first and let
   controls recede until needed.
2. Trust through visibility: long jobs show what they are doing, on which
   photo, how far along, and can always be cancelled without damage.
3. The machine proposes, the person decides: confident matches flow through
   automatically; uncertain ones get a fast, keyboard-first human pass.
4. Time is the axis. Dates, days and years are first-class navigation, not
   metadata.
5. Private by construction: local files, local processing, no network.

## Accessibility & Inclusion

WCAG 2.2 AA contrast for text and essential UI in both themes; full keyboard
operation of every flow (including crop, review and calendar); visible focus;
respects `prefers-reduced-motion` and `prefers-contrast`. **[brief + inferred]**
