---
name: FaceTimelapse — Darkroom / Light Table
description: A darkroom and a light table for one face across ten years. Photographs are the only light; the chrome is the room around them.
colors:
  z0-darkroom: "oklch(14.5% 0.004 80)"
  z1-chrome-dark: "oklch(18.5% 0.004 80)"
  z2-raised-dark: "oklch(22.5% 0.004 80)"
  z3-line-dark: "oklch(29% 0.004 80)"
  z4-line-strong-dark: "oklch(38% 0.004 80)"
  z5-disabled-dark: "oklch(50% 0.004 80)"
  z6-text-3-dark: "oklch(62% 0.004 80)"
  z7-text-2-dark: "oklch(74% 0.004 80)"
  z8-line-light: "oklch(85% 0.004 80)"
  z9-chrome-light: "oklch(93.5% 0.004 80)"
  z10-light-table: "oklch(98% 0.003 80)"
  sunken-dark: "oklch(11.5% 0.004 80)"
  sunken-light: "oklch(95.5% 0.004 80)"
  raised-light: "oklch(99.5% 0.002 80)"
  rebate-dark: "oklch(7.5% 0.004 80)"
  rebate-light: "oklch(17% 0.004 80)"
  chinagraph-dark: "oklch(68% 0.185 33)"
  chinagraph-light: "oklch(52% 0.2 31)"
  safelight-dark: "oklch(80% 0.13 78)"
  safelight-light: "oklch(50% 0.12 68)"
  stop-dark: "oklch(66% 0.2 22)"
  stop-light: "oklch(52% 0.2 24)"
typography:
  hero:
    fontFamily: "Bricolage Grotesque, ui-sans-serif, -apple-system, system-ui, sans-serif"
    fontSize: "76px"
    fontWeight: 300
    lineHeight: 0.92
    letterSpacing: "-0.04em"
  display:
    fontFamily: "Bricolage Grotesque, ui-sans-serif, -apple-system, system-ui, sans-serif"
    fontSize: "40px"
    fontWeight: 300
    lineHeight: 1
    letterSpacing: "-0.035em"
  heading:
    fontFamily: "Bricolage Grotesque, ui-sans-serif, -apple-system, system-ui, sans-serif"
    fontSize: "22px"
    fontWeight: 600
    lineHeight: 1.15
    letterSpacing: "-0.018em"
  title:
    fontFamily: "Bricolage Grotesque, ui-sans-serif, -apple-system, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.01em"
  ui:
    fontFamily: "Bricolage Grotesque, ui-sans-serif, -apple-system, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.38
    letterSpacing: "-0.003em"
  label:
    fontFamily: "Bricolage Grotesque, ui-sans-serif, -apple-system, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "0.07em"
  data:
    fontFamily: "Martian Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "11px"
    fontWeight: 400
    letterSpacing: "0"
  edge-print:
    fontFamily: "Martian Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "9.5px"
    fontWeight: 400
    lineHeight: 1
    letterSpacing: "0.06em"
rounded:
  frame: "1.5px"
  cell: "3px"
  control: "7px"
  row: "8px"
  card: "10px"
  panel: "14px"
  sheet: "18px"
  pill: "999px"
spacing:
  s-1: "2px"
  s0: "4px"
  s1: "6px"
  s2: "8px"
  s3: "12px"
  s4: "16px"
  s5: "20px"
  s6: "24px"
  s7: "32px"
  s8: "40px"
  s9: "56px"
  s10: "72px"
components:
  button-plate-dark:
    backgroundColor: "{colors.z10-light-table}"
    textColor: "{colors.z0-darkroom}"
    rounded: "{rounded.pill}"
    height: "30px"
    padding: "0 12px 0 16px"
  button-plate-light:
    backgroundColor: "{colors.z0-darkroom}"
    textColor: "{colors.z10-light-table}"
    rounded: "{rounded.pill}"
    height: "30px"
    padding: "0 12px 0 16px"
  button-quiet-dark:
    backgroundColor: "{colors.z2-raised-dark}"
    textColor: "{colors.z9-chrome-light}"
    rounded: "{rounded.pill}"
    height: "30px"
    padding: "0 14px"
  segmented-track-dark:
    backgroundColor: "{colors.sunken-dark}"
    rounded: "{rounded.pill}"
    padding: "3px"
  field-number-dark:
    backgroundColor: "{colors.sunken-dark}"
    typography: "{typography.data}"
    rounded: "{rounded.control}"
    height: "28px"
  day-cell:
    rounded: "{rounded.cell}"
    size: "minmax(26px, 1fr) square"
---

# Design System: FaceTimelapse — Darkroom / Light Table

> Status: phase-1 design direction, owned by the DESIGN agent. Binding companions:
> [`ARCHITECTURE.md`](ARCHITECTURE.md) (IPC contract, steps, keyboard map) and
> [`PRODUCT.md`](PRODUCT.md). Tokens live in
> [`prototype/tokens.css`](prototype/tokens.css); phase 2 copies that file to
> `ui/src/styles/tokens.css` unchanged. Prototype: [`prototype/index.html`](prototype/index.html).

## Overview

**Direction in five lines**

1. A darkroom (dark theme) and a light table (light theme): the photographs are the only light, and the chrome is the room around them.
2. Contact-sheet grammar: contact strips with edge-print frame numbers, a calendar where every day *is* its photo, and grease-pencil (chinagraph) marks for every decision you make.
3. Neutrals come only from an eleven-step Zone System ramp. Color is semantic: chinagraph red = your editorial decision about a photo, safelight amber = not settled yet, stop red = failure; "where you are" (focus, selection, playhead) is neutral ink.
4. Time is the axis. A two-level **decade ribbon** (focus year at one tick per day, over the whole decade) is the shared map for Scan, Days and the player.
5. The app is a native-feeling macOS app, not a website: overlay title bar, floating inset sidebar ledger, integrated toolbar, sheets, and keyboard paths for every task.

**Scene that sets the light.** One person at a Mac, usually in the evening, looking at ten years of their own face in a long, focused session. They judge skin tone and alignment, so the surround must be neutral (no tinted chrome biasing the photos), and the screen must be calm enough to hold attention for an hour. Dark is the default only because macOS is set to dark; the app follows the system, and the light theme is designed as a lit light table, not as an inverted dark theme.

**What it refuses (the legacy look and the category default).** The legacy UI was a generic dark amber admin look: six numbered pill tabs, uniform rounded cards, amber primary buttons, a Google-Fonts Inter stack, and coloured number grids for the calendar. The rewrite drops all of it: no pill wizard, no card grid, no amber, no gradient blobs, no glow, no default Tailwind/shadcn styling, no eyebrow labels above headings, no hero-metric tiles.

**Process record (impeccable + taste skill).**
- `design-taste-frontend` dials used: variance 8 → asymmetric stages (player frame left of centre, caption as a photobook plate), motion 6 → fluid CSS + View Transitions, density 4 → airy chrome over dense content (the contact sheet and calendar are deliberately dense). Taste-skill rules kept: no emoji, no Inter, no pure black, one accent, no 3-column card rows, skeleton/progress over spinners. Taste-skill rule overridden by the user's own budget: no Framer Motion (≈ 35 kB); motion is CSS + WAAPI + the View Transitions API.
- `impeccable` flow: PRODUCT.md written from the brief (no interview, by the user's instruction; every inferred fact labelled). Concept seed `7b9d13b1` (mode operate) assigned grounded candidate 7 (an ID-photo booth with its biometric template). The brief pins the world (darkroom / contact sheet / editorial, native macOS), and impeccable rules that a brief pin beats the roll, so the assigned candidate entered as a **raise**, not a replacement. No decision page was served (the user asked for no questions). Image generation is unavailable, so the build is code-led.
- Raises written into the direction, each named for its donor:
  - **ID-booth template (assigned candidate 7):** the alignment template (eye line, midline, face oval, chin line, five anchor points) is the shared measuring grammar of crop, review compare and onion skin.
  - **Exposure-record zone sheets (challenger, competitive):** neutrals are an 11-step Zone ramp and nothing else; light correction is written as stop deltas (`+⅔ EV`).
  - **Event-catalogue grid (challenger, competitive):** the map and the grid are the same space; ribbon ticks and calendar cells deep-link to each other; chosen items are circled in pen.
  - **Japanese high-density web (declined):** density courage; contact sheets and calendars pack edge to edge with 2–3 px gutters, no card padding.
  - **Centre-rail reference setting (declined):** hairlines are exactly one device pixel (`0.5px` at 2×).
  - **Timetable slide rack (declined):** chrome uses two sizes; rank comes from weight, case and width, and scale is spent only on content (dates, counts).
  - **Transit diagram (declined):** the ribbon never shrinks the decade into an unreadable miniature; it focuses the current year and keeps the decade as context.

## Colors

**Strategy: Restrained.** Neutrals carry 95 % of the surface. One accent (chinagraph) owns decisions; two signal colours (safelight, stop) appear only with an icon and words. Never decorative.

### Zone ramp (the only neutrals)

| Zone | OKLCH | Dark theme role | Light theme role |
|---|---|---|---|
| Z0 | 14.5% 0.004 80 | canvas (darkroom) | text-1 |
| Z1 | 18.5% | chrome (sidebar, inspector) | – |
| Z2 | 22.5% | raised (sheets, controls) | plate hover |
| Z3 | 29% | hairline | – |
| Z4 | 38% | strong hairline | text-2 |
| Z5 | 50% | disabled | – |
| Z6 | 62% | text-3, edge print | disabled |
| Z7 | 74% | text-2 | strong hairline, edge print on rebate |
| Z8 | 85% | – | hairline |
| Z9 | 93.5% | text-1 | chrome (the desk around the table) |
| Z10 | 98% | reversed plate | canvas (lit opal glass) |

Hue 80 at chroma 0.004 gives a silver-gelatin neutral: not warm cream, not blue-grey. Extra surfaces: `sunken` (wells, tracks), `rebate` (contact-strip film edge; prints black in both themes, like a real contact print).

### Semantic roles

| Role | Dark | Light | Used for | Never for |
|---|---|---|---|---|
| `--mark` chinagraph | 68% 0.185 33 | 52% 0.2 31 | editorial decisions about photos only: the photo chosen for a day ("In the timelapse"), "your pick" underlines (cell and ribbon), Keep, kept ticks, the saved tick | focus, selection, current stage, playhead, settings, machine detections, errors, primary buttons |
| `--focus`, `--cursor` | = text-1 (Z9) | = text-1 (Z0) | focus ring, current stage loop, selected calendar day, "now" frame rings, ribbon cursor and playhead, selected settings | — |
| `--rebate-ink` | Z9 | Z9 | "where you are" on the film rebate, which prints black in both themes: inside every strip (`.strip`, `.filmstrip`, `.grid-row`, `.q-strip`, `.neighbours`, `.rebate`) `--cursor` and `--focus` resolve to it, so the playhead, the current queue item, the selection and focus stay visible in light (they were Z0 on black, 1.04:1; critique round 4). A strip's own focus ring stays page ink. | page surfaces |
| `--rebate-mark` / `--rebate-safelight` | = mark / = safelight | dark-theme mark (68% 0.185 33) / dark-theme safelight (80% 0.13 78) | the chinagraph and safelight inks on the black rebate: inside every strip `--mark` and `--safelight` resolve to them, so a kept tick, an unsure `?` and a pick read on black in light too (in light they were 3.1:1; now 6.1:1 and 10.1:1 on the light theme's rebate, 6.7 and 11.0 on the dark one; critique round 5, P2-10) | page surfaces |
| `--on-photo-ink` / `--on-photo-shade` / `--on-photo-edge` / `--on-photo-glow` / `--on-photo-scrim` | 97 % white / black 62 % / black 45 % / 1 px black 65 % shadow / a gradient from black 45 % at the foot to clear | same | marks, numerals and chips laid on a photograph or a frame (anchors, day numbers in Month zoom, the alternates count, crop size, the caption preview; the scrim under the F viewer's burned-in date, 120 px tall), the same in both themes because the picture is | page surfaces |
| `--safelight` | 80% 0.13 78 | 50% 0.12 68 | "not settled yet": unsure matches, review pending, no face in the crop, alignment outliers | success, branding |
| `--stop` / `--stop-ink` | 66% 0.2 22 / Z0 | 52% 0.2 24 / Z10 | failures and destructive confirmation (Stop scan, Start over, Forget); the label on a stop button is `--stop-ink` (dark: Z0, 5.8:1; white was 3.3:1) | selection |
| `--plate` / `--plate-ink` | Z8 / Z0 (hover Z9) | Z0 / Z10 | the one primary action per screen (reversed plate). Z8, not paper white, in dark, so a plate never outshines the photos (12.5:1) | secondary actions |
| `--quiet-fill` / `--quiet-ring` | raised / none | Z9 / line-strong | secondary capsules (`.btn-quiet`, Review's Leave out): in light a Z9 step with a hairline, so a secondary never reads as the same white pill as a tertiary hairline control | primary actions |
| `--fold-back` | Z9 | Z4 | the turned-back corner of a day with alternates, cell and legend alike | — |
| `--guide` | white 78% | white 85% | template lines over photos (with a 1 px dark halo) | UI text |

**Score semantics (contract `SCORE_CONFIRMED` 0.60 / `SCORE_UNCERTAIN` 0.40) keep three distinct levels:**
- ≥ 0.60 "You": neutral ink (Z7 bar, filled dot).
- 0.40–0.60 "Unsure": safelight (bar, ring, `?` badge).
- < 0.40 "Not you": hairline grey (Z4 bar, hollow dot).

Colour is never the only signal: each level also has a glyph and a word.

**Measured contrast (WCAG 2.x, sRGB).** The ratios are computed from the tokens:

| Pair | Dark | Light |
|---|---|---|
| text-1 on canvas / chrome / raised | 16.4 / 15.4 / 14.1 | 18.7 / 16.4 / 19.5 |
| text-2 | 8.6 / 8.1 / 7.4 | 9.5 / 8.3 / 9.9 |
| text-3 | 5.4 / 5.1 / 4.7 | 6.4 / 5.6 / 6.7 |
| mark (text and icons) | 6.4 / 6.0 / 5.5 | 5.8 / 5.0 / 6.0 |
| safelight | 10.5 / 9.8 / 9.0 | 5.8 / 5.1 / 6.1 |
| stop | 5.8 / 5.5 / 5.0 | 5.8 / 5.1 / 6.0 |
| plate ink on plate | 12.5 | 18.7 |
| stop ink on stop | 5.8 | 5.8 |
| rebate ink on the rebate | 17.2 | 15.8 |

Hairlines (≈ 2:1) are separators only. Every control that has a hairline also has a text label or a fill. `prefers-contrast: more` raises hairlines (dark Z5/Z6, light Z6/Z5) and text-3 to text-2, (and the ribbon's baseline, month ticks, letters and span feet a zone), and `prefers-reduced-transparency` makes glass the opaque chrome; both are restated after the theme blocks with the themes' own specificity, so they hold in all four modes (Light or Dark pinned, or either through System). `e2e/prefs.spec.ts` checks each mode.

## Typography

| Face | Role | Licence | Why |
|---|---|---|---|
| **Bricolage Grotesque** (variable: `wght` 200–800, `wdth` 75–100, `opsz` 12–96) by Ateliers Triay | UI and display | SIL OFL 1.1 | It has character without costume. The optical-size axis makes it a sturdy workhorse at 11–13 px and a refined, slightly idiosyncratic display face at 40–76 px. The width axis gives condensed caps for labels without a third family. |
| **Martian Mono** (variable: `wght` 100–800, `wdth` 75–112.5) by Evil Martians | Data only: filenames, frame numbers, timecodes, counts, scores, dimensions, edge print | SIL OFL 1.1 | A tabular, measurement-grade mono whose condensed width reads like film edge print. It is never used as a "technical" costume. |

Chosen by rendering real UI strings in context (specimen and screen swaps). Rejected: **Mona Sans** (flagged by impeccable as overused, and indistinguishable from Bricolage at UI sizes), **Hubot Sans** (its slashed zero turns the hero date into "3θ Aug"), **Archivo** (solid but anonymous), **Geist** and **Inter** (category defaults). Serif faces stay out of the software UI (taste-skill rule).

**Bundling.** Self-hosted `woff2` in `ui/src/assets/fonts/`: Bricolage `latin` (≈ 100 kB) and `latin-ext`, Martian Mono `latin` (≈ 38 kB). Use `font-display: swap` with metric-compatible fallbacks (`-apple-system`, `SF Mono`). Preload only Bricolage latin. The licence texts ship next to the files. No network access: CSP forbids remote origins (ARCHITECTURE.md D19). Neither family covers Cyrillic; if the UI is ever localised to Cyrillic, the system font takes over for those glyphs.

### Hierarchy

Every `font-size` in the app's CSS is one of these tokens, a `calc()` on one (the ≤ 1180 px compact steps), or `inherit` (critique round 3: about 90 hardcoded sizes had drifted off the scale, two below the floor). `ui/src/styles/typeScale.test.ts` fails the build on a new hardcoded size or a token under the floor.

| Token | Size / weight | Tracking / leading | Use |
|---|---|---|---|
| `--text-hero` | 76 / 300 | −0.04em / 0.92 | at most one per screen: the player's date (compact: × 0.74) |
| `--text-display` | 40 / 300 | −0.035em / 1 | year numeral on Days, player year (compact: × 0.8) |
| `--text-statement` | 34 / 300 | −0.03em / 1.05 | the Scan status sentence (compact: × 0.82) |
| `--text-heading` | 22 / 600 | −0.018em / 1.15 | day in the inspector, empty-state and done leads, sheet results |
| `--text-lead` | 18 / 500 | −0.012em / 1.2 | the Review print dates (that screen's one display moment) |
| `--text-title` | 15 / 600 | −0.01em / 1.25 | toolbar stage title, sheet title |
| `--text-ui` | 13 / 400–600 | −0.003em / 1.38 | body, rows, buttons |
| `--text-small` | 12 / 400 | 0 / 1.45 | meta lines, help, facts values, notice body (the body-text floor) |
| `--text-label` | 11 / 600, condensed 78 % | caps +0.07em / 1.3 | section labels ("FRAMING", month names), key caps, data in tallies |
| `--text-edge` | 9.5, Martian 75 % width | +0.06em / 1 | edge print only: frame numbers on contact strips (decorative, `aria-hidden`, a duplicate of the accessible label) |

**Rules:**
- Chrome uses two sizes (13 and 11).
- Functional text is never below 11 px, and body text never below 12 px (impeccable audit floor). Only the decorative edge print is smaller.
- **Mono is for data only** (counts, times, ids, keys, file names, scores, dimensions), never for prose. A meta line in words (`.meta`) is the UI face at 12 px with only its numerals in the data font (`DataText` wraps each number in `.digits`): "38 photos/s · 12 workers", "3,518 in the timelapse · 4 left out", "Read in 1 min 32 s".
- **Four weights** (critique round 4: ten were in use, and 600–660 can't be told apart at 13–15 px): `--weight-regular` 400 for prose, `--weight-medium` 500 for controls, `--weight-strong` 600 for titles and values (also `b` and `strong`), `--weight-display` 300 for display numerals. `typeScale.test.ts` fails on any other weight.
- **One rhythm per size** (critique round 5, P2-15: 22 px headings carried four trackings and three leadings): `--tracking-<size>` and `--leading-<size>` tighten as the size grows. A rule that sets a size uses that size's rhythm, or a shared one that says why: `--tracking-caps` for caps labels, `--leading-prose` (1.5) for wrapped prose at 13 px and under, `--leading-tight` (1.2) for single-line stacks at title size and under (a ledger row's name over its status, the toolbar title), `--leading-solid` (1) for numerals. `typeScale.test.ts` fails on a literal tracking or leading, or one paired with another size.
- Numerals inside a sentence (`.digits`) step down to 0.9 em: Martian's figures stand about 10 % taller and darker than Bricolage's. Data on its own keeps its token size.
- A separator inside a number (the grouping comma, a time's colon, a decimal point) is set narrow: `DataText` wraps it in `.sep`, pulled in 0.16 em from each side, so a mono comma no longer fills a whole cell and "1,761" never reads as "1 , 761" at heading size (critique round 6, P2-5).
- Headings are balanced (`text-wrap: balance`) and prose is pretty (`text-wrap: pretty`).
- No eyebrow label sits above a heading: the weekday goes after the date, not above it.
- Numerals are tabular wherever they update.

## Layout

**Window.** Default 1440×900, minimum 960×640. `titleBarStyle: "Overlay"`, `hiddenTitle: true`. Traffic lights sit inside the sidebar panel at x≈23, y≈21. 78 px is reserved at the left in both sidebar modes (full sidebar 236 px; compact rail 72 px plus an 8 px inset = 80 px). Drag regions use `data-tauri-drag-region` on the toolbar and on the sidebar's top 48 px.

**Shell grid.**
```
┌ 8 ┬──── sidebar 236 (floating inset panel, r14) ───┬─ main ───────────────────────────────────────────┐
│   │ traffic lights / drag (48)                     │ toolbar 52: title+sub │ centre controls │ tools+plate │
│   │ project: reference print 36×45 + folder name   ├──────────────────────────────────────────────────┤
│   │ ledger: Reference · Scan · Review · Days ·     │ canvas (screen)                    │ inspector 296│
│   │         Timelapse (status line + inline meter) │                                    │ (optional)   │
│   │ … "Nothing leaves this Mac"                    ├──────────────────────────────────────────────────┤
│   │                                                │ decade ribbon 76 (Scan, Days, Timelapse only)    │
└───┴────────────────────────────────────────────────┴──────────────────────────────────────────────────┘
```

**Scroll edge (macOS 26).** Scrolling canvases under the toolbar or a screen header (scan sheet, Days) fade their top 22 px with a `mask-image` instead of slicing rows at a hard edge.

**Spacing rhythm.** Base 4 px. Tight inside groups (4–8), separation between groups (20–24), section breaks (32–40), and more space above a heading than below it. Canvas side padding is 32 px (20 px when compact). Contact sheets and calendars use 2–3 px gutters on purpose: the density shows the volume of a decade.

**Responsive (desktop window classes).**
- **≥ 1181 px:** full sidebar, inspector 296, 4-month calendar rows, 10-frame strips.
- **≤ 1180 px:** the sidebar becomes a 72 px rail (glyphs, the current-stage mark, and the inline meter under the running stage), inspector 268, 3-month rows, 7-frame strips, toolbar subtitles hidden, Review side columns narrowed and its key legend hidden. The inspector also toggles (⌥⌘I) to give photos the full width.
- Below 960 px the window does not shrink (`minWidth`).

## Elevation & Depth

Depth is physical, not decorative: prints lie on glass, and panels float over the room.

| Material | Dark | Light | Where |
|---|---|---|---|
| canvas | Z0, opaque | Z10, opaque | screens; photographs sit here |
| chrome | Z1 + window vibrancy (`sidebar` effect, optional) | Z9 | sidebar panel, inspector |
| raised | Z2 | white 99.5 % | sheets, popovers, quiet buttons, selected segment |
| sunken | 11.5 % | 95.5 % | wells, segmented tracks, number fields, empty frames |
| glass | Z1 at 72 % + `blur(24px) saturate(1.4)` + 0.5 px top highlight | Z10 at 70 % | only where controls actually overlay a photo: the full-screen viewer (`F`) and the onion legend chip. The player transport sits below the frame, so it is opaque `raised` (finish review: blur over flat canvas is decoration) |
| rebate | 7.5 % | 17 % | contact-strip film edge (scan sheet, review queue, player filmstrip, "Around it") |

**Shadow vocabulary:**
- `--shadow-print`: a 1 px hairline (dark), or 0.5/1 px + 2/6 px soft (light).
- `--shadow-panel`: floating sidebar and transport.
- `--shadow-sheet`: sheets and popovers, offset 32 px with 80 px blur.
- `--shadow-control`: a 0.5 px top highlight (dark) or a hairline ring (light).

Shadows are tinted toward the canvas hue. There are no zero-offset coloured halos and no glows.

`prefers-reduced-transparency` turns glass into opaque chrome. Window vibrancy (macOS): the shell makes the window transparent and applies the `sidebar` material from Rust (`FollowsWindowActiveState`, INTEGRATION-NOTES §1). The UI flags `html[data-vibrancy]` at boot inside Tauri on macOS. Then only the floating sidebar card lets the material through, as a 62 % `--chrome` tint. A backdrop under the card paints everything around it opaque, and every other surface paints its own `--canvas`. An explicit in-app Light/Dark choice goes to the native window (`setTheme`, v1.2 `allow-set-theme`; System passes `null`), so the title bar and the material follow it. Until the window confirms that theme (`data-native-theme`), the card stays opaque. The card is always opaque `--chrome` under `prefers-reduced-transparency`, on Windows and Linux, and in plain browsers. That opaque card is how the prototype renders.

## Shapes

- **Radii by role, never one radius for everything:**
  - Photographs 1.5 px (prints are nearly square).
  - Calendar cells 3 px.
  - Fields 7 px.
  - Inspector and list rows 8 px (`--r-row`): "Move a photo to another day…", "Scan again".
  - Tall rows that hold a picture or two lines 10 px (`--r-card`): ledger rows, a day's photo cards, the library card, aspect tiles.
  - Buttons and toolbar controls: pills (macOS 26 capsule controls).
  - Floating sidebar and popovers 14 px.
  - Sheets 18 px.
- **Chinagraph marks** are hand-drawn SVG symbols with `vector-effect: non-scaling-stroke`:
  - `mark-loop`: an imperfect, overlapping loop. In chinagraph red it marks the chosen photo; in neutral ink it marks "where you are" (current stage, selected day).
  - `mark-tick`: kept, and saved.
  - `mark-strike`: left out (review).
  - Hatch (135°, 1 px every 4 px, text-2 at 60 %): a day left out of the timelapse, from the exposure-record raise.

  They extend 4–5 px outside the thing they mark, as a pen would. Stroke 2–2.4 px, round caps.
- **Template geometry** (the ID-photo grammar): eye line, vertical midline through the face centre, dashed face oval, dashed chin line, and five anchor points (eyes as rings, nose and mouth corners as dots). It is drawn from data (`ReferenceDetection.anchors` and `faceBox`, crop-normalised), never from fixed percentages.
- **Crop handles** are crop-mark L brackets (3 px, 18 px arms), not square knobs. Outside the crop, the shade is an even-odd `clip-path` cut-out, so handles are never clipped at the image edge. The brackets reach past the photo onto the page, so they are drawn in the page's ink with a halo of the page's tone (`--bracket`, `--bracket-halo`): white on dark, Z0 on the light table.

## Components

Every interactive component has these states: default, hover, focus-visible (2 px `--focus` ring in neutral page ink, 2 px offset; `--rebate-ink` inside strips), active (scale 0.97, or a pressed fill), disabled (opacity 0.35–0.4 plus `aria-disabled`, with the reason in a tooltip), and loading where relevant.

| Component | Anatomy and behaviour |
|---|---|
| **Ledger row** (sidebar) | Glyph 30 + name 13/600 + status line 11.5 (block-level, so it ellipsizes; job copy stays short, e.g. "Encoding · 52 s left") + kbd hint on hover (⌘1–⌘5). Status values: `done` (status text), `ready`, `running` (status + an inline 2 px meter under the text), `attention` (safelight dot + count), `locked` (disabled ink + the reason, e.g. "After the scan"). The current row gets a selected fill, and a neutral-ink loop draws around its glyph (clip-path reveal, 360 ms). |
| **Reversed plate** | The single primary action of a screen, top-right in the toolbar, with its ⌘↩ hint. Plates: Scan library · Review 41 unsure / Continue to Days (Review's done state) · Align N days · Export… While Review has photos pending, its primary is the in-stage `Keep Y` (the plate fill, no ⌘↩). |
| **Quiet button** | Raised capsule for secondary actions (Stop, Skip review, Keep all remaining, Show in Finder). |
| **Icon button** | 30 px circle; the `sm` size is 24 px (the WCAG 2.2 target floor). |
| **Segmented control** | Sunken pill track (3 px inset); the selected segment takes the shared "on" style (`--pressed-fill` and the 1 px `--pressed-ring`, below). Used for zoom, view and format choices. |
| **Chip / toggle chip** | Hairline pill. **One "on" style app-wide** (critique round 3): a pressed toggle (Onion, Even light, Loop, Compare, icon toggles) and a selected radio chip (resolution) take `--pressed-fill`, an opaque step off the raised surface (17 % toward Z10 in dark, lit; 10 % toward Z0 in light, pressed into the paper), with ink label and icon and a 1 px `--pressed-ring` (ink at 52 % / 48 %), so "on" never rests on the ring alone. The selected segment of a segmented control takes the same fill and ring. Solid ink is kept for primary plates, the play disc and switches. `aria-pressed` always mirrors the real state, including when it is entered by key; disabled chips are struck through with a tooltip. |
| **Aspect tile** | Proportion glyph + label in a 3×2 grid; the selected tile gets a raised fill and a 2 px ink frame. Presets follow the contract `AspectPreset`: 1:1, 3:4, 9:16, 4:3, 16:9, Free. |
| **Row button** (inspector actions) | Icon + label + value + kbd: Level the eyes `L`, Centre the face `C`, Reset crop `R`, Move a photo to another day `M`, Leave this day out `X`. |
| **Facts list** | `dt` 12.5 text-2 / `dd` data 12 right-aligned with ellipsis. |
| **Number field** | Sunken, data font, right-aligned, unit suffix (`days/s`, `long`, `s first`). Coupled pair with a link toggle for pace ↔ length. |
| **Switch** | macOS-style; ink when on. A real checkbox with `role="switch"` sits underneath. |
| **Contact strip** (one component, four uses: scan sheet, review queue, player filmstrip, "Around it") | Rebate band with a 15 px top edge, cells 4:3 (or the frame aspect), 3 px gutters; a strip is as long as its film (it ends 3 px after its last frame with a square cut, and a short one centres). Edge print reads `▸ 0812  2018·06·11`; in the player's filmstrip (cells as narrow as 31 px) only the playhead frame keeps the `▸` marker and the others print the bare number, so no label is clipped (QA batch 9). Unsure cells get a 1.5 px safelight inner ring and a `?` badge (Phosphor icon). Inside the rebate the chinagraph and safelight inks are the rebate's own (`--rebate-mark`, `--rebate-safelight`), legible on black in both themes. During a scan, frames develop in order along one leading edge: a frame waiting for its image is latent (a slow-breathing lifted rebate); one whose image lands ahead of the frames before it stays latent until they land, for at most 400 ms; the Z8 outline moves, when a develop ends, to the highest developed frame with nothing before it still waiting or developing. Live rows print frame numbers only. |
| **Day cell** | Square, r3. Variants: face crop · empty (hairline, day number) · has-alternates (folded corner) · your pick (2 px chinagraph underline) · left out (hatch over the image at 30 %, never a chinagraph mark: its pick isn't in the timelapse) · selected (neutral loop) · drop target (2 px ink ring, image 55 %). |
| **Alternate row** | A card (`--r-card`): 64 px face, time (hidden when `dateSource = 'manual'`), likeness, kbd `1–9`, drag grip; chosen row: loop plus "In the timelapse"; a photo taken after midnight adds "Taken after midnight · Move to 1 May" as its last line. The radio is laid over the whole card (click or drag anywhere); the card's lines are drawn under it for the eye, and the move link sits above it. |
| **Decade ribbon** | A canvas focus row (critique round 4: it was 366 identical ticks, a barcode with no months): a 1 px baseline under the days that have a photo (`--ribbon-day`, Z5 dark / Z6 light, ≥ 3:1 on the canvas; critique round 5, P3-27), broken where a day has none; an 8 px tick on each month's first day (`--ribbon-month`, Z6 dark / Z5 light, a step louder than the baseline) with its letter J F M … D beside it in edge print (`--ribbon-edge`, Z6 dark / Z5 light); under the baseline a chinagraph dash for each day whose photo you chose by hand, and the left-out hatch (text-2 at 60 %) for days left out, never both. Below it a canvas decade row (binned coverage in `--ribbon-fill`, focus-year bracket, playhead) with year labels. Ink is only for the cursor and the bracket, so the photos stay the only light. The days on screen are marked by two 6 px crop-mark feet at the span's ends (`--ribbon-span`, Z6), hidden when the span covers the whole focus year (critique round 5, P2-14: a span rule read as a progress bar); while a run of days is selected on Days, the same feet mark the run (critique round 6, P1-4). While a scan runs, each day is exposed in its year as it's found; days not found yet stay faint on both rows. Increase contrast steps the baseline, ticks, letters and feet a zone further (dark baseline Z6, light Z5). The cursor moves by transform with no standing `will-change`. The loupe shows the day's photo at 160 px, captioned in words ("Thu 14 Aug 2014"). A transparent `<input type="range">` on top carries keyboard and screen-reader semantics. |
| **Transport** | Opaque raised capsule with a hairline edge, about 360 px, playback only: previous, play (a 38 px ink disc), next, timecode ("1:23 / 3:00", the ledger's format), pace chip ("10 days/s"; Loop is in its popover). Onion and Even light live in the caption plate as the Look pair. |
| **Sheet** | Attached under the toolbar, centred over the main column, max 700 px. It morphs between Settings → Encoding → Saved/Failed without closing: the visible bottom edge moves with `clip-path` (360 ms `--ease-sheet`) while a shade under it carries the shadow along, and the outgoing content cross-fades with the new over 120 ms; nothing animates layout. If a phase change removes the focused button, focus moves to the sheet. |
| **Popover** | Anchored confirmation (Stop scanning?), raised, 320 px. |
| **Inline notice** | An icon + sentence line at the point of the problem (no banners). Safelight for "fix this", stop for "this failed". |
| **Toast** | Bottom-centre over the canvas, raised (`--raised`, `--shadow-sheet`; opaque, so it reads over any photo), 4 s, always with Undo when the action is reversible (move photo, exclude day, keep all), a 24 px pill with a hairline ring. Identical toasts merge, except ones with an action: every Undo stays reachable. |
| **Keys card** | `?` (and Help › Keyboard Shortcuts ⌘/ in the native menu bar, contract v1.8 `show-keys`; critique round 6, P1-3: it opens the card, a second choice keeps it open) lays an exposure-record card over any screen, the export sheet included: a raised sheet (`--raised`, `--shadow-sheet`, `--r-sheet`), max 800 px, titled "Keys · ⟨screen⟩" (`--text-title` / 600) over a strong rule. The screen's keys fill the wide column and "Everywhere" sits in the narrower margin column (`--text-small`, text-2). Rows are grouped by intent (Move · Decide · Look · Make), each group named in the left margin in label caps, with hairlines between groups. Caps are the app's `kbd`; screen readers hear the keys' names. Over the export sheet it shows only the sheet's keys. A modal dialog: focus moves in and returns, and Esc, `?` again or a click outside put it away. In over 220 ms on `--ease-out` (fade and an 8 px rise), out over 150 ms on `--ease-in`, inert at once (critique round 5, P2-13). It is found from the sidebar footer: a quiet second row under "Nothing leaves this Mac", `? Keys` (the `?` as a cap, label size, text-3, tooltip "Keys for this screen (?)"; the rail keeps only the cap). Its layer (z 55) sits over the F viewer (50) and its lifted frame (51), under the toasts (60) and a file drop (70) (critique round 6, P1-3). The Help › Keyboard Shortcuts menu item belongs to the shell and is not built yet. |
| **Models notice** | When the face models can't be used (contract v1.6 `AppInfo.modelsError`, or any command answering `modelUnavailable`): a calm, persistent note in the ledger above the footer, on every screen (critique round 3: neutral raised surface with a hairline ring, the stop-red icon the only accent): the title "Face models are missing" (13/600), then 12 px prose that promises only what the session has. A session opened with the models before restores read-only with its photos, days and frames (QA N5), so with frames it reads "Reinstall FaceTimelapse to scan or align." and "Watching and exporting the frames you have still work." (with photos but no frames yet: "Reviewing photos and choosing days still work."). A session that never had the models restores nothing, so an empty library gets only "Faces can't be found until FaceTimelapse is reinstalled." A `Details` text toggle (`aria-expanded`) reveals the backend's `modelsError` on demand. The collapsed rail shows only its icon with the sentence as tooltip. While the startup load runs (`modelsReady: false`, no error) nothing is shown or turned off: a scan or align started then waits for the models. The UI subscribes to `models-changed`, then reads app info, and reads it again on the event. Scan, Resume, Align, Add a photo and frame nudges are off with that sentence as their tooltip. App info alone decides "missing" (UI review 4): a command answering `modelUnavailable` while the load still runs only gave up waiting (§7.1, after 2 s), so it latches nothing and reads "The face models are still loading. Try again in a moment."; once the load has failed it reads the models sentence. Either way app info is read again. |
| **Crash panel** | When a screen throws while rendering, only that screen is replaced (one error boundary per screen, one at the root): a stop-red icon, "Days stopped working", "Nothing you made is lost…", `Try again` and `Reload the window`, and the error as small print for a bug report. A crashing export sheet closes with a toast. |
| **Drop overlay** | Full window during an OS file drag: the matching target outlines in chinagraph with "Release to use as reference" or "Release to use this folder"; the other target dims to 32 %. |
| **Zone wedge** | An 11-step absolute Zone System strip (Z0–Z10) with a hollow "from" marker and a solid "to" marker and its reading "zone 5 → 5⅔" in the 11 px data font, showing the face's exposure before and after evening. Lives under "Light evened" in the player caption and in the Even-light popover. Labelled for screen readers ("Face exposure moved from zone 5⅓ to 6"). |
| **Develop-in** | New photos surface by image opacity over the latent rebate tone (the rebate mixed 12 % toward Z10), 700 ms expo-out, staggered 90 ms (the Saved spread: 240 ms, sequenced); never from a canvas-coloured overlay. Live scan frames develop for real along the edge, about four at once (signature moment 4). |

**Key caps:** `kbd` is set in Bricolage at `--text-label` / 600, leading 1.3 (not the mono, where "O" reads as "0"), hairline-boxed in rows and bare inside buttons at 78 % opacity.

**Icons:** Phosphor, regular weight, 16 px in rows and 18 px in the ledger (`@phosphor-icons/react` per-icon imports in phase 2). Chinagraph marks are custom SVG. There are no unicode glyphs standing in for icons.

## Do's and Don'ts

**Do:**
- Let photographs carry all colour.
- Spend scale only on dates and counts.
- Keep exactly one reversed plate per screen.
- Draw a chinagraph mark for every user decision.
- Put problems inline, next to the thing that caused them.
- Give every long job: what it is doing, on which photo, how far, how fast, how long remains, and a Stop that keeps partial work.
- Use the decade ribbon as the shared map.

**Don't:**
- No card grids, eyebrow labels, gradient text, glows, coloured side borders, hero-metric tiles, spinners in content, or modals for non-blocking tasks.
- Don't use red for anything that is not a decision (chinagraph) or a failure (stop).
- Don't animate layout properties.
- Don't show a photo's time when its date was set by hand.
- Don't put file paths in URLs (the contract's `ftimg` uses ids).

---

## App shell and navigation model

The six-pill wizard is replaced by a **ledger**: the floating sidebar lists the project's stages as a live status board, not as tabs to march through. Every row says what that stage holds right now (for example "3,529 matched", "29 of 41 left", "5:59 · 10 days/s"), shows progress inline while a job runs, and is reachable whenever the contract allows, so the flow is non-linear: you can jump from the player back to Days, swap a photo, and re-align only what changed.

| Ledger row | Contract step(s) (ARCHITECTURE.md §8) | Reachable | Shows |
|---|---|---|---|
| Reference ⌘1 | `setup` | always | reference crop editor + library folder |
| Scan ⌘2 | `scan` (transient) | while `activeJob.kind === 'scan'` (see proposal P6 for the post-scan library) | live contact sheet |
| Review ⌘3 | `review` | `scan.status === 'complete' && counts.uncertain > 0` | keyboard review |
| Days ⌘4 | `days` | `scan.status === 'complete'` | calendar of faces + day inspector |
| Timelapse ⌘5 | `align` (transient) and `timelapse` | `activeJob.kind === 'align'` or `frames.count > 0` | the player; while aligning, the same screen in its *aligning* state |

**Rules:**
- Auto-enter and startup behaviour follow ARCHITECTURE.md §8, except that the last review decision no longer enters Days after 600 ms: the done state waits for `Continue to Days`, so it can be read (QA batch 3).
- **One job at a time (D4):** while a job runs, every row stays clickable for *reading*, but mutating controls on the visited screen show disabled with the tooltip "Another task is running. Wait for it to finish or cancel it." The running row shows its meter, and ⌘. stops the job from anywhere.
- Scan cancelled or failed → Setup, with an inline notice. Align cancelled → Days, with the toast "Aligned 1,204 of 3,012. Align again to continue."
- Session restore (D7): the window opens on `lastStep`. The first-run empty state appears only when there is no session; after `reset_session` it shows recent folders and references.
- Start over: the project header's `⋯` (Project options) offers **Start a new timelapse?** with a short confirmation. It explains what is cleared (reference, folder, review calls, day picks) and what stays (photos already read, exported files). `Start over` calls `reset_session` and opens the empty Reference screen. It is hidden on an empty session and disabled while a job runs.
- A job the page didn't start (after a webview reload) is adopted from `session.activeJob`: its row shows as running, ⌘. cancels it, and the UI returns to idle when the session no longer lists it.
- Theme: View › Appearance (System, Light, Dark), stored in `localStorage` (try/catch), default System.
- **Continuity (critique rounds 4 and 5):** the store's `step` is the target and changes at once, so the step router, `afterJob` and every guard see it immediately; only the screen on show follows it, inside a same-document View Transition (`useShownStep` in `features/shell/stepTransition.ts`), always catching up to the newest target, so rapid changes resolve to the last one (UI review 5).
  - **One cross-fade, never a flash.** Old and new screens fade on the same duration and curve (`--dur-base`, `--ease-standard`), so the plus-lighter blend of the two snapshots never lifts the background: in the darkroom a screen change never brightens (round 5, P1-1 had a grey flash).
  - **The day travels as itself.** A picture of a day carries that day's transition name (`vtPrintName(day)` = `ft-day-YYYY-MM-DD`, set through `data-vt-print` and `--vt-print`, class `ft-print`): the selected Days cell (its aligned frame, laid over the face crop only while a transition runs) and the player's frame. The same picture of the same day grows into the player and shrinks back into its cell at matching centred crops (`object-fit: cover` at both ends), 360 ms on `--ease-sheet`. The player keeps `activeDay` on the frame on show, so Timelapse → Days lands in that day's cell.
  - **Never a loading frame.** A change of step first waits for the new screen's code (`loadScreen`), then starts its transition; a screen still loading its data, and a print not yet decoded, hold the capture (`useTransitionHold`, `holdTransition`) for at most 250 ms. Every screen's code is also fetched while the app is idle (`requestIdleCallback`, or after 800 ms where WebKit has none) and on a hover over its ledger row.
  - Transition names exist only while `html.vt` is set. Without the API, with the window hidden, or in tests, the change simply applies.
- **Focus follows the screen (critique round 5, P1-4).** When a step change would drop focus to `<body>` (the focused control left with its screen), focus lands on the new screen's labelled region (`section.screen`, `tabindex=-1`, no ring), inside the transition's update; a screen that arrives after its loading frame takes it then. Focus elsewhere (the ledger, a sheet) keeps its place. The new screen's name is said politely (a `role=status` line).
- **The ledger's words:** the project header names the project by its decade ("2012 – 2022", 15/600) with the folder and its count under it ("photos · 3,591"); before a scan, the folder is the name. Every stage row carries "Days · 3,518 days chosen ⌘4" as its tooltip; in the rail (≤ 1180 px) the names and statuses are visually hidden rather than removed, so VoiceOver still hears them. The current stage's loop is written by the pen as the stage becomes current. Aligning reads like the scan row, "44% · 1 min 21 s left".

## Screens and states

Each screen has one job. Prototype URLs: `prototype/index.html?screen=<id>&state=<state>&theme=<light|dark>` (export: `&sheet=open&sheetstate=<sheet|encoding|done>`).

### 1. Reference (`setup`)

- **Layout:** the canvas holds the reference print (fills the stage, preserving its own aspect) under the crop and template, with a caption line above it (file name and pixel size in the data font; "rotated 0.5°" in the UI face with its figure in the data font) and readouts below ("Eyes level −0.4°", "Face found · 5 points", the tick a neutral pen mark), the drag hint their own second line right under them (critique round 5, P3-21). The inspector holds:
  - Framing: aspect tiles.
  - Face: Level the eyes, Centre the face, Reset crop.
  - Library: folder card plus facts (already read, still to read, date range of the last scan), a stopped or failed scan said under the facts ("Stopped at 2,231 of 3,593." / "The next scan continues from here.", safelight; a failure in stop red with its reason), `Scan again` as an inspector row (`.row-btn`, `--r-row`; not a second capsule beside the plate, critique round 5, P3-21) once the plate has moved on, and "Forget earlier scan results…".
  - A note on time to scan.
- **Primary action (the next step, critique round 4):** before the first scan `Scan library ⌘↩` (`Resume scan` for a stopped one); after it `Scan 12 new photos ⌘↩` while photos wait, else `Review 1 unsure ⌘↩`, else `Open Days ⌘↩`. No plate before there is a reference.
- **The first photo lands (signature moment 6):** when a reference arrives (the first pick, or a new one; not when returning to it or opening the app on it) the print develops in (opacity, with contrast easing up from 0.6, `--dur-develop`), the template draws itself top to bottom over it (clip-path, `--dur-slow`), and "Face found" is ticked by the pen.

| State | Treatment |
|---|---|
| empty (first run or after reset) | Asymmetric composition: a large 3:4 drop frame showing the faint template (eyes drawn as rings), "Start with one photo of your face", "Each day's photo is lined up to this one. …", `Choose photo… ⌘O` (the frame's own "Drop a photo here" says the rest); on the right, after a hairline, "Then the folder of daily photos", `Choose folder… ⇧⌘O`, and Recent (only after a reset). No toolbar plate and no inspector toggle until there is a reference. The sidebar shows "New timelapse · No photos yet" with a sunken placeholder holding the template's oval, and the other rows are locked. |
| drag-over | The matching drop target outlines in chinagraph (2 px) with mark-soft fill and the caption "Release to use as reference"; the other target dims to 32 %. Folder drags light up the library target instead. Multi-item drops follow §8. |
| detecting | The print shows with the shade; the template and handles are hidden; the readout reads "Finding your face…" with a sweeping 2 px hairline (no spinner). |
| ready | As described above. Committing a crop change (150 ms after the drag ends) re-matches the library in memory, so the ledger's Scan status updates without rescanning. |
| no face in crop (`detection === null`) | Inline only: the crop ring turns safelight, the template and anchors hide, a chip inside the crop reads "No face inside the crop", and the readout line gives the contract message plus "Choose another photo…". The plate is disabled with a reason. |
| error (decode, unsupported, permission) | An inline stop notice in place of the readouts, with the friendly `IpcError.message` and one recovery action. |

### 2. Scan (transient `scan`)

- **Layout:** a status sentence at display size (34/300: "Read **2,231** of 3,593 photos") over a tally line:
  - ● 2,174 you
  - ◐ 27 unsure
  - ○ 30 someone else or no face
  - ▨ 412 remembered from the last scan
  - "N couldn't be read" (only when `failed > 0`)

  On the right: "38 photos/s · 12 workers", "About 36 s left", and the current file in the data font ("Starting…", in the UI face, until the first). Below that, a 2 px progress meter, then the **live contact sheet** (newest strip at the bottom, auto-follow until the user scrolls up, a "Jump to newest" chip after that, which lands on the newest rows; the frames above that screen stop holding the edge), and the decade ribbon exposing each day in its year as it is found; its focus year is the year with the most days found so far, held until another overtakes it (critique round 5, P2-9).

| State | Treatment |
|---|---|
| running | As described. A frame read but still waiting for its image is **latent**: the rebate lifted 12 % toward Z10, breathing slowly (opacity 0.4 ↔ 1 over 2.4 s; reduced motion holds it at 0.75), phase-locked to the document clock, each 160 ms behind the one before, so the run breathes as one wave toward the leading edge. **One leading edge (critique round 5, P1-6):** thumbnails land out of order, so frames develop in order: a frame whose image lands while one before it is still on its way stays latent, held at most 400 ms, after which the edge passes the frames still waiting (they keep breathing and fade in when they land). Frames released together start a step apart (the reading pace, ≤ 60 ms), so a batch, even a burst of rows, sweeps along the edge instead of lighting as a block; past 1.5 s of queue the steps shrink so it never reaches 3 s. **True development (signature moment 4):** each released frame develops on the sigmoid (opacity, and `contrast(.55) brightness(1.25)` easing to neutral, on the image only) over about four frames of reading, so about four develop at once: the full 900 ms on a slow scan, down to 160 ms; under 320 ms it is opacity only; reduced motion, a 120 ms fade. An image that can't be read stops breathing when the edge reaches it. The Z8 outline moves only when a develop ends, onto the highest developed frame with nothing before it still waiting or developing, so it never sits on a latent or black frame. Slots not read yet are flat rebate. The sheet follows the developing edge on a critically damped scroll (about 250 ms; any user scroll interrupts it), its row kept with two rows of the latent run under it, so the edge never leaves the view when reading outruns the pictures; a sheet opened mid-scan starts at the newest rows. The meter sits 12 px clear of the sheet. Live rows print frame numbers only: they are in read order, so a date would jump; month stamps stay in the date-ordered library. |
| cancel | A popover anchored to Stop: "Stop scanning? The 2,231 photos read so far are remembered, so the next scan continues from here." [Keep scanning] [Stop (stop red)]. |
| done | The sentence becomes "Found you in **3,529** of 3,593 photos" with "Read in 1 min 32 s · 41 need your eye" ("Read in under a second" for a rescan from memory, never "0 s"). After review the tally reads "● 3,558 you · ✓ 29 kept · ✕ 12 left out · ○ 23 someone else or no face" (tick and strike in chinagraph); no item at zero shows, and the side note shows only while photos are pending. The library sheet is one tab stop (←/→ photo, ↑/↓ row, Home/End, Enter/Space select). The plate is `Review 41 unsure`, the secondary is `Skip review` (unsure photos stay out). Auto-advance per §8. In the library, the ribbon follows the sheet: its cursor and visible-span bracket mark the days of the rows on screen, and a seek on the ribbon scrolls the sheet to that day. |
| no results (N5) | A finished scan with no photos in the session (for instance results lost while the face models were missing) never reads "Found you in 0 of 0 photos · Read in 40 s". The statement says "No scan results to show", and one line of prose under it says why: "The face models are missing, so this library can't be read. Reinstall FaceTimelapse, then scan again." (or, with the models there, "Scan the library to find your face in it."). It keeps the band's shape: the statement and reason on the left, the folder's facts where the rate would be, and two strips of unexposed film (edge numbers only) where the sheet would be; no tally, filter or ribbon. The plate is `Scan library ⌘↩`, disabled with the models reason while they are missing. A folder with no photos (`imageCount` 0) says "This folder has no photos FaceTimelapse can read. Choose the folder with your daily photos." and its plate is `Choose another folder… ⌘↩`, since a rescan could only find nothing (UI review 4); the ledger's Scan row reads "Ready · N photos", not "0 matched". With results still in the session, the library shows as usual and only the sidebar notice speaks of the models. |
| stopped (`partial`) | "Stopped after 2,231 photos"; under the tally a safelight notice "Stopped at 2,231 of 3,593." / "The next scan continues from here." (a failure: stop red, "The scan stopped." and its reason), as in the Reference inspector, so it stays said when the inspector is hidden (critique round 5, P3-26). Plate `Resume scan ⌘↩`. |
| failed | Back to Setup with an inline stop notice and the message. |

### 3. Review (`review`)

- **Layout:** three columns over a queue strip.
  - Left: the reference frame (`reference/frame`) captioned like the candidate: the label "Reference" and its date (from its file name when it has one).
  - Centre: the **candidate, shown as the frame it would get now.** With contract v1.7 this is the backend's own preview, `preview/{photoId}?w={640|1280}&v={PhotoDetail.previewVersion}`: the aligned frame rendered on demand with the extended backdrop and the photo's nudge (no master written), shown cover-fit, so Review shows exactly what the timelapse will contain. A preview that fails (a 404, a shed request) is retried twice, quietly (400 ms, 1.2 s), then the print falls back to aligning here: a similarity transform from `PhotoDetail.faces[matchedFace].anchors` to the reference anchors, applied as a CSS matrix on `thumb/{id}?w=1280`, over a blurred, enlarged copy of the same photo where it leaves the frame (one static `blur()` layer clipped to the frame), its edges feathered into it. The same fallback serves a photo without a preview version (no matched face or no reference face). The detail (and so the version) is read again after any change that moves the frame: the reference, its crop or rotation, an align with new render settings, a nudge. The next two pending photos' details are prefetched and their prints decoded (their previews once the detail says so; at most four held); a print holds until the next is decoded, then cross-fades (`--dur-xfade`), dimming only after a 240 ms grace, and the unaligned cover-fit shows only when there is nothing to align by. Below it: the label "Unsure match" and the date (time when known). The decision buttons `Leave out N`, `Compare Space`, `Keep Y` sit right under the prints: prints and buttons are one group centred in the stage, with no dead band. They are weighted by intent (critique round 3): **Keep** is the screen's primary while photos are pending (the ink plate fill), **Leave out** the secondary (the app's quiet material: raised in dark, Z9 with a hairline ring in light), **Compare** a tertiary hairline toggle (32 px, the shared pressed style when on); each carries its key. The queue below carries the only counter ("12 / 41"); a queue of one prints it on its own rebate as edge print ("▸ 01 / 01") in a tighter band, with no count beside it (critique round 5, P3-22).
  - Right: the likeness scale (three zones with a score pin, the score, and one plain-language sentence), facts (file in the data font; "One face" or "2 faces · best match used" and the date source in the UI face, only the count in the data font), and the key legend.
  - The candidate's date sits under the frame at 18/480, the screen's one display moment.
  - Bottom: the queue of all unsure photos as a contact strip (edge print `▸ 01…41`). Kept items get a chinagraph tick, left-out items a strike with a 35 % greyscale image, and the current item is enlarged with a ring in the rebate's ink. The strip is as long as its film: it ends 3 px after its last frame with a square cut; a short film centres under the stage; only an overflowing film fades at its end.
- **The verdict (signature moment 2):** Y writes a chinagraph tick on the print's corner (`--dur-pen`); the print lifts (panel shadow) and, after 120 ms, flies into its queue slot (280 ms `--ease-out`, transform and opacity only), dissolving where the queue's own tick is being written; the next pre-decoded print rises from the well (opacity, `--dur-base`). N does the same with a strike in guide ink (it reads over the photo; red stays for Keep) and the print in greyscale at 35 %. A new decision ends the previous flight at once, so forty-one in a row at key-repeat speed never stack. Reduced motion: a 120 ms fade, no movement.

| State | Treatment |
|---|---|
| default | As described. Decisions advance immediately, and `U` / ⌘Z walks back the undo stack. The toolbar has no plate while photos are pending: a quiet text action `Skip to Days · 12 stay out` (the cost beside it, not underlined; a tooltip says they can be added later from Days) and the secondary `Keep all remaining ⇧A`. ⌘↩ rests until every photo has a call, so it can never quietly leave photos out. |
| compare (hold Space) | The reference frame overlays the candidate at 50 % with the template; release to return. |
| multi-face photo | The matched face is outlined with a hairline box on the un-transformed thumbnail in the facts column. |
| done | Centred completion: "All 41 looked at", "29 kept, 12 left out. You can change any of them later from Days or the library.", then the reviewed film at 72 px with its ticks and strikes (the film is the result; no separate tick), the last call written by the pen and scrolled into view, and the toolbar plate `Continue to Days ⌘↩` (it appears only here, and with nothing to review). When the last call is made, focus moves to that plate (the focused control went away with the stage); a held Enter's repeats can't press it. Opening Review already done leaves focus alone. A decision batch that fails rolls its photos back and drops their undo entries, so U never undoes a call that didn't happen. It waits for Continue (no auto-continue), so the summary can be read. The decision keys rest here (only U / ⌘Z undo), so Enter or → can't silently re-decide a photo. |
| loading | Before the list of unsure photos is known (critique round 6, P1-2): the subtitle reads "Gathering the unsure photos…", the screen is `aria-busy`, the stage stays empty and the queue band holds a short film of seven latent prints breathing in turn (`ft-latent`, still under reduced motion), and the `Continue to Days ⌘↩` plate is disabled (⌘↩ rests too). Never "No photos the scan wasn't sure about" before the list says so. |
| nothing to review | The done composition without a film: "Nothing needed your eye", "The scan was sure about every photo it read.", the subtitle "No photos the scan wasn't sure about", and the `Continue to Days ⌘↩` plate. |
| busy (another job) | Decision buttons disabled with the busy reason; the queue stays browsable. |

### 4. Days (`days`)

- **Layout:**
  - **Year of faces:** a display year numeral with the legend on its row, and the summary on its own line under both ("3,518 in the timelapse · 4 left out · 1 empty · 6 with alternates": a `.meta` line, numbers in the data font, naming only the counts that aren't zero). The summary never shares a row with the legend, so a count that appears ("· 4 left out") can't push the legend or reflow the header; it stays on one line with an ellipsis (critique round 3), and 12 month blocks. The number per row follows the canvas's own width, not a window breakpoint (critique round 4): as many as keep a day cell at 26 px or more, in a count that divides the year (6, 4, 3, 2, 1), so the inspector never squeezes cells to 16 px and at 1920 px the whole year lies on one table (`yearColumns`). Each row of months is as tall as its longest month (4 to 6 weeks), so the year fills the height down to the ribbon. When the cells are sized by the height and width is left over (1920), the year lies centred as one sheet and its head is as wide, so the legend ends where December does (critique round 5, P1-5). Each block has a month label, a count, Monday-first weekday initials (the UI face, condensed), and day cells that *are* face-centred photos.
  - **Toolbar:** zoom (Decade · Year · Month), year stepper, find date, the alignment chip (it names the size only, "1080p"; what fills the frame is inside, under "Outside the photo"), and the plate `Align N days` (or `Open Timelapse ⌘↩`).
  - **Inspector:** the day heading ("2 May 2014", then "Friday · 3 photos · best match chosen"), the alternates list, actions, and an "Around it" strip of the 5 surrounding days for consistency, as prints at the frame's aspect (the aligned frames once they exist, so they show what will play).
- **Zoom levels:**
  - Decade: ten year rows of 1-px-wide day columns, i.e. the ribbon enlarged.
  - Year: the default.
  - Month: large cells with alternates fanned out.

| State | Treatment |
|---|---|
| default | Selected day: neutral loop. Picks that differ from the auto pick carry the chinagraph underline. "Around it" is a contact strip with day numbers as edge print. The pick just made is written by the pen, once (critique round 4): the cell's underline draws left to right and the loop around the chosen photo in the inspector strokes on (`--dur-pen`); marks that were already there just sit. |
| opening the timelapse | `Open Timelapse ⌘↩` opens the player on the selected day's frame, and the View Transition grows that day's aligned frame from its cell into the player's frame (`ft-day-…`, class `ft-print`, 360 ms `--ease-sheet`; signature moment 3). Back from the player, the frame on show shrinks into its own day's cell. |
| failed align | Said above the calendar in stop red until the next align: "Aligning stopped. ⟨reason⟩ The frames aligned so far are kept; aligning again does the rest." |
| empty day | Hairline cell with its number; the inspector reads "No photo on 29 April 2014" with a drop zone and `Add a photo to this day…`. |
| dragging (dnd-kit) | A tilted face ghost follows the pointer with a plate label ("Move to Sat 3 May"); the target cell gets the chinagraph ring; the source dims. On drop the ghost settles into the day (shrinks and fades where it was let go, 220 ms ease-out; no settle under reduced motion). Dropping calls `move_photo_to_day`, then a toast that says what happened, with Undo: the day's pick follows the best likeness unless one was chosen by hand, so a better photo takes over ("Moved to 3 May 2014 · now the pick"), otherwise it joins as an alternate ("· added as an alternate"). Keyboard: `M` then arrows, then Enter. |
| moving (`M`) | A neutral glass strip floats over the bottom of the calendar (sticky): "Moving the photo from Sat 19 Sep to **Tue 22 Sep**. Arrows choose the day, ↩ moves it, Esc cancels." It never reflows the months. While moving, a click on a day, the ribbon, Find a date or "Around it" retargets the move instead of selecting. |
| excluded day | Hatch over a 30 % image (legend "Left out"); the inspector toggle reads "Leave this day out" (`X`). |
| run of days | Each day of the run carries the selection ink (`--cursor`) as a 1.5 px frame inside the cell; the active day keeps its loop. The inspector heads with the run ("4 days", "2–5 May 2014", "⇧-click or ⇧←/⇧→ to change it · Esc ends it") over the active day, and its X row reads "Leave these 4 days out" or "Put these 4 days back in" (counting the days with photos). The ribbon's crop-mark feet mark the run instead of the days on screen. |
| after-midnight hint | An alternate taken before 04:00 shows "Taken after midnight · Move to 1 May" (one click, which calls `move_photo_to_day`) as the card's own third line, under the likeness (critique round 5, P2-19). The card's radio is laid over the whole card (a click or a drag anywhere); what the card shows is drawn under it for the eye, and the move link sits above it as its own button. Only for a known time of day (`timeKnown`). |
| date-only photo | Without a known time of day (contract v1.4 `timeKnown: false`: a date-only file name, a file time, a hand-added photo), the card and the Review caption show the date only ("31 Aug"), never "00:00". |
| busy (aligning) | Read-only: the selection and drag affordances hide, and the busy reason shows. |
| stale frames | The ledger's Timelapse row reads "Re-align 3" (`frames.status === 'stale'`; short enough for the row), and the plate changes to `Re-align 3 days`. A restored reference re-analysed once at startup (`REFERENCE_VERSION`) stales every frame the same way: a safelight dot and the re-align plate, never an error. |

### 5. Timelapse (`align` while aligning, then `timelapse`)

- **Layout:**
  - **Player stage (critique round 4: a viewer, not an editing console):** the aligned frame at the largest size the stage allows, positioned left of centre. To its right, a photobook plate caption: the date at hero size ("30 Aug"), the year at display size, the weekday, a hairline, then one facts line, "Day 1,439 of 3,573" (a chosen day is counted as a day, never a frame: critique round 6, P2-7), and "Tightly lined up · 1.2 px" (Lined up, Loosely lined up: words first, units after; critique round 5, P2-12) with a three-band scale (tight up to 1.5× the median fit, ok up to 3×, loose over 3× in safelight; the sheet's outlier rule uses the same bands); the line is a button whose popover explains the measure (the face's five points against the reference's, in output px, and the band edges against the median). Then the **Look** pair (Onion skin, Even light: their chips, popovers, split carets, pressed style and keys) and, when light is evened, "Brightened ⅔ stop" (Darkened 1⅓ stops, Already even) over the zone wedge labelled "From zone 5 to 5⅔". The date, year and weekday follow the playhead at frame rate (written through a ref, tabular figures); the facts line follows the settled playhead.
  - **Filmstrip:** a contact strip of up to 15 neighbouring frames under the stage (never wider than the stage), lying on the table with the print shadow (`--shadow-print`) in both themes (critique round 5, P2-18), frame numbers as edge print, the current one marked ▸ and ringed in the rebate's ink; one tab stop (←/→, ⇧ for 10, Home/End move the playhead).
  - **Transport:** under the filmstrip, playback only (about 360 px): previous, the play disc, next, the timecode in the ledger's length format ("1:23 / 3:00"), J/K/L rate, and the pace chip; Loop is a switch in the pace popover. Each control's tooltip carries its key: Play (Space), Previous frame (←), Next frame (→), Pace and loop (J, K, L shuttle).
  - **While playing** the filmstrip fades out (opacity, `--dur-base`) and folds away, and the frame grows into its place by transform (FLIP, 360 ms `--ease-sheet`), never by animating size; its images are sized for the playing width in both states, so Space never refetches the ring buffer. The strip stays frozen while hidden and catches up on pause.
  - **Lights-out (signature moment 1):** while playing and still, the room — sidebar, toolbar, inspector, transport, the caption except date and year, and the ribbon except its playhead — fades to 8 % over 360 ms (`html[data-lights="out"]`, opacity only). A pointer move, key, wheel or focus change restores it, and it dims again after 2 s of stillness; a region holding keyboard focus never dims. Reduced motion: 120 ms. In the light theme the table switches off too (critique round 5, P1-8): a fixed scrim fades the room to Z1 at 92 % over `--dur-slow` (lifted over `--dur-base` on wake); the frame, the hero date and year and the ribbon's playhead stay above it, their ink turning to the darkroom's (Z9/Z7) as the room passes mid-grey. The ribbon's top hairline dims with the room. After 2 s of stillness the pointer hides; a move brings it back. A focused region with its own surface rises above the scrim; focus in the toolbar or the plate keeps the table lit. The plate's other parts (facts, fit, Look pair and their hairlines) sit above the scrim, so in light they go out entirely rather than to 8 % (`--above-dim`: 0 in light, 0.08 in dark), and the ribbon keeps one playhead mark, the focus track's (critique round 6, P2-6).
  - **The print becomes the film (signature moment 3):** the day on show travels by name (`ft-day-…`): the selected Days cell's aligned frame grows into the player frame and back, a poster of the frame painted under the canvas and the transition waiting for it (at most 250 ms); the playhead's day becomes the Days selection whenever the player settles, so Timelapse → Days shrinks into that day's cell. **F** lifts the same frame to the full window with the date burned into the print at display size (regular weight, on-photo ink over `--on-photo-scrim` along the print's foot, so it reads on the brightest frame: critique round 6, P2-8) (F, Esc and the backdrop click run in a View Transition); the viewer is a dialog that takes focus and gives it back.
  - **Decade ribbon** as the scrubber: click or drag anywhere, and the playhead is chinagraph.
- **Toolbar:** View segmented (Player · Sheet), inspector toggle, and the plate `Export… E`.
- **Inspector (hidden by default):** per-frame adjust (dx, dy, scale, rotation with live re-render via `set_frame_adjustment`), "Replace this day's photo" (jumps to Days at that date), "Leave this day out".
- **Sheet view:** a virtualised contact sheet of every aligned frame. Alignment outliers (`residualPx` > 3× the median) carry a safelight corner, and there is a sort-by-fit toggle.

| State | Treatment |
|---|---|
| default (paused) | As described. Space plays at the video pace (contract `Pace`); playback renders on a `<canvas>` from a ±48-frame `ImageBitmap` ring buffer, per §8. |
| aligning | The stage shows the newest finished frame; the caption block shows "Aligning 1,204 of 3,547 · newest frames appear as they finish" with the sweep line; the filmstrip fills with develop-in frames (image opacity over the latent rebate tone, never a canvas-coloured overlay); the transport dims; the plate becomes `Stop ⌘.`. The ledger row shows the meter. |
| onion (`O`) | The previous frame (or the reference frame, chosen in the Onion popover) overlays at 50 % (adjustable 0–100 %), together with the template. The legend chip reads "Onion skin: previous day at 50%". `D` switches to difference blend, `A` toggles the anchor dots (`FramesView.referenceAnchors`). |
| even light (`N`) | Toggles `set_look` between off and the last-used mode. Its popover offers Exposure / Exposure and colour and Strength. (A/B by holding `N` is not built yet.) |
| align failures | After align, a dismissible inline list in the caption column ("6 days couldn't be aligned"; days, not frames: critique round 6, P2-7), each entry linking to its day. |
| no frames | Unreachable (the ledger row is locked with "After the days"). |

### 6. Export sheet

- **Layout:** a preview (the current frame with its burned-in caption, at the selected size) beside a right-aligned label form:
  - **Format:** Video (MP4) / Frames (PNG).
  - **Size:** `Resolution` chips 720p · 1080p · 4K · Source, with pixel dimensions in help text. Chips larger than the masters are disabled with the reason "Frames were aligned at 1080p…".
  - **Pace:** coupled days-a-second ↔ length fields with a link toggle; the last-edited field sets `Pace.mode`, and the feasible range comes from `lib/video.ts`. **One pace everywhere:** the pace is days a second, the same value the ledger ("5:59 · 10 days/s") and the transport's pace chip show, and the player plays the export's own timeline (blends and holds) at the export's frame rate, so the preview lasts as long as the video. An edit shows everywhere at once and is saved with `set_video_settings` (contract v1.5) after 400 ms of quiet (`state/video.ts`); only the newest save lands, a refusal keeps the edit on screen with the backend's reason ("Not saved. …", in the sheet and the pace popover), and only Start over drops an unsaved edit (before it resets; a new folder keeps it, since the settings belong to the session). A session read already in flight when a save lands is cancelled and repeated, so it can't bring the old settings back.
  - **Date caption:** a switch plus a position picker (3×2 = the six `CaptionPosition` values, 24 px targets holding 8 px dots), a format chip (strftime presets that preview a real date), and a size chip.
  - **Even out light and colour:** mirrors the session look.
  - **More options** (folded; the toggle names their values, "Blend 2 · Hold last 1 s · High quality"):
    - **Between days:** Cut / Blend 2 / Blend 4 / Blend 8 (`Crossfade.frames`). Changing it keeps the pace; the output frame rate follows (days a second × (1 + blend frames)) and is named only here, in the help ("2 video frames fade each day into the next: the video runs at 30 fps") and the footer. A blend that would need more than 60 fps at the pace is disabled with the reason, and struck through like a size larger than the frames.
    - **Hold:** first and last, in seconds.
    - **Quality:** Small / Standard / High / Max (`low` … `max`; a custom bitrate shows as its own choice).
  - Segmented tracks hug their options; they never stretch across the column.
- **Under the preview:** the export as facts (Video H.264 · Size · Frame rate · Length with holds · File size ≈); help copy wraps `pretty`. File size ≈ is computed client-side: bits per pixel for photo, blend and hold frames at the preset, × 1.15 when Even light is off (an unevened decade costs more bits). It is calibrated on four exports and errs high (0 to +3 %; critique round 5, P1-7); a custom bitrate stays exact.
- **The sheet counts days** (critique round 5, P1-7). "Frames" in the sheet are only ever the video's own, named "video frames" (blend help); while encoding, the video is given by its length, not a frame count that reads as a typo for the days (critique round 6, P2-7). Subtitle: "3,573 days · 1 Sep 2012 – 31 Aug 2022". Hold fields: "Hold the first day" / "Hold the last day".
- **Footer:** only `Cancel` and `Export… ⌘↩`, which opens `pick_video_path`. ⌘↩ exports from anywhere while the sheet is open, even when focus has left it (a stacked primary action).
- **Frames format** swaps the timing, crossfade and caption fields for PNG / JPEG + quality + "Never overwrite existing files" (`overwrite: false`, default), and picks a folder.

| State | Treatment |
|---|---|
| settings | As described. |
| encoding | The sheet morphs to fit (critique round 4: it kept the settings' height, 60 % empty): a 136 px print on latent film (the rebate lifted 12 % toward Z10, never `--sunken`) steps to the day being written about once a second, each new image cross-fading in over `--dur-xfade` (the first develops), beside "Encoding day 767 of 3,573" at `--text-heading` (numerals in the data font) with "2:59.6 of video · 60 fps · about 52 s left" as the data line (critique round 6, P2-7), over a 2 px meter the width of the sheet and `Stop ⌘.` (critique round 5, P1-7 and P2-16). The ledger's Timelapse row reads "Encoding · 52 s left". |
| done | **Saved as a photobook spread (signature moment 5):** the decade as its first and last days, about 220 px tall (wide frames capped at 320 px wide), on film with edge print "2012·09·01 ▸ 2022·08·31" (the dates are also in the images' alt text). It is one sequence, started once the window is visible and focused, so a long background encode still plays its moment when you come back: the first print develops once its image is in, the last 240 ms later, the pen ticks across the gutter at 60 % of the last print's develop (only once both images are in), then "Saved · 2:59.6 · 648 MB" and the file name arrive as the pen lifts (a 2 s cap covers a missing image). Reduced motion keeps the order without movement. The facts sit at the spread's foot and wrap under it when there is no room (critique round 5, P2-11). Actions: `Show in Finder` (quiet, `reveal_path`), `Done` (quiet), and the plate **`Play ⌘↩`**, which opens the saved video in the default player (contract v1.7 `open_path`; a refusal shows its reason and the sheet stays). The spread itself is the in-sheet "Watch here" (a glass cue with a play icon over the gutter on hover and focus): a click closes the sheet and plays the timelapse in the player from the first day, bringing the player back from the Sheet view first. After a frames export, `Done ⌘↩` is the plate. A closing sheet stops being modal at once, so the screen's keys work during its exit. |
| failed / cancelled | An inline stop notice with the message (e.g. "The disk is full. Free some space and try again."), with Try again keeping the settings. The partial file is gone (D13), and the copy says so. |

## Interaction details

- **Crop tool:**
  - Drag inside to move, corner brackets to resize, aspect-locked except for Free (port of the legacy math, `lib/crop.ts`).
  - Arrows nudge by 1 px (⇧ 10 px). `L` levels the eyes (applies `autoRotationDeg` only when it differs from the current rotation by more than 0.3°; within that the eyes read as level everywhere: the ledger, the readouts and the inspector), `C` centres the face, `R` resets.
  - The rule-of-thirds grid appears only while dragging.
  - Commit with `set_reference_crop` 150 ms after the drag ends or after keyboard idle. Optimistic: the crop moves instantly, and the template re-draws from the returned detection.
  - The canvas preview fills the available stage, never a fixed 380 px.
- **Keyboard-first review:** decisions apply in under 16 ms locally (optimistic) and batch to `set_review_decision` on a 300 ms idle, or immediately on navigation away. The undo stack is per session view. The queue keeps the current item centred (`scrollIntoView` with `block: nearest`, no smooth scroll under reduced motion).
- **Calendar and drag-to-reassign:**
  - The calendar is a `role="grid"` per month with a roving tabindex. `←/→` previous/next day, `↑/↓` previous/next photo of the day (contract map), `1–9` pick, `X` exclude, `M` move.
  - **Runs of days (critique round 6, P1-4):** ⇧-click, ⇧Space on a focused day, or ⇧←/⇧→ extend a run from the selected day (the anchor) to the new one; a plain click or arrow, Esc, a move (`M`) or any other way of pointing at a day ends it. The grids are `aria-multiselectable`, and every day of the run is `aria-selected`. X (or the inspector row) applies to the whole run: it leaves every day with a photo out while any of them is still in, else puts them all back, as one `set_day_excluded` after another (no bulk command), never two passes at once and nothing while a job runs; one toast says what changed ("Left 4 days out") with one Undo that restores each day as it was. A refusal stops the pass with the backend's reason and no Undo; the days done before it stay done.
  - Moves use `@dnd-kit/core` with a pointer sensor and a `DragOverlay` ghost; the keyboard path is the explicit move mode (`M`, arrows, ↩ to drop, Esc to cancel), not dnd-kit's keyboard sensor, whose Space/Enter pick-up would collide with choosing an alternate. Drag announcements name dates, not photo ids. HTML5 DnD is never used (D14).
  - Drop targets are any day cell, including empty ones.
- **Virtualised grids (3,600+ items):**
  - TanStack Virtual with fixed row heights: contact strip rows, calendar months (Decade/Year), the review queue, the timelapse sheet.
  - Overscan 2 rows, `content-visibility: auto` on month blocks, ≤ 200 mounted `<img>`.
  - `<img decoding="async" loading="lazy">` with a width bucket of `cssWidth × devicePixelRatio` rounded up to {160, 320, 640, 1280, 2048}, inside a fixed aspect box (no layout shift).
  - Face-centred cells crop the `thumb` image with a CSS transform from `faceBox` (proposal P3).
- **Decade ribbon:**
  - Two canvases redrawn on data change or resize, never per frame while playing (only the playhead layer moves, via a transformed 2 px div).
  - Click or drag scrubs; while scrubbing, the stage shows 320 px previews and settles to 1280 px after 120 ms idle.
  - Hovering a tick shows a loupe tooltip with that day's face (160 px) and date.
  - Keyboard: the range input (←/→ day, PageUp/PageDown month, ⌥←/⌥→ year).
- **Drag and drop onto the window:** `onDragDropEvent` drives the full-window drop overlay on every screen. A drop on a non-Setup screen jumps to Setup first (busy rule permitting).
- **Shared-element transitions:** the View Transitions API (`document.startViewTransition`) morphs a day's picture into the same day's picture on the next screen, named by the day (Days ↔ Timelapse; see Continuity). Each transition is wrapped in a feature check, and reduced motion uses a cross-fade.

## Motion

| Token | Value | Use |
|---|---|---|
| `--dur-press` | 90 ms | active scale |
| `--dur-fast` | 150 ms | hover, toggles |
| `--dur-base` | 220 ms | state changes, onion fade, meters, the new screen arriving |
| `--dur-slow` | 360 ms | sheets, the print's travel, lights-out |
| `--dur-develop` | 700 ms | develop-in |
| `--dur-true-develop` | 900 ms | a live scan frame's develop on a slow scan, on `--ease-develop` (a sigmoid); about four frames of reading as the pace rises, never under 160 ms |
| `--dur-pen` | 360 ms | a chinagraph mark written by the pen |
| `--dur-xfade` | 120 ms | one print or sheet phase giving way to the next, and the encoding print's once-a-second step |
| `--dur-exit-fast` / `--dur-exit` / `--dur-exit-slow` | 100 / 150 / 200 ms | popover / toast and the leaving screen / sheet exits |
| `--ease-out` | cubic-bezier(.16,1,.3,1) | arrivals |
| `--ease-standard` | cubic-bezier(.2,0,0,1) | state changes |
| `--ease-in` | cubic-bezier(.4,0,1,1) | exits (kept short) |
| `--ease-sheet` | cubic-bezier(.32,.72,0,1) | sheets, the print's travel, the frame's grow |
| `--ease-develop` | cubic-bezier(.62,.02,.24,1) | true development |

**Signature moments (critique round 4), each authored once:**
1. **Lights-out playback:** on play, the room fades to 8 % (in light, the table switches off too) and only the frame, the hero date and the ribbon's playhead stay lit; the pointer hides after 2 s; a pointer move restores it (Timelapse).
2. **The verdict:** Y writes a tick on the print's corner, the print flies into its queue slot, and the next pre-decoded print rises from the well; N the same with a strike and greyscale. Forty-one in a row feels like marking a contact sheet with a pen (Review).
3. **The print becomes the film:** a View Transition grows the selected day's aligned frame from its cell into the player frame (the same day at both ends, matching crops), and F lifts the same frame to the full window.
4. **True development:** new scan frames develop in order along one leading edge, on a sigmoid with contrast easing up, and the latent run breathes as one wave toward the leading edge.
5. **Saved as a photobook spread:** the decade as its first and last days, developed one after the other and ticked across the gutter by the pen once both are in, seen when you come back to the window, with Play.
6. **The first photo lands:** the print develops in, the template draws itself over it, and "Face found" is ticked.

**The pen:** a decision mark (tick, strike, the loop around a chosen photo, a pick's underline, the current stage's loop) is written from its first point to its last, a stroke-dashoffset over `--dur-pen` measured in screen pixels (the strokes don't scale), never a left-to-right wipe; only the mark just made is written, marks already there sit.

**Exits** run at about 60 % of the entrance on `--ease-in`: a sheet lifts 10 px and fades over 200 ms, a toast drops 6 px and fades over 150 ms, a popover fades over 100 ms. The leaving element is inert from its first frame, so focus returns and Escape reaches the layer under it at once.

Animated properties are only transform, opacity, clip-path, stroke-dashoffset (the pen) and filter (filter only on the frames that are developing and the Review fill layer; a hover never animates a filter: a day's hover lifts it with a sheen on its own layer, by opacity); `will-change` is set only while an animation runs. There are no page-load choreographies.

**Reduced motion:** durations collapse to 120 ms cross-fades, develop-in becomes instant, the pen becomes a 120 ms fade, the print's travel and the frame's grow stop (screens still cross-fade), sheets and toasts fade without sliding, press nudges (buttons, chips, segments, the Saved spread) and sliding knobs stop, the player never autoplays, scrubbing still works, and indeterminate sweeps become a static bar. Every state change still shows; only movement goes.

## Keyboard map

ARCHITECTURE.md §8 is binding; the additions are marked (+) and are frontend-only (proposal P7). Keys are ignored while typing in a field and while a form control (range, checkbox) or a popover has focus. Enter and Space always belong to a focused button or option. Arrows belong to a focused group: in the Review queue (a listbox) ←/→/Home/End browse the photos and decide nothing; among a day's photos (radios) the arrows choose the next photo and keep focus on it. While a modal sheet is open, only ⌘., Esc, ? (the Keys card shows the sheet's keys) and the sheet's own ⌘↩ (which works wherever focus is, and from a number field commits it first) reach past it.

| Scope | Keys |
|---|---|
| global | ⌘O reference · ⇧⌘O folder · ⌘↩ primary action · Esc close or cancel drag · ⌘. cancel the running job · (+) ⌘1–⌘5 ledger rows · (+) ⌃⌘S toggle sidebar · (+) ⌥⌘I toggle inspector · (+) ? the Keys card (the current screen's keys, then Everywhere) · (+) ⌘/ Help › Keyboard Shortcuts (native menu; shows the Keys card) · (+) ⌘, settings (not built) |
| setup | arrows nudge crop (⇧ ×10) · L level eyes · C centre face · R reset |
| review | → / ↩ / Y keep · ← / N leave out (Backspace alias) · U or ⌘Z undo · Space hold to compare · ⇧A keep all remaining |
| days | ←/→ day · ↑/↓ photo in day · 1–9 pick · X exclude day (or the run) · M move photo · (+) ⇧←/⇧→ (and ⇧-click, ⇧Space) extend a run · (+) Esc end the run · (+) [ / ] previous/next year · (+) ⌘↑/⌘↓ zoom out/in |
| timelapse | Space play/pause · ←/→ frame · ⇧←/⇧→ ±10 · Home/End · J/K/L shuttle · O onion · D difference · A anchors · N even light · F full-screen viewer · E export (+ ⌘E alias) · (+) ⌥←/⌥→ ±1 year · filmstrip (one tab stop): ←/→, ⇧←/⇧→, Home/End |
| scan library | ←/→ photo · ↑/↓ row · Home/End · Enter/Space select (one tab stop) |
| export sheet | ⌘↩ export · Esc cancel (Stop while encoding asks for confirmation) |

## Accessibility

- **Contrast:** AA for all text in both themes (table under Colors). Increased-contrast mode steps hairlines and text-3 up a zone. Score levels and statuses are never colour-only. Edge print (9 px) is always an `aria-hidden` duplicate of an accessible label or `alt`.
- **Focus:** a visible 2 px ink ring (`--focus`) with 2 px offset (inset on photo cells so it is never clipped). Focus order runs toolbar → canvas → inspector → ribbon. A step change never drops focus to `<body>`: it lands on the new screen's region and the screen's name is said politely (see Continuity). Sheets trap focus and return it to the trigger. Popovers use the native `popover` attribute or `<dialog>`.
- **Screen readers:**
  - The ledger is `<nav aria-label="Project">` with `aria-current="page"` and `aria-disabled` plus the reason. Running jobs use `role="progressbar"` with values.
  - Job progress is announced through one polite live region, throttled (at most every 10 % or 15 s, plus start and finish).
  - The calendar is `role="grid"`, with cells labelled "Friday 2 May 2014, 3 photos, your pick".
  - Review announces "Kept. 13 of 41." The player frame alt reads "Frame for 14 August 2014". The ribbon range has `aria-valuetext` set to the date.
  - Edge print and decorative marks are `aria-hidden` duplicates of accessible labels.
- **Targets:** at least 24×24 px (WCAG 2.2 AA 2.5.8); toolbar controls are 30 px. The models notice's Details toggle is 24 px tall; Project options (Start over) stays in the compact rail under the reference. The Decade zoom's weekly faces (about 17 px) rely on the 2.5.8 equivalent exception: the year rows, the ribbon and Year zoom reach the same days.
- **Motion and transparency:** respects `prefers-reduced-motion`, `prefers-reduced-transparency` and `prefers-contrast`.
- **Lights-out is a presentation state:** while the player runs and the pointer is still, the room's text sits at 8 % and fails a contrast check by design, like a player's hidden controls; any pointer move, key or focus change wakes it at once, and a focused region never dims. Every other state passes axe (WCAG 2.2 AA) in both themes.
- **Keyboard parity:** every pointer action has a key path (crop nudge, keyboard dnd-kit moves, ribbon range, onion opacity via arrows in its popover).

## Frontend performance constraints

- **Budgets (ARCHITECTURE.md §11):** < 300 kB gzipped initial JS, < 50 kB CSS, 60 fps (p95 frame ≤ 16.7 ms) while flinging a 3,600-item grid and the calendar, no long task > 50 ms.
- **Dependencies:** React 19, Zustand, TanStack Query/Virtual, dnd-kit, and Phosphor per-icon imports. No CSS framework (tokens + CSS modules or plain CSS) and no animation library. The heavy views (player canvas, export sheet) are lazy-loaded.
- **Animation:** compositor-only properties (see Motion); `will-change` only during a drag or transition.
- **Images:** ids only, immutable `?v=` URLs, width buckets, no base64 anywhere; at most 200 mounted `<img>` and at most 96 decoded bitmaps in the player ring.
- **Canvas:** ribbon and player on `<canvas>`; the ribbon redraws on data change, not per frame.
- **Progress events:** coalesced in `requestAnimationFrame`; the store updates at most once per frame.
- **Fonts:** three `woff2` files, 170 kB total, local only, Bricolage latin preloaded.

## What the UI needs from the IPC contract

Cross-checked against ARCHITECTURE.md §7.3. Everything below exists in the contract unless it is tagged **P#**.

| Screen | Data | Commands / events / routes |
|---|---|---|
| Shell / ledger | `SessionSnapshot` (`reference`, `folder`, `scan`, `counts`, `frames`, `activeJob`, `recents`), job progress | `get_session`, `get_app_info` (`imageBaseUrl`, `parallelism`), job channels, `cancel_job` |
| Reference | `ReferenceState` (`image.fileName/size/autoRotationDeg/face/version`, `crop`, `aspect`, `detection.anchors/faceBox`), `FolderInfo` (`name/path/imageCount/analyzedCount/unsupportedCount`), last-scan date range (from `get_days`) | `pick_reference_photo`, `set_reference_photo`, `set_reference_rotation`, `set_reference_crop`, `pick_source_folder`, `set_source_folder`, `clear_scan_cache`, `reference` route |
| Scan | `ScanProgress` (`done/total/fromCache/confirmed/uncertain/rejected/noFace/failed/currentFile/photosPerSecond/etaMs/recent`), `ScanSummary` | `start_scan`, `thumb?w=320`; **P1** (`recent` items with `version` and `dayKey`) |
| Review | `PhotoSummary[]` for `uncertain`, `PhotoDetail` (`faces`, `matchedFace`, `rawSimilarity`, `path`), `takenAt`, `dateSource`, reference anchors | `get_photos({statuses:['uncertain']})`, `get_photo`, `set_review_decision`, `thumb?w=1280`, `reference/frame` |
| Days | `DayGroup[]` (`photoIds`, `selectedId`, `autoSelectedId`, `manualSelection`, `excluded`), `PhotoSummary` (`takenAt`, `dateSource`, `score`, `dayKey`), face crop | `get_days`, `get_photos`, `select_day_photo`, `move_photo_to_day`, `add_photo_to_day`, `set_day_excluded`, `start_align(render)`; **P3** (`faceBox`) |
| Timelapse | `FramesView` (`status`, `outputSize`, `render`, `look`, `referenceAnchors`, `frames[]` with `version/residualPx/adjust`), `AlignProgress` | `get_frames`, `set_look`, `set_frame_adjustment`, `aligned?w=320/640/1280`, `reference/frame`; **P2** (`recent` with `version`), **P5** (`lookDelta`) |
| Export | `VideoSettings`, `ImageExportSettings`, `VideoProgress`, `VideoSummary`, `ExportProgress`, `ExportImagesSummary` | `pick_video_path`, `start_export_video`, `pick_export_folder`, `start_export_images`, `reveal_path` |

**Proposed contract changes:** exact edits to §7.3, with the Rust mirror to follow.

- **P1 (needed for the live scan view):** replace `ScanProgress.recent: PhotoId[]` with `recent: ScanRecent[]`, adding `export interface ScanRecent { id: PhotoId; version: Version; dayKey: DayKey; status: 'confirmed' | 'uncertain' }`. Without `version`, live-mosaic URLs can't be immutable and get served `no-store`. Without `dayKey`, the decade ribbon can't expose days during the scan, and the only alternative would be polling `get_photos` (megabytes per tick).
- **P2 (needed for the live align view):** replace `AlignProgress.recent: PhotoId[]` with `recent: AlignRecent[]`, adding `export interface AlignRecent { id: PhotoId; version: Version; dayKey: DayKey }`. This is the same reason as P1, for the filmstrip filling during alignment.
- **P3 (needed for face-centred cells):** add `faceBox: Rect | null` to `PhotoSummary` (the matched face's bounds, normalised to the oriented photo; `null` for `noFace`/`failed`). The calendar, the review queue, day alternates and "Around it" then crop `thumb` images to the face with a CSS transform. Without it, a 28 px day cell shows a whole room with the face at about a quarter of the cell, which defeats the signature screen. No new image route is needed.
- **P4 (recommended):** add `'4:5'` to `AspectPreset` (Instagram / Threads portrait maximum; the user already shares there). The prototype uses the contract's 3:4 until this lands.
- **P5 (optional):** add `lookDelta: { exposureEv: number; colorShift: number } | null` to `FrameSummary` (`null` when the look is off), to show "Light evened +⅔ EV" and to sort by correction size. The UI hides that row if this is absent.
- **P6 (frontend-only, `lib/steps.ts`):** make `scan` reachable when `activeJob?.kind === 'scan' || scan.status !== 'none'`. After a scan, the Scan row opens a **library view**: the same contact sheet filtered by status (You · Unsure · Not you · No face) via `get_photos`. That lets the user rescue a false "Not you" with `set_review_decision(['confirmed'])`, which today has no surface.
- **P7 (frontend-only):** the keyboard additions marked (+) above.

## Tauri window configuration (for INTEGRATION)

```jsonc
// tauri.conf.json → app.windows[0]
{ "title": "FaceTimelapse", "width": 1440, "height": 900, "minWidth": 960, "minHeight": 640,
  "titleBarStyle": "Overlay", "hiddenTitle": true,
  "trafficLightPosition": { "x": 22, "y": 24 },   // if supported by the installed Tauri 2.x; the layout already clears the default
  "transparent": true,                              // only with windowEffects; else omit
  "windowEffects": { "effects": ["sidebar"], "state": "followsWindowActiveState" },
  "backgroundColor": "#0f0f0e" }                   // Z0 sRGB fallback; avoids a white flash before first paint
```

Background colour follows the theme at startup (Rust reads the persisted theme or the system appearance). `tauri-plugin-window-state` persists size and position (U18).

## Prototype

- **Committed:** `docs/rewrite/prototype/` (`index.html`, `tokens.css`, `app.css`, `screens.css`, `app.js`, `photos.js`, `fonts/`, `standins/`). Static, no build step: open `index.html` directly. A small control (bottom right; hidden with `&shot=1`) switches screen, state and theme. All imagery is **synthetic** (SVG stand-in portraits and a generated day coverage), and no personal photos are in git.
- **Local-only judging copy** (never committed): `scratchpad/design/proto-real/` (same files, with a `photos.js` that maps the same keys to real photos). The reference is loaded straight from the original via `file://`; the grids use aligned thumbnails produced locally with Apple Vision into the scratchpad.
- **Screenshots** (1440×900 and 1024×700, dark and light, plus state shots): `scratchpad/design/shots-final/`.

## Decisions made without asking (user instruction: no questions)

1. **World:** brief-pinned darkroom / contact sheet, raised by the impeccable seed (ID-booth template, assigned) and by the challengers listed in Overview. No decision page was served. The finish review then tightened chinagraph red to editorial decisions only and spread the contact-strip component to every strip.
2. **Fonts:** Bricolage Grotesque + Martian Mono, after comparing Mona Sans, Archivo, Hubot Sans and Geist in situ.
3. **Accent:** chinagraph red reserved for editorial decisions about photos; focus, selection and playhead are neutral ink. The primary action is a reversed plate, not red.
4. **Default theme:** follow the system. Both themes are designed from physical scenes (darkroom, light table).
5. **Navigation:** a ledger sidebar instead of wizard pills. Align stays inside the Timelapse row.
6. **Aspect in the prototype:** the contract's 3:4 (4:5 proposed as P4).
7. **Motion:** no animation library. CSS + WAAPI + View Transitions.
8. **Scan view:** an editorial sentence at display size instead of metric tiles (impeccable bans the hero-metric template).
9. **Light theme:** a flat lit opal canvas (Z10) inside a darker desk (Z9) with soft print shadows. A backlight vignette or gradient was considered and declined (it would read as a gradient blob).
