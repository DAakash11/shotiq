import { useEffect, useState } from 'react'

import { searchPlayers } from '../services/nbaApi'
import styles from './PlayerPicker.module.css'

// Wait for a pause in typing before calling the API. The shot table's
// search filters an array already in memory, so it can run on every
// keystroke; this one crosses the network, so it should not.
const DEBOUNCE_MS = 250
const MIN_QUERY_LENGTH = 2

/**
 * Search for an NBA player by name and pick one.
 *
 * @param {string} currentName  Name of the player currently being analysed.
 * @param {(player: { id: number, name: string }) => void} onSelect
 */
function PlayerPicker({ currentName, onSelect }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [error, setError] = useState(null)

  useEffect(() => {
    const trimmed = query.trim()

    if (trimmed.length < MIN_QUERY_LENGTH) {
      setResults([])
      setError(null)
      return
    }

    const controller = new AbortController()

    const timer = setTimeout(() => {
      searchPlayers(trimmed, controller.signal)
        .then((payload) => {
          setResults(payload.players)
          setError(null)
        })
        .catch((thrown) => {
          if (thrown.name === 'AbortError') return
          setError(thrown)
        })
    }, DEBOUNCE_MS)

    // Cleanup runs before the next effect and on unmount. Cancelling the
    // pending timer is what actually makes the debounce work: each new
    // keystroke throws away the previous scheduled request before it fires.
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [query])

  function handleSelect(player) {
    onSelect(player)
    setQuery('')
    setResults([])
  }

  return (
    <div className={styles.wrap}>
      <label className={styles.label} htmlFor="player-search">
        Player
      </label>

      <input
        id="player-search"
        type="search"
        className={styles.input}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={currentName ? `${currentName} — type to change` : 'Search players…'}
        autoComplete="off"
      />

      {results.length > 0 && (
        <ul className={styles.results}>
          {results.map((player) => (
            <li key={player.id}>
              <button
                type="button"
                className={styles.result}
                onClick={() => handleSelect(player)}
              >
                <span>{player.name}</span>
                {!player.isActive && <span className={styles.retired}>retired</span>}
              </button>
            </li>
          ))}
        </ul>
      )}

      <p className={styles.hint} aria-live="polite">
        {error
          ? `Search failed: ${error.message}`
          : query.trim().length >= MIN_QUERY_LENGTH && results.length === 0
            ? `No players match “${query.trim()}”.`
            : 'Type at least two letters to search.'}
      </p>
    </div>
  )
}

export default PlayerPicker
