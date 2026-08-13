/**
 * Compare two non-null values of the same broad type.
 *
 * Null handling deliberately lives in sortRows, not here -- see the note
 * there about why blanks must not follow the sort direction.
 */
export function compareValues(a, b) {
  if (typeof a === 'number' && typeof b === 'number') {
    return a - b
  }

  if (typeof a === 'boolean' && typeof b === 'boolean') {
    return Number(a) - Number(b)
  }

  // localeCompare with numeric:true sorts 'Q2' before 'Q10' rather than
  // the other way round, which plain string comparison would get wrong.
  return String(a).localeCompare(String(b), undefined, {
    numeric: true,
    sensitivity: 'base',
  })
}

/**
 * Return a new array sorted by `key`. Never mutates the input.
 *
 * @param {Array<object>} rows
 * @param {string | null} key  null means "leave in the original order"
 * @param {'asc' | 'desc'} direction
 */
export function sortRows(rows, key, direction) {
  if (!key) {
    return rows
  }

  // Array.prototype.sort sorts IN PLACE and returns the same array. Sorting
  // the array we were handed would mutate the data held in the fetch hook's
  // state -- React would not see a new reference, so components could miss
  // the update, and the "original order" would be permanently lost. Copy first.
  const sorted = [...rows]

  sorted.sort((rowA, rowB) => {
    const a = rowA[key]
    const b = rowB[key]

    // Missing values always sort to the bottom, in both directions.
    // Negating them along with everything else would park every blank at
    // the top of a descending sort, which reads as a bug.
    if (a == null && b == null) return 0
    if (a == null) return 1
    if (b == null) return -1

    const result = compareValues(a, b)
    return direction === 'desc' ? -result : result
  })

  return sorted
}
