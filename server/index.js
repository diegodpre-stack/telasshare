import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { WebSocketServer, WebSocket } from 'ws'
import crypto from 'node:crypto'

const app = express()
const origin = process.env.CLIENT_ORIGIN || 'http://localhost:5173'
app.use(cors({ origin: origin.split(',').map((value) => value.trim()) }))
app.use(express.json({ limit: '16kb' }))
app.get('/health', (_req, res) => res.json({ ok: true }))

const sessionSecret = process.env.SESSION_SECRET || (!process.env.RENDER ? 'local-development-session-secret' : '')
const roomPassword = process.env.ROOM_PASSWORD || (!process.env.RENDER ? 'entretelas' : '')
const adminPasswords = [1, 2, 3, 4].map((number) => process.env[`ADMIN_PASSWORD_${number}`]).filter(Boolean)
const loginAttempts = new Map()
const signSession = (payload) => {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signature = crypto.createHmac('sha256', sessionSecret).update(body).digest('base64url')
  return `${body}.${signature}`
}
const verifySession = (token) => {
  if (!sessionSecret || typeof token !== 'string') return null
  const [body, signature] = token.split('.')
  if (!body || !signature) return null
  const expected = crypto.createHmac('sha256', sessionSecret).update(body).digest()
  let supplied
  try { supplied = Buffer.from(signature, 'base64url') } catch { return null }
  if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) return null
  try { const payload = JSON.parse(Buffer.from(body, 'base64url')); return payload.exp > Date.now() ? payload : null } catch { return null }
}

app.post('/api/login', (req, res) => {
  if (!roomPassword || !sessionSecret) return res.status(503).json({ error: 'A senha da sala ainda não foi configurada.' })
  const ip = req.ip || req.socket.remoteAddress || 'unknown'
  const now = Date.now(); const recent = (loginAttempts.get(ip) || []).filter((time) => now - time < 10 * 60 * 1000)
  if (recent.length >= 10) return res.status(429).json({ error: 'Muitas tentativas. Aguarde dez minutos.' })
  const name = typeof req.body?.name === 'string' ? req.body.name.trim().replace(/\s+/g, ' ').slice(0, 32) : ''
  const password = typeof req.body?.password === 'string' ? req.body.password : ''
  const matches = (expected) => password.length === expected.length && crypto.timingSafeEqual(Buffer.from(password), Buffer.from(expected))
  const role = adminPasswords.some(matches) ? 'admin' : 'member'
  const valid = role === 'admin' || matches(roomPassword)
  if (name.length < 2 || !valid) { recent.push(now); loginAttempts.set(ip, recent); return res.status(401).json({ error: 'Usuário ou senha incorretos.' }) }
  loginAttempts.delete(ip)
  res.json({ session: signSession({ sub: crypto.randomUUID(), name, role, exp: now + 30 * 24 * 60 * 60 * 1000 }), role })
})

const here = dirname(fileURLToPath(import.meta.url))
const dist = join(here, '..', 'dist')
app.use(express.static(dist))
app.get('*', (req, res, next) => req.path.startsWith('/health') ? next() : res.sendFile(join(dist, 'index.html'), (error) => error && next()))

const tls = process.env.TLS_CERT_PATH && process.env.TLS_KEY_PATH
  ? { cert: readFileSync(process.env.TLS_CERT_PATH), key: readFileSync(process.env.TLS_KEY_PATH) }
  : null
const server = tls ? createHttpsServer(tls, app) : createHttpServer(app)
const wss = new WebSocketServer({ server, maxPayload: 128 * 1024 })
const clients = new Map()
const bannedNames = new Set()
const allowedTypes = new Set(['hello', 'broadcast-start', 'broadcast-stop', 'watch-request', 'moderate', 'signal', 'stop'])

const safeSend = (socket, message) => {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
}
const publicUsers = () => [...clients.values()].map(({ id, name, role, broadcasting }) => ({ id, name, role, broadcasting }))
const broadcastUsers = () => {
  const message = { type: 'users', users: publicUsers() }
  for (const { socket } of clients.values()) safeSend(socket, message)
}
const cleanName = (value) => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, 32) : ''
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const validDescription = (value) => isObject(value) && ['offer', 'answer'].includes(value.type) && typeof value.sdp === 'string' && value.sdp.length < 100_000
const validCandidate = (value) => value === null || (isObject(value) && (value.candidate === undefined || typeof value.candidate === 'string'))
const validConnectionId = (value) => typeof value === 'string' && /^[a-zA-Z0-9-]{8,64}$/.test(value)

wss.on('connection', (socket, request) => {
  const sessionToken = new URL(request.url, 'http://localhost').searchParams.get('session')
  const authenticated = verifySession(sessionToken)
  if (!authenticated) { socket.close(1008, 'Login necessário'); return }
  const id = crypto.randomUUID()
  let registered = false
  socket.on('message', (raw) => {
    let message
    try { message = JSON.parse(raw.toString()) } catch { return safeSend(socket, { type: 'error', message: 'Mensagem inválida.' }) }
    if (!isObject(message) || !allowedTypes.has(message.type)) return safeSend(socket, { type: 'error', message: 'Tipo de mensagem inválido.' })
    if (!registered) {
      if (message.type !== 'hello') return safeSend(socket, { type: 'error', message: 'Identifique-se primeiro.' })
      const name = cleanName(authenticated.name)
      if (name.length < 2) return safeSend(socket, { type: 'error', message: 'Use um nome com pelo menos 2 caracteres.' })
      if (clients.size >= 5) { safeSend(socket, { type: 'room-full', message: 'A sala atingiu o limite de 5 pessoas.' }); return socket.close(1008, 'Sala cheia') }
      if (bannedNames.has(name.toLocaleLowerCase('pt-BR'))) { safeSend(socket, { type: 'banned' }); return socket.close(1008, 'Banido') }
      if ([...clients.values()].some((client) => client.name.toLocaleLowerCase('pt-BR') === name.toLocaleLowerCase('pt-BR'))) {
        safeSend(socket, { type: 'error', message: 'Este nome de usuário já está online.' }); return socket.close(1008, 'Nome em uso')
      }
      clients.set(id, { id, name, role: authenticated.role === 'admin' ? 'admin' : 'member', broadcasting: false, socket })
      registered = true
      safeSend(socket, { type: 'welcome', id, role: authenticated.role === 'admin' ? 'admin' : 'member' })
      return broadcastUsers()
    }
    const sender = clients.get(id)
    if (message.type === 'broadcast-start') { sender.broadcasting = true; return broadcastUsers() }
    if (message.type === 'broadcast-stop') { sender.broadcasting = false; return broadcastUsers() }
    const target = typeof message.to === 'string' ? clients.get(message.to) : null
    if (!target || target.id === id) return safeSend(socket, { type: 'error', message: 'Usuário indisponível.' })

    if (message.type === 'watch-request') {
      if (!target.broadcasting) return safeSend(socket, { type: 'error', message: 'Esta transmissão não está mais disponível.' })
      return safeSend(target.socket, { type: 'watch-request', from: id, fromName: sender.name })
    }
    if (message.type === 'moderate') {
      if (sender.role !== 'admin' || !['kick', 'ban'].includes(message.action)) return safeSend(socket, { type: 'error', message: 'Ação não autorizada.' })
      if (message.action === 'ban') bannedNames.add(target.name.toLocaleLowerCase('pt-BR'))
      safeSend(target.socket, { type: message.action === 'ban' ? 'banned' : 'kicked' })
      target.socket.close(1008, message.action === 'ban' ? 'Banido' : 'Expulso')
      return
    }
    if (message.type === 'signal') {
      if (!validConnectionId(message.connectionId)) return safeSend(socket, { type: 'error', message: 'Identificador de transmissão inválido.' })
      const descriptionOk = message.description === undefined || validDescription(message.description)
      const candidateOk = message.candidate === undefined || validCandidate(message.candidate)
      if (!descriptionOk || !candidateOk || (message.description === undefined && message.candidate === undefined)) return safeSend(socket, { type: 'error', message: 'Sinal WebRTC inválido.' })
      return safeSend(target.socket, { type: 'signal', from: id, connectionId: message.connectionId, description: message.description, candidate: message.candidate })
    }
    if (message.type === 'stop') {
      if (!validConnectionId(message.connectionId)) return safeSend(socket, { type: 'error', message: 'Identificador de transmissão inválido.' })
      return safeSend(target.socket, { type: 'stop', from: id, connectionId: message.connectionId })
    }
  })
  socket.on('close', () => {
    if (!registered) return
    clients.delete(id)
    for (const { socket: peerSocket } of clients.values()) safeSend(peerSocket, { type: 'peer-left', id })
    broadcastUsers()
  })
  socket.on('error', () => socket.close())
})

const port = Number(process.env.PORT || 8787)
const host = process.env.HOST || '0.0.0.0'
server.listen(port, host, () => console.log(`Signaling server on ${tls ? 'https' : 'http'}://${host}:${port}`))
