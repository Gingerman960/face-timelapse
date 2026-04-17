import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import React from 'react'
import ConfirmView from '../../renderer/src/views/ConfirmView.jsx'
import useAlignmentStore from '../../renderer/src/store/alignmentStore.js'

afterEach(() => {
  cleanup()
  useAlignmentStore.getState().reset()
})

const makeCandidate = (overrides = {}) => ({
  filePath: '/photos/a.jpg',
  filename: 'a.jpg',
  embedding: new Array(45).fill(0),
  similarityScore: 0.5,
  status: 'uncertain',
  creationDate: new Date('2024-03-07').toISOString(),
  ...overrides,
})

describe('ConfirmView', () => {
  it('renders the first uncertain photo with its score', () => {
    useAlignmentStore.setState({ candidates: [makeCandidate()] })
    render(<ConfirmView />)
    expect(screen.getByText(/50% similarity/)).toBeTruthy()
    expect(screen.getByText(/a\.jpg/)).toBeTruthy()
  })

  it('advances after confirming a photo', () => {
    useAlignmentStore.setState({
      candidates: [
        makeCandidate({ filePath: '/photos/a.jpg', filename: 'a.jpg' }),
        makeCandidate({ filePath: '/photos/b.jpg', filename: 'b.jpg' }),
      ],
    })
    render(<ConfirmView />)
    expect(screen.getByText(/a\.jpg/)).toBeTruthy()
    fireEvent.click(screen.getByText(/Confirm/))
    expect(screen.getByText(/b\.jpg/)).toBeTruthy()
  })
})
