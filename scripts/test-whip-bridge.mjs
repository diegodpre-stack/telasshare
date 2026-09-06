import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const { createWhipBridge, parseTrickle } = createRequire(import.meta.url)('../desktop/whipBridge.cjs')

const OFFER = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\nm=video 9 UDP/TLS/RTP/SAVPF 97\r\na=mid:video0\r\n'
const ANSWER = 'v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\nm=video 9 UDP/TLS/RTP/SAVPF 97\r\n'
const call = (port, method, path, body) =>
  fetch(`http://127.0.0.1:${port}${path}`, { method, body }).then(async (r) => ({ status: r.status, body: await r.text(), location: r.headers.get('location') }))

// --- trickle parsing ------------------------------------------------------
const parsed = parseTrickle('m=video 9 UDP/TLS/RTP/SAVPF 97\r\na=mid:video0\r\na=candidate:1 1 UDP 2013 10.0.0.1 5 typ host\r\n')
assert.equal(parsed.length, 1)
assert.equal(parsed[0].sdpMid, 'video0')
assert.equal(parsed[0].sdpMLineIndex, 0)
assert.ok(parsed[0].candidate.startsWith('candidate:'), 'the a= prefix belongs to SDP, not to the candidate')
// A fragment for the second m-section must not be applied to the first.
assert.equal(parseTrickle('m=audio 9 x\r\nm=video 9 x\r\na=candidate:2 1 UDP 1 10.0.0.2 6 typ host\r\n')[0].sdpMLineIndex, 1)
assert.deepEqual(parseTrickle('a=mid:video0\r\n'), [], 'a fragment carrying no candidate yields none')

// --- the bridge -----------------------------------------------------------
const offers = [], candidates = [], closed = []
const bridge = createWhipBridge({
  onOffer: (id, sdp) => offers.push({ id, sdp }),
  onCandidate: (id, candidate) => candidates.push({ id, candidate }),
  onClosed: (id) => closed.push(id),
  // Stands in for the constrained-baseline rewrite, to prove the hook is applied before the app sees it.
  transform: (sdp) => sdp.replace('SAVPF 97', 'SAVPF 96'),
  timeoutMs: 400,
})

assert.throws(() => bridge.createSession(), /not listening/, 'an endpoint URL needs a port to name')
const port = await bridge.listen()
assert.ok(port > 0)

const a = bridge.createSession()
const b = bridge.createSession()
assert.notEqual(a.id, b.id, 'each viewer gets its own session')
assert.ok(a.endpoint.includes(`127.0.0.1:${port}`) && a.endpoint.endsWith(a.id))
assert.ok(bridge.hasSession(a.id) && bridge.hasSession(b.id))

// An unknown session must be refused rather than silently accepted.
assert.equal((await call(port, 'POST', '/whip/not-a-session', OFFER)).status, 404)
assert.equal((await call(port, 'GET', `/whip/${a.id}`)).status, 405)

// The POST stays open until the viewer answers, which is what lets the offer travel over signalling.
const posting = call(port, 'POST', `/whip/${a.id}`, OFFER)
await new Promise((r) => setTimeout(r, 60))
assert.equal(offers.length, 1)
assert.equal(offers[0].id, a.id)
assert.ok(offers[0].sdp.includes('SAVPF 96'), 'transform must run before the app is handed the offer')
assert.equal(bridge.provideAnswer(a.id, 'not an sdp'), false, 'garbage must not be forwarded as an answer')
assert.equal(bridge.provideAnswer('unknown', ANSWER), false)
assert.equal(bridge.provideAnswer(a.id, ANSWER), true)

const posted = await posting
assert.equal(posted.status, 201)
assert.equal(posted.body, ANSWER)
// Absolute, or the sender has nowhere to PATCH candidates to and no way to DELETE the session.
assert.equal(posted.location, `http://127.0.0.1:${port}/whip/${a.id}`)
assert.equal(bridge.provideAnswer(a.id, ANSWER), false, 'a late duplicate answer is refused, not queued')

// Trickle from the pipeline reaches the app tagged with the session it belongs to.
assert.equal((await call(port, 'PATCH', `/whip/${a.id}`, 'm=video 9 x\r\na=mid:video0\r\na=candidate:1 1 UDP 2013 10.0.0.1 5 typ host\r\n')).status, 204)
assert.equal(candidates.length, 1)
assert.equal(candidates[0].id, a.id)

// A viewer who never answers must release the pipeline instead of holding it for the whole broadcast.
const abandoned = await call(port, 'POST', `/whip/${b.id}`, OFFER)
assert.equal(abandoned.status, 504)
assert.equal(offers.length, 2)

// The sender ending its session is the app's cue to drop the viewer.
assert.equal((await call(port, 'DELETE', `/whip/${a.id}`)).status, 204)
assert.deepEqual(closed, [a.id])
assert.equal(bridge.hasSession(a.id), false)
// Closing from the app's side is not a pipeline event and must not be reported back as one.
bridge.closeSession(b.id)
assert.deepEqual(closed, [a.id], 'a locally closed session must not look like the pipeline hung up')

const c = bridge.createSession()
assert.equal((await call(port, 'POST', `/whip/${c.id}`, 'this is not an sdp')).status, 400)

await bridge.close()
await assert.rejects(call(port, 'POST', `/whip/${a.id}`, OFFER), 'the bridge must not outlive close()')

console.log('PASS: per-viewer sessions, offer held for the answer, absolute Location, trickle routing, abandoned-viewer timeout and clean shutdown.')
