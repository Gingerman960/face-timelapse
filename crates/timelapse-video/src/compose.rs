//! Places a source frame on the output canvas: SIMD Lanczos resize
//! (`fast_image_resize`), letterboxing or cropping, background fill.

use fast_image_resize::images::{CroppedImageMut, Image, ImageRef};
use fast_image_resize::{FilterType, PixelType, ResizeAlg, ResizeOptions, Resizer};

use crate::error::{Result, VideoError};
use crate::geometry::{ScaleMode, place};
use crate::source::Frame;

/// Renders source frames onto an `width x height` RGB canvas.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Compositor {
    width: u32,
    height: u32,
    mode: ScaleMode,
    background: [u8; 3],
}

impl Compositor {
    /// A compositor for the given output size and placement policy.
    #[must_use]
    pub fn new(width: u32, height: u32, mode: ScaleMode, background: [u8; 3]) -> Self {
        Self {
            width,
            height,
            mode,
            background,
        }
    }

    /// Output width.
    #[must_use]
    pub fn width(&self) -> u32 {
        self.width
    }

    /// Output height.
    #[must_use]
    pub fn height(&self) -> u32 {
        self.height
    }

    fn blank_canvas(&self) -> Vec<u8> {
        let len = self.width as usize * self.height as usize * 3;
        if self.background == [0, 0, 0] {
            // Zeroed allocations come straight from the OS (calloc), no fill pass.
            vec![0; len]
        } else {
            self.background.repeat(len / 3)
        }
    }

    /// Scales `frame` onto a fresh canvas (reusing its buffer when the frame
    /// already has the output size).
    ///
    /// # Errors
    /// [`VideoError::Internal`] if the resizer rejects the geometry (a bug).
    pub fn compose(&self, frame: Frame) -> Result<Vec<u8>> {
        let placement = place(
            frame.width,
            frame.height,
            self.width,
            self.height,
            self.mode,
        );
        let (dx, dy, dw, dh) = placement.dst;
        let (cl, ct, cw, ch) = placement.src_crop;
        let identity = (dw, dh) == (frame.width, frame.height)
            && (cl, ct) == (0.0, 0.0)
            && (cw, ch) == (f64::from(frame.width), f64::from(frame.height));
        if identity && placement.covers(self.width, self.height) {
            return Ok(frame.rgb);
        }
        let mut canvas = self.blank_canvas();
        let row = self.width as usize * 3;
        if identity {
            // Same size, only offset: copy rows.
            let src_row = dw as usize * 3;
            for (y, src) in frame.rgb.chunks_exact(src_row).enumerate() {
                let start = (dy as usize + y) * row + dx as usize * 3;
                canvas[start..start + src_row].copy_from_slice(src);
            }
            return Ok(canvas);
        }
        let resize_err = |e: &dyn std::fmt::Display| VideoError::Internal(format!("resize: {e}"));
        let src = ImageRef::new(frame.width, frame.height, &frame.rgb, PixelType::U8x3)
            .map_err(|e| resize_err(&e))?;
        let mut dst = Image::from_slice_u8(self.width, self.height, &mut canvas, PixelType::U8x3)
            .map_err(|e| resize_err(&e))?;
        let mut view =
            CroppedImageMut::new(&mut dst, dx, dy, dw, dh).map_err(|e| resize_err(&e))?;
        let options = ResizeOptions::new()
            .resize_alg(ResizeAlg::Convolution(FilterType::Lanczos3))
            .crop(cl, ct, cw, ch);
        Resizer::new()
            .resize(&src, &mut view, &options)
            .map_err(|e| resize_err(&e))?;
        Ok(canvas)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(w: u32, h: u32, rgb: [u8; 3]) -> Frame {
        Frame::new(w, h, rgb.repeat((w * h) as usize), None).unwrap()
    }

    fn pixel(canvas: &[u8], w: u32, x: u32, y: u32) -> [u8; 3] {
        let i = ((y * w + x) * 3) as usize;
        [canvas[i], canvas[i + 1], canvas[i + 2]]
    }

    #[test]
    fn same_size_frame_is_copied_verbatim() {
        let frame = solid(8, 6, [1, 2, 3]);
        let out = Compositor::new(8, 6, ScaleMode::Fit, [0, 0, 0])
            .compose(frame.clone())
            .unwrap();
        assert_eq!(out, frame.rgb);
    }

    #[test]
    fn letterboxes_with_background_colour() {
        // 4:3 red frame into a 16:9 canvas with a blue background.
        let frame = solid(400, 300, [255, 0, 0]);
        let comp = Compositor::new(160, 90, ScaleMode::Fit, [0, 0, 255]);
        let out = comp.compose(frame.clone()).unwrap();
        assert_eq!(out.len(), 160 * 90 * 3);
        assert_eq!(pixel(&out, 160, 5, 45), [0, 0, 255], "left pillar");
        assert_eq!(pixel(&out, 160, 155, 45), [0, 0, 255], "right pillar");
        assert_eq!(pixel(&out, 160, 80, 45), [255, 0, 0], "centre");
        assert_eq!((comp.width(), comp.height()), (160, 90));
    }

    #[test]
    fn fill_mode_covers_the_canvas() {
        let frame = solid(400, 300, [0, 200, 0]);
        let out = Compositor::new(160, 90, ScaleMode::Fill, [0, 0, 255])
            .compose(frame.clone())
            .unwrap();
        assert!(out.as_chunks::<3>().0.iter().all(|p| p == &[0, 200, 0]));
    }

    #[test]
    fn same_size_but_different_aspect_is_offset_without_resampling() {
        // 4x2 frame onto 4x4 canvas: rows 1..3 hold the frame.
        let frame = Frame::new(4, 2, (0..24).collect(), None).unwrap();
        let out = Compositor::new(4, 4, ScaleMode::Fit, [9, 9, 9])
            .compose(frame.clone())
            .unwrap();
        assert_eq!(pixel(&out, 4, 0, 0), [9, 9, 9]);
        assert_eq!(pixel(&out, 4, 0, 1), [0, 1, 2]);
        assert_eq!(pixel(&out, 4, 3, 2), [21, 22, 23]);
        assert_eq!(pixel(&out, 4, 3, 3), [9, 9, 9]);
    }

    #[test]
    fn downscale_preserves_flat_colour() {
        let frame = solid(1000, 750, [10, 120, 230]);
        let out = Compositor::new(200, 150, ScaleMode::Fit, [0, 0, 0])
            .compose(frame.clone())
            .unwrap();
        assert!(out.as_chunks::<3>().0.iter().all(|p| p == &[10, 120, 230]));
    }
}
