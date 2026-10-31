// Critique round 4, P1-7: `prefers-contrast` and `prefers-reduced-transparency`
// sat on a bare :root and lost to the themed rules, so they worked only in
// System theme with macOS in dark. They must hold in all four modes: Light or
// Dark pinned in the app, or either one through System.
import { expect, test, type Page } from '@playwright/test'
import { openApp } from './helpers'

type Mode = { label: string; theme?: 'light' | 'dark'; scheme: 'light' | 'dark' }

const MODES: Mode[] = [
  { label: 'Light pinned', theme: 'light', scheme: 'dark' },
  { label: 'Dark pinned', theme: 'dark', scheme: 'light' },
  { label: 'System light', scheme: 'light' },
  { label: 'System dark', scheme: 'dark' },
]

/** A token's resolved colour, as the page computes it. */
async function token(page: Page, name: string): Promise<string> {
  return page.evaluate((n) => {
    const probe = document.createElement('i')
    probe.style.color = `var(${n})`
    document.body.append(probe)
    const value = getComputedStyle(probe).color
    probe.remove()
    return value
  }, name)
}

async function reduceTransparency(page: Page, on: boolean): Promise<void> {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: on ? 'reduce' : 'no-preference' }] })
}

for (const mode of MODES) {
  test(`increased contrast and reduced transparency hold: ${mode.label}`, async ({ page }) => {
    // Arrange: the theme as the mode sets it, no preferences yet.
    await page.emulateMedia({ colorScheme: mode.scheme, contrast: 'no-preference' })
    await openApp(page, { scenario: 'aligned', theme: mode.theme })
    const line = await token(page, '--line')
    const lineStrong = await token(page, '--line-strong')
    const chrome = await token(page, '--chrome')
    expect(await token(page, '--glass')).not.toBe(chrome)

    // Act + Assert: more contrast steps the hairlines up.
    await page.emulateMedia({ colorScheme: mode.scheme, contrast: 'more' })
    expect(await token(page, '--line')).not.toBe(line)
    expect(await token(page, '--line-strong')).not.toBe(lineStrong)

    // Act + Assert: reduced transparency makes glass the opaque chrome of this theme.
    await reduceTransparency(page, true)
    expect(await token(page, '--glass')).toBe(chrome)
  })
}
