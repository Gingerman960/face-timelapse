import { create } from 'zustand'
import type { DayKey, PhotoId, ReviewDecision } from '../ipc/contract'
import { isStep, type Step } from '../lib/steps'

export type Theme = 'system' | 'light' | 'dark'
export type DaysZoom = 'decade' | 'year' | 'month'
export type TimelapseMode = 'player' | 'grid'
export type OnionSource = 'previous' | 'reference'
export type ScanFilter = 'all' | 'confirmed' | 'uncertain' | 'rejected' | 'noFace'

export interface Toast {
  id: number
  message: string
  tone: 'info' | 'stop'
  action?: { label: string; run: () => void }
}

/** Screens with an inspector; Scan and Review have none. */
export type InspectorScreen = 'setup' | 'days' | 'timelapse'
const INSPECTOR_DEFAULTS: Readonly<Record<InspectorScreen, boolean>> = { setup: true, days: true, timelapse: false }

function inspectorScreen(step: Step): InspectorScreen | null {
  if (step === 'setup' || step === 'days') return step
  if (step === 'timelapse' || step === 'align') return 'timelapse'
  return null
}

export interface UndoEntry {
  ids: PhotoId[]
  previous: ReviewDecision
}

interface ViewState {
  step: Step
  theme: Theme
  sidebarCollapsed: boolean
  /** The current screen's inspector; toggled by ⌥⌘I and each screen's toolbar button. */
  inspectorOpen: boolean
  /** Each screen remembers its own inspector state (DESIGN: Timelapse starts without). */
  inspectors: Readonly<Record<InspectorScreen, boolean>>
  setupDragging: boolean
  reviewIndex: number
  reviewUndo: UndoEntry[]
  scanFilter: ScanFilter
  activeDay: DayKey | null
  daysZoom: DaysZoom
  daysYear: number | null
  timelapseMode: TimelapseMode
  onion: boolean
  onionSource: OnionSource
  onionOpacity: number
  onionDifference: boolean
  anchors: boolean
  exportOpen: boolean
  dropActive: boolean
  toasts: Toast[]
  setStep: (step: Step) => void
  setTheme: (theme: Theme) => void
  toggleSidebar: () => void
  toggleInspector: () => void
  setSetupDragging: (dragging: boolean) => void
  setReviewIndex: (index: number) => void
  pushReviewUndo: (entry: UndoEntry) => void
  popReviewUndo: () => UndoEntry | null
  /** A batch failed and these photos rolled back: their calls never happened, so nothing undoes them. */
  dropReviewUndo: (ids: readonly PhotoId[]) => void
  setScanFilter: (filter: ScanFilter) => void
  setActiveDay: (day: DayKey | null) => void
  setDaysZoom: (zoom: DaysZoom) => void
  setDaysYear: (year: number) => void
  setTimelapseMode: (mode: TimelapseMode) => void
  setOnion: (patch: Partial<Pick<ViewState, 'onion' | 'onionSource' | 'onionOpacity' | 'onionDifference'>>) => void
  setAnchors: (on: boolean) => void
  setExportOpen: (open: boolean) => void
  setDropActive: (active: boolean) => void
  /** Forgets per-library positions (active day, review cursor and undo) when the library changes. */
  resetLibraryView: () => void
  pushToast: (toast: Omit<Toast, 'id'>) => number
  dismissToast: (id: number) => void
}

const THEME_KEY = 'ft.theme'
const STEP_KEY = 'ft.lastStep'

/** Reads a localStorage value; storage can be unavailable (private mode, tests). */
export function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

/** Writes a localStorage value, ignoring storage failures. */
export function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    /* storage unavailable: the preference simply is not remembered */
  }
}

function initialTheme(): Theme {
  const stored = readStored(THEME_KEY)
  return stored === 'light' || stored === 'dark' ? stored : 'system'
}

/** The step stored on the last run, if any (validated against reachability elsewhere). */
export function storedLastStep(): Step | null {
  const v = readStored(STEP_KEY)
  return isStep(v) ? v : null
}

let toastSeq = 0

export const useView = create<ViewState>((set, get) => ({
  step: 'setup',
  theme: initialTheme(),
  sidebarCollapsed: false,
  inspectorOpen: INSPECTOR_DEFAULTS.setup,
  inspectors: INSPECTOR_DEFAULTS,
  setupDragging: false,
  reviewIndex: 0,
  reviewUndo: [],
  scanFilter: 'all',
  activeDay: null,
  daysZoom: 'year',
  daysYear: null,
  timelapseMode: 'player',
  onion: false,
  onionSource: 'previous',
  onionOpacity: 0.5,
  onionDifference: false,
  anchors: false,
  exportOpen: false,
  dropActive: false,
  toasts: [],
  setStep: (step) => {
    if (step !== 'scan' && step !== 'align') writeStored(STEP_KEY, step)
    const screen = inspectorScreen(step)
    set((s) => (screen ? { step, inspectorOpen: s.inspectors[screen] } : { step }))
  },
  setTheme: (theme) => {
    writeStored(THEME_KEY, theme)
    set({ theme })
  },
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  toggleInspector: () =>
    set((s) => {
      const open = !s.inspectorOpen
      const screen = inspectorScreen(s.step)
      return screen ? { inspectorOpen: open, inspectors: { ...s.inspectors, [screen]: open } } : { inspectorOpen: open }
    }),
  setSetupDragging: (setupDragging) => set({ setupDragging }),
  setReviewIndex: (reviewIndex) => set({ reviewIndex: Math.max(0, reviewIndex) }),
  pushReviewUndo: (entry) => set((s) => ({ reviewUndo: [...s.reviewUndo, entry].slice(-200) })),
  popReviewUndo: () => {
    const stack = get().reviewUndo
    const last = stack[stack.length - 1] ?? null
    if (last) set({ reviewUndo: stack.slice(0, -1) })
    return last
  },
  dropReviewUndo: (ids) => {
    const gone = new Set(ids)
    set((s) => ({ reviewUndo: s.reviewUndo.map((e) => ({ ...e, ids: e.ids.filter((id) => !gone.has(id)) })).filter((e) => e.ids.length > 0) }))
  },
  setScanFilter: (scanFilter) => set({ scanFilter }),
  setActiveDay: (activeDay) => set({ activeDay }),
  setDaysZoom: (daysZoom) => set({ daysZoom }),
  setDaysYear: (daysYear) => set({ daysYear }),
  setTimelapseMode: (timelapseMode) => set({ timelapseMode }),
  setOnion: (patch) => set(patch),
  setAnchors: (anchors) => set({ anchors }),
  setExportOpen: (exportOpen) => set({ exportOpen }),
  setDropActive: (dropActive) => set({ dropActive }),
  resetLibraryView: () => set({ activeDay: null, daysYear: null, reviewIndex: 0, reviewUndo: [] }),
  pushToast: (toast) => {
    toastSeq += 1
    const id = toastSeq
    // Identical toasts coalesce (e.g. a burst of `busy` while the mutation gate
    // is held): the old copy goes, the new one restarts the time on screen.
    // Never ones with an action: each Undo belongs to its own change (UI review 2, L2).
    const same = (t: Toast) => !t.action && !toast.action && t.message === toast.message && t.tone === toast.tone
    set((s) => ({ toasts: [...s.toasts.filter((t) => !same(t)), { ...toast, id }].slice(-3) }))
    return id
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}))
