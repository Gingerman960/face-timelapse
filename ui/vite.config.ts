/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { mockImages } from './vite/mockImages.ts'

// The Tauri shell runs the `dev` script (devUrl http://localhost:1420, the
// Tauri convention; 5173 is often taken by other local Vite servers) and the
// `build` script (frontendDist ../ui/dist). In a plain browser, or with
// VITE_FT_MOCK=1, src/main.tsx installs the in-memory fake backend and the
// mockImages dev middleware serves synthetic stand-in images under /__mock/img/.
export default defineConfig({
  plugins: [react(), mockImages()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  preview: { port: 1421, strictPort: true },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    // WKWebView on macOS 11+ with Safari 16 updates; WebView2 and WebKitGTK are newer.
    target: ['es2022', 'safari16'],
    cssTarget: ['safari16'],
    outDir: 'dist',
    sourcemap: false,
    reportCompressedSize: true,
    // The entry chunk carries React DOM (~180 kB raw); screens are split lazily.
    chunkSizeWarningLimit: 400,
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/test/**',
        'src/main.tsx',
        'src/**/*.d.ts',
        'src/ipc/contract.ts',
      ],
      reporter: ['text-summary', 'text', 'json-summary'],
    },
  },
})
