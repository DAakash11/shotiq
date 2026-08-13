import styles from './SearchBar.module.css'

/**
 * A controlled search input.
 *
 * "Controlled" means the input has no memory of its own: `value` comes
 * from the parent's state and every keystroke calls `onChange` to update
 * it. React state is the single source of truth, so the Clear button can
 * empty the field simply by setting state -- no DOM manipulation, no refs.
 */
function SearchBar({ id = 'shot-search', label, value, onChange, placeholder, hint }) {
  return (
    <div className={styles.wrap}>
      {/* htmlFor pairs the label with the input, so clicking the label
          focuses the field and screen readers announce the two together. */}
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>

      <div className={styles.field}>
        <input
          id={id}
          type="search"
          className={styles.input}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          autoComplete="off"
        />

        {value && (
          <button type="button" className={styles.clear} onClick={() => onChange('')}>
            Clear
          </button>
        )}
      </div>

      {/* aria-live announces the updated match count to screen readers as
          the user types, since the visual change happens far from focus. */}
      <p className={styles.hint} aria-live="polite">
        {hint}
      </p>
    </div>
  )
}

export default SearchBar
