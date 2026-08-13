import DataTable from './components/DataTable'
import StatusMessage from './components/StatusMessage'
import { useFetchData } from './hooks/useFetchData'
import { fetchShots } from './services/nbaApi'
import styles from './App.module.css'

// How many rows go into the DOM at once. Each row is 9 cells, so rendering
// all 1,311 attempts would mean roughly 12,000 elements -- enough to make
// scrolling and every re-render visibly sluggish. Step 4 adds search and
// sort so you narrow the data down rather than scrolling through it.
const ROW_LIMIT = 100

// Describing columns as data rather than hard-coding <td>s keeps DataTable
// generic and puts every formatting decision for shots in one readable list.
const SHOT_COLUMNS = [
  { key: 'gameDate', header: 'Date' },
  {
    key: 'opponent',
    header: 'Opp',
    // Basketball convention: 'vs' at home, '@' away.
    format: (value, row) => `${row.isHome ? 'vs' : '@'} ${value}`,
  },
  { key: 'period', header: 'Qtr', align: 'right' },
  { key: 'clock', header: 'Clock', align: 'right' },
  { key: 'actionType', header: 'Action' },
  { key: 'zone', header: 'Zone' },
  {
    key: 'distanceFt',
    header: 'Dist',
    align: 'right',
    format: (value) => `${value} ft`,
  },
  {
    key: 'angleDeg',
    header: 'Angle',
    align: 'right',
    // null for shots at the rim, where an angle carries no meaning.
    format: (value) => (value == null ? '—' : `${value}°`),
  },
  {
    key: 'made',
    header: 'Result',
    format: (value) => (
      <span className={value ? styles.made : styles.missed}>
        {value ? 'Made' : 'Miss'}
      </span>
    ),
  },
]

function App() {
  const { data, error, isLoading } = useFetchData(fetchShots)

  const shots = data?.shots ?? []
  const visibleShots = shots.slice(0, ROW_LIMIT)

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
              <p className={styles.tableMeta}>
                Showing {visibleShots.length} of {shots.length.toLocaleString()}{' '}
                attempts, in game order.
              </p>

              <DataTable
                columns={SHOT_COLUMNS}
                rows={visibleShots}
                // Composed server-side from GAME_ID + GAME_EVENT_ID, so it is
                // unique and stable regardless of how the array is ordered.
                getRowKey={(shot) => shot.id}
                caption={`Field-goal attempts by ${data.meta.player}, ${data.meta.season}`}
              />
            </section>
          </>
        )}
      </main>
    </div>
  )
}

export default App
