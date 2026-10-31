/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { DataText, dataRuns } from './DataText'

describe('DataText (mono for data only, QA critique round 3)', () => {
  it('splits words from numbers, keeping sizes and times whole', () => {
    expect(dataRuns('Read in 40 s')).toEqual(['Read in ', '40', ' s'])
    expect(dataRuns('Preview · 1080 × 1440')).toEqual(['Preview · ', '1080 × 1440', ''])
    expect(dataRuns('3,547 frames · 1 Sep 2012 – 31 Aug 2022')).toEqual(['', '3,547', ' frames · ', '1 Sep 2012', ' – ', '31 Aug 2022', ''])
    expect(dataRuns('Sep 2012')).toEqual(['Sep ', '2012', ''])
    expect(dataRuns('00:48.1')).toEqual(['', '00:48.1', ''])
  })

  it('sets only the numbers in the data font', () => {
    const { container } = render(<DataText>Read in 40 s</DataText>)
    expect(container.querySelector('.meta')).toHaveTextContent('Read in 40 s')
    expect([...container.querySelectorAll('.digits')].map((n) => n.textContent)).toEqual(['40'])
  })
})

// Critique round 6, P2-5: a mono comma or colon fills a whole cell, so at heading
// size "1,761" read as "1 , 761". Separators inside a number set narrow.
describe('DataText separators', () => {
  it('wraps the grouping comma, the colon and the decimal point in a narrow .sep', () => {
    const { container } = render(<DataText>Encoding day 1,761 of 3,547 · 1:59.2</DataText>)
    expect(container.querySelector('.meta')).toHaveTextContent('Encoding day 1,761 of 3,547 · 1:59.2')
    expect([...container.querySelectorAll('.digits')].map((n) => n.textContent)).toEqual(['1,761', '3,547', '1:59.2'])
    expect([...container.querySelectorAll('.digits .sep')].map((n) => n.textContent)).toEqual([',', ',', ':', '.'])
  })

  it('leaves dates and sizes without separators alone', () => {
    const { container } = render(<DataText>1 Sep 2012 · 1080 × 1440</DataText>)
    expect(container.querySelectorAll('.sep')).toHaveLength(0)
  })

  it('pulls the separator in from both sides in the data font (base.css)', () => {
    const css = readFileSync(join(process.cwd(), 'src', 'styles', 'base.css'), 'utf8')
    expect(css).toMatch(/\.digits \.sep \{[^}]*margin-inline: -0\.\d+em/)
  })
})
