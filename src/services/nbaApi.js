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

// These are declared at module scope, which gives each one a stable
// identity for the lifetime of the app. That matters -- see the dependency
// array note in hooks/useFetchData.js.

export function fetchShots(signal) {
  return getJson('/api/shots', signal)
}

export function fetchSplits(signal) {
  return getJson('/api/splits', signal)
}
