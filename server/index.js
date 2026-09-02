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
const adminPasswords = [1, 2, 3, 4].map((number) => process.env[`ADMIN_PASSWORD_${number}`])
const loginAttempts = new Map()
const rooms = new Map()
const ROOM_SESSION_MS = 30 * 24 * 60 * 60 * 1000
const normalizeRoomName = (value) => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, 40) : ''
const roomKey = (name) => name.toLocaleLowerCase('pt-BR')
const hashPassword = (password, salt = crypto.randomBytes(16).toString('base64url')) => ({
  salt,
  hash: crypto.scryptSync(password, salt, 64).toString('base64url'),
})
const passwordMatches = (password, stored) => {
  if (typeof password !== 'string' || !stored?.salt || !stored?.hash) return false
  const actual = crypto.scryptSync(password, stored.salt, 64)
  const expected = Buffer.from(stored.hash, 'base64url')
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected)
}
const secretMatches = (password, expected) => typeof password === 'string' && typeof expected === 'string' && password.length === expected.length && crypto.timingSafeEqual(Buffer.from(password), Buffer.from(expected))
const cleanUserName = (value) => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, 32) : ''
const rateLimitLogin = (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown'
  const now = Date.now()
  const recent = (loginAttempts.get(ip) || []).filter((time) => now - time < 10 * 60 * 1000)
  if (recent.length >= 10) { res.status(429).json({ error: 'Muitas tentativas. Aguarde dez minutos.' }); return null }
  return { ip, now, recent }
}
const readBearerSession = (req, kind = 'site') => {
  const header = req.get('authorization') || ''
  const session = verifySession(header.startsWith('Bearer ') ? header.slice(7) : '')
  return session?.kind === kind ? session : null
}
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
  if (!sessionSecret) return res.status(503).json({ error: 'O acesso ao site ainda não foi configurado.' })
  const attempt = rateLimitLogin(req, res); if (!attempt) return
  const name = cleanUserName(req.body?.name)
  const adminPassword = typeof req.body?.adminPassword === 'string' ? req.body.adminPassword : ''
  let role = 'member'
  if (adminPassword) {
    if (adminPasswords[0] && secretMatches(adminPassword, adminPasswords[0])) role = 'superadmin'
    else if (adminPasswords.slice(1).some((password) => secretMatches(adminPassword, password))) role = 'admin'
    else role = 'invalid'
  }
  if (name.length < 2 || role === 'invalid') {
    attempt.recent.push(attempt.now); loginAttempts.set(attempt.ip, attempt.recent)
    return res.status(401).json({ error: 'Usuário ou senha incorretos.' })
  }
  loginAttempts.delete(attempt.ip)
  res.json({ session: signSession({ kind: 'site', sub: crypto.randomUUID(), name, role, exp: attempt.now + ROOM_SESSION_MS }), role })
})

app.get('/api/rooms', (req, res) => {
  const authenticated = readBearerSession(req)
  if (!authenticated) return res.status(401).json({ error: 'Entre no site novamente.' })
  res.json({ rooms: [...rooms.values()].map(({ id, name }) => ({ id, name })), role: authenticated.role })
})

app.post('/api/rooms', (req, res) => {
  const authenticated = readBearerSession(req)
  if (!authenticated) return res.status(401).json({ error: 'Entre no site novamente.' })
  const roomName = normalizeRoomName(req.body?.roomName)
  const password = typeof req.body?.password === 'string' ? req.body.password : ''
  if (roomName.length < 2 || password.length < 4 || password.length > 128) return res.status(400).json({ error: 'Informe um nome e uma senha com pelo menos 4 caracteres.' })
  const key = roomKey(roomName)
  if (rooms.has(key)) return res.status(409).json({ error: 'Não foi possível criar essa sala. Escolha outro nome.' })
  const room = { id: crypto.randomUUID(), name: roomName, password: hashPassword(password), bannedNames: new Set(), createdAt: Date.now(), deleteTimer: null }
  rooms.set(key, room)
  scheduleRoomDeletion(room, key)
  res.status(201).json({ room: { id: room.id, name: room.name } })
})

app.post('/api/rooms/:roomId/join', (req, res) => {
  const authenticated = readBearerSession(req)
  if (!authenticated) return res.status(401).json({ error: 'Entre no site novamente.' })
  const attempt = rateLimitLogin(req, res); if (!attempt) return
  const password = typeof req.body?.password === 'string' ? req.body.password : ''
  const entry = [...rooms.entries()].find(([, candidate]) => candidate.id === req.params.roomId)
  const room = entry?.[1]
  const valid = room && (authenticated.role === 'superadmin' || passwordMatches(password, room.password))
  if (!valid) {
    attempt.recent.push(attempt.now); loginAttempts.set(attempt.ip, attempt.recent)
    return res.status(401).json({ error: 'Senha da sala incorreta.' })
  }
  loginAttempts.delete(attempt.ip)
  scheduleRoomDeletion(room, entry[0])
  res.json({ session: signSession({ kind: 'room', sub: authenticated.sub, name: authenticated.name, role: authenticated.role, roomId: room.id, roomKey: entry[0], exp: attempt.now + ROOM_SESSION_MS }), role: authenticated.role, roomName: room.name })
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
const allowedTypes = new Set(['hello', 'heartbeat', 'broadcast-start', 'broadcast-stop', 'watch-request', 'restart-request', 'moderate', 'signal', 'stop'])

const safeSend = (socket, message) => {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
}
const roomClients = (roomId) => [...clients.values()].filter((client) => client.roomId === roomId)
const publicUsers = (roomId) => roomClients(roomId).map(({ id, name, role, broadcasting }) => ({ id, name, role, broadcasting }))
const broadcastUsers = (roomId) => {
  const message = { type: 'users', users: publicUsers(roomId) }
  for (const { socket } of roomClients(roomId)) safeSend(socket, message)
}
const scheduleRoomDeletion = (room, key) => {
  clearTimeout(room.deleteTimer)
  room.deleteTimer = setTimeout(() => {
    if (roomClients(room.id).length === 0 && rooms.get(key)?.id === room.id) rooms.delete(key)
  }, 15_000)
}
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const validDescription = (value) => isObject(value) && ['offer', 'answer'].includes(value.type) && typeof value.sdp === 'string' && value.sdp.length < 100_000
const validCandidate = (value) => value === null || (isObject(value) && (value.candidate === undefined || typeof value.candidate === 'string'))
const validConnectionId = (value) => typeof value === 'string' && /^[a-zA-Z0-9-]{8,64}$/.test(value)

wss.on('connection', (socket, request) => {
  const sessionToken = new URL(request.url, 'http://localhost').searchParams.get('session')
  const authenticated = verifySession(sessionToken)
  const room = authenticated ? rooms.get(authenticated.roomKey) : null
  if (!authenticated || authenticated.kind !== 'room' || !room || room.id !== authenticated.roomId) { socket.close(1008, 'Entrada na sala necessária'); return }
  const id = authenticated.sub
  let registered = false
  socket.on('message', (raw) => {
    let message
    try { message = JSON.parse(raw.toString()) } catch { return safeSend(socket, { type: 'error', message: 'Mensagem inválida.' }) }
    if (!isObject(message) || !allowedTypes.has(message.type)) return safeSend(socket, { type: 'error', message: 'Tipo de mensagem inválido.' })
    if (!registered) {
      if (message.type !== 'hello') return safeSend(socket, { type: 'error', message: 'Identifique-se primeiro.' })
      const name = cleanUserName(authenticated.name)
      if (name.length < 2) return safeSend(socket, { type: 'error', message: 'Use um nome com pelo menos 2 caracteres.' })
      if (room.bannedNames.has(name.toLocaleLowerCase('pt-BR'))) { safeSend(socket, { type: 'banned' }); return socket.close(1008, 'Banido') }
      const previousConnection = clients.get(id)
      if (previousConnection && previousConnection.socket !== socket) { clients.delete(id); previousConnection.socket.close(1012, 'Reconectado em outra conexão') }
      if (roomClients(room.id).some((client) => client.id !== id && client.name.toLocaleLowerCase('pt-BR') === name.toLocaleLowerCase('pt-BR'))) {
        safeSend(socket, { type: 'error', message: 'Este nome de usuário já está online.' }); return socket.close(1008, 'Nome em uso')
      }
      clients.set(id, { id, name, role: ['admin', 'superadmin'].includes(authenticated.role) ? authenticated.role : 'member', roomId: room.id, broadcasting: false, socket })
      clearTimeout(room.deleteTimer); room.deleteTimer = null
      registered = true
      safeSend(socket, { type: 'welcome', id, role: ['admin', 'superadmin'].includes(authenticated.role) ? authenticated.role : 'member', roomName: room.name })
      return broadcastUsers(room.id)
    }
    const sender = clients.get(id)
    if (!sender || sender.socket !== socket) return socket.close(1012, 'Conexão substituída')
    if (message.type === 'heartbeat') return safeSend(socket, { type: 'heartbeat', at: Date.now() })
    if (message.type === 'broadcast-start') { sender.broadcasting = true; return broadcastUsers(sender.roomId) }
    if (message.type === 'broadcast-stop') { sender.broadcasting = false; return broadcastUsers(sender.roomId) }
    const target = typeof message.to === 'string' ? clients.get(message.to) : null
    if (!target || target.id === id || target.roomId !== sender.roomId) return safeSend(socket, { type: 'error', message: 'Usuário indisponível.' })

    if (message.type === 'watch-request') {
      if (!target.broadcasting) return safeSend(socket, { type: 'error', message: 'Esta transmissão não está mais disponível.' })
      return safeSend(target.socket, { type: 'watch-request', from: id, fromName: sender.name })
    }
    if (message.type === 'restart-request') {
      if (!validConnectionId(message.connectionId)) return safeSend(socket, { type: 'error', message: 'Identificador de transmissão inválido.' })
      return safeSend(target.socket, { type: 'restart-request', from: id, connectionId: message.connectionId })
    }
    if (message.type === 'moderate') {
      if (!['admin', 'superadmin'].includes(sender.role) || !['kick', 'ban'].includes(message.action)) return safeSend(socket, { type: 'error', message: 'Ação não autorizada.' })
      if (message.action === 'ban') room.bannedNames.add(target.name.toLocaleLowerCase('pt-BR'))
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
    if (!registered || clients.get(id)?.socket !== socket) return
    const departed = clients.get(id); clients.delete(id)
    for (const { socket: peerSocket } of roomClients(departed.roomId)) safeSend(peerSocket, { type: 'peer-left', id })
    broadcastUsers(departed.roomId)
    if (roomClients(departed.roomId).length === 0) scheduleRoomDeletion(room, authenticated.roomKey)
  })
  socket.on('error', () => socket.close())
})

const port = Number(process.env.PORT || 8787)
const host = process.env.HOST || '0.0.0.0'
server.listen(port, host, () => console.log(`Signaling server on ${tls ? 'https' : 'http'}://${host}:${port}`))
