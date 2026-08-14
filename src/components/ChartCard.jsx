import styles from './ChartCard.module.css'

/**
 * Consistent framing for a chart: heading, one line of context, the plot,
 * and an optional footnote.
 *
 * Charts are the one place in this app where a reader has to be told what
 * they are looking at, so the title and description are required structure
 * rather than something each chart re-invents. Keeping the frame here also
 * means the chart components below only ever draw data.
 *
 * @param {string} title
 * @param {import('react').ReactNode} [description]  One line: what to read.
 * @param {import('react').ReactNode} children  The chart itself.
 * @param {import('react').ReactNode} [footnote]  Caveats, e.g. sample size.
 */
function ChartCard({ title, description, children, footnote }) {
  return (
    <section className={styles.card}>
      <h3 className={styles.title}>{title}</h3>
      {description && <p className={styles.description}>{description}</p>}

      <div className={styles.plot}>{children}</div>

      {footnote && <p className={styles.footnote}>{footnote}</p>}
    </section>
  )
}

export default ChartCard
