// Text that must fit whole (QA §11, 31 Oct retake): two labels were clipped in the README captures.
// jsdom has no text metrics, so these measure real layout in the browser.
import { expect, test, type Page } from '@playwright/test'
import { MOD, openApp, screenReady, title } from './helpers'

/** True when the element's content is wider than its box (clipped or ellipsized). */
async function overflowsX(page: Page, selector: string): Promise<boolean> {
  return page.locator(selector).first().evaluate((el) => el.scrollWidth > el.clientWidth + 0.5)
}

test.describe('labels fit whole', () => {
  test('a film of one prints its whole counter "▸ 01 / 01" on the rebate', async ({ page }) => {
    // Arrange: the Review queue's markup for a library with one unsure photo (the mock has 41),
    // with the sizes ReviewQueue gives it (filmWidth(1, true) = 74 px, 44 px cells, 56 px current).
    await page.setViewportSize({ width: 1440, height: 900 })
    await openApp(page, { scenario: 'scanned', speed: 'instant', theme: 'dark' })
    await page.evaluate(() => {
      document.body.insertAdjacentHTML(
        'beforeend',
        `<div class="queue" data-single id="fit-queue" style="position:fixed;left:0;bottom:0;width:800px">
           <div class="q-strip" style="--film-w:74px;--cell:44px">
             <div class="q-track" style="width:68px">
               <span class="q-item current" style="transform:translateX(0px)"><span class="edge" data-n="▸ 01 / 01"></span></span>
             </div>
           </div>
         </div>`,
      )
    })

    // Act
    const clipped = await overflowsX(page, '#fit-queue .edge')
    const strip = await overflowsX(page, '#fit-queue .q-strip')

    // Assert: the whole counter shows, and the film doesn't scroll to hold it.
    expect(clipped).toBe(false)
    expect(strip).toBe(false)
  })

  test('the after-midnight note shows its whole "Move to …" link in the Days inspector', async ({ page }) => {
    // Arrange: 2 May 2014 has a 00:41 alternate (mock calendar).
    await page.setViewportSize({ width: 1440, height: 900 })
    await openApp(page, { scenario: 'aligned', speed: 'instant', theme: 'dark' })
    await page.keyboard.press(`${MOD}+4`)
    await expect(title(page)).toHaveText('Days')
    await screenReady(page)
    const landed = Number(await page.locator('.year-num').first().textContent())
    for (let i = 0; i < Math.abs(landed - 2014); i++) await page.keyboard.press(landed > 2014 ? 'BracketLeft' : 'BracketRight')
    await page.locator('[data-day="2014-05-02"]').click()
    const move = page.getByRole('button', { name: 'Move to 1 May 2014' })
    await expect(move).toBeVisible()

    // Act
    const note = await overflowsX(page, '.alt-note')
    const fits = await move.evaluate((button) => {
      const b = button.getBoundingClientRect()
      const card = (button.closest('.alt-meta') as HTMLElement).getBoundingClientRect()
      return button.scrollWidth <= button.clientWidth + 0.5 && b.right <= card.right + 0.5
    })

    // Assert: nothing is cut to an ellipsis, and the link sits inside its card.
    expect(note).toBe(false)
    expect(fits).toBe(true)
  })
})
