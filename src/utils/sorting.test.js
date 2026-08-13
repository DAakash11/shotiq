import { describe, expect, it } from 'vitest'

import { compareValues, sortRows } from './sorting'

// Shaped like real shot records, including the nulls the API returns for
// angles at the rim.
const rows = [
  { id: 'a', dist: 18, zone: 'Mid-Range', angle: 13.5, made: true },
  { id: 'b', dist: 0, zone: 'Restricted Area', angle: null, made: false },
  { id: 'c', dist: 25, zone: 'Above the Break 3', angle: -30.8, made: false },
  { id: 'd', dist: 7, zone: 'In The Paint (Non-RA)', angle: null, made: true },
]

const ids = (result) => result.map((row) => row.id)

describe('sortRows', () => {
  it('sorts numbers ascending', () => {
    expect(ids(sortRows(rows, 'dist', 'asc'))).toEqual(['b', 'd', 'a', 'c'])
  })

  it('sorts numbers descending', () => {
    expect(ids(sortRows(rows, 'dist', 'desc'))).toEqual(['c', 'a', 'd', 'b'])
  })

  it('sorts booleans, false first', () => {
    expect(ids(sortRows(rows, 'made', 'asc'))).toEqual(['b', 'c', 'a', 'd'])
  })

  it('puts missing values last when ascending', () => {
    expect(ids(sortRows(rows, 'angle', 'asc'))).toEqual(['c', 'a', 'b', 'd'])
  })

  it('still puts missing values last when descending', () => {
    // The one that naive implementations get wrong: negating the
    // comparator flips the nulls to the top of a descending sort.
    expect(ids(sortRows(rows, 'angle', 'desc'))).toEqual(['a', 'c', 'b', 'd'])
  })

  it('does not mutate the array it was given', () => {
    const original = ids(rows)
    sortRows(rows, 'dist', 'desc')
    expect(ids(rows)).toEqual(original)
  })

  it('returns rows untouched when no sort key is set', () => {
    // No key means "original game order", so it should hand back the very
    // same array rather than a sorted copy.
    expect(sortRows(rows, null, 'asc')).toBe(rows)
  })
})

describe('compareValues', () => {
  it('orders strings naturally, so Q2 comes before Q10', () => {
    // Plain string comparison would put '10' before '2'.
    expect(compareValues('Q2', 'Q10')).toBeLessThan(0)
  })

  it('ignores case', () => {
    expect(compareValues('mid-range', 'Mid-Range')).toBe(0)
  })

  it('orders numbers by value, not as text', () => {
    expect(compareValues(9, 10)).toBeLessThan(0)
  })
})
