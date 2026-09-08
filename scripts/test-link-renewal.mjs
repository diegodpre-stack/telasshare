// A file address carries its own permission and that permission expires, so a page left open long
// enough ends up holding links that no longer work. This is the way back: the page asks, and gets
// addresses minted afresh -- without being handed anything it was not already entitled to.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { startMongo } from './testMongo.mjs'

const BASE = 'http://127.0.0.1:8802'
const folder = mkdtempSync(join(tmpdir(), 'telasshare-'))
const mongo = await startMongo()
// Two seconds instead of six hours, so a genuinely dead link can be produced rather than simulated.
const LINK_MS = 2_000
let server = null

const start = async () => {
  server = spawn(process.execPath, ['server/index.js'], {
    env: {
      ...process.env, PORT: '8802', HOST: '127.0.0.1', SESSION_SECRET: 'teste-de-renovacao',
      MONGODB_URI: mongo.uri, MONGODB_DB: 'renovacao', FILES_DIR: join(folder, 'arquivos'),
      FILE_LINK_MS: String(LINK_MS),
    },
    stdio: 'ignore',
  })
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 150))
    try { if ((await fetch(`${BASE}/health`)).ok) return } catch { /* not up yet */ }
  }
  throw new Error('the server never came up')
}
const cleanUp = () => {
  try { server?.kill() } catch { /* gone */ }
  try { mongo?.stop() } catch { /* gone */ }
  try { rmSync(folder, { recursive: true, force: true }) } catch { /* gone */ }
}
process.on('uncaughtException', (error) => { cleanUp(); console.error(error); process.exit(1) })

const request = async (method, path, body, token) => {
  const response = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, body: await response.json().catch(() => null) }
}
const jpeg = (size) => { const buffer = Buffer.alloc(size, 7); buffer.set([0xff, 0xd8, 0xff, 0xe0]); return buffer }

// A socket that collects what the server sends, so the answers can be waited for by type.
const connect = (seat) => new Promise((resolve, reject) => {
  const socket = new WebSocket(`ws://127.0.0.1:8802/?session=${encodeURIComponent(seat)}`)
  const seen = []
  socket.on('message', (raw) => { try { seen.push(JSON.parse(raw)) } catch { /* not ours */ } })
  socket.on('error', reject)
  socket.on('open', () => resolve({
    socket,
    seen,
    ask: (message) => socket.send(JSON.stringify(message)),
    async waitFor(type, timeout = 5_000) {
      const deadline = Date.now() + timeout
      for (;;) {
        const found = seen.find((entry) => entry.type === type)
        if (found) return found
        if (Date.now() > deadline) throw new Error(`nothing of type ${type} arrived`)
        await new Promise((r) => setTimeout(r, 50))
      }
    },
  }))
})

await start()
const diego = await request('POST', '/api/login', { name: 'Diego' })
const session = diego.body.session
const room = (await request('POST', '/api/rooms', { roomName: 'Sala com foto', password: '', permanent: true }, session)).body.room
const seat = (await request('POST', `/api/rooms/${room.id}/join`, { password: '' }, session)).body.session

const sent = await fetch(`${BASE}/api/room/files`, {
  method: 'POST',
  headers: { authorization: `Bearer ${seat}`, 'content-type': 'application/octet-stream', 'x-file-name': 'foto.jpg' },
  body: jpeg(2_000),
})
const file = (await sent.json()).file
assert.equal((await fetch(BASE + file.url)).status, 200, 'the address works when it is new')

// --- it really does die ----------------------------------------------------
await new Promise((resolve) => setTimeout(resolve, LINK_MS + 300))
assert.equal((await fetch(BASE + file.url)).status, 401, 'and stops working once it has expired')

// --- and asking brings it back ---------------------------------------------
const client = await connect(seat)
// The socket says nothing until it is identified; the history arrives as part of that.
client.ask({ type: 'hello' })
await client.waitFor('chat-history')
client.ask({ type: 'history' })
const renewed = await client.waitFor('chat-links')
assert.ok(Array.isArray(renewed.links) && renewed.links.length === 1, 'one file, one address')
assert.notEqual(renewed.links[0].url, file.url, 'a different address, not the one that expired')
assert.equal((await fetch(BASE + renewed.links[0].url)).status, 200, 'and this one opens')

// The renewal carries addresses and nothing else: it must not become a second way to read the room.
assert.deepEqual(Object.keys(renewed).sort(), ['links', 'type'])
assert.deepEqual(Object.keys(renewed.links[0]).sort(), ['id', 'url'])
assert.ok(!JSON.stringify(renewed).includes('Sala com foto'), 'no room detail rides along')

// --- and only for somebody who is in the room -------------------------------
// The socket is what proves membership, and it is refused without a room session -- so there is no way
// to ask for a renewal from outside. Worth pinning: this route hands out working file addresses.
const outsider = await request('POST', '/api/login', { name: 'Estranho' })
await new Promise((resolve) => {
  const socket = new WebSocket(`ws://127.0.0.1:8802/?session=${encodeURIComponent(outsider.body.session)}`)
  socket.on('close', (code) => { assert.equal(code, 1008, 'a site session cannot open the room socket'); resolve() })
  socket.on('error', () => resolve())
})

client.socket.close()
await new Promise((resolve) => setTimeout(resolve, 200))
cleanUp()
console.log('PASS: a file address expires and stops working, asking over the room socket returns a freshly minted one that does open, the renewal carries ids and addresses and no room detail, and it cannot be asked for from outside the room.')
