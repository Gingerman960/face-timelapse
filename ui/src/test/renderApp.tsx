import { render, screen, waitFor, type RenderResult } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { App } from '../App'
import { installMockBackend, type MockOptions } from '../ipc/mock/install'
import { queryClient } from '../state/queries'
import { useJobs } from '../state/jobs'
import { usePlayer } from '../state/player'
import { resetVideoDraft } from '../state/videoDraft'
import { useView } from '../state/view'

const viewInitial = useView.getState()
const jobsInitial = useJobs.getState()
const playerInitial = usePlayer.getState()

/** Resets every store and the query cache between tests. */
export function resetStores(): void {
  queryClient.clear()
  useView.setState(viewInitial, true)
  useJobs.setState(jobsInitial, true)
  usePlayer.setState(playerInitial, true)
  resetVideoDraft()
}

/** Renders the real App against the fake backend and waits for the first screen. */
export async function renderApp(opts: Partial<MockOptions> = {}): Promise<RenderResult & { backend: ReturnType<typeof installMockBackend> }> {
  resetStores()
  const backend = installMockBackend({ scenario: 'aligned', speed: 'instant', ...opts })
  const result = render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
  )
  await screen.findByRole('navigation', { name: 'Project' })
  await screen.findByRole('heading', { level: 1 })
  await waitScreenReady()
  return { ...result, backend }
}

/** Waits until the current screen's lazy code and data have loaded. */
export async function waitScreenReady(): Promise<void> {
  await waitFor(() => {
    if (document.querySelector('.screen[aria-busy="true"]')) throw new Error('screen still loading')
    if (!document.querySelector('.screen')) throw new Error('no screen yet')
  })
}
