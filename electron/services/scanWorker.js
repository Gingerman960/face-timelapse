const { parentPort, workerData } = require('worker_threads')
const sharp = require('sharp')
const exifr = require('exifr')
const fs = require('fs')
const { detectFaceFromBuffer, initFaceDetection } = require('./faceDetection')
const { generateEmbedding, compareFaces, categorize } = require('./faceEmbedding')

initFaceDetection(workerData.modelsPath).then(() => {
    parentPort.postMessage({ type: 'ready' })
}).catch(err => {
    parentPort.postMessage({ type: 'error', error: err.message })
})

parentPort.on('message', async (task) => {
    const { filePath, filename, referenceEmbedding, index } = task

    try {
        // Thumbnail
        let thumbnailBase64 = null
        try {
            const thumbBuf = await sharp(filePath).rotate().resize(100, 100, { fit: 'cover' }).jpeg({ quality: 60 }).toBuffer()
            thumbnailBase64 = thumbBuf.toString('base64')
        } catch (_) { }

        // Scan buffer
        let scanBuffer
        try {
            scanBuffer = await sharp(filePath).rotate().resize(400, 400, { fit: 'inside' }).jpeg({ quality: 85 }).toBuffer()
        } catch (err) {
            parentPort.postMessage({ type: 'skipped', index, filename, thumbnailBase64 })
            return
        }

        let detection
        try {
            detection = await detectFaceFromBuffer(scanBuffer)
        } catch (_) { }

        if (!detection) {
            parentPort.postMessage({ type: 'skipped', index, filename, thumbnailBase64 })
            return
        }

        const embedding = generateEmbedding(detection.landmarks68)
        const score = compareFaces(referenceEmbedding, embedding)
        const status = categorize(score)

        if (status === 'rejected') {
            parentPort.postMessage({ type: 'skipped', index, filename, thumbnailBase64 })
            return
        }

        // Exif
        let creationDate = null
        try {
            const exif = await exifr.parse(filePath, { pick: ['DateTimeOriginal', 'CreateDate', 'ModifyDate'] })
            creationDate = exif?.DateTimeOriginal || exif?.CreateDate || exif?.ModifyDate || null
        } catch (_) { }

        if (!creationDate) {
            try {
                creationDate = fs.statSync(filePath).birthtime
            } catch (_) {
                creationDate = new Date()
            }
        }

        parentPort.postMessage({
            type: 'result',
            index,
            result: {
                filePath,
                filename,
                embedding,
                similarityScore: score,
                status,
                creationDate: creationDate instanceof Date ? creationDate.toISOString() : new Date(creationDate).toISOString(),
            },
            thumbnailBase64
        })

    } catch (err) {
        parentPort.postMessage({ type: 'skipped', index, filename, thumbnailBase64: null })
    }
})
