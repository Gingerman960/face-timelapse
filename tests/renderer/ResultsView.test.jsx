import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import React from 'react'
import ResultsView from '../../renderer/src/views/ResultsView.jsx'
import useAlignmentStore from '../../renderer/src/store/alignmentStore.js'

afterEach(() => {
  cleanup()
  useAlignmentStore.getState().reset()
})

describe('ResultsView', () => {
  it('renders the aligned photo count', () => {
    useAlignmentStore.setState({
      alignedResults: [
        { outputPath: '/tmp/a.png', creationDate: '2024-03-07T00:00:00Z' },
        { outputPath: '/tmp/b.png', creationDate: '2024-03-08T00:00:00Z' },
      ],
    })
    render(<ResultsView />)
    expect(screen.getByText('2 Aligned Photos')).toBeTruthy()
  })

  it('thumbnail buttons expose accessible labels', () => {
    useAlignmentStore.setState({
      alignedResults: [
        { outputPath: '/tmp/a.png', creationDate: '2024-03-07T00:00:00Z' },
      ],
    })
    render(<ResultsView />)
    const thumbBtns = screen.getAllByRole('button', { name: /View photo/i })
    expect(thumbBtns.length).toBeGreaterThan(0)
  })

  it('disables Create Video when fewer than 2 aligned results', () => {
    useAlignmentStore.setState({
      alignedResults: [{ outputPath: '/tmp/a.png', creationDate: '2024-03-07T00:00:00Z' }],
    })
    render(<ResultsView />)
    const createBtn = screen.getByRole('button', { name: /Create Video/i })
    expect(createBtn.disabled).toBe(true)
  })
})
