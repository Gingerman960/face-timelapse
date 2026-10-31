import { create } from 'zustand'
import type { NormalizeMode } from '../ipc/contract'

const MAX_RATE = 8

/** An Even light mode that is on. */
export type LookMode = Exclude<NormalizeMode, 'off'>

export interface PlayerState {
  /** Photo on screen (source frame index). */
  index: number
  /** The index the rest of the UI follows: equal to `index` when paused, ~4 Hz while playing. */
  settled: number
  playing: boolean
  /** Shuttle multiplier: negative plays backwards (J), doubles on repeat. */
  rate: number
  loop: boolean
  viewer: boolean
  /** The Even light mode last switched on, so the player and the export sheet turn it back on the same way. */
  lookMode: LookMode
  setIndex: (index: number) => void
  step: (delta: number, count: number) => void
  toggle: () => void
  pause: () => void
  shuttle: (key: 'j' | 'k' | 'l') => void
  setLoop: (loop: boolean) => void
  setViewer: (viewer: boolean) => void
  setLookMode: (mode: LookMode) => void
  /** Back to the first frame, paused (another library or a fresh session; UI review 2, H4). Loop and the look mode are preferences and stay. */
  resetPlayback: () => void
}

/** Next shuttle state for J/K/L (K pauses; J/L start or double in their direction). */
export function nextShuttle(playing: boolean, rate: number, key: 'j' | 'k' | 'l'): { playing: boolean; rate: number } {
  if (key === 'k') return { playing: false, rate: 1 }
  const dir = key === 'l' ? 1 : -1
  if (playing && Math.sign(rate) === dir) return { playing: true, rate: Math.max(-MAX_RATE, Math.min(MAX_RATE, rate * 2)) }
  return { playing: true, rate: dir }
}

export const usePlayer = create<PlayerState>((set) => ({
  index: 0,
  settled: 0,
  playing: false,
  rate: 1,
  loop: true,
  viewer: false,
  lookMode: 'exposureAndColor',
  setIndex: (index) => set({ index: Math.max(0, index), settled: Math.max(0, index) }),
  step: (delta, count) =>
    set((s) => {
      const index = Math.max(0, Math.min(count - 1, s.index + delta))
      return { playing: false, index, settled: index }
    }),
  toggle: () => set((s) => ({ playing: !s.playing, settled: s.index, rate: s.playing ? s.rate : Math.sign(s.rate) === 0 ? 1 : s.rate })),
  pause: () => set((s) => ({ playing: false, settled: s.index })),
  shuttle: (key) => set((s) => ({ ...nextShuttle(s.playing, s.rate, key), settled: s.index })),
  setLoop: (loop) => set({ loop }),
  setViewer: (viewer) => set({ viewer }),
  setLookMode: (lookMode) => set({ lookMode }),
  resetPlayback: () => set({ index: 0, settled: 0, playing: false, rate: 1, viewer: false }),
}))
