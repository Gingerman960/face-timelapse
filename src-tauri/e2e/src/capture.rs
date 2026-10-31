//! macOS recorder behind `record_start` / `record_stop`.
//!
//! A background thread asks the window server for this app's own window
//! (`CGWindowListCreateImage` with the window's number, exactly like `snap`
//! with `mode: window`: no screen-recording permission, no other window) on a
//! fixed frame clock and pipes the BGRA pixels into an `ffmpeg` child process
//! (see [`crate::recording`]), or appends them to a raw file. Nothing runs
//! on the main thread while it records, so the app keeps its normal frame
//! pacing; the recorder thread asks for user-interactive QoS so a job that
//! fills every core (a scan) cannot starve the frame clock.

use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use objc2_core_foundation::{CGPoint, CGRect, CGSize};
use objc2_core_graphics::{CGDataProvider, CGImage, CGWindowImageOption, CGWindowListOption};
use serde_json::{Value, json};
use tauri::{Runtime, WebviewWindow};

use crate::recording::{self, Frame, RecordCodec};

/// What `record_start` asked for.
pub struct Spec {
    pub path: PathBuf,
    pub fps: u32,
    pub codec: RecordCodec,
    pub retina: bool,
    pub ffmpeg: String,
    pub max: Duration,
}

/// A running recording.
pub struct Recording {
    stop: Arc<AtomicBool>,
    thread: JoinHandle<Result<Value, String>>,
}

impl Recording {
    /// Ends the recording, waits for the encoder and reports statistics.
    ///
    /// # Errors
    /// When capturing or encoding failed.
    pub fn stop(self) -> Result<Value, String> {
        self.stop.store(true, Ordering::Relaxed);
        self.thread
            .join()
            .map_err(|_| "the recorder thread panicked".to_owned())?
    }
}

/// The sidecar file next to the video (`clip.mov` → `clip.<ext>`).
fn sidecar(path: &Path, ext: &str) -> PathBuf {
    path.with_extension(ext)
}

/// Starts recording the window into `spec.path`.
///
/// # Errors
/// When the window is gone, or `ffmpeg` or the raw file cannot be started.
pub fn start<R: Runtime>(
    window: &WebviewWindow<R>,
    spec: Spec,
) -> Result<(Recording, Value), String> {
    let (id, w_pt, h_pt, scale) = crate::native::window_geometry(window)?;
    let scale = if spec.retina { scale } else { 1.0 };
    let resolution = if spec.retina {
        CGWindowImageOption::BestResolution
    } else {
        CGWindowImageOption::NominalResolution
    };
    let opts = CGWindowImageOption::BoundsIgnoreFraming | resolution;
    // Points × scale is a whole, positive pixel count for a real window.
    let width = recording::even((w_pt * scale).round().max(2.0) as usize);
    let height = recording::even((h_pt * scale).round().max(2.0) as usize);
    if let Some(dir) = spec.path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    let out = spec.path.to_string_lossy().into_owned();
    // Sizes fit u32: they come from a window on a screen.
    let sink = match recording::ffmpeg_args(spec.codec, width as u32, height as u32, spec.fps, &out)
    {
        Some(args) => {
            let log_path = sidecar(&spec.path, "ffmpeg.log");
            let log =
                File::create(&log_path).map_err(|e| format!("{}: {e}", log_path.display()))?;
            let mut child = Command::new(&spec.ffmpeg)
                .args(&args)
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::from(log))
                .spawn()
                .map_err(|e| format!("cannot start {}: {e}", spec.ffmpeg))?;
            let Some(stdin) = child.stdin.take() else {
                let _ = child.kill();
                return Err("ffmpeg has no standard input".to_owned());
            };
            Sink::Ffmpeg {
                child,
                stdin,
                log: log_path,
            }
        }
        None => {
            let meta =
                json!({"width": width, "height": height, "pix_fmt": "bgra", "fps": spec.fps});
            let meta_path = sidecar(&spec.path, "raw.json");
            std::fs::write(&meta_path, meta.to_string())
                .map_err(|e| format!("{}: {e}", meta_path.display()))?;
            let file =
                File::create(&spec.path).map_err(|e| format!("{}: {e}", spec.path.display()))?;
            Sink::Raw(BufWriter::with_capacity(64 << 20, file))
        }
    };
    let frames_path = sidecar(&spec.path, "frames.tsv");
    let frames = File::create(&frames_path)
        .map(BufWriter::new)
        .map_err(|e| format!("{}: {e}", frames_path.display()))?;
    let stop = Arc::new(AtomicBool::new(false));
    let job = Job {
        id,
        opts,
        fps: spec.fps.max(1),
        max: spec.max,
        width,
        height,
        stop: Arc::clone(&stop),
    };
    let thread = std::thread::Builder::new()
        .name("ft-e2e-record".into())
        .spawn(move || job.run(sink, frames))
        .map_err(|e| format!("cannot start the recorder thread: {e}"))?;
    let info = json!({
        "path": spec.path,
        "pixels": [width, height],
        "fps": spec.fps,
        "codec": spec.codec,
        "windowNumber": id,
    });
    Ok((Recording { stop, thread }, info))
}

/// The recorder thread's state.
struct Job {
    id: u32,
    opts: CGWindowImageOption,
    fps: u32,
    max: Duration,
    width: usize,
    height: usize,
    stop: Arc<AtomicBool>,
}

/// Where frames go: an encoder's standard input, or a raw file.
enum Sink {
    Ffmpeg {
        child: Child,
        stdin: ChildStdin,
        log: PathBuf,
    },
    Raw(BufWriter<File>),
}

impl Sink {
    fn put(&mut self, frame: &Frame) -> Result<(), String> {
        match self {
            Self::Ffmpeg { stdin, log, .. } => stdin
                .write_all(&frame.bytes)
                .map_err(|e| format!("writing to ffmpeg: {e}; see {}", log.display())),
            Self::Raw(file) => file
                .write_all(&frame.bytes)
                .map_err(|e| format!("writing the raw file: {e}")),
        }
    }

    /// Whether held slots must be written out (an encoder needs every frame).
    fn repeats_held(&self) -> bool {
        matches!(self, Self::Ffmpeg { .. })
    }

    fn finish(self) -> Result<(), String> {
        match self {
            Self::Ffmpeg {
                mut child,
                stdin,
                log,
            } => {
                // Closing standard input lets ffmpeg finish the file.
                drop(stdin);
                let status = child
                    .wait()
                    .map_err(|e| format!("waiting for ffmpeg: {e}"))?;
                if status.success() {
                    Ok(())
                } else {
                    Err(format!("ffmpeg failed ({status}); see {}", log.display()))
                }
            }
            Self::Raw(mut file) => file
                .flush()
                .map_err(|e| format!("writing the raw file: {e}")),
        }
    }
}

/// Asks the scheduler to treat the recorder like UI work (user-interactive
/// QoS), so a job that keeps every core busy cannot starve the frame clock.
fn prefer_interactive() {
    unsafe extern "C" {
        fn pthread_set_qos_class_self_np(qos_class: u32, relative_priority: i32) -> i32;
    }
    const QOS_CLASS_USER_INTERACTIVE: u32 = 0x21;
    // SAFETY: a libSystem call that only changes the calling thread's QoS;
    // the class constant is valid and the relative priority is in range.
    let _ = unsafe { pthread_set_qos_class_self_np(QOS_CLASS_USER_INTERACTIVE, 0) };
}

/// Running totals of a recording.
#[derive(Default)]
struct Totals {
    written: u64,
    captures: u64,
    held: u64,
    missing: u64,
    blank: u64,
    capture_ms: Vec<f64>,
}

impl Job {
    fn run(self, mut sink: Sink, mut frames: BufWriter<File>) -> Result<Value, String> {
        prefer_interactive();
        let mut t = Totals::default();
        let looped = self.capture_loop(&mut sink, &mut frames, &mut t);
        let _ = frames.flush();
        let finished = sink.finish();
        looped?;
        finished?;
        t.capture_ms.sort_by(f64::total_cmp);
        let seconds = recording::slot_start(t.written, self.fps).as_secs_f64();
        Ok(json!({
            "frames": t.written,
            "seconds": (seconds * 1000.0).round() / 1000.0,
            "captures": t.captures,
            "held": t.held,
            "missing": t.missing,
            "blank": t.blank,
            "effectiveFps": if seconds > 0.0 { ((t.captures as f64 / seconds) * 10.0).round() / 10.0 } else { 0.0 },
            "captureMsP50": (recording::quantile(&t.capture_ms, 0.5) * 10.0).round() / 10.0,
            "captureMsP95": (recording::quantile(&t.capture_ms, 0.95) * 10.0).round() / 10.0,
            "captureMsMax": (recording::quantile(&t.capture_ms, 1.0) * 10.0).round() / 10.0,
        }))
    }

    /// Captures until stopped (or `max` passes), writing one frame per slot
    /// of the frame clock.
    fn capture_loop(
        &self,
        sink: &mut Sink,
        frames: &mut BufWriter<File>,
        t: &mut Totals,
    ) -> Result<(), String> {
        let mut cur = Frame::blank(self.width, self.height);
        let mut prev = Frame::blank(self.width, self.height);
        let t0 = Instant::now();
        // At least one frame, so the video is never empty.
        while t.written == 0 || (!self.stop.load(Ordering::Relaxed) && t0.elapsed() < self.max) {
            let started = t0.elapsed();
            let slot = recording::slot_at(started, self.fps).max(t.written);
            let c0 = Instant::now();
            if !grab(self.id, self.opts, &mut cur)? {
                cur.bytes.fill(0);
                t.missing += 1;
            }
            let ms = c0.elapsed().as_secs_f64() * 1000.0;
            t.captures += 1;
            t.capture_ms.push(ms);
            if cur.looks_blank() {
                t.blank += 1;
            }
            // Slots that passed while capturing keep showing the last image.
            while t.written < slot {
                if sink.repeats_held() {
                    sink.put(&prev)?;
                }
                t.written += 1;
                t.held += 1;
            }
            sink.put(&cur)?;
            t.written += 1;
            let _ = writeln!(
                frames,
                "{slot}\t{:.1}\t{ms:.1}",
                started.as_secs_f64() * 1000.0
            );
            std::mem::swap(&mut cur, &mut prev);
            let next = recording::slot_start(t.written, self.fps);
            let now = t0.elapsed();
            if next > now {
                std::thread::sleep(next - now);
            }
        }
        Ok(())
    }
}

/// Copies the window's current image into `into`; `false` when the window
/// server has no image of it (not on screen yet, or hidden).
fn grab(id: u32, opts: CGWindowImageOption, into: &mut Frame) -> Result<bool, String> {
    let null_rect = CGRect::new(
        CGPoint::new(f64::INFINITY, f64::INFINITY),
        CGSize::new(0.0, 0.0),
    );
    #[allow(deprecated)]
    let Some(img) = objc2_core_graphics::CGWindowListCreateImage(
        null_rect,
        CGWindowListOption::OptionIncludingWindow,
        id,
        opts,
    ) else {
        return Ok(false);
    };
    let (w, h) = (CGImage::width(Some(&img)), CGImage::height(Some(&img)));
    if w == 0 || h == 0 {
        return Ok(false);
    }
    recording::check_bgra(
        CGImage::bits_per_pixel(Some(&img)),
        CGImage::bitmap_info(Some(&img)).0,
    )?;
    let stride = CGImage::bytes_per_row(Some(&img));
    let provider = CGImage::data_provider(Some(&img)).ok_or("the capture has no pixels")?;
    let data =
        CGDataProvider::data(Some(&provider)).ok_or("the capture's pixels are unreadable")?;
    // SAFETY: `data` is this function's own immutable copy of the pixels
    // (CGDataProviderCopyData); nothing can change it while the slice lives.
    let bytes = unsafe { data.as_bytes_unchecked() };
    into.put_centered(bytes, w, h, stride)?;
    Ok(true)
}
