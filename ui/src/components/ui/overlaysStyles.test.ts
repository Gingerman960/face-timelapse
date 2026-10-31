// Overlay styles the tests can't see in jsdom (CSS imports are empty there): read from disk.
/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(join(process.cwd(), 'src', 'components', 'ui', 'overlays.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

describe('overlay styles', () => {
  // Critique round 4, item 21: the toast's Undo was an 18 px text link.
  it('the toast action is a 24 px pill with hover and pressed states', () => {
    const at = css.indexOf('.toast-action {')
    const body = css.slice(at, css.indexOf('}', at))
    expect(body).toMatch(/height: var\(--control-h-sm\)/)
    expect(body).toMatch(/border-radius: var\(--r-pill\)/)
    expect(css).toMatch(/\.toast-action:hover \{/)
    expect(css).toMatch(/\.toast-action:active \{/)
  })
})
