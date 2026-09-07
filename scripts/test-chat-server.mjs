// Drives the real server: chat only matters as something two people actually receive, and the rate
// limit only matters as something a real connection actually runs into.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { WebSocket } from 'ws'

const BASE = 'http://127.0.0.1:8791'
const server = spawn(process.execPath, ['server/index.js'], {
  env: { ...process.env, PORT: '8791', HOST: '127.0.0.1', SESSION_SECRET: 'teste-de-chat' },
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

// One login each. The server allows a person only one live connection and replaces the old one, so
// sharing a session between two sockets in a test would knock out the socket under test.
const diego = (await post('/api/login', { name: 'Diego' })).session
const amigo = (await post('/api/login', { name: 'Amigo' })).session
const carla = (await post('/api/login', { name: 'Carla' })).session
const bruno = (await post('/api/login', { name: 'Bruno' })).session
const { room } = await post('/api/rooms', { roomName: 'Sala de conversa', password: '' }, diego)
const seat = async (site) => (await post(`/api/rooms/${room.id}/join`, { password: '' }, site)).session

const open = (session, name) => new Promise((resolve, reject) => {
  const socket = new WebSocket(`ws://127.0.0.1:8791?session=${encodeURIComponent(session)}`)
  const inbox = []
  let closed = null
  socket.on('error', reject)
  socket.on('close', (code) => { closed = code })
  socket.on('message', (raw) => inbox.push(JSON.parse(raw.toString())))
  socket.on('open', () => {
    socket.send(JSON.stringify({ type: 'hello', name }))
    setTimeout(() => resolve({ socket, inbox, get closed() { return closed }, send: (message) => socket.send(JSON.stringify(message)) }), 200)
  })
})
const chatsIn = (client) => client.inbox.filter((message) => message.type === 'chat').map((message) => message.message)

const one = await open(await seat(diego), 'Diego')
const two = await open(await seat(amigo), 'Amigo')
await settle()

// --- a message reaches the room -------------------------------------------
one.send({ type: 'chat', text: 'boa noite' })
await settle()
const received = chatsIn(two).at(-1)
assert.equal(received.text, 'boa noite')
assert.equal(received.fromName, 'Diego')
assert.ok(received.id && received.at, 'each message is identifiable and timed')
// The sender sees it too, so nobody has to guess whether it went out.
assert.equal(chatsIn(one).at(-1).text, 'boa noite')

// The name is taken from the connection, never from the message: a sender who could choose the name
// shown against their words could put them in somebody else's mouth.
one.send({ type: 'chat', text: 'nao fui eu', fromName: 'Amigo', from: 'outro' })
await settle()
assert.equal(chatsIn(two).at(-1).fromName, 'Diego', 'the name cannot be spoofed')
assert.equal(chatsIn(two).at(-1).from, one.inbox.find((message) => message.type === 'welcome').id)

// --- what the server refuses to carry -------------------------------------
const before = chatsIn(two).length
for (const empty of ['', '   ', '\n\n\n', null, 42, { text: 'x' }, ['x']]) {
  one.send({ type: 'chat', text: empty })
}
await settle()
assert.equal(chatsIn(two).length, before, 'nothing empty or malformed is relayed')

// Long messages are cut rather than refused: losing the first 500 characters of a paste is better than
// losing all of it, and the cap is what stops one message filling everyone's screen.
one.send({ type: 'chat', text: 'a'.repeat(4000) })
await settle()
assert.equal(chatsIn(two).at(-1).text.length, 500)

// Markup is carried verbatim and stays inert: the client renders text, never HTML. Stripping tags on
// the server would quietly mangle anybody discussing code.
one.send({ type: 'chat', text: '<img src=x onerror=alert(1)>' })
await settle()
assert.equal(chatsIn(two).at(-1).text, '<img src=x onerror=alert(1)>')

// --- history for whoever joins late ---------------------------------------
const late = await open(await seat(carla), 'Carla')
await settle()
const history = late.inbox.find((message) => message.type === 'chat-history')
assert.ok(history, 'the conversation so far arrives on joining')
assert.equal(history.messages.at(-1).text, '<img src=x onerror=alert(1)>')
assert.equal(history.messages.at(0).text, 'boa noite')
late.socket.close()

// --- the flood ------------------------------------------------------------
// Measured against this server before the limit existed: 50,871 messages accepted in one second.
const flooder = await open(await seat(bruno), 'Bruno')
await settle()
let sent = 0
const until = Date.now() + 1000
while (Date.now() < until && flooder.socket.readyState === WebSocket.OPEN) {
  flooder.send({ type: 'heartbeat' })
  sent += 1
}
await settle(500)
assert.equal(flooder.closed, 1008, `a flooding connection is closed (sent ${sent})`)

// And the room carries on: a flood costs the flooder their connection and nobody else anything.
assert.equal(two.closed, null)
one.send({ type: 'chat', text: 'ainda aqui' })
await settle()
assert.equal(chatsIn(two).at(-1).text, 'ainda aqui')

// --- typing quickly is not flooding ---------------------------------------
// Somebody sending a few messages in a row gets told to slow down, and keeps their connection.
const talker = await open(await seat(carla), 'Carla')
await settle()
for (let i = 0; i < 12; i += 1) talker.send({ type: 'chat', text: `mensagem ${i}` })
await settle(600)
assert.equal(talker.closed, null, 'a fast typist is not disconnected')
assert.ok(talker.inbox.some((message) => message.type === 'error'), 'they are told to slow down')
const delivered = chatsIn(talker).filter((message) => message.fromName === 'Carla').length
assert.ok(delivered > 0 && delivered < 12, `some got through and some did not (${delivered})`)

talker.socket.close(); two.socket.close(); one.socket.close()
stop()
console.log('PASS: messages reach the room with a name that cannot be spoofed, empty and malformed ones are dropped, long ones are cut, markup is carried inert, latecomers get the history, a flooding connection is closed without disturbing the room, and a fast typist is slowed rather than disconnected.')
process.exit(0)
