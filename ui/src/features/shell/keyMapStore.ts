import { create } from 'zustand'

interface KeyMapState {
  /** The Keys card is on the table (critique round 5, P2-13). */
  open: boolean
  setOpen: (open: boolean) => void
  /** "?": show the card, or put it away (Help › Keyboard Shortcuts only shows it: `setOpen(true)`). */
  toggle: () => void
}

export const useKeyMap = create<KeyMapState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set((s) => ({ open: !s.open })),
}))
