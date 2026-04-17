'use strict'

const fs = require('fs')
const path = require('path')

/**
 * Export aligned images to a folder with YYYYMMDD file naming.
 * Port of exportService logic from plan.
 *
 * @param {Array<{outputPath: string|null, creationDate: string}>} alignedResults
 * @param {string} outputFolder
 * @param {Function} onProgress
 * @returns {Promise<string[]>} Output file paths
 */
async function exportToFolder(alignedResults, outputFolder, onProgress) {
  fs.mkdirSync(outputFolder, { recursive: true })

  const usedNames = new Set()
  const outputPaths = []
  const total = alignedResults.length

  for (let i = 0; i < alignedResults.length; i++) {
    const result = alignedResults[i]

    if (!result.outputPath) continue

    const filename = generateFilename(result.creationDate, usedNames)
    usedNames.add(filename)

    const destPath = path.join(outputFolder, filename)

    try {
      fs.copyFileSync(result.outputPath, destPath)
      outputPaths.push(destPath)
    } catch (err) {
      console.error(`Failed to copy ${result.outputPath}: ${err.message}`)
    }

    onProgress({ current: i + 1, total, filename })
  }

  return outputPaths
}

/**
 * Generate a YYYYMMDD.png filename for a given ISO date string.
 * Handles collisions by appending _1, _2, etc.
 *
 * @param {string} isoDate
 * @param {Set<string>} usedNames - Already used filenames (with extension)
 */
function generateFilename(isoDate, usedNames) {
  let date
  try {
    date = new Date(isoDate)
    if (isNaN(date.getTime())) date = new Date()
  } catch (_) {
    date = new Date()
  }

  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  const base = `${y}${m}${d}`

  let candidate = `${base}.png`
  let suffix = 1

  while (usedNames.has(candidate)) {
    candidate = `${base}_${suffix}.png`
    suffix++
  }

  return candidate
}

module.exports = { exportToFolder, generateFilename }
