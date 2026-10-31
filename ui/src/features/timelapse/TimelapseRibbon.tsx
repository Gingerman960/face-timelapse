import { useCallback, useMemo } from 'react'
import type { AlignRecent, DayKey, FrameSummary } from '../../ipc/contract'
import { usePlayer } from '../../state/player'
import { DecadeRibbon } from '../shell/DecadeRibbon'
import { frameIndexForDay, presentDays } from './timelapseModel'

interface TimelapseRibbonProps {
  frames: readonly FrameSummary[]
  recent: readonly AlignRecent[]
  aligning: boolean
  /** The frame at the settled playhead. */
  frame: FrameSummary | undefined
}

/**
 * The decade ribbon as the scrubber. Its canvases redraw only when the days
 * change (memoized `present`) or the focus year changes, never per frame.
 */
export function TimelapseRibbon({ frames, recent, aligning, frame }: TimelapseRibbonProps) {
  const present = useMemo(() => presentDays(frames, recent), [frames, recent])
  const seek = useCallback((day: DayKey) => usePlayer.getState().setIndex(frameIndexForDay(frames, day)), [frames])
  const firstDay = frames[0]?.dayKey ?? recent[0]?.dayKey
  const lastDay = frames[frames.length - 1]?.dayKey ?? recent[recent.length - 1]?.dayKey
  if (!firstDay || !lastDay) return null
  const at = aligning ? (recent[recent.length - 1]?.dayKey ?? null) : (frame?.dayKey ?? null)
  return (
    <DecadeRibbon
      start={`${firstDay.slice(0, 4)}-01-01`}
      end={`${lastDay.slice(0, 4)}-12-31`}
      present={present}
      focusYear={Number((at ?? firstDay).slice(0, 4))}
      cursor={at}
      exposedUntil={aligning ? at : null}
      onSeek={aligning ? undefined : seek}
      label="Playhead date"
    />
  )
}
