// Starts the real signalling server and drives two clients through it. The voice mesh is only as good
// as the presence and the relay underneath it, and neither of those is visible from a unit test.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { WebSocket } from 'ws'

const BASE = 'http://127.0.0.1:8799'
const server = spawn(process.execPath, ['server/index.js'], {
  env: { ...process.env, PORT: '8799', HOST: '127.0.0.1', SESSION_SECRET: 'teste-de-voz' },
  stdio: 'ignore',
})
const stop = () => { try { server.kill() } catch { /* already gone */ } }
process.on('exit', stop)
process.on('uncaughtException', (error) => { stop(); console.error(error); process.exit(1) })

const settle = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms))
await settle(1800)

const post = async (path, body, token) => (await fetch(BASE + path, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
})).json()

const diego = (await post('/api/login', { name: 'Diego' })).session
const amigo = (await post('/api/login', { name: 'Amigo' })).session
const { room } = await post('/api/rooms', { roomName: 'Sala de voz', password: '' }, diego)
const seat = async (site) => (await post(`/api/rooms/${room.id}/join`, { password: '' }, site)).session

const open = (session, name) => new Promise((resolve, reject) => {
  const socket = new WebSocket(`ws://127.0.0.1:8799?session=${encodeURIComponent(session)}`)
  const inbox = []
  socket.on('error', reject)
  socket.on('message', (raw) => inbox.push(JSON.parse(raw.toString())))
  socket.on('open', () => {
    socket.send(JSON.stringify({ type: 'hello', name }))
    setTimeout(() => resolve({ socket, inbox, send: (message) => socket.send(JSON.stringify(message)) }), 200)
  })
})

const one = await open(await seat(diego), 'Diego')
const two = await open(await seat(amigo), 'Amigo')
await settle()

const usersSeenBy = (client) => client.inbox.filter((message) => message.type === 'users').at(-1).users
const idOf = (client) => client.inbox.find((message) => message.type === 'welcome').id

// --- presence -------------------------------------------------------------
// Who is in voice is what every peer uses to decide whom to open a connection to, so it has to travel
// with the room list rather than being discovered by trying.
assert.ok(usersSeenBy(two).every((user) => user.voice === false), 'nobody is in voice on arrival')
one.send({ type: 'voice-join' })
await settle()
assert.equal(usersSeenBy(two).find((user) => user.name === 'Diego').voice, true)
assert.equal(usersSeenBy(one).find((user) => user.name === 'Diego').voice, true, 'and you can see your own state')

// Joining voice must not make anyone look like they are sharing a screen.
assert.ok(usersSeenBy(two).every((user) => user.broadcasting === false), 'voice is not a broadcast')

// --- the relay ------------------------------------------------------------
two.send({ type: 'voice-join' })
await settle()
one.send({ type: 'signal', to: idOf(two), connectionId: 'voz-0123456789ab', voice: true, description: { type: 'offer', sdp: 'v=0' } })
await settle()
const relayed = two.inbox.filter((message) => message.type === 'signal').at(-1)
assert.equal(relayed.voice, true, 'the flag that separates voice from a screen survives the relay')
assert.equal(relayed.connectionId, 'voz-0123456789ab')
assert.equal(relayed.from, idOf(one))

// Anything but a boolean is refused rather than passed along: the receiving side branches on it.
one.send({ type: 'signal', to: idOf(two), connectionId: 'voz-0123456789ab', voice: 'sim', description: { type: 'offer', sdp: 'v=0' } })
await settle()
assert.equal(one.inbox.at(-1).type, 'error')

// A restart request on a voice connection reaches the other side with its id intact; that id is the
// only thing telling the receiver to hand it to the voice mesh instead of to a screen.
one.send({ type: 'restart-request', to: idOf(two), connectionId: 'voz-0123456789ab' })
await settle()
assert.equal(two.inbox.filter((message) => message.type === 'restart-request').at(-1).connectionId, 'voz-0123456789ab')

// --- leaving --------------------------------------------------------------
one.send({ type: 'voice-leave' })
await settle()
assert.equal(usersSeenBy(two).find((user) => user.name === 'Diego').voice, false)

// Closing the socket has to clear it too, or a crash would leave a ghost everyone keeps calling.
two.send({ type: 'voice-join' })
await settle()
assert.equal(usersSeenBy(one).find((user) => user.name === 'Amigo').voice, true)
two.socket.close()
await settle()
assert.ok(!usersSeenBy(one).some((user) => user.name === 'Amigo'), 'a disconnected peer leaves the list entirely')

one.socket.close()
stop()
console.log('PASS: voice presence travels with the room list, the voice flag survives and is validated on the relay, restart requests keep their id, and both leaving and disconnecting clear it.')
process.exit(0)
