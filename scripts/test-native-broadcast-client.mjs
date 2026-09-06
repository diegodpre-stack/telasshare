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

const { createNativeBroadcast, PREVIEW_ID, isNativeCaptureAvailable } = await import('../src/nativeBroadcast.js')

assert.equal(await isNativeCaptureAvailable(), true)

const seen = { offers: [], candidates: [], gone: [], errors: [] }
const native = createNativeBroadcast({
  onOffer: (id, sdp) => seen.offers.push([id, sdp]),
  onCandidate: (id, c) => seen.candidates.push([id, c]),
  onViewerGone: (id) => seen.gone.push(id),
  onError: (id, reason) => seen.errors.push([id, reason]),
})

assert.equal(await native.start({ fps: 60 }), true)
assert.deepEqual(calls[0], ['start', { fps: 60 }])

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

console.log('PASS: viewer signalling forwarded, preview answered locally, preview pipeline released on close, listeners disposed.')
