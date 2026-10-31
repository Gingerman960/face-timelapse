import { useState, type CSSProperties, type ReactNode } from 'react'
import { Sidebar as SidebarIcon } from '@phosphor-icons/react'
import type { IpcError, ReferenceImage } from '../../ipc/contract'
import { toIpcError } from '../../ipc/client'
import { referenceUrl } from '../../ipc/images'
import { thisMachine } from '../../lib/format'
import { outputSize } from '../../lib/video'
import { IconButton, PlateButton } from '../../components/ui/Button'
import { Notice } from '../../components/ui/Overlays'
import { DataText } from '../../components/ui/DataText'
import { usePrimaryAction } from '../../hooks/useKeys'
import { pickReferencePhoto, pickSourceFolder, reportError, setReferencePhoto, setSourceFolder } from '../../state/actions'
import { startScan, useJobs } from '../../state/jobs'
import { useAppInfo, useDays, useSession } from '../../state/queries'
import { useView } from '../../state/view'
import { Screen } from '../shell/Screen'
import { CropEditor } from './CropEditor'
import { ReferenceReadouts } from './ReferenceReadouts'
import { ReferenceInspector } from './SetupInspector'
import { SetupEmpty } from './SetupEmpty'
import { scanBlocker, setupPlate, type SetupPlate } from './setupModel'
import { useArrival } from './useArrival'
import { useModelsBlock } from '../../state/models'
import { useCropDraft } from './useCropDraft'
import { forgetScanResults, useReferenceEdits } from './useReferenceEdits'
import { useSetupKeys } from './useSetupKeys'
import './setup.css'

const TITLE = 'Reference'
const SUBTITLE = 'Pick the face every frame lines up to'
/** CSS width the print is requested at (the stage is about this wide). */
const PRINT_CSS_WIDTH = 1100

type PickSide = 'photo' | 'folder'

/** First-run picks report next to the button that failed; a later pick clears the report. */
function usePickErrors(onSuccess: () => void) {
  const [pickError, setPickError] = useState<{ side: PickSide; error: IpcError } | null>(null)
  const pick = (side: PickSide, p: Promise<unknown>) => {
    setPickError(null)
    void p.then(onSuccess, (e: unknown) => setPickError({ side, error: toIpcError(e) }))
  }
  const notice = (side: PickSide): ReactNode =>
    pickError?.side === side ? (
      <Notice tone="stop" title={side === 'photo' ? 'That photo didn’t work.' : 'That folder didn’t work.'}>
        {pickError.error.message}
      </Notice>
    ) : null
  return { pick, notice }
}

function CaptionLine({ image }: { image: ReferenceImage }) {
  return (
    <p className="caption-line">
      <span className="label-caps">Reference</span>
      <span className="mono-meta">
        {image.fileName} · {image.size.width} × {image.size.height}
      </span>
      {/* Words in the UI face, the figure in the data face (critique round 5, P3-21). */}
      {image.rotationDeg ? <DataText className="meta caption-rotated">{`rotated ${image.rotationDeg.toFixed(1)}°`}</DataText> : null}
    </p>
  )
}

interface SetupToolsProps {
  inspectorOpen: boolean
  onToggleInspector: () => void
  /** The next step (critique round 4): scan, or go on to Review or Days. */
  plate: SetupPlate
  /** Why the plate can't run now (a scan blocked), or null. */
  blocker: string | null
  onPlate: () => void
}

function SetupTools({ inspectorOpen, onToggleInspector, plate, blocker, onPlate }: SetupToolsProps) {
  return (
    <>
      <IconButton label="Toggle inspector" aria-pressed={inspectorOpen} onClick={onToggleInspector}>
        <SidebarIcon className="icon" aria-hidden="true" mirrored />
      </IconButton>
      <PlateButton kbd="⌘↩" onClick={onPlate} disabled={blocker !== null} title={blocker ?? undefined}>
        {plate.label}
      </PlateButton>
    </>
  )
}

/** Reference screen: crop editor + framing, face and library controls. */
export default function SetupScreen() {
  const session = useSession().data
  const info = useAppInfo().data
  const days = useDays(session?.scan.status === 'complete').data
  const busy = useJobs((s) => s.activeJobId !== null)
  const scanError = useJobs((s) => s.scan.error)
  const inspectorOpen = useView((s) => s.inspectorOpen)
  const toggleInspector = useView((s) => s.toggleInspector)
  const [dragging, setDragging] = useState(false)
  const ref = session?.reference ?? null
  const draft = useCropDraft(ref?.aspect ?? 'free')
  const crop = draft.draft ?? ref?.crop ?? null
  const edits = useReferenceEdits(ref, crop, draft)
  const picks = usePickErrors(() => draft.setError(null))
  const models = useModelsBlock()
  const plate: SetupPlate = session ? setupPlate(session) : { action: 'scan', label: 'Scan library' }
  const scanBlock = session ? scanBlocker(session, busy, models) : 'Loading…'
  const blocker = plate.action === 'scan' ? scanBlock : null
  const scan = () => {
    if (!scanBlock) void startScan().catch(reportError)
  }
  const runPlate = () => {
    if (plate.action === 'scan') scan()
    else useView.getState().setStep(plate.action)
  }
  // No plate before there is a reference: the one real action is choosing the photo (critique round 4).
  const empty = !ref || !crop || !info
  const arrival = useArrival(ref?.image.version ?? null)
  usePrimaryAction(blocker || empty ? null : runPlate)
  useSetupKeys(ref !== null && crop !== null && !busy, edits)

  if (!session) return null
  const tools = empty ? null : <SetupTools inspectorOpen={inspectorOpen} onToggleInspector={toggleInspector} plate={plate} blocker={blocker} onPlate={runPlate} />

  if (empty) {
    return (
      <Screen title={TITLE} subtitle={SUBTITLE} tools={tools}>
        <SetupEmpty
          folder={session.folder}
          recents={session.recents}
          disabled={busy}
          onChoosePhoto={() => picks.pick('photo', pickReferencePhoto())}
          onChooseFolder={() => picks.pick('folder', pickSourceFolder())}
          onRecentPhoto={(p) => picks.pick('photo', setReferencePhoto(p))}
          onRecentFolder={(p) => picks.pick('folder', setSourceFolder(p))}
          machine={thisMachine(info?.platform)}
          photoNotice={picks.notice('photo')}
          folderNotice={picks.notice('folder')}
        />
      </Screen>
    )
  }

  const stale = dragging || draft.draft !== null
  const stageStyle = { '--ar': `${ref.image.size.width} / ${ref.image.size.height}` } as CSSProperties
  return (
    <Screen title={TITLE} subtitle={SUBTITLE} tools={tools}>
      <div className="setup-work">
        <div className="setup-stage" style={stageStyle}>
          <CaptionLine image={ref.image} />
          <CropEditor
            reference={ref}
            imageUrl={referenceUrl(info.imageBaseUrl, ref.image.version, PRINT_CSS_WIDTH, window.devicePixelRatio)}
            crop={crop}
            aspect={ref.aspect}
            stale={stale}
            arrival={arrival}
            onDraft={draft.setDraft}
            onDragChange={(d) => {
              setDragging(d)
              // The newest draft, not this render's: the pointerup can beat the last move's render (H2).
              const latest = draft.latest()
              if (!d && latest) draft.schedule(latest)
            }}
          />
          <ReferenceReadouts
            reference={ref}
            error={draft.error}
            finding={draft.pending || stale}
            output={outputSize(session.render.resolution, Math.round(crop.width), Math.round(crop.height))}
            busy={busy}
            arrival={arrival}
            onChooseAnother={() => edits.run(pickReferencePhoto())}
          />
        </div>
        {inspectorOpen ? (
          <ReferenceInspector
            reference={ref}
            folder={session.folder}
            days={days}
            busy={busy}
            onAspect={edits.changeAspect}
            onLevel={edits.level}
            onCenter={edits.center}
            onReset={edits.reset}
            onChooseFolder={() => edits.run(pickSourceFolder())}
            onForget={forgetScanResults}
            scanState={{ status: session.scan.status, error: scanError?.message ?? null, again: plate.action !== 'scan' ? scan : null, blocked: scanBlock }}
          />
        ) : null}
      </div>
    </Screen>
  )
}
