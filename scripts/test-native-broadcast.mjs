import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
const { createNativeBroadcast } = createRequire(import.meta.url)('../desktop/nativeBroadcast.cjs')

// A stand-in bridge: same surface, no sockets, so session routing can be driven step by step.
function fakeBridge() {
  const state = { sessions: new Map(), closed: [], handlers: null, transform: null, next: 0 }
  state.factory = (handlers) => {
    state.handlers = handlers
    state.transform = handlers.transform
    return {
      listen: async () => 1234,
      createSession: () => { const id = `s${++state.next}`; state.sessions.set(id, true); return { id, endpoint: `http://127.0.0.1:1234/whip/${id}` } },
      provideAnswer: (id, sdp) => state.sessions.has(id) && typeof sdp === 'string',
      closeSession: (id) => { state.sessions.delete(id); state.closed.push(id) },
      close: async () => { state.sessions.clear() },
    }
  }
  return state
}

const setup = (overrides = {}) => {
  const bridge = fakeBridge()
  const events = { offers: [], candidates: [], gone: [], errors: [] }
  const spawned = []
  const broadcast = createNativeBroadcast({
    onOffer: (id, sdp) => events.offers.push({ id, sdp }),
    onCandidate: (id, c) => events.candidates.push({ id, c }),
    onViewerGone: (id) => events.gone.push(id),
    onError: (id, reason) => events.errors.push({ id, reason }),
    bridgeFactory: bridge.factory,
    startPipeline: overrides.startPipeline || ((options) => {
      const child = new EventEmitter()
      child.kill = () => { child.killed = true; child.emit('exit', 0) }
      spawned.push({ options, child })
      return child
    }),
  })
  return { bridge, events, spawned, broadcast }
}

// --- lifecycle ------------------------------------------------------------
const { bridge, events, spawned, broadcast } = setup()
assert.equal(broadcast.active, false)
assert.equal(broadcast.addViewer('c1'), false, 'no viewer can be added before the broadcast starts')

await broadcast.start({ monitorIndex: 1, fps: 60, bitrateKbps: 12000 })
assert.equal(broadcast.active, true)
// The codec rewrite has to reach the bridge, or Chrome rejects every offer with an m-line of port 0.
assert.ok(bridge.transform, 'the bridge must be given the SDP transform')
assert.ok(bridge.transform('profile-level-id=420432').includes('42e01f'))

// --- one session and one pipeline per viewer ------------------------------
assert.equal(broadcast.addViewer('c1'), true)
assert.equal(broadcast.addViewer('c1'), false, 'the same viewer must not be started twice')
assert.equal(broadcast.addViewer('c2'), true)
assert.equal(broadcast.viewerCount, 2)
assert.equal(spawned.length, 2)
// Each pipeline must post to its own endpoint, or two viewers would answer into one session.
assert.notEqual(spawned[0].options.endpoint, spawned[1].options.endpoint)
assert.equal(spawned[0].options.monitorIndex, 1, 'capture settings must reach the pipeline')
assert.equal(spawned[0].options.fps, 60)

// --- routing between session ids and connection ids -----------------------
bridge.handlers.onOffer('s1', 'v=0 offer')
assert.deepEqual(events.offers, [{ id: 'c1', sdp: 'v=0 offer' }], 'the offer must arrive tagged with the app connection')
bridge.handlers.onCandidate('s2', { candidate: 'candidate:1 1 UDP' })
assert.equal(events.candidates[0].id, 'c2')
// A session the app no longer knows about must not produce phantom messages.
bridge.handlers.onOffer('s99', 'v=0 stray')
assert.equal(events.offers.length, 1)

assert.equal(broadcast.answer('c1', 'v=0 answer'), true)
assert.equal(broadcast.answer('unknown', 'v=0 answer'), false)

// --- a pipeline dying takes its viewer, and only its viewer ---------------
spawned[0].child.emit('exit', 1)
assert.deepEqual(events.gone, ['c1'])
assert.equal(broadcast.viewerCount, 1, 'the other viewer must survive')
assert.ok(bridge.closed.includes('s1'), 'its session must be released too')
assert.equal(broadcast.answer('c1', 'v=0 answer'), false)

// The sender hanging up is reported; the app dropping a viewer itself is not an event to report back.
assert.equal(broadcast.addViewer('c3'), true)
const c3 = spawned[2]
bridge.handlers.onClosed(c3 && 's3')
assert.deepEqual(events.gone, ['c1', 'c3'])
assert.equal(broadcast.addViewer('c4'), true)
broadcast.removeViewer('c4')
assert.deepEqual(events.gone, ['c1', 'c3'], 'a locally removed viewer must not look like the pipeline hung up')

// --- stopping releases every pipeline -------------------------------------
await broadcast.stop()
assert.equal(broadcast.active, false)
assert.equal(broadcast.viewerCount, 0)
assert.ok(spawned.every((s) => s.child.killed || s.child.listenerCount('exit') === 0),
  'no pipeline may outlive the broadcast, holding the capture and the encoder')

// --- missing GStreamer falls back instead of failing ----------------------
const missing = setup({ startPipeline: () => null })
await missing.broadcast.start({})
assert.equal(missing.broadcast.addViewer('c1'), false)
assert.deepEqual(missing.events.errors, [{ id: 'c1', reason: 'gstreamer-missing' }],
  'the caller needs to know why, so it can use the Chromium path instead')
assert.equal(missing.broadcast.viewerCount, 0, 'a viewer with no pipeline must not be tracked')
assert.ok(missing.bridge.closed.length === 1, 'and its session must not be left dangling')

// --- a source that never produces a frame ---------------------------------
// whipsink only offers once a frame reaches it, so a minimised window, an occluded one or a game in
// exclusive fullscreen leaves the pipeline in PLAYING forever with nothing said. Hanging in silence is
// the worst outcome available, so it has to become an error someone can read.
const silent = setup()
await silent.broadcast.start({})
silent.broadcast.addViewer('quiet')
assert.equal(silent.events.errors.length, 0, 'the source must be given time before being declared dead')
await new Promise((resolve) => setTimeout(resolve, 60))
assert.deepEqual(silent.events.errors, [], 'and not judged after 60ms')

const fast = setup()
const quick = createNativeBroadcast({
  onOffer: () => {},
  onError: (id, reason) => fast.events.errors.push({ id, reason }),
  onViewerGone: (id) => fast.events.gone.push(id),
  bridgeFactory: fast.bridge.factory,
  startPipeline: () => { const c = new EventEmitter(); c.kill = () => {}; return c },
  firstFrameTimeoutMs: 30,
})
await quick.start({})
quick.addViewer('quiet')
await new Promise((resolve) => setTimeout(resolve, 80))
assert.deepEqual(fast.events.errors, [{ id: 'quiet', reason: 'no-frames' }])
assert.equal(quick.viewerCount, 0, 'a source producing nothing must not keep a pipeline alive')

// An offer arriving in time proves the source is live and must cancel the verdict.
const lively = setup()
const alive = createNativeBroadcast({
  onOffer: () => {},
  onError: (id, reason) => lively.events.errors.push({ id, reason }),
  bridgeFactory: lively.bridge.factory,
  startPipeline: () => { const c = new EventEmitter(); c.kill = () => {}; return c },
  firstFrameTimeoutMs: 40,
})
await alive.start({})
alive.addViewer('loud')
lively.bridge.handlers.onOffer('s1', 'v=0 offer')
await new Promise((resolve) => setTimeout(resolve, 90))
assert.deepEqual(lively.events.errors, [], 'a source that offered must never be reported as silent')
assert.equal(alive.viewerCount, 1)

console.log('PASS: per-viewer sessions and pipelines, id routing, silent-source detection, isolated failures, clean stop and missing-GStreamer fallback.')
