'use strict'

// @napi-rs/canvas is used for raster work. Require is deferred to the
// bottom of the file so the pure-math helpers (computeProcrustesTransform,
// scalePoints) can be imported by the unit-test runner without loading
// the native binding.

/**
 * Compute Procrustes transform from srcPoints → refPoints.
 * Direct port of CGAffineTransform+Procrustes.swift.
 *
 * Returns { a, b, c, d, tx, ty } where:
 *   x' = a*x + c*y + tx
 *   y' = b*x + d*y + ty
 *
 * Canvas setTransform(a, b, c, d, e, f) maps to Swift CGAffineTransform(a,b,c,d,tx,ty):
 *   canvas {a,b,c,d,e,f} = swift {a,b,c,d,tx,ty}
 */
function computeProcrustesTransform(srcPoints, refPoints) {
  if (!srcPoints || !refPoints || srcPoints.length !== refPoints.length || srcPoints.length < 3) {
    return { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }
  }

  // 1. Compute centroids
  const centroid = (pts) => {
    const s = pts.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 })
    return { x: s.x / pts.length, y: s.y / pts.length }
  }

  const srcCx_obj = centroid(srcPoints)
  const refCx_obj = centroid(refPoints)
  const srcCx = srcCx_obj.x
  const srcCy = srcCx_obj.y
  const refCx = refCx_obj.x
  const refCy = refCx_obj.y

  // 2. Center points
  const srcCentered = srcPoints.map((p) => ({ x: p.x - srcCx, y: p.y - srcCy }))
  const refCentered = refPoints.map((p) => ({ x: p.x - refCx, y: p.y - refCy }))

  // 3. Compute scale (RMS distance from origin)
  const rms = (pts) => {
    const sumSq = pts.reduce((acc, p) => acc + p.x * p.x + p.y * p.y, 0)
    return Math.sqrt(sumSq / pts.length)
  }

  const srcStd = rms(srcCentered)
  const refStd = rms(refCentered)
  if (srcStd === 0 || refStd === 0) return { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }

  const scale = refStd / srcStd

  // 4. Normalize
  const srcNorm = srcCentered.map((p) => ({ x: p.x / srcStd, y: p.y / srcStd }))
  const refNorm = refCentered.map((p) => ({ x: p.x / refStd, y: p.y / refStd }))

  // 5. Correlation matrix H = ref^T @ src
  let h00 = 0, h01 = 0, h10 = 0, h11 = 0
  for (let i = 0; i < srcNorm.length; i++) {
    h00 += refNorm[i].x * srcNorm[i].x
    h01 += refNorm[i].x * srcNorm[i].y
    h10 += refNorm[i].y * srcNorm[i].x
    h11 += refNorm[i].y * srcNorm[i].y
  }

  // 6. Optimal rotation angle
  const angle = Math.atan2(h10 - h01, h00 + h11)
  const cosA = Math.cos(angle)
  const sinA = Math.sin(angle)

  // 7-9. Build transform
  // Swift CGAffineTransform layout: a*x + c*y + tx, b*x + d*y + ty
  const a = scale * cosA
  const b = scale * sinA
  const c = -scale * sinA
  const d = scale * cosA
  const tx = -scale * (cosA * srcCx - sinA * srcCy) + refCx
  const ty = -scale * (sinA * srcCx + cosA * srcCy) + refCy

  return { a, b, c, d, tx, ty }
}

/**
 * Apply Procrustes transform to align sourceBuffer to refPoints.
 * Returns aligned JPEG buffer at outputSize.
 *
 * The Canvas setTransform mapping to CGAffineTransform is direct:
 *   ctx.setTransform(a, b, c, d, tx, ty)
 * where canvas {a,b,c,d,e(=tx),f(=ty)} = swift {a,b,c,d,tx,ty}.
 */
async function alignImage(sourceBuffer, srcPoints, refPoints, outputSize) {
  const { createCanvas, loadImage } = require('@napi-rs/canvas')
  const { a, b, c, d, tx, ty } = computeProcrustesTransform(srcPoints, refPoints)

  const canvas = createCanvas(outputSize.w, outputSize.h)
  const ctx = canvas.getContext('2d')

  const img = await loadImage(sourceBuffer)

  // Soft source-derived backdrop instead of black. Stretch the source to
  // cover the output canvas, then darken, so anywhere the aligned face
  // doesn't reach is a softened extension of the same photo rather than a
  // hard black rectangle.
  const coverScale = Math.max(outputSize.w / img.width, outputSize.h / img.height)
  const backdropW = img.width * coverScale
  const backdropH = img.height * coverScale
  const backdropX = (outputSize.w - backdropW) / 2
  const backdropY = (outputSize.h - backdropH) / 2
  ctx.drawImage(img, backdropX, backdropY, backdropW, backdropH)

  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)'
  ctx.fillRect(0, 0, outputSize.w, outputSize.h)

  // Apply transform and draw aligned foreground on top.
  // Canvas API: setTransform(a, b, c, d, e, f)
  // where: x' = a*x + c*y + e, y' = b*x + d*y + f
  // Swift CGAffineTransform: x' = a*x + c*y + tx, y' = b*x + d*y + ty
  // So canvas {a,b,c,d,e,f} = swift {a,b,c,d,tx,ty} — direct 1:1 mapping
  ctx.setTransform(a, b, c, d, tx, ty)
  ctx.drawImage(img, 0, 0)
  ctx.setTransform(1, 0, 0, 1, 0, 0)

  return canvas.toBuffer('image/png')
}

/**
 * Scale landmark points from one image size to another.
 * Port of FaceLandmarks.scaled(from:to:).
 */
function scalePoints(points, fromSize, toSize) {
  const sx = toSize.w / fromSize.w
  const sy = toSize.h / fromSize.h
  return points.map((p) => ({ x: p.x * sx, y: p.y * sy }))
}

module.exports = { computeProcrustesTransform, alignImage, scalePoints }
