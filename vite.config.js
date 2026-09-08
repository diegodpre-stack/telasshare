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
  // A deploy done by hand needs a name that can be said out loud and compared -- "oracle-3" answers
  // "did my F5 pick up the new one" in a way a UTC timestamp three hours off the reader's clock never
  // did. The timestamp stays as the fallback, because a stamp that never changes cannot answer the
  // question it exists for.
  const named = process.env.TELASSHARE_BUILD || env.TELASSHARE_BUILD || ''
  const commit = (process.env.RENDER_GIT_COMMIT || env.RENDER_GIT_COMMIT || '').slice(0, 7)
  const build = named || commit || new Date().toISOString().slice(5, 16).replace('T', ' ')
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
