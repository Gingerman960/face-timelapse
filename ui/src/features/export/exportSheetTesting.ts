// Shared by the export sheet's tests: open the sheet over the aligned scenario and find its parts.
import { fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { FramesView, SessionSnapshot } from '../../ipc/contract'
import type { MockOptions } from '../../ipc/mock/install'
import { renderApp } from '../../test/renderApp'
import { queryClient, queryKeys } from '../../state/queries'

type Queries = ReturnType<typeof within>

/** ⌘ (and Ctrl, for the tests' platform-neutral key handling). */
export const mod = { metaKey: true, ctrlKey: true }

/** Renders the app on the aligned timelapse and opens the export sheet with E. */
export async function openSheet(opts: Partial<MockOptions> = {}) {
  const app = await renderApp({ scenario: 'aligned', ...opts })
  await screen.findByRole('toolbar', { name: 'Playback' })
  fireEvent.keyDown(window, { key: 'e' })
  const sheet = await screen.findByRole('dialog', { name: 'Export timelapse' })
  const frames = queryClient.getQueryData<FramesView>(queryKeys.frames)?.frames ?? []
  const session = queryClient.getQueryData<SessionSnapshot>(queryKeys.session) as SessionSnapshot
  return { ...app, sheet, frames, session, ui: within(sheet) }
}

export const exportButton = (ui: Queries) => ui.getByRole('button', { name: /^Export…/ })
/** A paragraph by its whole text (data lines set their values in their own spans). */
export const line = (ui: Queries, re: RegExp) => ui.getByText((_: string, el: Element | null) => el?.tagName === 'P' && re.test(el.textContent ?? ''))
export const field = (ui: Queries, name: string) => ui.getByRole('textbox', { name })
/** A fact under the preview by its label (critique round 4, item 25: the footer's spec moved there). */
export const fact = (ui: Queries, label: string) => {
  const term = ui.getAllByText(label).find((el: HTMLElement) => el.tagName === 'DT')
  return term?.nextElementSibling as HTMLElement
}
/** Every fact under the preview as "Label value", in order. */
export const facts = (sheet: HTMLElement) =>
  [...sheet.querySelectorAll('.export-facts > div')].map((row) => `${row.querySelector('dt')?.textContent} ${row.querySelector('dd')?.textContent}`)
/** The lead of the saved phase: "Saved · 2:59.6 · 534 MB". */
export const savedLead = (sheet: HTMLElement) => sheet.querySelector('.saved-lead')

/** Unfolds Between days, Hold and Quality (critique round 2). */
export async function moreOptions(ui: Queries): Promise<void> {
  const toggle = ui.getByRole('button', { name: /^More options/ })
  if (toggle.getAttribute('aria-expanded') !== 'true') await userEvent.click(toggle)
}

export async function commit(input: HTMLElement, text: string): Promise<void> {
  await userEvent.clear(input)
  await userEvent.type(input, `${text}{Enter}`)
}
