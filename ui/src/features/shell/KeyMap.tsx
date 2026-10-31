import { useCallback, useEffect, useId, useRef, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { X } from '@phosphor-icons/react'
import { useFocusTrap } from '../../components/ui/Overlays'
import { useExit, usePresence } from '../../components/ui/presence'
import { useView } from '../../state/view'
import { groupByIntent, isKeyMapKey, keyMapFor, spokenKey, spokenKeys, type KeyRow, type KeySection } from './keyMapData'
import { useKeyMap } from './keyMapStore'
import { usePrimaryAction } from '../../hooks/useKeys'
import './keymap.css'

/** "?" again puts the card away, and goes no further: the screen under it never sees the key. */
function useKeyMapKeyCloses(active: boolean, close: () => void): void {
  const latest = useRef(close)
  useEffect(() => {
    latest.current = close
  })
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (!isKeyMapKey(e)) return
      e.preventDefault()
      e.stopPropagation()
      latest.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [active])
}

/** A cap in running text: the glyph for the eye, the key's name for a screen reader. */
function Cap({ cap }: { cap: string }) {
  return (
    <>
      <kbd aria-hidden="true">{cap}</kbd>
      <span className="visually-hidden">{spokenKey(cap)}</span>
    </>
  )
}

/** One entry of the record: its caps (alternatives side by side) and what they do. */
function KeyLine({ row }: { row: KeyRow }) {
  return (
    <div className="km-row">
      <dt className="km-keys">
        {row.keys.map((cap) => (
          <kbd key={cap} aria-hidden="true">
            {cap}
          </kbd>
        ))}
        <span className="visually-hidden">{spokenKeys(row.keys)}</span>
      </dt>
      <dd className="km-does">{row.does}</dd>
    </div>
  )
}

/** A section's rows in intent groups (Move · Decide · Look · Make), each labelled in the margin. */
function KeyGroups({ section, idPrefix }: { section: KeySection; idPrefix: string }) {
  return (
    <div className="km-groups">
      {groupByIntent(section.rows).map((group) => {
        const labelId = `${idPrefix}-${group.intent}`
        return (
          <div key={group.intent} className="km-group" role="group" aria-labelledby={labelId}>
            <span id={labelId} className="km-intent label-caps">
              {group.label}
            </span>
            <dl className="km-rows">
              {group.rows.map((row) => (
                <KeyLine key={row.keys.join(' ')} row={row} />
              ))}
            </dl>
          </div>
        )
      })}
      {section.note ? <p className="km-note">{section.note}</p> : null}
    </div>
  )
}

interface KeyCardProps {
  cardRef: RefObject<HTMLElement | null>
  scrimRef: RefObject<HTMLDivElement | null>
  open: boolean
  leaving: boolean
  close: () => void
}

/** The exposure record: titled with the screen it describes, its keys in the wide column, Everywhere in the margin column. */
function KeyCard({ cardRef, scrimRef, open, leaving, close }: KeyCardProps) {
  const id = useId()
  const step = useView((s) => s.step)
  const exportOpen = useView((s) => s.exportOpen)
  const [own, everywhere] = keyMapFor(exportOpen ? 'export' : step)
  const titleId = `${id}-title`
  return (
    <div className="keymap-layer" inert={leaving} data-leaving={leaving || undefined}>
      <div ref={scrimRef} className="keymap-scrim" onClick={close} aria-hidden="true" />
      <section
        ref={cardRef}
        className="keymap"
        role="dialog"
        // Modal only while open: a leaving card must not hold the screen's keys for its exit.
        aria-modal={open}
        aria-labelledby={titleId}
        data-single={everywhere ? undefined : true}
      >
        <h2 id={titleId} className="km-title">
          Keys <span className="km-dot">·</span> <span className="km-where">{own?.title}</span>
        </h2>
        <button type="button" className="btn-icon sm km-close" aria-label="Close" title="Close (Esc)" onClick={close}>
          <X className="icon" aria-hidden="true" />
        </button>
        {own ? (
          <div className="km-col km-screen">
            <KeyGroups section={own} idPrefix={`${id}-own`} />
          </div>
        ) : null}
        {everywhere ? (
          <div className="km-col km-everywhere">
            <h3 className="km-col-head">{everywhere.title}</h3>
            <KeyGroups section={everywhere} idPrefix={`${id}-all`} />
          </div>
        ) : null}
        <p className="km-foot">
          Press <Cap cap="?" /> on any screen to see its keys, and again to put them away. Keys rest while you type in a field.
        </p>
      </section>
    </div>
  )
}

/**
 * While the card is open it owns ⌘↩: a modal primary action that does
 * nothing, so the export sheet's under it can't export (UI review 6, L2).
 */
function HoldPrimaryAction() {
  usePrimaryAction(null, { modal: true })
  return null
}

/**
 * Keys (critique round 5, P2-13): "?" lays an exposure-record card over any
 * screen with that screen's keys, then the ones that work everywhere. A modal
 * dialog: focus moves in and comes back, Tab stays inside, and Escape, "?"
 * again or a click outside put it away. It leaves with a short exit as an
 * inert copy, so focus and the screen's keys are back at once.
 */
export function KeyMap() {
  const open = useKeyMap((s) => s.open)
  const setOpen = useKeyMap((s) => s.setOpen)
  const { mounted, leaving, done } = usePresence(open)
  const card = useRef<HTMLElement>(null)
  const scrim = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [setOpen])
  useFocusTrap(card, open, close)
  useKeyMapKeyCloses(open, close)
  useExit(
    leaving,
    [
      { ref: card, kind: 'toast' },
      { ref: scrim, kind: 'popover' },
    ],
    done,
  )
  if (!mounted) return null
  return (
    <>
      {open ? <HoldPrimaryAction /> : null}
      {createPortal(<KeyCard cardRef={card} scrimRef={scrim} open={open} leaving={leaving} close={close} />, document.body)}
    </>
  )
}
