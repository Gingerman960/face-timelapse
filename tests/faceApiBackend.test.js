import { describe, it, expect } from 'vitest'
import { buildAttempts, AVAILABLE_BACKENDS } from '../electron/services/faceApiBackend.js'

describe('buildAttempts', () => {
  it('orders gpu > node > wasm by default', () => {
    const attempts = buildAttempts(undefined)
    expect(attempts.map((a) => a.name)).toEqual(['gpu', 'node', 'wasm'])
  })

  it('keeps wasm as the last fallback when no override is given', () => {
    const attempts = buildAttempts(undefined)
    expect(attempts.at(-1).name).toBe('wasm')
    expect(attempts.at(-1).tfPkg).toBeNull()
  })

  it('when override=gpu, tries gpu then falls back to wasm', () => {
    const attempts = buildAttempts('gpu')
    expect(attempts.map((a) => a.name)).toEqual(['gpu', 'wasm'])
  })

  it('when override=node, tries node then falls back to wasm', () => {
    const attempts = buildAttempts('node')
    expect(attempts.map((a) => a.name)).toEqual(['node', 'wasm'])
  })

  it('when override=wasm, only tries wasm', () => {
    const attempts = buildAttempts('wasm')
    expect(attempts).toHaveLength(1)
    expect(attempts[0].name).toBe('wasm')
  })

  it('pairs each non-wasm backend with a matching @tensorflow package', () => {
    const attempts = buildAttempts(undefined)
    const gpu = attempts.find((a) => a.name === 'gpu')
    const node = attempts.find((a) => a.name === 'node')
    expect(gpu.tfPkg).toBe('@tensorflow/tfjs-node-gpu')
    expect(node.tfPkg).toBe('@tensorflow/tfjs-node')
  })

  it('exports a list of available backend names', () => {
    expect(AVAILABLE_BACKENDS).toEqual(['gpu', 'node', 'wasm'])
  })
})
