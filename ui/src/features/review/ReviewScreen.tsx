import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react'
import type { PhotoId, PhotoSummary } from '../../ipc/contract'
import { referenceFrameUrl } from '../../ipc/images'
import { dayKeyFromFileName } from '../../lib/dates'
import { countOf, formatCount, pluralize } from '../../lib/format'
import { PlateButton, QuietButton, TextButton } from '../../components/ui/Button'
import { isActivationTarget, isMod, useKeydown, usePrimaryAction } from '../../hooks/useKeys'
import { useJobs } from '../../state/jobs'
import { useAppInfo, usePhoto, usePhotos, useSession } from '../../state/queries'
import { useView } from '../../state/view'
import { Screen } from '../shell/Screen'
import type { ShownPrint } from './Candidate'
import { ReviewDone } from './ReviewDone'
import { ReviewFacts, ReviewStage } from './ReviewParts'
import { filmWidth, ReviewQueue } from './ReviewQueue'
import { UNCERTAIN, useReviewDecisions } from './useReviewDecisions'
import { usePrintPrefetch } from './usePrintPrefetch'
import { VerdictGhost, type Flight } from './VerdictGhost'
import './review.css'

/** Next photo still awaiting a decision after `from` (wrapping), or -1. */
export function nextPending(list: readonly PhotoSummary[], from: number): number {
  for (let k = 1; k <= list.length; k++) {
    const i = (from + k) % list.length
    if (list[i]?.review === 'pending') return i
  }
  return -1
}

interface ReviewActions {
  /** False on the done state: the decision keys rest, undo stays (UI review 3, M4). */
  deciding: boolean
  decide: (review: 'confirmed' | 'rejected') => void
  undo: () => void
  keepAll: () => void
  setCompare: (on: boolean) => void
}

/**
 * Review's keys: Y/→/Enter keep, N/←/⌫ leave out, U/⌘Z undo, ⇧A keep all,
 * Space held compares. Enter and Space stand back when a focused control
 * (a button, a queue photo) handles them itself.
 */
function useReviewKeys({ deciding, decide, undo, keepAll, setCompare }: ReviewActions): void {
  // True while a held Space (not a focused control's) shows the comparison (UI review 2, L5).
  const spaceCompares = useRef(false)
  useKeydown((e) => {
    const k = e.key
    if ((k === 'Enter' || k === ' ') && isActivationTarget(e.target)) return
    if ((isMod(e) && k.toLowerCase() === 'z') || k === 'u' || k === 'U') {
      e.preventDefault()
      undo()
    } else if (isMod(e) || e.altKey || !deciding) return
    else if (k === 'y' || k === 'Y' || k === 'ArrowRight' || k === 'Enter') {
      e.preventDefault()
      decide('confirmed')
    } else if (k === 'n' || k === 'N' || k === 'ArrowLeft' || k === 'Backspace') {
      e.preventDefault()
      decide('rejected')
    } else if (k === 'A' && e.shiftKey) keepAll()
    else if (k === ' ' && !e.repeat) {
      e.preventDefault()
      spaceCompares.current = true
      setCompare(true)
    }
  })
  useEffect(() => {
    // Only the release of a Space that started comparing ends it; a focused control's Space is its own.
    const up = (e: KeyboardEvent) => {
      if (e.key !== ' ' || !spaceCompares.current) return
      spaceCompares.current = false
      setCompare(false)
    }
    window.addEventListener('keyup', up)
    return () => window.removeEventListener('keyup', up)
  }, [setCompare])
}

/**
 * The last call made (critique round 4, signature moment 2): its photo's mark
 * is the only one written with the pen, and while its print flies to the
 * queue, `flight` holds it.
 */
interface Verdict {
  seq: number
  id: PhotoId
  flight: Flight | null
}

/** The print on show, as the verdict lifts it: only if it is the photo being decided. */
function liftPrint(shown: ShownPrint | null, photo: PhotoSummary, review: 'confirmed' | 'rejected'): Flight | null {
  if (!shown || shown.spec.key !== photo.id) return null
  const r = shown.frame.getBoundingClientRect()
  return { id: photo.id, review, spec: shown.spec, from: { left: r.left, top: r.top, width: r.width, height: r.height } }
}

/** The unsure photos, the cursor, and the decide / undo / keep-all actions. */
function useReview() {
  const photos = usePhotos([...UNCERTAIN])
  const list = useMemo(() => photos.data ?? [], [photos.data])
  const index = useView((s) => s.reviewIndex)
  const setIndex = useView((s) => s.setReviewIndex)
  const setStep = useView((s) => s.setStep)
  const busy = useJobs((s) => s.activeJobId !== null)
  const queue = useReviewDecisions()
  const [announce, setAnnounce] = useState('')
  const [verdict, setVerdict] = useState<Verdict | null>(null)
  const shown = useRef<ShownPrint | null>(null)
  const onShown = useCallback((print: ShownPrint | null) => {
    shown.current = print
  }, [])
  const pendingCount = list.filter((p) => p.review === 'pending').length
  const cursor = Math.min(index, Math.max(0, list.length - 1))
  const current = list[cursor]

  useEffect(() => {
    if (!photos.data || list.length === 0 || list[index]) return
    setIndex(Math.max(0, nextPending(list, -1)))
  }, [photos.data, list, index, setIndex])

  const decide = useCallback(
    (review: 'confirmed' | 'rejected') => {
      if (!current || busy) return
      const flight = liftPrint(shown.current, current, review)
      useView.getState().pushReviewUndo({ ids: [current.id], previous: current.review })
      queue.decide([current.id], review)
      // A new call ends the previous verdict's flight at once (its ghost unmounts): input never waits.
      setVerdict((v) => ({ seq: (v?.seq ?? 0) + 1, id: current.id, flight }))
      setAnnounce(`${review === 'confirmed' ? 'Kept' : 'Left out'}. ${list.indexOf(current) + 1} of ${list.length}.`)
      const next = nextPending(list.map((p) => (p.id === current.id ? { ...p, review } : p)), index)
      if (next >= 0) setIndex(next)
    },
    [current, busy, list, index, setIndex, queue],
  )

  const undo = useCallback(() => {
    if (busy) return
    const entry = useView.getState().popReviewUndo()
    if (!entry) return
    queue.decide(entry.ids, entry.previous)
    setVerdict(null)
    const i = list.findIndex((p) => p.id === entry.ids[0])
    if (i >= 0) setIndex(i)
    setAnnounce('Undone.')
  }, [busy, list, setIndex, queue])

  const keepAll = useCallback(() => {
    const ids = list.filter((p) => p.review === 'pending').map((p) => p.id)
    if (ids.length === 0 || busy) return
    useView.getState().pushReviewUndo({ ids, previous: 'pending' })
    queue.decide(ids, 'confirmed')
    setVerdict(null)
    setAnnounce(`Kept ${ids.length} remaining.`)
  }, [list, busy, queue])

  const landed = useCallback((seq: number) => setVerdict((v) => (v && v.seq === seq ? { ...v, flight: null } : v)), [])

  return {
    list,
    loaded: photos.data !== undefined,
    cursor,
    current,
    pendingCount,
    busy,
    announce,
    verdict,
    justDecided: verdict?.id ?? null,
    onShown,
    landed,
    decide,
    undo,
    keepAll,
    setIndex,
    setStep,
  }
}

/**
 * The toolbar while photos are pending (critique round 3): the decision
 * buttons under the prints carry the screen's weight, so the way on to Days is
 * a quiet text action that says what it costs, and Keep all is the secondary.
 */
function PendingTools({ pending, busy, onKeepAll, onSkip }: { pending: number; busy: boolean; onKeepAll: () => void; onSkip: () => void }) {
  return (
    <>
      <TextButton className="skip-days" onClick={onSkip} title="Photos you haven’t looked at stay out of the timelapse; you can add any of them later from Days.">
        Skip to Days <span className="meta">· <span className="digits">{formatCount(pending)}</span> {pluralize(pending, 'stays', 'stay')} out</span>
      </TextButton>
      <QuietButton kbd="⇧A" onClick={onKeepAll} disabled={busy}>
        Keep all remaining
      </QuietButton>
    </>
  )
}

/**
 * When the last call is made (UI review 4, L2), the control that had focus
 * goes away with the stage: focus moves to the Continue plate, the one way on.
 * Not when Review opens already done. Returns the plate's ref.
 */
function useFocusOnDone(deciding: boolean): RefObject<HTMLButtonElement | null> {
  const plate = useRef<HTMLButtonElement>(null)
  const wasDeciding = useRef(deciding)
  useEffect(() => {
    if (wasDeciding.current && !deciding) plate.current?.focus()
    wasDeciding.current = deciding
  }, [deciding])
  return plate
}

/** A held Enter that made the last call must not also press the plate it lands on. */
function ignoreHeldKey(e: ReactKeyboardEvent<HTMLButtonElement>): void {
  if (e.repeat) e.preventDefault()
}

/** Latent prints in the queue band while the list is on its way: as many as a short film. */
const LOADING_PRINTS = 7

/**
 * Review before its list is known (critique round 6, P1-2): the stage stays
 * empty and the queue band holds a short run of latent prints, breathing like
 * the scan's undeveloped frames, until the photos arrive.
 */
function ReviewLoading() {
  const film = { '--film-w': `${filmWidth(LOADING_PRINTS, false)}px` } as CSSProperties
  return (
    <div className="review review-loading">
      <div className="review-stage" />
      <div className="queue" style={film} aria-hidden="true">
        <div className="q-strip q-latent">
          {Array.from({ length: LOADING_PRINTS }, (_, i) => (
            <span key={i} className="q-ghost" style={{ '--i': i } as CSSProperties} />
          ))}
        </div>
      </div>
    </div>
  )
}

/** Review: a fast, keyboard-first pass over the photos the scan wasn't sure about. */
export default function ReviewScreen() {
  const session = useSession().data
  const info = useAppInfo().data
  const r = useReview()
  const [compare, setCompare] = useState(false)
  const photo = usePhoto(r.current?.id ?? null)
  const detail = photo.data
  usePrintPrefetch(r.list, r.cursor, info?.imageBaseUrl ?? null)
  const toggleCompare = useCallback(() => setCompare((c) => !c), [])
  const deciding = r.pendingCount > 0
  useReviewKeys({ deciding, decide: r.decide, undo: r.undo, keepAll: r.keepAll, setCompare })
  const continueToDays = () => r.setStep('days')
  // ⌘↩ continues only once every photo has a call: while some are pending it
  // would quietly leave them out (critique round 3), so it rests until then,
  // and until the list is known at all (critique round 6, P1-2).
  usePrimaryAction(deciding || !r.loaded ? null : continueToDays)
  const plate = useFocusOnDone(deciding)

  if (!session || !info) return null
  const { list, current } = r
  const tools = deciding ? <PendingTools pending={r.pendingCount} busy={r.busy} onKeepAll={r.keepAll} onSkip={continueToDays} /> : (
    <PlateButton ref={plate} kbd="⌘↩" onClick={continueToDays} onKeyDown={ignoreHeldKey} disabled={!r.loaded}>
      Continue to Days
    </PlateButton>
  )
  // Before the list loads (critique round 6, P1-2): a calm gathering state, never "nothing to review".
  if (!r.loaded) {
    return (
      <Screen title="Review" subtitle="Gathering the unsure photos…" tools={tools} busy>
        <ReviewLoading />
      </Screen>
    )
  }
  const subtitle = list.length === 0 ? 'No photos the scan wasn’t sure about' : `${countOf(list.length, 'photo')} the scan wasn’t sure about`

  // Done, or nothing to review (critique round 4, P2-20): the same composition.
  if (r.pendingCount === 0) {
    return (
      <Screen title="Review" subtitle={subtitle} tools={tools}>
        <ReviewDone list={list} base={info.imageBaseUrl} announce={r.announce} justDecided={r.justDecided} />
      </Screen>
    )
  }
  if (!current) {
    return (
      <Screen title="Review" subtitle={subtitle} tools={tools}>
        {null}
      </Screen>
    )
  }

  const ref = session.reference
  const refFrame = ref ? referenceFrameUrl(info.imageBaseUrl, ref.version, 1100, window.devicePixelRatio) : null
  const position = list.indexOf(current) + 1
  const flight = r.verdict?.flight ?? null
  const seq = r.verdict?.seq ?? 0
  const film = { '--film-w': `${filmWidth(list.length, true)}px` } as CSSProperties
  return (
    <Screen title="Review" subtitle={subtitle} tools={tools}>
      <div className="review" style={{ ['--frame-ar' as string]: ref ? `${ref.crop.width} / ${ref.crop.height}` : '3 / 4' }}>
        <ReviewStage
          referenceDay={ref ? dayKeyFromFileName(ref.image.fileName) : null}
          photo={current}
          detail={detail}
          detailPending={photo.isPending}
          justDecided={r.justDecided}
          onShown={r.onShown}
          refAnchors={ref?.detection?.anchors ?? null}
          base={info.imageBaseUrl}
          referenceFrameUrl={refFrame}
          compare={compare}
          busy={r.busy}
          onDecide={r.decide}
          onToggleCompare={toggleCompare}
        />
        <ReviewFacts photo={current} detail={detail} />
        <div className="queue" style={film} data-single={list.length === 1 ? 'true' : undefined}>
          {/* A film of one carries its counter on its rebate instead (critique round 5, P3-22). */}
          {list.length > 1 ? (
            <span className="q-count mono-meta">
              {position} / {list.length}
            </span>
          ) : null}
          <ReviewQueue list={list} currentId={current.id} base={info.imageBaseUrl} onPick={r.setIndex} justDecided={r.justDecided} />
        </div>
        <div className="verdict-layer" aria-hidden="true">
          {flight ? <VerdictGhost key={seq} flight={flight} onDone={() => r.landed(seq)} /> : null}
        </div>
        <p className="visually-hidden" aria-live="polite">
          {r.announce}
        </p>
      </div>
    </Screen>
  )
}
