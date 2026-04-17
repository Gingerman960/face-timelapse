import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import React from 'react'
import App from '../../renderer/src/App.jsx'
import useAlignmentStore from '../../renderer/src/store/alignmentStore.js'

afterEach(() => {
  cleanup()
  // Reset the zustand store between tests so state doesn't bleed.
  useAlignmentStore.getState().reset()
})

describe('App', () => {
  it('renders the workflow stepper with all six steps', () => {
    render(<App />)
    expect(screen.getByText('FaceTimelapse')).toBeTruthy()
    expect(screen.getByText('1. Setup')).toBeTruthy()
    expect(screen.getByText('6. Results')).toBeTruthy()
  })

  it('shows the error banner when an error is in the store', () => {
    useAlignmentStore.setState({ error: 'Something went wrong' })
    render(<App />)
    expect(screen.getByRole('alert').textContent).toContain('Something went wrong')
  })

  it('renders SetupView by default', () => {
    render(<App />)
    expect(screen.getByText('Reference Photo')).toBeTruthy()
    expect(screen.getByText('Source Folder')).toBeTruthy()
  })
})
