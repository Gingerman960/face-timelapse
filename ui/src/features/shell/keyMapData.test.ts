import { describe, expect, it } from 'vitest'
import { STEPS, type Step } from '../../lib/steps'
import {
  EVERYWHERE,
  INTENT_ORDER,
  SCREEN_KEYS,
  groupByIntent,
  isKeyMapKey,
  keyMapFor,
  spokenKey,
  spokenKeys,
  type KeyContext,
  type KeyRow,
  type KeySection,
} from './keyMapData'

const CONTEXTS: readonly KeyContext[] = [...STEPS, 'export']
const ALL_SECTIONS: readonly KeySection[] = [...CONTEXTS.map((c) => SCREEN_KEYS[c]), EVERYWHERE]

function caps(section: KeySection): string[] {
  return section.rows.flatMap((r) => r.keys)
}

describe('the keyboard map', () => {
  it('gives every screen its own keys, named as the sidebar names it', () => {
    // Arrange
    const names: Record<Step, string> = { setup: 'Reference', scan: 'Scan', review: 'Review', days: 'Days', align: 'Timelapse', timelapse: 'Timelapse' }

    // Act + Assert
    for (const step of STEPS) {
      expect(SCREEN_KEYS[step].title).toBe(names[step])
      expect(SCREEN_KEYS[step].rows.length).toBeGreaterThan(0)
    }
  })

  it('lists the current screen first, then Everywhere', () => {
    for (const step of STEPS) {
      // Act
      const sections = keyMapFor(step)

      // Assert
      expect(sections).toEqual([SCREEN_KEYS[step], EVERYWHERE])
    }
    expect(EVERYWHERE.title).toBe('Everywhere')
  })

  it('shows only the sheet’s own keys over the export sheet (nothing else reaches past it)', () => {
    // Act
    const sections = keyMapFor('export')

    // Assert
    expect(sections).toEqual([SCREEN_KEYS.export])
    expect(SCREEN_KEYS.export.title).toBe('Export')
    expect(caps(SCREEN_KEYS.export)).toEqual(expect.arrayContaining(['⌘↩', 'Esc', '⌘.']))
  })

  it('carries the keys round 5 found shown nowhere: F, J/K/L, D, A, [ ] and ⌘↑/⌘↓', () => {
    expect(caps(SCREEN_KEYS.timelapse)).toEqual(expect.arrayContaining(['F', 'J', 'K', 'L', 'D', 'A']))
    expect(caps(SCREEN_KEYS.days)).toEqual(expect.arrayContaining(['[', ']', '⌘↑', '⌘↓']))
  })

  it('carries DESIGN’s keyboard map for every screen', () => {
    // Arrange
    const expected: Record<KeyContext | 'everywhere', string[]> = {
      setup: ['←', '→', '↑', '↓', 'L', 'C', 'R'],
      scan: ['←', '→', '↑', '↓', 'Home', 'End', '↩', 'Space'],
      review: ['Y', '→', '↩', 'N', '←', '⌫', 'U', '⌘Z', 'Space', '⇧A'],
      days: ['←', '→', '↑', '↓', '1–9', 'X', 'M', '[', ']', '⌘↑', '⌘↓'],
      align: ['⌘.'],
      timelapse: ['Space', '←', '→', '⇧←', '⇧→', 'Home', 'End', 'J', 'K', 'L', 'O', 'D', 'A', 'N', 'F', 'E', '⌘E', '⌥←', '⌥→'],
      export: ['⌘↩', 'Esc', '⌘.'],
      everywhere: ['⌘O', '⇧⌘O', '⌘↩', 'Esc', '⌘.', '⌘1–⌘5', '⌃⌘S', '⌥⌘I', '?'],
    }

    // Act + Assert
    for (const context of CONTEXTS) expect(caps(SCREEN_KEYS[context]), context).toEqual(expect.arrayContaining(expected[context]))
    expect(caps(EVERYWHERE)).toEqual(expect.arrayContaining(expected.everywhere))
  })

  it('tells when a screen’s keys rest: the scan’s sheet after the scan, the player after aligning', () => {
    expect(SCREEN_KEYS.scan.note).toMatch(/once the scan has finished/)
    expect(SCREEN_KEYS.align.note).toMatch(/once the frames are aligned/)
  })

  it('writes every action in words: sentence case, no full stop, never empty', () => {
    const rows: KeyRow[] = ALL_SECTIONS.flatMap((s) => [...s.rows])
    for (const row of rows) {
      expect(row.keys.length, row.does).toBeGreaterThan(0)
      expect(row.does, row.keys.join(' ')).toMatch(/^[A-Z]/)
      expect(row.does).not.toMatch(/[.…]$/)
      for (const cap of row.keys) expect(cap.trim()).toBe(cap)
    }
  })

  it('never lists the same keys twice on one card section', () => {
    for (const section of ALL_SECTIONS) {
      const lines = section.rows.map((r) => r.keys.join(' '))
      expect(new Set(lines).size, section.title).toBe(lines.length)
    }
  })

  it('writes chords the macOS way, modifiers in ⌃ ⌥ ⇧ ⌘ order', () => {
    const order = ['⌃', '⌥', '⇧', '⌘']
    for (const cap of ALL_SECTIONS.flatMap(caps)) {
      const mods = [...cap].filter((ch) => order.includes(ch))
      const sorted = [...mods].sort((a, b) => order.indexOf(a) - order.indexOf(b))
      expect(mods, cap).toEqual(sorted)
    }
  })
})

describe('groupByIntent', () => {
  it('groups rows Move, Decide, Look, Make and leaves out empty groups', () => {
    // Arrange
    const rows: KeyRow[] = [
      { intent: 'make', keys: ['E'], does: 'Export the timelapse' },
      { intent: 'move', keys: ['←', '→'], does: 'Previous or next frame' },
      { intent: 'look', keys: ['F'], does: 'Full-window viewer' },
      { intent: 'move', keys: ['Home', 'End'], does: 'First or last frame' },
    ]

    // Act
    const groups = groupByIntent(rows)

    // Assert
    expect(INTENT_ORDER).toEqual(['move', 'decide', 'look', 'make'])
    expect(groups.map((g) => g.label)).toEqual(['Move', 'Look', 'Make'])
    expect(groups[0]?.rows.map((r) => r.does)).toEqual(['Previous or next frame', 'First or last frame'])
  })
})

describe('spoken keys', () => {
  it('names modifiers and symbols the way the keys are called on a Mac', () => {
    expect(spokenKey('⇧⌘O')).toBe('Shift Command O')
    expect(spokenKey('⌥⌘I')).toBe('Option Command I')
    expect(spokenKey('⌃⌘S')).toBe('Control Command S')
    expect(spokenKey('⌘1–⌘5')).toBe('Command 1 to Command 5')
    expect(spokenKey('1–9')).toBe('1 to 9')
    expect(spokenKey('←')).toBe('Left arrow')
    expect(spokenKey('⌘↓')).toBe('Command Down arrow')
    expect(spokenKey('↩')).toBe('Return')
    expect(spokenKey('⌫')).toBe('Delete')
    expect(spokenKey('Esc')).toBe('Escape')
    expect(spokenKey('[')).toBe('Left bracket')
    expect(spokenKey('?')).toBe('Question mark')
    expect(spokenKey('⌘.')).toBe('Command Period')
    expect(spokenKey('Space')).toBe('Space')
    expect(spokenKey('Home')).toBe('Home')
  })

  it('joins alternatives with “or”', () => {
    expect(spokenKeys(['F'])).toBe('F')
    expect(spokenKeys(['U', '⌘Z'])).toBe('U or Command Z')
    expect(spokenKeys(['Y', '→', '↩'])).toBe('Y, Right arrow or Return')
  })

  it('can say every cap on the card (no glyph is left unnamed)', () => {
    for (const cap of ALL_SECTIONS.flatMap(caps)) expect(spokenKey(cap), cap).toMatch(/^[A-Za-z0-9]+( [A-Za-z0-9]+)*$/)
  })
})

describe('isKeyMapKey', () => {
  it('is “?” as typed (with the Shift that types it), never with ⌘, ⌃ or ⌥', () => {
    const key = (k: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>> = {}) =>
      isKeyMapKey({ key: k, metaKey: false, ctrlKey: false, altKey: false, ...mods })

    expect(key('?', { shiftKey: true })).toBe(true)
    expect(key('/')).toBe(false)
    expect(key('?', { metaKey: true })).toBe(false)
    expect(key('?', { ctrlKey: true })).toBe(false)
    expect(key('?', { altKey: true })).toBe(false)
  })
})
