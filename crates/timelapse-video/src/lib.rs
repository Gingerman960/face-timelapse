//! Pure-Rust timelapse MP4 encoder for FaceTimelapse.
//!
//! Turns an ordered sequence of photos into an H.264/MP4 timelapse with no
//! external tools: frames are decoded, letterboxed/scaled, optionally
//! captioned with their date and crossfaded, converted to BT.709 I420,
//! encoded with openh264 and muxed into a fast-start MP4.
//!
//! ```no_run
//! use timelapse_video::{encode_timelapse, CancelToken, ImageFiles, VideoOptions};
//!
//! let photos = ImageFiles::from_paths(&["20120901_111216.jpg", "20120902_233234.jpg"]);
//! let summary = encode_timelapse(
//!     photos,
//!     &VideoOptions::default(),
//!     "timelapse.mp4".as_ref(),
//!     |p| println!("{:.0}%", p.fraction() * 100.0),
//!     &CancelToken::new(),
//! )?;
//! println!("{} frames in {:.1}s", summary.frames, summary.elapsed_secs);
//! # Ok::<(), timelapse_video::VideoError>(())
//! ```

pub mod caption;
pub mod compose;
pub mod encoder;
mod error;
pub mod geometry;
pub mod h264;
pub mod mp4;
pub mod options;
mod output;
mod pipeline;
mod progress;
pub mod source;
pub mod timing;
pub mod yuv420;

#[cfg(target_os = "macos")]
pub use encoder::VideoToolboxEncoder;
pub use encoder::{AutoEncoder, EncodedSample, EncoderSettings, OpenH264Encoder, VideoEncoder};
pub use error::{Result, VideoError};
pub use geometry::{Resolution, ScaleMode};
pub use options::{
    CaptionOptions, CaptionPosition, Crossfade, EncoderBackend, Pace, Quality, TimingPlan,
    VideoOptions,
};
pub use output::{Committed, PartialFile, is_partial_name};
pub use pipeline::{EncodeSummary, encode_timelapse};
pub use progress::{CancelToken, PROGRESS_INTERVAL, Progress};
pub use source::{
    Frame, FrameIter, FrameLoader, FrameSource, ImageFiles, ImageInput, date_from_filename,
    decode_image,
};
pub use timing::{
    Easing, FrameRate, TimelineSpec, duration_for_fps, fps_for_duration, js_to_fixed,
};
pub use yuv420::YuvFrame;
