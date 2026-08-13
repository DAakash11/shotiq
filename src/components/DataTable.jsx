import styles from './DataTable.module.css'

/**
 * A presentational, data-agnostic table.
 *
 * It knows nothing about shots, the NBA, or where its rows came from. It
 * renders whatever `rows` it is handed, in whatever shape `columns`
 * describes. That is what makes it reusable -- step 5 could point it at
 * the tracking splits without changing a line in here.
 *
 * @param {Array<{
 *   key: string,
 *   header: string,
 *   align?: 'right',
 *   format?: (value: unknown, row: object) => import('react').ReactNode
 * }>} columns  Column definitions, in display order.
 * @param {Array<object>} rows  The data to render.
 * @param {(row: object) => string} getRowKey
 *   Must return a stable, unique id for a row. See the note below.
 * @param {string} [caption]  Description announced to screen readers.
 * @param {string} [emptyMessage]  Shown when `rows` is empty.
 */
function DataTable({
  columns,
  rows,
  getRowKey,
  caption,
  emptyMessage = 'No rows match the current filters.',
}) {
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
                className={column.align === 'right' ? styles.right : undefined}
              >
                {column.header}
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
              // sorting reorders the array in step 4, React would keep
              // the existing DOM and only swap the text, quietly
              // discarding any per-row state.
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
