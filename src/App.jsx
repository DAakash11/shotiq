import { useCallback, useMemo, useState } from 'react'

import AiSummary from './components/AiSummary'
import ChartCard from './components/ChartCard'
import DataTable from './components/DataTable'
import DistanceChart from './components/DistanceChart'
import PlayerPicker from './components/PlayerPicker'
import SearchBar from './components/SearchBar'
import SeasonSelect from './components/SeasonSelect'
import SplitChart from './components/SplitChart'
import StatusMessage from './components/StatusMessage'
import { useFetchData } from './hooks/useFetchData'
import { fetchSeasons, fetchShots, fetchSplits } from './services/nbaApi'
import { shootingByDistance, splitSeries } from './utils/aggregate'
import { sortRows } from './utils/sorting'
import styles from './App.module.css'

// How many rows go into the DOM at once. Each row is 9 cells, so rendering
// all ~1,300 attempts would mean roughly 12,000 elements -- enough to make
// scrolling and every re-render visibly sluggish. Search narrows the data
// instead.
const ROW_LIMIT = 100

// Declared once at module scope so the "no data yet" cases return the SAME
// array on every render. Writing `?? []` inline would build a brand new
// empty array each time, and that changed reference would invalidate the
// useMemo below on every single render.
const NO_SHOTS = []
const NO_SEASONS = []
const NO_LEAGUE_AVERAGES = []

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
  // null means "let the API pick" -- the first request omits both
  // parameters and the server applies its own defaults, so the client
  // never has to hard-code who the featured player is.
  const [subject, setSubject] = useState(null)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState({ key: null, direction: 'asc' })

  // THIS is why useFetchData insists on a stable fetcher. The request now
  // depends on component state, so it cannot be a module-scope function --
  // but an inline arrow would be a new object every render, and the hook's
  // effect would refetch forever. useCallback returns the same function
  // until `subject` actually changes, which is exactly when we DO want a
  // refetch. Changing the player or season swaps the identity, the effect
  // re-runs, and the previous request is aborted mid-flight.
  const loadShots = useCallback((signal) => fetchShots(subject ?? {}, signal), [subject])
  const loadSplits = useCallback((signal) => fetchSplits(subject ?? {}, signal), [subject])

  const { data, error, isLoading } = useFetchData(loadShots)
  // The two requests are independent, so they run in parallel rather than
  // one waiting on the other. Tracking splits are also allowed to fail on
  // their own: the charts that need them disappear, the rest of the page
  // carries on.
  const { data: splitData } = useFetchData(loadSplits)
  // fetchSeasons takes no arguments and lives at module scope, so it needs
  // no useCallback -- the same hook handles both cases.
  const { data: seasonData } = useFetchData(fetchSeasons)

  // The user's pending choice wins over the loaded data, so the controls
  // reflect what was clicked immediately rather than snapping back to the
  // previous player while the new request is still in flight.
  const currentPlayerId = subject?.playerId ?? data?.meta.playerId
  const currentPlayerName = subject?.playerName ?? data?.meta.player
  const currentSeason = subject?.season ?? data?.meta.season

  const seasons = seasonData?.seasons ?? NO_SEASONS
  const shots = data?.shots ?? NO_SHOTS
  const leagueAverages = data?.leagueAverages ?? NO_LEAGUE_AVERAGES

  // Chart data is derived the same way the table's is -- computed during
  // render, never stored. The aggregation walks every shot, so it is worth
  // memoising: without this it would re-run on each keystroke in the search
  // box, which changes nothing the charts display.
  const distanceBands = useMemo(
    () => shootingByDistance(shots, leagueAverages),
    [shots, leagueAverages],
  )
  const defenderRows = useMemo(
    () => splitSeries(splitData?.splits?.defenderDistance),
    [splitData],
  )
  const shotClockRows = useMemo(
    () => splitSeries(splitData?.splits?.shotClock),
    [splitData],
  )

  // The season's own FG%, drawn on the split charts so each bucket reads
  // against how he shoots overall rather than against nothing.
  const seasonFgPct = splitData?.overall?.fgPct ?? data?.meta?.fgPct ?? null

  // Derived state: computed during render from the data plus the user's
  // input. Storing the filtered rows in their own useState would create a
  // second source of truth that has to be manually kept in sync -- forget
  // one setState and the table silently shows stale results.
  const matchingShots = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const filtered = needle
      ? shots.filter((shot) => matchesQuery(shot, needle))
      : shots

    return sortRows(filtered, sort.key, sort.direction)
  }, [shots, query, sort])

  const visibleShots = matchingShots.slice(0, ROW_LIMIT)
  const sortedColumnHeader = SHOT_COLUMNS.find(
    (column) => column.key === sort.key,
  )?.header

  function handlePlayerSelect(player) {
    setSubject({
      playerId: player.id,
      playerName: player.name,
      season: currentSeason,
    })
  }

  function handleSeasonChange(season) {
    setSubject({
      playerId: currentPlayerId,
      playerName: currentPlayerName,
      season,
    })
  }

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
        <section className={styles.controls}>
          <PlayerPicker currentName={currentPlayerName} onSelect={handlePlayerSelect} />
          <SeasonSelect
            seasons={seasons}
            value={currentSeason}
            onChange={handleSeasonChange}
            disabled={isLoading}
          />
        </section>

        {isLoading && (
          <StatusMessage title={`Loading ${currentPlayerName ?? 'shot'} data…`}>
            A player and season we have not fetched before comes straight from
            stats.nba.com, which can take several seconds. It is cached afterwards.
          </StatusMessage>
        )}

        {error && (
          <StatusMessage tone="error" title="Could not load shot data">
            {error.message} — check the API is running on port 8000.
          </StatusMessage>
        )}

        {data && !isLoading && (
          <>
            <section className={styles.summary}>
              <h2 className={styles.summaryHeading}>
                {data.meta.player} — {data.meta.season} {data.meta.seasonType}
              </h2>

              {shots.length === 0 ? (
                <p>
                  No field-goal attempts recorded. {data.meta.player} may not have
                  played in {data.meta.season}.
                </p>
              ) : (
                <p>
                  {data.meta.made.toLocaleString()} made from{' '}
                  {data.meta.attempts.toLocaleString()} attempts
                  {data.meta.fgPct != null &&
                    ` (${(data.meta.fgPct * 100).toFixed(1)}% FG)`}
                  {data.meta.team && ` · ${data.meta.team}`}.
                </p>
              )}

              <p className={styles.source}>
                Served from {data.meta.source} · league averages loaded for{' '}
                {data.leagueAverages.length} zones
                {!data.meta.hasTracking && ' · no player tracking this season'}
                {data.meta.warning && ` · ${data.meta.warning}`}
              </p>
            </section>

            {shots.length > 0 && (
              <div className={styles.charts}>
                <ChartCard
                  title="Shooting by distance"
                  description="Bar length is attempts, so the chart shows where he shoots as well as how well. The tick marks where the colour boundary would fall if he shot league average on the same attempts."
                  footnote={
                    distanceBands.some((band) => band.isLowSample)
                      ? 'Faded bars have too few attempts to read as a rate.'
                      : undefined
                  }
                >
                  <DistanceChart
                    bands={distanceBands}
                    playerName={data.meta.player}
                  />
                </ChartCard>

                {!data.meta.hasTracking ? (
                  <StatusMessage title="No tracking data for this season">
                    Defender distance and shot clock come from player tracking,
                    which the NBA only began recording in 2013-14.
                  </StatusMessage>
                ) : (
                  <div className={styles.chartRow}>
                    {defenderRows.length > 0 && (
                      <ChartCard
                        title="Under pressure"
                        description="How the closest defender changes his accuracy. A lower percentage when wide open usually means those attempts are threes — check eFG% in the tooltip."
                      >
                        <SplitChart
                          rows={defenderRows}
                          baseline={seasonFgPct}
                          axisLabel="closest defender"
                          bucketLabel="Defender distance"
                          playerName={data.meta.player}
                        />
                      </ChartCard>
                    )}

                    {shotClockRows.length > 0 && (
                      <ChartCard
                        title="Against the clock"
                        description="Seconds left on the shot clock when the ball goes up. The last bucket is where possessions break down and someone has to force one."
                      >
                        <SplitChart
                          rows={shotClockRows}
                          baseline={seasonFgPct}
                          axisLabel="seconds left on the shot clock"
                          bucketLabel="Shot clock"
                          playerName={data.meta.player}
                        />
                      </ChartCard>
                    )}
                  </div>
                )}
              </div>
            )}

            {shots.length > 0 && (
              /* The key is doing real work. Changing it unmounts the old
                 panel and mounts a fresh one, which resets its state for
                 free -- no effect watching props, and no summary of the
                 previous player lingering under the new one's name while
                 a request is in flight. Resetting state by remounting is
                 usually cleaner than resetting it by hand. */
              <AiSummary
                key={`${data.meta.playerId}-${data.meta.season}`}
                className={styles.summarySection}
                playerId={data.meta.playerId}
                season={data.meta.season}
                playerName={data.meta.player}
              />
            )}

            {shots.length > 0 && (
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
            )}
          </>
        )}
      </main>
    </div>
  )
}

export default App
