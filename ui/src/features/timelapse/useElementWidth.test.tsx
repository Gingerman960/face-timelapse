// UI review 2, L7: the player started at a made-up 480 px, so every mount first
// fetched frames at the wrong width bucket and then cancelled them.
import { useLayoutEffect } from 'react'
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { stubLayout } from '../../test/layout'
import { useElementWidth } from './useElementWidth'

const seen: number[] = []

/** Like the player canvas: works with the width its parent measured, in its own layout effect. */
function Child({ width }: { width: number }) {
  useLayoutEffect(() => {
    seen.push(width)
  }, [width])
  return null
}

function Parent() {
  const { ref, width } = useElementWidth<HTMLDivElement>()
  return (
    <div ref={ref}>
      <Child width={width} />
    </div>
  )
}

describe('useElementWidth', () => {
  it('gives children the laid-out width or nothing, never a guess', () => {
    stubLayout(912, 600)
    seen.length = 0
    render(<Parent />)
    expect(seen.filter((w) => w > 0)).toEqual([912])
  })
})
