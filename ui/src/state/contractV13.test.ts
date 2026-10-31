// Contract v1.3 (behaviour only): a superseded folder choice answers
// `cancelled` (silent), mutations can answer `busy` after the 2 s mutation
// gate (shown once, not stacked), and paths must be ones the user chose
// (`permissionDenied` otherwise, shown calmly with what to do instead).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { IpcError, SessionSnapshot } from '../ipc/contract'
import { call } from '../ipc/client'
import { installMockBackend, type MockOptions } from '../ipc/mock/install'
import { DEMO_FOLDER, REFERENCE_PATH } from '../ipc/mock/fixtures'
import { EMPTY_FOLDER, EXPORT_FOLDER, MOVIES } from '../ipc/mock/mockFs'
import { makeSession } from '../test/session'
import { act, screen, waitFor } from '@testing-library/react'
import { renderApp, resetStores } from '../test/renderApp'
import { addPhotoToDay, pickReferencePhoto, reportError, setReferencePhoto, setSourceFolder } from './actions'
import { startExportImages, startExportVideo } from './jobs'
import { queryClient, queryKeys } from './queries'
import { useView } from './view'

const GATE_BUSY: IpcError = { kind: 'busy', message: 'FaceTimelapse is still applying your previous change. Try again in a moment.' }

function setup(opts: Partial<MockOptions> = {}) {
  resetStores()
  useView.setState({ toasts: [] })
  return installMockBackend({ scenario: 'aligned', speed: 'instant', ...opts })
}

beforeEach(() => {
  useView.setState({ toasts: [] })
})
afterEach(() => {
  delete window.__FT_MOCK__
})

const toasts = () => useView.getState().toasts
const rejection = async (p: Promise<unknown>): Promise<IpcError> => p.then(() => ({ kind: 'internal', message: 'resolved' }) as IpcError, (e: IpcError) => e)

describe('cancelled: a newer folder choice replaced this one', () => {
  it('is silent: no toast, no error, and the session is re-read to show the newest choice', async () => {
    setup({ fail: { set_source_folder: 'cancelled' } })
    await queryClient.fetchQuery({ queryKey: queryKeys.session, queryFn: () => call('get_session') })
    await expect(setSourceFolder(DEMO_FOLDER)).resolves.toBeNull()
    expect(toasts()).toEqual([])
    expect(queryClient.getQueryState(queryKeys.session)?.isInvalidated).toBe(true)
  })

  // UI review 2, M4: silence is per command now; reportError itself shows a cancellation like any error.
  it('reportError shows a cancellation that no command handled', () => {
    reportError({ kind: 'cancelled', message: 'The task was cancelled.' })
    expect(toasts()).toEqual([expect.objectContaining({ tone: 'stop' })])
  })
})

describe('cancelled through the UI', () => {
  it('a superseded folder drop shows nothing, and the next choice lands', async () => {
    const { backend } = await renderApp({ scenario: 'fresh', strictGrants: true, fail: { set_source_folder: 'cancelled' } })
    await act(async () => {
      await window.__FT_MOCK__?.emitDragDrop([DEMO_FOLDER])
    })
    expect(toasts()).toEqual([])
    expect(screen.queryByRole('alert')).toBeNull()
    backend.configure({ fail: {} })
    await act(async () => {
      await window.__FT_MOCK__?.emitDragDrop([DEMO_FOLDER])
    })
    await waitFor(() => expect(queryClient.getQueryData<SessionSnapshot>(queryKeys.session)?.folder?.path).toBe(DEMO_FOLDER))
    expect(toasts()).toEqual([])
  })
})

describe('busy from the mutation gate', () => {
  it('shows the message like any busy toast, once, however many changes bounce', () => {
    for (let i = 0; i < 6; i++) reportError(GATE_BUSY)
    expect(toasts().map((t) => t.message)).toEqual([GATE_BUSY.message])
  })

  it('a repeated toast restarts its time on screen (newest id) instead of stacking', () => {
    const first = useView.getState().pushToast({ message: 'Same', tone: 'stop' })
    const second = useView.getState().pushToast({ message: 'Same', tone: 'stop' })
    expect(toasts()).toHaveLength(1)
    expect(toasts()[0]?.id).toBe(second)
    expect(second).not.toBe(first)
  })
})

describe('path grants (permissionDenied)', () => {
  it('a path the user didn’t choose is refused, with what to do instead (reference)', async () => {
    setup({ scenario: 'fresh', strictGrants: true })
    const e = await rejection(setReferencePhoto('/Users/demo/Pictures/Reference/IMG_20140817_101500.jpg'))
    expect(e.kind).toBe('permissionDenied')
    expect(e.message).toMatch(/Choose photo… or drop it onto the window/)
  })

  it('folders, hand-added photos and exports explain their own way in', async () => {
    setup({ scenario: 'aligned', strictGrants: true })
    expect((await rejection(setSourceFolder(EMPTY_FOLDER))).message).toMatch(/Choose folder… or drop it onto the window/)
    expect((await rejection(addPhotoToDay('2014-05-02', '/Users/demo/Pictures/Extras/IMG_20150704_101532.jpg'))).message).toMatch(/Add a photo to this day…/)
    const video = makeSession('aligned').video
    expect((await rejection(startExportVideo(`${MOVIES}/Untitled.mp4`, video))).message).toMatch(/Export… and choose where to save/)
    expect((await rejection(startExportImages(EXPORT_FOLDER, { format: 'png', jpegQuality: 95, overwrite: false }))).message).toMatch(
      /Export… and choose where to save/,
    )
  })

  it('an OS permission problem keeps the system’s own advice', async () => {
    setup({ scenario: 'aligned', strictGrants: true, fail: { set_source_folder: 'permissionDenied' } })
    const e = await rejection(setSourceFolder(DEMO_FOLDER))
    expect(e.message).toMatch(/System Settings/)
  })

  it('dialog results, drops and the session’s own paths pass byte-for-byte', async () => {
    const backend = setup({ scenario: 'fresh', strictGrants: true })
    const picked = await pickReferencePhoto()
    expect(picked?.image.path).toBe(REFERENCE_PATH)
    await window.__FT_MOCK__?.emitDragDrop(['/Users/demo/Pictures/Daily selfies'])
    await expect(setSourceFolder(DEMO_FOLDER)).resolves.toMatchObject({ path: DEMO_FOLDER })
    // A recent (session) path keeps working without a new dialog.
    backend.loadScenario('ready')
    const session = await call('get_session')
    await expect(setReferencePhoto((session as SessionSnapshot).reference?.image.path ?? '')).resolves.toBeTruthy()
  })

  it('a trimmed or normalised variant of a chosen path is not the chosen path', async () => {
    setup({ scenario: 'aligned', strictGrants: true })
    const images = { format: 'png' as const, jpegQuality: 95, overwrite: false }
    const dir = await call('pick_export_folder')
    expect((await rejection(startExportImages(`${dir}/`, images))).kind).toBe('permissionDenied')
    const video = await call('pick_video_path', { suggestedName: 'FaceTimelapse 2012–2022.mp4' })
    expect((await rejection(startExportVideo(` ${video}`, makeSession('aligned').video))).kind).toBe('permissionDenied')
  })
})
