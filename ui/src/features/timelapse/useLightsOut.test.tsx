// Critique round 4, signature moment 1: lights-out playback. While the player
// plays, the chrome fades to 8 % (CSS keyed on html[data-lights="out"]); a
// pointer move, a key or a focus change brings it back, and it dims again
// after two seconds of stillness.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render } from '@testing-library/react'
import { usePlayer } from '../../state/player'
import { LIGHTS_IDLE_MS, useLightsOut } from './useLightsOut'

const initial = usePlayer.getState()
const lights = () => document.documentElement.dataset.lights
const pointer = () => document.documentElement.dataset.pointer

function Probe({ enabled }: { enabled: boolean }) {
  useLightsOut(enabled)
  return null
}

const play = () => act(() => usePlayer.getState().toggle())

beforeEach(() => {
  vi.useFakeTimers()
  usePlayer.setState(initial, true)
})
afterEach(() => {
  vi.useRealTimers()
  delete document.documentElement.dataset.lights
  delete document.documentElement.dataset.pointer
})

describe('lights-out playback', () => {
  it('is lit while paused and dims the moment playback starts', () => {
    // Arrange
    render(<Probe enabled />)
    expect(lights()).toBe('on')

    // Act
    play()

    // Assert
    expect(lights()).toBe('out')
  })

  it('a pointer move restores the chrome, which dims again after two seconds of stillness', () => {
    // Arrange
    render(<Probe enabled />)
    play()

    // Act
    fireEvent.pointerMove(window, { clientX: 40, clientY: 40 })

    // Assert
    expect(lights()).toBe('on')
    act(() => vi.advanceTimersByTime(LIGHTS_IDLE_MS - 1))
    expect(lights()).toBe('on')
    fireEvent.pointerMove(window, { clientX: 41, clientY: 40 })
    act(() => vi.advanceTimersByTime(LIGHTS_IDLE_MS - 1))
    expect(lights()).toBe('on')
    act(() => vi.advanceTimersByTime(1))
    expect(lights()).toBe('out')
  })

  it('ignores a pointer event that did not move (content shifting under a still pointer)', () => {
    // Arrange
    render(<Probe enabled />)
    fireEvent.pointerMove(window, { clientX: 40, clientY: 40 })
    play()

    // Act
    fireEvent.pointerMove(window, { clientX: 40, clientY: 40 })

    // Assert
    expect(lights()).toBe('out')
  })

  it('any key and any focus change restore it, so keyboard focus is never left in the dark', () => {
    // Arrange
    render(<Probe enabled />)
    play()

    // Act + Assert
    fireEvent.keyDown(window, { key: 'Shift' })
    expect(lights()).toBe('on')
    act(() => vi.advanceTimersByTime(LIGHTS_IDLE_MS))
    expect(lights()).toBe('out')
    fireEvent.focusIn(document.body)
    expect(lights()).toBe('on')
  })

  it('pausing restores it for good', () => {
    // Arrange
    render(<Probe enabled />)
    play()

    // Act
    act(() => usePlayer.getState().pause())
    act(() => vi.advanceTimersByTime(LIGHTS_IDLE_MS * 3))

    // Assert
    expect(lights()).toBe('on')
  })

  it('clears the attribute when the player goes away or is turned off, also mid-play', () => {
    // Arrange
    const { rerender, unmount } = render(<Probe enabled />)
    play()

    // Act + Assert
    rerender(<Probe enabled={false} />)
    expect(lights()).toBeUndefined()
    rerender(<Probe enabled />)
    unmount()
    expect(lights()).toBeUndefined()
    act(() => vi.advanceTimersByTime(LIGHTS_IDLE_MS))
    expect(lights()).toBeUndefined()
  })

  it('mounting while already playing starts lit and dims after the idle time', () => {
    // Arrange
    play()

    // Act
    render(<Probe enabled />)

    // Assert
    expect(lights()).toBe('on')
    act(() => vi.advanceTimersByTime(LIGHTS_IDLE_MS))
    expect(lights()).toBe('out')
  })
})

// Critique round 5, P2-17: in lights-out the pointer stayed on the picture.
describe('the pointer in lights-out', () => {
  it('hides after two seconds of stillness while the lights are out, and a move brings it back', () => {
    // Arrange
    render(<Probe enabled />)
    fireEvent.pointerMove(window, { clientX: 40, clientY: 40 })

    // Act
    play()

    // Assert: out at once, the pointer only once it has been still for two seconds.
    expect(lights()).toBe('out')
    expect(pointer()).toBeUndefined()
    act(() => vi.advanceTimersByTime(LIGHTS_IDLE_MS - 1))
    expect(pointer()).toBeUndefined()
    act(() => vi.advanceTimersByTime(1))
    expect(pointer()).toBe('hidden')
    fireEvent.pointerMove(window, { clientX: 41, clientY: 40 })
    expect(pointer()).toBeUndefined()
    act(() => vi.advanceTimersByTime(LIGHTS_IDLE_MS))
    expect(lights()).toBe('out')
    expect(pointer()).toBe('hidden')
  })

  it('a pointer event that did not move leaves it hidden', () => {
    // Arrange
    render(<Probe enabled />)
    fireEvent.pointerMove(window, { clientX: 40, clientY: 40 })
    play()
    act(() => vi.advanceTimersByTime(LIGHTS_IDLE_MS))

    // Act
    fireEvent.pointerMove(window, { clientX: 40, clientY: 40 })

    // Assert
    expect(pointer()).toBe('hidden')
  })

  it('stays visible while paused, however still', () => {
    // Arrange
    render(<Probe enabled />)

    // Act
    act(() => vi.advanceTimersByTime(LIGHTS_IDLE_MS * 3))

    // Assert
    expect(pointer()).toBeUndefined()
  })

  it('comes back when playback pauses and when the player goes away', () => {
    // Arrange
    const { unmount } = render(<Probe enabled />)
    play()
    act(() => vi.advanceTimersByTime(LIGHTS_IDLE_MS))
    expect(pointer()).toBe('hidden')

    // Act + Assert
    act(() => usePlayer.getState().pause())
    expect(pointer()).toBeUndefined()
    play()
    act(() => vi.advanceTimersByTime(LIGHTS_IDLE_MS))
    unmount()
    expect(pointer()).toBeUndefined()
  })
})
