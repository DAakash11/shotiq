import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // In development React is served from :5173 and the Python API from
    // :8000. Proxying /api keeps every request same-origin, so the browser
    // never needs CORS and our frontend code can use plain relative paths
    // like fetch('/api/shots') -- the exact same paths that will work in
    // production behind nginx at step 7. No environment-specific URLs.
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
})
