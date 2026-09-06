import assert from 'node:assert/strict'

// The module reaches for window.electronAPI and RTCPeerConnection at call time, so a small stand-in for
// each is enough to drive it -- no browser, no Electron.
const handlers = {}
const calls = []
const api = {
  isNativeCaptureAvailable: async () => true,
  startNativeBroadcast: async (settings) => { calls.push(['start', settings]); return true },
  stopNativeBroadcast: () => calls.push(['stop']),
  addNativeViewer: async (id) => { calls.push(['add', id]); return id !== 'refused' },
  answerNativeViewer: async (id, sdp) => { calls.push(['answer', id, sdp]); return true },
  removeNativeViewer: (id) => calls.push(['remove', id]),
  pickNativeSource: async (audioRequested) => { calls.push(['pick', audioRequested]); return { kind: 'monitor', monitorIndex: 0, audio: audioRequested, name: 'Tela 1' } },
  onNativeOffer: (cb) => { handlers.offer = cb; return () => { handlers.offer = null } },
  onNativeCandidate: (cb) => { handlers.candidate = cb; return () => { handlers.candidate = null } },
  onNativeViewerGone: (cb) => { handlers.gone = cb; return () => { handlers.gone = null } },
  onNativeError: (cb) => { handlers.error = cb; return () => { handlers.error = null } },
}

let lastPeer = null
class FakePeer {
  constructor() {
    this.iceGatheringState = 'complete'
    this.localDescription = { sdp: 'v=0 answer' }
    this.added = []
    this.closed = false
    lastPeer = this
  }
  async setRemoteDescription(d) { this.remote = d }
  async createAnswer() { return { type: 'answer', sdp: 'v=0 answer' } }
  async setLocalDescription(d) { this.local = d }
  async addIceCandidate(c) { this.added.push(c) }
  addEventListener() {}
  removeEventListener() {}
  close() { this.closed = true }
}

globalThis.window = { electronAPI: api }
globalThis.RTCPeerConnection = FakePeer
globalThis.MediaStream = class { constructor(tracks = []) { this.tracks = tracks } }

const { createNativeBroadcast, PREVIEW_ID, isNativeCaptureAvailable, nativeIceServers } = await import('../src/nativeBroadcast.js')

// --- ICE servers for the pipeline ----------------------------------------
// Without these it gathers host candidates only: private addresses that work on loopback and are
// unreachable from anywhere else, so a viewer over the internet waits at "connecting" and never joins.
const cloudflare = [
  { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] },
  { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:3478?transport=tcp'], username: 'a/b+c', credential: 'p@ss=word' },
]
const ice = nativeIceServers(cloudflare)
assert.equal(ice.stunServer, 'stun://stun.cloudflare.com:3478', 'whipsink wants a URL, not the browser form')
// UDP first: TCP and TLS exist for networks that block it and cost latency everywhere else.
assert.ok(ice.turnServer.startsWith('turn://') && ice.turnServer.endsWith('@turn.cloudflare.com:3478'))
// Credentials must be encoded, or a slash or an at-sign ends the authority early and the URL points
// somewhere else entirely -- which fails as a silent connection problem, not as an error.
assert.ok(ice.turnServer.includes(encodeURIComponent('a/b+c')) && ice.turnServer.includes(encodeURIComponent('p@ss=word')))
assert.ok(!ice.turnServer.includes('?transport='), 'the query is not part of the authority')

// TURN without credentials cannot be used and must not be half-passed.
assert.equal(nativeIceServers([{ urls: 'turn:relay:3478' }]).turnServer, null)
assert.deepEqual(nativeIceServers([]), { stunServer: null, turnServer: null })
assert.deepEqual(nativeIceServers(), { stunServer: null, turnServer: null })
assert.equal(nativeIceServers([{ urls: 'stun://already:3478' }]).stunServer, 'stun://already:3478', 'a URL already in form is left alone')
assert.equal(nativeIceServers([{ urls: [null, 42, 'stun:ok:1'] }]).stunServer, 'stun://ok:1', 'junk in the list must not become an argument')

assert.equal(await isNativeCaptureAvailable(), true)

const seen = { offers: [], candidates: [], gone: [], errors: [] }
const native = createNativeBroadcast({
  onOffer: (id, sdp) => seen.offers.push([id, sdp]),
  onCandidate: (id, c) => seen.candidates.push([id, c]),
  onViewerGone: (id) => seen.gone.push(id),
  onError: (id, reason) => seen.errors.push([id, reason]),
})

// The picker's audio answer has to reach the main process, or the checkbox decides nothing and sound is
// shared whatever anyone ticked.
assert.deepEqual(await native.pickSource(true), { kind: 'monitor', monitorIndex: 0, audio: true, name: 'Tela 1' })
assert.deepEqual(calls.at(-1), ['pick', true])
assert.equal((await native.pickSource()).audio, false, 'silence unless asked for')
assert.deepEqual(calls.at(-1), ['pick', false], 'a missing argument must not reach the picker as undefined')

assert.equal(await native.start({ fps: 60 }), true)
assert.deepEqual(calls.at(-1), ['start', { fps: 60 }])

// --- a real viewer's signalling must reach the caller untouched -----------
await handlers.offer('c1', 'v=0 offer')
assert.deepEqual(seen.offers, [['c1', 'v=0 offer']], 'the page must put a viewer offer on the socket itself')
handlers.candidate('c1', { candidate: 'candidate:1 1 UDP' })
assert.equal(seen.candidates.length, 1)
handlers.gone('c1')
assert.deepEqual(seen.gone, ['c1'])

// --- the preview answers itself and never touches the socket --------------
let streamed = null
assert.equal(await native.openPreview((stream) => { streamed = stream }), true)
assert.ok(calls.some(([kind, id]) => kind === 'add' && id === PREVIEW_ID))

await handlers.offer(PREVIEW_ID, 'v=0 preview offer')
assert.deepEqual(seen.offers, [['c1', 'v=0 offer']], 'the preview offer must not be sent to the server')
assert.equal(lastPeer.remote.sdp, 'v=0 preview offer')
assert.ok(calls.some(([kind, id, sdp]) => kind === 'answer' && id === PREVIEW_ID && sdp === 'v=0 answer'),
  'the preview answers the pipeline directly')

handlers.candidate(PREVIEW_ID, { candidate: 'candidate:2 1 UDP' })
assert.equal(lastPeer.added.length, 1, 'preview candidates go into the local peer, not onto the socket')
assert.equal(seen.candidates.length, 1)

lastPeer.ontrack({ streams: [{ id: 'preview' }] })
assert.deepEqual(streamed, { id: 'preview' })

// --- closing the preview releases the extra pipeline ----------------------
const previewPeer = lastPeer
native.closePreview()
assert.equal(previewPeer.closed, true, 'the local peer must be closed')
assert.ok(calls.some(([kind, id]) => kind === 'remove' && id === PREVIEW_ID),
  'the pipeline it costs must be released, not left running for nobody')

// The pipeline dying is not something to report as a viewer leaving the room.
assert.equal(await native.openPreview(() => {}), true)
handlers.gone(PREVIEW_ID)
assert.deepEqual(seen.gone, ['c1'], 'the preview is not a viewer the room should hear about')

// --- refusal must not leave a half-open preview ---------------------------
// GStreamer can be missing, or the pipeline can fail to spawn; either way the caller gets a plain false
// and no peer is left dangling with nothing on the other end of it.
const refused = createNativeBroadcast({})
const allow = api.addNativeViewer
api.addNativeViewer = async () => false
assert.equal(await refused.openPreview(() => {}), false)
assert.equal(lastPeer.closed, true, 'a preview that never started must not leave a peer open')
api.addNativeViewer = allow

// --- stopping and disposing ----------------------------------------------
native.stop()
assert.ok(calls.some(([kind]) => kind === 'stop'))
native.dispose()
assert.equal(handlers.offer, null, 'listeners must be released, or a second broadcast gets two of each')

console.log('PASS: ICE servers translated for the pipeline, audio answered by the picker, viewer signalling forwarded, preview answered locally, preview pipeline released on close, listeners disposed.')
