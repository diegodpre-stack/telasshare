// Ownership, co-ownership and the two clocks, against the real server. The waits are measured in days
// in production and in fractions of a second here, which is what the environment overrides are for --
// the code under test is the same either way.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { startMongo } from './testMongo.mjs'

const BASE = 'http://127.0.0.1:8793'
const folder = mkdtempSync(join(tmpdir(), 'telasshare-'))
const mongo = await startMongo()
// Three days becomes one second. The two-month clock is kept far out of reach for most of this file --
// a first attempt set it to three seconds and the rooms under test quietly died of old age in the
// middle of the co-owner assertions, which read as the wrong thing failing.
const DELAY_MS = 1_000
const IDLE_FAR = 120_000
const IDLE_NEAR = 2_500
let server = null

const start = async (extra = {}) => {
  server = spawn(process.execPath, ['server/index.js'], {
    env: {
      ...process.env, PORT: '8793', HOST: '127.0.0.1', SESSION_SECRET: 'teste-de-posse', MONGODB_URI: mongo.uri, MONGODB_DB: 'teste',
      ROOM_IDLE_MS: String(IDLE_FAR), ROOM_DELETE_DELAY_MS: String(DELAY_MS), ROOM_SWEEP_MS: '200',
      ...extra,
    },
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
  server.once('exit', resolve); server.kill(); server = null
})
const cleanUp = () => { try { server?.kill() } catch { /* gone */ } try { mongo?.stop() } catch { /* gone */ } try { rmSync(folder, { recursive: true, force: true }) } catch { /* gone */ } }
process.on('exit', cleanUp)
process.on('uncaughtException', (error) => { cleanUp(); console.error(error); process.exit(1) })

const settle = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms))
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
  const socket = new WebSocket(`ws://127.0.0.1:8793?session=${encodeURIComponent(session)}`)
  const inbox = []
  socket.on('error', reject)
  socket.on('message', (raw) => inbox.push(JSON.parse(raw.toString())))
  socket.on('open', () => {
    socket.send(JSON.stringify({ type: 'hello', name }))
    setTimeout(() => resolve({ socket, inbox, send: (message) => socket.send(JSON.stringify(message)) }), 250)
  })
})
const roomsFor = async (token) => (await request('GET', '/api/rooms', undefined, token)).body.rooms
const roomFor = async (token, id) => (await roomsFor(token)).find((room) => room.id === id)
const make = async (token, name) => (await request('POST', '/api/rooms', { roomName: name, password: '', permanent: true }, token)).body.room
const enter = async (token, id) => (await request('POST', `/api/rooms/${id}/join`, { password: '' }, token)).body.session

await start()

// --- the creator, and nobody else -----------------------------------------
const owner = await login('Diego')
const friend = await login('Amigo')
const stranger = await login('Estranho')
const room = await make(owner, 'Sala de posse')
assert.equal((await roomFor(owner, room.id)).owned, true, 'the creator is told the room is theirs')
assert.equal((await roomFor(friend, room.id)).owned, false)

// --- the same person on another machine -----------------------------------
// Standing follows the name as well as the session, so signing in somewhere else with the same name is
// the same person. The price is that the name proves nothing: anybody who types it is treated as them.
const otherMachine = await login('Diego')
assert.notEqual(otherMachine, owner, 'a second sign-in really is a different session')
assert.equal((await roomFor(otherMachine, room.id)).owned, true, 'and it is still the creator')

// A different name is a different person, however similar.
const almost = await login('Diego2')
assert.equal((await roomFor(almost, room.id)).owned, false)

// The comparison ignores case and stray spacing, because a person typing their own name will not be
// careful about either.
const shouting = await login('  DIEGO  ')
assert.equal((await roomFor(shouting, room.id)).owned, true, 'the same name typed carelessly is the same name')

// --- the password guards destroying, not only entering --------------------
// Standing rests on a name anybody can type, so it cannot be the only thing between a room and its
// destruction. Measured before this was fixed: somebody who could not get past the door could still
// delete the room from outside it.
const guarded = (await request('POST', '/api/rooms', { roomName: 'Sala trancada', password: 'segredo', permanent: true }, owner)).body.room
const elsewhere = await login('Diego')
assert.equal((await roomFor(elsewhere, guarded.id)).owned, true, 'recognised as the creator')
assert.equal((await request('POST', `/api/rooms/${guarded.id}/join`, { password: 'chute' }, elsewhere)).status, 401, 'and still cannot get in')
assert.equal((await request('POST', `/api/rooms/${guarded.id}/delete`, { password: 'chute' }, elsewhere)).status, 401, 'nor destroy it')
assert.equal((await request('POST', `/api/rooms/${guarded.id}/delete`, {}, elsewhere)).status, 401, 'nor by not answering at all')
assert.ok(await roomFor(owner, guarded.id), 'the room is still there')
// With the password, the same person can.
assert.equal((await request('POST', `/api/rooms/${guarded.id}/delete`, { password: 'segredo' }, elsewhere)).status, 200)
assert.equal(await roomFor(owner, guarded.id), undefined)

// An open room has no password to ask for, and asking for one anyway would make it undeletable.
const openRoom = (await request('POST', '/api/rooms', { roomName: 'Sala aberta', password: '', permanent: true }, owner)).body.room
assert.equal((await request('POST', `/api/rooms/${openRoom.id}/delete`, {}, owner)).status, 200)

// --- appointing a co-owner ------------------------------------------------
// Only somebody in the room can be appointed: there are no accounts, so being present is the only way
// the server ever learns who somebody is.
const ownerSocket = await open(await enter(owner, room.id), 'Diego')
const friendSocket = await open(await enter(friend, room.id), 'Amigo')
await settle()
const friendId = friendSocket.inbox.find((message) => message.type === 'welcome').id
assert.equal(ownerSocket.inbox.find((message) => message.type === 'welcome').permanent, true)

// A co-owner cannot appoint anybody, and neither can an ordinary member.
friendSocket.send({ type: 'promote', to: ownerSocket.inbox.find((m) => m.type === 'welcome').id })
await settle()
assert.ok(friendSocket.inbox.some((message) => message.type === 'error'), 'a member is refused')

ownerSocket.send({ type: 'promote', to: friendId })
await settle()
assert.deepEqual(friendSocket.inbox.filter((m) => m.type === 'co-owners').at(-1).coOwners, [friendId], 'everybody is told who the co-owners are')
assert.equal((await roomFor(friend, room.id)).coOwner, true)
assert.equal((await roomFor(stranger, room.id)).coOwner, false)

// --- what a co-owner can and cannot do ------------------------------------
// A stranger cannot even start the countdown.
assert.equal((await request('POST', `/api/rooms/${room.id}/delete`, { password: '' }, stranger)).status, 403)
assert.equal((await roomFor(stranger, room.id)).deleteAfter, null)

// The co-owner starts it, and the room is still there -- that is the difference that matters.
const asked = await request('POST', `/api/rooms/${room.id}/delete`, { password: '' }, friend)
assert.equal(asked.status, 200)
assert.equal(asked.body.deleted, false, 'asking is not deleting')
assert.ok(asked.body.deleteAfter > Date.now(), 'it is scheduled, not done')
assert.equal((await roomFor(owner, room.id)).deleteByName, 'Amigo', 'and the room says who asked')
await settle()
assert.ok(ownerSocket.inbox.some((message) => message.type === 'room-closing'), 'the room is told out loud')

// Asking again does not bring it forward.
const firstDeadline = (await roomFor(owner, room.id)).deleteAfter
await settle(300)
await request('POST', `/api/rooms/${room.id}/delete`, { password: '' }, friend)
assert.equal((await roomFor(owner, room.id)).deleteAfter, firstDeadline, 'the first request is the one that counts')

// --- the creator says no --------------------------------------------------
assert.equal((await request('POST', `/api/rooms/${room.id}/keep`, { password: '' }, stranger)).status, 403)
assert.equal((await request('POST', `/api/rooms/${room.id}/keep`, { password: '' }, owner)).status, 200)
assert.equal((await roomFor(owner, room.id)).deleteAfter, null)
await settle(DELAY_MS + 600)
assert.ok(await roomFor(owner, room.id), 'and the room outlives the deadline it was given')

// --- when nobody says no --------------------------------------------------
await request('POST', `/api/rooms/${room.id}/delete`, { password: '' }, friend)
await settle(DELAY_MS + 600)
assert.equal(await roomFor(owner, room.id), undefined, 'an uncontested countdown does run out')

// --- unappointing takes the countdown with it -----------------------------
const second = await make(owner, 'Segunda sala')
const ownerTwo = await open(await enter(owner, second.id), 'Diego')
const friendTwo = await open(await enter(friend, second.id), 'Amigo')
await settle()
const friendTwoId = friendTwo.inbox.find((message) => message.type === 'welcome').id
ownerTwo.send({ type: 'promote', to: friendTwoId })
await settle()
await request('POST', `/api/rooms/${second.id}/delete`, { password: '' }, friend)
assert.ok((await roomFor(owner, second.id)).deleteAfter, 'the countdown is running')
ownerTwo.send({ type: 'demote', to: friendTwoId })
await settle()
assert.equal((await roomFor(owner, second.id)).deleteAfter, null, 'and taking the standing away stops it')
assert.equal((await roomFor(friend, second.id)).coOwner, false)
await settle(DELAY_MS + 600)
assert.ok(await roomFor(owner, second.id), 'so the room is still here')

// --- the two-month clock, and what resets it ------------------------------
// Brought within reach on its own server, so the rooms above are never at risk of expiring underneath
// the assertions that are actually about something else.
ownerTwo.socket.close(); friendTwo.socket.close()
await stopServer()
await start({ ROOM_IDLE_MS: String(IDLE_NEAR) })
const idle = await make(owner, 'Sala esquecida')

// Anybody walking in is enough. It does not have to be the creator, because the question is whether the
// room is still used rather than by whom.
await settle(IDLE_NEAR * 0.7)
await enter(stranger, idle.id)
await settle(IDLE_NEAR * 0.7)
assert.ok(await roomFor(owner, idle.id), 'a visit from anybody put the clock back')

// Left alone, it goes.
await settle(IDLE_NEAR + 600)
assert.equal(await roomFor(owner, idle.id), undefined, 'a room nobody visits does not last forever')

// And a room that ran out while the server was down is gone by the time anybody looks, rather than
// surviving until the next sweep would have come round.
const forgotten = await make(owner, 'Outra esquecida')
await stopServer()
await settle(IDLE_NEAR + 400)
await start({ ROOM_IDLE_MS: String(IDLE_NEAR) })
assert.equal(await roomFor(owner, forgotten.id), undefined, 'it expired while nothing was running')

await stopServer()
await start()

// --- a co-owner is recognised on another machine too ----------------------
const fourth = await make(owner, 'Quarta sala')
const ownerFour = await open(await enter(owner, fourth.id), 'Diego')
const friendFour = await open(await enter(friend, fourth.id), 'Amigo')
await settle()
ownerFour.send({ type: 'promote', to: friendFour.inbox.find((message) => message.type === 'welcome').id })
await settle()
const friendElsewhere = await login('Amigo')
assert.equal((await roomFor(friendElsewhere, fourth.id)).coOwner, true, 'the same name is the same co-owner')

// Asking from one machine and taking it back from another is the same person changing their mind.
await request('POST', `/api/rooms/${fourth.id}/delete`, { password: '' }, friendElsewhere)
assert.ok((await roomFor(owner, fourth.id)).deleteAfter, 'the countdown started')
assert.equal((await request('POST', `/api/rooms/${fourth.id}/keep`, { password: '' }, friend)).status, 200, 'and they can stop it from the other one')
assert.equal((await roomFor(owner, fourth.id)).deleteAfter, null)

// Unappointing reaches the name, not just the session that happened to be promoted -- otherwise they
// would still be a co-owner from anywhere else they had signed in.
ownerFour.send({ type: 'demote', to: friendFour.inbox.find((message) => message.type === 'welcome').id })
await settle()
assert.equal((await roomFor(friendElsewhere, fourth.id)).coOwner, false, 'the standing is gone everywhere')
assert.equal((await request('POST', `/api/rooms/${fourth.id}/delete`, { password: '' }, friendElsewhere)).status, 403)
ownerFour.socket.close(); friendFour.socket.close()

// --- and it is the same after a restart -----------------------------------
const third = await make(owner, 'Terceira sala')
const ownerThree = await open(await enter(owner, third.id), 'Diego')
const friendThree = await open(await enter(friend, third.id), 'Amigo')
await settle()
ownerThree.send({ type: 'promote', to: friendThree.inbox.find((message) => message.type === 'welcome').id })
await settle()
ownerThree.socket.close(); friendThree.socket.close()
await stopServer()
await start()
assert.equal((await roomFor(friend, third.id)).coOwner, true, 'a co-owner is still one after a restart')
assert.equal((await roomFor(owner, third.id)).owned, true, 'and the creator is still the creator')

// A countdown started before a restart keeps running through it rather than being forgotten.
await request('POST', `/api/rooms/${third.id}/delete`, { password: '' }, friend)
await stopServer()
await start()
assert.ok((await roomFor(owner, third.id)).deleteAfter, 'the countdown came back')
await settle(DELAY_MS + 800)
assert.equal(await roomFor(owner, third.id), undefined, 'and it finished')

ownerSocket.socket.close(); friendSocket.socket.close()
await stopServer()
await mongo.stop()
cleanUp()
console.log('PASS: the room password is required to destroy a room and not only to enter it; standing follows the name as well as the session, so the same person is themselves on another machine; the creator owns the room outright and alone appoints co-owners; a co-owner can only start a countdown, which the creator can stop and which unappointing them cancels; an uncontested one runs out; a visit from anybody resets the two-month clock and an unvisited room goes; and all of it survives a restart.')
process.exit(0)
