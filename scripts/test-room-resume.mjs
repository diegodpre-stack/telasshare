// Coming back to a room without typing its password again -- and, much more importantly, all the ways
// that must not work. Remembering a password-protected room is a convenience that sits directly on top
// of the thing protecting the room, so the interesting assertions here are the refusals.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRoomSeats } from '../src/roomSeats.js'
import { startMongo } from './testMongo.mjs'

const BASE = 'http://127.0.0.1:8797'
const folder = mkdtempSync(join(tmpdir(), 'telasshare-'))
const mongo = await startMongo()
let server = null

const start = async () => {
  server = spawn(process.execPath, ['server/index.js'], {
    env: {
      ...process.env, PORT: '8797', HOST: '127.0.0.1', SESSION_SECRET: 'teste-de-volta',
      MONGODB_URI: mongo.uri, MONGODB_DB: 'volta', FILES_DIR: join(folder, 'arquivos'),
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
process.on('exit', cleanUp)
process.on('uncaughtException', (error) => { cleanUp(); console.error(error); process.exit(1) })

const request = async (method, path, body, token) => {
  const response = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, body: await response.json().catch(() => null) }
}
const login = async (name) => (await request('POST', '/api/login', { name })).body.session
const enter = (id, session, body) => request('POST', `/api/rooms/${id}/join`, body, session)

await start()
const SENHA = 'senha-da-sala'

// --- the store, on its own ------------------------------------------------
const fakeStorage = (data = {}) => ({ getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v) } })
const store = fakeStorage()
const seats = createRoomSeats({ storage: store })
assert.equal(seats.get('sala-1'), '', 'nothing is remembered to begin with')
seats.remember('sala-1', 'assento')
assert.equal(createRoomSeats({ storage: store }).get('sala-1'), 'assento', 'and it survives a reload')
seats.forget('sala-1')
assert.equal(seats.get('sala-1'), '', 'forgetting one room forgets that room')
seats.remember('sala-1', 'a'); seats.remember('sala-2', 'b')
seats.clear()
assert.deepEqual(seats.rooms, [], 'leaving the site clears them all')
// Junk in the store is not handed to the server as though it were a credential.
for (const junk of ['[]', 'null', 'nao json', '{"sala":123}', '{"sala":{"tudo":true}}']) {
  assert.equal(createRoomSeats({ storage: fakeStorage({ 'telasshare-room-seats': junk }) }).get('sala'), '', `${junk} yields nothing`)
}
assert.doesNotThrow(() => {
  const refuses = createRoomSeats({ storage: { getItem() { throw new Error('no') }, setItem() { throw new Error('no') } } })
  refuses.remember('sala', 'assento')
})

// --- the round trip -------------------------------------------------------
const diego = await login('Diego')
const room = (await request('POST', '/api/rooms', { roomName: 'Sala com senha', password: SENHA, permanent: true }, diego)).body.room

assert.equal((await enter(room.id, diego, { password: 'errada' })).status, 401, 'the password still guards the door')
const first = await enter(room.id, diego, { password: SENHA })
assert.equal(first.status, 200)
const seat = first.body.session

// Leaving is a client-side act; what matters is that the seat opens the room again with no password.
const again = await enter(room.id, diego, { password: '', seat })
assert.equal(again.status, 200, 'the same browser walks back in')
assert.equal(again.body.roomName, 'Sala com senha')
assert.equal(again.body.role, 'owner', 'and is still recognised as the owner')

// --- the refusals ---------------------------------------------------------
// Another machine, or the desktop app: same person, same name, different site session.
const outroAparelho = await login('Diego')
assert.equal((await enter(room.id, outroAparelho, { password: '', seat })).status, 401,
  'a seat carried to another platform is not accepted, even with the same name')
assert.equal((await enter(room.id, outroAparelho, { password: SENHA })).status, 200, 'that platform types the password once')

// A seat for one room does not open another.
const outra = (await request('POST', '/api/rooms', { roomName: 'Outra sala', password: 'outra-senha', permanent: true }, diego)).body.room
assert.equal((await enter(outra.id, diego, { password: '', seat })).status, 401, 'a seat names one room only')

// Nothing invented, edited or of the wrong kind is taken.
const [body, signature] = seat.split('.')
for (const forged of ['', 'inventado', `${body}.${'a'.repeat(signature.length)}`, `${body}x.${signature}`, diego]) {
  assert.equal((await enter(room.id, diego, { password: '', seat: forged })).status, 401, `${forged.slice(0, 12)} is refused`)
}
// A site session is not a room seat, even though both are signed by the same server.
assert.equal((await enter(room.id, diego, { password: '', seat: diego })).status, 401, 'the kinds are not interchangeable')

// Every one of those refusals counts as a failed attempt, and after ten the door stops answering at
// all -- which is the point of the limiter and worth pinning down rather than working around.
let limited = null
for (let i = 0; i < 12 && !limited; i += 1) {
  const attempt = await enter(room.id, diego, { password: 'errada' })
  if (attempt.status === 429) limited = attempt
}
assert.ok(limited, 'guessing in bulk stops being answered')
assert.match(limited.body.error, /dez minutos/)
// A good seat is refused too while the limiter holds: it is the address that is being shut out, not the
// credential that is being judged.
assert.equal((await enter(room.id, diego, { password: '', seat })).status, 429, 'and it shuts the door for everything, not just guesses')

// The attempts are held in memory, so a restart clears them. That is also how the rest of this file
// gets a clean slate to keep asserting in.
server.kill()
await new Promise((resolve) => server.once('exit', resolve))
await start()
assert.equal((await enter(room.id, diego, { password: '', seat })).status, 200, 'and the seat still works afterwards')

// Anything that is not a string at all changes nothing.
for (const wrong of [null, 42, { seat }, ['x']]) {
  assert.equal((await enter(room.id, diego, { password: '', seat: wrong })).status, 401, 'a seat has to be a string')
}

// An open room never needed any of this.
const aberta = (await request('POST', '/api/rooms', { roomName: 'Sala aberta', password: '', permanent: true }, diego)).body.room
assert.equal((await enter(aberta.id, diego, { password: '' })).status, 200)

// The seat is signed rather than stored, which is why it survived that restart: the server keeps no
// list of who is allowed back in, so there is nothing to lose and nothing to grow.

cleanUp()
console.log('PASS: a seat earned with the password reopens that room with no password, survives a server restart, is shut out along with everything else once the attempt limiter engages, and is refused when it comes from another platform, names another room, is forged, edited, of the wrong kind, or is not a string; the store survives junk and a storage that refuses to write.')
process.exit(0)
