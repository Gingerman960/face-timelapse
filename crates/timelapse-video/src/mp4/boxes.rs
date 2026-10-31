//! ISO-BMFF box serialisation for a single H.264 video track.
//!
//! Layout follows ISO/IEC 14496-12 / 14496-15 and mirrors what ffmpeg's mov
//! muxer writes for `avc1` (minus the edit list, which is unnecessary without
//! B-frames): `mvhd`, `trak{tkhd, mdia{mdhd, hdlr, minf{vmhd, dinf, stbl}}}`.

/// Seconds between 1904-01-01 (MP4 epoch) and 1970-01-01 (Unix epoch).
pub const MP4_EPOCH_OFFSET: u64 = 2_082_844_800;
/// Movie-level timescale (milliseconds), as used by ffmpeg.
pub const MOVIE_TIMESCALE: u32 = 1000;
/// Identity transformation matrix for `mvhd` / `tkhd`.
const UNITY_MATRIX: [u32; 9] = [0x0001_0000, 0, 0, 0, 0x0001_0000, 0, 0, 0, 0x4000_0000];
/// `und` (undetermined) packed ISO-639-2/T language code.
const LANGUAGE_UND: u16 = 0x55c4;
/// BT.709 code point for primaries, transfer and matrix (ITU-T H.273).
const BT709: u16 = 1;

/// Everything needed to serialise the `moov` box of one video track.
#[derive(Debug, Clone, Copy)]
pub struct TrackTables<'a> {
    /// Display width in pixels.
    pub width: u32,
    /// Display height in pixels.
    pub height: u32,
    /// Media timescale (ticks per second).
    pub timescale: u32,
    /// Duration of every sample in media ticks (constant frame rate).
    pub sample_delta: u32,
    /// Size in bytes of each sample.
    pub sizes: &'a [u32],
    /// Absolute file offset of each sample (one sample per chunk).
    pub offsets: &'a [u64],
    /// 1-based numbers of sync (IDR) samples.
    pub sync: &'a [u32],
    /// `AVCDecoderConfigurationRecord` bytes.
    pub avcc: &'a [u8],
    /// Creation time in seconds since 1904-01-01.
    pub creation_time: u64,
}

impl TrackTables<'_> {
    fn sample_count(&self) -> u64 {
        self.sizes.len() as u64
    }

    fn media_duration(&self) -> u64 {
        self.sample_count() * u64::from(self.sample_delta)
    }

    fn movie_duration(&self) -> u64 {
        if self.timescale == 0 {
            return 0;
        }
        // Round to nearest millisecond.
        (u128::from(self.media_duration()) * u128::from(MOVIE_TIMESCALE)
            + u128::from(self.timescale) / 2)
            .checked_div(u128::from(self.timescale))
            .and_then(|d| u64::try_from(d).ok())
            .unwrap_or(u64::MAX)
    }
}

/// Appends a box: 32-bit size placeholder, type, body, then patches the size.
pub fn write_box(out: &mut Vec<u8>, kind: &[u8; 4], body: impl FnOnce(&mut Vec<u8>)) {
    let start = out.len();
    out.extend_from_slice(&[0; 4]);
    out.extend_from_slice(kind);
    body(out);
    // moov boxes are far below 4 GiB (bounded by sample tables of u32 counts).
    let size = u32::try_from(out.len() - start).unwrap_or(u32::MAX);
    out[start..start + 4].copy_from_slice(&size.to_be_bytes());
}

fn write_full_box(
    out: &mut Vec<u8>,
    kind: &[u8; 4],
    version: u8,
    flags: u32,
    body: impl FnOnce(&mut Vec<u8>),
) {
    write_box(out, kind, |out| {
        out.push(version);
        out.extend_from_slice(&flags.to_be_bytes()[1..]);
        body(out);
    });
}

fn put_u16(out: &mut Vec<u8>, v: u16) {
    out.extend_from_slice(&v.to_be_bytes());
}

fn put_u32(out: &mut Vec<u8>, v: u32) {
    out.extend_from_slice(&v.to_be_bytes());
}

fn put_u64(out: &mut Vec<u8>, v: u64) {
    out.extend_from_slice(&v.to_be_bytes());
}

fn put_matrix(out: &mut Vec<u8>) {
    for v in UNITY_MATRIX {
        put_u32(out, v);
    }
}

fn needs_v1(values: &[u64]) -> bool {
    values.iter().any(|&v| v > u64::from(u32::MAX))
}

/// Writes `creation, modification, [extra u32], duration` in v0 or v1 layout.
fn put_times(out: &mut Vec<u8>, v1: bool, time: u64, middle: u32, duration: u64) {
    if v1 {
        put_u64(out, time);
        put_u64(out, time);
        put_u32(out, middle);
        put_u64(out, duration);
    } else {
        // Guarded by needs_v1: every value fits in 32 bits here.
        put_u32(out, time as u32);
        put_u32(out, time as u32);
        put_u32(out, middle);
        put_u32(out, duration as u32);
    }
}

/// The `ftyp` box (same brands as ffmpeg's default MP4 output).
#[must_use]
pub fn ftyp() -> Vec<u8> {
    let mut out = Vec::with_capacity(32);
    write_box(&mut out, b"ftyp", |out| {
        out.extend_from_slice(b"isom");
        put_u32(out, 0x200);
        for brand in [b"isom", b"iso2", b"avc1", b"mp41"] {
            out.extend_from_slice(brand);
        }
    });
    out
}

/// A `free` box of exactly `size` bytes (`size >= 8`).
#[must_use]
pub fn free_box(size: usize) -> Vec<u8> {
    let mut out = vec![0u8; size.max(8)];
    let size32 = u32::try_from(out.len()).unwrap_or(u32::MAX);
    out[..4].copy_from_slice(&size32.to_be_bytes());
    out[4..8].copy_from_slice(b"free");
    out
}

/// Serialises the complete `moov` box.
#[must_use]
pub fn moov(t: &TrackTables<'_>) -> Vec<u8> {
    let mut out = Vec::with_capacity(1024 + t.sizes.len() * 16);
    write_box(&mut out, b"moov", |out| {
        mvhd(out, t);
        write_box(out, b"trak", |out| {
            tkhd(out, t);
            write_box(out, b"mdia", |out| {
                mdhd(out, t);
                hdlr(out);
                write_box(out, b"minf", |out| {
                    write_full_box(out, b"vmhd", 0, 1, |out| out.extend_from_slice(&[0; 8]));
                    dinf(out);
                    stbl(out, t);
                });
            });
        });
    });
    out
}

fn mvhd(out: &mut Vec<u8>, t: &TrackTables<'_>) {
    let duration = t.movie_duration();
    let v1 = needs_v1(&[t.creation_time, duration]);
    write_full_box(out, b"mvhd", u8::from(v1), 0, |out| {
        put_times(out, v1, t.creation_time, MOVIE_TIMESCALE, duration);
        put_u32(out, 0x0001_0000); // rate 1.0
        put_u16(out, 0x0100); // volume 1.0
        out.extend_from_slice(&[0; 10]); // reserved
        put_matrix(out);
        out.extend_from_slice(&[0; 24]); // pre_defined
        put_u32(out, 2); // next_track_ID
    });
}

fn tkhd(out: &mut Vec<u8>, t: &TrackTables<'_>) {
    let duration = t.movie_duration();
    let v1 = needs_v1(&[t.creation_time, duration]);
    // flags: track_enabled | track_in_movie
    write_full_box(out, b"tkhd", u8::from(v1), 3, |out| {
        if v1 {
            put_u64(out, t.creation_time);
            put_u64(out, t.creation_time);
            put_u32(out, 1); // track_ID
            put_u32(out, 0); // reserved
            put_u64(out, duration);
        } else {
            put_u32(out, t.creation_time as u32);
            put_u32(out, t.creation_time as u32);
            put_u32(out, 1);
            put_u32(out, 0);
            put_u32(out, duration as u32);
        }
        out.extend_from_slice(&[0; 8]); // reserved
        put_u16(out, 0); // layer
        put_u16(out, 0); // alternate_group
        put_u16(out, 0); // volume (video)
        put_u16(out, 0); // reserved
        put_matrix(out);
        put_u32(out, t.width << 16);
        put_u32(out, t.height << 16);
    });
}

fn mdhd(out: &mut Vec<u8>, t: &TrackTables<'_>) {
    let duration = t.media_duration();
    let v1 = needs_v1(&[t.creation_time, duration]);
    write_full_box(out, b"mdhd", u8::from(v1), 0, |out| {
        put_times(out, v1, t.creation_time, t.timescale, duration);
        put_u16(out, LANGUAGE_UND);
        put_u16(out, 0); // pre_defined
    });
}

fn hdlr(out: &mut Vec<u8>) {
    write_full_box(out, b"hdlr", 0, 0, |out| {
        put_u32(out, 0); // pre_defined
        out.extend_from_slice(b"vide");
        out.extend_from_slice(&[0; 12]); // reserved
        out.extend_from_slice(b"VideoHandler\0");
    });
}

fn dinf(out: &mut Vec<u8>) {
    write_box(out, b"dinf", |out| {
        write_full_box(out, b"dref", 0, 0, |out| {
            put_u32(out, 1);
            // flags = 1: media data is in this file.
            write_full_box(out, b"url ", 0, 1, |_| {});
        });
    });
}

fn stbl(out: &mut Vec<u8>, t: &TrackTables<'_>) {
    let count = u32::try_from(t.sizes.len()).unwrap_or(u32::MAX);
    write_box(out, b"stbl", |out| {
        stsd(out, t);
        write_full_box(out, b"stts", 0, 0, |out| {
            if count == 0 {
                put_u32(out, 0);
            } else {
                put_u32(out, 1);
                put_u32(out, count);
                put_u32(out, t.sample_delta);
            }
        });
        if t.sync.len() < t.sizes.len() {
            write_full_box(out, b"stss", 0, 0, |out| {
                put_u32(out, u32::try_from(t.sync.len()).unwrap_or(u32::MAX));
                for &s in t.sync {
                    put_u32(out, s);
                }
            });
        }
        write_full_box(out, b"stsc", 0, 0, |out| {
            if count == 0 {
                put_u32(out, 0);
            } else {
                put_u32(out, 1);
                put_u32(out, 1); // first_chunk
                put_u32(out, 1); // samples_per_chunk
                put_u32(out, 1); // sample_description_index
            }
        });
        write_full_box(out, b"stsz", 0, 0, |out| {
            put_u32(out, 0); // sample_size: sizes vary
            put_u32(out, count);
            for &s in t.sizes {
                put_u32(out, s);
            }
        });
        let wide = t.offsets.iter().any(|&o| o > u64::from(u32::MAX));
        let kind = if wide { b"co64" } else { b"stco" };
        write_full_box(out, kind, 0, 0, |out| {
            put_u32(out, count);
            for &o in t.offsets {
                if wide {
                    put_u64(out, o);
                } else {
                    put_u32(out, o as u32);
                }
            }
        });
    });
}

fn stsd(out: &mut Vec<u8>, t: &TrackTables<'_>) {
    write_full_box(out, b"stsd", 0, 0, |out| {
        put_u32(out, 1);
        write_box(out, b"avc1", |out| {
            out.extend_from_slice(&[0; 6]); // reserved
            put_u16(out, 1); // data_reference_index
            out.extend_from_slice(&[0; 16]); // pre_defined + reserved
            put_u16(out, u16::try_from(t.width).unwrap_or(u16::MAX));
            put_u16(out, u16::try_from(t.height).unwrap_or(u16::MAX));
            put_u32(out, 0x0048_0000); // 72 dpi
            put_u32(out, 0x0048_0000);
            put_u32(out, 0); // reserved
            put_u16(out, 1); // frame_count
            out.extend_from_slice(&[0; 32]); // compressorname (empty)
            put_u16(out, 0x0018); // depth
            put_u16(out, 0xffff); // pre_defined = -1
            write_box(out, b"avcC", |out| out.extend_from_slice(t.avcc));
            write_box(out, b"colr", |out| {
                out.extend_from_slice(b"nclx");
                put_u16(out, BT709); // colour_primaries
                put_u16(out, BT709); // transfer_characteristics
                put_u16(out, BT709); // matrix_coefficients
                out.push(0); // full_range_flag = 0 (limited) + reserved
            });
            write_box(out, b"pasp", |out| {
                put_u32(out, 1);
                put_u32(out, 1);
            });
        });
    });
}

#[cfg(test)]
pub(crate) mod parse {
    //! A tiny box walker for tests.

    /// `(type, payload)` of every top-level box in `data`.
    pub fn boxes(data: &[u8]) -> Vec<([u8; 4], &[u8])> {
        let mut out = Vec::new();
        let mut i = 0usize;
        while i + 8 <= data.len() {
            let size32 = u32::from_be_bytes(data[i..i + 4].try_into().unwrap());
            let kind: [u8; 4] = data[i + 4..i + 8].try_into().unwrap();
            let (header, size) = match size32 {
                1 => (
                    16,
                    u64::from_be_bytes(data[i + 8..i + 16].try_into().unwrap()) as usize,
                ),
                0 => (8, data.len() - i),
                n => (8, n as usize),
            };
            out.push((kind, &data[i + header..(i + size).min(data.len())]));
            i += size;
        }
        out
    }

    /// Payload of the first box at `path` (e.g. `["moov", "trak", "tkhd"]`).
    pub fn find<'a>(data: &'a [u8], path: &[&str]) -> Option<&'a [u8]> {
        let (head, rest) = path.split_first()?;
        let payload = boxes(data)
            .into_iter()
            .find(|(k, _)| k == head.as_bytes())?
            .1;
        if rest.is_empty() {
            Some(payload)
        } else if *head == "stsd" {
            find(&payload[8..], rest)
        } else if *head == "avc1" {
            find(&payload[78..], rest)
        } else {
            find(payload, rest)
        }
    }

    /// Big-endian u32 at `offset`.
    pub fn be32(data: &[u8], offset: usize) -> u32 {
        u32::from_be_bytes(data[offset..offset + 4].try_into().unwrap())
    }
}

#[cfg(test)]
mod tests {
    use super::parse::{be32, boxes, find};
    use super::*;

    fn tables<'a>(sizes: &'a [u32], offsets: &'a [u64], sync: &'a [u32]) -> TrackTables<'a> {
        TrackTables {
            width: 1920,
            height: 1080,
            timescale: 15360,
            sample_delta: 512,
            sizes,
            offsets,
            sync,
            avcc: &[1, 100, 0, 40, 0xff],
            creation_time: 3_900_000_000,
        }
    }

    #[test]
    fn ftyp_and_free_are_well_formed() {
        let f = ftyp();
        assert_eq!(be32(&f, 0) as usize, f.len());
        assert_eq!(&f[4..12], b"ftypisom");
        let free = free_box(20);
        assert_eq!(free.len(), 20);
        assert_eq!(be32(&free, 0), 20);
        assert_eq!(&free[4..8], b"free");
        assert_eq!(free_box(3).len(), 8);
    }

    #[test]
    fn moov_has_expected_hierarchy_and_tables() {
        let sizes = [100, 50, 60, 200];
        let offsets = [1000, 1100, 1150, 1210];
        let sync = [1, 4];
        let m = moov(&tables(&sizes, &offsets, &sync));
        assert_eq!(be32(&m, 0) as usize, m.len());
        let top = boxes(&m);
        assert_eq!(top.len(), 1);
        assert_eq!(&top[0].0, b"moov");

        let mvhd = find(&m, &["moov", "mvhd"]).unwrap();
        assert_eq!(mvhd[0], 0, "v0 header");
        assert_eq!(be32(mvhd, 12), MOVIE_TIMESCALE);
        // 4 samples * 512 / 15360 s = 0.1333 s -> 133 ms.
        assert_eq!(be32(mvhd, 16), 133);

        let tkhd = find(&m, &["moov", "trak", "tkhd"]).unwrap();
        assert_eq!(be32(tkhd, 0) & 0xff_ffff, 3);
        assert_eq!(be32(tkhd, tkhd.len() - 8), 1920 << 16);
        assert_eq!(be32(tkhd, tkhd.len() - 4), 1080 << 16);

        let mdhd = find(&m, &["moov", "trak", "mdia", "mdhd"]).unwrap();
        assert_eq!(be32(mdhd, 12), 15360);
        assert_eq!(be32(mdhd, 16), 2048);

        let stbl = ["moov", "trak", "mdia", "minf", "stbl"];
        let at = |leaf: &str| {
            let mut p = stbl.to_vec();
            p.push(leaf);
            find(&m, &p)
        };
        let stts = at("stts").unwrap();
        assert_eq!((be32(stts, 4), be32(stts, 8), be32(stts, 12)), (1, 4, 512));
        let stss = at("stss").unwrap();
        assert_eq!((be32(stss, 4), be32(stss, 8), be32(stss, 12)), (2, 1, 4));
        let stsz = at("stsz").unwrap();
        assert_eq!(be32(stsz, 8), 4);
        assert_eq!(be32(stsz, 12 + 3 * 4), 200);
        let stco = at("stco").unwrap();
        assert_eq!(be32(stco, 4), 4);
        assert_eq!(be32(stco, 8 + 3 * 4), 1210);
        assert!(at("co64").is_none());

        let avcc = find(
            &m,
            &[
                "moov", "trak", "mdia", "minf", "stbl", "stsd", "avc1", "avcC",
            ],
        );
        assert_eq!(avcc.unwrap(), &[1, 100, 0, 40, 0xff]);
        let colr = find(
            &m,
            &[
                "moov", "trak", "mdia", "minf", "stbl", "stsd", "avc1", "colr",
            ],
        );
        assert_eq!(colr.unwrap(), b"nclx\0\x01\0\x01\0\x01\0");
    }

    #[test]
    fn all_sync_omits_stss_and_large_values_switch_to_wide_boxes() {
        let sizes = [10, 10];
        let offsets = [u64::from(u32::MAX) + 10, u64::from(u32::MAX) + 20];
        let sync = [1, 2];
        let mut t = tables(&sizes, &offsets, &sync);
        t.creation_time = u64::from(u32::MAX) + 1;
        let m = moov(&t);
        let stbl = ["moov", "trak", "mdia", "minf", "stbl"];
        assert!(find(&m, &[stbl.as_slice(), &["stss"]].concat()).is_none());
        let co64 = find(&m, &[stbl.as_slice(), &["co64"]].concat()).unwrap();
        assert_eq!(be32(co64, 4), 2);
        assert_eq!(find(&m, &["moov", "mvhd"]).unwrap()[0], 1, "v1 header");
        assert_eq!(find(&m, &["moov", "trak", "tkhd"]).unwrap()[0], 1);
        assert_eq!(find(&m, &["moov", "trak", "mdia", "mdhd"]).unwrap()[0], 1);
    }

    #[test]
    fn empty_track_serialises() {
        let m = moov(&tables(&[], &[], &[]));
        let stts = find(&m, &["moov", "trak", "mdia", "minf", "stbl", "stts"]).unwrap();
        assert_eq!(be32(stts, 4), 0);
        let mut t = tables(&[], &[], &[]);
        t.timescale = 0;
        assert_eq!(t.movie_duration(), 0);
    }
}
