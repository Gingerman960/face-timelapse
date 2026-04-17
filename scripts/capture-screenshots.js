#!/usr/bin/env node
/**
 * Capture the four README screenshots by driving the app via
 * Playwright-for-Electron.
 *
 * Usage:
 *   SCREENSHOT_REFERENCE=/abs/path/to/ref.jpg \
 *   SCREENSHOT_FOLDER=/abs/path/to/photos \
 *   npm run capture:screenshots
 *
 * What it does:
 *   1. Runs `vite build` so Electron loads the prod renderer (no DevTools)
 *   2. Stride-samples ~150 photos from SCREENSHOT_FOLDER into a temp dir so
 *      the scan completes in seconds, not minutes
 *   3. Launches Electron under Playwright, overrides the chooseFile /
 *      chooseFolder IPC handlers to return the provided paths
 *   4. Walks the wizard: setup → scanning → (confirm if any uncertain) →
 *      dailySelection → aligning → results, capturing a PNG at each
 *      meaningful state to assets/screenshots/
 *   5. Cleans up the temp dir
 *
 * The production IPC handlers are untouched — overrides happen in the
 * live Electron process via electronApp.evaluate().
 */

const { _electron: electron } = require('playwright')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { execSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const OUT_DIR = path.join(ROOT, 'assets', 'screenshots')
const SAMPLE_SIZE = 250
const SCAN_WAIT_MS = 300_000
const SUPPORTED_EXT = new Set(['.jpg', '.jpeg', '.png', '.heic', '.tiff', '.tif', '.webp'])

async function main() {
  const REFERENCE = process.env.SCREENSHOT_REFERENCE
  const FOLDER = process.env.SCREENSHOT_FOLDER

  if (!REFERENCE || !FOLDER) {
    console.error('ERROR: set SCREENSHOT_REFERENCE and SCREENSHOT_FOLDER env vars')
    console.error('Example:')
    console.error('  SCREENSHOT_REFERENCE=/abs/ref.jpg SCREENSHOT_FOLDER=/abs/photos npm run capture:screenshots')
    process.exit(1)
  }
  if (!fs.existsSync(REFERENCE)) throw new Error(`reference not found: ${REFERENCE}`)
  if (!fs.existsSync(FOLDER)) throw new Error(`folder not found: ${FOLDER}`)

  fs.mkdirSync(OUT_DIR, { recursive: true })

  console.log('[1/5] Building renderer (vite build)...')
  execSync('npx vite build', { cwd: ROOT, stdio: 'inherit' })

  const tmpSubset = buildPhotoSubset(FOLDER, REFERENCE)
  console.log(`[2/5] Sampled ${fs.readdirSync(tmpSubset).length} photos into ${tmpSubset}`)

  console.log('[3/5] Launching Electron under Playwright...')
  const electronApp = await electron.launch({
    args: [ROOT],
    env: { ...process.env, NODE_ENV: 'production' },
  })

  // Surface main-process stdout/stderr so scan progress and errors are
  // visible in the capture script's log. Essential for debugging why a
  // scan returned zero matches.
  const mainProc = electronApp.process()
  if (mainProc.stdout) mainProc.stdout.on('data', (b) => process.stdout.write('[main]   ' + b))
  if (mainProc.stderr) mainProc.stderr.on('data', (b) => process.stderr.write('[main-e] ' + b))

  const page = await electronApp.firstWindow()
  page.on('console', (msg) => {
    const t = msg.type()
    if (t === 'error' || t === 'warning') {
      console.log(`[render-${t}]`, msg.text())
    }
  })
  page.on('pageerror', (err) => console.log('[render-err]', err.message))

  await waitForAppReady(page)

  // Resize to a consistent 1440×900 so screenshots are reproducible across
  // machines with different default BrowserWindow sizes. setContentSize
  // avoids platform-specific chrome (titlebar) changing the inner width.
  await electronApp.evaluate(async ({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows()
    if (windows[0]) {
      windows[0].setContentSize(1440, 900)
      windows[0].center()
    }
  })
  await page.waitForTimeout(300)

  // Install IPC overrides AFTER the app has booted, so main.js's own
  // handlers exist to be replaced.
  await electronApp.evaluate(({ ipcMain }, { ref, folder }) => {
    ipcMain.removeHandler('dialog:chooseFile')
    ipcMain.handle('dialog:chooseFile', async () => ref)
    ipcMain.removeHandler('dialog:chooseFolder')
    ipcMain.handle('dialog:chooseFolder', async () => folder)
  }, { ref: REFERENCE, folder: tmpSubset })

  try {
    console.log('[4/5] Driving the wizard...')
    await captureSetup(page)
    await captureScanning(page)
    await captureDailySelection(page)
    await captureResults(page)
    console.log('[5/5] All four screenshots saved to', OUT_DIR)
  } finally {
    await electronApp.close()
    try { fs.rmSync(tmpSubset, { recursive: true, force: true }) } catch (_) {}
  }
}

function buildPhotoSubset(sourceFolder, referencePath) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'facetimelapse-capture-'))
  const all = fs.readdirSync(sourceFolder)
    .filter((n) => SUPPORTED_EXT.has(path.extname(n).toLowerCase()))
    .sort()
  if (all.length === 0) throw new Error(`no supported images in ${sourceFolder}`)

  // Pick photos whose sorted-filename position is near the reference
  // filename's. Assumes `IMG_YYYYMMDD_HHMMSS` or similar date-prefixed
  // names — close sort position ≈ close in time ≈ same subject.
  // This produces a meaningful daily-selection screenshot (several days
  // clustered around the reference date) AND a high face-match ratio so
  // the scan does real detection work (not just instant skips).
  const refName = path.basename(referencePath)
  let anchor = all.findIndex((n) => n >= refName)
  if (anchor < 0) anchor = Math.floor(all.length / 2)

  const half = Math.floor(SAMPLE_SIZE / 2)
  const start = Math.max(0, anchor - half)
  const end = Math.min(all.length, start + SAMPLE_SIZE)
  const picks = all.slice(start, end)

  for (const name of picks) {
    try {
      fs.symlinkSync(path.join(sourceFolder, name), path.join(tmp, name))
    } catch (_) {
      fs.copyFileSync(path.join(sourceFolder, name), path.join(tmp, name))
    }
  }
  return tmp
}

async function waitForAppReady(page) {
  await page.waitForSelector('.app-header', { timeout: 30_000 })
}

async function captureSetup(page) {
  await page.getByRole('button', { name: 'Choose Reference Photo' }).click()
  await page.waitForSelector('.crop-container img', { timeout: 15_000 })

  await page.getByRole('button', { name: 'Choose Folder' }).click()
  await page.waitForSelector('.path-display', { timeout: 5000 })

  // Wait for the reference-detection round-trip to finish: the Start Scan
  // button stays disabled until referenceEmbedding AND sourceFolderPath
  // are both set. Polling its disabled state is more reliable than a
  // fixed sleep, especially on cold-start WASM loads.
  await page.waitForFunction(
    () => {
      const btn = document.querySelector('.start-btn')
      return btn && !btn.disabled
    },
    { timeout: 60_000 }
  )
  await page.waitForTimeout(500)

  await page.screenshot({ path: path.join(OUT_DIR, 'setup.png') })
  console.log('  captured setup.png')
}

async function captureScanning(page) {
  await page.getByRole('button', { name: 'Start Scan' }).click()
  // ScanningView has a .progress-track that doesn't exist on SetupView —
  // use it as the transition signal rather than title text (which has a
  // Unicode ellipsis that innerText sometimes normalizes).
  try {
    await page.waitForSelector('.progress-track', { timeout: 30_000 })
  } catch (err) {
    const state = await page.evaluate(() => ({
      stepBadge: [...document.querySelectorAll('.step-badge')].find((el) => el.classList.contains('current'))?.textContent || null,
      bodyStart: document.body.innerText.slice(0, 400),
    }))
    console.error('scanning view did not appear. Current state:', JSON.stringify(state, null, 2))
    throw err
  }

  // Let counters and thumbnails populate so the screenshot shows real
  // work in progress instead of an empty scanning frame.
  await page.waitForSelector('.scan-counter', { timeout: 20_000 })
  await page.waitForTimeout(3000)

  await page.screenshot({ path: path.join(OUT_DIR, 'scanning.png') })
  console.log('  captured scanning.png')
}

async function captureDailySelection(page) {
  // Scan eventually navigates to either ConfirmView (if any uncertain
  // matches) or DailySelectionView. Handle both.
  await page.waitForFunction(
    () => /Calendar|Review Uncertain/.test(document.body.innerText),
    { timeout: SCAN_WAIT_MS }
  )

  const onConfirm = await page.locator('text=Review Uncertain').count() > 0
  if (onConfirm) {
    // Skip through the review step — the daily selection shot is the
    // more informative one for the README.
    await page.getByRole('button', { name: 'Done Reviewing' }).click()
  }

  await page.waitForSelector('text=Calendar', { timeout: 15_000 })
  // Let the 4-concurrency thumbnail loader catch up on the first day.
  await page.waitForTimeout(4000)

  await page.screenshot({ path: path.join(OUT_DIR, 'daily-selection.png') })
  console.log('  captured daily-selection.png')
}

async function captureResults(page) {
  // Align button lives in the fixed daily-footer. Using a structural
  // selector avoids issues with the button label flipping to
  // "Aligning…" the moment it's clicked.
  await page.locator('.daily-footer .btn-primary').click()

  // Wait for AligningView to appear — progress-track is present there too.
  await page.waitForSelector('.thumb-grid', { timeout: 30_000 })
  console.log('  alignment in progress, waiting for completion...')

  // The results gallery is unique to ResultsView.
  await page.waitForSelector('.results-gallery', { timeout: 600_000 })
  // Let the IntersectionObserver kick off a batch of b64 loads.
  await page.waitForTimeout(8000)

  await page.screenshot({ path: path.join(OUT_DIR, 'results.png') })
  console.log('  captured results.png')
}

main().catch((err) => {
  console.error('CAPTURE FAILED:', err)
  process.exit(1)
})
