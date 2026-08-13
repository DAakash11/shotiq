import { afterEach, describe, expect, it, vi } from 'vitest'

import { fetchShots, searchPlayers } from './nbaApi'

/** Stub global fetch with a canned response and return the spy. */
function stubFetch({ body = {}, ok = true, status = 200, jsonThrows = false } = {}) {
  const spy = vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => {
      if (jsonThrows) throw new Error('not JSON')
      return body
    },
  })
  vi.stubGlobal('fetch', spy)
  return spy
}

const requestedUrl = (spy) => spy.mock.calls[0][0]

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchShots', () => {
  it('sends no query string when no subject is given, letting the API default', async () => {
    const spy = stubFetch({ body: { shots: [] } })
    await fetchShots({})
    expect(requestedUrl(spy)).toBe('/api/shots')
  })

  it('includes playerId and season when they are set', async () => {
    const spy = stubFetch({ body: { shots: [] } })
    await fetchShots({ playerId: 203999, season: '2021-22' })
    expect(requestedUrl(spy)).toBe('/api/shots?playerId=203999&season=2021-22')
  })

  it('forwards the abort signal so requests can be cancelled', async () => {
    const spy = stubFetch({ body: { shots: [] } })
    const controller = new AbortController()
    await fetchShots({}, controller.signal)
    expect(spy.mock.calls[0][1].signal).toBe(controller.signal)
  })

  it('throws on an HTTP error, which fetch alone would not do', async () => {
    // The whole reason getJson checks response.ok: a 400 resolves
    // successfully, so without the check the error body would be treated
    // as data.
    stubFetch({
      ok: false,
      status: 400,
      body: { detail: 'Season 2099-00 has not started yet' },
    })

    await expect(fetchShots({})).rejects.toThrow(/400.*has not started yet/)
  })

  it('still throws when the error body is not JSON', async () => {
    stubFetch({ ok: false, status: 500, jsonThrows: true })
    await expect(fetchShots({})).rejects.toThrow(/500/)
  })
})

describe('searchPlayers', () => {
  it('url-encodes the query', async () => {
    const spy = stubFetch({ body: { players: [] } })
    await searchPlayers('shai gilgeous')
    expect(requestedUrl(spy)).toBe('/api/players?q=shai%20gilgeous')
  })
})
