// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { Bar, BarChart, XAxis, YAxis } from 'recharts'

import { MissedSegment } from './DistanceChart'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

/** A band where the player is above league average: 57 of 100, against a
 *  league rate of .446 -- so 44.6 makes on the same attempts. */
const aboveAverage = {
  label: '8-16 ft',
  attempts: 100,
  made: 57,
  missed: 43,
  fgPct: 0.57,
  leagueFgPct: 0.446,
  leagueMade: 44.6,
  diff: 0.124,
  isLowSample: false,
}

/* Geometry as Recharts hands it to the missed segment: the bar starts at
   x=65 and runs 5.3px per shot, so the missed rectangle opens where the
   57 makes end. */
const geometry = { x: 367.1, y: 21, width: 227.9, height: 128 }
const PX_PER_SHOT = geometry.width / aboveAverage.missed
const BAR_START = geometry.x - aboveAverage.made * PX_PER_SHOT

const tickXOf = (element) => {
  const children = element.props.children
  if (!Array.isArray(children)) return null
  const lines = children.filter((child) => child?.type === 'line')
  return lines.length ? lines.at(-1).props.x1 : null
}

describe('MissedSegment league tick', () => {
  it('places the tick at the league make count, not the player’s', () => {
    const tickX = tickXOf(MissedSegment({ ...geometry, payload: aboveAverage }))

    // Independently: bar start, plus 44.6 shots' worth of pixels.
    expect(tickX).toBeCloseTo(BAR_START + 44.6 * PX_PER_SHOT, 5)
  })

  it('puts the tick inside the made segment when above league average', () => {
    const tickX = tickXOf(MissedSegment({ ...geometry, payload: aboveAverage }))

    // Left of the colour boundary -- the green overshoots the league mark.
    expect(tickX).toBeLessThan(geometry.x)
    expect(tickX).toBeGreaterThan(BAR_START)
  })

  it('puts the tick inside the missed segment when below league average', () => {
    // Same volume, but only 38 makes against a league 44.6.
    const below = { ...aboveAverage, made: 38, missed: 62, leagueMade: 44.6 }
    const geo = { ...geometry, x: 266.4, width: 328.6 }

    const tickX = tickXOf(MissedSegment({ ...geo, payload: below }))

    // Right of the boundary. This is the case that forced the tick to be
    // drawn by the LAST segment: drawn by the made segment it would be
    // painted over by the missed rectangle and vanish exactly when it
    // matters most.
    expect(tickX).toBeGreaterThan(geo.x)
  })

  it('draws no tick when the league has no baseline for the band', () => {
    const element = MissedSegment({
      ...geometry,
      payload: { ...aboveAverage, leagueMade: null },
    })

    expect(tickXOf(element)).toBeNull()
  })

  it('draws no tick when the player made every attempt', () => {
    // No missed segment means no pixel scale to derive, and nothing to
    // divide by.
    const element = MissedSegment({
      ...geometry,
      width: 0,
      payload: { ...aboveAverage, made: 100, missed: 0 },
    })

    expect(tickXOf(element)).toBeNull()
  })
})

describe('recharts integration', () => {
  it('still hands the row to a custom shape', async () => {
    // Guards the assumption the tick maths rests on. If a Recharts upgrade
    // stops passing the row, every tick silently lands at the wrong place
    // rather than throwing, so this needs its own test.
    let seen = null

    const host = document.createElement('div')
    document.body.appendChild(host)

    await act(async () => {
      createRoot(host).render(
        <BarChart layout="vertical" width={600} height={200} data={[aboveAverage]}>
          <XAxis type="number" />
          <YAxis type="category" dataKey="label" />
          <Bar dataKey="made" stackId="s" isAnimationActive={false} />
          <Bar
            dataKey="missed"
            stackId="s"
            isAnimationActive={false}
            shape={(props) => {
              seen = props
              return MissedSegment(props)
            }}
          />
        </BarChart>,
      )
    })

    expect(seen?.payload).toMatchObject({ made: 57, missed: 43, leagueMade: 44.6 })

    // And the tick made it into the DOM, left of the colour boundary.
    const tick = host.querySelector('line[stroke="var(--chart-reference)"]')
    expect(tick).not.toBeNull()
    expect(Number(tick.getAttribute('x1'))).toBeLessThan(seen.x)
  })
})
