'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')
const ffmpeg = require('fluent-ffmpeg')
let ffmpegStatic = require('ffmpeg-static')

// Fix path for packaged app (ffmpeg-static can't run from inside .asar)
if (typeof ffmpegStatic === 'string' && ffmpegStatic.includes('app.asar')) {
  ffmpegStatic = ffmpegStatic.replace('app.asar', 'app.asar.unpacked')
}
if (ffmpegStatic) {
  ffmpeg.setFfmpegPath(ffmpegStatic)
}

/**
 * Create an MP4 timelapse video from a list of image paths.
 * Port of VideoExportService.swift adapted for fluent-ffmpeg.
 *
 * @param {string[]} imagePaths - Ordered list of aligned image file paths
 * @param {string} outputPath - Destination .mp4 path
 * @param {number} fps - Frames per second
 * @param {number} totalDuration - Total video duration in seconds
 * @param {Function} onProgress - Called with { percent, timemark }
 */
async function createVideo(imagePaths, outputPath, fps, totalDuration, onProgress) {
  return new Promise((resolve, reject) => {
    const frameDuration = totalDuration / imagePaths.length

    // Write ffmpeg concat list to a temp file
    const concatListPath = path.join(os.tmpdir(), `facetimelapse_concat_${Date.now()}.txt`)
    const lines = imagePaths.map((p, i) => {
      // Normalize path separators (Windows fix)
      const normalized = p.replace(/\\/g, '/')
      const duration = i === imagePaths.length - 1
        ? frameDuration * 2  // repeat last frame to avoid truncation
        : frameDuration
      return `file '${normalized}'\nduration ${duration.toFixed(6)}`
    })
    fs.writeFileSync(concatListPath, lines.join('\n'))

    ffmpeg()
      .input(concatListPath)
      .inputOptions(['-f concat', '-safe 0'])
      .videoCodec('libx264')
      .outputOptions([
        `-r ${fps}`,
        '-pix_fmt yuv420p',
        '-preset fast',
        '-crf 23',
        '-vf scale=trunc(iw/2)*2:trunc(ih/2)*2',  // ensure even dimensions for H.264
        '-movflags +faststart',
      ])
      .output(outputPath)
      .on('progress', (progress) => {
        let percent = 0
        if (progress.timemark) {
          // Manually calculate percent because FFmpeg's concat demuxer produces massive negative percents
          const parts = progress.timemark.split(':')
          if (parts.length === 3) {
            const h = parseInt(parts[0], 10)
            const m = parseInt(parts[1], 10)
            const s = parseFloat(parts[2])
            const currentSecs = h * 3600 + m * 60 + s
            percent = (currentSecs / totalDuration) * 100
          }
        }
        // Clamp between 0 and 100
        percent = Math.max(0, Math.min(100, percent))
        onProgress({ percent, timemark: progress.timemark })
      })
      .on('end', () => {
        fs.unlink(concatListPath, () => { })
        resolve()
      })
      .on('error', (err) => {
        fs.unlink(concatListPath, () => { })
        reject(new Error(`FFmpeg error: ${err.message}`))
      })
      .run()
  })
}

module.exports = { createVideo }
