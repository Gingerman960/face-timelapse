// Player styles the tests can't see in jsdom (CSS imports are empty there): read from disk.
/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(join(process.cwd(), 'src', 'features', 'timelapse', 'timelapse.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(selector: string): string {
  const at = css.indexOf(`${selector} {`)
  expect(at, `no rule for ${selector}`).toBeGreaterThanOrEqual(0)
  return css.slice(at, css.indexOf('}', at))
}

describe('player styles', () => {
  // Critique round 5, P1-2: the name followed the role, so the wrong prints paired.
  it('names no print by its role: the frame travels by its day (data-vt-print, base.css)', () => {
    expect(css).not.toMatch(/\.player-frame\s*\{[^}]*view-transition-name/)
    expect(css).not.toMatch(/ft-print/)
  })

  // Critique round 5, P1-8: in light, lights-out left the table lit.
  it('switches the light table off with a fixed scrim, by opacity, in the light theme only', () => {
    const scrim = rule('.lights-scrim')
    expect(scrim).toMatch(/position: fixed/)
    expect(scrim).toMatch(/inset: 0/)
    expect(scrim).toMatch(/pointer-events: none/)
    expect(scrim).toMatch(/background: var\(--z1\)/)
    // Level with the lit layers, and first in the player, so they paint over it.
    expect(scrim).toMatch(/z-index: var\(--lit-z\)/)
    expect(scrim).toMatch(/opacity: 0;/)
    expect(scrim).toMatch(/transition: opacity var\(--dur-base\)/)
    expect(rule(':root[data-lights="out"] .lights-scrim')).toMatch(/opacity: var\(--table-off\);\s*transition: opacity var\(--dur-slow\)/)
    expect(css).toMatch(/:root, :root\[data-theme="dark"\] \{[^}]*--table-off: 0;/)
    expect(css).toMatch(/:root\[data-theme="light"\] \{[^}]*--table-off: 0\.92;/)
    expect(css).toMatch(/@media \(prefers-color-scheme: light\) \{\s*:root:not\(\[data-theme="dark"\]\) \{[^}]*--table-off: 0\.92;/)
  })

  it('keeps the frame, the hero date and the ribbon playhead lit above the scrim, in light ink', () => {
    // The full-window viewer's frame keeps its own place above the viewer.
    expect(css).toMatch(/:root\[data-lights\] :is\(\.player \.frame:not\(\.viewer-frame\), \.cap-col, \.ribbon-cursor\) \{ z-index: var\(--lit-z\); \}/)
    expect(css).toMatch(/:root\[data-lights="out"\] \.cap-date \{ color: var\(--lit-ink\);/)
    expect(css).toMatch(/:root\[data-lights="out"\] \.ribbon-cursor \{ --cursor: var\(--lit-ink\);/)
  })

  it('a region holding keyboard focus never dims: a solid one rises above the scrim, and one on the table keeps the table lit', () => {
    expect(css).toMatch(/:root\[data-lights="out"\] :is\([^)]*\.sidebar[^)]*\.player > \.transport[^)]*\.ribbon[^)]*\):has\(:focus-visible\) \{ z-index: calc\(var\(--lit-z\) \+ 1\); \}/)
    expect(css).toMatch(/:root\[data-lights="out"\]:has\(:is\(\.toolbar, \.cap-col\) :focus-visible\) \.lights-scrim \{ opacity: 0; \}/)
  })

  it('the viewer takes focus without a ring around the window, and its backdrop goes dark with the table', () => {
    expect(rule('.viewer:focus-visible')).toMatch(/outline: none/)
    expect(rule(':root[data-lights="out"] .viewer::before')).toMatch(/opacity: var\(--table-off\)/)
    expect(css).not.toMatch(/\.viewer-bar/)
  })

  // Critique round 5, P2-17: the ribbon's hairline and the pointer stayed lit.
  it('dims the ribbon’s top hairline and hides a still pointer', () => {
    expect(rule(':root[data-lights] .tl::after')).toMatch(/top: 100%/)
    expect(rule(':root[data-lights="out"] .tl::after')).toMatch(/opacity: 0\.92/)
    expect(css).toMatch(/:root\[data-pointer="hidden"\], :root\[data-pointer="hidden"\] \* \{ cursor: none; \}/)
  })

  // Critique round 5, P2-18: in light the strip was a black slab twice the frame's width.
  it('sets the strip on the table as a print', () => {
    expect(rule('.filmstrip')).toMatch(/box-shadow: var\(--shadow-print\)/)
  })

  it('animates nothing but opacity and transform here, and never sets will-change at rest', () => {
    const transitions = [...css.matchAll(/transition:\s*([^;}]+)/g)].map((m) => m[1] ?? '')
    const props = transitions.flatMap((t) => t.split(',').map((part) => part.trim().split(/\s+/)[0]))
    const allowed = new Set(['opacity', 'transform', 'translate', 'visibility', 'var(--fade)', 'var(--move)', 'background-color', 'color', 'none'])
    expect(props.filter((p) => !allowed.has(p ?? ''))).toEqual([])
    expect(css).not.toMatch(/will-change/)
  })
})

describe('lights-out and F, round 6', () => {
  // Critique round 6, P2-6: in light, the plate's pill outlines and the rule under the date
  // stayed faintly visible over the scrim (they sit above it at 8 %), and two playhead marks stayed lit.
  it('in light, the plate parts above the scrim go fully dark; in dark they keep the room’s 8 %', () => {
    expect(css).toMatch(/:root, :root\[data-theme="dark"\] \{ --table-off: 0; --above-dim: 0\.08; \}/)
    expect(css).toMatch(/:root\[data-theme="light"\] \{ --table-off: 0\.92; --above-dim: 0; \}/)
    expect(css).toMatch(/:root:not\(\[data-theme="dark"\]\) \{ --table-off: 0\.92; --above-dim: 0; \}/)
    expect(rule(':root[data-lights="out"] :is(.plate-caption > :not(.cap-date, .cap-year), .cap-col > .align-failures):not(:has(:focus-visible))')).toMatch(/opacity: var\(--above-dim\)/)
  })

  it('keeps one playhead mark on the ribbon: the decade track’s gives way to the focus track’s', () => {
    expect(rule(':root[data-lights="out"] .ribbon:not(:has(:focus-visible)):has(.ribbon-focus .ribbon-cursor) .ribbon-decade .ribbon-cursor')).toMatch(/opacity: 0/)
  })

  // Critique round 6, P2-8: the burned-in date was weight 300 with a 2 px glow, lost on a bright frame.
  it('the burned-in date sits on an on-photo scrim at a readable weight', () => {
    expect(rule('.frame-plate')).toMatch(/font-weight: var\(--weight-regular\)/)
    expect(rule('.viewer-frame::after')).toMatch(/background: var\(--on-photo-scrim\)/)
    const tokens = readFileSync(join(process.cwd(), 'src', 'styles', 'tokens.css'), 'utf8')
    expect(tokens).toMatch(/--on-photo-scrim: linear-gradient\(/)
  })
})
