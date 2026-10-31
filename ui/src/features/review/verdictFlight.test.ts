// Critique round 4, signature moment 2 ("the verdict"): the decided print
// flies into its queue slot on transform and opacity only.
import { describe, expect, it } from 'vitest'
import { FLIGHT_DELAY_MS, FLIGHT_MS, flightPlan, LEFT_OUT_OPACITY } from './verdictFlight'

const from = { left: 100, top: 50, width: 300, height: 400 }
const slot = { left: 600, top: 700, width: 44, height: 44 }

/** The numbers in a `translate(x, y) scale(s)` string. */
function parse(transform: unknown): number[] {
  return String(transform)
    .match(/-?\d+(\.\d+)?/g)
    ?.map(Number) ?? []
}

describe('flightPlan', () => {
  it('lands the print on its queue slot: centres meet and the heights match', () => {
    // Act
    const plan = flightPlan(from, slot, 'confirmed', false)

    // Assert
    const [tx, ty, s] = parse(plan.transform?.at(-1)?.transform)
    expect(s).toBeCloseTo(44 / 400, 6)
    expect(from.left + (tx as number) + (from.width * (s as number)) / 2).toBeCloseTo(slot.left + slot.width / 2, 6)
    expect(from.top + (ty as number) + (from.height * (s as number)) / 2).toBeCloseTo(slot.top + slot.height / 2, 6)
  })

  it('lets the pen start first, then flies for 280 ms on the arrival curve', () => {
    const plan = flightPlan(from, slot, 'confirmed', false)
    expect(plan.timing.delay).toBe(FLIGHT_DELAY_MS)
    expect(plan.timing.duration).toBe(FLIGHT_MS)
    expect(plan.timing.easing).toBe('cubic-bezier(0.16, 1, 0.3, 1)')
    expect(plan.opacityTiming.delay).toBe(FLIGHT_DELAY_MS)
    expect(plan.opacityTiming.duration).toBe(FLIGHT_MS)
  })

  it('hands over to the slot: a kept print stays bright until late, a left-out one dims to 35 % first', () => {
    const kept = flightPlan(from, slot, 'confirmed', false).opacity.map((k) => k.opacity)
    const out = flightPlan(from, slot, 'rejected', false).opacity.map((k) => k.opacity)
    expect(kept).toEqual([1, 1, 0])
    expect(out).toEqual([1, LEFT_OUT_OPACITY, 0])
  })

  it('sinks and fades in place when its slot is out of view', () => {
    const plan = flightPlan(from, null, 'confirmed', false)
    expect(plan.transform?.at(-1)?.transform).toMatch(/^translateY\(\d+px\) scale\(0\.\d+\)$/)
    expect(plan.opacity.at(-1)?.opacity).toBe(0)
  })

  it('under reduced motion nothing moves: a short fade only', () => {
    const plan = flightPlan(from, slot, 'rejected', true)
    expect(plan.transform).toBeNull()
    expect(plan.opacity.map((k) => k.opacity)).toEqual([1, 0])
    expect(plan.opacityTiming.duration).toBeLessThanOrEqual(120)
    expect(plan.opacityTiming.delay).toBe(0)
  })
})
