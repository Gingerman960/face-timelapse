import { vi, beforeEach } from 'vitest'

// This setup file is loaded for *every* test file per vitest.config.js, but
// the DOM stubs below are only meaningful in happy-dom. For Node-only test
// files (services, alignment math) we short-circuit and do nothing.
const hasDom = typeof window !== 'undefined' && typeof document !== 'undefined'

if (hasDom) {
  await import('@testing-library/react')
}

// Mock window.electronAPI with vi.fn() stubs so views can render and
// interact without needing a real Electron preload bridge.
beforeEach(() => {
  if (!hasDom) return
  window.electronAPI = {
    setReference: vi.fn().mockResolvedValue({
      embedding: new Array(45).fill(0),
      landmarks68: Array.from({ length: 68 }, () => ({ x: 0, y: 0 })),
      alignmentPoints: Array.from({ length: 5 }, () => ({ x: 0, y: 0 })),
      imageSize: { w: 512, h: 512 },
      outputSize: { w: 512, h: 512 },
      previewBase64: 'AAAA',
    }),
    startScan: vi.fn().mockResolvedValue([]),
    cancelScan: vi.fn().mockResolvedValue(undefined),
    clearScanCache: vi.fn().mockResolvedValue(true),
    onScanProgress: vi.fn().mockReturnValue(() => {}),
    alignBatch: vi.fn().mockResolvedValue([]),
    cancelAlign: vi.fn().mockResolvedValue(undefined),
    onAlignProgress: vi.fn().mockReturnValue(() => {}),
    exportVideo: vi.fn().mockResolvedValue({ success: true }),
    onVideoProgress: vi.fn().mockReturnValue(() => {}),
    exportToFolder: vi.fn().mockResolvedValue([]),
    onExportProgress: vi.fn().mockReturnValue(() => {}),
    getImageBase64: vi.fn().mockResolvedValue('AAAA'),
    detectFaceBounds: vi.fn().mockResolvedValue(null),
    straightenImage: vi.fn().mockResolvedValue({ filePath: '/tmp/straightened.jpg' }),
    chooseFolder: vi.fn().mockResolvedValue(null),
    chooseFile: vi.fn().mockResolvedValue(null),
    savePath: vi.fn().mockResolvedValue(null),
  }

  // happy-dom doesn't provide IntersectionObserver
  if (!window.IntersectionObserver) {
    window.IntersectionObserver = class {
      constructor() {}
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  }
})
