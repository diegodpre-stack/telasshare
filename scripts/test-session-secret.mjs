// The key that signs every session. There is nothing else standing between a name and somebody else's
// rooms, so the only thing worth asserting here is that it is never a value anybody else could know.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

const PORT = 8798
const BASE = `http://127.0.0.1:${PORT}`
let server = null

const start = (env) => new Promise((resolve, reject) => {
  server = spawn(process.execPath, ['server/index.js'], {
    // A clean environment, minus anything the developer happens to have set. dotenv still reads .env,
    // which is why SESSION_SECRET is blanked explicitly rather than merely left out.
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', SESSION_SECRET: '', ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let warning = ''
  server.stderr.on('data', (chunk) => { warning += chunk })
  const deadline = Date.now() + 15_000
  const poll = async () => {
    if (Date.now() > deadline) return reject(new Error('the server never came up'))
    try { if ((await fetch(`${BASE}/health`)).ok) return resolve(() => warning) } catch { /* not up yet */ }
    setTimeout(poll, 150)
  }
  poll()
})
const stop = () => new Promise((resolve) => {
  if (!server) return resolve()
  server.once('exit', resolve); server.kill(); server = null
})
process.on('exit', () => { try { server?.kill() } catch { /* gone */ } })

const login = async (name) => (await (await fetch(`${BASE}/api/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }),
})).json()).session
const roomsWith = (session) => fetch(`${BASE}/api/rooms`, { headers: { authorization: `Bearer ${session}` } })

// --- no constant, anywhere ------------------------------------------------
// This one is worth stating in the crudest possible way. The old fallback was a fixed string used
// whenever RENDER was unset, which is every machine that is not Render -- so it was published in the
// repository and would have signed real sessions on the new server had the variable ever been missed.
const source = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8')
assert.ok(!/session-secret'/.test(source), 'no literal stands in for the signing key')
assert.ok(!/process\.env\.RENDER/.test(source.split('const sessionSecret')[1]?.slice(0, 600) ?? ''),
  'and which host it runs on does not decide whether it is safe')

// --- missing means random, not shared -------------------------------------
const readWarning = await start({})
assert.match(readWarning(), /SESSION_SECRET/, 'and it says so rather than pretending all is well')
const before = await login('Diego')
assert.equal((await roomsWith(before)).status, 200, 'the session works while the server lives')
await stop()

await start({})
assert.equal((await roomsWith(before)).status, 401,
  'a session from the previous run is refused: the two runs did not share a key')
await stop()

// --- given one, it is used ------------------------------------------------
await start({ SESSION_SECRET: 'um-segredo-de-teste-bem-comprido-para-nao-parecer-real' })
const stable = await login('Diego')
await stop()
await start({ SESSION_SECRET: 'um-segredo-de-teste-bem-comprido-para-nao-parecer-real' })
assert.equal((await roomsWith(stable)).status, 200, 'the same key across a restart keeps people signed in')
await stop()
await start({ SESSION_SECRET: 'outro-segredo-completamente-diferente-do-anterior' })
assert.equal((await roomsWith(stable)).status, 401, 'a different key does not')
await stop()

console.log('PASS: no constant stands in for the signing key and the host it runs on does not decide that; with none set the server warns and signs with a secret of that run alone, so sessions do not survive a restart and nothing is guessable; with one set, sessions survive a restart and only under that same key.')
process.exit(0)
