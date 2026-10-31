// QA 4: the readout must show the tilt that remains, not the rotation applied.
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ReferenceState } from '../../ipc/contract'
import { makeReference } from '../../test/session'
import { ReferenceReadouts } from './ReferenceReadouts'
import { FaceActions } from './SetupInspector'

function withRotation(rotationDeg: number, autoRotationDeg: number | null): ReferenceState {
  const ref = makeReference()
  return { ...ref, image: { ...ref.image, rotationDeg, autoRotationDeg } }
}

function readout(ref: ReferenceState) {
  render(<ReferenceReadouts reference={ref} error={null} finding={false} output={null} busy={false} onChooseAnother={() => undefined} />)
  return screen.getByText(/^(Eyes level|Tilted)/).closest('span') as HTMLElement
}

describe('reference readout (QA 4)', () => {
  it('after levelling by 1.1°, the eyes read level with no tilt left', () => {
    expect(readout(withRotation(1.1, 1.1))).toHaveTextContent(/^Eyes level 0\.0°$/)
  })

  it('an unlevelled photo shows the tilt that remains', () => {
    expect(readout(withRotation(0, -1.8))).toHaveTextContent(/^Tilted 1\.8°$/)
  })

  it('a partly levelled photo shows only the rest', () => {
    expect(readout(withRotation(0.5, 2.3))).toHaveTextContent(/^Tilted 1\.8°$/)
  })

  it('the Level button names the turn it would make', () => {
    render(<FaceActions reference={withRotation(0.5, 2.3)} disabled={false} onLevel={() => undefined} onCenter={() => undefined} onReset={() => undefined} />)
    expect(screen.getByRole('button', { name: /Level the eyes/ })).toHaveTextContent('+1.8°')
  })
})
