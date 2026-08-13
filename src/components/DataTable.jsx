import styles from './DataTable.module.css'

/**
 * A presentational, data-agnostic table.
 *
 * It knows nothing about shots, the NBA, or where its rows came from. It
 * renders whatever `rows` it is handed, in whatever shape `columns`
 * describes. That is what makes it reusable -- step 5 could point it at
 * the tracking splits without changing a line in here.
 *
 * Note that it does not sort either. It renders the current sort state and
 * reports clicks through `onSortChange`; the parent owns the state and does
 * the actual sorting. Keeping the component stateless means the same table
 * works for sorted, unsorted and server-sorted data alike.
 *
 * @param {Array<{
 *   key: string,
 *   header: string,
 *   align?: 'right',
 *   sortable?: boolean,
 *   format?: (value: unknown, row: object) => import('react').ReactNode
 * }>} columns  Column definitions, in display order.
 * @param {Array<object>} rows  The data to render.
 * @param {(row: object) => string} getRowKey  Stable, unique row id.
 * @param {{ key: string | null, direction: 'asc' | 'desc' }} [sort]
 * @param {(key: string) => void} [onSortChange]
 * @param {string} [caption]  Description announced to screen readers.
 * @param {string} [emptyMessage]  Shown when `rows` is empty.
 */
function DataTable({
  columns,
  rows,
  getRowKey,
  sort,
  onSortChange,
  caption,
  emptyMessage = 'No rows match the current filters.',
}) {
  function renderHeaderContent(column) {
    const isSortable = column.sortable && onSortChange
    if (!isSortable) {
      return column.header
    }

    const isSorted = sort?.key === column.key

    return (
      // A real <button>, not a click handler on the <th>. Buttons are
      // keyboard focusable and activate on Enter and Space for free;
      // a clickable <th> would be unreachable without a mouse.
      <button
        type="button"
        className={styles.sortButton}
        onClick={() => onSortChange(column.key)}
      >
        {column.header}
        <span aria-hidden="true" className={styles.indicator}>
          {isSorted ? (sort.direction === 'asc' ? '▲' : '▼') : '↕'}
        </span>
      </button>
    )
  }

  function ariaSortFor(column) {
    if (!column.sortable) return undefined
    if (sort?.key !== column.key) return 'none'
    return sort.direction === 'asc' ? 'ascending' : 'descending'
  }

  return (
    <div className={styles.scroll}>
      <table className={styles.table}>
        {caption && <caption className={styles.caption}>{caption}</caption>}

        <thead>
          <tr>
            {columns.map((column) => (
              // Column keys are the column's own identity -- stable even
              // if we reorder columns later.
              <th
                key={column.key}
                scope="col"
                aria-sort={ariaSortFor(column)}
                className={column.align === 'right' ? styles.right : undefined}
              >
                {renderHeaderContent(column)}
              </th>
            ))}
          </tr>
        </thead>

        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className={styles.empty}>
                {emptyMessage}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              // The key must identify the DATA, not its position. React
              // uses it to match rows between renders: same key means
              // "same row, maybe moved", a new key means "different row,
              // rebuild it". Using the array index instead would tell
              // React that row 0 is always the same row -- so when
              // sorting reorders the array, React would keep the existing
              // DOM node and only swap the text, quietly leaving any
              // per-row state attached to the position.
              <tr key={getRowKey(row)}>
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={column.align === 'right' ? styles.right : undefined}
                  >
                    {column.format
                      ? column.format(row[column.key], row)
                      : row[column.key]}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}

export default DataTable
