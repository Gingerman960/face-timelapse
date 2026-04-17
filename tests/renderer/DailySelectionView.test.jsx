import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import React from 'react'
import DailySelectionView from '../../renderer/src/views/DailySelectionView.jsx'
import useAlignmentStore from '../../renderer/src/store/alignmentStore.js'

afterEach(() => {
  cleanup()
  useAlignmentStore.getState().reset()
})

describe('DailySelectionView', () => {
  it('renders an empty state when no groups are loaded', () => {
    render(<DailySelectionView />)
    // Footer still renders
    expect(screen.getByText(/photos? to align/)).toBeTruthy()
  })

  it('renders a calendar and photos when a group is active', () => {
    useAlignmentStore.setState({
      dailyGroups: [
        {
          date: '2024-03-07',
          photos: [
            { filePath: '/p/a.jpg', filename: 'a.jpg', similarityScore: 0.8, status: 'confirmed', creationDate: '2024-03-07T12:00:00Z' },
            { filePath: '/p/b.jpg', filename: 'b.jpg', similarityScore: 0.7, status: 'confirmed', creationDate: '2024-03-07T13:00:00Z' },
          ],
          selectedIndex: 0,
        },
      ],
    })
    render(<DailySelectionView />)
    // Calendar header
    expect(screen.getByText(/Calendar/)).toBeTruthy()
    // Alignment CTA shows count
    expect(screen.getByText(/Align 1 Photos?/)).toBeTruthy()
  })

  it('calendar day cells are rendered as real buttons', () => {
    useAlignmentStore.setState({
      dailyGroups: [
        {
          date: '2024-03-07',
          photos: [{ filePath: '/p/a.jpg', filename: 'a.jpg', similarityScore: 0.8, status: 'confirmed', creationDate: '2024-03-07T12:00:00Z' }],
          selectedIndex: 0,
        },
      ],
    })
    render(<DailySelectionView />)
    // Our a11y fix converts every date cell to <button>
    const dayBtn = screen.getByRole('button', { name: /2024.*7.*1 photo/i })
    expect(dayBtn).toBeTruthy()
    expect(dayBtn.tagName).toBe('BUTTON')
  })
})
