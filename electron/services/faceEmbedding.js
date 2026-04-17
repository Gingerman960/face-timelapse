'use strict'

/**
 * Generate a geometric face embedding from 68-point landmarks.
 * Exact port of FaceRecognitionService.extractGeometricFeatures().
 *
 * Returns 45 floats representing person-specific facial proportions.
 * These are lighting/color invariant because they use only geometry.
 */
function generateEmbedding(landmarks68) {
  // face-api.js 68-point regions
  const faceContour = landmarks68.slice(0, 17)
  const leftEyebrow = landmarks68.slice(17, 22)
  const rightEyebrow = landmarks68.slice(22, 27)
  const noseBridge = landmarks68.slice(27, 31)  // noseCrest in Swift
  const noseBase = landmarks68.slice(31, 36)  // nose in Swift
  const leftEye = landmarks68.slice(36, 42)
  const rightEye = landmarks68.slice(42, 48)
  const outerLips = landmarks68.slice(48, 60)
  const innerLips = landmarks68.slice(60, 68)

  // --- Helper functions ---
  const centroid = (pts) => {
    const s = pts.reduce((a, p) => ({ x: a.x + p.x, y: a.y + p.y }), { x: 0, y: 0 })
    return { x: s.x / pts.length, y: s.y / pts.length }
  }

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)

  const widthOf = (pts) => {
    const xs = pts.map((p) => p.x)
    return Math.max(...xs) - Math.min(...xs)
  }

  const heightOf = (pts) => {
    const ys = pts.map((p) => p.y)
    return Math.max(...ys) - Math.min(...ys)
  }

  const features = []

  // --- Eye geometry (6 features) ---
  const leftEyeCenter = centroid(leftEye)
  const rightEyeCenter = centroid(rightEye)
  const interPupillaryDist = dist(leftEyeCenter, rightEyeCenter)
  const refDist = interPupillaryDist > 0 ? interPupillaryDist : 1.0

  const leftEyeW = widthOf(leftEye)
  const leftEyeH = heightOf(leftEye)
  const rightEyeW = widthOf(rightEye)
  const rightEyeH = heightOf(rightEye)

  features.push(leftEyeW / refDist)                                    // 1
  features.push(leftEyeH / refDist)                                    // 2
  features.push(rightEyeW / refDist)                                   // 3
  features.push(rightEyeH / refDist)                                   // 4
  features.push(leftEyeW > 0 ? leftEyeH / leftEyeW : 0)               // 5
  features.push(rightEyeW > 0 ? rightEyeH / rightEyeW : 0)            // 6

  // --- Eyebrow geometry (6 features) ---
  const leftBrowCenter = centroid(leftEyebrow)
  const rightBrowCenter = centroid(rightEyebrow)
  const leftBrowW = widthOf(leftEyebrow)
  const rightBrowW = widthOf(rightEyebrow)
  const leftBrowH = heightOf(leftEyebrow)
  const rightBrowH = heightOf(rightEyebrow)

  features.push(leftBrowW / refDist)                                   // 7
  features.push(rightBrowW / refDist)                                  // 8
  features.push(leftBrowH / refDist)                                   // 9
  features.push(rightBrowH / refDist)                                  // 10
  features.push(dist(leftBrowCenter, leftEyeCenter) / refDist)        // 11
  features.push(dist(rightBrowCenter, rightEyeCenter) / refDist)      // 12

  // --- Nose geometry (6 features) ---
  // Swift: noseCrest = noseBridge (indices 27-30), nose = noseBase (indices 31-35)
  const noseW = widthOf(noseBase)
  const noseH = heightOf(noseBase)
  const noseCrestH = heightOf(noseBridge)
  const noseCrestW = widthOf(noseBridge)
  const noseCenter = centroid(noseBase)
  const noseTip = noseBridge[noseBridge.length - 1]  // last of nose bridge = landmarks68[30]

  features.push(noseW / refDist)                                       // 13
  features.push(noseH / refDist)                                       // 14
  features.push(noseW > 0 ? noseH / noseW : 0)                        // 15
  features.push(noseCrestW / refDist)                                  // 16
  features.push(noseCrestH / refDist)                                  // 17
  const eyeMidForNose = { x: (leftEyeCenter.x + rightEyeCenter.x) / 2, y: (leftEyeCenter.y + rightEyeCenter.y) / 2 }
  features.push(dist(noseTip, eyeMidForNose) / refDist)               // 18

  // --- Mouth geometry (8 features) ---
  const outerLipsW = widthOf(outerLips)
  const outerLipsH = heightOf(outerLips)
  const innerLipsW = widthOf(innerLips)
  const innerLipsH = heightOf(innerLips)
  const mouthCenter = centroid(outerLips)

  features.push(outerLipsW / refDist)                                  // 19
  features.push(outerLipsH / refDist)                                  // 20
  features.push(outerLipsW > 0 ? outerLipsH / outerLipsW : 0)         // 21
  features.push(innerLipsW / refDist)                                  // 22
  features.push(innerLipsH / refDist)                                  // 23
  features.push(innerLipsW > 0 ? innerLipsH / innerLipsW : 0)         // 24
  features.push(dist(mouthCenter, noseCenter) / refDist)              // 25

  // Mouth corner span
  if (outerLips.length >= 2) {
    const leftCorner = outerLips[0]
    const rightCorner = outerLips[Math.floor(outerLips.length / 2)]
    features.push(dist(leftCorner, rightCorner) / refDist)            // 26
  } else {
    features.push(0)
  }

  // --- Face proportions (6 features) ---
  // Swift uses bounding box faceWidth/faceHeight — face-api.js uses detection.box
  // We approximate using faceContour span
  const contourXs = faceContour.map((p) => p.x)
  const contourYs = faceContour.map((p) => p.y)
  const faceW = Math.max(...contourXs) - Math.min(...contourXs)
  const faceH = Math.max(...contourYs) - Math.min(...contourYs)
  const faceAspect = faceH > 0 ? faceW / faceH : 1.0
  features.push(faceAspect)                                            // 27

  const eyeMidY = (leftEyeCenter.y + rightEyeCenter.y) / 2
  const noseTipY = noseTip.y
  const mouthCenterY = mouthCenter.y
  // In face-api.js, y increases downward (unlike Vision which was flipped)
  const faceTop = Math.min(...contourYs)     // smallest y = top of head
  const faceBottom = Math.max(...contourYs)  // largest y = chin
  const faceVerticalSpan = faceBottom - faceTop
  if (faceVerticalSpan <= 0) {
    // pad remaining features with zeros
    while (features.length < 45) features.push(0)
    return features
  }

  features.push((eyeMidY - faceTop) / faceVerticalSpan)              // 28: upper face
  features.push((noseTipY - eyeMidY) / faceVerticalSpan)             // 29: mid face
  features.push((faceBottom - noseTipY) / faceVerticalSpan)          // 30: lower face
  features.push((faceBottom - mouthCenterY) / faceVerticalSpan)      // 31: chin proportion
  features.push(interPupillaryDist / faceVerticalSpan)               // 32: IPD ratio

  // --- Jaw shape (7 features) ---
  if (faceContour.length >= 5) {
    const jaw = faceContour
    const count = jaw.length
    const jawBottom = jaw[Math.floor(count / 2)]  // chin
    const jawLeftLow = jaw[Math.floor(count / 4)]
    const jawRightLow = jaw[Math.floor(3 * count / 4)]
    const jawLeftHigh = jaw[1]
    const jawRightHigh = jaw[count - 2]

    const jawWidthLow = dist(jawLeftLow, jawRightLow)
    const jawWidthHigh = dist(jawLeftHigh, jawRightHigh)

    features.push(jawWidthLow / refDist)                              // 33
    features.push(jawWidthHigh / refDist)                             // 34
    features.push(jawWidthHigh > 0 ? jawWidthLow / jawWidthHigh : 0) // 35

    const chinToLeftAngle = Math.atan2(jawLeftLow.y - jawBottom.y, jawLeftLow.x - jawBottom.x)
    const chinToRightAngle = Math.atan2(jawRightLow.y - jawBottom.y, jawRightLow.x - jawBottom.x)
    features.push(chinToLeftAngle)                                    // 36
    features.push(chinToRightAngle)                                   // 37
    features.push(chinToLeftAngle + chinToRightAngle)                 // 38

    const jawSideMid = {
      x: (jawLeftLow.x + jawRightLow.x) / 2,
      y: (jawLeftLow.y + jawRightLow.y) / 2,
    }
    features.push(dist(jawBottom, jawSideMid) / refDist)             // 39
  } else {
    for (let i = 0; i < 7; i++) features.push(0)
  }

  // --- Relative positions (6 features) ---
  const eyeMidpoint = {
    x: (leftEyeCenter.x + rightEyeCenter.x) / 2,
    y: (leftEyeCenter.y + rightEyeCenter.y) / 2,
  }

  features.push(dist(eyeMidpoint, noseTip) / refDist)                // 40
  features.push(dist(noseTip, mouthCenter) / refDist)                // 41

  const chinX = (faceContour[0].x + faceContour[faceContour.length - 1].x) / 2
  const chinY = Math.max(...faceContour.map((p) => p.y))
  features.push(dist(mouthCenter, { x: chinX, y: chinY }) / refDist) // 42

  features.push(dist(eyeMidpoint, mouthCenter) / refDist)            // 43
  features.push((noseCenter.x - eyeMidpoint.x) / refDist)            // 44: nose lateral offset
  features.push((mouthCenter.x - eyeMidpoint.x) / refDist)           // 45: mouth lateral offset

  return features
}

/**
 * Compare two face embeddings.
 * Port of FaceRecognitionService.compareFaces().
 *
 * Returns similarity in [0, 1]:
 *   ≥ 0.75 → confirmed same person
 *   0.55–0.74 → uncertain
 *   < 0.55 → rejected
 */
function compareFaces(a, b) {
  if (!a || !b || a.length !== b.length) return 0

  let sumSq = 0
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i]
    sumSq += d * d
  }
  const distance = Math.sqrt(sumSq)
  const sigma = 1.5
  return Math.exp(-distance / sigma)
}

const THRESHOLDS = {
  confirmed: 0.60,
  uncertain: 0.40,
}

function categorize(score) {
  if (score >= THRESHOLDS.confirmed) return 'confirmed'
  if (score >= THRESHOLDS.uncertain) return 'uncertain'
  return 'rejected'
}

module.exports = { generateEmbedding, compareFaces, categorize, THRESHOLDS }
