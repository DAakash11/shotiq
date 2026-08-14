// All network access lives in this folder. Components never call fetch
// directly -- they call these functions, or a hook that wraps them. That
// keeps request details in one place and makes components testable without
// a network.
//
// Paths are relative on purpose: Vite proxies /api to the Python service in
// development, and nginx will proxy it in production. Same code either way.

// fetch() only rejects on network-level failure. A 404 or 500 still
// resolves successfully, so without this check server errors would sail
// through and land in our state as if they were data.
async function unwrap(response, path) {
  if (response.ok) return response.json()

  let detail = ''
  try {
    const body = await response.json()
    if (typeof body?.detail === 'string') {
      detail = `: ${body.detail}`
    } else if (body?.detail) {
      // FastAPI's own validation errors arrive as an ARRAY of objects, not
      // a string. Interpolating that directly prints "[object Object]",
      // which tells the user nothing at all.
      const first = Array.isArray(body.detail) ? body.detail[0] : body.detail
      if (first?.msg) detail = `: ${first.msg}`
    }
  } catch {
    // Body wasn't JSON. The status code alone will have to do.
  }

  const error = new Error(`Request to ${path} failed (${response.status})${detail}`)
  // Carried so callers can tell apart states that mean different things to
  // a user -- 503 "this deployment does not generate summaries" is not the
  // same news as 502 "the model failed, try again".
  error.status = response.status
  throw error
}

function getJson(path, signal) {
  return fetch(path, { headers: { Accept: 'application/json' }, signal }).then(
    (response) => unwrap(response, path),
  )
}

function postJson(path, body, signal) {
  return fetch(path, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  }).then((response) => unwrap(response, path))
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

/** The AI scouting note. POST, not GET, because on a cache miss the server
 *  spends money and writes a file -- and because a GET would invite the
 *  browser to prefetch it on hover.
 *
 *  The body carries identifiers only. The server rejects anything else and
 *  recomputes every number the model sees, so the client cannot influence
 *  what goes into the prompt. */
export function fetchSummary({ playerId, season } = {}, signal) {
  const body = {}
  if (playerId != null) body.playerId = playerId
  if (season) body.season = season
  return postJson('/api/summary', body, signal)
}
