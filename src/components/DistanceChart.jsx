import {
  Bar,
  BarChart,
  CartesianGrid,
  Rectangle,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

import styles from './ChartCard.module.css'

/* Shooting by distance band, as stacked attempt counts.
 *
 * Bar length is ATTEMPTS, not a percentage. That is the whole point of the
 * chart: a 100%-stacked version would make every bar the same length and
 * the missed segment pure redundancy, since misses are just 100 minus
 * makes. Using attempts means the length carries shot selection -- how
 * often he goes to that range -- while the colour boundary carries
 * accuracy. Two facts, one mark.
 *
 * The tick on each bar is where the boundary would sit if he shot exactly
 * league average on the same volume, so the visible gap is his edge
 * counted in shots. */

// Gap between the made and missed segments, so the boundary reads as an
// edge rather than the two fills bleeding into each other.
const SEGMENT_GAP = 2
const CORNER = 4

const pct = (value) => (value == null ? '—' : `${(value * 100).toFixed(1)}%`)
const signed = (value) =>
  value == null ? '—' : `${value > 0 ? '+' : ''}${(value * 100).toFixed(1)} pt`

/** Custom shapes receive the row either as `payload` or spread onto props,
 *  depending on the Recharts version. Read it one way. */
const rowOf = (props) => props.payload ?? props

/* MadeSegment and MissedSegment are exported for the unit tests. They are
   plain functions of geometry plus a row, so the tick arithmetic can be
   checked without standing up a chart. */
export function MadeSegment(props) {
  const { width } = props
  const row = rowOf(props)
  const gap = width > SEGMENT_GAP ? SEGMENT_GAP : 0

  return (
    <Rectangle
      {...props}
      width={Math.max(width - gap, 0)}
      fill="var(--color-made)"
      // A band with too few attempts is drawn faintly rather than dropped,
      // so the reader can see it exists without reading it as comparable.
      fillOpacity={row.isLowSample ? 0.45 : 1}
      // Only round the outer end if there is no missed segment after it.
      radius={row.missed > 0 ? 0 : [0, CORNER, CORNER, 0]}
    />
  )
}

export function MissedSegment(props) {
  const { x, y, width, height } = props
  const { made, missed, leagueMade } = rowOf(props)

  const rect = (
    <Rectangle
      {...props}
      fill="var(--color-missed-fill)"
      radius={[0, CORNER, CORNER, 0]}
    />
  )

  // The league tick is drawn HERE, on the last segment, purely for z-order.
  // Recharts paints bars in the order they are declared, so a tick drawn by
  // the made segment would be painted over by this rectangle whenever the
  // player shoots below league average and the mark lands in the grey.
  // Drawing it last means it is visible either side of the boundary.
  if (leagueMade == null || missed <= 0 || width <= 0) return rect

  // This segment spans `missed` shots across `width` pixels, which is the
  // scale for the whole bar. The tick sits `leagueMade - made` shots from
  // the boundary: negative (into the green) when he is above average.
  const pxPerShot = width / missed
  const tickX = x + (leagueMade - made) * pxPerShot
  const top = y - 4
  const bottom = y + height + 4

  return (
    <g>
      {rect}
      {/* A surface-coloured halo under the tick keeps it legible where it
          crosses the boundary between the two fills. */}
      <line
        x1={tickX}
        x2={tickX}
        y1={top}
        y2={bottom}
        stroke="var(--color-surface)"
        strokeWidth={5}
        strokeLinecap="round"
      />
      <line
        x1={tickX}
        x2={tickX}
        y1={top}
        y2={bottom}
        stroke="var(--chart-reference)"
        strokeWidth={2}
        strokeLinecap="round"
      />
    </g>
  )
}

function DistanceTooltip({ active, payload }) {
  if (!active || !payload?.length) return null

  const row = payload[0].payload
  const rows = [
    ['Attempts', row.attempts.toLocaleString()],
    ['Made', row.made.toLocaleString()],
    ['FG%', pct(row.fgPct)],
    ['League FG%', pct(row.leagueFgPct)],
    ['Difference', signed(row.diff)],
  ]

  return (
    <div className={styles.tooltip}>
      <p className={styles.tooltipTitle}>{row.label}</p>
      {rows.map(([label, value]) => (
        <p key={label} className={styles.tooltipRow}>
          <span>{label}</span>
          <span className={styles.tooltipValue}>{value}</span>
        </p>
      ))}
      {row.leagueMade != null && (
        <p className={styles.tooltipRow}>
          <span>League makes on {row.attempts.toLocaleString()} attempts</span>
          <span className={styles.tooltipValue}>
            {Math.round(row.leagueMade).toLocaleString()}
          </span>
        </p>
      )}
      {row.isLowSample && (
        <p className={styles.tooltipWarning}>
          Small sample — treat this percentage as indicative only.
        </p>
      )}
    </div>
  )
}

/**
 * @param {Array<object>} bands  Output of shootingByDistance.
 * @param {string} playerName    Used in the accessible summary.
 */
function DistanceChart({ bands, playerName }) {
  const shooting = bands.filter((band) => band.attempts > 0)

  if (shooting.length === 0) return null

  return (
    <>
      {/* Recharts draws an <svg>, which a screen reader cannot read. The
          same numbers go out as text, hidden visually. */}
      <p className={styles.srOnly}>
        {playerName} by distance:{' '}
        {shooting
          .map(
            (band) =>
              `${band.label}, ${band.made} of ${band.attempts} (${pct(band.fgPct)}), ` +
              `league ${pct(band.leagueFgPct)}`,
          )
          .join('. ')}
        .
      </p>

      <div aria-hidden="true">
        <ResponsiveContainer width="100%" height={40 + shooting.length * 52}>
          <BarChart
            layout="vertical"
            data={shooting}
            margin={{ top: 4, right: 12, bottom: 16, left: 0 }}
            barCategoryGap={14}
            // Recharts otherwise renders the <svg> as role="application"
            // with tabindex="0". Inside the aria-hidden wrapper above, that
            // is a keyboard trap in miniature: a Tab lands on an element
            // deliberately hidden from screen readers, so it announces
            // nothing. The text summary above replaces it, and says more
            // than the built-in layer would.
            accessibilityLayer={false}
          >
            {/* Vertical rules only. Horizontal ones would cut through the
                bars they are meant to sit behind. */}
            <CartesianGrid horizontal={false} stroke="var(--chart-grid)" />
            <XAxis
              type="number"
              tick={{ fill: 'var(--color-text-muted)', fontSize: 12 }}
              axisLine={{ stroke: 'var(--color-border)' }}
              tickLine={false}
              label={{
                value: 'attempts',
                position: 'insideBottom',
                offset: -8,
                fill: 'var(--color-text-muted)',
                fontSize: 12,
              }}
            />
            <YAxis
              type="category"
              dataKey="label"
              width={104}
              tick={{ fill: 'var(--color-text)', fontSize: 12 }}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              content={<DistanceTooltip />}
              cursor={{ fill: 'var(--chart-grid)' }}
            />
            {/* Animation off: the chart re-renders on every player and
                season change, and replaying a grow-in each time reads as
                the page stuttering rather than as feedback. */}
            <Bar
              dataKey="made"
              stackId="shots"
              shape={<MadeSegment />}
              isAnimationActive={false}
            />
            <Bar
              dataKey="missed"
              stackId="shots"
              shape={<MissedSegment />}
              isAnimationActive={false}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className={styles.legend}>
        <span className={styles.legendItem}>
          <span className={`${styles.swatch} ${styles.swatchMade}`} />
          Made
        </span>
        <span className={styles.legendItem}>
          <span className={`${styles.swatch} ${styles.swatchMissed}`} />
          Missed
        </span>
        <span className={styles.legendItem}>
          <span className={styles.swatchReference} />
          League average on the same attempts
        </span>
      </div>
    </>
  )
}

export default DistanceChart
