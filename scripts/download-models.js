#!/usr/bin/env node
/**
 * Copy face-api.js model weights from the vladmandic/face-api package into models/.
 * Run: node scripts/download-models.js
 */

const fs = require('fs')
const path = require('path')

const MODELS_DIR = path.join(__dirname, '../models')
const FACE_API_MODELS = path.join(__dirname, '../node_modules/@vladmandic/face-api/model')

const REQUIRED_MODELS = [
  'ssd_mobilenetv1_model-weights_manifest.json',
  'ssd_mobilenetv1_model.bin',
  'face_landmark_68_model-weights_manifest.json',
  'face_landmark_68_model.bin',
]

function main() {
  fs.mkdirSync(MODELS_DIR, { recursive: true })

  if (!fs.existsSync(FACE_API_MODELS)) {
    console.error('face-api.js models not found. Run npm install first.')
    process.exit(1)
  }

  let copied = 0
  for (const filename of REQUIRED_MODELS) {
    const src = path.join(FACE_API_MODELS, filename)
    const dst = path.join(MODELS_DIR, filename)

    if (!fs.existsSync(src)) {
      console.warn(`  WARNING: ${filename} not found in face-api package`)
      continue
    }

    if (fs.existsSync(dst)) {
      console.log(`  SKIP (already exists): ${filename}`)
      continue
    }

    fs.copyFileSync(src, dst)
    console.log(`  COPIED: ${filename}`)
    copied++
  }

  console.log(`\nDone. ${copied} files copied to models/`)
}

main()
