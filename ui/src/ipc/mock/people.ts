// Appearance of the synthetic subject (and of other people in some photos):
// rooms the subject lived in, shirts, skin, hair, a beard that grows over the
// decade, exposure and white-balance wobble. Pure, derived from id + date.
import type { LocalDateTime } from '../contract'
import { decadeFraction } from './calendar'
import { clamp, pick, rngFor, round } from './random'

export interface PortraitParams {
  /** Wall colour. */
  room: string
  /** Darker trim colour (door frame / shelf). */
  trim: string
  shirt: string
  skin: string
  hair: string
  /** 0 = clean-shaven … 1 = full beard. */
  beard: number
  /** Photo exposure relative to the reference, in stops (≈ −1.2 … +1.2). */
  exposureEv: number
  /** White balance: −1 cool … +1 warm. */
  warmth: number
  /** Window light position across the frame, 0..1. */
  lightX: number
  /** Window light strength, 0..1. */
  lightStrength: number
  /** Door / shelf position across the frame, 0..1. */
  featureX: number
}

export type PersonRole = 'subject' | 'other'

/** Muted wall colours: the subject's rooms over the years, then a few others. */
const ROOMS = ['#9c7d66', '#77826a', '#8d939b', '#bdb19d', '#4d4955', '#9a7465', '#cdc7bc', '#5f6c7a'] as const
const TRIMS = ['#6e5646', '#545c4a', '#62676e', '#8f8572', '#35323b', '#6d5248', '#9b958b', '#424c57'] as const
const SHIRTS = ['#2f3a4a', '#d9d4c8', '#6b4a3a', '#3e5a44', '#9a9c9e', '#26292e', '#b9a27a', '#7a3f3a'] as const
const OTHER_SKINS = ['hsl(30 35% 70%)', 'hsl(22 42% 48%)', 'hsl(18 38% 36%)', 'hsl(28 30% 76%)'] as const
const OTHER_HAIRS = ['hsl(40 45% 55%)', 'hsl(20 25% 10%)', 'hsl(12 50% 32%)', 'hsl(0 0% 62%)'] as const

/** The subject moved flat every couple of years; each era has its own wall colour. */
const ERAS: readonly { until: string; room: number }[] = [
  { until: '2014-03-15', room: 0 },
  { until: '2016-07-01', room: 1 },
  { until: '2018-11-20', room: 2 },
  { until: '2020-06-10', room: 3 },
  { until: '9999-12-31', room: 6 },
]

const BEARD_START = 0.62
const BEARD_GROWTH = 0.25
const OWN_ROOM_SHARE = 0.78

function eraRoom(dayKey: string): number {
  return (ERAS.find((e) => dayKey < e.until) ?? ERAS[ERAS.length - 1])?.room ?? 0
}

/**
 * Appearance for photo `id` taken at `takenAt`. The `subject` role is the
 * person whose decade this is; `other` is someone else in the frame. Scene
 * fields (room, light, exposure, white balance) are the same for both roles.
 */
export function portraitParams(id: string, takenAt: LocalDateTime, role: PersonRole = 'subject'): PortraitParams {
  const dayKey = takenAt.slice(0, 10)
  const scene = rngFor(`scene:${id}`)
  const age = decadeFraction(dayKey)
  const roomIndex = scene() < OWN_ROOM_SHARE ? eraRoom(dayKey) : Math.floor(scene() * ROOMS.length)
  const exposureEv = round(clamp((scene() + scene() - 1) * 1.2, -1.2, 1.2), 2)
  const warmth = round(clamp((scene() - 0.5) * 2, -1, 1), 2)
  const lightX = round(0.15 + scene() * 0.7, 3)
  const lightStrength = round(0.12 + scene() * 0.22, 3)
  const featureX = round(scene() < 0.5 ? 0.05 + scene() * 0.12 : 0.83 + scene() * 0.1, 3)

  const person = rngFor(`${role}:${id}`)
  const shirt = pick(SHIRTS, person)
  let skin: string
  let hair: string
  let beard: number
  if (role === 'subject') {
    skin = `hsl(${24 + Math.round(person() * 4)} ${38 + Math.round(person() * 6)}% ${60 + Math.round(person() * 4)}%)`
    const grey = age * 5
    hair = `hsl(26 ${Math.round(34 - age * 10)}% ${Math.round(16 + grey + person() * 3)}%)`
    beard = age > BEARD_START ? Math.min(1, (age - BEARD_START) / BEARD_GROWTH) : person() < 0.12 ? 0.2 : 0
  } else {
    skin = pick(OTHER_SKINS, person)
    hair = pick(OTHER_HAIRS, person)
    beard = person() < 0.3 ? 0.8 : 0
  }
  return {
    room: ROOMS[roomIndex] ?? ROOMS[0],
    trim: TRIMS[roomIndex] ?? TRIMS[0],
    shirt,
    skin,
    hair,
    beard: round(beard, 3),
    exposureEv,
    warmth,
    lightX,
    lightStrength,
    featureX,
  }
}
