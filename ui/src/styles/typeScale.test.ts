// The type scale is the only source of font sizes (QA critique round 3: about
// 90 hardcoded sizes had drifted off the scale, two of them below the 11 px
// floor). Every `font-size` in the app's CSS is a token, a calc on tokens, or
// `inherit`; the tokens themselves live in tokens.css and keep the floors.
/// <reference types="node" />
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/** `ui/src` (read from disk: Vitest hands CSS imports over empty; tests run from `ui/`). */
const SRC = join(process.cwd(), 'src')

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return cssFiles(path)
    return name.endsWith('.css') ? [path] : []
  })
}

/** Every `font-size` declaration, with where it is. */
function fontSizes(): Array<{ where: string; value: string }> {
  return cssFiles(SRC).flatMap((file) => {
    const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    return [...text.matchAll(/font-size\s*:\s*([^;}]+)/g)].map((m) => ({ where: relative(SRC, file), value: (m[1] ?? '').trim() }))
  })
}

/** Each CSS rule that sets a tracking or a leading: its size token (null when it inherits one) and the values. */
function cssRules(): Array<{ where: string; size: string | null; tracking: string | null; leading: string | null }> {
  return cssFiles(SRC).flatMap((file) => {
    const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    return [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap((m) => {
      const body = m[2] ?? ''
      const tracking = /letter-spacing\s*:\s*([^;}]+)/.exec(body)?.[1]?.trim() ?? null
      const leading = /line-height\s*:\s*([^;}]+)/.exec(body)?.[1]?.trim() ?? null
      if (tracking === null && leading === null) return []
      const size = /font-size\s*:\s*var\(--text-([a-z]+)\)/.exec(body)?.[1] ?? null
      return [{ where: `${relative(SRC, file)} ${(m[1] ?? '').trim().split('\n').pop() ?? ''}`, size, tracking, leading }]
    })
  })
}

/** The scale's tokens and their sizes, from tokens.css. */
function scale(): Map<string, number> {
  const tokens = readFileSync(join(SRC, 'styles', 'tokens.css'), 'utf8')
  return new Map([...tokens.matchAll(/(--text-[a-z-]+)\s*:\s*([\d.]+)px/g)].map((m) => [m[1] as string, Number(m[2])]))
}

/** A token, a calc on a token, `inherit`, or a calc on 1em (a run inside text matching its sentence, e.g. `.digits`). */
const ALLOWED = /^(var\(--text-[a-z-]+\)|calc\(var\(--text-[a-z-]+\)\s*\*\s*[\d.]+\)|calc\(1em\s*\*\s*0?\.\d+\)|inherit)$/

describe('the type scale', () => {
  it('is the only source of font sizes in the CSS', () => {
    expect(fontSizes().length).toBeGreaterThan(80)
    const off = fontSizes().filter(({ value }) => !ALLOWED.test(value))
    expect(off).toEqual([])
  })

  // Critique round 4: ten weights were in use, and 600, 620, 640 and 660 can't be told apart.
  it('uses only the four weight tokens (the font-face ranges aside)', () => {
    const weights = cssFiles(SRC).flatMap((file) => {
      const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/@font-face\s*\{[^}]*\}/g, '')
      return [...text.matchAll(/font-weight\s*:\s*([^;}]+)/g)].map((m) => ({ where: relative(SRC, file), value: (m[1] ?? '').trim() }))
    })
    expect(weights.length).toBeGreaterThan(40)
    expect(weights.filter(({ value }) => !/^var\(--weight-(regular|medium|strong|display)\)$/.test(value))).toEqual([])
  })

  // Critique round 5, P2-15: 22 px headings carried four trackings and three leadings.
  // Each size has its own tracking and leading; a rule that sets a size uses that size's
  // rhythm, or a shared one where it says why: caps labels, wrapped prose (13 px and
  // under), single-line stacks (title size and under), and solid numerals.
  it('gives each size one tracking and one leading, and every rule uses its size’s', () => {
    const rules = cssRules()
    const tracking = rules.flatMap((r) => (r.tracking ? [{ ...r, value: r.tracking }] : []))
    const leading = rules.flatMap((r) => (r.leading ? [{ ...r, value: r.leading }] : []))
    expect(tracking.length).toBeGreaterThan(15)
    expect(leading.length).toBeGreaterThan(25)
    // Only tokens (and 0, which resets mono runs).
    expect(tracking.filter(({ value }) => !/^(var\(--tracking-[a-z]+\)|0)$/.test(value))).toEqual([])
    expect(leading.filter(({ value }) => !/^var\(--leading-[a-z]+\)$/.test(value))).toEqual([])
    // Paired with the rule's own size.
    const small = new Set(['edge', 'label', 'small', 'ui'])
    const chrome = new Set([...small, 'title'])
    const offTracking = tracking.filter(({ size, value }) => {
      const t = /--tracking-([a-z]+)/.exec(value)?.[1]
      return size !== null && t !== undefined && t !== size && t !== 'caps'
    })
    const offLeading = leading.filter(({ size, value }) => {
      const l = /--leading-([a-z]+)/.exec(value)?.[1] ?? ''
      if (size === null || l === size || l === 'solid') return false
      if (l === 'prose') return !small.has(size)
      if (l === 'tight') return !chrome.has(size)
      return true
    })
    expect(offTracking).toEqual([])
    expect(offLeading).toEqual([])
    // Every size on the scale has its rhythm.
    const tokens = readFileSync(join(SRC, 'styles', 'tokens.css'), 'utf8')
    for (const size of [...scale().keys()].map((t) => t.replace('--text-', ''))) {
      expect(tokens).toMatch(new RegExp(`--leading-${size}\\s*:`))
      if (size !== 'label' && size !== 'small') expect(tokens).toMatch(new RegExp(`--tracking-${size}\\s*:`))
    }
  })

  it('keeps every functional size at 11 px or more (only decorative edge print is smaller)', () => {
    const below = [...scale()].filter(([token, px]) => px < 11 && token !== '--text-edge')
    expect(scale().size).toBeGreaterThan(8)
    expect(below).toEqual([])
    expect(scale().get('--text-small')).toBeGreaterThanOrEqual(12)
  })
})
