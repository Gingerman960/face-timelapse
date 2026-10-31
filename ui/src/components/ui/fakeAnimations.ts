/*
 * Test support: a controllable stand-in for the Web Animations API, which
 * jsdom lacks. `installFakeAnimations()` gives every element an `animate()`
 * that records its keyframes and returns an animation whose `finished`
 * promise the test settles (`finishAll`) or that `cancel()` rejects, like a
 * browser's. `removeFakeAnimations()` takes it away again (call it in
 * `afterEach`; it is not a spy, so `restoreMocks` does not undo it).
 */
import { vi, type Mock } from 'vitest'

export interface FakeCall {
  target: Element
  keyframes: Keyframe[]
  options: KeyframeAnimationOptions
}

export interface FakeAnimation {
  target: Element
  finished: Promise<FakeAnimation>
  onfinish: ((this: Animation, ev: AnimationPlaybackEvent) => unknown) | null
  cancel: Mock<() => void>
  finish: Mock<() => void>
  /** Settles `finished` as if the animation had run to its end. */
  resolve: () => void
  /** True once cancelled (its `finished` rejected). */
  cancelled: boolean
}

export interface FakeAnimations {
  calls: FakeCall[]
  animations: FakeAnimation[]
  /** Finishes every animation still running, then lets the promise chains settle. */
  finishAll: () => Promise<void>
}

/** Microtask hops to wait after settling, so `Promise.all(...).then(...)` chains have run. */
const SETTLE_TICKS = 6

function fakeAnimation(target: Element): FakeAnimation {
  let resolveFinished: (a: FakeAnimation) => void = () => undefined
  let rejectFinished: (e: Error) => void = () => undefined
  const finished = new Promise<FakeAnimation>((resolve, reject) => {
    resolveFinished = resolve
    rejectFinished = reject
  })
  // A browser rejects `finished` on cancel; nobody has to listen.
  finished.catch(() => undefined)
  let settled = false
  const animation: FakeAnimation = {
    target,
    finished,
    onfinish: null,
    cancelled: false,
    cancel: vi.fn(() => {
      if (settled) return
      settled = true
      animation.cancelled = true
      rejectFinished(new DOMException('The animation was cancelled', 'AbortError'))
    }),
    finish: vi.fn(() => animation.resolve()),
    resolve: () => {
      if (settled) return
      settled = true
      resolveFinished(animation)
    },
  }
  return animation
}

export function installFakeAnimations(): FakeAnimations {
  const record: FakeAnimations = {
    calls: [],
    animations: [],
    finishAll: async () => {
      for (const a of record.animations) a.resolve()
      for (let i = 0; i < SETTLE_TICKS; i++) await Promise.resolve()
    },
  }
  function animate(this: Element, keyframes: Keyframe[] | PropertyIndexedKeyframes | null, options?: number | KeyframeAnimationOptions): FakeAnimation {
    const opts = typeof options === 'number' ? { duration: options } : (options ?? {})
    record.calls.push({ target: this, keyframes: (keyframes ?? []) as Keyframe[], options: opts })
    const animation = fakeAnimation(this)
    record.animations.push(animation)
    return animation
  }
  if (!installed) {
    original = Object.getOwnPropertyDescriptor(Element.prototype, 'animate')
    installed = true
  }
  Object.defineProperty(Element.prototype, 'animate', { value: animate, configurable: true, writable: true })
  return record
}

/** What `Element.prototype.animate` was before the fake (jsdom: nothing). */
let original: PropertyDescriptor | undefined
let installed = false

export function removeFakeAnimations(): void {
  if (!installed) return
  if (original) Object.defineProperty(Element.prototype, 'animate', original)
  else delete (Element.prototype as Partial<Element>).animate
  original = undefined
  installed = false
}
