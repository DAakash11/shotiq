// All network access lives in this folder. Components never call fetch
// directly -- they call these functions, or a hook that wraps them. That
// keeps request details in one place and makes components testable without
// a network.
//
// Paths are relative on purpose: Vite proxies /api to the Python service in
// development, and nginx will proxy it in production. Same code either way.

async function getJson(path, signal) {
  const response = await fetch(path, {
    headers: { Accept: 'application/json' },
    signal,
  })

  // fetch() only rejects on network-level failure. A 404 or 500 still
  // resolves successfully, so without this check server errors would sail
  // through and land in our state as if they were data.
  if (!response.ok) {
    let detail = ''
    try {
      const body = await response.json()
      if (body?.detail) detail = `: ${body.detail}`
    } catch {
      // Body wasn't JSON. The status code alone will have to do.
    }
    throw new Error(`Request to ${path} failed (${response.status})${detail}`)
  }

  return response.json()
}

// Omitting playerId/season lets the API apply its own defaults, so the
// first load does not need the client to know who the featured player is.
function subjectQuery({ playerId, season } = {}) {
  const params = new URLSearchParams()
  if (playerId != null) params.set('playerId', String(playerId))
  if (season) params.set('season', season)
  const query = params.toString()
  return query ? `?${query}` : ''
}

export function fetchShots(subject, signal) {
  return getJson(`/api/shots${subjectQuery(subject)}`, signal)
}

export function fetchSplits(subject, signal) {
  return getJson(`/api/splits${subjectQuery(subject)}`, signal)
}

// Declared at module scope, so these two have a stable identity and can be
// handed straight to useFetchData. Anything that varies per render (the
// subject-dependent fetchers above) must be wrapped in useCallback instead.

export function fetchSeasons(signal) {
  return getJson('/api/seasons', signal)
}

export function searchPlayers(query, signal) {
  return getJson(`/api/players?q=${encodeURIComponent(query)}`, signal)
}
