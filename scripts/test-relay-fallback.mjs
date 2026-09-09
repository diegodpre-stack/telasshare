// Which relay is offered, and when. Cloudflare stays first because it can carry TURN over 443, which is
// what gets somebody out of a network that allows nothing else; ours takes over the moment Cloudflare
// cannot be used -- its allowance spent, its keys missing, or its API refusing to answer -- because the
// alternative is leaving people on STUN alone, and behind a symmetric NAT that means no picture at all.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'

const PORT = 8804
const BASE = `http://127.0.0.1:${PORT}`
const SECRET = 'segredo-de-teste-do-relay-proprio'
const HOST = 'telasshare.exemplo:3478'
let server = null

const start = async (extra) => {
  server = spawn(process.execPath, ['server/index.js'], {
    // Blanked rather than omitted: dotenv reads the developer's own .env, and a real Cloudflare key
    // sitting there would quietly turn these assertions into a live API call.
    env: {
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1', SESSION_SECRET: 'teste-de-relay',
      MONGODB_URI: '', CLOUDFLARE_TURN_KEY_ID: '', CLOUDFLARE_TURN_API_TOKEN: '',
      CLOUDFLARE_ACCOUNT_ID: '', CLOUDFLARE_ANALYTICS_API_TOKEN: '',
      COTURN_HOST: '', COTURN_SECRET: '', TURN_ENABLED: 'true', ...extra,
    },
    stdio: 'ignore',
  })
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 150))
    try { if ((await fetch(`${BASE}/health`)).ok) return } catch { /* not up yet */ }
  }
  throw new Error('the server never came up')
}
const stop = () => new Promise((resolve) => {
  if (!server) return resolve()
  const child = server; server = null
  child.once('exit', resolve); child.kill()
})
process.on('uncaughtException', async (error) => { await stop(); console.error(error); process.exit(1) })

const request = async (method, path, body, token) => {
  const response = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, body: await response.json().catch(() => null) }
}
// A temporary room, so none of this needs a database. A fresh name each time, since two rooms cannot
// share one and this is called more than once against the same server.
let salas = 0
const seatIn = async () => {
  salas += 1
  const session = (await request('POST', '/api/login', { name: `Pessoa ${salas}` })).body.session
  const created = await request('POST', '/api/rooms', { roomName: `Sala ${salas}`, password: '' }, session)
  if (!created.body?.room) throw new Error(`criar sala falhou: ${created.status} ${JSON.stringify(created.body)}`)
  return (await request('POST', `/api/rooms/${created.body.room.id}/join`, { password: '' }, session)).body.session
}
const ice = async (seat) => request('GET', '/api/ice-servers', undefined, seat)
const relayEntry = (body) => body.iceServers.find((entry) => JSON.stringify(entry.urls).includes('turn:'))

// --- ours takes over when Cloudflare cannot be used -------------------------
// No Cloudflare keys at all is one of the ways: the others are the allowance being spent and the API
// refusing to answer, and all three land in the same place.
await start({ COTURN_HOST: HOST, COTURN_SECRET: SECRET })
let seat = await seatIn()
const ours = await ice(seat)
assert.equal(ours.status, 200)
assert.equal(ours.body.turnEnabled, true, 'a relay is offered rather than STUN alone')
assert.equal(ours.body.relay, 'coturn', 'and it says which one, so this is visible rather than guessed at')

const entry = relayEntry(ours.body)
assert.ok(entry, 'there is a relay in the list')
// The order is the whole point: the client walks direct, then UDP relay, then everything. Relaying over
// TCP costs latency and exists only for networks that block UDP, so it must never be tried first.
assert.deepEqual(entry.urls, [`turn:${HOST}?transport=udp`, `turn:${HOST}?transport=tcp`])
assert.ok(JSON.stringify(ours.body.iceServers).includes('stun:'), 'and STUN is still there, so a direct pair keeps its priority')

// The credential is minted, not stored: username is "<expiry>:<name>" and the password is that string
// signed with the shared secret, which is what coturn checks with use-auth-secret.
const [expiry, who] = entry.username.split(':')
// Named for whoever asked, because coturn counts its quotas per username: one name shared by the room
// would mean the allocations a person is allowed are the allocations the room is allowed.
assert.match(who, /^[A-Za-z0-9_-]{12}$/, 'the name identifies the asker without carrying their session')
const seconds = Number(expiry)
assert.ok(Number.isInteger(seconds) && seconds > Math.floor(Date.now() / 1000), 'it expires in the future')
assert.ok(seconds < Math.floor(Date.now() / 1000) + 86_400, 'and not so far ahead that a stolen one is worth having')
assert.equal(entry.credential, crypto.createHmac('sha1', SECRET).update(entry.username).digest('base64'),
  'the password is the signature of the username, which is what the relay verifies')

// Two people asking get two credentials: nothing shared, nothing reused.
const second = relayEntry((await ice(await seatIn())).body)
assert.notEqual(second.credential, entry.credential, 'each one is minted for whoever asked')

// The status route agrees with what was handed out, so the page is not told one thing and given another.
const status = await request('GET', '/api/turn-status', undefined, seat)
assert.equal(status.body.turnEnabled, true)
assert.equal(status.body.relay, 'coturn')
assert.equal(status.body.blocked, false, 'blocked means nobody can relay, and somebody can')
assert.ok(!JSON.stringify(status.body).includes(SECRET), 'and the shared secret never leaves the server')
await stop()

// --- the hard switch still means no relay at all ----------------------------
// TURN_ENABLED=false is the one that has to win over everything, including ours: it is how somebody says
// "no relay", not "a different relay".
await start({ COTURN_HOST: HOST, COTURN_SECRET: SECRET, TURN_ENABLED: 'false' })
seat = await seatIn()
const off = await ice(seat)
assert.equal(off.body.turnEnabled, false)
assert.equal(relayEntry(off.body), undefined, 'no relay is offered')
assert.ok(JSON.stringify(off.body.iceServers).includes('stun:'), 'STUN alone, which is what was asked for')
assert.equal((await request('GET', '/api/turn-status', undefined, seat)).body.relay, null)
await stop()

// --- and without one configured, nothing changes ----------------------------
// The behaviour before any of this existed: no Cloudflare, no relay of our own, STUN and nothing else.
await start({})
seat = await seatIn()
const none = await ice(seat)
assert.equal(none.body.turnEnabled, false)
assert.equal(relayEntry(none.body), undefined)
assert.ok(JSON.stringify(none.body.iceServers).includes('stun:'))
// Half a configuration is not a configuration: a host with no secret cannot sign anything.
await stop()
await start({ COTURN_HOST: HOST })
seat = await seatIn()
assert.equal((await ice(seat)).body.turnEnabled, false, 'a host without a secret offers nothing')
await stop()
await start({ COTURN_SECRET: SECRET })
seat = await seatIn()
assert.equal((await ice(seat)).body.turnEnabled, false, 'and a secret without a host has nowhere to point')
await stop()

// --- none of this is readable from outside a room ---------------------------
await start({ COTURN_HOST: HOST, COTURN_SECRET: SECRET })
const outsider = (await request('POST', '/api/login', { name: 'Estranho' })).body.session
assert.equal((await request('GET', '/api/ice-servers', undefined, outsider)).status, 401, 'a site session is not a room seat')
assert.equal((await request('GET', '/api/ice-servers')).status, 401, 'and nothing at all is refused')
await stop()

console.log('PASS: with Cloudflare unusable the room is given our own relay rather than STUN alone, UDP before TCP and STUN still present so a direct pair keeps its priority; the credential is a signature of its own username, expires within the day and differs per person, and the shared secret never leaves the server; the status route agrees with what was handed out; TURN_ENABLED=false still means no relay at all; half a configuration offers nothing; and none of it is readable without a room seat.')
