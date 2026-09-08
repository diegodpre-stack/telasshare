// Persistence is only worth anything if it survives the thing it exists for, so this kills the server
// and starts a new one against the same file. Nothing here inspects the database directly: what matters
// is what a client sees after the restart, which is the only thing anybody actually experiences.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { startMongo } from './testMongo.mjs'

const BASE = 'http://127.0.0.1:8792'
const folder = mkdtempSync(join(tmpdir(), 'telasshare-'))
const mongo = await startMongo()
let server = null

const start = async () => {
  server = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: '8792', HOST: '127.0.0.1', SESSION_SECRET: 'teste-de-persistencia', MONGODB_URI: mongo.uri, MONGODB_DB: 'teste' },
    stdio: 'ignore',
  })
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 150))
    try { if ((await fetch(`${BASE}/health`)).ok) return } catch { /* not up yet */ }
  }
  throw new Error('the server never came up')
}
const stopServer = () => new Promise((resolve) => {
  if (!server) return resolve()
  server.once('exit', resolve)
  server.kill()
  server = null
})
const cleanUp = () => { try { server?.kill() } catch { /* gone */ } try { mongo?.stop() } catch { /* gone */ } try { rmSync(folder, { recursive: true, force: true }) } catch { /* gone */ } }
process.on('exit', cleanUp)
process.on('uncaughtException', (error) => { cleanUp(); console.error(error); process.exit(1) })

const settle = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms))
const request = async (method, path, body, token) => {
  const response = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, body: await response.json().catch(() => null) }
}
const login = async (name) => (await request('POST', '/api/login', { name })).body.session
const open = (session, name) => new Promise((resolve, reject) => {
  const socket = new WebSocket(`ws://127.0.0.1:8792?session=${encodeURIComponent(session)}`)
  const inbox = []
  socket.on('error', reject)
  socket.on('message', (raw) => inbox.push(JSON.parse(raw.toString())))
  socket.on('open', () => {
    socket.send(JSON.stringify({ type: 'hello', name }))
    setTimeout(() => resolve({ socket, inbox, send: (message) => socket.send(JSON.stringify(message)) }), 250)
  })
})
const roomsFor = async (token) => (await request('GET', '/api/rooms', undefined, token)).body.rooms

await start()

// --- a room that is meant to last -----------------------------------------
const diego = await login('Diego')
const permanent = (await request('POST', '/api/rooms', { roomName: 'Sala fixa', password: 'segredo', permanent: true }, diego)).body.room
const temporary = (await request('POST', '/api/rooms', { roomName: 'Sala passageira', password: '' }, diego)).body.room
assert.equal(permanent.permanent, true)
assert.equal(temporary.permanent, false, 'a room that was not asked to last says so plainly')

const seat = (await request('POST', `/api/rooms/${permanent.id}/join`, { password: 'segredo' }, diego)).body.session
const before = await open(seat, 'Diego')
before.send({ type: 'chat', text: 'isso tem que sobreviver' })
before.send({ type: 'chat', text: 'e isso tambem' })
await settle()
before.socket.close()
// Long enough that a temporary room would have been swept away.
await settle(16_000)
assert.ok((await roomsFor(diego)).some((room) => room.id === permanent.id), 'an empty permanent room is still there')
assert.ok(!(await roomsFor(diego)).some((room) => room.id === temporary.id), 'and a temporary one is not')

// --- the restart ----------------------------------------------------------
await stopServer()
await start()

const listed = await roomsFor(await login('Diego'))
const restored = listed.find((room) => room.name === 'Sala fixa')
assert.ok(restored, 'the room came back')
assert.equal(restored.permanent, true)
assert.equal(restored.open, false, 'and it came back still asking for its password')
assert.equal(listed.length, 1, 'the temporary one did not come back')

// The password survived as a hash that still matches, which is the part that would be easy to get wrong.
const diegoAgain = await login('Diego')
assert.equal((await request('POST', `/api/rooms/${restored.id}/join`, { password: 'errada' }, diegoAgain)).status, 401)
const seatAgain = (await request('POST', `/api/rooms/${restored.id}/join`, { password: 'segredo' }, diegoAgain)).body.session
assert.ok(seatAgain, 'and the right password still opens it')

// --- and the conversation in it -------------------------------------------
const after = await open(seatAgain, 'Diego')
await settle()
const history = after.inbox.find((message) => message.type === 'chat-history')
assert.deepEqual(history.messages.map((message) => message.text), ['isso tem que sobreviver', 'e isso tambem'])
assert.equal(history.messages[0].fromName, 'Diego', 'with who said it')
assert.ok(history.messages[0].at > 0, 'and when')

// A message sent now joins the ones from before rather than replacing them.
after.send({ type: 'chat', text: 'depois de reiniciar' })
await settle()
after.socket.close()
await stopServer()
await start()

// The very first token, from before two restarts: it is signed rather than stored, so it still works --
// and it is what makes the creator still the creator.
const third = await open((await request('POST', `/api/rooms/${restored.id}/join`, { password: 'segredo' }, diego)).body.session, 'Diego')
assert.equal((await roomsFor(diego)).length, 1, 'the original session outlives the restarts')
await settle()
assert.deepEqual(
  third.inbox.find((message) => message.type === 'chat-history').messages.map((message) => message.text),
  ['isso tem que sobreviver', 'e isso tambem', 'depois de reiniciar'],
)

// --- taking one away ------------------------------------------------------
// Somebody who did not create it cannot delete it, and the room is untouched by their asking.
const outsider = await login('Estranho')
assert.equal((await request('POST', `/api/rooms/${restored.id}/delete`, { password: 'segredo' }, outsider)).status, 403)
assert.equal((await roomsFor(outsider)).length, 1)

// Somebody signing in under the creator's name, however, is treated as the creator. That is the
// deliberate trade for having no accounts: standing follows the name so the same person is themselves
// on another machine, and the price is that the name proves nothing. See test-room-ownership.
const sameName = await login('Diego')
assert.notEqual(sameName, diego, 'a different session')
assert.equal((await request('POST', `/api/rooms/${restored.id}/delete`, { password: 'segredo' }, sameName)).status, 200)
assert.equal((await roomsFor(sameName)).length, 0)
third.socket.close()
await stopServer()
await start()
assert.equal((await roomsFor(diego)).length, 0, 'a deleted room does not come back')

await stopServer()
await mongo.stop()
cleanUp()
console.log('PASS: a permanent room outlives an empty room and two restarts, with its password still matching and its conversation intact; new messages join the old ones; a temporary room still vanishes; a stranger is refused deletion while somebody using the same name as the creator is not; and a deletion survives the restart.')
process.exit(0)
