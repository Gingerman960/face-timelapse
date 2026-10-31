// Critique round 6, P1-2: before its list loaded, Review said there was nothing
// to review and left Continue enabled over an empty canvas.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import type { PhotoSummary } from '../../ipc/contract'
import { renderApp } from '../../test/renderApp'
import { queryClient, queryKeys } from '../../state/queries'
import { useView } from '../../state/view'

const mod = { metaKey: true, ctrlKey: true }

afterEach(() => {
  vi.restoreAllMocks()
  delete window.__FT_MOCK__
})

/** Opens Review with its list on the way: `get_photos` waits until `release` is called. */
async function reviewWhileLoading() {
  const { backend } = await renderApp({ scenario: 'scanned' })
  let release: () => void = () => undefined
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const handle = backend.handle.bind(backend)
  vi.spyOn(backend, 'handle').mockImplementation(async (cmd, payload) => {
    if (cmd === 'get_photos') await held
    return handle(cmd, payload)
  })
  queryClient.removeQueries({ queryKey: queryKeys.photos(['uncertain']) })
  fireEvent.keyDown(window, { key: '3', ...mod })
  // Review's code may still be on its way under a loaded test run: a generous wait, not a fixed delay.
  await screen.findByText('Gathering the unsure photos…', undefined, { timeout: 5000 })
  return { release: () => act(async () => release()) }
}

describe('Review while its list loads', () => {
  it('says it is gathering, never that there is nothing to review', async () => {
    await reviewWhileLoading()
    expect(screen.queryByText('No photos the scan wasn’t sure about')).toBeNull()
    expect(screen.queryByRole('heading', { name: 'All looked at' })).toBeNull()
    expect(document.querySelector('.screen[data-screen="Review"]')).toHaveAttribute('aria-busy', 'true')
    expect(document.querySelectorAll('.review-loading .q-latent').length).toBeGreaterThan(0)
  })

  it('holds Continue (button and ⌘↩) until the list is known', async () => {
    const { release } = await reviewWhileLoading()
    expect(screen.getByRole('button', { name: /^Continue to Days/ })).toBeDisabled()
    fireEvent.keyDown(window, { key: 'Enter', ...mod })
    expect(useView.getState().step).toBe('review')

    await release()
    await screen.findByRole('button', { name: 'Keep' })
    const list = queryClient.getQueryData<PhotoSummary[]>(queryKeys.photos(['uncertain'])) ?? []
    expect(await screen.findByText(new RegExp(`the scan wasn’t sure about$`))).toHaveTextContent(String(list.length))
    await waitFor(() => expect(document.querySelector('.screen[data-screen="Review"]')).not.toHaveAttribute('aria-busy'))
  })
})
