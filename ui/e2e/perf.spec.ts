import { expect, test, type Page } from '@playwright/test'
import { MOD, openApp } from './helpers'

// Frame-time budgets need a quiet machine; shared CI runners are not one.
test.skip(Boolean(process.env.CI) && !process.env.FT_PERF, 'perf budgets run locally (set FT_PERF=1 to run them in CI)')

/**
 * The mock serves SVG stand-ins, and Chromium renders SVG images on the main
 * thread (about 1.6 s of main-thread work per 2.5 s fling here), while the
 * real `ftimg` thumbnails are JPEGs decoded off the main thread. So these
 * tests swap the stand-ins for a few JPEGs of the same size, keeping the
 * measurement about the app rather than the stand-in format.
 */
async function useJpegStandIns(page: Page): Promise<void> {
  await page.goto('about:blank')
  const variants: string[] = await page.evaluate(async () => {
    const out: string[] = []
    for (let i = 0; i < 8; i++) {
      const c = new OffscreenCanvas(320, 240)
      const g = c.getContext('2d')
      if (!g) throw new Error('no 2d context')
      const bg = g.createLinearGradient(0, 0, 0, 240)
      bg.addColorStop(0, `hsl(${30 + i * 25} 18% 62%)`)
      bg.addColorStop(1, `hsl(${30 + i * 25} 14% 38%)`)
      g.fillStyle = bg
      g.fillRect(0, 0, 320, 240)
      g.fillStyle = `hsl(${20 + i * 3} 38% ${58 + i}%)`
      g.beginPath()
      g.ellipse(160, 110, 52, 68, 0, 0, Math.PI * 2)
      g.fill()
      const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.82 })
      const bytes = new Uint8Array(await blob.arrayBuffer())
      let bin = ''
      for (const b of bytes) bin += String.fromCharCode(b)
      out.push(btoa(bin))
    }
    return out
  })
  const bodies = variants.map((b64) => Buffer.from(b64, 'base64'))
  await page.route('**/__mock/img/**', (route) => {
    const url = route.request().url()
    let h = 0
    for (let i = 0; i < url.length; i++) h = (h * 31 + url.charCodeAt(i)) >>> 0
    return route.fulfill({
      body: bodies[h % bodies.length],
      contentType: 'image/jpeg',
      headers: { 'cache-control': 'public, max-age=31536000, immutable' },
    })
  })
}

/**
 * ARCHITECTURE §11: 60 fps while flinging a 3,600-item grid and the calendar.
 * Samples rAF intervals and long tasks while scrolling programmatically.
 */
async function flingAndMeasure(page: import('@playwright/test').Page, selector: string) {
  return page.evaluate(async (sel) => {
    const el = document.querySelector<HTMLElement>(sel)
    if (!el) throw new Error(`missing ${sel}`)
    const frames: number[] = []
    const longTasks: number[] = []
    const po = new PerformanceObserver((list) => list.getEntries().forEach((e) => longTasks.push(e.duration)))
    try {
      po.observe({ type: 'longtask', buffered: false })
    } catch {
      /* longtask unsupported */
    }
    let last = performance.now()
    const end = last + 2500
    await new Promise<void>((resolve) => {
      const tick = (t: number) => {
        frames.push(t - last)
        last = t
        el.scrollTop += 140
        if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2) el.scrollTop = 0
        if (t < end) requestAnimationFrame(tick)
        else resolve()
      }
      requestAnimationFrame(tick)
    })
    po.disconnect()
    const sorted = frames.slice(5).sort((a, b) => a - b)
    const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0
    return { p95, frames: sorted.length, maxLongTask: Math.max(0, ...longTasks) }
  }, selector)
}

test('flinging the 3,593-photo contact sheet stays smooth', async ({ page }) => {
  await useJpegStandIns(page)
  await openApp(page, { scenario: 'aligned', speed: 'instant' })
  await page.keyboard.press(`${MOD}+2`)
  await expect(page.getByLabel('Photos in the library')).toBeVisible()
  const r = await flingAndMeasure(page, '.sheet-scroll')
  test.info().annotations.push({ type: 'perf', description: JSON.stringify(r) })
  expect(r.p95).toBeLessThanOrEqual(20)
  expect(r.maxLongTask).toBeLessThan(50)
})

test('flinging the year calendar stays smooth', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 700 })
  await useJpegStandIns(page)
  await openApp(page, { scenario: 'aligned', speed: 'instant' })
  await page.keyboard.press(`${MOD}+4`)
  await expect(page.locator('.year-grid')).toBeVisible()
  const r = await flingAndMeasure(page, '.days-canvas')
  test.info().annotations.push({ type: 'perf', description: JSON.stringify(r) })
  expect(r.p95).toBeLessThanOrEqual(20)
  expect(r.maxLongTask).toBeLessThan(50)
})

test('the player keeps 30 fps: decodes ahead and never stalls', async ({ page }) => {
  await useJpegStandIns(page)
  await openApp(page, { scenario: 'aligned', speed: 'instant' })
  await expect(page.getByRole('toolbar', { name: 'Playback' })).toBeVisible()
  // The aligned scenario cuts between days, so 30 days a second is 30 frames a second.
  await expect(page.getByRole('button', { name: /^Pace / })).toHaveText('30 days/s')
  // The plate's facts line: "Day 1 of 3,547" (critique rounds 4 and 6).
  const frameNo = page.locator('.cap-facts > :first-child')
  await expect(frameNo).toHaveText(/^Day 1 of /)

  const PLAY_MS = 3000
  await page.keyboard.press('Space')
  const frameTimes = await page.evaluate(async (ms) => {
    const times: number[] = []
    let last = performance.now()
    const end = last + ms
    await new Promise<void>((resolve) => {
      const tick = (t: number) => {
        times.push(t - last)
        last = t
        if (t < end) requestAnimationFrame(tick)
        else resolve()
      }
      requestAnimationFrame(tick)
    })
    return times.slice(5).sort((a, b) => a - b)
  }, PLAY_MS)
  await page.keyboard.press('Space')
  const shown = Number((await frameNo.textContent())?.match(/^Day ([\d,]+) of/)?.[1]?.replaceAll(',', '') ?? '0')
  const p95 = frameTimes[Math.floor(frameTimes.length * 0.95)] ?? 0
  test.info().annotations.push({ type: 'perf', description: JSON.stringify({ framesAdvanced: shown - 1, expected: (PLAY_MS / 1000) * 30, p95 }) })
  // 30 fps for 3 s is 90 frames; allow start-up latency, not stalls.
  expect(shown - 1).toBeGreaterThanOrEqual(80)
  expect(p95).toBeLessThanOrEqual(20)
})
