import { expect, type Page } from '@playwright/test'

export type Scenario = 'fresh' | 'ready' | 'scanned' | 'reviewed' | 'aligned'

export interface OpenOptions {
  scenario?: Scenario
  speed?: 'instant' | 'fast' | 'normal'
  fail?: string
  theme?: 'light' | 'dark'
  /** Pre-seeds the last step the app restores to. */
  lastStep?: string
  /** The face models couldn't be loaded (the mock's `models=missing`). */
  models?: 'missing'
}

/** Opens the app against the in-memory fake backend and waits for the first screen. */
export async function openApp(page: Page, opts: OpenOptions = {}): Promise<void> {
  const params = new URLSearchParams({ mock: opts.scenario ?? 'aligned', speed: opts.speed ?? 'fast' })
  if (opts.fail) params.set('fail', opts.fail)
  if (opts.models) params.set('models', opts.models)
  await page.addInitScript(
    ({ theme, lastStep }) => {
      try {
        window.localStorage.clear()
        if (theme) window.localStorage.setItem('ft.theme', theme)
        if (lastStep) window.localStorage.setItem('ft.lastStep', lastStep)
      } catch {
        /* storage unavailable */
      }
    },
    { theme: opts.theme ?? null, lastStep: opts.lastStep ?? null },
  )
  await page.goto(`/?${params.toString()}`)
  await expect(page.getByRole('navigation', { name: 'Project' })).toBeVisible()
  await expect(page.locator('.toolbar h1:visible').first()).toBeVisible()
  await screenReady(page)
}

/** Waits until the current screen's lazy code and data have loaded (its keys are live). */
export async function screenReady(page: Page): Promise<void> {
  await expect(page.locator('.screen').first()).toBeVisible()
  await expect(page.locator('.screen[aria-busy="true"]')).toHaveCount(0)
}

/** The ledger row button for a stage. */
export function ledger(page: Page, label: string) {
  return page.getByRole('navigation', { name: 'Project' }).getByRole('button', { name: new RegExp(`^${label}\\b`) })
}

/**
 * The current screen title in the toolbar. While a lazy screen loads, React
 * keeps the previous screen in the DOM (hidden), so match the visible one.
 */
export function title(page: Page) {
  return page.locator('.toolbar h1:visible')
}

/**
 * Waits until every visible image has loaded (stable screenshots). Lazy images
 * clipped away by the window or a scrolling ancestor never start loading, so
 * only images with a visible area are awaited.
 */
export async function settleImages(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      Array.from(document.images).every((img) => {
        if (img.complete) return true
        let r = img.getBoundingClientRect()
        let left = Math.max(r.left, 0)
        let top = Math.max(r.top, 0)
        let right = Math.min(r.right, innerWidth)
        let bottom = Math.min(r.bottom, innerHeight)
        for (let el = img.parentElement; el && right > left && bottom > top; el = el.parentElement) {
          const cs = getComputedStyle(el)
          if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue
          r = el.getBoundingClientRect()
          left = Math.max(left, r.left)
          top = Math.max(top, r.top)
          right = Math.min(right, r.right)
          bottom = Math.min(bottom, r.bottom)
        }
        return !(right - left > 1 && bottom - top > 1)
      }),
    undefined,
    { timeout: 15_000 },
  )
  await page.evaluate(() => document.fonts.ready)
}

/** Modifier key for shortcuts (the app uses ⌘ on macOS, Ctrl elsewhere). */
export const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

/**
 * Waits until every finite animation on the page has finished (entrances such
 * as the export sheet's arrival); endless ones (latent film breathing) are
 * left running. Contrast checks measured a sheet still fading in.
 */
export async function settleAnimations(page: Page): Promise<void> {
  await page.waitForFunction(() =>
    document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().iterations === Infinity),
  )
}
