//! Streaming, fast-start MP4 writer for one constant-frame-rate H.264 track.
//!
//! Samples are streamed straight to disk (memory use is ~16 bytes per frame
//! for the sample tables). Because the frame count is known up front, the
//! writer reserves the worst-case `moov` size right after `ftyp`, so the
//! finished file is "fast start" (moov before mdat) without a second pass.
//! File layout:
//!
//! ```text
//! ftyp | moov + free (reserved) | free(8) | mdat(...)   (mdat < 4 GiB)
//! ftyp | moov + free (reserved) | mdat largesize(...)    (mdat >= 4 GiB)
//! ```
//!
//! If more samples arrive than were announced (a caller bug), the reserved
//! region is left as `free` and `moov` is appended at the end instead, which
//! is still a valid, playable file.

mod boxes;

use std::io::{Seek, SeekFrom, Write};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::{Result, VideoError};
use crate::h264::AvcParameterSets;
use boxes::{MP4_EPOCH_OFFSET, TrackTables, free_box, ftyp, moov};

#[cfg(test)]
#[allow(unused_imports)]
pub(crate) use boxes::parse;

/// Upper bound for the `avcC` record we reserve space for (SPS+PPS are
/// typically ~40 bytes).
const MAX_AVCC_LEN: usize = 1024;

/// Static properties of the video track.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TrackConfig {
    /// Width in pixels.
    pub width: u32,
    /// Height in pixels.
    pub height: u32,
    /// Media timescale (ticks per second).
    pub timescale: u32,
    /// Ticks per sample.
    pub sample_delta: u32,
    /// Number of samples that will be written (used to reserve `moov` space).
    pub expected_samples: u64,
}

/// Writes an MP4 file sample by sample. Call [`Mp4Writer::finish`] to make
/// the file valid; dropping the writer leaves a truncated file.
pub struct Mp4Writer<W: Write + Seek> {
    out: W,
    config: TrackConfig,
    reserved_at: u64,
    reserved_len: u64,
    mdat_header_at: u64,
    position: u64,
    sizes: Vec<u32>,
    offsets: Vec<u64>,
    sync: Vec<u32>,
    parameter_sets: Option<AvcParameterSets>,
    creation_time: u64,
}

fn mux_io(context: &str) -> impl FnOnce(std::io::Error) -> VideoError + '_ {
    move |e| VideoError::io(context, e)
}

impl<W: Write + Seek> Mp4Writer<W> {
    /// Starts a file: writes `ftyp`, the reserved `moov` area and the `mdat` header.
    ///
    /// # Errors
    /// [`VideoError::Mux`] for invalid dimensions/timing, or I/O errors.
    pub fn new(mut out: W, config: TrackConfig) -> Result<Self> {
        if config.width == 0
            || config.height == 0
            || config.width > 0xffff
            || config.height > 0xffff
        {
            return Err(VideoError::Mux(format!(
                "invalid track size {}x{}",
                config.width, config.height
            )));
        }
        if config.timescale == 0 || config.sample_delta == 0 {
            return Err(VideoError::Mux(
                "timescale and sample duration must be non-zero".into(),
            ));
        }
        let creation_time = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_secs())
            + MP4_EPOCH_OFFSET;
        let reserved_len = max_moov_len(&config)? + 8;
        let start = out
            .stream_position()
            .map_err(mux_io("writing MP4 header"))?;
        let header = ftyp();
        let reserved_at = start + header.len() as u64;
        out.write_all(&header)
            .map_err(mux_io("writing MP4 header"))?;
        let reserved = usize::try_from(reserved_len)
            .map_err(|_| VideoError::Mux("too many frames for one MP4".into()))?;
        out.write_all(&free_box(reserved))
            .map_err(mux_io("writing MP4 header"))?;
        let mdat_header_at = reserved_at + reserved_len;
        // free(8) + mdat(8); upgraded to a 16-byte largesize mdat header if needed.
        out.write_all(&free_box(8))
            .and_then(|()| out.write_all(&[0, 0, 0, 0, b'm', b'd', b'a', b't']))
            .map_err(mux_io("writing MP4 header"))?;
        Ok(Self {
            out,
            config,
            reserved_at,
            reserved_len,
            mdat_header_at,
            position: mdat_header_at + 16,
            sizes: Vec::with_capacity(usize::try_from(config.expected_samples).unwrap_or(0)),
            offsets: Vec::with_capacity(usize::try_from(config.expected_samples).unwrap_or(0)),
            sync: Vec::new(),
            parameter_sets: None,
            creation_time,
        })
    }

    /// Number of samples written so far.
    #[must_use]
    pub fn samples_written(&self) -> u64 {
        self.sizes.len() as u64
    }

    /// Bytes of sample data written so far.
    #[must_use]
    pub fn payload_bytes(&self) -> u64 {
        self.position - (self.mdat_header_at + 16)
    }

    /// Records the stream's SPS/PPS. They must not change mid-stream.
    ///
    /// # Errors
    /// [`VideoError::Mux`] if different parameter sets were already recorded.
    pub fn set_parameter_sets(&mut self, sets: &AvcParameterSets) -> Result<()> {
        match &self.parameter_sets {
            None => {
                self.parameter_sets = Some(sets.clone());
                Ok(())
            }
            Some(existing) if existing == sets => Ok(()),
            Some(_) => Err(VideoError::Mux(
                "the encoder changed its SPS/PPS mid-stream".into(),
            )),
        }
    }

    /// Appends one AVCC (length-prefixed) sample.
    ///
    /// # Errors
    /// [`VideoError::Mux`] if the first sample is not a keyframe or the
    /// sample is empty/oversized; I/O errors.
    pub fn write_sample(&mut self, data: &[u8], keyframe: bool) -> Result<()> {
        if self.sizes.is_empty() && !keyframe {
            return Err(VideoError::Mux(
                "the first video frame must be a keyframe".into(),
            ));
        }
        let size = u32::try_from(data.len())
            .ok()
            .filter(|&s| s > 0)
            .ok_or_else(|| VideoError::Mux(format!("invalid sample size {}", data.len())))?;
        let number = u32::try_from(self.sizes.len() + 1)
            .map_err(|_| VideoError::Mux("too many frames for one MP4".into()))?;
        self.out
            .write_all(data)
            .map_err(mux_io("writing video data"))?;
        self.offsets.push(self.position);
        self.sizes.push(size);
        if keyframe {
            self.sync.push(number);
        }
        self.position += u64::from(size);
        Ok(())
    }

    /// Writes `moov`, patches the `mdat` size and returns the inner writer.
    ///
    /// # Errors
    /// [`VideoError::Mux`] if no samples or no parameter sets were provided; I/O errors.
    pub fn finish(mut self) -> Result<W> {
        if self.sizes.is_empty() {
            return Err(VideoError::Mux("no video frames were encoded".into()));
        }
        let sets = self
            .parameter_sets
            .as_ref()
            .ok_or_else(|| VideoError::Mux("the encoder never emitted SPS/PPS".into()))?;
        let avcc = sets.avcc_record()?;
        let movie = moov(&TrackTables {
            width: self.config.width,
            height: self.config.height,
            timescale: self.config.timescale,
            sample_delta: self.config.sample_delta,
            sizes: &self.sizes,
            offsets: &self.offsets,
            sync: &self.sync,
            avcc: &avcc,
            creation_time: self.creation_time,
        });
        let ctx = "finalising MP4";
        let payload = self.payload_bytes();
        if let Ok(mdat32) = u32::try_from(payload + 8) {
            self.seek(self.mdat_header_at + 8, ctx)?;
            self.out
                .write_all(&mdat32.to_be_bytes())
                .map_err(mux_io(ctx))?;
        } else {
            self.seek(self.mdat_header_at, ctx)?;
            let mut header = [0u8; 16];
            header[..4].copy_from_slice(&1u32.to_be_bytes());
            header[4..8].copy_from_slice(b"mdat");
            header[8..].copy_from_slice(&(payload + 16).to_be_bytes());
            self.out.write_all(&header).map_err(mux_io(ctx))?;
        }
        if (movie.len() as u64) + 8 <= self.reserved_len {
            let free_len = usize::try_from(self.reserved_len)
                .map_err(|_| VideoError::Mux("reserved area too large".into()))?
                - movie.len();
            self.seek(self.reserved_at, ctx)?;
            self.out.write_all(&movie).map_err(mux_io(ctx))?;
            self.out
                .write_all(&free_box(free_len))
                .map_err(mux_io(ctx))?;
        } else {
            // More samples than announced: append moov (not fast-start, still valid).
            self.seek(self.position, ctx)?;
            self.out.write_all(&movie).map_err(mux_io(ctx))?;
        }
        self.out.flush().map_err(mux_io(ctx))?;
        Ok(self.out)
    }

    fn seek(&mut self, to: u64, ctx: &str) -> Result<()> {
        self.out.seek(SeekFrom::Start(to)).map_err(mux_io(ctx))?;
        Ok(())
    }
}

/// Worst-case `moov` size for `config.expected_samples` samples: v1 headers,
/// 64-bit chunk offsets, an `stss` entry for every sample but one and the
/// largest `avcC` we accept.
fn max_moov_len(config: &TrackConfig) -> Result<u64> {
    let n = usize::try_from(config.expected_samples)
        .ok()
        .filter(|&n| n < u32::MAX as usize)
        .ok_or_else(|| VideoError::Mux("too many frames for one MP4".into()))?;
    let sizes = vec![0u32; n];
    let offsets = vec![u64::MAX; n];
    let sync: Vec<u32> = (2..=n as u32).collect();
    let avcc = vec![0u8; MAX_AVCC_LEN];
    let worst = moov(&TrackTables {
        width: config.width,
        height: config.height,
        timescale: config.timescale,
        sample_delta: u32::MAX,
        sizes: &sizes,
        offsets: &offsets,
        sync: &sync,
        avcc: &avcc,
        creation_time: u64::MAX / 2,
    });
    Ok(worst.len() as u64)
}

#[cfg(test)]
mod tests {
    use super::boxes::parse::{be32, boxes, find};
    use super::*;
    use std::io::Cursor;

    fn sets() -> AvcParameterSets {
        AvcParameterSets {
            sps: vec![0x67, 100, 0, 40, 0xac],
            pps: vec![0x68, 0xeb],
        }
    }

    fn config(expected: u64) -> TrackConfig {
        TrackConfig {
            width: 64,
            height: 48,
            timescale: 15360,
            sample_delta: 512,
            expected_samples: expected,
        }
    }

    fn write(expected: u64, samples: &[(&[u8], bool)]) -> Vec<u8> {
        let mut w = Mp4Writer::new(Cursor::new(Vec::new()), config(expected)).unwrap();
        w.set_parameter_sets(&sets()).unwrap();
        for (data, key) in samples {
            w.write_sample(data, *key).unwrap();
        }
        assert_eq!(w.samples_written(), samples.len() as u64);
        w.finish().unwrap().into_inner()
    }

    #[test]
    fn writes_fast_start_layout_with_correct_offsets() {
        let samples: [(&[u8], bool); 3] = [(b"AAAA", true), (b"BB", false), (b"CCC", false)];
        let file = write(3, &samples);
        let kinds: Vec<[u8; 4]> = boxes(&file).iter().map(|(k, _)| *k).collect();
        assert_eq!(kinds, [*b"ftyp", *b"moov", *b"free", *b"free", *b"mdat"]);
        let mdat = boxes(&file).last().unwrap().1;
        assert_eq!(mdat, b"AAAABBCCC");

        let stbl = ["moov", "trak", "mdia", "minf", "stbl"];
        let stco = find(&file, &[stbl.as_slice(), &["stco"]].concat()).unwrap();
        let first = be32(stco, 8) as usize;
        assert_eq!(&file[first..first + 4], b"AAAA");
        let second = be32(stco, 12) as usize;
        assert_eq!(&file[second..second + 2], b"BB");
        let stss = find(&file, &[stbl.as_slice(), &["stss"]].concat()).unwrap();
        assert_eq!((be32(stss, 4), be32(stss, 8)), (1, 1));
    }

    #[test]
    fn appends_moov_when_more_samples_than_announced() {
        // The 1-sample reservation has ~1 KiB of avcC slack; 300 samples overflow it.
        let many: Vec<(&[u8], bool)> = (0..300).map(|i| (&b"xyz"[..], i == 0)).collect();
        let file = write(1, &many);
        let kinds: Vec<[u8; 4]> = boxes(&file).iter().map(|(k, _)| *k).collect();
        assert_eq!(kinds, [*b"ftyp", *b"free", *b"free", *b"mdat", *b"moov"]);
        let stsz = find(&file, &["moov", "trak", "mdia", "minf", "stbl", "stsz"]).unwrap();
        assert_eq!(be32(stsz, 8), 300);
    }

    #[test]
    fn rejects_invalid_streams() {
        assert!(
            Mp4Writer::new(
                Cursor::new(Vec::new()),
                TrackConfig {
                    width: 0,
                    ..config(1)
                }
            )
            .is_err()
        );
        assert!(
            Mp4Writer::new(
                Cursor::new(Vec::new()),
                TrackConfig {
                    timescale: 0,
                    ..config(1)
                }
            )
            .is_err()
        );

        let mut w = Mp4Writer::new(Cursor::new(Vec::new()), config(2)).unwrap();
        assert!(
            w.write_sample(b"p", false).is_err(),
            "first sample must be sync"
        );
        assert!(w.write_sample(b"", true).is_err(), "empty sample");
        w.write_sample(b"k", true).unwrap();
        assert!(w.finish().is_err(), "missing SPS/PPS");

        let w = Mp4Writer::new(Cursor::new(Vec::new()), config(2)).unwrap();
        assert!(w.finish().is_err(), "no samples");

        let mut w = Mp4Writer::new(Cursor::new(Vec::new()), config(2)).unwrap();
        w.set_parameter_sets(&sets()).unwrap();
        w.set_parameter_sets(&sets()).unwrap();
        let mut other = sets();
        other.pps.push(1);
        assert!(w.set_parameter_sets(&other).is_err());
    }

    #[test]
    fn reservation_grows_linearly_and_fits_real_tables() {
        let small = max_moov_len(&config(10)).unwrap();
        let large = max_moov_len(&config(1010)).unwrap();
        // 4 (stsz) + 8 (co64) + 4 (stss) bytes per extra sample.
        assert_eq!(large - small, 1000 * 16);
        assert!(max_moov_len(&config(u64::from(u32::MAX))).is_err());
    }

    #[test]
    fn payload_counter_tracks_bytes() {
        let mut w = Mp4Writer::new(Cursor::new(Vec::new()), config(2)).unwrap();
        w.write_sample(b"12345", true).unwrap();
        assert_eq!(w.payload_bytes(), 5);
    }

    /// Keeps only the first `HEAD` bytes; everything after is counted, not stored.
    struct SparseSink {
        head: Vec<u8>,
        pos: u64,
        len: u64,
    }

    const HEAD: usize = 1 << 16;

    impl std::io::Write for SparseSink {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            let start = self.pos as usize;
            if start < HEAD {
                let end = (start + buf.len()).min(HEAD);
                if self.head.len() < end {
                    self.head.resize(end, 0);
                }
                self.head[start..end].copy_from_slice(&buf[..end - start]);
            }
            self.pos += buf.len() as u64;
            self.len = self.len.max(self.pos);
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl Seek for SparseSink {
        fn seek(&mut self, to: SeekFrom) -> std::io::Result<u64> {
            match to {
                SeekFrom::Start(p) => self.pos = p,
                SeekFrom::Current(0) => {}
                _ => return Err(std::io::Error::other("unsupported")),
            }
            Ok(self.pos)
        }
    }

    #[test]
    fn files_over_4_gib_use_largesize_mdat_and_co64() {
        const SAMPLE: usize = 64 << 20;
        const COUNT: u64 = 70; // 70 * 64 MiB = 4.375 GiB
        let sink = SparseSink {
            head: Vec::new(),
            pos: 0,
            len: 0,
        };
        let mut w = Mp4Writer::new(sink, config(COUNT)).unwrap();
        w.set_parameter_sets(&sets()).unwrap();
        let sample = vec![0u8; SAMPLE];
        for i in 0..COUNT {
            w.write_sample(&sample, i == 0).unwrap();
        }
        let sink = w.finish().unwrap();
        let payload = COUNT * SAMPLE as u64;
        assert!(payload > u64::from(u32::MAX));
        let head = &sink.head;
        let kinds: Vec<[u8; 4]> = boxes(head).iter().map(|(k, _)| *k).collect();
        assert_eq!(&kinds[..3], &[*b"ftyp", *b"moov", *b"free"]);
        // The 16-byte largesize mdat header replaces the free(8) + mdat(8) pair.
        let mdat_at = head
            .windows(8)
            .position(|w| w == [0, 0, 0, 1, b'm', b'd', b'a', b't']);
        let mdat_at = mdat_at.expect("largesize mdat header");
        let large = u64::from_be_bytes(head[mdat_at + 8..mdat_at + 16].try_into().unwrap());
        assert_eq!(large, payload + 16);
        assert_eq!(sink.len, mdat_at as u64 + 16 + payload);
        let stbl = ["moov", "trak", "mdia", "minf", "stbl"];
        let co64 = find(head, &[stbl.as_slice(), &["co64"]].concat()).expect("co64");
        assert_eq!(be32(co64, 4), COUNT as u32);
        let last = u64::from_be_bytes(co64[8 + 69 * 8..8 + 70 * 8].try_into().unwrap());
        assert_eq!(last, mdat_at as u64 + 16 + 69 * SAMPLE as u64);
    }
}
