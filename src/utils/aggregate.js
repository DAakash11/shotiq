/* Aggregations that turn raw API records into chart-ready series.

   Deliberately kept out of the components: this is pure data logic with no
   React in it, so it can be unit-tested directly and the chart components
   stay presentational. Same split as sorting.js. */

/** Below this many attempts a field-goal percentage is mostly noise.
 *  At 25 attempts the 95% interval around a .500 shooter is roughly
 *  +/-20 percentage points, so anything under it is flagged rather than
 *  drawn as if it were comparable to a 500-attempt sample. */
export const MIN_ATTEMPTS = 25

/** stats.nba.com's zoneRange values, in court order.
 *
 *  These are the join key between a player's shots and the league averages
 *  the API returns alongside them -- both sides carry zoneRange, so the
 *  comparison needs no lookup table.
 *
 *  'Back Court Shot' is deliberately absent: those are buzzer heaves, and
 *  including them would say something about the clock, not about shooting. */
export const DISTANCE_BANDS = [
  { key: 'Less Than 8 ft.', label: 'Less than 8 ft' },
  { key: '8-16 ft.', label: '8-16 ft' },
  { key: '16-24 ft.', label: '16-24 ft' },
  { key: '24+ ft.', label: '24+ ft' },
]

/** A rate is undefined with no attempts -- null, never 0.
 *  Zero would draw a bar claiming the player missed everything. */
function rate(made, attempts) {
  return attempts > 0 ? made / attempts : null
}

function addTo(totals, key, made, attempts) {
  const running = totals.get(key) ?? { made: 0, attempts: 0 }
  running.made += made
  running.attempts += attempts
  totals.set(key, running)
}

/** Player and league shooting per distance band, ready to stack.
 *
 *  Returns every band in court order even when the player never shot from
 *  one, so the chart keeps a stable shape between players and seasons. */
export function shootingByDistance(shots, leagueAverages) {
  const player = new Map()
  for (const shot of shots ?? []) {
    addTo(player, shot.zoneRange, shot.made ? 1 : 0, 1)
  }

  /* The league rate has to be re-derived from raw makes and attempts.
     Averaging the per-row fgPct values is the classic error: the league
     rows are split by court area, so a 9-attempt backcourt row would
     count as much as a 26,000-attempt one. On 2025-26 that mistake moves
     'Above the Break 3' from a true .350 to a reported .429. */
  const league = new Map()
  for (const row of leagueAverages ?? []) {
    addTo(league, row.zoneRange, row.fgm ?? 0, row.fga ?? 0)
  }

  return DISTANCE_BANDS.map(({ key, label }) => {
    const { made, attempts } = player.get(key) ?? { made: 0, attempts: 0 }
    const leagueTotals = league.get(key)

    const fgPct = rate(made, attempts)
    const leagueFgPct = leagueTotals
      ? rate(leagueTotals.made, leagueTotals.attempts)
      : null

    return {
      key,
      label,
      attempts,
      made,
      missed: attempts - made,
      fgPct,
      leagueFgPct,
      // How many of these SAME attempts a league-average shooter makes.
      // The chart marks this on the bar, so the gap between the mark and
      // the colour boundary is the player's edge counted in shots -- a
      // more concrete quantity than a percentage-point difference.
      leagueMade: leagueFgPct != null ? leagueFgPct * attempts : null,
      // Percentage points, not a ratio -- '+12.7pt', not '1.28x'.
      diff: fgPct != null && leagueFgPct != null ? fgPct - leagueFgPct : null,
      isLowSample: attempts > 0 && attempts < MIN_ATTEMPTS,
    }
  })
}

/** '0-2 Feet - Very Tight' -> '0-2 ft', '22-18 Very Early' -> '22-18'.
 *
 *  Axis ticks have no room for the descriptive tail. The full label is kept
 *  on the row so the tooltip can still show it. */
export function shortLabel(label) {
  const range = String(label ?? '').match(/^\d+[-+]\d*/)
  if (!range) return label ?? ''
  return /feet/i.test(label) ? `${range[0]} ft` : range[0]
}

/** Normalise one tracking split (defender distance, shot clock, ...) into a
 *  chart series. Rows arrive from the API already in sortOrder. */
export function splitSeries(rows) {
  return (rows ?? [])
    /* stats.nba.com emits an unlabelled shot-clock row -- null range, null
       sortOrder -- for attempts taken with the shot clock off. It carries
       real attempts and zero makes, and 0 is not null, so it survives the
       fgPct check in SplitChart and draws a zero-height bar under a blank
       axis tick. A bucket with no name cannot be plotted honestly. */
    /* Trimmed, because a whitespace-only label is truthy and would pass a
       plain emptiness check while still being no name at all. */
    .filter((row) => String(row.label ?? '').trim())
    .map((row) => {
      const attempts = row.fga ?? 0
      return {
        label: shortLabel(row.label),
        fullLabel: row.label,
        attempts,
        made: row.fgm ?? 0,
        // Left as null where the player took no such shot. The API is
        // explicit about this and the chart must not redraw it as 0%.
        fgPct: row.fgPct ?? null,
        efgPct: row.efgPct ?? null,
        frequency: row.frequency ?? null,
        isLowSample: attempts > 0 && attempts < MIN_ATTEMPTS,
      }
    })
}
