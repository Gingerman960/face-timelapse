// Critique round 5, P1-6: the live sheet's newest-frame outline jumped onto
// black, unloaded slots, and about three rows mixed lit, ghosted and black
// frames, because images land out of order. The frontier develops frames in
// order along one leading edge and moves the outline only when a develop ends.
/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createFrontier,
  developEnded,
  failedAt,
  filmOf,
  HOLD_MS,
  initialFrontier,
  MAX_SWEEP_FRAMES,
  MAX_SWEEP_MS,
  landed,
  passBefore,
  readTo,
  tick,
  TRUE_DEVELOP_MS,
  wakeAt,
  type FrontierState,
} from './frontier'

/** Frames read 0..n-1 at time 0 (no pace yet). */
function readFrames(n: number, now = 0): FrontierState {
  return readTo(initialFrontier(), n, now)
}

const films = (s: FrontierState, n: number) => Array.from({ length: n }, (_, i) => filmOf(s, i).film)

describe('frontier: one leading edge', () => {
  it('develops frames in order: an early arrival stays latent until the frames before it land', () => {
    // Arrange
    let s = readFrames(4)

    // Act: frame 2 lands first.
    s = landed(s, 2, 10)

    // Assert: held latent, nothing outlined.
    expect(films(s, 4)).toEqual(['latent', 'latent', 'latent', 'latent'])
    expect(s.outline).toBe(-1)

    // Act: 0 and 1 land; the run 0–2 is complete.
    s = landed(s, 0, 20)
    s = landed(s, 1, 30)

    // Assert
    expect(films(s, 4)).toEqual(['fresh', 'fresh', 'fresh', 'latent'])
    expect(s.edge).toBe(3)
  })

  it('a batch released at once sweeps along the edge: each develop starts after the one before', () => {
    // Arrange
    let s = readFrames(5)
    s = landed(s, 3, 0)
    s = landed(s, 2, 0)
    s = landed(s, 1, 0)

    // Act
    s = landed(s, 0, 5)

    // Assert
    const delays = [0, 1, 2, 3].map((i) => filmOf(s, i).delay)
    expect(delays[0]).toBe(0)
    for (let i = 1; i < delays.length; i++) expect(delays[i]).toBeGreaterThan(delays[i - 1] ?? 0)
    expect(Math.max(...delays)).toBeLessThanOrEqual(HOLD_MS)
  })

  // Integration (batch 13): thumbnails often land in bursts (a row scrolled into view, a cache hit).
  // Clamping every delay to the hold made a burst of 80 develop as one block, eight rows deep.
  it('a burst of arrivals still develops along one edge: about a row at a time, never a block', () => {
    // Arrange: reading at 25 ms a frame; 80 frames' images land in the same moment.
    let s = readTo(readTo(initialFrontier(), 1, 0), 81, 2000)
    const now = 2100

    // Act
    for (let i = 0; i < 80; i++) s = landed(s, i, now)

    // Assert: develops start one after another, the sweep is bounded, and few run at once.
    const develops = Array.from({ length: 80 }, (_, i) => filmOf(s, i))
    for (let i = 1; i < develops.length; i++) expect(develops[i]?.delay).toBeGreaterThan(develops[i - 1]?.delay ?? 0)
    expect(Math.max(...develops.map((d) => d.delay))).toBeLessThanOrEqual(MAX_SWEEP_MS)
    const atOnce = (t: number) => develops.filter((d) => d.delay <= t && t < d.delay + d.duration).length
    const busiest = Math.max(...Array.from({ length: 140 }, (_, k) => atOnce(k * 10)))
    expect(busiest).toBeLessThanOrEqual(12)
  })

  // QA §14 P1-1: releases come at the reading pace, so a backlog of develops never drained on a fast scan, and
  // the outline trailed the release edge by two screens for the rest of it.
  it('a fast reader: a backlog drains, the sweep taking larger batches until it is back within a few rows', () => {
    // Arrange: reading at 12 ms a frame; a hundred frames' pictures land at once.
    let s = readTo(readTo(initialFrontier(), 1, 0), 101, 1200)
    for (let i = 0; i < 100; i++) s = landed(s, i, 1200)
    const queued = (st: FrontierState, at: number) => Math.round((st.nextStart - at) / 12)
    expect(queued(s, 1200)).toBeGreaterThan(50)
    expect(queued(s, 1200)).toBeLessThan(MAX_SWEEP_FRAMES)

    // Act: reading goes on at the same pace for 2 s, ten frames a step, each picture landing as it's read.
    let now = 1200
    let count = 101
    let next = 100
    for (let step = 0; step < 17; step++) {
      now += 120
      count += 10
      s = readTo(s, count, now)
      for (; next < count; next++) s = landed(s, next, now)
    }

    // Assert: the queue is back to a few rows of develops.
    expect(queued(s, now)).toBeLessThanOrEqual(40)
  })

  it('moves the outline only when a develop ends, onto the highest frame whose run is complete', () => {
    // Arrange
    let s = readFrames(3)
    for (const i of [0, 1, 2]) s = landed(s, i, 0)
    expect(s.outline).toBe(-1)

    // Act + Assert: frame 2 finishes first; frame 1 is still developing, so the outline waits.
    s = developEnded(s, 2, 900)
    expect(s.outline).toBe(-1)
    s = developEnded(s, 0, 910)
    expect(s.outline).toBe(0)
    s = developEnded(s, 1, 920)
    expect(s.outline).toBe(2)
    expect(films(s, 3)).toEqual(['fixed', 'fixed', 'fixed'])
  })

  it('never outlines a frame whose image has not landed', () => {
    // Arrange: 0 is fixed, 1 never lands, 2 has landed but is held behind it.
    let s = readFrames(3)
    s = developEnded(landed(s, 0, 0), 0, 900)
    s = landed(s, 2, 950)

    // Act
    s = tick(s, 950 + HOLD_MS - 1)

    // Assert
    expect(s.outline).toBe(0)
    expect(filmOf(s, 1).film).toBe('latent')
    expect(filmOf(s, 2).film).toBe('latent')
  })
})

describe('frontier: early arrivals are held for at most 400 ms', () => {
  it('passes a frame still waiting once an arrival behind it has waited 400 ms', () => {
    // Arrange: 1 lands at t=0 while 0 is still on its way.
    let s = readFrames(3)
    s = landed(s, 1, 0)

    // Act + Assert: still held just before the limit.
    expect(films(tick(s, HOLD_MS - 1), 3)).toEqual(['latent', 'latent', 'latent'])
    s = tick(s, HOLD_MS)

    // Assert: 0 is passed (it keeps breathing, latent), 1 develops; 2 hasn't landed.
    expect(films(s, 3)).toEqual(['latent', 'fresh', 'latent'])
    expect(s.edge).toBe(2)
  })

  it('a frame passed while waiting just appears when it lands, and can then carry the outline', () => {
    // Arrange
    let s = readFrames(3)
    s = tick(landed(s, 1, 0), HOLD_MS)
    s = developEnded(s, 1, HOLD_MS + 900)
    expect(s.outline).toBe(1)

    // Act: the late frame lands.
    s = landed(s, 0, 2000)

    // Assert: fixed at once (it is behind the edge), and the outline stays on the higher frame.
    expect(filmOf(s, 0).film).toBe('fixed')
    expect(s.outline).toBe(1)
  })

  it('a frame passed while waiting that then fails stops breathing', () => {
    // Arrange: 0 is passed while it waits.
    let s = readFrames(3)
    s = tick(landed(s, 1, 0), HOLD_MS)
    expect(filmOf(s, 0).film).toBe('latent')

    // Act: its image fails.
    s = failedAt(s, 0, HOLD_MS + 10)

    // Assert
    expect(filmOf(s, 0).film).toBe('blank')
    expect(failedAt(s, 0, HOLD_MS + 20)).toBe(s)
  })

  it('asks to be woken when the oldest early arrival’s hold runs out', () => {
    // Arrange
    let s = readFrames(4)
    s = landed(s, 2, 100)
    s = landed(s, 3, 250)

    // Act + Assert
    expect(wakeAt(s, 260)).toBe(100 + HOLD_MS)
  })
})

describe('frontier: images that fail', () => {
  it('a failed image passes the edge as blank (it stops breathing), and a later retry fixes it', () => {
    // Arrange
    let s = readFrames(3)
    s = failedAt(s, 1, 0)
    expect(filmOf(s, 1).film).toBe('latent')

    // Act: the frames before and after it land.
    s = landed(s, 0, 10)
    s = landed(s, 2, 20)

    // Assert
    expect(films(s, 3)).toEqual(['fresh', 'blank', 'fresh'])

    // Act: the retry lands.
    s = landed(s, 1, 1500)

    // Assert
    expect(filmOf(s, 1).film).toBe('fixed')
  })

  it('a blank frame never carries the outline, and does not hold the run back', () => {
    let s = readFrames(3)
    s = failedAt(s, 1, 0)
    for (const i of [0, 2]) s = landed(s, i, 0)
    s = developEnded(developEnded(s, 0, 900), 2, 900)
    expect(s.outline).toBe(2)
  })
})

describe('frontier: develop length follows the reading pace', () => {
  function atPace(msPerFrame: number): FrontierState {
    let s = initialFrontier()
    for (let n = 1; n <= 8; n++) s = readTo(s, n, n * msPerFrame)
    return landed(s, 0, 8 * msPerFrame)
  }

  it('a slow scan develops for real: the whole sigmoid, contrast easing up', () => {
    const film = filmOf(atPace(300), 0)
    expect(film.duration).toBe(TRUE_DEVELOP_MS)
    expect(film.quick).toBe(false)
  })

  it('a fast scan keeps about four frames developing at once, opacity only', () => {
    const film = filmOf(atPace(12), 0)
    expect(film.duration).toBeLessThan(300)
    expect(film.duration).toBeGreaterThanOrEqual(120)
    expect(film.quick).toBe(true)
  })

  it('in between, a develop lasts about four frames of reading', () => {
    const film = filmOf(atPace(150), 0)
    expect(film.duration).toBeGreaterThan(500)
    expect(film.duration).toBeLessThan(700)
  })
})

describe('frontier: frames off screen, a new scan, and deadlines', () => {
  it('passes frames above the mounted rows: held ones are fixed, the rest wait latent', () => {
    // Arrange: a mid-scan entry; frames 0–5 were read before the sheet mounted at row 4.
    let s = readFrames(8)
    s = landed(s, 2, 0)
    s = failedAt(s, 3, 0)

    // Act
    s = passBefore(s, 4, 5)

    // Assert
    expect(films(s, 8)).toEqual(['latent', 'latent', 'fixed', 'blank', 'latent', 'latent', 'latent', 'latent'])
    expect(s.edge).toBe(4)
    expect(s.outline).toBe(2)

    // Act: the frames on screen land in order.
    s = landed(s, 4, 10)

    // Assert
    expect(filmOf(s, 4).film).toBe('fresh')
  })

  it('never moves the edge back', () => {
    const s = passBefore(readFrames(8), 6, 0)
    expect(passBefore(s, 2, 1)).toBe(s)
  })

  it('a shorter list is a new scan: everything starts latent again', () => {
    // Arrange
    let s = readFrames(3)
    for (const i of [0, 1, 2]) s = landed(s, i, 0)

    // Act
    s = readTo(s, 1, 50)

    // Assert
    expect(films(s, 1)).toEqual(['latent'])
    expect(s.outline).toBe(-1)
    expect(s.edge).toBe(0)
  })

  it('ends a develop whose animation never reported (unmounted, hidden window) by its deadline', () => {
    // Arrange
    let s = landed(readFrames(1), 0, 0)
    const deadline = wakeAt(s, 0)
    expect(deadline).toBeGreaterThanOrEqual(TRUE_DEVELOP_MS)

    // Act
    s = tick(s, deadline ?? 0)

    // Assert
    expect(filmOf(s, 0).film).toBe('fixed')
    expect(s.outline).toBe(0)
    expect(wakeAt(s, deadline ?? 0)).toBeNull()
  })

  it('hands back the same film object for a frame that did not change', () => {
    let s = readFrames(3)
    s = landed(s, 0, 0)
    const zero = filmOf(s, 0)
    const two = filmOf(s, 2)
    s = landed(s, 1, 10)
    expect(filmOf(s, 0)).toBe(zero)
    expect(filmOf(s, 2)).toBe(two)
  })
})

describe('frontier store', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('notifies on change, wakes itself for a hold, and stops its timer when disposed', () => {
    // Arrange
    vi.useFakeTimers()
    let t = 0
    const store = createFrontier({ now: () => t })
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)
    store.read(2)
    store.land(1)
    expect(store.film(1).film).toBe('latent')

    // Act: the hold runs out.
    t = HOLD_MS
    vi.advanceTimersByTime(HOLD_MS)

    // Assert
    expect(store.film(1).film).toBe('fresh')
    expect(listener).toHaveBeenCalled()

    // Act: disposed, the develop's deadline never fires.
    store.dispose()
    t = 5000
    vi.advanceTimersByTime(5000)

    // Assert
    expect(store.film(1).film).toBe('fresh')
    unsubscribe()
  })

  it('does not notify when nothing changed', () => {
    const store = createFrontier({ now: () => 0 })
    store.read(2)
    const listener = vi.fn()
    store.subscribe(listener)
    store.developed(0)
    store.pass(0)
    expect(listener).not.toHaveBeenCalled()
  })
})

// The JS mirrors the token so a slow scan's develop is the signature moment's full length.
it('TRUE_DEVELOP_MS matches --dur-true-develop in tokens.css', () => {
  const tokens = readFileSync(join(process.cwd(), 'src', 'styles', 'tokens.css'), 'utf8')
  const value = /--dur-true-develop:\s*(\d+)ms/.exec(tokens)?.[1]
  expect(Number(value)).toBe(TRUE_DEVELOP_MS)
})
