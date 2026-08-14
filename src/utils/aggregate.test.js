import { readFileSync } from 'node:fs'
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

  it('expresses the league rate as makes on the same volume', () => {
    // 100 attempts at a league rate of .446 is 44.6 makes, against the
    // player's 57 -- an edge of roughly 12 shots over the season.
    const band = bandOf(
      shootingByDistance(shots('8-16 ft.', 100, 57), [
        { zoneRange: '8-16 ft.', fgm: 446, fga: 1000 },
      ]),
      '8-16 ft',
    )

    expect(band.leagueMade).toBeCloseTo(44.6, 1)
    expect(band.made - band.leagueMade).toBeCloseTo(12.4, 1)
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

/* The numbers below are also asserted, to the same precision, by
   server/tests/test_analytics.py against this same file.

   server/analytics.py duplicates this module in Python, because the summary
   endpoint must re-derive its own numbers rather than trust anything the
   client posts. Two implementations can drift silently, so both are pinned
   to one real fixture: change either one in a way that moves these values
   and exactly one suite goes red, naming the side that moved. */
describe('agreement with the Python twin', () => {
  const cache = (name) =>
    JSON.parse(readFileSync(new URL(`../../server/cache/${name}`, import.meta.url), 'utf-8'))

  const shotsPayload = cache('shots-1628983-2025-26.json')
  const bands = shootingByDistance(shotsPayload.shots, shotsPayload.leagueAverages)

  it('pins the 8-16 ft band for the default subject', () => {
    const band = bandOf(bands, '8-16 ft')

    expect(band.fgPct).toBeCloseTo(0.573, 3)
    expect(band.leagueFgPct).toBeCloseTo(0.446, 3)
    expect(band.diff * 100).toBeCloseTo(12.7, 1)
  })

  it('accounts for every attempt in the season', () => {
    // Backcourt heaves are excluded by design, and he took none in 2025-26,
    // so the bands should add up to the season total exactly.
    const total = bands.reduce((sum, band) => sum + band.attempts, 0)

    expect(total).toBe(shotsPayload.meta.attempts)
    expect(total).toBe(1321)
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
