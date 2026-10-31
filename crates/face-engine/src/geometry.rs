//! 2-D geometry: points, rectangles, sizes and similarity transforms.
//!
//! Two estimators are provided for "rotation + uniform scale + translation":
//! - [`Similarity::procrustes_legacy`]: exact port of the legacy app's
//!   `computeProcrustesTransform` (RMS-ratio scale). Used for frame alignment
//!   so v2 frames line up exactly like v1 frames.
//! - [`Similarity::least_squares`]: weighted least-squares (Umeyama) solution,
//!   used for the SFace 112×112 crop, matching OpenCV's `alignCrop`.
//!
//! Both are written with complex-number algebra, so a reflection can never be
//! produced (`det = a² + b² > 0`).

use serde::{Deserialize, Serialize};

/// A 2-D point (pixels or normalized units, depending on context).
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct Point {
    /// Horizontal coordinate (grows to the right).
    pub x: f64,
    /// Vertical coordinate (grows downwards).
    pub y: f64,
}

impl Point {
    /// Creates a point.
    #[must_use]
    pub const fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }

    /// Euclidean distance to `other`.
    #[must_use]
    pub fn distance(self, other: Self) -> f64 {
        (self.x - other.x).hypot(self.y - other.y)
    }

    /// Midpoint between `self` and `other`.
    #[must_use]
    pub fn midpoint(self, other: Self) -> Self {
        Self::new((self.x + other.x) * 0.5, (self.y + other.y) * 0.5)
    }

    /// Component-wise scaling.
    #[must_use]
    pub fn scaled(self, sx: f64, sy: f64) -> Self {
        Self::new(self.x * sx, self.y * sy)
    }
}

/// Pixel size of an image.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
pub struct Size {
    /// Width in pixels.
    pub width: u32,
    /// Height in pixels.
    pub height: u32,
}

impl Size {
    /// Creates a size.
    #[must_use]
    pub const fn new(width: u32, height: u32) -> Self {
        Self { width, height }
    }

    /// Longer side.
    #[must_use]
    pub fn long_edge(self) -> u32 {
        self.width.max(self.height)
    }

    /// True if either side is zero.
    #[must_use]
    pub fn is_empty(self) -> bool {
        self.width == 0 || self.height == 0
    }

    /// Largest size with the same aspect that fits inside `max × max`
    /// (never upscales, never returns a zero side).
    #[must_use]
    pub fn fit_within(self, max: u32) -> Self {
        let long = self.long_edge();
        if long <= max || long == 0 {
            return self;
        }
        let s = f64::from(max) / f64::from(long);
        Self::new(scale_dim(self.width, s), scale_dim(self.height, s))
    }
}

/// Scales a pixel dimension, rounding and clamping to at least 1.
#[must_use]
pub fn scale_dim(v: u32, s: f64) -> u32 {
    // Clamped to u32 range by construction (s <= 1 at all call sites).
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let r = (f64::from(v) * s).round().clamp(1.0, f64::from(u32::MAX)) as u32;
    r
}

/// Axis-aligned rectangle (pixels or normalized units, depending on context).
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct Rect {
    /// Left edge.
    pub x: f64,
    /// Top edge.
    pub y: f64,
    /// Width (≥ 0).
    pub width: f64,
    /// Height (≥ 0).
    pub height: f64,
}

impl Rect {
    /// Creates a rectangle.
    #[must_use]
    pub const fn new(x: f64, y: f64, width: f64, height: f64) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }

    /// Right edge.
    #[must_use]
    pub fn right(&self) -> f64 {
        self.x + self.width
    }

    /// Bottom edge.
    #[must_use]
    pub fn bottom(&self) -> f64 {
        self.y + self.height
    }

    /// Area (0 for degenerate rectangles).
    #[must_use]
    pub fn area(&self) -> f64 {
        self.width.max(0.0) * self.height.max(0.0)
    }

    /// Center point.
    #[must_use]
    pub fn center(&self) -> Point {
        Point::new(self.x + self.width * 0.5, self.y + self.height * 0.5)
    }

    /// Intersection-over-union with `other` (0 when disjoint or degenerate).
    #[must_use]
    pub fn iou(&self, other: &Self) -> f64 {
        let ix = (self.right().min(other.right()) - self.x.max(other.x)).max(0.0);
        let iy = (self.bottom().min(other.bottom()) - self.y.max(other.y)).max(0.0);
        let inter = ix * iy;
        let union = self.area() + other.area() - inter;
        if union <= 0.0 { 0.0 } else { inter / union }
    }

    /// Component-wise scaling of position and size.
    #[must_use]
    pub fn scaled(&self, sx: f64, sy: f64) -> Self {
        Self::new(self.x * sx, self.y * sy, self.width * sx, self.height * sy)
    }

    /// Moves the rectangle by `(dx, dy)`.
    #[must_use]
    pub fn translated_by(&self, dx: f64, dy: f64) -> Self {
        Self::new(self.x + dx, self.y + dy, self.width, self.height)
    }

    /// Grows the rectangle by `fraction` of its size on every side.
    #[must_use]
    pub fn padded(&self, fraction: f64) -> Self {
        let dx = self.width * fraction;
        let dy = self.height * fraction;
        Self::new(
            self.x - dx,
            self.y - dy,
            self.width + 2.0 * dx,
            self.height + 2.0 * dy,
        )
    }

    /// Clips the rectangle to `[0, w] × [0, h]`.
    #[must_use]
    pub fn clipped(&self, w: f64, h: f64) -> Self {
        let x0 = self.x.clamp(0.0, w);
        let y0 = self.y.clamp(0.0, h);
        let x1 = self.right().clamp(0.0, w);
        let y1 = self.bottom().clamp(0.0, h);
        Self::new(x0, y0, (x1 - x0).max(0.0), (y1 - y0).max(0.0))
    }

    /// Bounding box of a set of points (`None` when empty).
    #[must_use]
    pub fn bounding(points: &[Point]) -> Option<Self> {
        let first = points.first()?;
        let (mut x0, mut y0, mut x1, mut y1) = (first.x, first.y, first.x, first.y);
        for p in &points[1..] {
            x0 = x0.min(p.x);
            y0 = y0.min(p.y);
            x1 = x1.max(p.x);
            y1 = y1.max(p.y);
        }
        Some(Self::new(x0, y0, x1 - x0, y1 - y0))
    }
}

/// Similarity transform `p' = s·R(θ)·p + t`, stored as
/// `x' = a·x − b·y + tx`, `y' = b·x + a·y + ty` with `a = s·cos θ`, `b = s·sin θ`.
///
/// In image coordinates (y down) a positive θ rotates clockwise on screen.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Similarity {
    /// `s·cos θ`.
    pub a: f64,
    /// `s·sin θ`.
    pub b: f64,
    /// Horizontal translation.
    pub tx: f64,
    /// Vertical translation.
    pub ty: f64,
}

impl Default for Similarity {
    fn default() -> Self {
        Self::IDENTITY
    }
}

impl Similarity {
    /// The identity transform.
    pub const IDENTITY: Self = Self {
        a: 1.0,
        b: 0.0,
        tx: 0.0,
        ty: 0.0,
    };

    /// Builds a transform from scale, clockwise rotation (radians) and translation.
    #[must_use]
    pub fn from_parts(scale: f64, rotation_rad: f64, tx: f64, ty: f64) -> Self {
        Self {
            a: scale * rotation_rad.cos(),
            b: scale * rotation_rad.sin(),
            tx,
            ty,
        }
    }

    /// Uniform scaling about the origin.
    #[must_use]
    pub fn scaling(s: f64) -> Self {
        Self::from_parts(s, 0.0, 0.0, 0.0)
    }

    /// Translation.
    #[must_use]
    pub fn translation(tx: f64, ty: f64) -> Self {
        Self {
            a: 1.0,
            b: 0.0,
            tx,
            ty,
        }
    }

    /// Rotation by `rotation_rad` (clockwise on screen) and scaling by `scale`
    /// about `center`.
    #[must_use]
    pub fn about(center: Point, scale: f64, rotation_rad: f64) -> Self {
        Self::translation(-center.x, -center.y)
            .then(&Self::from_parts(scale, rotation_rad, 0.0, 0.0))
            .then(&Self::translation(center.x, center.y))
    }

    /// Applies the transform to a point.
    #[must_use]
    pub fn apply(&self, p: Point) -> Point {
        Point::new(
            self.a * p.x - self.b * p.y + self.tx,
            self.b * p.x + self.a * p.y + self.ty,
        )
    }

    /// Uniform scale factor `s`.
    #[must_use]
    pub fn scale(&self) -> f64 {
        self.a.hypot(self.b)
    }

    /// Rotation angle θ in radians (clockwise on screen).
    #[must_use]
    pub fn rotation_rad(&self) -> f64 {
        self.b.atan2(self.a)
    }

    /// Inverse transform (`None` when the scale is zero or not finite).
    #[must_use]
    pub fn inverse(&self) -> Option<Self> {
        let det = self.a * self.a + self.b * self.b;
        if !(det.is_finite() && det > f64::EPSILON * f64::EPSILON) {
            return None;
        }
        let ia = self.a / det;
        let ib = -self.b / det;
        Some(Self {
            a: ia,
            b: ib,
            tx: -(ia * self.tx - ib * self.ty),
            ty: -(ib * self.tx + ia * self.ty),
        })
    }

    /// Composition: first `self`, then `next`.
    #[must_use]
    pub fn then(&self, next: &Self) -> Self {
        Self {
            a: next.a * self.a - next.b * self.b,
            b: next.b * self.a + next.a * self.b,
            tx: next.a * self.tx - next.b * self.ty + next.tx,
            ty: next.b * self.tx + next.a * self.ty + next.ty,
        }
    }

    /// Exact port of the legacy `computeProcrustesTransform` (LEGACY-SPEC
    /// §4.10): centroids, RMS-ratio scale `σr/σs`, angle
    /// `atan2(H10 − H01, H00 + H11)` on σ-normalized points. Returns the
    /// identity when the inputs differ in length, have fewer than 3 points or
    /// either set is degenerate (σ = 0).
    #[must_use]
    pub fn procrustes_legacy(src: &[Point], dst: &[Point]) -> Self {
        if src.len() != dst.len() || src.len() < 3 {
            return Self::IDENTITY;
        }
        let (sc, rc) = (centroid(src), centroid(dst));
        let s_std = rms_radius(src, sc);
        let r_std = rms_radius(dst, rc);
        if s_std == 0.0 || r_std == 0.0 || !s_std.is_finite() || !r_std.is_finite() {
            return Self::IDENTITY;
        }
        let scale = r_std / s_std;
        let (mut h00, mut h01, mut h10, mut h11) = (0.0, 0.0, 0.0, 0.0);
        for (s, r) in src.iter().zip(dst) {
            let (sx, sy) = ((s.x - sc.x) / s_std, (s.y - sc.y) / s_std);
            let (rx, ry) = ((r.x - rc.x) / r_std, (r.y - rc.y) / r_std);
            h00 += rx * sx;
            h01 += rx * sy;
            h10 += ry * sx;
            h11 += ry * sy;
        }
        let angle = (h10 - h01).atan2(h00 + h11);
        let (sin, cos) = angle.sin_cos();
        Self {
            a: scale * cos,
            b: scale * sin,
            tx: -scale * (cos * sc.x - sin * sc.y) + rc.x,
            ty: -scale * (sin * sc.x + cos * sc.y) + rc.y,
        }
    }

    /// Weighted least-squares similarity (2-D Umeyama without reflection)
    /// mapping `src` onto `dst`. `weights` defaults to all ones. Returns
    /// `None` for mismatched lengths, fewer than 2 points or degenerate input.
    #[must_use]
    pub fn least_squares(src: &[Point], dst: &[Point], weights: Option<&[f64]>) -> Option<Self> {
        if src.len() != dst.len() || src.len() < 2 {
            return None;
        }
        if weights.is_some_and(|w| w.len() != src.len()) {
            return None;
        }
        let w_at = |i: usize| weights.map_or(1.0, |w| w[i]);
        let total: f64 = (0..src.len()).map(w_at).sum();
        if total.partial_cmp(&0.0) != Some(std::cmp::Ordering::Greater) {
            return None;
        }
        let mut sc = Point::default();
        let mut rc = Point::default();
        for (i, (s, r)) in src.iter().zip(dst).enumerate() {
            let w = w_at(i) / total;
            sc = Point::new(sc.x + w * s.x, sc.y + w * s.y);
            rc = Point::new(rc.x + w * r.x, rc.y + w * r.y);
        }
        let (mut num_a, mut num_b, mut den) = (0.0, 0.0, 0.0);
        for (i, (s, r)) in src.iter().zip(dst).enumerate() {
            let w = w_at(i);
            let (sx, sy) = (s.x - sc.x, s.y - sc.y);
            let (rx, ry) = (r.x - rc.x, r.y - rc.y);
            num_a += w * (sx * rx + sy * ry);
            num_b += w * (sx * ry - sy * rx);
            den += w * (sx * sx + sy * sy);
        }
        if den.partial_cmp(&0.0) != Some(std::cmp::Ordering::Greater) || !den.is_finite() {
            return None;
        }
        let (a, b) = (num_a / den, num_b / den);
        Some(Self {
            a,
            b,
            tx: rc.x - (a * sc.x - b * sc.y),
            ty: rc.y - (b * sc.x + a * sc.y),
        })
    }

    /// Root-mean-square distance between transformed `src` and `dst`.
    #[must_use]
    pub fn residual_rms(&self, src: &[Point], dst: &[Point]) -> f64 {
        let n = src.len().min(dst.len());
        if n == 0 {
            return 0.0;
        }
        let sum: f64 = src
            .iter()
            .zip(dst)
            .map(|(s, d)| {
                let p = self.apply(*s);
                (p.x - d.x).powi(2) + (p.y - d.y).powi(2)
            })
            .sum();
        #[allow(clippy::cast_precision_loss)]
        let mean = sum / n as f64;
        mean.sqrt()
    }
}

/// Mean of a non-empty point set (origin when empty).
#[must_use]
pub fn centroid(points: &[Point]) -> Point {
    if points.is_empty() {
        return Point::default();
    }
    #[allow(clippy::cast_precision_loss)]
    let n = points.len() as f64;
    let (sx, sy) = points
        .iter()
        .fold((0.0, 0.0), |(x, y), p| (x + p.x, y + p.y));
    Point::new(sx / n, sy / n)
}

fn rms_radius(points: &[Point], c: Point) -> f64 {
    #[allow(clippy::cast_precision_loss)]
    let n = points.len() as f64;
    let sum: f64 = points
        .iter()
        .map(|p| (p.x - c.x).powi(2) + (p.y - c.y).powi(2))
        .sum();
    (sum / n).sqrt()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pts(raw: &[(f64, f64)]) -> Vec<Point> {
        raw.iter().map(|&(x, y)| Point::new(x, y)).collect()
    }

    fn face() -> Vec<Point> {
        pts(&[
            (38.3, 51.7),
            (73.5, 51.5),
            (56.0, 71.7),
            (41.5, 92.4),
            (70.7, 92.2),
        ])
    }

    fn close(a: f64, b: f64, eps: f64) -> bool {
        (a - b).abs() <= eps
    }

    fn assert_maps(t: &Similarity, src: &[Point], dst: &[Point], eps: f64) {
        for (s, d) in src.iter().zip(dst) {
            let p = t.apply(*s);
            assert!(
                close(p.x, d.x, eps) && close(p.y, d.y, eps),
                "{p:?} vs {d:?}"
            );
        }
    }

    // Legacy test vectors (tests/alignment.test.js).
    #[test]
    fn legacy_identity_for_identical_points() {
        let p = pts(&[(0.0, 0.0), (1.0, 0.0), (0.0, 1.0), (1.0, 1.0), (0.5, 0.5)]);
        let t = Similarity::procrustes_legacy(&p, &p);
        assert!(close(t.a, 1.0, 1e-9) && close(t.b, 0.0, 1e-9));
        assert!(close(t.tx, 0.0, 1e-9) && close(t.ty, 0.0, 1e-9));
    }

    #[test]
    fn legacy_pure_translation() {
        let src = pts(&[
            (0.0, 0.0),
            (10.0, 0.0),
            (0.0, 10.0),
            (10.0, 10.0),
            (5.0, 5.0),
        ]);
        let dst: Vec<_> = src
            .iter()
            .map(|p| Point::new(p.x + 50.0, p.y + 30.0))
            .collect();
        let t = Similarity::procrustes_legacy(&src, &dst);
        assert!(close(t.tx, 50.0, 1e-9) && close(t.ty, 30.0, 1e-9));
        assert!(close(t.scale(), 1.0, 1e-12));
    }

    #[test]
    fn legacy_uniform_scale() {
        let src = pts(&[
            (0.0, 0.0),
            (10.0, 0.0),
            (0.0, 10.0),
            (10.0, 10.0),
            (5.0, 5.0),
        ]);
        let dst: Vec<_> = src.iter().map(|p| p.scaled(2.0, 2.0)).collect();
        let t = Similarity::procrustes_legacy(&src, &dst);
        assert!(close(t.a, 2.0, 1e-9) && close(t.b, 0.0, 1e-9));
        assert_maps(&t, &src, &dst, 1e-9);
    }

    #[test]
    fn legacy_degenerate_inputs_fall_back_to_identity() {
        let p = pts(&[(1.0, 1.0), (2.0, 2.0)]);
        assert_eq!(Similarity::procrustes_legacy(&p, &p), Similarity::IDENTITY);
        let same = pts(&[(3.0, 3.0), (3.0, 3.0), (3.0, 3.0)]);
        let other = pts(&[(0.0, 0.0), (1.0, 0.0), (0.0, 1.0)]);
        assert_eq!(
            Similarity::procrustes_legacy(&same, &other),
            Similarity::IDENTITY
        );
        assert_eq!(
            Similarity::procrustes_legacy(&other, &same),
            Similarity::IDENTITY
        );
        assert_eq!(
            Similarity::procrustes_legacy(&other, &p),
            Similarity::IDENTITY
        );
    }

    #[test]
    fn both_estimators_recover_exact_similarities() {
        let src = face();
        for &(s, deg, tx, ty) in &[
            (1.0, 0.0, 0.0, 0.0),
            (2.5, 17.0, 100.0, -40.0),
            (0.3, -63.0, 5.0, 900.0),
            (1.7, 179.0, -3.0, 2.0),
        ] {
            let truth = Similarity::from_parts(s, f64::to_radians(deg), tx, ty);
            let dst: Vec<_> = src.iter().map(|p| truth.apply(*p)).collect();
            let legacy = Similarity::procrustes_legacy(&src, &dst);
            let ls = Similarity::least_squares(&src, &dst, None).expect("ls");
            for t in [legacy, ls] {
                assert!(close(t.scale(), s, 1e-9), "{t:?}");
                assert!(close(t.rotation_rad(), f64::to_radians(deg), 1e-9));
                assert_maps(&t, &src, &dst, 1e-7);
                assert!(t.residual_rms(&src, &dst) < 1e-7);
            }
        }
    }

    #[test]
    fn mirrored_targets_never_produce_a_reflection() {
        let src = face();
        let dst: Vec<_> = src.iter().map(|p| Point::new(200.0 - p.x, p.y)).collect();
        for t in [
            Similarity::procrustes_legacy(&src, &dst),
            Similarity::least_squares(&src, &dst, None).expect("ls"),
        ] {
            // det of [[a, -b], [b, a]] is a² + b² ≥ 0: a proper rotation.
            assert!(t.a * t.a + t.b * t.b > 0.0);
            assert!(
                t.residual_rms(&src, &dst) > 1.0,
                "a reflection cannot be fitted"
            );
        }
    }

    #[test]
    fn least_squares_scale_shrinks_with_noise_but_legacy_does_not() {
        // With noisy correspondences the LS scale is biased low; the legacy
        // RMS-ratio scale is not. This is why alignment keeps the legacy formula.
        let src = face();
        let noise = [
            (3.0, -2.0),
            (-2.5, 1.5),
            (0.5, 3.0),
            (2.0, 2.0),
            (-3.0, -1.0),
        ];
        let dst: Vec<_> = src
            .iter()
            .zip(noise)
            .map(|(p, (nx, ny))| Point::new(p.x + nx, p.y + ny))
            .collect();
        let legacy = Similarity::procrustes_legacy(&src, &dst);
        let ls = Similarity::least_squares(&src, &dst, None).expect("ls");
        assert!(ls.scale() < legacy.scale());
        assert!(ls.residual_rms(&src, &dst) <= legacy.residual_rms(&src, &dst) + 1e-12);
    }

    #[test]
    fn least_squares_weights_and_errors() {
        let src = face();
        let mut dst: Vec<_> = src.iter().map(|p| Point::new(p.x + 10.0, p.y)).collect();
        dst[4] = Point::new(500.0, 500.0); // outlier
        let w = [1.0, 1.0, 1.0, 1.0, 0.0];
        let t = Similarity::least_squares(&src, &dst, Some(&w)).expect("weighted");
        assert_maps(&t, &src[..4], &dst[..4], 1e-9);
        assert!(Similarity::least_squares(&src, &dst, Some(&[1.0])).is_none());
        assert!(Similarity::least_squares(&src, &dst, Some(&[0.0; 5])).is_none());
        assert!(Similarity::least_squares(&src[..1], &dst[..1], None).is_none());
        let same = vec![Point::new(1.0, 1.0); 3];
        assert!(Similarity::least_squares(&same, &dst[..3], None).is_none());
    }

    #[test]
    fn inverse_compose_and_about() {
        let t = Similarity::from_parts(1.7, 0.4, 12.0, -7.0);
        let inv = t.inverse().expect("invertible");
        let id = t.then(&inv);
        assert!(close(id.a, 1.0, 1e-12) && close(id.b, 0.0, 1e-12));
        assert!(close(id.tx, 0.0, 1e-9) && close(id.ty, 0.0, 1e-9));
        let p = Point::new(3.0, 4.0);
        let q = t.then(&Similarity::translation(1.0, 2.0)).apply(p);
        let expected = t.apply(p);
        assert!(close(q.x, expected.x + 1.0, 1e-12) && close(q.y, expected.y + 2.0, 1e-12));
        assert!(Similarity::scaling(0.0).inverse().is_none());

        let c = Point::new(50.0, 40.0);
        let r = Similarity::about(c, 2.0, std::f64::consts::FRAC_PI_2);
        let fixed = r.apply(c);
        assert!(close(fixed.x, c.x, 1e-9) && close(fixed.y, c.y, 1e-9));
        // Clockwise on screen: a point to the right of the center moves below it.
        let moved = r.apply(Point::new(60.0, 40.0));
        assert!(close(moved.x, 50.0, 1e-9) && close(moved.y, 60.0, 1e-9));
    }

    #[test]
    fn rect_helpers() {
        let a = Rect::new(0.0, 0.0, 10.0, 10.0);
        let b = Rect::new(5.0, 5.0, 10.0, 10.0);
        assert!(close(a.iou(&b), 25.0 / 175.0, 1e-12));
        assert_eq!(a.iou(&Rect::new(20.0, 20.0, 1.0, 1.0)), 0.0);
        assert_eq!(Rect::default().iou(&Rect::default()), 0.0);
        assert_eq!(a.center(), Point::new(5.0, 5.0));
        assert_eq!(a.padded(0.5), Rect::new(-5.0, -5.0, 20.0, 20.0));
        assert_eq!(
            a.padded(0.5).clipped(12.0, 8.0),
            Rect::new(0.0, 0.0, 12.0, 8.0)
        );
        assert_eq!(a.scaled(0.5, 2.0), Rect::new(0.0, 0.0, 5.0, 20.0));
        assert_eq!(
            Rect::bounding(&pts(&[(1.0, 5.0), (3.0, 2.0)])),
            Some(Rect::new(1.0, 2.0, 2.0, 3.0))
        );
        assert_eq!(Rect::bounding(&[]), None);
        assert_eq!(a.right(), 10.0);
        assert_eq!(a.translated_by(1.0, -2.0), Rect::new(1.0, -2.0, 10.0, 10.0));
        assert_eq!(a.bottom(), 10.0);
    }

    #[test]
    fn size_and_point_helpers() {
        assert_eq!(Size::new(4000, 3000).fit_within(640), Size::new(640, 480));
        assert_eq!(Size::new(300, 4000).fit_within(640), Size::new(48, 640));
        assert_eq!(Size::new(100, 50).fit_within(640), Size::new(100, 50));
        assert_eq!(Size::new(10_000, 1).fit_within(10), Size::new(10, 1));
        assert!(Size::new(0, 3).is_empty());
        assert_eq!(Size::new(3, 9).long_edge(), 9);
        let p = Point::new(0.0, 0.0);
        assert_eq!(p.distance(Point::new(3.0, 4.0)), 5.0);
        assert_eq!(p.midpoint(Point::new(2.0, 4.0)), Point::new(1.0, 2.0));
        assert_eq!(centroid(&[]), Point::default());
        assert_eq!(scale_dim(10, 0.01), 1);
    }
}
