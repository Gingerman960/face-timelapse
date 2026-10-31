//! The `extended` backdrop (§9.5): the warped photo's own edges continued
//! outward, blurred more and darkened gently with the distance from the
//! photo, composited with the photo in one fused pass.

#[allow(clippy::wildcard_imports)]
use super::*;

/// The extended backdrop of an `out` frame onto which `src` is warped by `t`
/// (source → output pixels), as an image (see [`ExtendedBackdrop`]).
///
/// # Errors
/// Empty inputs, resize failures.
pub fn extended_backdrop(src: &RgbImage, t: &Similarity, out: Size) -> Result<RgbImage> {
    Ok(ExtendedBackdrop::build(src, t, out)?.render())
}

/// The extended backdrop: the photo warped onto the frame and sampled
/// clamp-to-edge, so the colours at its border continue outward, with a blur
/// that grows with the distance from the photo — σ =
/// [`EXTENDED_NEAR_SIGMA_FRACTION`] of the output long edge at (and under)
/// its border, [`EXTENDED_SIGMA_FRACTION`] [`EXTENDED_RAMP_FRACTION`] away —
/// while the brightness falls from 1 to [`EXTENDED_FACTOR`] (both
/// smoothstep), so no rectangle shows where the photo ends.
///
/// Cheap at any output size: the photo is pre-shrunk and warped onto a
/// reduced canvas where the near σ is 2 px, both blurs run there, and output
/// pixels sample the two layers bilinearly — only where the photo is not
/// opaque when compositing ([`ExtendedBackdrop::composite`]).
#[derive(Debug, Clone)]
pub struct ExtendedBackdrop {
    near: RgbImage,
    far: RgbImage,
    /// Output → full-resolution photo (`None` for a degenerate transform).
    inv: Option<Inverse>,
    /// Full-resolution photo size.
    full: Size,
    /// Output pixels per photo pixel.
    scale: f32,
    out: Size,
    ramp: f32,
    feather: f32,
}

impl ExtendedBackdrop {
    /// Builds the blurred layers for `src` warped by `t` onto an `out` frame.
    ///
    /// # Errors
    /// Empty inputs, resize failures.
    pub fn build(src: &RgbImage, t: &Similarity, out: Size) -> Result<Self> {
        if out.is_empty() || src.size().is_empty() {
            return Err(crate::error::EngineError::InvalidArgument(
                "cannot build a backdrop for an empty image".into(),
            ));
        }
        let long = f64::from(out.long_edge());
        let k = (EXTENDED_SMALL_SIGMA / (long * EXTENDED_NEAR_SIGMA_FRACTION)).min(1.0);
        let small = Size::new(
            crate::geometry::scale_dim(out.width, k).max(2),
            crate::geometry::scale_dim(out.height, k).max(2),
        );
        #[allow(clippy::cast_possible_truncation)]
        let (ramp, scale) = (
            (long as f32 * EXTENDED_RAMP_FRACTION).max(1.0),
            t.scale() as f32,
        );
        let feather = feather_for(out, BackdropMode::Extended);
        let (Some(inv), Some(inv32)) = (t.inverse(), Inverse::of(t)) else {
            let black = RgbImage::new(small.width, small.height);
            return Ok(Self {
                near: black.clone(),
                far: black,
                inv: None,
                full: src.size(),
                scale,
                out,
                ramp,
                feather,
            });
        };
        // Pre-shrink so the small warp minifies by ≤ 2× (area filter: no aliasing).
        let r = (2.0 * t.scale() * k).min(1.0);
        let shrunk = if r < 1.0 {
            let size = Size::new(
                crate::geometry::scale_dim(src.width(), r),
                crate::geometry::scale_dim(src.height(), r),
            );
            src.resized(size.width, size.height, Filter::Box)?
        } else {
            src.clone()
        };
        let base = warp_clamped(&shrunk, src.size(), &inv, out, small);
        #[allow(clippy::cast_possible_truncation)]
        let far_sigma =
            (EXTENDED_SMALL_SIGMA * EXTENDED_SIGMA_FRACTION / EXTENDED_NEAR_SIGMA_FRACTION) as f32;
        #[allow(clippy::cast_possible_truncation)]
        let near = gaussian_blur(&base, EXTENDED_SMALL_SIGMA as f32);
        Ok(Self {
            far: gaussian_blur(&base, far_sigma),
            near,
            inv: Some(inv32),
            full: src.size(),
            scale,
            out,
            ramp,
            feather,
        })
    }

    /// The backdrop alone, as an `out`-sized image.
    #[must_use]
    pub fn render(&self) -> RgbImage {
        let mut canvas = RgbImage::new(self.out.width, self.out.height);
        self.fill(&mut canvas, None);
        canvas
    }

    /// Writes `canvas` (`out`-sized): `photo` warped by `t` (photo → output
    /// pixels; any resampled copy of the photo the layers were built from)
    /// over the backdrop, with a foreground alpha that ramps from 0 at the
    /// photo's border to 1 at [`feather_for`] output pixels inside it. The
    /// backdrop is only evaluated where the photo is not opaque.
    pub fn composite(&self, photo: &RgbImage, t: &Similarity, canvas: &mut RgbImage) {
        let fg = Inverse::of(t).filter(|_| !photo.size().is_empty());
        self.fill(canvas, fg.map(|inv| (photo, inv)));
    }

    fn fill(&self, canvas: &mut RgbImage, photo: Option<(&RgbImage, Inverse)>) {
        const NONE: Inverse = Inverse {
            a: 0.0,
            b: 0.0,
            tx: f32::NAN,
            ty: f32::NAN,
        };
        let (nw, nh) = (self.near.width() as usize, self.near.height() as usize);
        #[allow(clippy::cast_precision_loss)]
        let (kx, ky, wf, hf) = (
            nw as f32 / self.out.width.max(1) as f32,
            nh as f32 / self.out.height.max(1) as f32,
            self.full.width as f32,
            self.full.height as f32,
        );
        let (near, far) = (self.near.as_raw(), self.far.as_raw());
        let inv = self.inv.unwrap_or(NONE);
        let (pw, ph, pdata, pinv) = photo.map_or((1, 1, &[0u8; 3][..], NONE), |(p, i)| {
            (p.width() as usize, p.height() as usize, p.as_raw(), i)
        });
        let inv_feather = self.scale / self.feather.max(f32::EPSILON);
        let stride = canvas.stride();
        crate::decode::assert_no_share_held("extended backdrop");
        canvas
            .as_raw_mut()
            .par_chunks_mut(stride.max(1))
            .enumerate()
            .for_each(|(y, row)| {
                // Full-resolution photo coordinates (geometry) and the photo
                // copy's coordinates (pixels), advanced per output pixel.
                let (mut fx, mut fy, fdx, fdy) = inv.row_start(y);
                let (mut sx, mut sy, sdx, sdy) = pinv.row_start(y);
                #[allow(clippy::cast_precision_loss)]
                let ly = (y as f32 + 0.5) * ky;
                for (x, px) in row.as_chunks_mut::<3>().0.iter_mut().enumerate() {
                    // Signed distance to the photo's border (> 0 inside),
                    // photo px; NaN for a degenerate photo transform.
                    let d = fx.min(fy).min(wf - fx).min(hf - fy);
                    let alpha = if photo.is_some() && d > 0.0 {
                        (d * inv_feather).min(1.0)
                    } else {
                        0.0
                    };
                    let mut bg = [0f32; 3];
                    if alpha < 1.0 {
                        // Euclidean distance outside the photo, output px.
                        let ex = (-fx).max(fx - wf).max(0.0);
                        let ey = (-fy).max(fy - hf).max(0.0);
                        let u = ((ex * ex + ey * ey).sqrt() * self.scale / self.ramp).min(1.0);
                        let w = if u.is_nan() {
                            1.0
                        } else {
                            u * u * (3.0 - 2.0 * u)
                        };
                        let gain = 1.0 - (1.0 - EXTENDED_FACTOR) * w;
                        #[allow(clippy::cast_precision_loss)]
                        let lx = (x as f32 + 0.5) * kx;
                        // Only the layer(s) this distance needs.
                        let layer = if w <= 0.0 {
                            sample(near, nw, nh, lx, ly)
                        } else if w >= 1.0 {
                            sample(far, nw, nh, lx, ly)
                        } else {
                            let a = sample(near, nw, nh, lx, ly);
                            let b = sample(far, nw, nh, lx, ly);
                            [0, 1, 2].map(|c| a[c] + (b[c] - a[c]) * w)
                        };
                        for c in 0..3 {
                            bg[c] = layer[c] * gain;
                        }
                    }
                    if alpha > 0.0 {
                        let v = sample(pdata, pw, ph, sx, sy);
                        for c in 0..3 {
                            bg[c] += (v[c] - bg[c]) * alpha;
                        }
                    }
                    *px = [to_u8(bg[0]), to_u8(bg[1]), to_u8(bg[2])];
                    fx += fdx;
                    fy += fdy;
                    sx += sdx;
                    sy += sdy;
                }
            });
    }
}

/// Renders a `small` canvas covering the whole `out` frame: each pixel maps
/// (output → `inv` → original source of size `full`) into `src` (a resized
/// copy of the source) and is sampled clamp-to-edge.
fn warp_clamped(src: &RgbImage, full: Size, inv: &Similarity, out: Size, small: Size) -> RgbImage {
    let (w, h) = (src.width() as usize, src.height() as usize);
    let (rx, ry) = (
        f64::from(src.width()) / f64::from(full.width),
        f64::from(src.height()) / f64::from(full.height),
    );
    let (ox, oy) = (
        f64::from(out.width) / f64::from(small.width),
        f64::from(out.height) / f64::from(small.height),
    );
    let mut img = RgbImage::new(small.width, small.height);
    let data = src.as_raw();
    let stride = img.stride();
    for (y, row) in img.as_raw_mut().chunks_mut(stride.max(1)).enumerate() {
        #[allow(clippy::cast_precision_loss)]
        let cy = (y as f64 + 0.5) * oy;
        for (x, px) in row.as_chunks_mut::<3>().0.iter_mut().enumerate() {
            #[allow(clippy::cast_precision_loss)]
            let p = inv.apply(Point::new((x as f64 + 0.5) * ox, cy));
            #[allow(clippy::cast_possible_truncation)]
            let v = sample(data, w, h, (p.x * rx) as f32, (p.y * ry) as f32);
            *px = [to_u8(v[0]), to_u8(v[1]), to_u8(v[2])];
        }
    }
    img
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Left half red, right half blue.
    fn halves(w: u32, h: u32) -> RgbImage {
        let mut img = RgbImage::filled(w, h, [0, 0, 255]);
        let stride = img.stride();
        for row in img.as_raw_mut().chunks_mut(stride) {
            for px in row.as_chunks_mut::<3>().0.iter_mut().take(w as usize / 2) {
                *px = [255, 0, 0];
            }
        }
        img
    }

    #[test]
    fn extended_backdrop_continues_the_warped_border() {
        let src = halves(120, 120);
        let out = Size::new(600, 400);
        // Photo in the middle of a wider canvas, slightly rotated.
        let t = Similarity::about(Point::new(60.0, 60.0), 2.0, 0.1)
            .then(&Similarity::translation(240.0, 140.0));
        let bd = extended_backdrop(&src, &t, out).expect("backdrop");
        assert_eq!(bd.size(), out);
        // Far left of the photo continues its red edge, far right its blue
        // edge, darkened to `EXTENDED_FACTOR` (255 × 0.75 ≈ 191).
        let left = bd.pixel(15, 200).expect("px");
        let right = bd.pixel(585, 200).expect("px");
        assert!(left[0] > 180 && left[2] < 30, "{left:?}");
        assert!(right[2] > 180 && right[0] < 30, "{right:?}");
        // Smooth: far from the photo (strong blur) neighbours barely differ;
        // near it the mild blur still softens the photo's own hard edge.
        for y in (0..400).step_by(7) {
            for x in 1..600 {
                let a = bd.pixel(x - 1, y).expect("px");
                let b = bd.pixel(x, y).expect("px");
                let step = a.iter().zip(b).map(|(p, q)| p.abs_diff(q)).max();
                let bound = if (120..480).contains(&x) { 40 } else { 4 };
                assert!(step.is_some_and(|s| s <= bound), "{x},{y}: {step:?}");
            }
        }
        // `backdrop` (no transform) uses the cover geometry.
        let cover = backdrop(&src, Size::new(60, 60), BackdropMode::Extended).expect("cover");
        assert!(cover.pixel(2, 30).expect("px")[0] > 200);
        assert!(cover.pixel(57, 30).expect("px")[2] > 200);
        // Degenerate transforms leave black; empty inputs are errors.
        let black = extended_backdrop(&src, &Similarity::scaling(0.0), out).expect("black");
        assert!(black.as_raw().iter().all(|&v| v == 0));
        assert!(extended_backdrop(&RgbImage::new(0, 0), &t, out).is_err());
        assert!(extended_backdrop(&src, &t, Size::new(0, 5)).is_err());
        // Upscaling photos skip the pre-shrink.
        let big = extended_backdrop(&src, &Similarity::scaling(40.0), Size::new(64, 64));
        assert_eq!(big.expect("big").pixel(10, 10), Some([255, 0, 0]));
    }

    /// Largest per-channel step between horizontally adjacent pixels of a row.
    fn max_step(img: &RgbImage, y: u32) -> u8 {
        (1..img.width())
            .flat_map(|x| {
                let (a, b) = (
                    img.pixel(x - 1, y).expect("px"),
                    img.pixel(x, y).expect("px"),
                );
                (0..3).map(move |c| a[c].abs_diff(b[c]))
            })
            .max()
            .unwrap_or(0)
    }

    #[test]
    fn extended_composite_has_no_seam_and_darkens_far_away() {
        let photo = RgbImage::filled(200, 150, [160, 120, 80]);
        let out = Size::new(500, 300);
        let t = Similarity::translation(150.0, 75.0);
        let bd = ExtendedBackdrop::build(&photo, &t, out).expect("bd");
        let mut canvas = RgbImage::new(out.width, out.height);
        bd.composite(&photo, &t, &mut canvas);
        // Crossing the photo's left/right borders: a gentle ramp, no step.
        assert!(max_step(&canvas, 150) <= 3, "{}", max_step(&canvas, 150));
        // At the border the backdrop is not darkened; far away it is.
        assert_eq!(canvas.pixel(148, 150), Some([160, 120, 80]));
        assert_eq!(canvas.pixel(250, 150), Some([160, 120, 80]));
        let far = canvas.pixel(2, 2).expect("px");
        assert_eq!(far, [120, 90, 60], "× {EXTENDED_FACTOR}");
        // The legacy dimmed mode, by contrast, has a hard step at the border.
        let mut dimmed = backdrop(&photo, out, BackdropMode::Dimmed).expect("bd");
        warp_over(&photo, &t, &mut dimmed, feather_px(out));
        assert!(max_step(&dimmed, 150) > 20);
        // Compositing a half-size copy of the photo gives the same frame.
        let half = photo.resized(100, 75, Filter::Bilinear).expect("half");
        let mut from_half = RgbImage::new(out.width, out.height);
        bd.composite(&half, &Similarity::scaling(2.0).then(&t), &mut from_half);
        assert_eq!(from_half, canvas);
        // Without a usable photo transform only the backdrop is drawn.
        let mut bare = RgbImage::filled(out.width, out.height, [9, 9, 9]);
        bd.composite(&photo, &Similarity::scaling(0.0), &mut bare);
        assert_eq!(bare, bd.render());
        assert_eq!(bare, extended_backdrop(&photo, &t, out).expect("bd"));
        // Leaving the photo, the backdrop darkens monotonically.
        let row: Vec<u8> = (0..150)
            .map(|x| canvas.pixel(x, 150).expect("px")[0])
            .collect();
        assert!(row.windows(2).all(|p| p[0] <= p[1]), "{row:?}");
    }
}
