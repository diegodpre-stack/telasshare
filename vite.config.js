import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const cert = env.VITE_HTTPS_CERT_PATH
  const key = env.VITE_HTTPS_KEY_PATH
  // The desktop app loads the deployed site, so its two halves update on separate schedules and a
  // stale one is invisible from the screen. Stamp the build in so the page can say which it is.
  // Falls back to a timestamp rather than a fixed word: a stamp that never changes cannot answer the
  // question it exists for, and would look identical on a fresh deploy and a stale one.
  const commit = (process.env.RENDER_GIT_COMMIT || env.RENDER_GIT_COMMIT || '').slice(0, 7)
  const build = commit || new Date().toISOString().slice(5, 16).replace('T', ' ')
  return {
    define: { __BUILD_ID__: JSON.stringify(build) },
    plugins: [react()],
    server: {
      host: '0.0.0.0',
      port: 5173,
      https: cert && key ? { cert: fs.readFileSync(cert), key: fs.readFileSync(key) } : undefined,
    },
  }
})
