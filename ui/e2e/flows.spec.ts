import { expect, test } from '@playwright/test'
import { ledger, MOD, openApp, screenReady, title } from './helpers'

test.describe('happy path', () => {
  test('reference → scan → review → days → align → player → export video', async ({ page }) => {
    await openApp(page, { scenario: 'fresh', speed: 'fast' })
    await expect(title(page)).toHaveText('Reference')
    await expect(page.getByRole('heading', { name: 'Start with one photo of your face' })).toBeVisible()
    await expect(ledger(page, 'Scan')).toHaveAttribute('aria-disabled', 'true')

    await page.getByRole('button', { name: /Choose photo/ }).click()
    await expect(page.getByRole('group', { name: /^Crop/ })).toBeVisible()
    await page.getByRole('button', { name: /Choose folder/ }).click()
    await expect(page.getByText(/Still to read/)).toBeVisible()

    await page.getByRole('button', { name: /^Scan library/ }).click()
    await expect(title(page)).toHaveText('Scan')
    await expect(page.getByRole('heading', { name: /Read .* of .* photos/ })).toBeVisible()

    await expect(title(page)).toHaveText('Review', { timeout: 20_000 })
    await expect(page.getByRole('button', { name: 'Keep', exact: true })).toBeVisible()
    await page.keyboard.press('y')
    await page.keyboard.press('y')
    await page.keyboard.press('n')
    await page.keyboard.press('u')
    await expect(page.getByText(/^Undone\.$/)).toBeAttached()
    await page.keyboard.press('Shift+A')
    await expect(page.getByRole('heading', { name: /All .* looked at/ })).toBeVisible()
    // The done state waits for Continue (QA batch 3: no auto-advance).
    await page.keyboard.press('ControlOrMeta+Enter')

    await expect(title(page)).toHaveText('Days', { timeout: 5000 })
    await expect(page.getByRole('heading', { level: 2 }).first()).toBeVisible()
    await page.getByRole('button', { name: /^Align .* days/ }).click()

    await expect(title(page)).toHaveText('Timelapse')
    await expect(page.getByRole('toolbar', { name: 'Playback' })).toBeVisible({ timeout: 20_000 })
    await expect(page.getByRole('button', { name: 'Play' })).toBeEnabled({ timeout: 20_000 })
    await page.keyboard.press('Space')
    await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible()
    await page.keyboard.press('Space')

    await page.keyboard.press('e')
    const sheet = page.getByRole('dialog', { name: 'Export timelapse' })
    await expect(sheet).toBeVisible()
    await sheet.getByRole('button', { name: /^Export…/ }).click()
    await expect(sheet.getByRole('heading', { name: 'Saved' })).toBeVisible({ timeout: 20_000 })
    await sheet.getByRole('button', { name: 'Done' }).click()
    await expect(sheet).toBeHidden()
  })

  test('restored session opens on the timelapse', async ({ page }) => {
    await openApp(page, { scenario: 'aligned' })
    await expect(title(page)).toHaveText('Timelapse')
    await expect(ledger(page, 'Timelapse')).toHaveAttribute('aria-current', 'page')
    await page.keyboard.press(`${MOD}+4`)
    await expect(title(page)).toHaveText('Days')
    await page.keyboard.press(`${MOD}+2`)
    await expect(title(page)).toHaveText('Scan')
    await expect(page.getByRole('heading', { name: /Found you in/ })).toBeVisible()
  })
})

test.describe('cancel paths', () => {
  test('stopping a scan keeps partial work and returns to the reference', async ({ page }) => {
    await openApp(page, { scenario: 'ready', speed: 'normal' })
    await page.getByRole('button', { name: /^Scan library/ }).click()
    await expect(title(page)).toHaveText('Scan')
    await page.getByRole('button', { name: /^Stop/ }).click()
    await page.getByRole('dialog', { name: 'Stop scanning?' }).getByRole('button', { name: 'Stop' }).click()
    await expect(title(page)).toHaveText('Reference', { timeout: 10_000 })
    await expect(ledger(page, 'Scan')).toContainText('resume')
  })

  test('⌘. stops aligning and returns to Days with a toast', async ({ page }) => {
    await openApp(page, { scenario: 'reviewed', speed: 'normal' })
    await expect(title(page)).toHaveText('Days')
    await page.getByRole('button', { name: /^Align .* days/ }).click()
    await expect(title(page)).toHaveText('Timelapse')
    await page.keyboard.press(`${MOD}+.`)
    await expect(title(page)).toHaveText('Days', { timeout: 10_000 })
    await expect(page.getByRole('status').getByText(/Align again to continue/)).toBeVisible()
  })

  test('stopping an export leaves the sheet ready to try again', async ({ page }) => {
    await openApp(page, { scenario: 'aligned', speed: 'normal' })
    await page.keyboard.press('e')
    const sheet = page.getByRole('dialog', { name: 'Export timelapse' })
    await sheet.getByRole('button', { name: /^Export…/ }).click()
    await expect(sheet.locator('.enc-num')).toContainText(/^Encoding/)
    await sheet.getByRole('button', { name: /^Stop/ }).click()
    await expect(sheet.getByText(/Export stopped/)).toBeVisible({ timeout: 10_000 })
  })
})

test.describe('error paths', () => {
  test('a refused scan explains why (permission denied)', async ({ page }) => {
    await openApp(page, { scenario: 'ready', fail: 'start_scan:permissionDenied' })
    await page.getByRole('button', { name: /^Scan library/ }).click()
    await expect(page.getByRole('status').getByText(/isn’t allowed to read that folder|isn't allowed/)).toBeVisible()
    await expect(title(page)).toHaveText('Reference')
  })

  test('busy: dropping a folder while a scan runs is refused', async ({ page }) => {
    await openApp(page, { scenario: 'ready', speed: 'normal' })
    await page.getByRole('button', { name: /^Scan library/ }).click()
    await expect(title(page)).toHaveText('Scan')
    await page.evaluate(() => (window as unknown as { __FT_MOCK__: { emitDragDrop: (p: string[]) => void } }).__FT_MOCK__.emitDragDrop(['/Users/demo/Pictures/Other']))
    await expect(page.getByRole('status').getByText(/Another task is running/)).toBeVisible()
  })

  test('no face in the crop is an inline state and blocks the scan', async ({ page }) => {
    await openApp(page, { scenario: 'ready', fail: 'start_scan:noFaceInReference' })
    const crop = page.getByRole('group', { name: /^Crop/ })
    await crop.focus()
    for (let i = 0; i < 30; i++) await page.keyboard.press('Shift+ArrowRight')
    await page.waitForTimeout(400)
    const plate = page.getByRole('button', { name: /^Scan library/ })
    if (await plate.isDisabled()) {
      await expect(page.getByText(/No face found inside the crop/)).toBeVisible()
    } else {
      await plate.click()
      await expect(page.getByRole('status').getByText(/No face/)).toBeVisible()
    }
  })

  test('a failed video export shows the reason in the sheet', async ({ page }) => {
    await openApp(page, { scenario: 'aligned', fail: 'start_export_video:diskFull' })
    await page.keyboard.press('e')
    const sheet = page.getByRole('dialog', { name: 'Export timelapse' })
    await sheet.getByRole('button', { name: /^Export…/ }).click()
    await expect(page.getByText(/disk is full/i).first()).toBeVisible()
  })
})

test.describe('drag and drop', () => {
  test('dropping a photo shows the overlay and sets the reference', async ({ page }) => {
    await openApp(page, { scenario: 'fresh' })
    await page.evaluate(() => (window as unknown as { __FT_MOCK__: { emitDragEnter: (p: string[]) => void } }).__FT_MOCK__.emitDragEnter(['/Users/demo/Pictures/Reference/IMG_20140815_142326.jpg']))
    await expect(page.getByText('Release to use as reference')).toBeVisible()
    await page.evaluate(() => (window as unknown as { __FT_MOCK__: { emitDragDrop: (p: string[]) => void } }).__FT_MOCK__.emitDragDrop(['/Users/demo/Pictures/Reference/IMG_20140815_142326.jpg']))
    await expect(page.getByRole('group', { name: /^Crop/ })).toBeVisible()
  })
})

test.describe('days drag (QA HIGH)', () => {
  test('dragging an alternate drops it on the day under the pointer', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await openApp(page, { scenario: 'aligned', speed: 'instant' })
    await page.keyboard.press(`${MOD}+4`)
    await expect(title(page)).toHaveText('Days')
    await screenReady(page)
    // Days lands on the player's day (critique round 5, P1-2); step to 2014.
    const landed = Number(await page.locator('.year-num').first().textContent())
    for (let i = 0; i < Math.abs(landed - 2014); i++) await page.keyboard.press(landed > 2014 ? 'BracketLeft' : 'BracketRight')
    await expect(page.locator('[data-day="2014-05-02"]')).toBeVisible()
    await page.locator('[data-day="2014-05-02"]').click()
    const alt = page.getByRole('radiogroup', { name: /Photos on 2 May 2014/ }).getByRole('radio').nth(1)
    const target = page.locator('[data-day="2014-05-13"]')
    await target.scrollIntoViewIfNeeded()
    const a = await alt.boundingBox()
    const t = await target.boundingBox()
    if (!a || !t) throw new Error('missing boxes')
    // Grab the row near its left edge, as QA did with the grip.
    await page.mouse.move(a.x + 16, a.y + a.height / 2)
    await page.mouse.down()
    await page.mouse.move(a.x + 30, a.y + a.height / 2, { steps: 4 })
    await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2, { steps: 16 })
    await expect(target).toHaveAttribute('data-over', 'true')
    await page.mouse.up()
    await expect(page.getByText(/^Moved to 13 May 2014/)).toBeVisible()
  })
})
