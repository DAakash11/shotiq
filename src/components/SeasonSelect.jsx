import styles from './SeasonSelect.module.css'

/**
 * Season chooser.
 *
 * A native <select> rather than a custom dropdown: it is keyboard
 * accessible, screen-reader friendly and renders as a proper picker on
 * mobile, all for free. Thirty options do not justify rebuilding that.
 *
 * @param {Array<{ value: string, hasTracking: boolean }>} seasons
 * @param {string} [value]
 * @param {(season: string) => void} onChange
 */
function SeasonSelect({ seasons, value, onChange, disabled }) {
  const selected = seasons.find((season) => season.value === value)

  return (
    <div className={styles.wrap}>
      <label className={styles.label} htmlFor="season-select">
        Season
      </label>

      <select
        id="season-select"
        className={styles.select}
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled || seasons.length === 0}
      >
        {seasons.map((season) => (
          <option key={season.value} value={season.value}>
            {season.value}
            {season.hasTracking ? '' : ' · no tracking'}
          </option>
        ))}
      </select>

      <p className={styles.hint}>
        {selected && !selected.hasTracking
          ? 'Defender distance and shot clock data begins in 2013-14.'
          : 'Shot charts go back to 1996-97.'}
      </p>
    </div>
  )
}

export default SeasonSelect
