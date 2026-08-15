// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import AiSummary from './AiSummary'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const SUMMARY = {
  headline: 'A mid-range season with few peers.',
  strengths: ['57.3% from 8-16 ft on 412 attempts.', '65.6% inside 8 ft.'],
  watch: ['38.0% with four seconds or fewer on the clock.'],
  context: 'Pull-ups account for 57.2% of his attempts.',
  meta: { model: 'gemini-3.7-flash', source: 'cache' },
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }
}

let host

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
})

afterEach(() => {
  vi.unstubAllGlobals()
  host.remove()
})

async function render(element) {
  await act(async () => {
    createRoot(host).render(element)
  })
}

async function clickButton() {
  const button = host.querySelector('button')
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  return button
}

describe('AiSummary', () => {
  it('does not request anything until asked', async () => {
    // The whole reason this does not use useFetchData. A summary can cost
    // money to produce, so it must never fire just because a page loaded.
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    await render(<AiSummary playerId={1} season="2025-26" playerName="Test" />)

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(host.textContent).toContain("Test's shooting season")
  })

  it('posts identifiers only, never anything the model could read', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse(SUMMARY))
    vi.stubGlobal('fetch', fetchSpy)

    await render(<AiSummary playerId={1628983} season="2025-26" />)
    await clickButton()

    const [path, options] = fetchSpy.mock.calls[0]
    expect(path).toBe('/api/summary')
    expect(options.method).toBe('POST')
    expect(JSON.parse(options.body)).toEqual({
      playerId: 1628983,
      season: '2025-26',
    })
  })

  it('renders every field of the note', async () => {
    vi.stubGlobal('fetch', async () => jsonResponse(SUMMARY))

    await render(<AiSummary playerId={1} season="2025-26" />)
    await clickButton()

    const text = host.textContent
    expect(text).toContain('A mid-range season with few peers.')
    expect(text).toContain('57.3% from 8-16 ft on 412 attempts.')
    expect(text).toContain('38.0% with four seconds or fewer on the clock.')
    expect(text).toContain('Pull-ups account for 57.2%')
  })

  it('labels the two lists by the role they play, not by a topic', async () => {
    // Regression test. The `watch` field holds whatever the data shows to
    // be a genuine weakness: a shot-clock bucket for one player, a
    // distance band for another. A topic-specific heading is therefore
    // wrong for every summary whose concern happens to be about something
    // else -- and nothing else in the suite would notice, because the
    // items themselves still render correctly underneath it.
    vi.stubGlobal('fetch', async () => jsonResponse(SUMMARY))

    await render(<AiSummary playerId={1} season="2025-26" />)
    await clickButton()

    const headings = [...host.querySelectorAll('h4')].map((h) => h.textContent)
    expect(headings).toEqual(['Strengths', 'Concerns'])
  })

  it('says who wrote it', async () => {
    // A reader should never have to wonder whether a person wrote this.
    vi.stubGlobal('fetch', async () => jsonResponse(SUMMARY))

    await render(<AiSummary playerId={1} season="2025-26" />)
    await clickButton()

    expect(host.textContent).toContain('Written by gemini-3.7-flash')
    expect(host.textContent).toContain('served from cache')
  })

  it('warns when the numbers have moved since it was written', async () => {
    vi.stubGlobal('fetch', async () =>
      jsonResponse({ ...SUMMARY, meta: { ...SUMMARY.meta, stale: true } }),
    )

    await render(<AiSummary playerId={1} season="2025-26" />)
    await clickButton()

    expect(host.textContent).toContain('the shot data has changed')
  })

  it('treats a disabled deployment as information, not an error', async () => {
    // 503 here means "this deployment does not generate summaries", which
    // is not the same news as "the app is broken", and must not be
    // flattened into a red error box.
    vi.stubGlobal('fetch', async () =>
      jsonResponse({ detail: 'Live generation is disabled' }, 503),
    )

    await render(<AiSummary playerId={1} season="2025-26" />)
    await clickButton()

    expect(host.textContent).toContain('No summary available for this player')
    expect(host.querySelector('[role="alert"]')).toBeNull()
    expect(host.querySelector('[role="status"]')).not.toBeNull()
  })

  it('offers to retry when the model itself failed', async () => {
    vi.stubGlobal('fetch', async () =>
      jsonResponse({ detail: 'could not be reached' }, 502),
    )

    await render(<AiSummary playerId={1} season="2025-26" />)
    await clickButton()

    expect(host.textContent).toContain('The model could not be reached')
    expect(host.textContent).toContain('Trying again often works')
    // An actual failure, so this one does interrupt a screen reader.
    expect(host.querySelector('[role="alert"]')).not.toBeNull()
  })

  it('explains an empty season rather than looking broken', async () => {
    vi.stubGlobal('fetch', async () =>
      jsonResponse({ detail: 'nothing to summarise' }, 422),
    )

    await render(<AiSummary playerId={1} season="2016-17" />)
    await clickButton()

    expect(host.textContent).toContain('Nothing to summarise')
  })

  it('reads FastAPI validation errors, which arrive as an array', async () => {
    // Interpolating that array directly prints "[object Object]".
    vi.stubGlobal('fetch', async () =>
      jsonResponse({ detail: [{ msg: 'Extra inputs are not permitted' }] }, 400),
    )

    await render(<AiSummary playerId={1} season="2025-26" />)
    await clickButton()

    expect(host.textContent).toContain('Extra inputs are not permitted')
    expect(host.textContent).not.toContain('object Object')
  })

  it('hides the button while a request is in flight', async () => {
    // Two clicks would mean two generations, and the second is pure waste.
    let resolve
    vi.stubGlobal('fetch', () => new Promise((r) => { resolve = r }))

    await render(<AiSummary playerId={1} season="2025-26" />)
    await clickButton()

    expect(host.querySelector('button')).toBeNull()
    expect(host.textContent).toContain('Writing the summary')

    await act(async () => {
      resolve(jsonResponse(SUMMARY))
    })

    expect(host.querySelector('button').textContent).toBe('Refresh')
  })
})
