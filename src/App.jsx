import styles from './App.module.css'

function App() {
  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <h1 className={styles.title}>
          Shot<span className={styles.titleAccent}>IQ</span>
        </h1>
        <p className={styles.tagline}>
          NBA shot analytics — distance, angle, defender pressure and shot clock.
        </p>
      </header>

      <main>
        <p className={styles.placeholder}>Data layer arrives in step 1.</p>
      </main>
    </div>
  )
}

export default App
