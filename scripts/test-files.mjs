// Uploading and downloading, against the real server. The dangerous parts of a file feature are not
// "does it store the bytes" -- they are who may fetch them, what the browser is told a file is, and
// what happens to the disk when a room goes. Those are what this leans on.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMongo } from './testMongo.mjs'

const BASE = 'http://127.0.0.1:8796'
const folder = mkdtempSync(join(tmpdir(), 'telasshare-'))
const filesDir = join(folder, 'arquivos')
const mongo = await startMongo()
const MAX_FILE = 200_000
const MAX_ROOM = 500_000
let server = null

const start = async () => {
  server = spawn(process.execPath, ['server/index.js'], {
    env: {
      ...process.env, PORT: '8796', HOST: '127.0.0.1', SESSION_SECRET: 'teste-de-arquivos',
      MONGODB_URI: mongo.uri, MONGODB_DB: 'arquivos', FILES_DIR: filesDir,
      MAX_FILE_BYTES: String(MAX_FILE), MAX_ROOM_BYTES: String(MAX_ROOM),
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
  server.once('exit', resolve); server.kill(); server = null
})
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
const upload = async (seat, bytes, name) => {
  const response = await fetch(`${BASE}/api/room/files`, {
    method: 'POST',
    headers: { authorization: `Bearer ${seat}`, 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(name) },
    body: bytes,
  })
  return { status: response.status, body: await response.json().catch(() => null) }
}
const jpeg = (size) => { const buffer = Buffer.alloc(size, 7); buffer.set([0xff, 0xd8, 0xff, 0xe0]); return buffer }

await start()
const diego = await login('Diego')
const amigo = await login('Amigo')
const room = (await request('POST', '/api/rooms', { roomName: 'Sala com arquivos', password: '', permanent: true }, diego)).body.room
const seat = (await request('POST', `/api/rooms/${room.id}/join`, { password: '' }, diego)).body.session

// --- a file goes up and comes back ----------------------------------------
const sent = await upload(seat, jpeg(5_000), 'férias.jpg')
assert.equal(sent.status, 201)
assert.equal(sent.body.file.kind, 'image/jpeg', 'the type is read from the bytes')
assert.equal(sent.body.file.inline, true)
assert.equal(sent.body.file.name, 'férias.jpg', 'and the name is kept for showing')

const fetched = await fetch(BASE + sent.body.file.url)
assert.equal(fetched.status, 200)
assert.equal(fetched.headers.get('content-type'), 'image/jpeg')
assert.equal(fetched.headers.get('x-content-type-options'), 'nosniff')
assert.ok(fetched.headers.get('content-disposition').startsWith('inline'))
assert.equal((await fetched.arrayBuffer()).byteLength, 5_000, 'and the bytes are the bytes')

// --- who may fetch it -----------------------------------------------------
// The address carries the permission, so an address without one is refused.
assert.equal((await fetch(`${BASE}/api/files/${sent.body.file.id}`)).status, 401)
assert.equal((await fetch(`${BASE}/api/files/${sent.body.file.id}?token=inventado`)).status, 401)
// A token minted for one file must not open another.
const second = await upload(seat, jpeg(1_000), 'outra.jpg')
const stolen = new URL(BASE + second.body.file.url).searchParams.get('token')
assert.equal((await fetch(`${BASE}/api/files/${sent.body.file.id}?token=${encodeURIComponent(stolen)}`)).status, 401)

// Somebody who is not in the room cannot upload to it, whatever they hold.
assert.equal((await upload(await login('Estranho'), jpeg(100), 'x.jpg')).status, 401)
assert.equal((await upload(amigo, jpeg(100), 'x.jpg')).status, 401, 'a site session is not a room session')

// --- what the browser is told a file is -----------------------------------
// This is the one that matters. An SVG is an image by every ordinary definition and it can carry
// script, so serving one as itself from this origin would run that script with the app's storage.
const svg = await upload(seat, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'), 'imagem.svg')
assert.equal(svg.body.file.kind, 'application/octet-stream', 'not treated as an image')
assert.equal(svg.body.file.inline, false)
const svgResponse = await fetch(BASE + svg.body.file.url)
assert.equal(svgResponse.headers.get('content-type'), 'application/octet-stream')
assert.ok(svgResponse.headers.get('content-disposition').startsWith('attachment'), 'it downloads, it does not render')

// The same for anything claiming to be one thing and being another.
const liar = await upload(seat, Buffer.from('<!DOCTYPE html><script>alert(1)</script>'), 'foto.jpg')
assert.equal(liar.body.file.kind, 'application/octet-stream', 'the name said jpg and the bytes did not')
assert.ok((await fetch(BASE + liar.body.file.url)).headers.get('content-disposition').startsWith('attachment'))

// A name cannot smuggle a second header or a path.
const nasty = await upload(seat, jpeg(100), `foto${String.fromCharCode(13, 10)}X-Injected: yes.jpg`)
assert.ok(!nasty.body.file.name.includes(String.fromCharCode(10)), 'no newline survives into a header')
const traversal = await upload(seat, jpeg(100), '../../../etc/passwd')
assert.ok(!traversal.body.file.name.includes('/'), 'and no separator survives either')

// --- the limits -----------------------------------------------------------
assert.equal((await upload(seat, jpeg(MAX_FILE + 1), 'grande.jpg')).status, 413, 'one file cannot be unbounded')
// Nothing is left behind by a refusal: a rejected upload must not still cost the disk.
const roomFolder = join(filesDir, room.id)
const beforeQuota = readdirSync(roomFolder).length
assert.ok(!readdirSync(roomFolder).some((entry) => entry.endsWith('.part')), 'no half-written file remains')

// The room's share runs out, and the message says which limit was hit.
let filled = null
for (let i = 0; i < 20 && !filled; i += 1) {
  const attempt = await upload(seat, jpeg(120_000), `enche-${i}.jpg`)
  if (attempt.status !== 201) filled = attempt
}
assert.equal(filled.status, 507, 'the room runs out of space rather than the disk')
assert.ok(readdirSync(roomFolder).length > beforeQuota, 'the ones that fitted are there')

// --- what happens when the room goes --------------------------------------
assert.ok(existsSync(roomFolder))
assert.equal((await request('POST', `/api/rooms/${room.id}/delete`, {}, diego)).status, 200)
await new Promise((resolve) => setTimeout(resolve, 600))
assert.ok(!existsSync(roomFolder), 'the files go with the room, off the disk and not only out of the database')
assert.equal((await fetch(BASE + sent.body.file.url)).status, 404, 'and the links stop working')

// --- and it all survives a restart ----------------------------------------
const kept = (await request('POST', '/api/rooms', { roomName: 'Outra sala', password: '', permanent: true }, diego)).body.room
const keptSeat = (await request('POST', `/api/rooms/${kept.id}/join`, { password: '' }, diego)).body.session
const before = await upload(keptSeat, jpeg(3_000), 'antes.jpg')
await stopServer()
await start()
const seatAgain = (await request('POST', `/api/rooms/${kept.id}/join`, { password: '' }, diego)).body.session
assert.ok(seatAgain)
const afterRestart = await fetch(BASE + before.body.file.url)
assert.equal(afterRestart.status, 200, 'the file is still there')
assert.equal((await afterRestart.arrayBuffer()).byteLength, 3_000)

await stopServer()
await mongo.stop()
cleanUp()
console.log('PASS: a file goes up and comes back with its bytes intact; the type is read from the bytes so an SVG and a disguised HTML both download instead of rendering; a name cannot smuggle a header or a path; a link without a token, with a forged one, or minted for another file is refused; outsiders cannot upload; the per-file and per-room limits hold and leave nothing half-written; deleting a room clears the disk as well as the database; and everything survives a restart.')
process.exit(0)
