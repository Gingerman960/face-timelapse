# timelapse-video

Pure-Rust timelapse MP4 encoder for FaceTimelapse. It turns an ordered
sequence of photos into an H.264 MP4 with no external tools (no ffmpeg at
runtime): frames are decoded, letterboxed or cropped to the output size,
captioned with their date, crossfaded, converted to BT.709 I420, encoded with
Apple VideoToolbox on macOS (hardware, default) or openh264 (everywhere, and the
automatic fallback) and muxed into a fast-start MP4 that plays in QuickTime,
Safari/WebKit, Chrome and VLC.

## API

```rust
pub fn encode_timelapse<S: FrameSource>(
    source: S,
    options: &VideoOptions,
    output: &Path,
    on_progress: impl FnMut(&Progress),
    cancel: &CancelToken,
) -> Result<EncodeSummary, VideoError>;

// Legacy slider coupling (bit-exact with the Electron dialog's `toFixed(2)`).
pub fn duration_for_fps(frame_count: usize, fps: f64) -> Option<f64>;
pub fn fps_for_duration(frame_count: usize, duration_secs: f64) -> Option<f64>;
// The same coupling with crossfades and holds, plus the slider bounds.
impl TimelineSpec {
    pub fn duration_for_fps(&self, fps: f64) -> Option<f64>;
    pub fn fps_for_duration(&self, duration_secs: f64) -> Option<f64>;
    pub fn feasible_duration_range(&self) -> Option<(f64, f64)>;
}
impl Resolution { pub fn output_size(self, src_w: u32, src_h: u32) -> Option<(u32, u32)>; }
impl VideoOptions {
    pub fn validate(&self) -> Result<()>;
    pub fn plan(&self, source_frames: usize) -> Result<TimingPlan>; // fps + frame count + duration
}
```

Inputs implement `FrameSource` (`len()` + an ordered stream of `FrameLoader`
closures that run on the worker pool):

| Source | Use |
|---|---|
| `ImageFiles::new(Vec<ImageInput { path, date }>)` | JPEG/PNG files, EXIF orientation applied |
| `FrameIter::new(iter, len)` / `FrameIter::from_frames(vec)` | in-memory `Frame { width, height, rgb, date }` |
| your own `FrameSource` | lazy work (decode + colour look + resize) parallelised on our pool |

`Progress` (serialisable, camelCase) reports `framesDone`, `framesTotal`,
`encodedSecs`, `totalSecs`, `elapsedSecs`, `etaSecs`, `framesPerSec`; it is
throttled to one callback per 50 ms plus the final frame. `CancelToken` wraps an
`Arc<AtomicBool>` (`CancelToken::from_flag` accepts an existing flag). The
`VideoEncoder` trait abstracts the codec (`OpenH264Encoder`,
`VideoToolboxEncoder` on macOS, and `AutoEncoder`, which adds the fallback).
`EncodeSummary` (camelCase) reports `output`, `width`, `height`, `frames`, `fps`,
`durationSecs`, `bytes`, `elapsedSecs`, `encoder` (`"videotoolbox"` or
`"openh264"`) and `encoderFallback` (why the hardware encoder was not used, or
`null`).

## Options (wire format)

`VideoOptions` is `serde` with camelCase fields and full defaults, so the UI
may send a partial object. It mirrors IPC `VideoSettings` (ARCHITECTURE.md
§7.3/§7.4) plus four optional extras.

```json
{
  "pace": { "mode": "fps", "fps": 10 },            // or { "mode": "duration", "seconds": 60 }
  "resolution": "1080p",                            // "source" | "2160p" | "1080p" | "720p"
  "quality": "high",                                // "low" | "medium" | "high" | "max" | { "bitrate": { "kbps": 8000 } }
  "crossfade": { "frames": 0, "easing": "easeInOut" }, // easing: "linear" | "easeInOut"
  "caption": null,                                  // or { "position": "bottomLeft", "size": 0.045, "format": "%b %-d, %Y" }
  "holdFirstSecs": 0,
  "holdLastSecs": 0,
  "scaleMode": "fit",                               // extra: "fit" (letterbox) | "fill" (crop)
  "background": [0, 0, 0],                          // extra: letterbox colour
  "encoder": "auto",                                // extra: "auto" | "openH264" | "videoToolbox"
  "threads": 0                                      // extra: frame-prep workers, 0 = all cores
}
```

Validation (`VideoError::InvalidOptions` with a user-readable message): fps
1–60, duration 1–120 s, crossfade ≤ 30 frames, holds 0–10 s, bitrate
100–200 000 kbps, caption size 0.01–0.2 of the frame height, caption format a
valid chrono strftime string of ≤ 64 characters. A duration that would need
more than 60 fps (or less than 1) is rejected with the feasible range in the
message; the UI should bound its slider with `feasible_duration_range`.

## Timing rules

* **Legacy parity.** `fps_for_duration(n, d) = Number((n/d).toFixed(2))`,
  `duration_for_fps(n, f) = Number((n/f).toFixed(2))`, reproduced bit-for-bit
  (JavaScript rounds the *exact* binary value half-up: `1.005 → 1.00`,
  `0.125 → 0.13`; Rust's formatter would round ties to even). Tested against
  vectors generated with node.
* **fps is the output frame rate.** Each photo is one frame; a crossfade of
  `c` frames inserts `c` blend frames between neighbours; holds repeat the
  first/last photo for `round(secs × fps)` frames. Total frames
  `n + (n−1)·c + holds`, duration `frames / fps`. With `c = 0` and no holds
  this is exactly the legacy math. `fps_for_duration` subtracts the holds and
  divides the content frames by the remaining time.
* **Exact frame rates.** The 2-decimal fps becomes a reduced fraction; the MP4
  timescale is `num × 2^k ≥ 10 000` with a constant sample delta (30 fps →
  15360/512 like ffmpeg; 29.94 fps → exact `1497/50`). Durations are exact.
* The legacy encoder doubled the last frame's duration as a concat-demuxer
  workaround; here that is an explicit option (`holdLastSecs`, UI default 1 s).

## Output

* H.264 **High profile, CABAC**, 8-bit 4:2:0 (`yuv420p`), `avc1` sample entry,
  SPS/PPS in `avcC` only, no B-frames, IDR every 2 s.
* **BT.709 limited range**, signalled twice: SPS VUI and an MP4 `colr`/`nclx`
  box (plus `pasp` 1:1). Players never have to guess (no green/purple casts or
  crushed blacks). RGB→YUV uses the SIMD kernels of `yuv` (±1 code value vs a
  float reference, no bias).
* **Fast start without a second pass.** The frame count is known up front, so
  the worst-case `moov` size is reserved after `ftyp`; samples stream to disk
  (≈16 bytes of RAM per frame), and `moov` + a `free` pad fill the reservation
  at the end. `stco` switches to `co64` and `mdat` to a 64-bit largesize
  header past 4 GiB (tested with a sparse sink).
* Even dimensions: `source` floors odd sizes like the legacy
  `trunc(iw/2)*2`, presets fit a 3840×2160 / 1920×1080 / 1280×720 box
  oriented like the first frame (portrait sources get a portrait box), keep the
  aspect, and may upscale. `source` never upscales and is capped to the encoder
  limit (3840×2160 / 2160×3840). Frames whose size differs from the first are
  letterboxed (`fit`) or centre-cropped (`fill`). **If you already resize
  frames to the final size, pass `"source"`** so nothing is rescaled.
* Written to a unique `{output}.{pid}-{n}.partial` (created exclusively: an
  existing `.partial` or a planted link is never truncated or followed) and
  atomically renamed on success. On error, cancel or panic that file is
  deleted and an existing file at `output` is untouched. After a crash, an app
  that remembers the target and its old pid can find leftovers with
  `is_partial_name` without touching anyone else's files.
* `replace_existing` (default `true`): replace a file at `output`. With
  `false` nothing is ever replaced — if a file appears there during the
  encode, the video is saved at the first free `{stem}_{n}.{ext}` and
  `EncodeSummary::output` says where. Placement is a hard link (check and
  placement in one step); where links are unsupported (FAT/exFAT, some
  shares) the name is claimed with an exclusive create and renamed onto — the
  only residual window is another process deleting that fresh placeholder
  and creating the same name between two calls. A temporary name that cannot
  be removed afterwards is reported in `EncodeSummary::leftover_partial`.
* `decode_image` (for `ImageFiles`) refuses images over 16,384 px per side or
  150 MP from their header, before any pixel buffer exists
  (`MAX_DECODE_SIDE`, `MAX_DECODE_PIXELS`), and caps the decoder's
  allocations.

### Captions

**Martian Mono** (the app's data face, see DESIGN.md) from the bundled variable
font, set at weight 500 and its most condensed width (`wdth` 75), like film
edge print, with word spaces at 60 % of the mono cell so the date reads as one
unit. `size` is the em height (fraction of the frame height). White text with a
tight dark halo plus a soft drop shadow stays legible on white shirts and dark
rooms alike. Digits sit on a fixed advance (natively, and enforced for any
font), so the caption never jitters from day to day; the default position is
bottom-left for the same reason. Bricolage Grotesque (the UI face) was
compared on real frames at 560–620 weight / 82–92 width: without GPOS kerning
(`ab_glyph` applies only legacy `kern`) its condensed comma-space read
cramped and tabular centring left gaps around the `1`, so the mono won. Masks are rendered on the
worker pool and composited in Y′CbCr **after** crossfade blending, so the date
switches crisply at the dissolve midpoint instead of ghosting. Frames without a
date get no caption. Month names are English (chrono).

## Encoders and quality

`"encoder": "auto"` (default) uses **VideoToolbox on macOS** and **openh264
elsewhere**. On macOS, `AutoEncoder` falls back to openh264 transparently when
the hardware session cannot be created (e.g. a VM without the media engine)
or fails before producing its first frame. It buffers the frames it has fed
the hardware until the first sample comes back, replays them into openh264
and nothing reaches the muxer twice. The reason is reported in
`EncodeSummary.encoderFallback`. `"openH264"` and `"videoToolbox"` force a
backend; the latter has no fallback and is rejected off macOS.

| Preset | openh264 | VideoToolbox |
|---|---|---|
| `low` | constant QP 30 | quality 0.57 |
| `medium` | QP 26 (≈ legacy x264 CRF 23) | 0.67 |
| `high` (default) | QP 22 (≈ x264 CRF 18) | 0.76 |
| `max` | QP 18 | 0.82 |
| `{bitrate}` | openh264 bitrate RC (approximate: frame skipping stays off so no frame is ever dropped) | `AverageBitRate` |

VideoToolbox values were calibrated so each preset matches the openh264 preset.
Two sets of 150 real photos (2019 and 2015) at 1440×1080, every frame a
different photo (the hard case), luma PSNR against the source, encoder alone:

| Preset | openh264 set A | VideoToolbox set A | openh264 set B | VideoToolbox set B |
|---|---|---|---|---|
| `low` | 4.65 MB, 40.09 dB | 4.03 MB, 40.12 dB | 5.16 MB, 40.01 dB | 4.43 MB, 40.02 dB |
| `medium` | 7.22 MB, 41.84 dB | 6.66 MB, 41.95 dB | 8.08 MB, 41.91 dB | 7.43 MB, 42.01 dB |
| `high` | 12.31 MB, 43.77 dB | 11.83 MB, 43.94 dB | 13.62 MB, 43.97 dB | 13.08 MB, 44.13 dB |
| `max` | 20.31 MB, 45.79 dB | 18.03 MB, 45.51 dB | 22.41 MB, 45.96 dB | 19.86 MB, 45.65 dB |
| speed | 152–237 fps | 426–467 fps | | |

VideoToolbox lands within −0.31…+0.17 dB of openh264 at every preset with
4–14 % smaller files. For reference, on set A x264 `fast` CRF 23 (the legacy
setting) gives 5.7 MB at 41.1 dB and CRF 18 gives 11.9 MB at 43.7 dB, so both
encoders are within a few percent of x264 `fast` at equal PSNR.
Note: when checking files like these with ffmpeg's `psnr` filter, decode both
sides to raw first; our file is colour-tagged and ffmpeg otherwise converts one
input before comparing, which costs several dB of "error".

**openh264** is built from source through `openh264-sys2` (the sys layer of the
`openh264` crate) and driven through its raw API, because the high-level crate
hard-codes single-slice CAVLC. We enable CABAC/High profile (~14% smaller),
fixed-count slices with one encoder thread per slice (up to 8, ≥ 8 macroblock
rows each), constant-QP presets and VUI colour signalling. openh264's log
output is captured through its trace callback and appended to
`VideoError::Encoder` messages instead of being printed.

**VideoToolbox** (always compiled on macOS through the objc2 bindings): a
hardware-preferred session with frame reordering off (no B-frames, samples in
presentation order), High/auto level, constant-quality presets, BT.709
primaries/transfer/matrix, a max keyframe interval of 2 s, and an I420→NV12 copy
into the session's IOSurface-backed pixel buffer pool. Output callbacks run on a
VideoToolbox thread and are drained after every frame. SPS/PPS come from the
format description and land in `avcC`, so files stay `avc1`, moov-first and
BT.709-tagged exactly like openh264's (the integration tests run the same
ffprobe checks against both backends). Not yet tried on Intel Macs (an
unsupported property makes session creation fail, which triggers the fallback).

## Performance (Apple M3 Max, release)

| Workload | openh264 | VideoToolbox (macOS default) |
|---|---|---|
| Pipeline, frames already at size, caption on: 1080×1080 | 346 fps | 545 fps |
| … 1920×1080 | 198 fps | 330 fps |
| … 3840×2160 | 49 fps | 87 fps |
| 300 real 12 MP JPEGs → 1440×1080, crossfade 2, caption (898 frames) | 190 fps (4.7 s) | 350 fps (2.6 s) |
| same → 2880×2160 | 53 fps (17.0 s) | 138 fps (6.5 s) |
| openh264 alone, 1080p, 1 / 2 / 4 / 8 threads | 59 / 101 / 200 / 204 fps | |
| openh264 alone, 2160p, 1 / 2 / 4 / 8 threads | 15 / 29 / 46 / 51 fps | |
| RGB→I420 1080p | 0.26 ms | |
| Lanczos 4032×3024 → 1440×1080 | 34 ms | |

With real photos at 1080p, JPEG decoding (not the encoder) limits VideoToolbox.

Frame preparation (decode, resize, caption, colour conversion) runs on a
dedicated rayon pool through an ordered window of in-flight loaders (capped by
a 1 GiB memory budget); a bounded channel of 8 frames feeds the encoder on the
calling thread, so preparation overlaps encoding and memory stays bounded.

## Testing

```text
cargo test -p timelapse-video     # unit + integration (ffmpeg checks and VideoToolbox variants skip if unavailable)
cargo test -p timelapse-video --release --test real_photos -- --ignored --nocapture
cargo bench -p timelapse-video --bench encode
cargo run --release -p timelapse-video --example sample_timelapse -- \
    --dir "/path/to/photos" --out /tmp/sample.mp4 --count 300 --landscape \
    --resolution 1080p --crossfade 2 --fps 24 --caption bottomLeft --hold-last 1
```

* Unit tests: coupling math vs node vectors, crossfade/hold timelines, even
  size/aspect math, RGB→YUV vs a float reference, blending, caption layout,
  tabular digits, condensed/monospaced font axes, YUV vs RGB caption
  compositing, legibility on white, MP4 box layout, fast-start reservation and
  fallback, >4 GiB `co64`/largesize, Annex B→AVCC, `avcC`, partial-file
  commit/cleanup, progress throttling, VideoToolbox keyframes/parameter sets,
  and every `AutoEncoder` fallback path (creation failure, early encode
  failure with replay, failed or silent flush, slow-but-healthy primary,
  later errors propagating).
* Integration (verified with ffprobe/ffmpeg when installed), run for openh264
  and, when a hardware session can be created, VideoToolbox: codec/profile/
  `pix_fmt`/colour tags/frame count/duration/keyframes/moov-first, PSNR per
  quality preset, colour round trip, crossfade luma ramp; plus fractional fps
  from a duration, odd/mixed frame sizes, captions, bitrate mode, `auto`
  backend selection. The pipeline-behaviour tests (progress, cancellation from
  the callback and from another thread, decode errors, cleanup) use the default
  `auto` encoder, so they exercise VideoToolbox on macOS.
* `real_photos` (ignored): stride-samples 300 photos from `FT_PHOTOS_DIR`
  (default: the maintainer's library when present) and asserts ≥ 30 fps.
* Line coverage ≈ 97% (`cargo llvm-cov -p timelapse-video`).

## Licences and patents

* This crate: MIT (workspace licence).
* **openh264**: Cisco's source code is BSD-2-Clause; `openh264-sys2` /
  `openh264` are BSD-2-Clause. **H.264 is patent-encumbered.** Cisco pays the
  MPEG LA (now Via LA) AVC royalties only for its *prebuilt binary* downloaded
  from Cisco at runtime; a build compiled from source, like this one, is **not**
  covered by Cisco's licence. Whoever distributes the app is responsible for
  any AVC patent licence their distribution needs (Via LA's AVC terms have a
  free tier for small unit volumes, but check the current terms). On macOS the
  default encoder is VideoToolbox, Apple's OS-provided encoder, so openh264
  only runs there as a fallback; Windows/Linux builds use openh264. Another
  option is `openh264-sys2`'s `libloading` feature to download Cisco's binary
  at runtime (conflicts with the app's offline principle, so not done). This
  note is not legal advice.
* **Martian Mono** variable (`assets/fonts/MartianMono-Variable.ttf`,
  unmodified `MartianMono[wdth,wght].ttf` from `google/fonts` `ofl/martianmono`,
  SHA-256 `c3467843…fb1b22e7`), © 2021 The Martian Mono Project Authors
  (Evil Martians), SIL Open Font License 1.1 with no Reserved Font Name
  (`assets/fonts/OFL-MartianMono.txt`, identical to the copy in the design
  prototype). The OFL allows bundling and embedding; the licence text must ship
  with the app (ARCHITECTURE.md §14 lists Martian Mono).
* Other dependencies: `yuv` (BSD-3-Clause OR Apache-2.0), `fast_image_resize`,
  `image`, `serde`, `thiserror`, `rayon`, `chrono` (MIT OR Apache-2.0),
  `ab_glyph` (Apache-2.0), objc2 crates (MIT, macOS only).

## Design notes

* **Muxer.** A purpose-built writer (~900 lines with tests) instead of a crate:
  `muxide` buffers every encoded frame in RAM until the end and stops at 4 GiB,
  `mp4` (alfg) is unmaintained since 2023 and cannot write moov-first, and
  `minimp4` is C. Knowing the frame count lets us reserve `moov` and stream,
  which none of them do.
* **Why openh264-sys2 directly.** See "Encoders" above: CABAC, slices/threads,
  constant QP and colour VUI are not reachable through the high-level crate.
* **Colour in Y′CbCr.** Crossfades and captions are blended in Y′CbCr; since
  the RGB→Y′CbCr transform is affine, this equals blending gamma-encoded RGB.
