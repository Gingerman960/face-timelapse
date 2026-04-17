const { app, BrowserWindow, ipcMain, dialog, protocol } = require('electron')
const { autoUpdater } = require('electron-updater')

// Must be called before app is ready
protocol.registerSchemesAsPrivileged([
  { scheme: 'safe-file', privileges: { secure: true, standard: true, supportFetchAPI: true } },
])
const path = require('path')
const os = require('os')
const fs = require('fs')

// Services
const { initFaceDetection, detectFaceFromBuffer, getActiveBackend } = require('./services/faceDetection')
const { generateEmbedding } = require('./services/faceEmbedding')
const { alignImage, scalePoints } = require('./services/alignment')
const { scanFolder } = require('./services/photoScanner')
const scanCache = require('./services/scanCache')
const { exportToFolder } = require('./services/exportService')
const { createVideo } = require('./services/videoExport')

// How long we wait for a worker thread to emit its `ready` message
// before deciding initialization has failed. Keeps a misconfigured
// install from hanging the alignment step forever.
const WORKER_READY_TIMEOUT_MS = 30_000

let mainWindow = null
let scanCancelToken = { cancelled: false }
let alignCancelToken = { cancelled: false }

function getModelsPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'models')
  }
  return path.join(__dirname, '../models')
}

function getTempDir() {
  return path.join(os.tmpdir(), 'facetimelapse')
}

function getScanCacheDir() {
  // Kept in the user data dir so it survives app updates and is per-user.
  return path.join(app.getPath('userData'), 'scans')
}

// Best-effort removal of every file we've ever written to the app's temp dir.
// Called on startup (leftovers from previous runs) and on quit.
function cleanupTempFiles() {
  const tmpDir = getTempDir()
  try {
    if (!fs.existsSync(tmpDir)) return
    for (const name of fs.readdirSync(tmpDir)) {
      try { fs.unlinkSync(path.join(tmpDir, name)) } catch (_) {}
    }
  } catch (_) {}

  // Straighten temp files land directly in os.tmpdir() with a known prefix.
  try {
    const root = os.tmpdir()
    for (const name of fs.readdirSync(root)) {
      if (name.startsWith('facetimelapse-straightened-')) {
        try { fs.unlinkSync(path.join(root, name)) } catch (_) {}
      }
    }
  } catch (_) {}
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#1a1a1a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  const isDev = !app.isPackaged && process.env.NODE_ENV !== 'production'

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

app.whenReady().then(async () => {
  cleanupTempFiles()

  // Drop scan caches older than 30 days so they don't accumulate forever
  // in the user data dir.
  try {
    const pruned = scanCache.pruneOld(getScanCacheDir())
    if (pruned > 0) console.log(`Pruned ${pruned} stale scan cache(s)`)
  } catch (err) {
    console.warn('scan cache prune failed:', err.message)
  }

  // Serve local files via safe-file:// to avoid file:// being blocked by the renderer.
  // With standard: true, the URL 'safe-file:///Users/foo' is parsed by Chromium as
  // host='users' + pathname='/foo', so we reconstruct the path as '/' + host + pathname.
  protocol.handle('safe-file', async (request) => {
    const url = new URL(request.url)
    const filePath = decodeURIComponent('/' + url.hostname + url.pathname)
    const ext = path.extname(filePath).toLowerCase()
    const mime = {
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
      '.gif': 'image/gif', '.webp': 'image/webp', '.tiff': 'image/tiff',
      '.tif': 'image/tiff'
    }[ext] || 'application/octet-stream'
    const data = await fs.promises.readFile(filePath)
    return new Response(data, { headers: { 'content-type': mime } })
  })

  try {
    await initFaceDetection(getModelsPath())
    console.log(`Face detection models loaded (backend: ${getActiveBackend() || 'unknown'})`)
  } catch (err) {
    console.error('Failed to load face detection models:', err)
  }

  createWindow()

  // Auto-update. Only runs in packaged builds (dev launches don't have an
  // update feed). Logs through electron-log-compatible console so failures
  // are visible in the user's app log.
  if (app.isPackaged) {
    try {
      autoUpdater.autoDownload = true
      autoUpdater.autoInstallOnAppQuit = true
      autoUpdater.on('update-available', (info) => {
        console.log(`Update available: ${info.version}`)
      })
      autoUpdater.on('update-downloaded', (info) => {
        console.log(`Update downloaded: ${info.version} — will install on next quit`)
      })
      autoUpdater.on('error', (err) => {
        // Don't surface this to the user — failing to *find* an update
        // shouldn't block normal usage.
        console.warn('autoUpdater error:', err.message)
      })
      autoUpdater.checkForUpdatesAndNotify().catch(() => {})
    } catch (err) {
      console.warn('autoUpdater init failed:', err.message)
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', cleanupTempFiles)

// --- IPC Handlers ---

// Set reference photo: crop via sharp, detect face, return embedding + preview base64
ipcMain.handle('face:setReference', async (event, { imagePath, cropParams, aspectRatio, rotationAngle }) => {
  const sharp = require('sharp')
  let pipeline = sharp(imagePath).rotate() // auto-orient from EXIF

  // Apply face-straightening rotation if provided
  if (rotationAngle && Math.abs(rotationAngle) > 0.01) {
    pipeline = pipeline.rotate(rotationAngle, { background: { r: 0, g: 0, b: 0, alpha: 1 } })
  }

  if (cropParams) {
    pipeline = pipeline.extract({
      left: Math.round(cropParams.x),
      top: Math.round(cropParams.y),
      width: Math.round(cropParams.width),
      height: Math.round(cropParams.height),
    })
  }

  const { data: croppedBuffer, info } = await pipeline.toBuffer({ resolveWithObject: true })

  // Always use the exact cropped dimensions to preserve aspect ratio and high resolution
  const outputSize = { w: info.width, h: info.height }

  const detection = await detectFaceFromBuffer(croppedBuffer)
  if (!detection) throw new Error('No face detected in reference photo')

  const embedding = generateEmbedding(detection.landmarks68)

  // Generate a smaller preview specifically for the UI to prevent slow base64 rendering
  const previewBuffer = await sharp(croppedBuffer)
    .resize(512, 512, { fit: 'inside' })
    .jpeg({ quality: 80 })
    .toBuffer()
  const previewBase64 = previewBuffer.toString('base64')

  return {
    embedding,
    landmarks68: detection.landmarks68,
    alignmentPoints: detection.alignmentPoints,
    imageSize: detection.imageSize,
    outputSize,
    previewBase64,
  }
})

// Start folder scan
ipcMain.handle('face:startScan', async (event, { folderPath, referenceEmbedding }) => {
  scanCancelToken = { cancelled: false }

  let lastProgressTime = 0
  const results = await scanFolder(
    folderPath,
    referenceEmbedding,
    getModelsPath(),
    scanCancelToken,
    (progress) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        const now = Date.now()
        // Throttle IPC messages to max 20fps to prevent OOM
        if (now - lastProgressTime > 50 || progress.index === progress.total - 1) {
          lastProgressTime = now
          mainWindow.webContents.send('scan:progress', progress)
        }
      }
    },
    getScanCacheDir()
  )

  return results
})

// Remove the cache for a specific (folder, reference) pair. Exposed so the
// user can force a full rescan when they suspect a stale cache — wire this
// up to a menu or settings panel later.
ipcMain.handle('face:clearScanCache', async (_, { folderPath, referenceEmbedding } = {}) => {
  if (!folderPath) return false
  const key = scanCache.cacheKey(folderPath, referenceEmbedding)
  const file = scanCache.cacheFilePath(getScanCacheDir(), key)
  try {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file)
      return true
    }
  } catch (err) {
    console.warn('clearScanCache failed:', err.message)
  }
  return false
})

// Cancel scan
ipcMain.handle('face:cancelScan', async () => {
  scanCancelToken.cancelled = true
})

// Cancel alignment: terminate worker pool and resolve with partial results.
ipcMain.handle('face:cancelAlign', async () => {
  alignCancelToken.cancelled = true
})

// Align a batch of photos using worker threads
ipcMain.handle('face:alignBatch', async (event, { candidates, referenceAlignmentPoints, referenceImageSize, outputSize }) => {
  const { Worker } = require('worker_threads')
  const tmpDir = getTempDir()
  fs.mkdirSync(tmpDir, { recursive: true })

  alignCancelToken = { cancelled: false }

  const results = new Array(candidates.length)
  const total = candidates.length
  let completed = 0
  let settled = false

  const numCpus = Math.max(1, os.cpus().length - 1) // Leave one core for main thread
  const maxWorkers = Math.min(numCpus, candidates.length)
  let currentIndex = 0
  let lastProgressTime = 0

  return new Promise((resolve, reject) => {
    const workers = []
    const readyTimeouts = new Map()

    const finish = (reason, err) => {
      if (settled) return
      settled = true
      for (const t of readyTimeouts.values()) clearTimeout(t)
      workers.forEach((w) => { try { w.terminate() } catch (_) {} })
      if (reason === 'error') reject(err)
      else resolve(results.filter((r) => r !== undefined))
    }

    const assignTask = (worker) => {
      if (alignCancelToken.cancelled) { finish('cancelled'); return false }
      if (currentIndex >= candidates.length) return false
      const idx = currentIndex++
      worker.postMessage({
        candidate: candidates[idx],
        referenceAlignmentPoints,
        referenceImageSize,
        outputSize,
        tmpDir,
        index: idx
      })
      return true
    }

    const startWorker = () => {
      const worker = new Worker(path.join(__dirname, 'services', 'alignmentWorker.js'), {
        workerData: { modelsPath: getModelsPath() }
      })

      // Watchdog: if a worker never emits `ready`, fail the whole batch
      // rather than hanging. Triggered most often when models fail to load.
      const readyTimer = setTimeout(() => {
        finish('error', new Error(
          `Alignment worker did not initialize within ${WORKER_READY_TIMEOUT_MS / 1000}s. ` +
          `Check that models are present (run "npm run download-models").`
        ))
      }, WORKER_READY_TIMEOUT_MS)
      readyTimeouts.set(worker, readyTimer)

      worker.on('message', (msg) => {
        if (alignCancelToken.cancelled) { finish('cancelled'); return }

        if (msg.type === 'ready') {
          const t = readyTimeouts.get(worker)
          if (t) { clearTimeout(t); readyTimeouts.delete(worker) }
          assignTask(worker)
        } else if (msg.type === 'result') {
          results[msg.index] = msg.result
          completed++

          if (mainWindow && !mainWindow.isDestroyed()) {
            const now = Date.now()
            // Throttle IPC messages to max 20fps to prevent OOM
            if (now - lastProgressTime > 50 || completed === total) {
              lastProgressTime = now
              mainWindow.webContents.send('align:progress', {
                current: completed,
                total,
                outputPath: msg.result.outputPath,
                filename: msg.result.filename || path.basename(msg.result.filePath)
              })
            }
          }

          if (completed === total) {
            finish('done')
          } else {
            assignTask(worker)
          }
        } else if (msg.type === 'error') {
          console.error('Worker init error:', msg.error)
          finish('error', new Error(`Alignment worker failed to initialize: ${msg.error}`))
        }
      })

      worker.on('error', (err) => {
        console.error('Alignment worker crashed:', err)
        // A single worker crash forfeits the batch — the renderer surfaces
        // the error and the user can retry once the underlying cause is fixed.
        finish('error', err)
      })

      workers.push(worker)
    }

    // Start initial workers
    for (let i = 0; i < maxWorkers; i++) {
      startWorker()
    }
  })
})

// Export video
ipcMain.handle('video:export', async (event, { imagePaths, outputPath, fps, totalDuration }) => {
  await createVideo(imagePaths, outputPath, fps, totalDuration, (progress) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('video:progress', progress)
    }
  })
  return { success: true }
})

// Export aligned images to folder
ipcMain.handle('export:toFolder', async (event, { alignedResults, outputFolder }) => {
  const outputPaths = await exportToFolder(alignedResults, outputFolder, (progress) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('export:progress', progress)
    }
  })
  return outputPaths
})

// Get base64 of a temp file (for displaying results in renderer)
ipcMain.handle('image:getBase64', async (event, { filePath }) => {
  const data = await fs.promises.readFile(filePath)
  return data.toString('base64')
})

// Dialog: choose folder
ipcMain.handle('dialog:chooseFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  })
  return result.canceled ? null : result.filePaths[0]
})

// Dialog: choose file
ipcMain.handle('dialog:chooseFile', async (event, { filters } = {}) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: filters || [
      { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'heic', 'tiff', 'webp'] },
    ],
  })
  return result.canceled ? null : result.filePaths[0]
})

// Straighten image: rotate by given angle, save to temp file, return new path
ipcMain.handle('image:straighten', async (event, { imagePath, angleDegrees }) => {
  const sharp = require('sharp')
  const tmpPath = path.join(os.tmpdir(), `facetimelapse-straightened-${Date.now()}.jpg`)
  await sharp(imagePath)
    .rotate()  // auto-orient from EXIF
    .rotate(angleDegrees, { background: { r: 0, g: 0, b: 0, alpha: 1 } })
    .jpeg({ quality: 92 })
    .toFile(tmpPath)
  return { filePath: tmpPath }
})

// Detect face in original image and return bounding box (for crop centering)
ipcMain.handle('face:detectBounds', async (event, { imagePath }) => {
  const sharp = require('sharp')
  const MAX = 1024
  const buffer = await sharp(imagePath)
    .rotate()
    .resize(MAX, MAX, { fit: 'inside' })
    .jpeg({ quality: 85 })
    .toBuffer()

  const detection = await detectFaceFromBuffer(buffer)
  if (!detection) return null

  const lm = detection.landmarks68
  const xs = lm.map((p) => p.x)
  const ys = lm.map((p) => p.y)

  // Eye centers: left eye = landmarks 36-41, right eye = landmarks 42-47
  const avgPt = (start, end) => {
    let sx = 0, sy = 0
    for (let i = start; i <= end; i++) { sx += lm[i].x; sy += lm[i].y }
    const n = end - start + 1
    return { x: sx / n, y: sy / n }
  }
  const leftEye = avgPt(36, 41)
  const rightEye = avgPt(42, 47)

  return {
    faceBox: {
      x: Math.min(...xs),
      y: Math.min(...ys),
      w: Math.max(...xs) - Math.min(...xs),
      h: Math.max(...ys) - Math.min(...ys),
    },
    leftEye,
    rightEye,
    imageSize: detection.imageSize,
  }
})

// Dialog: save path
ipcMain.handle('dialog:savePath', async (event, { defaultName, filters } = {}) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultName || 'export',
    filters: filters || [{ name: 'Video', extensions: ['mp4'] }],
  })
  return result.canceled ? null : result.filePath
})
