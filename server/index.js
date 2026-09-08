import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { WebSocketServer, WebSocket } from 'ws'
import { createRateLimiter } from './rateLimit.js'
import { createStore } from './store.js'
import { createFileStorage, MAX_FILE_BYTES, MAX_ROOM_BYTES, safeName } from './files.js'
import crypto from 'node:crypto'

const app = express()
// Announcing the framework only helps somebody deciding which published flaw to try first.
app.disable('x-powered-by')
const origin = process.env.CLIENT_ORIGIN || 'http://localhost:5173'
const origins = origin.split(',').map((value) => value.trim()).filter(Boolean)
app.use(cors({ origin: origins }))
app.use(express.json({ limit: '16kb' }))

// The signalling socket lives on the same host as the page, so the policy is built from the origins
// that are already trusted rather than from a wildcard.
const socketOrigins = origins.map((value) => value.replace(/^http/, 'ws'))
const policy = [
  "default-src 'self'",
  // wasm-unsafe-eval is RNNoise: the suppressor is WebAssembly, and without it the microphone quietly
  // loses noise suppression while everything else keeps working, which is the worst way to break.
  "script-src 'self' 'wasm-unsafe-eval'",
  // The panels are resized by writing style.height onto the element, which counts as an inline style.
  // The @import at the top of the stylesheet is what pulls the two typefaces.
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  `connect-src 'self' ${socketOrigins.join(' ')}`.trim(),
  // Nothing here is ever framed, and the buttons on this page start a screen capture and a microphone.
  // Being framed by a page that covers them is the whole clickjacking trick, so it is refused outright.
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ')

app.use((_req, res, next) => {
  res.set('Content-Security-Policy', policy)
  // For browsers that predate frame-ancestors. Harmless where both are understood.
  res.set('X-Frame-Options', 'DENY')
  // The page asks for a microphone and for a screen, and for nothing else. Saying so means a flaw in
  // some dependency cannot quietly reach for the camera or the location.
  res.set('Permissions-Policy', 'camera=(), geolocation=(), payment=(), usb=(), microphone=(self), display-capture=(self)')
  next()
})

app.get('/health', (_req, res) => res.json({ ok: true }))

// Every session anybody holds is signed with this, so a value anybody else knows is every account at
// once. It used to fall back to a fixed string whenever RENDER was unset -- which was fine while Render
// was the only place this ran, and became a hole the moment it ran anywhere else: a deploy that forgot
// the variable would sign with a constant sitting in a public repository, and look perfectly healthy.
//
// So there is no constant any more. Missing means one random secret for this run: nothing to guess, no
// configuration needed to develop, and a restart quietly signing out everybody -- which is a nuisance
// in development and an unmissable symptom in production, where it means the variable is missing.
const sessionSecret = process.env.SESSION_SECRET || (() => {
  console.warn('SESSION_SECRET nao definido. Usando um segredo aleatorio, valido apenas ate reiniciar.')
  return crypto.randomBytes(48).toString('base64url')
})()
const loginAttempts = new Map()
const rooms = new Map()
// Only permanent rooms are written down. A temporary one is still exactly what it was: it lives in
// memory, and it goes fifteen seconds after the last person leaves.
//
// The database now lives somewhere else, which means it can be unreachable in a way a local file never
// was. Sharing a screen and talking need it for nothing at all, so an outage must not take those down --
// the server comes up either way, and only permanent rooms are missing while it lasts.
const store = createStore()
const fileStorage = createFileStorage()
let storeReady = false
try {
  await store.connect()
  for (const room of await store.loadRooms()) rooms.set(room.key, { ...room, deleteTimer: null })
  storeReady = true
  console.log(`Rooms restored: ${rooms.size}`)
} catch (error) {
  console.error('Database unreachable; permanent rooms are unavailable this session:', error.message)
}
const ROOM_SESSION_MS = 30 * 24 * 60 * 60 * 1000
// How much of a conversation is kept. In a temporary room this is all there is, and it goes when the
// room does. In a permanent one the same hundred messages are written to disk and read back on boot, so
// what somebody sees on joining is the same either way -- the difference is only whether it survives.
// A room nobody has walked into for two months is a room nobody wants. Any visit resets it -- it does
// not have to be the owner, because the question is whether the room is still used, not by whom.
const ROOM_IDLE_MS = Number(process.env.ROOM_IDLE_MS) || 60 * 24 * 60 * 60 * 1000
// A co-owner can ask for the room to go, but not have it gone. The wait is the whole point: it is time
// for the owner to notice and say no.
const ROOM_DELETE_DELAY_MS = Number(process.env.ROOM_DELETE_DELAY_MS) || 3 * 24 * 60 * 60 * 1000
const ROOM_SWEEP_MS = Number(process.env.ROOM_SWEEP_MS) || 60 * 60 * 1000
const CHAT_HISTORY = 100
const CHAT_MAX_LENGTH = 500
const TURN_CREDENTIAL_TTL_SECONDS = 60 * 60
const TURN_USAGE_CACHE_MS = 5 * 60 * 1000
const TURN_DEFAULT_LIMIT_GB = 800
let turnUsageCache = null
const cleanUserName = (value) => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, 32) : ''
// Standing is recognised by the session that has it or by the name on that session, so the same person
// is themselves on another machine. The name is not proof of anything -- signing in asks for no password
// -- so anybody who types the creator's name is treated as the creator. That is a deliberate trade for
// an app with no accounts, made with the alternative on the table, and not an oversight.
const nameKey = (value) => cleanUserName(value).toLocaleLowerCase('pt-BR')
const isOwner = (room, session) => room.ownerSub === session?.sub
  || (room.ownerName ? room.ownerName === nameKey(session?.name) : false)
const isCoOwner = (room, session) => {
  if (!room.coOwners) return false
  if (room.coOwners.has(session?.sub)) return true
  const wanted = nameKey(session?.name)
  return wanted ? [...room.coOwners.values()].some((name) => name === wanted) : false
}
// Whoever asked for the room to go, by either measure, so they can take it back from anywhere.
const askedToDelete = (room, session) => room.deleteBy === session?.sub
  || (room.deleteByName ? nameKey(room.deleteByName) === nameKey(session?.name) : false)
// Somebody walked in. Whoever it was, the room's two-month clock starts over.
const touchRoom = (room, key) => {
  room.lastSeenAt = Date.now()
  if (room.permanent) store.touchRoom(key, room.lastSeenAt)
}
// Returns the write, so a caller about to tell somebody the room is gone can wait for it to be true.
const removeRoom = (key, room, reason) => {
  for (const client of roomClients(room.id)) {
    safeSend(client.socket, { type: 'room-closed', reason })
    client.socket.close(1000, 'Sala encerrada')
  }
  clearTimeout(room.deleteTimer)
  rooms.delete(key)
  // Three things, and only the first is the database's. A room removed without the other two leaves its
  // files on the disk with nothing pointing at them, which is space nobody can ever reclaim by hand.
  return Promise.all([
    store.deleteRoom(key),
    store.deleteFilesForRoom(key),
    fileStorage.removeRoom(room.id).catch((error) => console.error(`Could not remove files of ${key}:`, error.message)),
  ])
}
// Both clocks are checked in one place and on a timer rather than when somebody happens to ask, so a
// room that expired while the server was down is gone the moment it comes back up.
const sweepRooms = () => {
  const now = Date.now()
  for (const [key, room] of [...rooms]) {
    if (!room.permanent) continue
    if (room.deleteAfter !== null && room.deleteAfter <= now) { removeRoom(key, room, 'requested'); continue }
    if (now - (room.lastSeenAt ?? room.createdAt) >= ROOM_IDLE_MS) removeRoom(key, room, 'idle')
  }
}
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
  if (name.length < 2) {
    attempt.recent.push(attempt.now); loginAttempts.set(attempt.ip, attempt.recent)
    return res.status(401).json({ error: 'Usuário ou senha incorretos.' })
  }
  loginAttempts.delete(attempt.ip)
  res.json({ session: signSession({ kind: 'site', sub: crypto.randomUUID(), name, exp: attempt.now + ROOM_SESSION_MS }) })
})

app.get('/api/rooms', (req, res) => {
  const authenticated = readBearerSession(req)
  if (!authenticated) return res.status(401).json({ error: 'Entre no site novamente.' })
  res.json({
    rooms: [...rooms.values()].map((room) => ({
      id: room.id,
      name: room.name,
      open: !room.password,
      permanent: room.permanent === true,
      // Said plainly rather than as a role, so the interface never has to work out what somebody is.
      owned: isOwner(room, authenticated),
      coOwner: isCoOwner(room, authenticated),
      // A room on its way out has to look like one, or the wait would be a silent countdown.
      deleteAfter: room.deleteAfter ?? null,
      deleteByName: room.deleteByName ?? null,
    })),
  })
})

app.post('/api/rooms', async (req, res) => {
  const authenticated = readBearerSession(req)
  if (!authenticated) return res.status(401).json({ error: 'Entre no site novamente.' })
  const roomName = normalizeRoomName(req.body?.roomName)
  const password = typeof req.body?.password === 'string' ? req.body.password : ''
  const permanent = req.body?.permanent === true
  // An empty password means an open room. Anything else still has to be a real one: a two-character
  // password would read as protection while offering none.
  if (roomName.length < 2) return res.status(400).json({ error: 'Informe um nome com pelo menos 2 caracteres.' })
  if (password.length > 0 && (password.length < 4 || password.length > 128)) {
    return res.status(400).json({ error: 'A senha precisa ter de 4 a 128 caracteres, ou fique em branco para uma sala aberta.' })
  }
  if (permanent && !storeReady) {
    return res.status(503).json({ error: 'O banco de dados está indisponível agora. Crie uma sala temporária ou tente mais tarde.' })
  }
  const key = roomKey(roomName)
  if (rooms.has(key)) return res.status(409).json({ error: 'Não foi possível criar essa sala. Escolha outro nome.' })
  const now = Date.now()
  const room = { key, id: crypto.randomUUID(), name: roomName, password: password ? hashPassword(password) : null, ownerSub: authenticated.sub, ownerName: nameKey(authenticated.name), permanent, bannedNames: new Set(), coOwners: new Map(), messages: [], createdAt: now, lastSeenAt: now, deleteAfter: null, deleteBy: null, deleteByName: null, deleteTimer: null }
  rooms.set(key, room)
  // Awaited, unlike a chat message: somebody is about to be told their permanent room exists, and it
  // has to be true before they are told. Chat stays unawaited because it happens constantly and losing
  // the last line of a conversation to a crash costs far less than a round trip on every message.
  if (permanent) await store.saveRoom(key, room)
  else scheduleRoomDeletion(room, key)
  res.status(201).json({ room: { id: room.id, name: room.name, permanent } })
})

app.post('/api/rooms/:roomId/join', (req, res) => {
  const authenticated = readBearerSession(req)
  if (!authenticated) return res.status(401).json({ error: 'Entre no site novamente.' })
  const attempt = rateLimitLogin(req, res); if (!attempt) return
  const password = typeof req.body?.password === 'string' ? req.body.password : ''
  const entry = [...rooms.entries()].find(([, candidate]) => candidate.id === req.params.roomId)
  const room = entry?.[1]
  // Coming back to a room this browser already opened. The seat is the session the server itself issued
  // once the password was right, so accepting it is not a second door -- it is the same door, still
  // open. It has to name this room and this site session: a seat carried to another machine, or to the
  // desktop app, names a site session that is not the one presenting it, and the password is asked
  // again. Which is the point.
  const returning = verifySession(typeof req.body?.seat === 'string' ? req.body.seat : '')
  const seated = returning?.kind === 'room' && returning.sub === authenticated.sub && returning.roomId === req.params.roomId
  const valid = room && (seated || !room.password || passwordMatches(password, room.password))
  if (!valid) {
    attempt.recent.push(attempt.now); loginAttempts.set(attempt.ip, attempt.recent)
    return res.status(401).json({ error: 'Senha da sala incorreta.' })
  }
  loginAttempts.delete(attempt.ip)
  touchRoom(room, entry[0])
  scheduleRoomDeletion(room, entry[0])
  const roomRole = isOwner(room, authenticated) ? 'owner' : 'member'
  res.json({ session: signSession({ kind: 'room', sub: authenticated.sub, name: authenticated.name, role: roomRole, roomId: room.id, roomKey: entry[0], exp: attempt.now + ROOM_SESSION_MS }), role: roomRole, roomName: room.name, open: !room.password })
})

// Proving you could walk in. Standing says who somebody is, and with no accounts that rests on a name
// anybody can type -- so it cannot be the only thing standing between a room and its destruction. The
// password protects entering, and destroying is not the lesser act.
// An <img> cannot send an Authorization header, so the permission has to travel in the address. Signed
// and short-lived rather than a plain identifier: a link that never expires is a link that leaks once
// and works forever. Minted when a message is handed over, so a session's links stay usable while the
// session lasts and are useless to anybody who copies one out of it a day later.
const FILE_LINK_MS = 6 * 60 * 60 * 1000
const fileUrl = (id) => `/api/files/${id}?token=${encodeURIComponent(signSession({ kind: 'file', file: id, exp: Date.now() + FILE_LINK_MS }))}`
// Messages travel with their file's address attached, so nothing has to be asked for separately.
const withLinks = (message) => (message.file ? { ...message, file: { ...message.file, url: fileUrl(message.file.id) } } : message)

const roomPasswordOk = (room, supplied) => !room.password
  || passwordMatches(typeof supplied === 'string' ? supplied : '', room.password)

// The creator can remove their room at once. A co-owner can only start a countdown, which the creator
// has three days to stop -- so appointing one is not handing over the power to destroy the room.
//
// A POST rather than a DELETE because it carries the password: a body on a DELETE is permitted but has
// no agreed meaning, and an intermediary that drops it would look exactly like a wrong password.
app.post('/api/rooms/:roomId/delete', async (req, res) => {
  const authenticated = readBearerSession(req)
  if (!authenticated) return res.status(401).json({ error: 'Entre no site novamente.' })
  const attempt = rateLimitLogin(req, res); if (!attempt) return
  const entry = [...rooms.entries()].find(([, candidate]) => candidate.id === req.params.roomId)
  if (!entry) return res.status(404).json({ error: 'Essa sala não existe mais.' })
  const [key, room] = entry
  // Standing is checked before the password, so somebody with no business here is turned away without
  // ever being told whether a guess was close.
  if (!isOwner(room, authenticated) && !isCoOwner(room, authenticated)) {
    return res.status(403).json({ error: 'Só quem criou a sala ou um co-dono pode apagá-la.' })
  }
  if (!roomPasswordOk(room, req.body?.password)) {
    attempt.recent.push(attempt.now); loginAttempts.set(attempt.ip, attempt.recent)
    return res.status(401).json({ error: 'Senha da sala incorreta.' })
  }
  loginAttempts.delete(attempt.ip)
  if (isOwner(room, authenticated)) {
    await removeRoom(key, room, 'owner')
    return res.json({ deleted: true })
  }
  // Asking twice does not make it sooner: the first request is the one that counts.
  if (room.deleteAfter === null) {
    room.deleteAfter = Date.now() + ROOM_DELETE_DELAY_MS
    room.deleteBy = authenticated.sub
    room.deleteByName = authenticated.name
    await store.setPendingDeletion(key, room.deleteAfter, room.deleteBy, room.deleteByName)
    for (const client of roomClients(room.id)) safeSend(client.socket, { type: 'room-closing', deleteAfter: room.deleteAfter, byName: room.deleteByName })
  }
  res.json({ deleted: false, deleteAfter: room.deleteAfter, deleteByName: room.deleteByName })
})

// Calling off a countdown. The creator can stop any; a co-owner can only take back their own request,
// so one co-owner cannot undo another's while the creator is away.
app.post('/api/rooms/:roomId/keep', async (req, res) => {
  const authenticated = readBearerSession(req)
  if (!authenticated) return res.status(401).json({ error: 'Entre no site novamente.' })
  const attempt = rateLimitLogin(req, res); if (!attempt) return
  const entry = [...rooms.entries()].find(([, candidate]) => candidate.id === req.params.roomId)
  if (!entry) return res.status(404).json({ error: 'Essa sala não existe mais.' })
  const [key, room] = entry
  const mayKeep = isOwner(room, authenticated) || askedToDelete(room, authenticated)
  if (!mayKeep) return res.status(403).json({ error: 'Só quem criou a sala ou quem pediu a exclusão pode cancelá-la.' })
  // The same proof as deleting. Calling off a countdown is the gentler act, but it is the one that
  // decides whether the room lives, so it is not left as the easier door.
  if (!roomPasswordOk(room, req.body?.password)) {
    attempt.recent.push(attempt.now); loginAttempts.set(attempt.ip, attempt.recent)
    return res.status(401).json({ error: 'Senha da sala incorreta.' })
  }
  loginAttempts.delete(attempt.ip)
  room.deleteAfter = null; room.deleteBy = null; room.deleteByName = null
  await store.setPendingDeletion(key, null, null, null)
  for (const client of roomClients(room.id)) safeSend(client.socket, { type: 'room-kept' })
  res.json({ kept: true })
})

// Being in the room is the permission. Not the creator, not a co-owner -- anybody who got past the
// door, because that is exactly who is allowed to see what is posted there.
app.post('/api/room/files', async (req, res) => {
  const authenticated = authenticateRoomRequest(req, res)
  if (!authenticated) return
  const entry = [...rooms.entries()].find(([, candidate]) => candidate.id === authenticated.roomId)
  if (!entry) return res.status(404).json({ error: 'Essa sala não existe mais.' })
  const [key, room] = entry
  if (!room.permanent) return res.status(400).json({ error: 'Uma sala temporária não guarda arquivos.' })
  if (!storeReady) return res.status(503).json({ error: 'O banco de dados está indisponível agora.' })

  const used = await store.roomUsage(key)
  const received = await fileStorage.receive({
    roomId: room.id,
    stream: req,
    limit: MAX_FILE_BYTES,
    remainingQuota: Math.max(0, MAX_ROOM_BYTES - used),
  })
  if (!received.ok) {
    return res.status(received.reason === 'room-full' ? 507 : 413).json({
      error: received.reason === 'room-full'
        ? 'Esta sala já usou todo o espaço dela.'
        : received.reason === 'empty' ? 'Arquivo vazio.' : `Arquivo maior que o limite de ${Math.round(MAX_FILE_BYTES / 1048576)} MB.`,
    })
  }

  const file = {
    id: received.id,
    roomKey: key,
    roomId: room.id,
    from: authenticated.sub,
    fromName: authenticated.name,
    // Shown, never used to build a path. What is on disk is the generated identifier.
    name: safeName(req.get('x-file-name') ? decodeURIComponent(req.get('x-file-name')) : 'arquivo'),
    kind: received.kind,
    inline: received.inline,
    bytes: received.bytes,
    sha256: received.sha256,
    at: Date.now(),
  }
  await store.addFile(file)

  // A file arrives in the conversation like anything else somebody says, so it appears where people are
  // already looking rather than in a list they have to go and find.
  const message = { id: crypto.randomUUID(), from: authenticated.sub, fromName: authenticated.name, text: '', at: file.at, file: { id: file.id, name: file.name, kind: file.kind, inline: file.inline, bytes: file.bytes } }
  room.messages.push(message)
  if (room.messages.length > CHAT_HISTORY) room.messages.splice(0, room.messages.length - CHAT_HISTORY)
  await store.addMessage(key, message, CHAT_HISTORY)
  sendToRoom(room.id, { type: 'chat', message: withLinks(message) })
  res.status(201).json({ file: { ...message.file, url: fileUrl(file.id) } })
})

// Downloading. The token in the address is the whole permission, so it is checked before anything else
// is looked up, and the headers are chosen so that a file can never be run by the browser that fetched
// it -- only a short list of formats is handed over as itself, and everything else is a download.
app.get('/api/files/:id', async (req, res) => {
  const claim = verifySession(typeof req.query.token === 'string' ? req.query.token : '')
  if (claim?.kind !== 'file' || claim.file !== req.params.id) return res.status(401).json({ error: 'Link expirado.' })
  const file = storeReady ? await store.findFile(req.params.id) : null
  if (!file) return res.status(404).json({ error: 'Arquivo não encontrado.' })
  // nosniff is what stops a browser deciding for itself that an octet-stream looks like HTML.
  res.set('X-Content-Type-Options', 'nosniff')
  res.set('Cache-Control', 'private, max-age=3600')
  res.set('Content-Type', file.inline ? file.kind : 'application/octet-stream')
  res.set('Content-Length', String(file.bytes))
  // The filename is quoted and already stripped of anything that could end a header early.
  res.set('Content-Disposition', `${file.inline ? 'inline' : 'attachment'}; filename="${file.name}"`)
  res.sendFile(fileStorage.pathFor(file.roomId, file.id), (error) => { if (error && !res.headersSent) res.status(404).end() })
})

const turnConfiguration = () => ({
  enabled: process.env.TURN_ENABLED === 'true',
  keyId: process.env.CLOUDFLARE_TURN_KEY_ID,
  credentialToken: process.env.CLOUDFLARE_TURN_API_TOKEN,
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
  analyticsToken: process.env.CLOUDFLARE_ANALYTICS_API_TOKEN,
  limitBytes: Math.max(1, Number(process.env.TURN_MONTHLY_LIMIT_GB || TURN_DEFAULT_LIMIT_GB)) * 1_000_000_000,
})
const readTurnUsage = async ({ keyId, accountId, analyticsToken, limitBytes }) => {
  if (!keyId || !accountId || !analyticsToken) return { enabled: false, blocked: true, reason: 'protection-not-configured', usedBytes: 0, limitBytes }
  if (turnUsageCache && Date.now() - turnUsageCache.checkedAt < TURN_USAGE_CACHE_MS) return turnUsageCache
  const now = new Date()
  const dateFrom = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`
  const dateTo = now.toISOString().slice(0, 10)
  const query = `query TurnMonthlyUsage($accountId: String!, $keyId: String!, $dateFrom: Date!, $dateTo: Date!) {
    viewer { accounts(filter: { accountTag: $accountId }) { callsTurnUsageAdaptiveGroups(
      limit: 1
      filter: { keyId: $keyId, date_geq: $dateFrom, date_leq: $dateTo }
    ) { sum { egressBytes } } } }
  }`
  try {
    const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: { authorization: `Bearer ${analyticsToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables: { accountId, keyId, dateFrom, dateTo } }),
      signal: AbortSignal.timeout(8_000),
    })
    const result = await response.json()
    const groups = result?.data?.viewer?.accounts?.[0]?.callsTurnUsageAdaptiveGroups
    if (!response.ok || result?.errors?.length || !Array.isArray(groups)) throw new Error(result?.errors?.[0]?.message || 'TURN analytics unavailable')
    const usedBytes = groups.reduce((total, group) => total + Math.max(0, Number(group?.sum?.egressBytes) || 0), 0)
    turnUsageCache = { enabled: true, blocked: usedBytes >= limitBytes, reason: usedBytes >= limitBytes ? 'monthly-limit' : null, usedBytes, limitBytes, checkedAt: Date.now() }
    return turnUsageCache
  } catch (error) {
    console.error('Could not verify TURN usage; failing closed:', error.message)
    return { enabled: false, blocked: true, reason: 'usage-check-failed', usedBytes: 0, limitBytes, checkedAt: Date.now() }
  }
}
const authenticateRoomRequest = (req, res) => {
  const authenticated = readBearerSession(req, 'room')
  const room = authenticated ? rooms.get(authenticated.roomKey) : null
  if (!authenticated || !room || room.id !== authenticated.roomId) { res.status(401).json({ error: 'Entre em uma sala novamente.' }); return null }
  return authenticated
}

app.get('/api/turn-status', async (req, res) => {
  if (!authenticateRoomRequest(req, res)) return
  res.set('Cache-Control', 'no-store')
  const configuration = turnConfiguration()
  if (!configuration.enabled) return res.json({ turnEnabled: false, blocked: true, reason: 'turn-disabled' })
  const status = await readTurnUsage(configuration)
  res.json({ turnEnabled: status.enabled && !status.blocked, blocked: status.blocked, reason: status.reason, usedBytes: status.usedBytes, limitBytes: status.limitBytes })
})

app.get('/api/ice-servers', async (req, res) => {
  if (!authenticateRoomRequest(req, res)) return

  res.set('Cache-Control', 'no-store')
  const fallback = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302', 'stun:stun.nextcloud.com:443'] }]
  const configuration = turnConfiguration()
  if (!configuration.enabled) return res.json({ iceServers: fallback, turnEnabled: false, reason: 'turn-disabled' })
  if (!configuration.keyId || !configuration.credentialToken) return res.json({ iceServers: fallback, turnEnabled: false, reason: 'turn-not-configured' })
  const usage = await readTurnUsage(configuration)
  if (!usage.enabled || usage.blocked) return res.json({ iceServers: fallback, turnEnabled: false, blocked: usage.blocked, reason: usage.reason })

  try {
    const response = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(configuration.keyId)}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { authorization: `Bearer ${configuration.credentialToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ttl: TURN_CREDENTIAL_TTL_SECONDS, customIdentifier: 'entretelas' }),
      signal: AbortSignal.timeout(8_000),
    })
    const result = await response.json()
    if (!response.ok || !Array.isArray(result.iceServers) || result.iceServers.length === 0) throw new Error('TURN credentials unavailable')
    const cloudflareServers = result.iceServers.filter((serverEntry) => serverEntry && (typeof serverEntry.urls === 'string' || Array.isArray(serverEntry.urls)))
    if (cloudflareServers.length === 0) throw new Error('Invalid TURN response')
    // Keep Google's STUN candidate as well: some networks allow port 19302 but block Cloudflare STUN on 3478/53.
    // TURN remains available, but a working direct candidate keeps its normal ICE priority.
    const iceServers = [...fallback, ...cloudflareServers]
    return res.json({ iceServers, turnEnabled: iceServers.some((entry) => JSON.stringify(entry.urls).includes('turn:') || JSON.stringify(entry.urls).includes('turns:')) })
  } catch (error) {
    console.error('Could not generate temporary TURN credentials:', error.message)
    return res.json({ iceServers: fallback, turnEnabled: false })
  }
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
const allowedTypes = new Set(['hello', 'heartbeat', 'broadcast-start', 'broadcast-stop', 'voice-join', 'voice-leave', 'chat', 'watch-request', 'restart-request', 'moderate', 'promote', 'demote', 'signal', 'stop'])

const safeSend = (socket, message) => {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
}
const roomClients = (roomId) => [...clients.values()].filter((client) => client.roomId === roomId)
const publicUsers = (roomId) => roomClients(roomId).map(({ id, name, role, broadcasting, voice }) => ({ id, name, role, broadcasting, voice }))
const sendToRoom = (roomId, message) => {
  for (const { socket } of roomClients(roomId)) safeSend(socket, message)
}
const broadcastUsers = (roomId) => sendToRoom(roomId, { type: 'users', users: publicUsers(roomId) })
// Newlines are kept -- somebody pasting a few lines meant to -- but runs of them are collapsed so a
// single message cannot scroll everyone else's conversation off the screen.
const cleanChatText = (value) => typeof value === 'string'
  ? value.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[^\S\n]+/g, ' ').trim().slice(0, CHAT_MAX_LENGTH)
  : ''
const scheduleRoomDeletion = (room, key) => {
  // The whole point of a permanent room: an empty one is still there tomorrow.
  if (room.permanent) return
  clearTimeout(room.deleteTimer)
  room.deleteTimer = setTimeout(() => {
    if (roomClients(room.id).length === 0 && rooms.get(key)?.id === room.id) rooms.delete(key)
  }, 15_000)
}
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const validDescription = (value) => isObject(value) && ['offer', 'answer'].includes(value.type) && typeof value.sdp === 'string' && value.sdp.length < 100_000
const validCandidate = (value) => value === null || (isObject(value) && (value.candidate === undefined || typeof value.candidate === 'string'))
const validConnectionId = (value) => typeof value === 'string' && /^[a-zA-Z0-9-]{8,64}$/.test(value)
const roleRank = { member: 0, owner: 1 }

wss.on('connection', (socket, request) => {
  const sessionToken = new URL(request.url, 'http://localhost').searchParams.get('session')
  const authenticated = verifySession(sessionToken)
  const room = authenticated ? rooms.get(authenticated.roomKey) : null
  if (!authenticated || authenticated.kind !== 'room' || !room || room.id !== authenticated.roomId) { socket.close(1008, 'Entrada na sala necessária'); return }
  const id = authenticated.sub
  let registered = false
  const limiter = createRateLimiter()
  socket.on('message', (raw) => {
    // Counted before anything is parsed. A flood of malformed JSON costs the same to receive as a flood
    // of valid messages, so the ceiling cannot sit behind the parser.
    const allowed = limiter.accept(raw.length ?? 0)
    if (!allowed.ok) {
      if (limiter.flooding) return socket.close(1008, 'Excesso de mensagens')
      if (limiter.shouldWarn()) safeSend(socket, { type: 'error', message: 'Muitas mensagens de uma vez. Parte delas foi descartada.' })
      return
    }
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
      const role = Object.hasOwn(roleRank, authenticated.role) ? authenticated.role : 'member'
      clients.set(id, { id, name, role, roomId: room.id, broadcasting: false, voice: false, socket })
      touchRoom(room, authenticated.roomKey)
      clearTimeout(room.deleteTimer); room.deleteTimer = null
      registered = true
      safeSend(socket, {
        type: 'welcome', id, role, roomName: room.name,
        permanent: room.permanent === true,
        coOwners: [...(room.coOwners?.keys() || [])],
        deleteAfter: room.deleteAfter ?? null,
        deleteByName: room.deleteByName ?? null,
      })
      // Sent to this one socket, not the room: it is what was already said, not something new.
      safeSend(socket, { type: 'chat-history', messages: room.messages.map(withLinks) })
      return broadcastUsers(room.id)
    }
    const sender = clients.get(id)
    if (!sender || sender.socket !== socket) return socket.close(1012, 'Conexão substituída')
    if (message.type === 'heartbeat') return safeSend(socket, { type: 'heartbeat', at: Date.now() })
    if (message.type === 'broadcast-start') { sender.broadcasting = true; return broadcastUsers(sender.roomId) }
    if (message.type === 'broadcast-stop') { sender.broadcasting = false; return broadcastUsers(sender.roomId) }
    // Who is in voice is presence, not signalling: every peer needs it to know whom to open a connection
    // to, and it is the same list the interface draws. The audio itself never passes through here.
    if (message.type === 'voice-join') { sender.voice = true; return broadcastUsers(sender.roomId) }
    if (message.type === 'voice-leave') { sender.voice = false; return broadcastUsers(sender.roomId) }
    if (message.type === 'chat') {
      const text = cleanChatText(message.text)
      if (!text) return
      // Counted after the message is known to be worth sending, not before. Charging for the empty and
      // malformed ones meant a client sending junk would silently spend the budget of the person typing;
      // those cost nothing here because the ceiling above already counted them as traffic.
      //
      // Refused here is somebody typing quickly, which is worth a word back rather than a strike --
      // flooding past this costs the connection through that same ceiling anyway.
      if (!limiter.acceptChat()) return safeSend(socket, { type: 'error', message: 'Devagar com as mensagens.' })
      // The name is taken from the connection rather than from the message: a sender who could choose
      // the name shown against their words could put them in somebody else's mouth.
      const entry = { id: crypto.randomUUID(), from: id, fromName: sender.name, text, at: Date.now() }
      room.messages.push(entry)
      if (room.messages.length > CHAT_HISTORY) room.messages.splice(0, room.messages.length - CHAT_HISTORY)
      if (room.permanent) store.addMessage(authenticated.roomKey, entry, CHAT_HISTORY)
      return sendToRoom(sender.roomId, { type: 'chat', message: withLinks(entry) })
    }
    const target = typeof message.to === 'string' ? clients.get(message.to) : null
    if (!target || target.id === id || target.roomId !== sender.roomId) return safeSend(socket, { type: 'error', message: 'Usuário indisponível.' })

    if (message.type === 'watch-request') {
      if (message.mode !== undefined && !['auto', 'p2p', 'turn'].includes(message.mode)) return safeSend(socket, { type: 'error', message: 'Modo de conexão inválido.' })
      if (!target.broadcasting) return safeSend(socket, { type: 'error', message: 'Esta transmissão não está mais disponível.' })
      return safeSend(target.socket, { type: 'watch-request', from: id, fromName: sender.name, mode: message.mode || 'auto' })
    }
    if (message.type === 'restart-request') {
      if (!validConnectionId(message.connectionId)) return safeSend(socket, { type: 'error', message: 'Identificador de transmissão inválido.' })
      return safeSend(target.socket, { type: 'restart-request', from: id, connectionId: message.connectionId })
    }
    // Only the creator hands this out, and only to somebody who is in the room -- which is also the only
    // way the server learns who they are, since there are no accounts to look anybody up in.
    if (message.type === 'promote' || message.type === 'demote') {
      if (!room.permanent) return safeSend(socket, { type: 'error', message: 'Só uma sala permanente tem co-donos.' })
      if (!isOwner(room, authenticated)) return safeSend(socket, { type: 'error', message: 'Só quem criou a sala pode escolher co-donos.' })
      if (isOwner(room, { sub: target.id, name: target.name })) return safeSend(socket, { type: 'error', message: 'Essa pessoa já é dona da sala.' })
      const targetName = nameKey(target.name)
      if (message.type === 'promote') {
        room.coOwners.set(target.id, targetName)
        store.addCoOwner(authenticated.roomKey, target.id, targetName)
      } else {
        room.coOwners.delete(target.id)
        for (const [sub, name] of [...room.coOwners]) if (name === targetName) room.coOwners.delete(sub)
        store.removeCoOwner(authenticated.roomKey, target.id, targetName)
        // A co-owner who asked for the room to go and is then unappointed should not leave their
        // countdown running behind them.
        if (askedToDelete(room, { sub: target.id, name: target.name })) {
          room.deleteAfter = null; room.deleteBy = null; room.deleteByName = null
          store.setPendingDeletion(authenticated.roomKey, null, null, null)
          for (const client of roomClients(room.id)) safeSend(client.socket, { type: 'room-kept' })
        }
      }
      for (const client of roomClients(room.id)) safeSend(client.socket, { type: 'co-owners', coOwners: [...room.coOwners.keys()] })
      return broadcastUsers(room.id)
    }
    if (message.type === 'moderate') {
      // Moderation belongs to whoever made the room, which is the only standing left.
      if (sender.role !== 'owner' || !['kick', 'ban'].includes(message.action) || roleRank[sender.role] <= roleRank[target.role]) return safeSend(socket, { type: 'error', message: 'Ação não autorizada.' })
      if (message.action === 'ban') {
        const banned = target.name.toLocaleLowerCase('pt-BR')
        room.bannedNames.add(banned)
        // A ban that a restart forgets is not a ban.
        if (room.permanent) store.addBan(authenticated.roomKey, banned)
      }
      safeSend(target.socket, { type: message.action === 'ban' ? 'banned' : 'kicked' })
      target.socket.close(1008, message.action === 'ban' ? 'Banido' : 'Expulso')
      return
    }
    if (message.type === 'signal') {
      if (message.turnTransport !== undefined && !['direct', 'udp', 'all'].includes(message.turnTransport)) return safeSend(socket, { type: 'error', message: 'Transporte inválido.' })
      if (message.allowDirect !== undefined && typeof message.allowDirect !== 'boolean') return safeSend(socket, { type: 'error', message: 'Política de conexão inválida.' })
      if (message.mode !== undefined && !['auto', 'p2p', 'turn'].includes(message.mode)) return safeSend(socket, { type: 'error', message: 'Modo de conexão inválido.' })
      // A native sender receives no trickled candidates -- WHIP has no channel for them -- so the viewer
      // has to put all of its own inside the answer. It can only know to do that if the offer says so.
      if (message.nativeSender !== undefined && typeof message.nativeSender !== 'boolean') return safeSend(socket, { type: 'error', message: 'Origem de captura inválida.' })
      // Voice rides the same channel as video and has to be told apart on arrival, or an answer meant
      // for a microphone would be handed to a screen connection.
      if (message.voice !== undefined && typeof message.voice !== 'boolean') return safeSend(socket, { type: 'error', message: 'Canal de sinalização inválido.' })
      if (!validConnectionId(message.connectionId)) return safeSend(socket, { type: 'error', message: 'Identificador de transmissão inválido.' })
      const descriptionOk = message.description === undefined || validDescription(message.description)
      const candidateOk = message.candidate === undefined || validCandidate(message.candidate)
      if (!descriptionOk || !candidateOk || (message.description === undefined && message.candidate === undefined)) return safeSend(socket, { type: 'error', message: 'Sinal WebRTC inválido.' })
      return safeSend(target.socket, { type: 'signal', from: id, connectionId: message.connectionId, mode: message.mode, turnTransport: message.turnTransport, allowDirect: message.allowDirect, nativeSender: message.nativeSender, voice: message.voice, description: message.description, candidate: message.candidate })
    }
    if (message.type === 'stop') {
      if (!validConnectionId(message.connectionId)) return safeSend(socket, { type: 'error', message: 'Identificador de transmissão inválido.' })
      const reason = ['ice-timeout', 'signaling-timeout'].includes(message.reason) ? message.reason : undefined
      return safeSend(target.socket, { type: 'stop', from: id, connectionId: message.connectionId, reason })
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

// Run once before anything is served: a room whose two months ran out while the server was down should
// be gone by the time the first person looks, not on the next hour's turn.
sweepRooms()
const roomSweep = setInterval(sweepRooms, ROOM_SWEEP_MS)
roomSweep.unref?.()

const port = Number(process.env.PORT || 8787)
const host = process.env.HOST || '0.0.0.0'
server.listen(port, host, () => console.log(`Signaling server on ${tls ? 'https' : 'http'}://${host}:${port}`))
