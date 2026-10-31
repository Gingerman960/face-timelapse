import type { CSSProperties } from 'react'
import { SCORE_CONFIRMED, SCORE_UNCERTAIN } from '../../ipc/contract'

function zone(a: number, b: number): CSSProperties {
  return { left: `${a * 100}%`, width: `calc(${(b - a) * 100}% - 2px)` }
}

/** Where the likeness score sits between "not you", "unsure" and "you". */
export function Likeness({ score }: { score: number }) {
  const nearer = score < (SCORE_UNCERTAIN + SCORE_CONFIRMED) / 2 ? 'closer to “not you” than to a clear match.' : 'closer to a clear match than to “not you”.'
  return (
    <div>
      <div className="likeness-scale" aria-hidden="true">
        <i className="zone z-out" style={zone(0, SCORE_UNCERTAIN)} />
        <i className="zone z-unsure" style={zone(SCORE_UNCERTAIN, SCORE_CONFIRMED)} />
        <i className="zone z-in" style={zone(SCORE_CONFIRMED, 1)} />
        <b className="likeness-pin" style={{ left: `${score * 100}%` }} />
      </div>
      <div className="likeness-legend" aria-hidden="true">
        <span>Not you</span>
        <span>Unsure</span>
        <span>You</span>
      </div>
      <p className="likeness-value">
        <span className="mono">{score.toFixed(2)}</span> — {nearer}
      </p>
    </div>
  )
}
