import styles from './StatusMessage.module.css'

/**
 * Shared presentation for loading, empty and error states.
 *
 * Every async feature in the app needs these three states, so they live in
 * one component rather than being re-invented per feature.
 */
function StatusMessage({ tone = 'info', title, children }) {
  return (
    <div
      className={`${styles.message} ${styles[tone]}`}
      // Screen readers announce role="alert" immediately and role="status"
      // politely. Errors interrupt; progress updates wait their turn.
      role={tone === 'error' ? 'alert' : 'status'}
    >
      <p className={styles.title}>{title}</p>
      {children ? <p className={styles.detail}>{children}</p> : null}
    </div>
  )
}

export default StatusMessage
