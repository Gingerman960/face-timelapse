// The export sheet's styles that carry behaviour the tests can't see in jsdom (CSS imports are
// empty there): read from disk, like the type-scale guard. Critique round 4, items 21 and 25, P1-3.
/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(join(process.cwd(), 'src', 'features', 'export', 'export.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(selector: string): string {
  const at = css.indexOf(`${selector} {`)
  expect(at, `no rule for ${selector}`).toBeGreaterThanOrEqual(0)
  return css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at))
}

describe('export sheet styles', () => {
  it('caption positions are 24 px targets holding 8 px dots (item 21)', () => {
    expect(rule('.pos-grid button')).toMatch(/width: var\(--hit-min\); height: var\(--hit-min\)/)
    expect(rule('.pos-grid button::before')).toMatch(/width: 8px; height: 8px/)
  })

  it('strikes through a blend the pace cannot take, like a size above the frames (item 25)', () => {
    expect(rule(':is(.size-seg, .blend-seg) button:disabled')).toMatch(/text-decoration: line-through/)
  })

  it('wraps help copy prettily (item 25)', () => {
    expect(rule('.field-help')).toMatch(/text-wrap: pretty/)
  })

  it('the shade carries the shadow, so the sheet can be clipped as it morphs (P1-3)', () => {
    expect(rule('.sheet-shade')).toMatch(/box-shadow: var\(--shadow-sheet\)/)
    expect(rule('.sheet')).not.toMatch(/box-shadow/)
    expect(rule('.sheet[data-morph]')).toMatch(/overflow: hidden/)
  })

  // Critique round 5 (light material, P2-16): the encoding frame sat on --sunken, a pale well in
  // light; prints are film in both themes.
  it('prints rest on latent film (the rebate lifted 12 % toward Z10), never on a well', () => {
    expect(rule('.sheet')).toMatch(/--latent: color-mix\(in oklch, var\(--rebate\), var\(--z10\) 12%\)/)
    expect(rule('.export-print')).toMatch(/background: var\(--latent\)/)
    expect(css).not.toMatch(/(export-print|enc-frame|enc-print|diptych)[^{]*\{[^}]*var\(--sunken\)/)
  })

  it('the encoding print cross-fades each step over --dur-xfade; only its first develops', () => {
    expect(rule('.enc-print img[data-shown]')).toMatch(/animation: ft-print-surface var\(--dur-xfade\)/)
    expect(rule('.enc-print img[data-shown][data-develop]')).toMatch(/animation-duration: var\(--dur-develop\)/)
  })

  // Critique round 5, P2-11: a photobook spread, the tick crossing the gutter, the facts after it.
  it('the pen’s valley sits in the spread’s gutter, and the facts wait for it', () => {
    expect(rule('svg.mark.dip-tick')).toMatch(/left: calc\(3px \+ var\(--print-w\) \+ var\(--dip-gutter\) \/ 2 - var\(--tick-w\) \* 0\.38\)/)
    expect(rule('.diptych .export-print')).toMatch(/height: var\(--print-h\)/)
    expect(rule('.saved-copy:not([data-told])')).toMatch(/opacity: 0/)
  })

  it('animates only compositor-friendly properties', () => {
    const animated = [...css.matchAll(/@keyframes [\w-]+ \{([\s\S]*?)\}\s*\}/g)].flatMap((m) => [...(m[1] ?? '').matchAll(/([a-z-]+)\s*:/g)].map((p) => p[1]))
    expect(animated.length).toBeGreaterThan(0)
    expect(animated.filter((p) => !['opacity', 'transform', 'clip-path', 'filter'].includes(p ?? ''))).toEqual([])
  })
})
