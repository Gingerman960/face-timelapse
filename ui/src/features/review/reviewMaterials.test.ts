// Guards for review.css (read from disk: Vitest hands CSS imports over empty;
// tests run from `ui/`). Critique round 4: P2-13 (in light, Leave out and
// Compare were the same white pill), P2-14 (a strip is as long as its film),
// P1-4 (prints hold, then cross-fade) and the motion budget (transform and
// opacity only, will-change only on what is moving).
/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(join(process.cwd(), 'src', 'features', 'review', 'review.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp(`(?:^|[}\\s])${escaped}\\s*\\{([^}]*)\\}`))
  if (!match) throw new Error(`no rule for ${selector}`)
  return match[1] ?? ''
}

describe('decision buttons in both themes', () => {
  it('Leave out takes the app’s quiet material (raised in dark; Z9 with a hairline ring in light)', () => {
    const reject = rule('.btn-decide.reject')
    expect(reject).toMatch(/background:\s*var\(--quiet-fill\)/)
    expect(reject).toMatch(/box-shadow:\s*inset 0 0 0 var\(--hair\) var\(--quiet-ring\)/)
  })

  it('Compare stays a bare hairline, and Keep the plate', () => {
    const compare = rule('.btn-decide.compare')
    expect(compare).toMatch(/background:\s*transparent/)
    expect(compare).toMatch(/box-shadow:\s*inset 0 0 0 var\(--hair\) var\(--line-strong\)/)
    expect(rule('.btn-decide.keep')).toMatch(/background:\s*var\(--plate\)/)
  })
})

describe('the film', () => {
  it('is as long as its frames and cut square; only an overflowing film fades', () => {
    const strip = rule('.q-strip')
    expect(strip).toMatch(/width:\s*var\(--film-w\)/)
    expect(strip).toMatch(/max-width:\s*100%/)
    expect(strip).toMatch(/border-radius:\s*0/)
    expect(strip).not.toMatch(/mask-image/)
    expect(rule('.q-strip[data-overflow]')).toMatch(/mask-image/)
  })

  it('centres a short film under the stage', () => {
    expect(rule('.queue')).toMatch(/justify-content:\s*center/)
    expect(rule('.queue')).toMatch(/clamp\(0px, calc\(100% - var\(--film-w/)
  })
})

describe('motion', () => {
  it('prints cross-fade over --dur-xfade, rise over --dur-base, and a held print dims only after a grace', () => {
    expect(rule('.print.xfade')).toMatch(/animation:\s*ft-fade var\(--dur-xfade\)/)
    expect(rule('.print.rise')).toMatch(/animation:\s*ft-fade var\(--dur-base\)/)
    expect(rule('.print.held')).toMatch(/transition:\s*opacity var\(--dur-base\) var\(--ease-standard\) var\(--hold-grace\)/)
  })

  it('animates and transitions only compositor-friendly properties', () => {
    const transitions = [...css.matchAll(/transition:\s*([^;]+);/g)].map((m) => m[1] ?? '')
    const props = transitions.flatMap((t) => t.split(',').map((part) => part.trim().split(/\s+/)[0]))
    expect(props.filter((p) => !['opacity', 'transform', 'background-color', 'color', 'box-shadow'].includes(p ?? ''))).toEqual([])
    expect(css).not.toMatch(/@keyframes/)
  })

  it('promotes only the verdict, which exists only while it flies', () => {
    const promoted = [...css.matchAll(/([^{}]+)\{[^}]*will-change:\s*([^;]+);/g)].map((m) => [(m[1] ?? '').trim(), (m[2] ?? '').trim()])
    expect(promoted).toEqual([['.verdict', 'transform, opacity']])
  })

  it('blurs only the bounded fill behind the print', () => {
    const blurs = [...css.matchAll(/([^{}]+)\{[^}]*filter:\s*[^;]*blur\(/g)].map((m) => (m[1] ?? '').trim())
    expect(blurs).toEqual(['.print-fill'])
    expect(rule('.print-fill')).toMatch(/overflow:\s*hidden/)
  })
})
