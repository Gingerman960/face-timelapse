// Critique round 6, P1-3: the Keys card could not be found (nothing outside it
// mentioned "?"), and over the F viewer it sat under the lifted frame.
/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fireEvent, screen, within } from '@testing-library/react'
import { renderApp } from '../../test/renderApp'
import { useKeyMap } from './keyMapStore'

afterEach(() => {
  useKeyMap.getState().setOpen(false)
  delete window.__FT_MOCK__
})

/** The z-index of the first rule for `selector` in `file` (comments stripped). */
function zIndexOf(file: string[], selector: string): number {
  const css = readFileSync(join(process.cwd(), 'src', ...file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const at = css.indexOf(`${selector} {`)
  expect(at, `no rule for ${selector}`).toBeGreaterThanOrEqual(0)
  const z = /z-index:\s*(\d+)/.exec(css.slice(at, css.indexOf('}', at)))
  return Number(z?.[1] ?? Number.NaN)
}

describe('finding the Keys card', () => {
  it('the sidebar footer offers "? Keys" beside the local note, and it opens the card', async () => {
    await renderApp({ scenario: 'scanned' })
    const foot = screen.getByRole('navigation', { name: 'Project' }).querySelector('.sidebar-foot') as HTMLElement
    const hint = within(foot).getByRole('button', { name: 'Keys' })
    expect(hint).toHaveAttribute('title', 'Keys for this screen (?)')
    expect(hint.querySelector('kbd')).toHaveTextContent('?')

    fireEvent.click(hint)

    expect(await screen.findByRole('dialog', { name: /^Keys/ })).toBeInTheDocument()
  })

  it('the card stacks over the full-window viewer and its lifted frame', () => {
    const card = zIndexOf(['features', 'shell', 'keymap.css'], '.keymap-layer')
    expect(card).toBeGreaterThan(zIndexOf(['features', 'timelapse', 'timelapse.css'], '.viewer'))
    expect(card).toBeGreaterThan(zIndexOf(['features', 'timelapse', 'timelapse.css'], '.frame.viewer-frame'))
  })
})
