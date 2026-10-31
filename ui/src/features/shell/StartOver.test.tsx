// L8 (UI review #1): reset_session is reachable through a deliberate,
// confirmed "Start a new timelapse…" action in the sidebar's project header.
import { afterEach, describe, expect, it } from 'vitest'
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { FramesView, SessionSnapshot } from '../../ipc/contract'
import { renderApp } from '../../test/renderApp'
import { queryClient, queryKeys } from '../../state/queries'
import { useJobs } from '../../state/jobs'
import { useView } from '../../state/view'

const session = () => queryClient.getQueryData<SessionSnapshot>(queryKeys.session)

afterEach(() => {
  delete window.__FT_MOCK__
})

describe('Start a new timelapse', () => {
  it('asks first; Cancel changes nothing', async () => {
    await renderApp({ scenario: 'aligned' })
    await userEvent.click(screen.getByRole('button', { name: 'Project options' }))
    const dialog = screen.getByRole('dialog', { name: 'Start a new timelapse?' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog', { name: 'Start a new timelapse?' })).toBeNull()
    expect(session()?.reference).not.toBeNull()
  })

  it('confirmed, it clears the session, drops library caches and opens the empty Reference screen', async () => {
    await renderApp({ scenario: 'aligned' })
    useView.setState({ activeDay: '2014-05-02' })
    await userEvent.click(screen.getByRole('button', { name: 'Project options' }))
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Start a new timelapse?' })).getByRole('button', { name: 'Start over' }))
    await waitFor(() => expect(session()?.reference).toBeNull())
    expect(session()?.folder).toBeNull()
    // Mounted screens may re-read right away; whatever is cached now belongs to the empty session.
    expect(queryClient.getQueryData<FramesView>(queryKeys.frames)?.frames ?? []).toEqual([])
    expect(useView.getState()).toMatchObject({ step: 'setup', activeDay: null })
    expect(await screen.findByRole('heading', { name: 'Start with one photo of your face' })).toBeInTheDocument()
  })

  it('is not offered on a session that is already empty', async () => {
    await renderApp({ scenario: 'fresh' })
    expect(screen.queryByRole('button', { name: 'Project options' })).toBeNull()
  })

  it('is disabled while a job runs', async () => {
    await renderApp({ scenario: 'aligned' })
    act(() => useJobs.setState({ activeJobId: 'job-1', activeKind: 'exportVideo' }))
    expect(screen.getByRole('button', { name: 'Project options' })).toBeDisabled()
    act(() => useJobs.setState({ activeJobId: null, activeKind: null }))
  })
})
