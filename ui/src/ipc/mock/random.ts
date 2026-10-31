// Deterministic hashing and seeded randomness for the mock backend.
// Pure and environment-agnostic: used in the browser (fake backend) and in
// Node (the Vite mock-image middleware), so both sides derive identical data.

const FNV_OFFSET = 0x811c9dc5
const FNV_PRIME = 0x01000193
const GOLDEN = 0x9e3779b9
const UINT32 = 0x1_0000_0000

/** 32-bit FNV-1a over UTF-16 code units with a murmur3 finalizer (good avalanche). */
export function hash32(text: string, seed: number = FNV_OFFSET): number {
  let h = seed >>> 0
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, FNV_PRIME)
  }
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

/** `length` lowercase hex chars derived from `text` (independent 32-bit lanes). */
export function hashHex(text: string, length: number): string {
  let out = ''
  for (let lane = 1; out.length < length; lane++) {
    const seed = (FNV_OFFSET ^ Math.imul(lane, GOLDEN)) >>> 0
    out += hash32(text, seed).toString(16).padStart(8, '0')
  }
  return out.slice(0, length)
}

/** Uniform [0, 1) from a string key. */
export function unitHash(text: string): number {
  return hash32(text) / UINT32
}

export type Rng = () => number

/** mulberry32: tiny, fast, good enough for synthetic fixtures. Returns [0, 1). */
export function mulberry32(seed: number): Rng {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / UINT32
  }
}

/** A PRNG seeded from a string key. */
export function rngFor(key: string): Rng {
  return mulberry32(hash32(key))
}

/** Integer in [min, max] inclusive. */
export function randInt(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1))
}

/** Float in [min, max). */
export function randRange(rng: Rng, min: number, max: number): number {
  return min + rng() * (max - min)
}

/** A new array with the items of `items` in a seeded random order (Fisher–Yates on a copy). */
export function shuffled<T>(items: readonly T[], rng: Rng): T[] {
  const out = items.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const a = out[i] as T
    out[i] = out[j] as T
    out[j] = a
  }
  return out
}

/** Picks one item; throws on an empty list (a fixture bug, never user input). */
export function pick<T>(items: readonly T[], rng: Rng): T {
  if (items.length === 0) throw new Error('pick() from an empty list')
  return items[Math.floor(rng() * items.length)] as T
}

/** Rounds to `digits` decimals and normalizes -0 to 0 (JSON and deep-equal friendly). */
export function round(value: number, digits: number): number {
  const f = 10 ** digits
  const r = Math.round(value * f) / f
  return r === 0 ? 0 : r
}

/** Clamps `value` into [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
