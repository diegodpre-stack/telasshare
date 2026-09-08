// The room's file list, and who is allowed to take something off it. The list matters because the
// conversation forgets: it keeps a hundred lines, and a file sent before that still sits on the disk
// spending the room's share. The deleting matters because it is destructive and irreversible, so the
// interesting assertions here are the refusals.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { startMongo } from './testMongo.mjs'

const BASE = 'http://127.0.0.1:8803'
const folder = mkdtempSync(join(tmpdir(), 'telasshare-'))
const filesDir = join(folder, 'arquivos')
const mongo = await startMongo()
let server = null

const start = async () => {
  server = spawn(process.execPath, ['server/index.js'], {
    env: {
      ...process.env, PORT: '8803', HOST: '127.0.0.1', SESSION_SECRET: 'teste-do-painel',
      MONGODB_URI: mongo.uri, MONGODB_DB: 'painel', FILES_DIR: filesDir,
    },
    stdio: 'ignore',
  })
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 150))
    try { if ((await fetch(`${BASE}/health`)).ok) return } catch { /* not up yet */ }
  }
  throw new Error('the server never came up')
}
const stopServer = () => new Promise((resolve) => {
  if (!server) return resolve()
  const child = server; server = null
  child.once('exit', resolve); child.kill()
})
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
const login = async (name) => (await request('POST', '/api/login', { name })).body.session
const seatIn = async (roomId, session) => (await request('POST', `/api/rooms/${roomId}/join`, { password: '' }, session)).body.session
const upload = async (seat, name, size = 500) => {
  const bytes = Buffer.alloc(size, 7); bytes.set([0xff, 0xd8, 0xff, 0xe0])
  const response = await fetch(`${BASE}/api/room/files`, {
    method: 'POST',
    headers: { authorization: `Bearer ${seat}`, 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(name) },
    body: bytes,
  })
  return (await response.json()).file
}
const listing = (seat) => request('GET', '/api/room/files', undefined, seat)
const removeFile = (seat, id) => request('POST', `/api/room/files/${id}/delete`, {}, seat)

await start()
const diego = await login('Diego')
const amigo = await login('Amigo')
const estranho = await login('Estranho')
const room = (await request('POST', '/api/rooms', { roomName: 'Sala de arquivos', password: '', permanent: true }, diego)).body.room
const dono = await seatIn(room.id, diego)
const membro = await seatIn(room.id, amigo)

const primeiro = await upload(dono, 'contrato.jpg', 900)
const segundo = await upload(membro, 'foto-do-amigo.jpg', 400)

// --- the list ---------------------------------------------------------------
const asOwner = await listing(dono)
assert.equal(asOwner.status, 200)
assert.equal(asOwner.body.files.length, 2, 'everything the room holds, whoever sent it')
assert.equal(asOwner.body.manages, true, 'the owner runs the room')
assert.ok(asOwner.body.files.every((file) => file.canDelete), 'and may remove any of them')
assert.deepEqual(asOwner.body.files.map((file) => file.name), ['contrato.jpg', 'foto-do-amigo.jpg'], 'oldest first')
assert.equal(asOwner.body.files[1].fromName, 'Amigo', 'and who sent it')
assert.ok(asOwner.body.files[0].url.includes('token='), 'with an address that opens')
assert.equal((await fetch(BASE + asOwner.body.files[0].url)).status, 200)
// Nothing internal rides along: the path on disk and the hash are the server's business.
for (const file of asOwner.body.files) {
  assert.deepEqual(Object.keys(file).sort(), ['at', 'bytes', 'canDelete', 'fromName', 'id', 'inline', 'kind', 'name', 'url'])
}

const asMember = await listing(membro)
assert.equal(asMember.body.files.length, 2, 'everybody in the room sees the list')
assert.equal(asMember.body.manages, false, 'an ordinary member does not run the room')
// But their own file is theirs to take back, and only their own.
assert.deepEqual(asMember.body.files.map((file) => [file.name, file.canDelete]), [['contrato.jpg', false], ['foto-do-amigo.jpg', true]])

// --- the list outlives the conversation -------------------------------------
// This is the whole reason the panel exists. A hundred and five lines pushes the first files out of the
// history, and the list must still have them.
for (let i = 0; i < 105; i += 1) {
  const socket = new WebSocket(`ws://127.0.0.1:8803/?session=${encodeURIComponent(dono)}`)
  await new Promise((resolve) => socket.on('open', resolve))
  socket.send(JSON.stringify({ type: 'hello' }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  socket.send(JSON.stringify({ type: 'chat', text: `linha ${i}` }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  socket.close()
  await new Promise((resolve) => setTimeout(resolve, 5))
}
const afterTalking = await listing(dono)
assert.equal(afterTalking.body.files.length, 2, 'the files are still listed after the history has rolled over')
assert.equal((await fetch(BASE + afterTalking.body.files[0].url)).status, 200, 'and still downloadable')

// --- who may not delete ------------------------------------------------------
assert.equal((await removeFile(membro, primeiro.id)).status, 403, "a member cannot delete somebody else's file")
assert.equal((await removeFile(estranho, primeiro.id)).status, 401, 'a site session is not a room seat')
assert.equal((await request('POST', `/api/room/files/${primeiro.id}/delete`, {})).status, 401, 'and nothing at all is refused')
assert.equal((await listing(estranho)).status, 401, 'the list is not readable from outside the room either')
// A file belonging to another room is not deletable by the people who run this one.
const outra = (await request('POST', '/api/rooms', { roomName: 'Outra sala', password: '', permanent: true }, amigo)).body.room
const outroDono = await seatIn(outra.id, amigo)
const alheio = await upload(outroDono, 'de-outra-sala.jpg')
assert.equal((await removeFile(dono, alheio.id)).status, 404, 'an id from another room is not found here')
// Absent rather than forbidden, so the answer does not confirm that the file exists somewhere.
assert.equal((await removeFile(membro, alheio.id)).status, 404, 'even for the person who sent it, from the wrong room')
assert.equal((await listing(outroDono)).body.files.length, 1, 'and that room still has it')

// --- the sender may take their own back --------------------------------------
// Before any promotion: an ordinary member, deleting the file they sent and nothing else.
const proprio = await upload(membro, 'meu-arquivo.jpg', 300)
assert.equal((await removeFile(membro, proprio.id)).status, 200, 'their own file is theirs to remove')
assert.ok(!existsSync(join(filesDir, room.id, proprio.id)), 'and the bytes go with it')
// The same person arriving from another machine is a different session and the same person by name.
const outroPc = await seatIn(room.id, await login('Amigo'))
const doOutroPc = await upload(membro, 'de-outro-pc.jpg', 300)
assert.equal((await listing(outroPc)).body.files.find((file) => file.id === doOutroPc.id).canDelete, true, 'recognised by name, as ownership is')
assert.equal((await removeFile(outroPc, doOutroPc.id)).status, 200)

// --- a co-owner may ----------------------------------------------------------
const promoter = new WebSocket(`ws://127.0.0.1:8803/?session=${encodeURIComponent(dono)}`)
await new Promise((resolve) => promoter.on('open', resolve))
promoter.send(JSON.stringify({ type: 'hello' }))
const memberSocket = new WebSocket(`ws://127.0.0.1:8803/?session=${encodeURIComponent(membro)}`)
const seen = []
memberSocket.on('message', (raw) => { try { seen.push(JSON.parse(raw)) } catch { /* not ours */ } })
await new Promise((resolve) => memberSocket.on('open', resolve))
memberSocket.send(JSON.stringify({ type: 'hello' }))
await new Promise((resolve) => setTimeout(resolve, 300))
const amigoId = seen.find((entry) => entry.type === 'welcome')?.id
promoter.send(JSON.stringify({ type: 'promote', to: amigoId }))
await new Promise((resolve) => setTimeout(resolve, 400))
assert.equal((await listing(membro)).body.manages, true, 'a co-owner runs the room')
assert.ok((await listing(membro)).body.files.every((file) => file.canDelete), 'and may remove anything')

// --- and deleting takes the bytes with it ------------------------------------
const onDisk = join(filesDir, room.id, segundo.id)
assert.ok(existsSync(onDisk), 'the file is on the disk to begin with')
const removed = await removeFile(membro, segundo.id)
assert.equal(removed.status, 200)
assert.ok(!existsSync(onDisk), 'and the bytes go, not just the row')
assert.equal((await fetch(BASE + asOwner.body.files[1].url)).status, 404, 'an address minted earlier stops working')
assert.equal((await listing(dono)).body.files.length, 1, 'and it is off the list')
// Everyone in the room is told, so nobody is left looking at a line pointing at nothing.
await new Promise((resolve) => setTimeout(resolve, 300))
assert.ok(seen.some((entry) => entry.type === 'file-removed' && entry.id === segundo.id), 'the room is told')
assert.equal((await removeFile(membro, segundo.id)).status, 404, 'deleting it twice is not an error the second time either')

// --- and it stays deleted across a restart -----------------------------------
promoter.close(); memberSocket.close()
await new Promise((resolve) => setTimeout(resolve, 200))
await stopServer()
await start()
const afterRestart = await listing(await seatIn(room.id, diego))
assert.equal(afterRestart.body.files.length, 1, 'the deletion survived')
assert.equal(afterRestart.body.files[0].name, 'contrato.jpg')

cleanUp()
console.log('PASS: the room lists every file it holds, oldest first and with who sent it, and keeps listing them after the conversation has rolled past a hundred lines; whoever sent a file may take it back and is recognised by name from another machine, a member cannot touch what somebody else sent, an outsider cannot even read the list, and an id from another room reads as absent rather than forbidden; the owner and co-owners may remove anything, and deleting removes the row, the bytes on disk and the message, tells everybody in the room, invalidates addresses already handed out, and stays deleted across a restart.')
