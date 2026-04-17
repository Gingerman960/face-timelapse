const { app, BrowserWindow, ipcMain, dialog, protocol } = require('electron')

// Must be called before app is ready
protocol.registerSchemesAsPrivileged([
  { scheme: 'safe-file', privileges: { secure: true, standard: true, supportFetchAPI: true } },
])
const path = require('path')
const os = require('os')
const fs = require('fs')

// Services
const { initFaceDetection, detectFaceFromBuffer } = require('./services/faceDetection')
const { generateEmbedding } = require('./services/faceEmbedding')
const { alignImage, scalePoints } = require('./services/alignment')
const { scanFolder } = require('./services/photoScanner')
const { exportToFolder } = require('./services/exportService')
const { createVideo } = require('./services/videoExport')

let mainWindow = null
let cancelToken = { cancelled: false }

function getModelsPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'models')
  }
  return path.join(__dirname, '../models')
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
    console.log('Face detection models loaded')
  } catch (err) {
    console.error('Failed to load face detection models:', err)
  }

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// --- IPC Handlers ---

// Set reference photo: crop via sharp, detect face, return embedding + preview base64
ipcMain.handle('face:setReference', async (event, { imagePath, cropParams, aspectRatio, rotationAngle }) => {
  const sharp = require('sharp')
  const OUTPUT_SIZES = {
    '1:1': { w: 512, h: 512 },
    '4:3': { w: 512, h: 384 },
    '16:9': { w: 512, h: 288 },
    '9:16': { w: 288, h: 512 },
    '3:4': { w: 384, h: 512 },
  }

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
  cancelToken = { cancelled: false }

  let lastProgressTime = 0
  const results = await scanFolder(
    folderPath,
    referenceEmbedding,
    getModelsPath(),
    cancelToken,
    (progress) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        const now = Date.now()
        // Throttle IPC messages to max 20fps to prevent OOM
        if (now - lastProgressTime > 50 || progress.index === progress.total - 1) {
          lastProgressTime = now
          mainWindow.webContents.send('scan:progress', progress)
        }
      }
    }
  )

  return results
})

// Cancel scan
ipcMain.handle('face:cancelScan', async () => {
  cancelToken.cancelled = true
})

// Align a batch of photos using worker threads
ipcMain.handle('face:alignBatch', async (event, { candidates, referenceAlignmentPoints, referenceImageSize, outputSize }) => {
  const { Worker } = require('worker_threads')
  const tmpDir = path.join(os.tmpdir(), 'facetimelapse')
  fs.mkdirSync(tmpDir, { recursive: true })

  const results = new Array(candidates.length)
  const total = candidates.length
  let completed = 0

  const numCpus = Math.max(1, os.cpus().length - 1) // Leave one core for main thread
  const maxWorkers = Math.min(numCpus, candidates.length)
  let currentIndex = 0
  let lastProgressTime = 0

  return new Promise((resolve) => {
    const workers = []

    const assignTask = (worker) => {
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

      worker.on('message', (msg) => {
        if (msg.type === 'ready') {
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
            workers.forEach(w => w.terminate())
            resolve(results)
          } else {
            assignTask(worker)
          }
        } else if (msg.type === 'error') {
          console.error(`Worker init error:`, msg.error)
        }
      })

      worker.on('error', (err) => {
        console.error(`Worker threw hard error:`, err)
        // If a worker crashes hard, we could respawn it, but for now we just log it.
        // It shouldn't crash unless there is an out of memory exception.
      })

      workers.push(worker)
    }

    // Start initial workers
    for (let i = 0; i < maxWorkers; i++) {
      startWorker()
    }
  })
})

// Replaced with worker threads above

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
  const os = require('os')
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
