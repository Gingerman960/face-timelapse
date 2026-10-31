//! JPEG decoding: DCT-scaled `jpeg-decoder`, full-size `zune-jpeg`, and the
//! lenient fallback for truncated files — all within the pixel budget.

#[allow(clippy::wildcard_imports)]
use super::*;

pub(super) fn decode_jpeg(
    bytes: &[u8],
    path: &Path,
    target: DecodeTarget,
) -> Result<(RgbImage, Size, PixelPermit)> {
    let mut d = jpeg_decoder::Decoder::new(bytes);
    d.set_max_decoding_buffer_size(usize::try_from(MAX_ALLOC_BYTES).unwrap_or(usize::MAX));
    d.read_info()
        .map_err(|e| EngineError::decode(path, e.to_string()))?;
    let info = d
        .info()
        .ok_or_else(|| EngineError::decode(path, "missing JPEG header"))?;
    let full = Size::new(u32::from(info.width), u32::from(info.height));
    check_dimensions(full, path)?;
    let request = match target {
        DecodeTarget::Full => None,
        DecodeTarget::MinLongEdge(n) => {
            let n = u16::try_from(n.max(1)).unwrap_or(u16::MAX);
            Some((n, n))
        }
        DecodeTarget::MinScale(f) => {
            let f = f.clamp(0.0, 1.0);
            let req = |v: u16| {
                #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
                let r = (f64::from(v) * f).ceil().clamp(1.0, f64::from(u16::MAX)) as u16;
                r
            };
            Some((req(info.width), req(info.height)))
        }
    };
    let scaled_dims = match request {
        Some((w, h)) => d
            .scale(w, h)
            .map_err(|e| EngineError::decode(path, e.to_string()))?,
        None => (info.width, info.height),
    };
    let full_pixels = u64::from(full.width) * u64::from(full.height);
    let sequential = info.coding_process == jpeg_decoder::CodingProcess::DctSequential;
    if sequential && scaled_dims == (info.width, info.height) {
        // Full resolution: zune-jpeg is the fastest; jpeg-decoder is the fallback.
        let permit = PixelPermit::acquire(full_pixels);
        if let Ok(img) = decode_zune(bytes) {
            return Ok((img, full, permit));
        }
    }
    let scaled_pixels = u64::from(scaled_dims.0) * u64::from(scaled_dims.1);
    // Taken before jpeg-decoder allocates anything. While it decodes, its
    // per-component planes and the RGB output are alive together (~2 × the
    // output); progressive/lossless files also keep full-resolution
    // coefficient planes, whatever output size is asked for.
    let mut permit = PixelPermit::acquire(if sequential {
        2 * scaled_pixels
    } else {
        coefficient_pixels(full_pixels, info.pixel_format) + 2 * scaled_pixels
    });
    let decoded = d.decode();
    let out_info = d.info();
    drop(d); // frees the coefficient planes before anything else is allocated
    let pixels = match decoded {
        Ok(p) => p,
        Err(e) => {
            // Lenient fallback: zune-jpeg decodes files with a missing EOI or
            // truncated tail (seen in real phone libraries) at full size, then
            // shrinks — within the dimension check and the shared budget.
            drop(permit);
            let mut permit = PixelPermit::acquire(full_pixels);
            let img = decode_zune(bytes).map_err(|_| EngineError::decode(path, e.to_string()))?;
            let (sw, sh) = (u32::from(scaled_dims.0), u32::from(scaled_dims.1));
            let img = if (sw, sh) == (img.width(), img.height()) {
                img
            } else {
                img.resized(sw.max(1), sh.max(1), crate::image::Filter::Box)?
            };
            permit.shrink(u64::from(img.width()) * u64::from(img.height()));
            return Ok((img, full, permit));
        }
    };
    let info = out_info.ok_or_else(|| EngineError::decode(path, "missing JPEG header"))?;
    let (w, h) = (u32::from(info.width), u32::from(info.height));
    permit.shrink(u64::from(w) * u64::from(h));
    let rgb = to_rgb(pixels, info.pixel_format, path)?;
    Ok((RgbImage::from_raw(w, h, rgb)?, full, permit))
}

fn to_rgb(pixels: Vec<u8>, format: jpeg_decoder::PixelFormat, path: &Path) -> Result<Vec<u8>> {
    use jpeg_decoder::PixelFormat as P;
    Ok(match format {
        P::RGB24 => pixels,
        P::L8 => pixels.iter().flat_map(|&v| [v, v, v]).collect(),
        // Big-endian 16-bit luma: keep the high byte.
        P::L16 => pixels
            .as_chunks::<2>()
            .0
            .iter()
            .flat_map(|c| [c[0], c[0], c[0]])
            .collect(),
        P::CMYK32 => pixels
            .as_chunks::<4>()
            .0
            .iter()
            .flat_map(|c| {
                // jpeg-decoder returns Adobe-style (inverted) CMYK.
                let k = u16::from(c[3]);
                let ch = |v: u8| {
                    #[allow(clippy::cast_possible_truncation)]
                    let r = (u16::from(v) * k / 255) as u8;
                    r
                };
                [ch(c[0]), ch(c[1]), ch(c[2])]
            })
            .collect(),
        #[allow(unreachable_patterns)]
        _ => return Err(EngineError::decode(path, "unsupported JPEG pixel format")),
    })
}

fn decode_zune(bytes: &[u8]) -> std::result::Result<RgbImage, String> {
    use zune_jpeg::zune_core::{
        bytestream::ZCursor, colorspace::ColorSpace, options::DecoderOptions,
    };
    let side = usize::try_from(MAX_SIDE).unwrap_or(usize::MAX);
    let opts = DecoderOptions::default()
        .jpeg_set_out_colorspace(ColorSpace::RGB)
        .set_max_width(side)
        .set_max_height(side);
    let mut d = zune_jpeg::JpegDecoder::new_with_options(ZCursor::new(bytes), opts);
    let px = d.decode().map_err(|e| e.to_string())?;
    let (w, h) = d.dimensions().ok_or("no dimensions")?;
    let (w, h) = (
        u32::try_from(w).map_err(|e| e.to_string())?,
        u32::try_from(h).map_err(|e| e.to_string())?,
    );
    let rgb = match d.output_colorspace() {
        Some(ColorSpace::RGB) => px,
        Some(ColorSpace::Luma) => px.iter().flat_map(|&v| [v, v, v]).collect(),
        other => return Err(format!("unexpected output colorspace {other:?}")),
    };
    RgbImage::from_raw(w, h, rgb).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::super::tests::*;
    use super::*;

    #[test]
    fn decodes_jpeg_at_dct_scales() {
        let src = pattern(400, 300);
        let bytes = jpeg_bytes(&src);
        let p = Path::new("t.jpg");
        let full = decode(&bytes, p, 1, DecodeTarget::Full).expect("full");
        assert_eq!(full.image.size(), Size::new(400, 300));
        assert_eq!(full.full_size, Size::new(400, 300));
        let eighth = decode(&bytes, p, 1, DecodeTarget::MinLongEdge(40)).expect("1/8");
        assert_eq!(eighth.image.size(), Size::new(50, 38));
        assert!((eighth.scale_x() - 0.125).abs() < 1e-9);
        let quarter = decode(&bytes, p, 1, DecodeTarget::MinLongEdge(60)).expect("1/4");
        assert_eq!(quarter.image.size(), Size::new(100, 75));
        let half = decode(&bytes, p, 1, DecodeTarget::MinScale(0.3)).expect("1/2");
        assert_eq!(half.image.size(), Size::new(200, 150));
        let whole = decode(&bytes, p, 1, DecodeTarget::MinScale(0.9)).expect("1");
        assert_eq!(whole.image.size(), Size::new(400, 300));
        let big = decode(&bytes, p, 1, DecodeTarget::MinLongEdge(5000)).expect("full");
        assert_eq!(big.image.size(), Size::new(400, 300));
        // Colours survive: top-left is red, bottom-right is not.
        let tl = eighth.image.pixel(2, 2).expect("px");
        let br = eighth.image.pixel(48, 36).expect("px");
        assert!(tl[0] > 180 && br[0] < 60, "{tl:?} {br:?}");
        assert_eq!(
            probe_size(&bytes, p, 6).expect("probe"),
            Size::new(300, 400)
        );
    }

    #[test]
    fn tolerates_a_truncated_tail() {
        // Real libraries contain JPEGs whose last bytes (EOI) are missing.
        let mut bytes = jpeg_bytes(&pattern(400, 300));
        bytes.truncate(bytes.len() - 6);
        let p = Path::new("t.jpg");
        let scaled = decode(&bytes, p, 1, DecodeTarget::MinLongEdge(40)).expect("scaled");
        assert_eq!(scaled.image.size(), Size::new(50, 38));
        let full = decode(&bytes, p, 1, DecodeTarget::Full).expect("full");
        assert_eq!(full.image.size(), Size::new(400, 300));
    }

    #[test]
    fn converts_jpeg_decoder_pixel_formats() {
        use jpeg_decoder::PixelFormat as P;
        let p = Path::new("x.jpg");
        assert_eq!(to_rgb(vec![7], P::L8, p).expect("l8"), vec![7, 7, 7]);
        assert_eq!(to_rgb(vec![9, 1], P::L16, p).expect("l16"), vec![9, 9, 9]);
        assert_eq!(
            to_rgb(vec![255, 0, 128, 255], P::CMYK32, p).expect("cmyk"),
            vec![255, 0, 128]
        );
        assert_eq!(
            to_rgb(vec![1, 2, 3], P::RGB24, p).expect("rgb"),
            vec![1, 2, 3]
        );
    }

    #[test]
    fn small_progressive_jpegs_decode_at_every_scale() {
        let img = pattern(64, 48);
        let mut bytes = Vec::new();
        let mut enc = jpeg_encoder::Encoder::new(&mut bytes, 90);
        enc.set_progressive(true);
        enc.encode(img.as_raw(), 64, 48, jpeg_encoder::ColorType::Rgb)
            .expect("encode");
        let p = Path::new("p.jpg");
        let full = decode(&bytes, p, 1, DecodeTarget::Full).expect("full");
        assert_eq!(full.image.size(), Size::new(64, 48));
        let half = decode(&bytes, p, 1, DecodeTarget::MinScale(0.5)).expect("half");
        assert_eq!(half.image.size(), Size::new(32, 24));
        assert_eq!(half.full_size, Size::new(64, 48));
        assert_eq!(half.budget_pixels(), 0, "small results hold no budget");
    }

    #[test]
    fn jpeg_decoder_shares_count_planes_and_output() {
        let _serial = super::super::budget::tests::budget_lock();
        // Sequential, DCT-scaled to 3000 × 2000 = 6 MP: per-component planes
        // and the RGB output are alive together, ~2 × the output.
        let bytes = jpeg_bytes(&pattern(6_000, 4_000));
        let p = Path::new("big.jpg");
        take_requests();
        let half = decode(&bytes, p, 1, DecodeTarget::MinScale(0.5)).expect("half");
        assert_eq!(half.image.size(), Size::new(3_000, 2_000));
        assert_eq!(take_requests(), vec![2 * 6_000_000], "planes + output");
        // Progressive: coefficient planes + planes + output.
        let mut prog = Vec::new();
        let mut enc = jpeg_encoder::Encoder::new(&mut prog, 90);
        enc.set_progressive(true);
        enc.set_sampling_factor(jpeg_encoder::SamplingFactor::R_4_4_4);
        enc.encode(
            pattern(4_000, 3_000).as_raw(),
            4_000,
            3_000,
            jpeg_encoder::ColorType::Rgb,
        )
        .expect("encode");
        take_requests();
        let full = decode(&prog, p, 1, DecodeTarget::Full).expect("full");
        assert_eq!(full.image.size(), Size::new(4_000, 3_000));
        let requests = take_requests();
        assert_eq!(
            requests.first(),
            Some(&(2 * 12_000_000 + 2 * 12_000_000)),
            "{requests:?}"
        );
    }
}
