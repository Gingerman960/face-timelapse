import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { MOD, openApp, settleAnimations, settleImages, title } from './helpers'

const SIZES = [
  { w: 1024, h: 768 },
  { w: 1440, h: 900 },
  { w: 1920, h: 1080 },
] as const
const THEMES = ['light', 'dark'] as const

interface Shot {
  name: string
  scenario: 'fresh' | 'ready' | 'scanned' | 'reviewed' | 'aligned'
  go: (page: Page) => Promise<void>
}

const SHOTS: Shot[] = [
  { name: 'setup-empty', scenario: 'fresh', go: async (p) => { await expect(title(p)).toHaveText('Reference') } },
  { name: 'setup', scenario: 'ready', go: async (p) => { await expect(p.getByRole('group', { name: /^Crop/ })).toBeVisible() } },
  { name: 'scan-library', scenario: 'aligned', go: async (p) => { await p.keyboard.press(`${MOD}+2`); await expect(p.getByRole('heading', { name: /Found you in/ })).toBeVisible() } },
  { name: 'review', scenario: 'scanned', go: async (p) => { await p.keyboard.press(`${MOD}+3`); await expect(p.getByRole('button', { name: 'Keep', exact: true })).toBeVisible() } },
  // Days lands on the player's day (critique round 5, P1-2): the last frame, so the shot keeps the latest year.
  { name: 'days', scenario: 'aligned', go: async (p) => { await expect(p.getByRole('toolbar', { name: 'Playback' })).toBeVisible(); await p.keyboard.press('End'); await p.keyboard.press(`${MOD}+4`); await expect(title(p)).toHaveText('Days') } },
  { name: 'timelapse-player', scenario: 'aligned', go: async (p) => { await expect(p.getByRole('toolbar', { name: 'Playback' })).toBeVisible() } },
  { name: 'timelapse-onion', scenario: 'aligned', go: async (p) => { await expect(p.getByRole('toolbar', { name: 'Playback' })).toBeVisible(); await p.keyboard.press('o') } },
  { name: 'timelapse-sheet', scenario: 'aligned', go: async (p) => { await p.getByRole('radio', { name: 'Sheet' }).click(); await expect(p.getByLabel('All aligned frames')).toBeVisible() } },
  { name: 'export', scenario: 'aligned', go: async (p) => { await p.keyboard.press('e'); await expect(p.getByRole('dialog', { name: 'Export timelapse' })).toBeVisible() } },
]

for (const theme of THEMES) {
  for (const size of SIZES) {
    test.describe(`${theme} ${size.w}×${size.h}`, () => {
      test.use({ viewport: { width: size.w, height: size.h }, colorScheme: theme })
      for (const shot of SHOTS) {
        test(shot.name, async ({ page }) => {
          await page.emulateMedia({ reducedMotion: 'reduce' })
          await openApp(page, { scenario: shot.scenario, speed: 'instant' })
          await shot.go(page)
          await settleImages(page)
          await page.waitForTimeout(250)
          await expect(page).toHaveScreenshot(`${shot.name}-${size.w}-${theme}.png`, { fullPage: false })
        })
      }
    })
  }
}

test.describe('accessibility', () => {
  test.use({ viewport: { width: 1440, height: 900 } })
  for (const shot of SHOTS) {
    test(`axe: ${shot.name}`, async ({ page }) => {
      await openApp(page, { scenario: shot.scenario, speed: 'instant' })
      await shot.go(page)
      await settleImages(page)
      await settleAnimations(page)
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
      const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
      expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`)).toEqual([])
    })
  }
})

/**
 * Running jobs (live scan mosaic, aligning filmstrip) advance with real time,
 * so they are captured as reference images rather than compared baselines.
 * Opt in with FT_SHOOT_STATES=1; files land in e2e/__screenshots__/states/.
 */
test.describe('job states', () => {
  test.skip(!process.env.FT_SHOOT_STATES, 'set FT_SHOOT_STATES=1 to capture running-job screenshots')
  const STATES = [
    { name: 'scan-live', scenario: 'ready' as const, go: async (p: Page) => { await p.getByRole('button', { name: /^Scan library/ }).click(); await expect(title(p)).toHaveText('Scan') } },
    { name: 'aligning', scenario: 'reviewed' as const, go: async (p: Page) => { await p.getByRole('button', { name: /^Align .* days/ }).click(); await expect(title(p)).toHaveText('Timelapse') } },
  ]
  for (const theme of THEMES) {
    for (const size of SIZES) {
      for (const st of STATES) {
        test(`${st.name} ${size.w} ${theme}`, async ({ page }) => {
          await page.setViewportSize({ width: size.w, height: size.h })
          await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
          await openApp(page, { scenario: st.scenario, speed: 'normal' })
          await st.go(page)
          await page.waitForTimeout(2500)
          await settleImages(page)
          await page.screenshot({ path: `e2e/__screenshots__/states/${st.name}-${size.w}-${theme}.png` })
        })
      }
    }
  }
})
