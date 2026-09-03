import { createServer } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { AccessToken, TrackSource } from 'livekit-server-sdk'

const root = dirname(fileURLToPath(import.meta.url))
const executable = join(root, 'runtime', 'livekit-server.exe')
if (!existsSync(executable)) throw new Error('Execute setup.ps1 primeiro.')
const apiKey = 'localtest'
const secret = randomBytes(32).toString('hex')
const allowedOrigin = 'http://localhost:8790'
// Deliberately loopback-only: no public token endpoint, cloud TURN, or production credentials.
const config = JSON.stringify({
  port: 7880, bind_addresses: ['127.0.0.1'],
  rtc: { tcp_port: 7881, udp_port: 7882, use_external_ip: false, enable_loopback_candidate: true },
  keys: { [apiKey]: secret },
  room: { max_participants: 8, empty_timeout: 30 },
  logging: { level: 'warn' },
})
const child = spawn(executable, [], { cwd: root, windowsHide: true, env: { ...process.env, LIVEKIT_CONFIG: config }, stdio: ['ignore', 'inherit', 'inherit'] })
let stopping = false
const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ws://localhost:7880; media-src 'self' blob:; frame-ancestors 'none'")
  if (req.headers.host !== 'localhost:8790') { res.writeHead(403); return res.end('Use http://localhost:8790') }
  if (req.method === 'POST' && req.url === '/token') {
    if (req.headers.origin !== allowedOrigin) { res.writeHead(403); return res.end() }
    try {
      let body = ''
      for await (const chunk of req) { body += chunk; if (body.length > 2048) { res.writeHead(413); res.end(); return } }
      const { name } = JSON.parse(body)
      if (typeof name !== 'string' || !name.trim() || name.length > 32) { res.writeHead(400); return res.end() }
      const token = new AccessToken(apiKey, secret, { identity: randomUUID(), name: name.trim(), ttl: '10m' })
      token.addGrant({ roomJoin: true, room: 'teste-local', canPublish: true, canSubscribe: true, canPublishData: false, canPublishSources: [TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO] })
      res.setHeader('Content-Type', 'application/json')
      return res.end(JSON.stringify({ token: await token.toJwt(), url: 'ws://localhost:7880' }))
    } catch { res.writeHead(400); return res.end('Pedido invalido') }
  }
  const files = { '/': ['web/index.html', 'text/html; charset=utf-8'], '/main.js': ['dist/main.js', 'text/javascript'], '/style.css': ['web/style.css', 'text/css'] }
  if (req.method !== 'GET' || !files[req.url]) { res.writeHead(404); return res.end() }
  try { const [file, type] = files[req.url]; res.setHeader('Content-Type', type); res.end(readFileSync(join(root, file))) }
  catch { res.writeHead(503); res.end('Execute npm run build antes de iniciar.') }
})
function stop(code = 0) { if (stopping) return; stopping = true; child.kill(); server.close(); setTimeout(() => process.exit(code), 500).unref() }
child.on('error', (error) => { console.error(error.message); stop(1) })
child.on('exit', (code) => { if (!stopping) { console.error('Servidor de midia encerrou:', code); stop(1) } })
server.on('error', (error) => { console.error(error.message); stop(1) })
process.on('SIGINT', () => stop())
process.on('SIGTERM', () => stop())
server.listen(8790, '127.0.0.1', () => console.log('Teste local: http://localhost:8790 — abra duas abas. Ctrl+C encerra ambos os servidores.'))
