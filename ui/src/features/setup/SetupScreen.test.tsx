import { describe, expect, it, vi, type MockInstance } from 'vitest'
import { act, fireEvent, renderHook, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { SessionSnapshot } from '../../ipc/contract'
import { DEFAULT_MESSAGES } from '../../ipc/mock/errors'
import { MODELS_MISSING } from '../../state/models'
import { renderApp } from '../../test/renderApp'
import { stubLayout } from '../../test/layout'
import { resetSession, setReferenceCrop, setReferenceRotation } from '../../state/actions'
import { queryClient, queryKeys } from '../../state/queries'
import { levelRotation, scanBlocker } from './setupModel'
import { makeSession } from '../../test/session'
import { resetArrival, useArrival } from './useArrival'

const session = () => queryClient.getQueryData<SessionSnapshot>(queryKeys.session) as SessionSnapshot
const title = () => screen.getByRole('heading', { level: 1 })
const cropGroup = () => screen.getByRole('group', { name: /^Crop / })
const mod = { metaKey: true, ctrlKey: true }
/** Longer than the crop commit delay (150 ms), so a pending commit would have fired. */
const COMMIT_WINDOW_MS = 400
/** A tilt the eyes visibly show (well past the 0.3° that reads as level). */
const TILT_DEG = 5
/** Commands the fake backend received through a `handle` spy. */
const commandsOf = (spy: MockInstance<(cmd: string, payload?: unknown) => Promise<unknown>>) => spy.mock.calls.map(([cmd]) => cmd)

describe('scanBlocker', () => {
  it('names the first thing missing before a scan', () => {
    const ready = makeSession('ready')
    expect(scanBlocker(ready, true)).toMatch(/^Another task is running/)
    expect(scanBlocker(makeSession('fresh'), false)).toBe('Choose a reference photo first.')
    expect(scanBlocker({ ...ready, reference: { ...ready.reference!, detection: null } }, false)).toBe('No face inside the crop yet.')
    expect(scanBlocker({ ...ready, folder: null }, false)).toBe('Choose a source folder first.')
    expect(scanBlocker(ready, false)).toBeNull()
  })
})

describe('levelRotation', () => {
  it('offers the auto rotation only for a visible tilt', () => {
    expect(levelRotation({ rotationDeg: 0, autoRotationDeg: null })).toBeNull()
    expect(levelRotation({ rotationDeg: 0, autoRotationDeg: -0.2 })).toBeNull()
    expect(levelRotation({ rotationDeg: 0, autoRotationDeg: -0.4 })).toBe(-0.4)
    expect(levelRotation({ rotationDeg: 5, autoRotationDeg: 5.2 })).toBeNull()
    expect(levelRotation({ rotationDeg: 0, autoRotationDeg: -5.4 })).toBe(-5.4)
  })
})

/** Tilts the reference so its eyes are visibly off level (the fixture's −0.2° reads as level). */
async function tiltReference(): Promise<number> {
  await act(async () => {
    await setReferenceRotation(TILT_DEG)
  })
  await screen.findByText('Tilted')
  return session().reference?.image.autoRotationDeg ?? 0
}

describe('Reference screen', () => {
  it('L levels the eyes, R resets the crop and C centres the face', async () => {
    // Arrange
    await renderApp({ scenario: 'ready' })
    const auto = await tiltReference()

    // Act + Assert
    fireEvent.keyDown(window, { key: 'l' })
    await waitFor(() => expect(session().reference?.image.rotationDeg).toBe(auto))
    // Words in the UI face, the figure in the data face (critique round 5, P3-21).
    expect(await screen.findByText((_, el) => el?.classList.contains('caption-rotated') === true && el.textContent === `rotated ${auto.toFixed(1)}°`)).toBeInTheDocument()

    await act(async () => {
      await setReferenceCrop({ x: 0, y: 0, width: 1500, height: 2000 }, '3:4')
    })
    fireEvent.keyDown(window, { key: 'C' })
    await waitFor(() => expect(session().reference?.crop.x).not.toBe(0))

    fireEvent.keyDown(window, { key: 'R' })
    await waitFor(() => expect(session().reference?.crop.height).toBeGreaterThan(2300))
    const reset = session().reference?.crop
    expect((reset?.width ?? 0) / (reset?.height ?? 1)).toBeCloseTo(3 / 4, 2)
  })

  // Regression (H6): a rotation re-renders the reference and stales every aligned frame, so L must not rotate eyes that read as level.
  it('L leaves level eyes and the crop alone', async () => {
    // Arrange: the fixture's eyes are 0.4° off, which reads as level.
    const { backend } = await renderApp({ scenario: 'ready' })
    expect(await screen.findByText('Eyes level')).toBeInTheDocument()
    const crop = { x: 0, y: 0, width: 1500, height: 2000 }
    await act(async () => {
      await setReferenceCrop(crop, '3:4')
    })
    const handle = vi.spyOn(backend, 'handle')

    // Act
    fireEvent.keyDown(window, { key: 'L' })
    await act(async () => {
      await Promise.resolve()
    })

    // Assert
    expect(commandsOf(handle)).not.toContain('set_reference_rotation')
    expect(session().reference?.crop).toEqual(crop)
  })

  // v1.4: the backend carries the crop through a rotation, so L commits a pending
  // nudge first (on the canvas it was measured on) instead of losing it (was L7).
  it('L commits a pending nudge, then levels the eyes with the nudged crop', async () => {
    // Arrange
    const { backend } = await renderApp({ scenario: 'ready' })
    const auto = await tiltReference()
    const before = session().reference?.crop as NonNullable<SessionSnapshot['reference']>['crop']
    const handle = vi.spyOn(backend, 'handle')

    // Act
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    fireEvent.keyDown(window, { key: 'l' })
    await waitFor(() => expect(session().reference?.image.rotationDeg).toBe(auto))
    const rotated = session().reference?.crop
    await act(() => new Promise((resolve) => window.setTimeout(resolve, COMMIT_WINDOW_MS)))

    // Assert: one crop commit (the nudge, 1 px right), then the rotation, and nothing late.
    const edits = handle.mock.calls.filter(([cmd]) => cmd === 'set_reference_crop' || cmd === 'set_reference_rotation')
    expect(edits.map(([cmd]) => cmd)).toEqual(['set_reference_crop', 'set_reference_rotation'])
    const nudged = (edits[0]?.[1] as { crop: typeof before }).crop
    expect(nudged).toMatchObject({ width: before.width, height: before.height })
    expect(Math.abs(nudged.x - (before.x + 1))).toBeLessThan(1)
    expect(Math.abs(nudged.y - before.y)).toBeLessThan(1)
    expect(session().reference?.crop).toEqual(rotated)
  })

  it('L does not rotate when the pending nudge fails to commit, and keeps its error', async () => {
    // Arrange
    const { backend } = await renderApp({ scenario: 'ready' })
    await tiltReference()
    const handle = vi.spyOn(backend, 'handle')
    backend.configure({ fail: { set_reference_crop: 'io' } })

    // Act
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    fireEvent.keyDown(window, { key: 'l' })

    // Assert
    expect(await screen.findByRole('alert')).toHaveTextContent(DEFAULT_MESSAGES.io)
    expect(commandsOf(handle)).not.toContain('set_reference_rotation')
  })

  it('the face buttons and aspect tiles commit through the inspector', async () => {
    // Arrange
    await renderApp({ scenario: 'ready' })
    const inspector = within(screen.getByRole('complementary', { name: 'Reference settings' }))

    // Act
    await userEvent.click(inspector.getByRole('button', { name: /Reset crop/ }))
    await waitFor(() => expect(session().reference?.crop.height).toBe(session().reference?.image.size.height))
    await userEvent.click(inspector.getByRole('button', { name: /Centre the face/ }))
    await userEvent.click(inspector.getByRole('radio', { name: '16:9' }))

    // Assert
    await waitFor(() => expect(session().reference?.aspect).toBe('16:9'))
    expect(await screen.findByText((_, el) => el?.classList.contains('meta') === true && el.textContent === 'Face found · 5 points')).toBeInTheDocument()
    expect(screen.getByText(/^Output$/)).toBeInTheDocument()
  })

  it('dragging the crop shows a pending state, then commits after a short pause', async () => {
    // Arrange
    stubLayout()
    await renderApp({ scenario: 'ready' })
    const x0 = session().reference?.crop.x ?? 0

    // Act
    fireEvent.pointerDown(cropGroup(), { button: 0, pointerId: 1, clientX: 600, clientY: 400 })
    fireEvent.pointerMove(cropGroup(), { pointerId: 1, clientX: 630, clientY: 400 })

    // Assert
    expect(screen.getByText('Finding your face…').closest('[role="status"]')).not.toBeNull()

    // Act
    fireEvent.pointerUp(cropGroup(), { pointerId: 1 })

    // Assert
    await waitFor(() => expect(session().reference?.crop.x).toBe(x0 + 80))
    await waitFor(() => expect(screen.queryByText('Finding your face…')).toBeNull())
  })

  it('a failing crop change shows an inline notice', async () => {
    // Arrange
    await renderApp({ scenario: 'ready', fail: { set_reference_crop: 'io' } })

    // Act
    fireEvent.keyDown(window, { key: 'r' })

    // Assert
    const notice = await screen.findByRole('alert')
    expect(notice).toHaveTextContent("That didn't work.")
    expect(notice).toHaveTextContent(DEFAULT_MESSAGES.io)
  })

  it('a failing rotation shows an inline notice', async () => {
    // Arrange
    const { backend } = await renderApp({ scenario: 'ready' })
    await tiltReference()
    backend.configure({ fail: { set_reference_rotation: 'decodeFailed' } })

    // Act
    fireEvent.keyDown(window, { key: 'L' })

    // Assert
    expect(await screen.findByRole('alert')).toHaveTextContent(DEFAULT_MESSAGES.decodeFailed)
  })

  it('ignores shortcut keys with modifiers', async () => {
    // Arrange
    await renderApp({ scenario: 'ready' })
    const before = session().reference

    // Act
    fireEvent.keyDown(window, { key: 'r', altKey: true })
    fireEvent.keyDown(window, { key: 'ArrowLeft', ...mod })

    // Assert
    expect(session().reference).toEqual(before)
  })

  it('the inspector can be hidden', async () => {
    // Arrange
    await renderApp({ scenario: 'ready' })

    // Act
    await userEvent.click(screen.getByRole('button', { name: 'Toggle inspector', pressed: true }))

    // Assert
    expect(screen.queryByRole('complementary', { name: 'Reference settings' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Toggle inspector', pressed: false }))
    expect(screen.getByRole('complementary', { name: 'Reference settings' })).toBeInTheDocument()
  })

  it('has no inspector toggle before there is a reference (nothing to show)', async () => {
    // Arrange + Act
    await renderApp({ scenario: 'fresh' })

    // Assert
    expect(screen.getByRole('heading', { name: 'Start with one photo of your face' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Toggle inspector' })).toBeNull()
  })

  it('forgets earlier scan results after confirming', async () => {
    // Arrange
    await renderApp({ scenario: 'ready' })
    await userEvent.click(screen.getByRole('button', { name: /Forget earlier scan results/ }))

    // Act
    await userEvent.click(screen.getByRole('button', { name: 'Forget' }))

    // Assert
    await waitFor(() => expect(session().folder?.analyzedCount).toBe(0))
    await waitFor(() => expect(screen.getByRole('button', { name: /Forget earlier scan results/ })).toBeDisabled())
  })

  it('a failing forget is reported as a toast', async () => {
    // Arrange
    await renderApp({ scenario: 'ready', fail: { clear_scan_cache: 'permissionDenied' } })
    await userEvent.click(screen.getByRole('button', { name: /Forget earlier scan results/ }))

    // Act
    await userEvent.click(screen.getByRole('button', { name: 'Forget' }))

    // Assert
    expect(await screen.findByText(DEFAULT_MESSAGES.permissionDenied)).toBeInTheDocument()
  })

  it('choosing another folder from the inspector updates the library card', async () => {
    // Arrange
    await renderApp({ scenario: 'ready' })

    // Act
    await userEvent.click(screen.getByRole('button', { name: 'Choose another folder' }))

    // Assert
    await waitFor(() => expect(session().folder?.name).toBe('Daily selfies'))
    const inspector = within(screen.getByRole('complementary', { name: 'Reference settings' }))
    expect(inspector.getByText('Daily selfies')).toBeInTheDocument()
  })

  it('⌘↩ starts the scan', async () => {
    // Arrange
    await renderApp({ scenario: 'ready' })

    // Act
    fireEvent.keyDown(window, { key: 'Enter', ...mod })

    // Assert
    await waitFor(() => expect(title()).toHaveTextContent('Review'), { timeout: 5000 })
  })

  it('a scan that cannot start is reported as a toast', async () => {
    // Arrange
    await renderApp({ scenario: 'ready', fail: { start_scan: 'modelUnavailable' } })

    // Act
    await userEvent.click(screen.getByRole('button', { name: /^Scan library/ }))

    // Assert
    expect(await screen.findByText(MODELS_MISSING)).toBeInTheDocument()
    expect(title()).toHaveTextContent('Reference')
  })

  it('a reference without a face offers another photo', async () => {
    // Arrange
    await renderApp({ scenario: 'ready' })
    await act(async () => {
      await setReferenceCrop({ x: 0, y: 0, width: 600, height: 800 }, '3:4')
    })

    // Act
    await userEvent.click(await screen.findByRole('button', { name: 'Choose another photo…' }))

    // Assert
    await waitFor(() => expect(session().reference?.detection).not.toBeNull())
    expect(await screen.findByText((_, el) => el?.classList.contains('meta') === true && el.textContent === 'Face found · 5 points')).toBeInTheDocument()
  })

  it('after a reset, recent photos and folders can be reused', async () => {
    // Arrange
    await renderApp({ scenario: 'aligned' })
    await act(async () => {
      await resetSession()
    })
    await waitFor(() => expect(title()).toHaveTextContent('Reference'))

    // Act
    await userEvent.click(await screen.findByRole('button', { name: /^Daily selfies/ }))
    await waitFor(() => expect(session().folder).not.toBeNull())
    await userEvent.click(screen.getByRole('button', { name: /^IMG_20140815_142326\.jpg/ }))

    // Assert
    expect(await screen.findByRole('group', { name: /^Crop/ })).toBeInTheDocument()
  })

  // Regression: first-run pick errors used to go to the crop editor's error slot and never showed.
  it('a failing photo pick on first run is reported', async () => {
    await renderApp({ scenario: 'fresh', fail: { pick_reference_photo: 'permissionDenied' } })
    await userEvent.click(screen.getByRole('button', { name: /Choose photo/ }))
    expect(await screen.findByText(DEFAULT_MESSAGES.permissionDenied)).toBeInTheDocument()
  })
})

// Critique round 4: P2-11 (the plate is the next step), P2-12 (first run), P2-20 (a stopped scan stays said).
describe('Reference after the scan, and on first run', () => {
  it('first run has no plate: choosing the photo is the one action', async () => {
    await renderApp({ scenario: 'fresh' })
    expect(screen.getByRole('heading', { name: 'Start with one photo of your face' })).toBeInTheDocument()
    expect(screen.getByText(/^Each day’s photo is lined up to this one\./)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Scan library/ })).toBeNull()
  })

  it('with every photo read, the plate goes on to Review, and Scan again stays in the inspector', async () => {
    // Arrange
    await renderApp({ scenario: 'scanned' })
    fireEvent.keyDown(window, { key: '1', ...mod })
    await waitFor(() => expect(title()).toHaveTextContent('Reference'))
    const pending = session().counts.reviewPending
    expect(screen.getByRole('button', { name: new RegExp(`^Review ${pending} unsure`) })).toBeInTheDocument()
    expect(within(screen.getByRole('complementary', { name: 'Reference settings' })).getByRole('button', { name: 'Scan again' })).toBeEnabled()

    // Act
    fireEvent.keyDown(window, { key: 'Enter', ...mod })

    // Assert
    await waitFor(() => expect(title()).toHaveTextContent('Review'))
  })

  it('a stopped scan says where it stopped under the library facts', async () => {
    await renderApp({ scenario: 'aligned' })
    act(() => {
      queryClient.setQueryData<SessionSnapshot>(queryKeys.session, (s) => (s ? { ...s, scan: { ...s.scan, status: 'partial' } } : s))
    })
    fireEvent.keyDown(window, { key: '1', ...mod })
    await waitFor(() => expect(title()).toHaveTextContent('Reference'))
    const inspector = within(screen.getByRole('complementary', { name: 'Reference settings' }))
    expect(inspector.getByText(/^Stopped at [\d,]+ of [\d,]+\.$/)).toBeInTheDocument()
    expect(inspector.getByText('The next scan continues from here.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Resume scan/ })).toBeInTheDocument()
  })
})

// Signature moment 6: the first photo lands — the print develops, the template draws, "Face found" is ticked.
describe('the first photo lands', () => {
  it('marks an arrival when the first reference appears, but not when coming back to it', async () => {
    // Arrange: first run, no reference on screen.
    resetArrival()
    const { backend } = await renderApp({ scenario: 'fresh' })
    expect(document.querySelector('.crop-host')).toBeNull()

    // Act: the first photo is chosen.
    await userEvent.click(screen.getByRole('button', { name: /^Choose photo/ }))

    // Assert
    await waitFor(() => expect(document.querySelector('.crop-host')).toHaveAttribute('data-arrival', 'true'))
    expect(backend.current.reference).not.toBeNull()
  })

  it('a reference already there when the screen mounts (a restored session, a return visit) is no arrival', () => {
    resetArrival()
    const first = renderHook(({ v }) => useArrival(v), { initialProps: { v: 'v1' as string | null } })
    expect(first.result.current).toBe(false)
    first.unmount()
    const again = renderHook(({ v }) => useArrival(v), { initialProps: { v: 'v1' as string | null } })
    expect(again.result.current).toBe(false)
    // A new pick while on screen is.
    again.rerender({ v: 'v2' })
    expect(again.result.current).toBe(true)
  })
})
