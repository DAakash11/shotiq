import {
  Bar,
  BarChart,
  Cell,
  LabelList,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

import styles from './ChartCard.module.css'

/* One chart shape, two datasets.
 *
 * Defender distance and shot clock are the same question -- "does this
 * situation change how he shoots?" -- asked of different buckets, so they
 * are one component driven by its props rather than two near-identical
 * files. Same reasoning as DataTable: the component knows nothing about
 * what the buckets mean.
 *
 * Bars start at zero, always. A bar's length IS its value, so cropping the
 * axis to make differences look bigger misstates the data -- the one
 * shortcut that turns a bar chart into a lie. */

const pct = (value) => (value == null ? '—' : `${(value * 100).toFixed(1)}%`)

function SplitTooltip({ active, payload, bucketLabel }) {
  if (!active || !payload?.length) return null

  const row = payload[0].payload

  return (
    <div className={styles.tooltip}>
      <p className={styles.tooltipTitle}>{row.fullLabel}</p>
      {[
        [bucketLabel ?? 'Bucket', null],
        ['Attempts', row.attempts.toLocaleString()],
        ['Made', row.made.toLocaleString()],
        ['FG%', pct(row.fgPct)],
        // eFG% credits a three as worth 1.5 twos. Without it, a bucket full
        // of threes looks like worse shooting than it is.
        ['eFG%', pct(row.efgPct)],
        ['Share of attempts', pct(row.frequency)],
      ]
        .filter(([, value]) => value !== null)
        .map(([label, value]) => (
          <p key={label} className={styles.tooltipRow}>
            <span>{label}</span>
            <span className={styles.tooltipValue}>{value}</span>
          </p>
        ))}
      {row.isLowSample && (
        <p className={styles.tooltipWarning}>
          Only {row.attempts} attempts — too few to read as a rate.
        </p>
      )}
    </div>
  )
}

/**
 * @param {Array<object>} rows  Output of splitSeries.
 * @param {number|null} [baseline]  Season FG%, drawn as a reference line.
 * @param {string} [axisLabel]  What the buckets measure.
 * @param {string} [bucketLabel]  Heading for the tooltip.
 * @param {string} playerName  Used in the accessible summary.
 */
function SplitChart({ rows, baseline, axisLabel, bucketLabel, playerName }) {
  const plotted = rows.filter((row) => row.fgPct != null)

  if (plotted.length === 0) return null

  // Headroom above the tallest bar so the direct labels are not clipped,
  // rounded up to a tenth so the reference line lands on a sensible scale.
  const tallest = Math.max(...plotted.map((row) => row.fgPct), baseline ?? 0)
  const ceiling = Math.min(Math.ceil((tallest + 0.12) * 10) / 10, 1)

  return (
    <>
      <p className={styles.srOnly}>
        {playerName}, {axisLabel}:{' '}
        {plotted
          .map(
            (row) =>
              `${row.fullLabel}, ${pct(row.fgPct)} on ${row.attempts} attempts`,
          )
          .join('. ')}
        .
      </p>

      <div aria-hidden="true">
        <ResponsiveContainer width="100%" height={260}>
          <BarChart
            data={plotted}
            margin={{ top: 24, right: 8, bottom: 20, left: 8 }}
            // See DistanceChart: keeps the decorative <svg> out of the tab
            // order, since the text summary above carries the same content.
            accessibilityLayer={false}
          >
            <XAxis
              dataKey="label"
              tick={{ fill: 'var(--color-text)', fontSize: 12 }}
              axisLine={{ stroke: 'var(--color-border)' }}
              tickLine={false}
              interval={0}
              label={
                axisLabel && {
                  value: axisLabel,
                  position: 'insideBottom',
                  offset: -12,
                  fill: 'var(--color-text-muted)',
                  fontSize: 12,
                }
              }
            />
            {/* Hidden, but present: the axis is what fixes the domain, and
                the domain is what guarantees bars start at zero. Every value
                is printed on its own bar, so drawn ticks would only repeat
                what the labels already say. */}
            <YAxis hide domain={[0, ceiling]} />

            {baseline != null && (
              <ReferenceLine
                y={baseline}
                stroke="var(--chart-reference)"
                strokeDasharray="4 4"
                label={{
                  value: `season ${pct(baseline)}`,
                  position: 'right',
                  fill: 'var(--color-text-muted)',
                  fontSize: 11,
                }}
              />
            )}

            <Tooltip
              content={<SplitTooltip bucketLabel={bucketLabel} />}
              cursor={{ fill: 'var(--chart-grid)' }}
            />

            <Bar dataKey="fgPct" radius={[4, 4, 0, 0]} isAnimationActive={false}>
              {plotted.map((row) => (
                // Cell varies the fill per bar without a custom shape. Thin
                // samples are drawn faintly rather than hidden, so the
                // bucket still exists on the axis.
                <Cell
                  key={row.label}
                  fill="var(--color-made)"
                  fillOpacity={row.isLowSample ? 0.35 : 1}
                />
              ))}
              <LabelList
                dataKey="fgPct"
                position="top"
                formatter={pct}
                fill="var(--color-text)"
                fontSize={12}
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </>
  )
}

export default SplitChart
