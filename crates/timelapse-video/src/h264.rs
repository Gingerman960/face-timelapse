//! H.264 bitstream helpers: Annex B parsing, conversion to the
//! length-prefixed (AVCC) sample format MP4 requires, and the
//! `AVCDecoderConfigurationRecord` (`avcC`) built from SPS/PPS.

use crate::error::{Result, VideoError};

/// NAL unit type of an IDR slice.
pub const NAL_IDR: u8 = 5;
/// NAL unit type of a sequence parameter set.
pub const NAL_SPS: u8 = 7;
/// NAL unit type of a picture parameter set.
pub const NAL_PPS: u8 = 8;
/// NAL unit type of an access unit delimiter.
pub const NAL_AUD: u8 = 9;

/// Profiles whose `avcC` carries the chroma/bit-depth extension (ISO 14496-15 5.3.3.1.2).
const HIGH_PROFILES: [u8; 4] = [100, 110, 122, 144];

/// The `nal_unit_type` of a NAL unit (low five bits of the header byte).
#[must_use]
pub fn nal_type(nal: &[u8]) -> u8 {
    nal.first().map_or(0, |h| h & 0x1f)
}

/// Splits an Annex B byte stream into NAL units (start codes and trailing
/// zero bytes removed). Empty NAL units are skipped.
#[must_use]
pub fn split_annex_b(data: &[u8]) -> Vec<&[u8]> {
    let mut starts = Vec::new();
    let mut i = 0;
    while i + 3 <= data.len() {
        if data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 {
            starts.push(i + 3);
            i += 3;
        } else {
            i += 1;
        }
    }
    starts
        .iter()
        .enumerate()
        .filter_map(|(k, &start)| {
            let end = starts.get(k + 1).map_or(data.len(), |&next| next - 3);
            let mut nal = &data[start..end];
            while let [rest @ .., 0] = nal {
                nal = rest;
            }
            (!nal.is_empty()).then_some(nal)
        })
        .collect()
}

/// SPS and PPS of a stream (NAL units without start codes).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AvcParameterSets {
    /// Sequence parameter set NAL unit.
    pub sps: Vec<u8>,
    /// Picture parameter set NAL unit.
    pub pps: Vec<u8>,
}

impl AvcParameterSets {
    /// `profile_idc` from the SPS.
    #[must_use]
    pub fn profile_idc(&self) -> u8 {
        self.sps.get(1).copied().unwrap_or(0)
    }

    /// `level_idc` from the SPS.
    #[must_use]
    pub fn level_idc(&self) -> u8 {
        self.sps.get(3).copied().unwrap_or(0)
    }

    /// Serialises the `AVCDecoderConfigurationRecord` (payload of an `avcC` box)
    /// with 4-byte NAL length fields.
    ///
    /// # Errors
    /// [`VideoError::Mux`] if the SPS is truncated or a parameter set exceeds 64 KiB.
    pub fn avcc_record(&self) -> Result<Vec<u8>> {
        if self.sps.len() < 4 || nal_type(&self.sps) != NAL_SPS {
            return Err(VideoError::Mux("SPS is missing or truncated".into()));
        }
        if self.pps.is_empty() || nal_type(&self.pps) != NAL_PPS {
            return Err(VideoError::Mux("PPS is missing".into()));
        }
        let sps_len = u16::try_from(self.sps.len())
            .map_err(|_| VideoError::Mux("SPS larger than 64 KiB".into()))?;
        let pps_len = u16::try_from(self.pps.len())
            .map_err(|_| VideoError::Mux("PPS larger than 64 KiB".into()))?;
        let mut out = Vec::with_capacity(16 + self.sps.len() + self.pps.len());
        out.push(1); // configurationVersion
        out.extend_from_slice(&self.sps[1..4]); // profile, compatibility, level
        out.push(0xfc | 3); // reserved(6) + lengthSizeMinusOne = 3
        out.push(0xe0 | 1); // reserved(3) + numOfSequenceParameterSets = 1
        out.extend_from_slice(&sps_len.to_be_bytes());
        out.extend_from_slice(&self.sps);
        out.push(1); // numOfPictureParameterSets
        out.extend_from_slice(&pps_len.to_be_bytes());
        out.extend_from_slice(&self.pps);
        if HIGH_PROFILES.contains(&self.profile_idc()) {
            out.push(0xfc | 1); // chroma_format_idc = 1 (4:2:0)
            out.push(0xf8); // bit_depth_luma_minus8 = 0
            out.push(0xf8); // bit_depth_chroma_minus8 = 0
            out.push(0); // numOfSequenceParameterSetExt
        }
        Ok(out)
    }
}

/// One encoded access unit converted for MP4.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AvccAccessUnit {
    /// Length-prefixed NAL units without SPS/PPS/AUD.
    pub data: Vec<u8>,
    /// True if the access unit contains an IDR slice.
    pub is_idr: bool,
    /// Parameter sets carried in-band by this access unit, if any.
    pub parameter_sets: Option<AvcParameterSets>,
}

/// Converts one Annex B access unit into an MP4 sample.
///
/// SPS/PPS are lifted out (they belong in `avcC` for `avc1` tracks) and
/// access unit delimiters are dropped.
///
/// # Errors
/// [`VideoError::Encoder`] if the access unit carries an SPS without a PPS
/// (or vice versa) or contains no slice data.
pub fn annex_b_to_avcc(data: &[u8]) -> Result<AvccAccessUnit> {
    let mut out = Vec::with_capacity(data.len());
    let (mut sps, mut pps) = (None, None);
    let mut is_idr = false;
    for nal in split_annex_b(data) {
        match nal_type(nal) {
            NAL_SPS => sps = Some(nal.to_vec()),
            NAL_PPS => pps = Some(nal.to_vec()),
            NAL_AUD => {}
            kind => {
                is_idr |= kind == NAL_IDR;
                let len = u32::try_from(nal.len())
                    .map_err(|_| VideoError::Encoder("NAL unit larger than 4 GiB".into()))?;
                out.extend_from_slice(&len.to_be_bytes());
                out.extend_from_slice(nal);
            }
        }
    }
    if out.is_empty() {
        return Err(VideoError::Encoder(
            "encoder produced no picture data".into(),
        ));
    }
    let parameter_sets = match (sps, pps) {
        (Some(sps), Some(pps)) => Some(AvcParameterSets { sps, pps }),
        (None, None) => None,
        _ => {
            return Err(VideoError::Encoder(
                "encoder emitted an SPS without a PPS (or vice versa)".into(),
            ));
        }
    };
    Ok(AvccAccessUnit {
        data: out,
        is_idr,
        parameter_sets,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SPS: [u8; 6] = [0x67, 100, 0, 40, 0xac, 0xd9];
    const PPS: [u8; 3] = [0x68, 0xeb, 0xe3];
    const IDR: [u8; 4] = [0x65, 0x88, 0x84, 0x00];
    const P: [u8; 3] = [0x41, 0x9a, 0x02];

    fn annex_b(nals: &[&[u8]], four_byte: bool) -> Vec<u8> {
        let mut out = Vec::new();
        for nal in nals {
            if four_byte {
                out.push(0);
            }
            out.extend_from_slice(&[0, 0, 1]);
            out.extend_from_slice(nal);
        }
        out
    }

    #[test]
    fn splits_three_and_four_byte_start_codes() {
        let mut stream = annex_b(&[&SPS, &PPS], true);
        stream.extend(annex_b(&[&IDR], false));
        stream.extend_from_slice(&[0, 0]); // trailing_zero_8bits
        let nals = split_annex_b(&stream);
        // The IDR NAL's own trailing 0x00 is indistinguishable from padding
        // and is stripped, as every Annex B parser does.
        assert_eq!(nals, vec![&SPS[..], &PPS[..], &IDR[..3]]);
        assert!(split_annex_b(&[]).is_empty());
        assert!(split_annex_b(&[0, 0, 1]).is_empty());
        assert!(split_annex_b(&[1, 2, 3]).is_empty());
    }

    #[test]
    fn idr_access_unit_lifts_parameter_sets() {
        let au = annex_b_to_avcc(&annex_b(&[&[0x09, 0xf0], &SPS, &PPS, &P[..]], true)).unwrap();
        assert!(!au.is_idr);
        let ps = au.parameter_sets.unwrap();
        assert_eq!(ps.sps, SPS);
        assert_eq!(ps.pps, PPS);
        assert_eq!(au.data, [&[0, 0, 0, 3][..], &P].concat());

        let au = annex_b_to_avcc(&annex_b(&[&SPS, &PPS, &[0x65, 0x88, 0x84]], true)).unwrap();
        assert!(au.is_idr);
    }

    #[test]
    fn rejects_incomplete_access_units() {
        assert!(annex_b_to_avcc(&annex_b(&[&SPS, &PPS], true)).is_err());
        assert!(annex_b_to_avcc(&annex_b(&[&SPS, &P], true)).is_err());
        assert!(annex_b_to_avcc(&[]).is_err());
    }

    #[test]
    fn avcc_record_layout_for_high_profile() {
        let ps = AvcParameterSets {
            sps: SPS.to_vec(),
            pps: PPS.to_vec(),
        };
        assert_eq!(ps.profile_idc(), 100);
        assert_eq!(ps.level_idc(), 40);
        let rec = ps.avcc_record().unwrap();
        assert_eq!(&rec[..5], &[1, 100, 0, 40, 0xff]);
        assert_eq!(rec[5], 0xe1);
        assert_eq!(&rec[6..8], &[0, 6]);
        assert_eq!(&rec[8..14], &SPS);
        assert_eq!(rec[14], 1);
        assert_eq!(&rec[15..17], &[0, 3]);
        assert_eq!(&rec[17..20], &PPS);
        assert_eq!(&rec[20..], &[0xfd, 0xf8, 0xf8, 0]);
    }

    #[test]
    fn avcc_record_baseline_has_no_extension_and_validates_inputs() {
        let mut sps = SPS.to_vec();
        sps[1] = 66;
        let ps = AvcParameterSets {
            sps,
            pps: PPS.to_vec(),
        };
        assert_eq!(ps.avcc_record().unwrap().len(), 20);
        let bad = AvcParameterSets {
            sps: vec![0x67, 1],
            pps: PPS.to_vec(),
        };
        assert!(bad.avcc_record().is_err());
        let bad = AvcParameterSets {
            sps: SPS.to_vec(),
            pps: vec![],
        };
        assert!(bad.avcc_record().is_err());
        assert_eq!(nal_type(&[]), 0);
    }
}
