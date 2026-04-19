import { beforeEach, describe, it, expect } from 'vitest'
import useAlignmentStore from '../renderer/src/store/alignmentStore.js'

function makePhoto(overrides = {}) {
  return {
    filePath: '/p/' + (overrides.filename || 'a.jpg'),
    filename: overrides.filename || 'a.jpg',
    similarityScore: 0.9,
    status: 'confirmed',
    creationDate: '2020-01-01T10:00:00.000Z',
    embedding: null,
    ...overrides,
  }
}

describe('movePhotoToDate', () => {
  beforeEach(() => {
    useAlignmentStore.setState({ dailyGroups: [] })
  })

  it('moves a photo from a multi-photo day to an empty target day', () => {
    const groups = [
      {
        date: '2020-01-01',
        photos: [
          makePhoto({ filename: 'hi.jpg', similarityScore: 0.9 }),
          makePhoto({ filename: 'lo.jpg', similarityScore: 0.5 }),
        ],
        selectedIndex: 0,
      },
    ]
    useAlignmentStore.setState({ dailyGroups: groups })

    useAlignmentStore.getState().movePhotoToDate(0, 1, '2020-01-02')

    const next = useAlignmentStore.getState().dailyGroups
    expect(next).toHaveLength(2)
    expect(next[0].date).toBe('2020-01-01')
    expect(next[0].photos.map((p) => p.filename)).toEqual(['hi.jpg'])
    expect(next[0].selectedIndex).toBe(0)
    expect(next[1].date).toBe('2020-01-02')
    expect(next[1].photos.map((p) => p.filename)).toEqual(['lo.jpg'])
    expect(next[1].selectedIndex).toBe(0)
    // The moved photo's creationDate must fall on the target local date so
    // that groupByDay() re-bucketing still lands it in 2020-01-02.
    const moved = new Date(next[1].photos[0].creationDate)
    const localKey = `${moved.getFullYear()}-${String(moved.getMonth() + 1).padStart(2, '0')}-${String(moved.getDate()).padStart(2, '0')}`
    expect(localKey).toBe('2020-01-02')
  })

  it('merges into an existing target day and resorts by similarityScore', () => {
    useAlignmentStore.setState({
      dailyGroups: [
        {
          date: '2020-01-01',
          photos: [
            makePhoto({ filename: 'a.jpg', similarityScore: 0.9 }),
            makePhoto({ filename: 'b.jpg', similarityScore: 0.4 }),
          ],
          selectedIndex: 0,
        },
        {
          date: '2020-01-02',
          photos: [makePhoto({ filename: 'c.jpg', similarityScore: 0.7 })],
          selectedIndex: 0,
        },
      ],
    })

    useAlignmentStore.getState().movePhotoToDate(0, 1, '2020-01-02')

    const [src, tgt] = useAlignmentStore.getState().dailyGroups
    expect(src.photos.map((p) => p.filename)).toEqual(['a.jpg'])
    expect(tgt.photos.map((p) => p.filename)).toEqual(['c.jpg', 'b.jpg'])
    expect(tgt.selectedIndex).toBe(0)
  })

  it('is a no-op when source and target date match', () => {
    const before = [
      {
        date: '2020-01-01',
        photos: [
          makePhoto({ filename: 'a.jpg' }),
          makePhoto({ filename: 'b.jpg' }),
        ],
        selectedIndex: 0,
      },
    ]
    useAlignmentStore.setState({ dailyGroups: before })
    useAlignmentStore.getState().movePhotoToDate(0, 0, '2020-01-01')
    expect(useAlignmentStore.getState().dailyGroups).toEqual(before)
  })

  it('removes the source group entirely when its last photo is moved out', () => {
    useAlignmentStore.setState({
      dailyGroups: [
        { date: '2020-01-01', photos: [makePhoto({ filename: 'only.jpg' })], selectedIndex: 0 },
        { date: '2020-01-03', photos: [makePhoto({ filename: 'other.jpg' })], selectedIndex: 0 },
      ],
    })

    useAlignmentStore.getState().movePhotoToDate(0, 0, '2020-01-02')

    const next = useAlignmentStore.getState().dailyGroups
    expect(next.map((g) => g.date)).toEqual(['2020-01-02', '2020-01-03'])
    expect(next[0].photos[0].filename).toBe('only.jpg')
  })

  it('shifts selectedIndex left when a photo before the selection is moved out', () => {
    useAlignmentStore.setState({
      dailyGroups: [
        {
          date: '2020-01-01',
          photos: [
            makePhoto({ filename: 'a.jpg' }),
            makePhoto({ filename: 'b.jpg' }),
            makePhoto({ filename: 'c.jpg' }),
          ],
          selectedIndex: 2,
        },
      ],
    })

    useAlignmentStore.getState().movePhotoToDate(0, 0, '2020-01-02')

    const [src] = useAlignmentStore.getState().dailyGroups
    expect(src.photos.map((p) => p.filename)).toEqual(['b.jpg', 'c.jpg'])
    // Selection must still point at 'c.jpg', which is now at index 1.
    expect(src.selectedIndex).toBe(1)
    expect(src.photos[src.selectedIndex].filename).toBe('c.jpg')
  })

  it('leaves selectedIndex alone when a photo after the selection is moved out', () => {
    useAlignmentStore.setState({
      dailyGroups: [
        {
          date: '2020-01-01',
          photos: [
            makePhoto({ filename: 'a.jpg' }),
            makePhoto({ filename: 'b.jpg' }),
            makePhoto({ filename: 'c.jpg' }),
          ],
          selectedIndex: 0,
        },
      ],
    })

    useAlignmentStore.getState().movePhotoToDate(0, 2, '2020-01-02')

    const [src] = useAlignmentStore.getState().dailyGroups
    expect(src.photos.map((p) => p.filename)).toEqual(['a.jpg', 'b.jpg'])
    expect(src.selectedIndex).toBe(0)
  })

  it('clamps selectedIndex when the selected photo is moved out', () => {
    useAlignmentStore.setState({
      dailyGroups: [
        {
          date: '2020-01-01',
          photos: [
            makePhoto({ filename: 'a.jpg' }),
            makePhoto({ filename: 'b.jpg' }),
            makePhoto({ filename: 'c.jpg' }),
          ],
          selectedIndex: 2,
        },
      ],
    })

    useAlignmentStore.getState().movePhotoToDate(0, 2, '2020-01-02')

    const [src] = useAlignmentStore.getState().dailyGroups
    expect(src.photos.map((p) => p.filename)).toEqual(['a.jpg', 'b.jpg'])
    expect(src.selectedIndex).toBe(1)
  })

  it('leaves state untouched when groupIdx or photoIdx are out of range', () => {
    const before = [
      { date: '2020-01-01', photos: [makePhoto()], selectedIndex: 0 },
    ]
    useAlignmentStore.setState({ dailyGroups: before })

    useAlignmentStore.getState().movePhotoToDate(5, 0, '2020-01-02')
    useAlignmentStore.getState().movePhotoToDate(0, 5, '2020-01-02')

    expect(useAlignmentStore.getState().dailyGroups).toEqual(before)
  })
})
