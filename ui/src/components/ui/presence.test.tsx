// Critique round 4 (P1-3): sheets, popovers and toasts leave with a short exit
// instead of vanishing. These are the primitives they share.
import { useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { afterExit, durationToken, exitDuration, playExit, useExit, usePresence, usePresenceList } from './presence'
import { installFakeAnimations, removeFakeAnimations } from './fakeAnimations'

afterEach(() => {
  removeFakeAnimations()
})

function Box({ open }: { open: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const { mounted, leaving, done } = usePresence(open)
  useExit(leaving, [{ ref, kind: 'popover' }], done)
  return mounted ? (
    <div ref={ref} role="dialog" aria-label="Box" inert={leaving} data-leaving={leaving || undefined}>
      Box
    </div>
  ) : null
}

describe('usePresence + useExit', () => {
  it('unmounts at once where the browser cannot animate (jsdom)', () => {
    const { rerender } = render(<Box open />)
    rerender(<Box open={false} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('keeps a closing element mounted and inert until its exit has finished', async () => {
    // Arrange
    const fake = installFakeAnimations()
    const { rerender } = render(<Box open />)

    // Act
    rerender(<Box open={false} />)

    // Assert: still there, inert, fading on --ease-in.
    const box = screen.getByText('Box')
    expect(box).toHaveAttribute('inert')
    expect(box).toHaveAttribute('data-leaving', 'true')
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]?.keyframes).toEqual([{ opacity: 0 }])
    expect(fake.calls[0]?.options).toMatchObject({ duration: 100, fill: 'forwards' })

    // Act
    await act(async () => fake.finishAll())

    // Assert
    expect(screen.queryByText('Box')).toBeNull()
  })

  it('opening again while it leaves cancels the exit and keeps the same element', async () => {
    const fake = installFakeAnimations()
    const { rerender } = render(<Box open />)
    rerender(<Box open={false} />)
    const box = screen.getByText('Box')

    rerender(<Box open />)

    expect(fake.animations[0]?.cancel).toHaveBeenCalled()
    expect(screen.getByText('Box')).toBe(box)
    expect(box).not.toHaveAttribute('inert')
    await act(async () => fake.finishAll())
    expect(screen.getByText('Box')).toBeInTheDocument()
  })

  it('gives up waiting after the exit time and a grace (a hidden window may hold animations)', () => {
    vi.useFakeTimers()
    try {
      installFakeAnimations()
      const { rerender } = render(<Box open />)
      rerender(<Box open={false} />)
      expect(screen.getByText('Box')).toBeInTheDocument()
      act(() => {
        vi.advanceTimersByTime(exitDuration('popover') + 200)
      })
      expect(screen.queryByText('Box')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('playExit', () => {
  it('slides and fades a sheet out, and only fades under reduced motion', () => {
    const fake = installFakeAnimations()
    const el = document.createElement('div')
    playExit(el, 'sheet')
    playExit(el, 'toast')
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList)
    playExit(el, 'sheet')
    expect(fake.calls.map((c) => c.keyframes)).toEqual([
      [{ opacity: 0, transform: 'translateY(-10px) scale(0.985)' }],
      [{ opacity: 0, transform: 'translateY(6px) scale(0.98)' }],
      [{ opacity: 0 }],
    ])
    expect(fake.calls.map((c) => c.options.duration)).toEqual([200, 150, 200])
  })

  it('does nothing where the browser cannot animate', () => {
    expect(playExit(document.createElement('div'), 'toast')).toBeNull()
  })
})

describe('motion tokens', () => {
  it('reads durations in ms or s from :root, else the fallback', () => {
    document.documentElement.style.setProperty('--dur-test-ms', '240ms')
    document.documentElement.style.setProperty('--dur-test-s', '0.3s')
    expect(durationToken('--dur-test-ms', 1)).toBe(240)
    expect(durationToken('--dur-test-s', 1)).toBe(300)
    expect(durationToken('--dur-missing', 77)).toBe(77)
    document.documentElement.style.removeProperty('--dur-test-ms')
    document.documentElement.style.removeProperty('--dur-test-s')
  })
})

describe('afterExit', () => {
  it('calls done once, when every animation has finished', async () => {
    const fake = installFakeAnimations()
    const a = document.createElement('div').animate([{ opacity: 0 }], 10)
    const b = document.createElement('div').animate([{ opacity: 0 }], 10)
    const done = vi.fn()
    afterExit([a, b], 10, done)
    fake.animations[0]?.resolve()
    await Promise.resolve()
    expect(done).not.toHaveBeenCalled()
    await act(async () => fake.finishAll())
    expect(done).toHaveBeenCalledOnce()
  })

  it('its cancel stops the animations and never calls done', async () => {
    const fake = installFakeAnimations()
    const a = document.createElement('div').animate([{ opacity: 0 }], 10)
    const done = vi.fn()
    const cancel = afterExit([a], 10, done)
    cancel()
    await act(async () => fake.finishAll())
    expect(fake.animations[0]?.cancel).toHaveBeenCalled()
    expect(done).not.toHaveBeenCalled()
  })
})

interface Item {
  id: number
  text: string
}
const keyOf = (item: Item) => item.id

function List({ items, same }: { items: readonly Item[]; same?: (gone: Item, now: readonly Item[]) => boolean }) {
  const { entries, done } = usePresenceList(items, keyOf, same)
  return (
    <ul>
      {entries.map(({ item, leaving }) => (
        <li key={item.id} data-leaving={leaving || undefined}>
          {item.text}
          <button type="button" onClick={() => done(item.id)}>
            gone {item.id}
          </button>
        </li>
      ))}
    </ul>
  )
}

describe('usePresenceList', () => {
  const a = { id: 1, text: 'Moved.' }
  const b = { id: 2, text: 'Saved.' }
  const c = { id: 3, text: 'Saved.' }

  it('drops removed items at once where the browser cannot animate', () => {
    const { rerender } = render(<List items={[a, b]} />)
    rerender(<List items={[b]} />)
    expect(screen.getAllByRole('listitem').map((li) => li.firstChild?.textContent)).toEqual(['Saved.'])
  })

  it('keeps a removed item in its place, leaving, until done; new items join at the end', () => {
    installFakeAnimations()
    const { rerender } = render(<List items={[a, b]} />)
    rerender(<List items={[b, c]} />)
    const rows = screen.getAllByRole('listitem')
    expect(rows.map((li) => [li.firstChild?.textContent, li.dataset.leaving ?? null])).toEqual([
      ['Moved.', 'true'],
      ['Saved.', null],
      ['Saved.', null],
    ])
    act(() => screen.getByRole('button', { name: 'gone 1' }).click())
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
  })

  it('an item replaced by an identical one goes at once (a merged toast does not blink)', () => {
    installFakeAnimations()
    const same = (gone: Item, now: readonly Item[]) => now.some((n) => n.text === gone.text)
    const { rerender } = render(<List items={[a, b]} same={same} />)
    rerender(<List items={[a, c]} same={same} />)
    expect(screen.getAllByRole('listitem').map((li) => li.dataset.leaving ?? null)).toEqual([null, null])
    expect(screen.queryByRole('button', { name: 'gone 2' })).toBeNull()
  })

  it('done ignores an item that is still present', () => {
    installFakeAnimations()
    render(<List items={[a]} />)
    act(() => screen.getByRole('button', { name: 'gone 1' }).click())
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
  })
})
