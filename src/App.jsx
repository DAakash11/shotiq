import { useMemo, useState } from 'react'

import DataTable from './components/DataTable'
import SearchBar from './components/SearchBar'
import StatusMessage from './components/StatusMessage'
import { useFetchData } from './hooks/useFetchData'
import { fetchShots } from './services/nbaApi'
import { sortRows } from './utils/sorting'
import styles from './App.module.css'

// How many rows go into the DOM at once. Each row is 9 cells, so rendering
// all 1,311 attempts would mean roughly 12,000 elements -- enough to make
// scrolling and every re-render visibly sluggish. Search narrows the data
// instead.
const ROW_LIMIT = 100

// Declared once at module scope so the "no data yet" case returns the SAME
// array on every render. Writing `data?.shots ?? []` inline would build a
// brand new empty array each time, and that changed reference would
// invalidate the useMemo below on every single render.
const NO_SHOTS = []

// Which fields the search box looks at. Free-text matching against numeric
// columns like distance or angle would surprise more than it would help.
const SEARCH_KEYS = ['gameDate', 'opponent', 'actionType', 'zone']

// Describing columns as data rather than hard-coding <td>s keeps DataTable
// generic and puts every formatting decision for shots in one readable list.
const SHOT_COLUMNS = [
  { key: 'gameDate', header: 'Date', sortable: true },
  {
    key: 'opponent',
    header: 'Opp',
    sortable: true,
    // Basketball convention: 'vs' at home, '@' away.
    format: (value, row) => `${row.isHome ? 'vs' : '@'} ${value}`,
  },
  { key: 'period', header: 'Qtr', align: 'right', sortable: true },
  { key: 'clock', header: 'Clock', align: 'right' },
  { key: 'actionType', header: 'Action', sortable: true },
  { key: 'zone', header: 'Zone', sortable: true },
  {
    key: 'distanceFt',
    header: 'Dist',
    align: 'right',
    sortable: true,
    format: (value) => `${value} ft`,
  },
  {
    key: 'angleDeg',
    header: 'Angle',
    align: 'right',
    sortable: true,
    // null for shots at the rim, where an angle carries no meaning.
    format: (value) => (value == null ? '—' : `${value}°`),
  },
  {
    key: 'made',
    header: 'Result',
    sortable: true,
    format: (value) => (
      <span className={value ? styles.made : styles.missed}>
        {value ? 'Made' : 'Miss'}
      </span>
    ),
  },
]

function matchesQuery(shot, needle) {
  return SEARCH_KEYS.some((key) =>
    String(shot[key] ?? '')
      .toLowerCase()
      .includes(needle),
  )
}

function App() {
  const { data, error, isLoading } = useFetchData(fetchShots)

  // Only the user's raw intent is stored: what they typed, and which column
  // they clicked. The filtered and sorted rows are NOT stored -- see below.
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState({ key: null, direction: 'asc' })

  const shots = data?.shots ?? NO_SHOTS

  // Derived state: computed during render from the data plus the user's
  // input. Storing the filtered rows in their own useState would create a
  // second source of truth that has to be manually kept in sync -- forget
  // one setState and the table silently shows stale results. Deriving means
  // it cannot drift.
  //
  // useMemo skips the work when nothing relevant changed. At 1,311 rows the
  // filter and sort take well under a millisecond, so this is a habit rather
  // than a rescue; it earns its place once the component holds more state,
  // because unrelated re-renders would otherwise redo this every time.
  // Measure before assuming useMemo is needed.
  const matchingShots = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const filtered = needle
      ? shots.filter((shot) => matchesQuery(shot, needle))
      : shots

    return sortRows(filtered, sort.key, sort.direction)
  }, [shots, query, sort])

  const visibleShots = matchingShots.slice(0, ROW_LIMIT)
  const sortedColumnHeader = SHOT_COLUMNS.find((column) => column.key === sort.key)?.header

  function handleSortChange(key) {
    // The updater form receives the freshest state rather than whatever
    // `sort` was captured in this render's closure. It matters whenever the
    // next value depends on the previous one.
    setSort((current) => {
      if (current.key !== key) return { key, direction: 'asc' }
      if (current.direction === 'asc') return { key, direction: 'desc' }
      // A third click clears the sort and restores original game order.
      return { key: null, direction: 'asc' }
    })
  }

  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <h1 className={styles.title}>
          Shot<span className={styles.titleAccent}>IQ</span>
        </h1>
        <p className={styles.tagline}>
          NBA shot analytics — distance, angle, defender pressure and shot clock.
        </p>
      </header>

      <main>
        {isLoading && (
          <StatusMessage title="Loading shot data…">
            The first request can take a few seconds while the API reads its cache.
          </StatusMessage>
        )}

        {error && (
          <StatusMessage tone="error" title="Could not load shot data">
            {error.message} — check the API is running on port 8000.
          </StatusMessage>
        )}

        {data && (
          <>
            <section className={styles.summary}>
              <h2 className={styles.summaryHeading}>
                {data.meta.player} — {data.meta.season} {data.meta.seasonType}
              </h2>

              <p>
                {data.meta.made.toLocaleString()} made from{' '}
                {data.meta.attempts.toLocaleString()} attempts
                {data.meta.fgPct != null &&
                  ` (${(data.meta.fgPct * 100).toFixed(1)}% FG)`}
                .
              </p>

              <p className={styles.source}>
                Served from {data.meta.source} · league averages loaded for{' '}
                {data.leagueAverages.length} zones
                {data.meta.warning && ` · ${data.meta.warning}`}
              </p>
            </section>

            <section className={styles.tableSection}>
              <SearchBar
                label="Search attempts"
                value={query}
                onChange={setQuery}
                placeholder="Try LAL, Dunk, or Mid-Range"
                hint={
                  query
                    ? `${matchingShots.length.toLocaleString()} of ${shots.length.toLocaleString()} attempts match.`
                    : `Searching ${shots.length.toLocaleString()} attempts by date, opponent, action or zone.`
                }
              />

              <p className={styles.tableMeta}>
                Showing {visibleShots.length.toLocaleString()} of{' '}
                {matchingShots.length.toLocaleString()} attempts
                {sortedColumnHeader
                  ? ` · sorted by ${sortedColumnHeader} (${sort.direction})`
                  : ' · in game order'}
                .
              </p>

              <DataTable
                columns={SHOT_COLUMNS}
                rows={visibleShots}
                // Composed server-side from GAME_ID + GAME_EVENT_ID, so it is
                // unique and stable regardless of how the array is ordered.
                getRowKey={(shot) => shot.id}
                sort={sort}
                onSortChange={handleSortChange}
                caption={`Field-goal attempts by ${data.meta.player}, ${data.meta.season}`}
                emptyMessage={`No attempts match “${query}”.`}
              />
            </section>
          </>
        )}
      </main>
    </div>
  )
}

export default App
