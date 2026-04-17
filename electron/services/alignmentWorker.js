const { parentPort, workerData } = require('worker_threads')
const sharp = require('sharp')
const path = require('path')
const fs = require('fs')

// We need to require these locally in the worker
const { detectFaceFromBuffer } = require('./faceDetection')
const { alignImage, scalePoints } = require('./alignment')
const { initFaceDetection } = require('./faceDetection')

// Initialize once
initFaceDetection(workerData.modelsPath).then(() => {
    // Tell parent we're ready for tasks
    parentPort.postMessage({ type: 'ready' })
}).catch(err => {
    parentPort.postMessage({ type: 'error', error: err.message })
})

parentPort.on('message', async (task) => {
    const { candidate, referenceAlignmentPoints, referenceImageSize, outputSize, tmpDir, index } = task

    try {
        // Load source image (uncompressed for best quality)
        const sourceBuffer = await sharp(candidate.filePath)
            .rotate()
            .png()
            .toBuffer()

        // Detect face
        const detection = await detectFaceFromBuffer(sourceBuffer)
        if (!detection) {
            parentPort.postMessage({ type: 'result', result: { ...candidate, error: 'No face detected', outputPath: null }, index })
            return
        }

        // Scale reference alignment points to match output size
        const scaledRefPoints = scalePoints(
            referenceAlignmentPoints,
            referenceImageSize,
            outputSize
        )

        // Align
        const alignedBuffer = await alignImage(
            sourceBuffer,
            detection.alignmentPoints,
            scaledRefPoints,
            outputSize
        )

        // Save to temp file
        const tmpFile = path.join(tmpDir, `aligned_${Date.now()}_${index}.png`)
        fs.writeFileSync(tmpFile, alignedBuffer)

        parentPort.postMessage({
            type: 'result',
            result: {
                ...candidate,
                outputPath: tmpFile,
                error: null,
            },
            index
        })
    } catch (err) {
        parentPort.postMessage({ type: 'result', result: { ...candidate, error: err.message, outputPath: null }, index })
    }
})
