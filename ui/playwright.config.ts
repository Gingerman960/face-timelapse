import { defineConfig, devices } from '@playwright/test'

// E2E runs against the Vite dev server (the same port 1420 `tauri dev` uses)
// with the in-memory fake backend: Playwright starts it with `--mode mock`
// (.env.mock sets VITE_FT_MOCK=1); a reused plain dev server installs the mock
// too, because the browser is not inside Tauri. FT_E2E_PORT picks another
// port. Screenshot baselines live in e2e/__screenshots__ and are generated
// from synthetic stand-ins only, never from real photos. Visual specs are
// titled "(light|dark) W×H" so CI can skip them off macOS.
const PORT = Number(process.env.FT_E2E_PORT ?? 1420)

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results',
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFileName}/{arg}-{platform}{ext}',
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  timeout: 60_000,
  expect: {
    timeout: 10_000,
    toHaveScreenshot: { maxDiffPixelRatio: 0.01, animations: 'disabled', caret: 'hide' },
  },
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', testIgnore: /perf\.spec\.ts/, use: { ...devices['Desktop Chrome'], deviceScaleFactor: 1 } },
    // Frame-time budgets need a quiet machine: run after every other test, one at a time.
    { name: 'perf', testMatch: /perf\.spec\.ts/, dependencies: ['chromium'], fullyParallel: false, use: { ...devices['Desktop Chrome'], deviceScaleFactor: 1 } },
  ],
  webServer: {
    command: `npx vite --port ${PORT} --strictPort --mode mock`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
})
