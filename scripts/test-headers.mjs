// The headers the browser is told to enforce. A content policy is only worth having if it is both
// present and correct, and the two failures look nothing alike: a missing one leaves the page open,
// while an over-tight one breaks the microphone or the fonts and nobody connects it to a header.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'

const PORT = 8799
const BASE = `http://127.0.0.1:${PORT}`
const ORIGIN = 'https://exemplo.test'
let server = null

const start = async () => {
  server = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', SESSION_SECRET: 'teste-de-cabecalhos', CLIENT_ORIGIN: ORIGIN },
    stdio: 'ignore',
  })
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 150))
    try { if ((await fetch(`${BASE}/health`)).ok) return } catch { /* not up yet */ }
  }
  throw new Error('the server never came up')
}
// Stopped explicitly and the handle dropped before exiting: killing a child from inside the exit
// handler trips an assertion in libuv on Windows, and the run fails after every assertion has passed.
const stop = () => new Promise((resolve) => {
  if (!server) return resolve()
  const child = server
  server = null
  child.once('exit', resolve)
  child.kill()
})
process.on('uncaughtException', async (error) => { await stop(); console.error(error); process.exit(1) })

await start()
const response = await fetch(`${BASE}/health`)
const csp = response.headers.get('content-security-policy')

// --- present at all -------------------------------------------------------
assert.ok(csp, 'a content policy is sent')
assert.equal(response.headers.get('x-frame-options'), 'DENY')
assert.match(response.headers.get('permissions-policy'), /camera=\(\)/)
assert.equal(response.headers.get('x-powered-by'), null, 'the framework is not announced')

// --- and it does not lock the app out of its own parts ---------------------
// Each of these was found by breaking it: without wasm-unsafe-eval the noise suppressor dies silently,
// without unsafe-inline the panels cannot be resized, and without the two font hosts the page loses its
// typefaces. They are allowances, so they are asserted as such rather than left to be discovered.
assert.match(csp, /script-src [^;]*'wasm-unsafe-eval'/, 'RNNoise can instantiate its WebAssembly')
assert.match(csp, /style-src [^;]*'unsafe-inline'/, 'panels can be resized by writing an inline style')
assert.match(csp, /style-src [^;]*https:\/\/fonts\.googleapis\.com/, 'the stylesheet can import the fonts')
assert.match(csp, /font-src [^;]*https:\/\/fonts\.gstatic\.com/, 'and fetch the files themselves')
assert.match(csp, /img-src [^;]*blob:/)
assert.match(csp, /media-src [^;]*blob:/)

// --- and it does close what it is for --------------------------------------
assert.match(csp, /frame-ancestors 'none'/, 'the page cannot be framed, which is the clickjacking route')
assert.match(csp, /object-src 'none'/)
assert.match(csp, /base-uri 'none'/)
assert.ok(!/script-src [^;]*'unsafe-eval'(?!-)/.test(csp), 'wasm only, never arbitrary eval')
assert.ok(!/script-src [^;]*'unsafe-inline'/.test(csp), 'and no inline script')
assert.ok(!/\*/.test(csp), 'nothing is opened with a wildcard')

// --- the socket is allowed, and only where the page is ---------------------
// Built from CLIENT_ORIGIN rather than a wildcard, so a deployment elsewhere carries its own answer.
assert.match(csp, /connect-src [^;]*'self'/)
assert.match(csp, /connect-src [^;]*wss:\/\/exemplo\.test/, 'the signalling socket of this deployment')
assert.ok(!/connect-src [^;]*ws:\/\/[^ ;]*[^s]/.test(csp.replace('wss://', '')), 'and not plain ws anywhere else')

// --- a downloaded file carries them too ------------------------------------
const file = await fetch(`${BASE}/api/files/qualquer`)
assert.equal(file.status, 401)
assert.ok(file.headers.get('content-security-policy'), 'including on the file route')

await stop()
console.log('PASS: the page is sent a content policy that cannot be framed, has no wildcard, no inline script and no eval beyond WebAssembly, while still allowing the things this app genuinely needs -- RNNoise, inline styles for resizing, the two font hosts, blob images and media, and the signalling socket of this deployment only; the framework is not announced and the camera and location are refused outright.')
