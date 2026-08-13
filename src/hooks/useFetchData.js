import { useEffect, useState } from 'react'

/**
 * Runs an async fetcher and tracks its lifecycle as React state.
 *
 * @param {(signal: AbortSignal) => Promise<unknown>} fetcher
 *   Must accept an AbortSignal and pass it to fetch.
 * @returns {{ data: unknown, error: Error | null, isLoading: boolean }}
 *
 * IMPORTANT -- `fetcher` must have a stable identity across renders.
 * Pass a function declared at module scope (like fetchShots), not one
 * defined inline in the component body. An inline arrow function is a
 * brand new object on every render, so the dependency array below would
 * see a change every time, re-run the effect, set state, trigger another
 * render, and loop forever. If you ever need an inline fetcher, wrap it
 * in useCallback first.
 */
export function useFetchData(fetcher) {
  // Three pieces of state rather than one object, so each can update
  // independently without clobbering the others.
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    // A fresh controller per effect run. The cleanup function returned
    // below aborts the request, which does two useful things:
    //
    //  1. A response arriving after the component unmounts never calls
    //     setState on something that no longer exists.
    //  2. In development, StrictMode deliberately mounts, unmounts and
    //     remounts every component to surface missing cleanup. Without
    //     this abort, both requests would race and either could win.
    const controller = new AbortController()

    setIsLoading(true)
    setError(null)

    fetcher(controller.signal)
      .then((result) => {
        setData(result)
        setIsLoading(false)
      })
      .catch((thrown) => {
        // An abort is us cancelling on purpose, not a failure. Showing an
        // error for it would mean every StrictMode remount flashed a
        // spurious error message.
        if (thrown.name === 'AbortError') return
        setError(thrown)
        setIsLoading(false)
      })

    return () => controller.abort()
  }, [fetcher])

  return { data, error, isLoading }
}
