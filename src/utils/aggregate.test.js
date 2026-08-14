import { describe, expect, it } from 'vitest'

import {
  DISTANCE_BANDS,
  MIN_ATTEMPTS,
  shootingByDistance,
  shortLabel,
  splitSeries,
} from './aggregate'

const shot = (zoneRange, made) => ({ zoneRange, made })

/** Repeat a shot n times -- keeps the fixtures readable. */
const shots = (zoneRange, attempts, made) => [
  ...Array.from({ length: made }, () => shot(zoneRange, true)),
  ...Array.from({ length: attempts - made }, () => shot(zoneRange, false)),
]

const bandOf = (result, label) => result.find((band) => band.label === label)

describe('shootingByDistance', () => {
  it('returns every band in court order, including ones never shot from', () => {
    const result = shootingByDistance(shots('24+ ft.', 10, 4), [])

    expect(result.map((band) => band.label)).toEqual(
      DISTANCE_BANDS.map((band) => band.label),
    )
  })

  it('counts makes and misses per band', () => {
    const result = shootingByDistance(
      [...shots('8-16 ft.', 100, 57), ...shots('24+ ft.', 50, 20)],
      [],
    )

    expect(bandOf(result, '8-16 ft')).toMatchObject({
      attempts: 100,
      made: 57,
      missed: 43,
      fgPct: 0.57,
    })
    expect(bandOf(result, '24+ ft')).toMatchObject({ attempts: 50, made: 20 })
  })

  it('derives the league rate from raw totals rather than averaging percentages', () => {
    // The trap this pins down: the league rows are split by court area, so a
    // band contains one tiny row and one enormous one. Averaging the two
    // percentages weights them equally and lands nowhere near the truth.
    const leagueAverages = [
      { zoneRange: '24+ ft.', fgm: 6, fga: 9 }, //     .667 on 9 attempts
      { zoneRange: '24+ ft.', fgm: 9342, fga: 26514 }, // .352 on 26,514
    ]

    const { leagueFgPct } = bandOf(
      shootingByDistance(shots('24+ ft.', 10, 4), leagueAverages),
      '24+ ft',
    )

    // 9348 / 26523
    expect(leagueFgPct).toBeCloseTo(0.352, 3)
    // Not the mean of .667 and .352, which would be .510.
    expect(leagueFgPct).not.toBeCloseTo(0.51, 2)
  })

  it('reports the gap in percentage points', () => {
    const { diff } = bandOf(
      shootingByDistance(shots('8-16 ft.', 100, 57), [
        { zoneRange: '8-16 ft.', fgm: 446, fga: 1000 },
      ]),
      '8-16 ft',
    )

    expect(diff).toBeCloseTo(0.124, 3)
  })

  it('leaves an unshot band null rather than zero', () => {
    const band = bandOf(shootingByDistance([], []), '16-24 ft')

    // 0 would draw a bar claiming the player missed everything.
    expect(band.fgPct).toBeNull()
    expect(band.attempts).toBe(0)
    expect(band.isLowSample).toBe(false)
  })

  it('leaves diff null when the league has no row for the band', () => {
    const { diff, fgPct } = bandOf(
      shootingByDistance(shots('24+ ft.', 10, 4), []),
      '24+ ft',
    )

    expect(fgPct).toBeCloseTo(0.4)
    expect(diff).toBeNull()
  })

  it('excludes backcourt heaves, which say nothing about shooting', () => {
    const result = shootingByDistance(
      [...shots('Back Court Shot', 5, 1), ...shots('24+ ft.', 10, 4)],
      [],
    )

    const total = result.reduce((sum, band) => sum + band.attempts, 0)
    expect(total).toBe(10)
  })

  it('flags a band below the sample threshold', () => {
    const result = shootingByDistance(
      [
        ...shots('24+ ft.', MIN_ATTEMPTS - 1, 10),
        ...shots('8-16 ft.', MIN_ATTEMPTS, 10),
      ],
      [],
    )

    expect(bandOf(result, '24+ ft').isLowSample).toBe(true)
    expect(bandOf(result, '8-16 ft').isLowSample).toBe(false)
  })

  it('survives missing inputs', () => {
    expect(() => shootingByDistance(undefined, undefined)).not.toThrow()
    expect(shootingByDistance(undefined, undefined)).toHaveLength(
      DISTANCE_BANDS.length,
    )
  })
})

describe('splitSeries', () => {
  it('keeps a null percentage null instead of coercing it to zero', () => {
    // The API returns null where the player took no such shot -- e.g. no
    // threes with a defender inside two feet. Drawing that as 0% would
    // invent a miss that never happened.
    const [row] = splitSeries([
      { label: '0-2 Feet - Very Tight', fga: 70, fgm: 35, fgPct: 0.5, fg3Pct: null },
    ])

    expect(row.fgPct).toBe(0.5)
    expect(row.efgPct).toBeNull()
  })

  it('keeps the full label alongside the shortened one', () => {
    const [row] = splitSeries([{ label: '6+ Feet - Wide Open', fga: 167 }])

    expect(row.label).toBe('6+ ft')
    expect(row.fullLabel).toBe('6+ Feet - Wide Open')
  })

  it('flags a bucket below the sample threshold', () => {
    const [tiny, big] = splitSeries([
      { label: '24-22', fga: 8, fgm: 5 },
      { label: '15-7 Average', fga: 588, fgm: 326 },
    ])

    expect(tiny.isLowSample).toBe(true)
    expect(big.isLowSample).toBe(false)
  })

  it('returns an empty series for a season with no tracking data', () => {
    expect(splitSeries(undefined)).toEqual([])
    expect(splitSeries([])).toEqual([])
  })
})

describe('shortLabel', () => {
  it.each([
    ['0-2 Feet - Very Tight', '0-2 ft'],
    ['6+ Feet - Wide Open', '6+ ft'],
    ['22-18 Very Early', '22-18'],
    ['4-0 Very Late', '4-0'],
    ['24-22', '24-22'],
    ['Touch < 2 Seconds', 'Touch < 2 Seconds'],
    [undefined, ''],
  ])('turns %s into %s', (input, expected) => {
    expect(shortLabel(input)).toBe(expected)
  })
})
