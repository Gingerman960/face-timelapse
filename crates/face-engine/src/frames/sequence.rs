//! The frame source for video export: masters (+ look) decoded lazily on the
//! encoder's workers ([`FrameSequence`]).

#[allow(clippy::wildcard_imports)]
use super::*;

/// A frame ready for the video encoder (same shape as `timelapse_video::Frame`).
#[derive(Clone, PartialEq, Eq)]
pub struct RgbFrame {
    /// Width.
    pub width: u32,
    /// Height.
    pub height: u32,
    /// `width·height·3` bytes.
    pub rgb: Vec<u8>,
    /// Day of the frame (caption).
    pub date: NaiveDate,
}

impl std::fmt::Debug for RgbFrame {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RgbFrame")
            .field("width", &self.width)
            .field("height", &self.height)
            .field("date", &self.date)
            .finish_non_exhaustive()
    }
}

/// One frame of a sequence: a master plus its optional look.
#[derive(Debug, Clone)]
pub struct FrameSpec {
    /// Master JPEG.
    pub master: PathBuf,
    /// Day.
    pub date: NaiveDate,
    /// Look (`None` = no normalization); its LUT is built by the loader.
    pub look: Option<FrameLook>,
}

/// Deferred loading of one frame; runs on the consumer's worker threads.
pub type FrameLoader = Box<dyn FnOnce() -> Result<RgbFrame> + Send>;

/// Ordered frames for the video encoder: masters + look, optionally resized
/// to `target` (fast_image_resize, Lanczos3). Hand each loader to the video
/// crate's worker pool (e.g. map errors into `VideoError::Source`).
#[derive(Debug, Clone)]
pub struct FrameSequence {
    specs: Vec<FrameSpec>,
    target: Option<Size>,
}

impl FrameSequence {
    /// A sequence of `specs`, resized to `target` when given.
    #[must_use]
    pub fn new(specs: Vec<FrameSpec>, target: Option<Size>) -> Self {
        Self { specs, target }
    }

    /// Number of frames.
    #[must_use]
    pub fn len(&self) -> usize {
        self.specs.len()
    }

    /// True when empty.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.specs.is_empty()
    }

    /// Loads frame `i` now.
    ///
    /// # Errors
    /// Out-of-range index, decode or resize errors.
    pub fn load(&self, i: usize) -> Result<RgbFrame> {
        let spec = self
            .specs
            .get(i)
            .ok_or_else(|| EngineError::InvalidArgument(format!("frame {i} out of range")))?;
        load_frame(spec, self.target)
    }

    /// One loader per frame, in order.
    pub fn into_loaders(self) -> impl ExactSizeIterator<Item = FrameLoader> {
        let target = self.target;
        self.specs
            .into_iter()
            .map(move |spec| Box::new(move || load_frame(&spec, target)) as FrameLoader)
    }
}

/// Decodes a master, applies its look and resizes it.
///
/// # Errors
/// Decode or resize errors.
pub fn load_frame(spec: &FrameSpec, target: Option<Size>) -> Result<RgbFrame> {
    let mut img = load_master(&spec.master, spec.look.as_ref())?;
    if let Some(t) = target.filter(|t| *t != img.size() && !t.is_empty()) {
        img = img.resized(t.width, t.height, Filter::Lanczos3)?;
    }
    Ok(RgbFrame {
        width: img.width(),
        height: img.height(),
        rgb: img.into_raw(),
        date: spec.date,
    })
}

#[cfg(test)]
mod tests {
    use super::super::tests::*;
    use super::*;
    use crate::color::{LookSettings, NormalizeMode};

    #[test]
    fn sequence_loads_with_look_and_resize() {
        let dir = tempfile::tempdir().expect("tmp");
        let store = FrameStore::new(dir.path(), "abc");
        store.write("p1", "k1", &rendered()).expect("write");
        let date = NaiveDate::from_ymd_opt(2014, 8, 15).expect("date");
        let stats = rendered().face_stats.expect("stats");
        let look = Some(FrameLook {
            frame: stats,
            reference: FaceStats {
                mean: [0.7, 0.01, 0.02],
                ..stats
            },
            settings: LookSettings {
                normalize: NormalizeMode::Exposure,
                strength: 1.0,
            },
        });
        let specs = vec![
            FrameSpec {
                master: store.master_path("p1", "k1"),
                date,
                look: None,
            },
            FrameSpec {
                master: store.master_path("p1", "k1"),
                date,
                look,
            },
        ];
        let seq = FrameSequence::new(specs, Some(Size::new(48, 32)));
        assert_eq!(seq.len(), 2);
        assert!(!seq.is_empty());
        let plain = seq.load(0).expect("plain");
        assert_eq!(
            (plain.width, plain.height, plain.rgb.len()),
            (48, 32, 48 * 32 * 3)
        );
        assert!(format!("{plain:?}").contains("2014-08-15"));
        let lit = seq.load(1).expect("look");
        let mean =
            |f: &RgbFrame| f.rgb.iter().map(|&v| f64::from(v)).sum::<f64>() / f.rgb.len() as f64;
        assert!(mean(&lit) > mean(&plain) + 10.0);
        assert!(seq.load(5).is_err());
        let frames: Vec<_> = seq.into_loaders().map(|l| l().expect("frame")).collect();
        assert_eq!(frames.len(), 2);
    }
}
