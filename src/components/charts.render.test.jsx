// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeAll, describe, expect, it } from 'vitest'

import DistanceChart from './DistanceChart'
import SplitChart from './SplitChart'
import { shootingByDistance, splitSeries } from '../utils/aggregate'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

/* ResponsiveContainer measures its parent, and jsdom reports every element
   as 0x0, so without this the charts mount to nothing. Reporting a fixed
   size is enough to get real geometry out of Recharts. */
beforeAll(() => {
  globalThis.ResizeObserver = class {
    constructor(callback) {
      this.callback = callback
    }
    observe(target) {
      this.callback([{ target, contentRect: { width: 720, height: 300 } }], this)
    }
    unobserve() {}
    disconnect() {}
  }

  for (const prop of ['offsetWidth', 'offsetHeight', 'clientWidth', 'clientHeight']) {
    Object.defineProperty(HTMLElement.prototype, prop, {
      configurable: true,
      value: prop.includes('Width') ? 720 : 300,
    })
  }
})

async function render(element) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  await act(async () => {
    createRoot(host).render(element)
  })
  return host
}

const bands = shootingByDistance(
  [
    ...Array.from({ length: 57 }, () => ({ zoneRange: '8-16 ft.', made: true })),
    ...Array.from({ length: 43 }, () => ({ zoneRange: '8-16 ft.', made: false })),
    ...Array.from({ length: 4 }, () => ({ zoneRange: '24+ ft.', made: true })),
    ...Array.from({ length: 6 }, () => ({ zoneRange: '24+ ft.', made: false })),
  ],
  [
    { zoneRange: '8-16 ft.', fgm: 446, fga: 1000 },
    { zoneRange: '24+ ft.', fgm: 360, fga: 1000 },
  ],
)

describe('DistanceChart', () => {
  it('states the numbers in text for screen readers, not only in the svg', async () => {
    const host = await render(<DistanceChart bands={bands} playerName="Test Player" />)

    const summary = host.textContent
    expect(summary).toContain('Test Player by distance')
    expect(summary).toContain('57 of 100 (57.0%)')
    expect(summary).toContain('league 44.6%')
  })

  it('draws a league tick for every band it plots', async () => {
    const host = await render(<DistanceChart bands={bands} playerName="Test Player" />)

    const ticks = host.querySelectorAll('line[stroke="var(--chart-reference)"]')
    expect(ticks).toHaveLength(2)
  })

  it('renders nothing at all for a player with no attempts', async () => {
    const empty = shootingByDistance([], [])
    const host = await render(<DistanceChart bands={empty} playerName="Nobody" />)

    expect(host.querySelector('svg')).toBeNull()
  })
})

describe('SplitChart', () => {
  const rows = splitSeries([
    { label: '0-2 Feet - Very Tight', fga: 70, fgm: 35, fgPct: 0.5, efgPct: 0.5 },
    { label: '2-4 Feet - Tight', fga: 531, fgm: 312, fgPct: 0.588, efgPct: 0.6 },
    { label: '6+ Feet - Wide Open', fga: 167, fgm: 80, fgPct: 0.479, efgPct: 0.56 },
  ])

  it('plots a bar per bucket with the value printed on it', async () => {
    const host = await render(
      <SplitChart rows={rows} baseline={0.553} playerName="Test Player" />,
    )

    const text = host.textContent
    expect(text).toContain('50.0%')
    expect(text).toContain('58.8%')
    expect(text).toContain('47.9%')
    // The season baseline is labelled on the reference line.
    expect(text).toContain('season 55.3%')
  })

  it('keeps the short axis labels and the long ones', async () => {
    const host = await render(<SplitChart rows={rows} playerName="Test Player" />)

    // Axis ticks are shortened...
    expect(host.textContent).toContain('0-2 ft')
    // ...while the accessible summary keeps the full description.
    expect(host.textContent).toContain('0-2 Feet - Very Tight')
  })

  it('skips buckets the player never shot from', async () => {
    // fgPct null means no such attempt, which must not become a zero bar.
    const withGap = splitSeries([
      { label: '0-2 Feet - Very Tight', fga: 0, fgm: 0, fgPct: null },
      { label: '2-4 Feet - Tight', fga: 531, fgm: 312, fgPct: 0.588 },
    ])

    const host = await render(<SplitChart rows={withGap} playerName="Test Player" />)

    expect(host.textContent).toContain('58.8%')
    expect(host.textContent).not.toContain('0.0%')
  })

  it('renders nothing when the season predates tracking', async () => {
    const host = await render(<SplitChart rows={[]} playerName="Test Player" />)

    expect(host.querySelector('svg')).toBeNull()
  })
})
