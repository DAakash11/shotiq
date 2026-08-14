import { useEffect, useRef, useState } from 'react'

import StatusMessage from './StatusMessage'
import { fetchSummary } from '../services/nbaApi'
import styles from './AiSummary.module.css'

/* An LLM-written note on the shooting season.
 *
 * Deliberately NOT built on useFetchData, which every other async feature
 * here uses. That hook fires on mount, which is right for data the page
 * exists to show -- and wrong for a request that can cost money. This one
 * waits to be asked.
 *
 * The component holds no summary logic of its own: it renders four fields
 * the server produced, and every number in them was computed server-side.
 * It cannot check them and does not try to. */

const IDLE = 'idle'
const LOADING = 'loading'
const READY = 'ready'
const FAILED = 'failed'

/** Turn a failed request into something worth reading.
 *
 *  The route answers with different codes for genuinely different
 *  situations, and flattening them into "something went wrong" would tell
 *  a visitor the app is broken when in fact this deployment simply does
 *  not generate summaries.
 */
function describe(error) {
  switch (error?.status) {
    case 503:
      return {
        tone: 'info',
        title: 'No summary available for this player',
        detail:
          'A written summary ships with the featured player. Generating one ' +
          'for anybody else needs an API key, which this deployment does not use.',
      }
    case 422:
      return {
        tone: 'info',
        title: 'Nothing to summarise',
        detail: 'There are no recorded attempts in this season to write about.',
      }
    case 502:
      return {
        tone: 'error',
        title: 'The model could not be reached',
        detail: 'This is usually temporary. Trying again often works.',
      }
    default:
      return {
        tone: 'error',
        title: 'Could not load the summary',
        detail: error?.message ?? 'Unknown error.',
      }
  }
}

/**
 * @param {number} [playerId]  Omitted means the API's default subject.
 * @param {string} [season]
 * @param {string} [playerName]  Display only.
 *
 * App gives this component a `key` built from the subject, so switching
 * player unmounts and remounts it. That resets every piece of state here
 * for free -- no effect watching props, no stale summary from the previous
 * player flashing up under the new one's name.
 */
function AiSummary({ playerId, season, playerName, className = '' }) {
  const [status, setStatus] = useState(IDLE)
  const [summary, setSummary] = useState(null)
  const [error, setError] = useState(null)

  // Held in a ref so the cleanup below can reach the in-flight request
  // without the identity of the controller triggering a re-render.
  const abortRef = useRef(null)

  // Abort on unmount. Switching player mid-request would otherwise leave a
  // response arriving after this component is gone, and React would warn
  // about setting state on something no longer mounted.
  useEffect(() => () => abortRef.current?.abort(), [])

  async function handleRequest() {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setStatus(LOADING)
    setError(null)

    try {
      const result = await fetchSummary({ playerId, season }, controller.signal)
      setSummary(result)
      setStatus(READY)
    } catch (caught) {
      // An abort is not a failure -- it means we deliberately gave up,
      // and something else is already driving the UI.
      if (caught.name === 'AbortError') return
      setError(caught)
      setStatus(FAILED)
    }
  }

  return (
    <section
      // Page spacing stays in App.module.css with every other section, so
      // this component is not the one deciding where it sits.
      className={`${styles.panel} ${className}`.trim()}
      aria-labelledby="ai-summary-heading"
    >
      <div className={styles.header}>
        <div>
          <h3 id="ai-summary-heading" className={styles.heading}>
            Scouting note
          </h3>
          <p className={styles.subheading}>
            Written by a language model from the numbers on this page, and
            nothing else.
          </p>
        </div>

        {status !== LOADING && (
          <button type="button" className={styles.button} onClick={handleRequest}>
            {status === READY || status === FAILED ? 'Refresh' : 'Read the note'}
          </button>
        )}
      </div>

      {status === IDLE && (
        <p className={styles.idle}>
          {playerName ? `${playerName}'s ` : 'This '}shooting season in a few
          sentences.
        </p>
      )}

      {status === LOADING && (
        <StatusMessage title="Writing the summary…">
          Reading the shot data and drafting a note. This takes a few seconds
          the first time; afterwards it is served from cache.
        </StatusMessage>
      )}

      {status === FAILED && (
        <StatusMessage tone={describe(error).tone} title={describe(error).title}>
          {describe(error).detail}
        </StatusMessage>
      )}

      {status === READY && summary && (
        <article className={styles.note}>
          <p className={styles.headline}>{summary.headline}</p>

          <div className={styles.columns}>
            <div>
              <h4 className={styles.listHeading}>Strengths</h4>
              <ul className={styles.list}>
                {summary.strengths.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>

            <div>
              <h4 className={styles.listHeading}>Watch</h4>
              <ul className={styles.list}>
                {summary.watch.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          </div>

          <p className={styles.context}>{summary.context}</p>

          <p className={styles.provenance}>
            {summary.meta?.model && `Written by ${summary.meta.model}`}
            {summary.meta?.source === 'cache' && ' · served from cache'}
            {/* Shown rather than hidden: the alternative is silently
                describing numbers that have since changed. */}
            {summary.meta?.stale &&
              ' · the shot data has changed since this was written'}
          </p>
        </article>
      )}
    </section>
  )
}

export default AiSummary
