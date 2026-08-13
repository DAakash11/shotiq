import StatusMessage from './components/StatusMessage'
import { useFetchData } from './hooks/useFetchData'
import { fetchShots } from './services/nbaApi'
import styles from './App.module.css'

function App() {
  // fetchShots is imported from module scope, so its identity is stable and
  // the hook's effect runs once rather than on every render.
  const { data, error, isLoading } = useFetchData(fetchShots)

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
          <section className={styles.summary}>
            <h2 className={styles.summaryHeading}>
              {data.meta.player} — {data.meta.season} {data.meta.seasonType}
            </h2>

            <p>
              Loaded <strong>{data.shots.length.toLocaleString()}</strong> shot
              records: {data.meta.made.toLocaleString()} made from{' '}
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
        )}
      </main>
    </div>
  )
}

export default App
