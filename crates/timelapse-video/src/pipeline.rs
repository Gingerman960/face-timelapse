//! The encode pipeline.
//!
//! ```text
//!  calling thread ──► load frame 0 (decides output size) ──► encoder loop ──► MP4 writer
//!                                                               ▲
//!  producer thread ── ordered window of FrameLoaders ──► rayon pool:
//!                     decode → resize/letterbox → caption → RGB→I420
//!                  ── sequencer: holds / keys / crossfade blends ──► bounded channel
//! ```
//!
//! Frame preparation runs in parallel on a dedicated rayon pool while the
//! single-threaded encoder consumes frames in order; a bounded window of
//! in-flight preparations and a bounded channel cap memory use.

use std::collections::VecDeque;
use std::io::BufWriter;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::mpsc::{Receiver, SyncSender, sync_channel};
use std::time::Instant;

use serde::Serialize;

use crate::caption::{CaptionRenderer, PlacedCaption};
use crate::compose::Compositor;
use crate::encoder::{EncodedSample, EncoderSettings, VideoEncoder, create_encoder};
use crate::error::{Result, VideoError};
use crate::mp4::{Mp4Writer, TrackConfig};
use crate::options::VideoOptions;
use crate::output::PartialFile;
use crate::progress::{CancelToken, PROGRESS_INTERVAL, Progress, ProgressTracker};
use crate::source::{Frame, FrameLoader, FrameSource};
use crate::timing::{FrameRef, Timeline};
use crate::yuv420::YuvFrame;

/// Prepared frames buffered between the sequencer and the encoder.
const ENCODER_QUEUE: usize = 8;
/// Frames prepared ahead of need beyond one per worker thread.
const PREP_LOOKAHEAD: usize = 2;
/// Upper bound on memory used by in-flight frame preparations.
const PREP_MEMORY_BUDGET: usize = 1 << 30;
/// Output write buffer.
const WRITE_BUFFER: usize = 1 << 20;

/// What was produced.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EncodeSummary {
    /// Final video path.
    pub output: PathBuf,
    /// Video width.
    pub width: u32,
    /// Video height.
    pub height: u32,
    /// Encoded frames (including crossfades and holds).
    pub frames: u64,
    /// Frame rate.
    pub fps: f64,
    /// Video duration in seconds.
    pub duration_secs: f64,
    /// File size in bytes.
    pub bytes: u64,
    /// Wall-clock encoding time in seconds.
    pub elapsed_secs: f64,
    /// Encoder implementation used (`"videotoolbox"` or `"openh264"`).
    pub encoder: String,
    /// Why the preferred encoder was replaced by openh264, if it was
    /// (`EncoderBackend::Auto` on macOS when the hardware session fails).
    pub encoder_fallback: Option<String>,
    /// The temporary `.partial` name, if it could not be removed after the
    /// video was placed without replacing (`replace_existing: false`).
    pub leftover_partial: Option<PathBuf>,
}

impl EncodeSummary {
    /// Average throughput in output frames per second.
    #[must_use]
    pub fn frames_per_sec(&self) -> f64 {
        if self.elapsed_secs > 0.0 {
            self.frames as f64 / self.elapsed_secs
        } else {
            0.0
        }
    }
}

/// Encodes `source` into an MP4 at `output`.
///
/// The file is written to a temporary sibling and renamed into place only on
/// success; on error or cancellation nothing is left behind and an existing
/// file at `output` is untouched. `on_progress` is called on the calling
/// thread at most every [`PROGRESS_INTERVAL`] and always for the last frame.
///
/// # Errors
/// [`VideoError::Cancelled`] if `cancel` fires, [`VideoError::InvalidOptions`]
/// / [`VideoError::EmptySource`] for bad input, or any decode, encoder, mux or
/// I/O error.
pub fn encode_timelapse<S: FrameSource>(
    mut source: S,
    options: &VideoOptions,
    output: &Path,
    mut on_progress: impl FnMut(&Progress),
    cancel: &CancelToken,
) -> Result<EncodeSummary> {
    let started = Instant::now();
    let plan = options.plan(source.len())?;
    check_cancel(cancel)?;
    let first = load_first(&mut source)?;
    let (width, height) = options
        .resolution
        .output_size(first.width, first.height)
        .ok_or_else(|| VideoError::InvalidFrame {
            index: 0,
            reason: "zero-sized frame".into(),
        })?;
    let stage = Stage {
        compositor: Compositor::new(width, height, options.scale_mode, options.background),
        caption: options
            .caption
            .as_ref()
            .map(|c| CaptionRenderer::new(c, width, height))
            .transpose()?,
        keep_plain: options.crossfade.frames > 0,
    };
    let fps = plan.frame_rate.as_f64();
    let mut encoder = create_encoder(
        options.encoder,
        &EncoderSettings::new(width, height, fps, options.quality),
    )?;
    let total = plan.total_frames();
    let (partial, file) = PartialFile::create(output)?;
    let (timescale, sample_delta) = plan.frame_rate.mp4_timescale();
    let writer = Mp4Writer::new(
        BufWriter::with_capacity(WRITE_BUFFER, file),
        TrackConfig {
            width,
            height,
            timescale,
            sample_delta,
            expected_samples: total,
        },
    )?;
    let pool = build_pool(options.threads)?;
    // Decoded source + RGB canvas + up to two I420 copies (captioned and plain).
    let per_task = first.rgb.len() + width as usize * height as usize * 6;
    let window = (PREP_MEMORY_BUDGET / per_task.max(1))
        .clamp(2, pool.current_num_threads() + PREP_LOOKAHEAD);
    let mut tracker = ProgressTracker::new(total, fps, PROGRESS_INTERVAL);

    let (tx, rx) = sync_channel::<Result<Arc<YuvFrame>>>(ENCODER_QUEUE);
    let (timeline, stage_ref, pool_ref, source_ref) = (&plan.timeline, &stage, &pool, &mut source);
    let writer = std::thread::scope(|scope| {
        // `tx` moves into the producer so the channel closes when it finishes.
        let producer = scope.spawn(move || {
            let keys = KeyStream::new(source_ref, first, timeline.source_frames, window);
            if let Err(e) = produce(keys, timeline, stage_ref, pool_ref, &tx, cancel) {
                // The consumer may already be gone; then nobody needs the error.
                let _ = tx.send(Err(e));
            }
        });
        let consumed = consume(
            rx,
            encoder.as_mut(),
            writer,
            total,
            &mut tracker,
            &mut on_progress,
            cancel,
        );
        let joined = producer.join();
        match (consumed, joined) {
            (Err(e), _) => Err(e),
            (Ok(_), Err(_)) => Err(VideoError::Internal("frame preparation panicked".into())),
            (Ok(w), Ok(())) => Ok(w),
        }
    })?;
    let file = writer
        .finish()?
        .into_inner()
        .map_err(|e| VideoError::io("writing video data", e.into_error()))?;
    check_cancel(cancel)?;
    let (output, bytes, leftover_partial) = if options.replace_existing {
        (output.to_path_buf(), partial.commit(file)?, None)
    } else {
        let c = partial.commit_new(file)?;
        (c.path, c.size, c.leftover)
    };
    Ok(EncodeSummary {
        output,
        width,
        height,
        frames: total,
        fps,
        duration_secs: plan.duration_secs(),
        bytes,
        elapsed_secs: started.elapsed().as_secs_f64(),
        encoder: encoder.name().to_owned(),
        encoder_fallback: encoder.fallback_reason().map(str::to_owned),
        leftover_partial,
    })
}

fn check_cancel(cancel: &CancelToken) -> Result<()> {
    if cancel.is_cancelled() {
        Err(VideoError::Cancelled)
    } else {
        Ok(())
    }
}

fn load_first<S: FrameSource>(source: &mut S) -> Result<Frame> {
    let expected = source.len();
    let loader = source
        .next_loader()
        .ok_or(VideoError::SourceExhausted { expected, got: 0 })?;
    let frame = loader()?;
    frame.validate(0)?;
    Ok(frame)
}

fn build_pool(threads: usize) -> Result<rayon::ThreadPool> {
    let threads = if threads == 0 {
        std::thread::available_parallelism().map_or(1, |n| n.get())
    } else {
        threads
    };
    rayon::ThreadPoolBuilder::new()
        .num_threads(threads)
        .thread_name(|i| format!("timelapse-prep-{i}"))
        .build()
        .map_err(|e| VideoError::Internal(format!("cannot start worker threads: {e}")))
}

/// Per-frame preparation shared by all workers.
struct Stage {
    compositor: Compositor,
    caption: Option<CaptionRenderer>,
    /// Keep an uncaptioned copy of each key for crossfade blending.
    keep_plain: bool,
}

/// One prepared source photo.
struct PreparedKey {
    /// The frame as shown on its own (caption composited).
    shown: Arc<YuvFrame>,
    /// Uncaptioned pixels, kept only when blends need them.
    plain: Option<Arc<YuvFrame>>,
    /// The caption drawn on `shown`, re-applied on top of blends.
    caption: Option<Arc<PlacedCaption>>,
}

impl PreparedKey {
    fn blend_source(&self) -> &YuvFrame {
        self.plain.as_deref().unwrap_or(&self.shown)
    }
}

impl Stage {
    fn prepare(&self, index: usize, loader: FrameLoader) -> Result<PreparedKey> {
        let frame = loader()?;
        frame.validate(index)?;
        let date = frame.date;
        let canvas = self.compositor.compose(frame)?;
        let plain = YuvFrame::from_rgb(&canvas, self.compositor.width(), self.compositor.height())?;
        drop(canvas);
        let caption = match (&self.caption, date) {
            (Some(renderer), Some(date)) => Some(Arc::new(renderer.place(date))),
            _ => None,
        };
        let Some(placed) = caption else {
            return Ok(PreparedKey {
                shown: Arc::new(plain),
                plain: None,
                caption: None,
            });
        };
        let mut shown = plain.clone();
        placed.apply(&mut shown);
        Ok(PreparedKey {
            shown: Arc::new(shown),
            plain: self.keep_plain.then(|| Arc::new(plain)),
            caption: Some(placed),
        })
    }

    /// A crossfade frame: blend the uncaptioned photos, then draw the date
    /// of whichever photo dominates, so text switches crisply mid-dissolve.
    fn blend(&self, a: &PreparedKey, b: &PreparedKey, weight: f32) -> Result<YuvFrame> {
        let mut frame = YuvFrame::blend(a.blend_source(), b.blend_source(), weight)?;
        let caption = if weight < 0.5 { &a.caption } else { &b.caption };
        if let Some(caption) = caption {
            caption.apply(&mut frame);
        }
        Ok(frame)
    }
}

/// Prepared key frames in source order, computed in parallel within a window.
struct KeyStream<'a, S> {
    source: &'a mut S,
    first: Option<Frame>,
    total: usize,
    window: usize,
    submitted: usize,
    received: usize,
    pending: VecDeque<Receiver<Result<PreparedKey>>>,
    recent: VecDeque<(usize, Arc<PreparedKey>)>,
}

impl<'a, S: FrameSource> KeyStream<'a, S> {
    fn new(source: &'a mut S, first: Frame, total: usize, window: usize) -> Self {
        Self {
            source,
            first: Some(first),
            total,
            window,
            submitted: 0,
            received: 0,
            pending: VecDeque::with_capacity(window),
            recent: VecDeque::with_capacity(2),
        }
    }

    /// Keeps `window` preparations in flight.
    fn refill<'s>(&mut self, scope: &rayon::Scope<'s>, stage: &'s Stage, cancel: &'s CancelToken) {
        while self.pending.len() < self.window && self.submitted < self.total {
            let loader: FrameLoader = match self.first.take() {
                Some(frame) => Box::new(move || Ok(frame)),
                None => match self.source.next_loader() {
                    Some(loader) => loader,
                    None => return,
                },
            };
            let index = self.submitted;
            let (done_tx, done_rx) = sync_channel(1);
            scope.spawn(move |_| {
                let result = if cancel.is_cancelled() {
                    Err(VideoError::Cancelled)
                } else {
                    stage.prepare(index, loader)
                };
                // The receiver only disappears if the producer already failed.
                let _ = done_tx.send(result);
            });
            self.pending.push_back(done_rx);
            self.submitted += 1;
        }
    }

    /// Key frame `index` (must be requested in non-decreasing order).
    fn get<'s>(
        &mut self,
        index: usize,
        scope: &rayon::Scope<'s>,
        stage: &'s Stage,
        cancel: &'s CancelToken,
    ) -> Result<Arc<PreparedKey>> {
        while self.received <= index {
            self.refill(scope, stage, cancel);
            let next = self
                .pending
                .pop_front()
                .ok_or(VideoError::SourceExhausted {
                    expected: self.total,
                    got: self.received,
                })?;
            let frame = next.recv().map_err(|_| {
                VideoError::Internal("a frame worker stopped unexpectedly".into())
            })??;
            self.recent.push_back((self.received, Arc::new(frame)));
            if self.recent.len() > 2 {
                self.recent.pop_front();
            }
            self.received += 1;
        }
        self.refill(scope, stage, cancel);
        self.recent
            .iter()
            .find(|(i, _)| *i == index)
            .map(|(_, f)| Arc::clone(f))
            .ok_or_else(|| {
                VideoError::Internal(format!("key frame {index} requested out of order"))
            })
    }
}

/// Walks the timeline and feeds the encoder channel.
fn produce<S: FrameSource>(
    mut keys: KeyStream<'_, S>,
    timeline: &Timeline,
    stage: &Stage,
    pool: &rayon::ThreadPool,
    tx: &SyncSender<Result<Arc<YuvFrame>>>,
    cancel: &CancelToken,
) -> Result<()> {
    pool.in_place_scope(|scope| {
        for frame_ref in timeline.frames() {
            check_cancel(cancel)?;
            let frame = match frame_ref {
                FrameRef::Key(i) => Arc::clone(&keys.get(i, scope, stage, cancel)?.shown),
                FrameRef::Blend { from, weight } => {
                    let a = keys.get(from, scope, stage, cancel)?;
                    let b = keys.get(from + 1, scope, stage, cancel)?;
                    Arc::new(stage.blend(&a, &b, weight)?)
                }
            };
            if tx.send(Ok(frame)).is_err() {
                return Ok(()); // the encoder stopped (error or cancel)
            }
        }
        Ok(())
    })
}

fn flush_samples<W: std::io::Write + std::io::Seek>(
    writer: &mut Mp4Writer<W>,
    encoder: &dyn VideoEncoder,
    samples: &mut Vec<EncodedSample>,
) -> Result<()> {
    if samples.is_empty() {
        return Ok(());
    }
    if let Some(sets) = encoder.parameter_sets() {
        writer.set_parameter_sets(sets)?;
    }
    for sample in samples.drain(..) {
        writer.write_sample(&sample.data, sample.keyframe)?;
    }
    Ok(())
}

/// Encoder loop on the calling thread.
fn consume<W: std::io::Write + std::io::Seek>(
    rx: Receiver<Result<Arc<YuvFrame>>>,
    encoder: &mut dyn VideoEncoder,
    mut writer: Mp4Writer<W>,
    total: u64,
    tracker: &mut ProgressTracker,
    on_progress: &mut dyn FnMut(&Progress),
    cancel: &CancelToken,
) -> Result<Mp4Writer<W>> {
    let mut samples = Vec::with_capacity(4);
    let mut done = 0u64;
    while let Ok(item) = rx.recv() {
        check_cancel(cancel)?;
        let frame = item?;
        encoder.encode(&frame, &mut samples)?;
        drop(frame);
        flush_samples(&mut writer, encoder, &mut samples)?;
        done += 1;
        if let Some(progress) = tracker.update(done) {
            on_progress(&progress);
        }
    }
    check_cancel(cancel)?;
    encoder.finish(&mut samples)?;
    flush_samples(&mut writer, encoder, &mut samples)?;
    if done != total {
        return Err(VideoError::Internal(format!(
            "encoded {done} of {total} frames"
        )));
    }
    Ok(writer)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::FrameIter;

    fn frames(n: usize, w: u32, h: u32) -> Vec<Frame> {
        (0..n)
            .map(|i| Frame::new(w, h, vec![(i * 20) as u8; (w * h * 3) as usize], None).unwrap())
            .collect()
    }

    #[test]
    fn key_stream_reports_short_sources() {
        struct Short(usize);
        impl FrameSource for Short {
            fn len(&self) -> usize {
                5
            }
            fn next_loader(&mut self) -> Option<FrameLoader> {
                (self.0 > 0).then(|| {
                    self.0 -= 1;
                    Box::new(|| Frame::new(4, 4, vec![0; 48], None)) as FrameLoader
                })
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("short.mp4");
        let err = encode_timelapse(
            Short(3),
            &VideoOptions::default(),
            &out,
            |_| {},
            &CancelToken::new(),
        )
        .unwrap_err();
        assert!(
            matches!(
                err,
                VideoError::SourceExhausted {
                    expected: 5,
                    got: 3
                }
            ),
            "{err}"
        );
        assert!(!out.exists());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn invalid_frame_aborts_and_cleans_up() {
        let mut list = frames(4, 32, 32);
        list[2].rgb.pop();
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("bad.mp4");
        let err = encode_timelapse(
            FrameIter::from_frames(list),
            &VideoOptions::default(),
            &out,
            |_| {},
            &CancelToken::new(),
        )
        .unwrap_err();
        assert!(
            matches!(err, VideoError::InvalidFrame { index: 2, .. }),
            "{err}"
        );
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn source_errors_propagate() {
        let items: Vec<Result<Frame>> = vec![
            Frame::new(8, 8, vec![0; 192], None),
            Err(VideoError::Source("camera unplugged".into())),
        ];
        let dir = tempfile::tempdir().unwrap();
        let err = encode_timelapse(
            FrameIter::new(items.into_iter(), 2),
            &VideoOptions::default(),
            &dir.path().join("x.mp4"),
            |_| {},
            &CancelToken::new(),
        )
        .unwrap_err();
        assert!(err.to_string().contains("camera unplugged"), "{err}");
    }

    #[test]
    fn cancellation_before_start_creates_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let cancel = CancelToken::new();
        cancel.cancel();
        let err = encode_timelapse(
            FrameIter::from_frames(frames(3, 16, 16)),
            &VideoOptions::default(),
            &dir.path().join("c.mp4"),
            |_| {},
            &cancel,
        )
        .unwrap_err();
        assert!(err.is_cancelled());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn summary_reports_speed() {
        let s = EncodeSummary {
            output: PathBuf::from("a.mp4"),
            width: 2,
            height: 2,
            frames: 10,
            fps: 10.0,
            duration_secs: 1.0,
            bytes: 1,
            elapsed_secs: 2.0,
            encoder: "openh264".into(),
            encoder_fallback: None,
            leftover_partial: None,
        };
        assert!((s.frames_per_sec() - 5.0).abs() < 1e-12);
        assert_eq!(
            EncodeSummary {
                elapsed_secs: 0.0,
                ..s
            }
            .frames_per_sec(),
            0.0
        );
    }
}
