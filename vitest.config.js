import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    root: '.',
    include: [
      'tests/**/*.test.js',
      'tests/**/*.test.jsx',
    ],
    // Per-file environment selection:
    // - renderer component tests use happy-dom
    // - Node/service tests stay on Node
    environmentMatchGlobs: [
      ['tests/renderer/**', 'happy-dom'],
    ],
    setupFiles: ['tests/renderer/setup.js'],
  },
})
