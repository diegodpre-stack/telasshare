import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const cert = env.VITE_HTTPS_CERT_PATH
  const key = env.VITE_HTTPS_KEY_PATH
  return {
    plugins: [react()],
    server: {
      host: '0.0.0.0',
      port: 5173,
      https: cert && key ? { cert: fs.readFileSync(cert), key: fs.readFileSync(key) } : undefined,
    },
  }
})
