import type { ElementType } from 'react'

/**
 * A data run as text sets it: a whole date ("1 Sep 2012", one face rather than
 * three), digits with grouping, decimals and times, and "1080 × 1440" sizes.
 */
const NUMBER = /(\d{1,2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4}|\d[\d,.:]*(?:\s?×\s?\d[\d,.:]*)?)/

/** Splits text into word and number runs, in order (numbers at the odd indices). */
export function dataRuns(text: string): string[] {
  return text.split(NUMBER)
}

/** A separator between two digits: a grouping comma, a time's colon, a decimal point. */
const SEP = /(?<=\d)([,.:])(?=\d)/

/**
 * A number with its separators set narrow (critique round 6, P2-5): in the data
 * font a comma fills a whole cell, so at heading size "1,761" read as "1 , 761".
 */
function Digits({ run }: { run: string }) {
  const parts = run.split(SEP)
  return (
    <span className="digits">
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <span key={i} className="sep">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </span>
  )
}

interface DataTextProps {
  children: string
  /** The element to render (a `span` by default). */
  as?: ElementType
  className?: string
}

/**
 * A meta line in words, with only its numerals in the data font: DESIGN keeps
 * Martian Mono for data (counts, times, sizes), never for prose (QA critique
 * round 3). "Read in 40 s", "3,547 frames · 1 Sep 2012 – 31 Aug 2022".
 */
export function DataText({ children, as: Tag = 'span', className = 'meta' }: DataTextProps) {
  return (
    <Tag className={className}>
      {dataRuns(children).map((run, i) =>
        i % 2 === 1 ? <Digits key={i} run={run} /> : run,
      )}
    </Tag>
  )
}
