import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
const { createNativeBroadcast } = createRequire(import.meta.url)('../desktop/nativeBroadcast.cjs')

// A stand-in bridge: same surface, no sockets, so seat handling can be driven step by step.
function fakeBridge() {
  const state = { sessions: new Map(), closed: [], armed: [], handlers: null, transform: null, next: 0 }
  state.factory = (handlers) => {
    state.handlers = handlers
    state.transform = handlers.transform
    return {
      listen: async () => 1234,
      createSession: ({ armed = true } = {}) => {
        const id = `s${++state.next}`
        state.sessions.set(id, { armed })
        return { id, endpoint: `http://127.0.0.1:1234/whip/${id}` }
      },
      arm: (id) => { state.armed.push(id); const session = state.sessions.get(id); if (session) session.armed = true; return true },
      provideAnswer: (id, sdp) => state.sessions.has(id) && typeof sdp === 'string',
      closeSession: (id) => { state.sessions.delete(id); state.closed.push(id) },
      close: async () => { state.sessions.clear() },
    }
  }
  return state
}

const setup = ({ seats = 2, startPipeline, firstFrameTimeoutMs } = {}) => {
  const bridge = fakeBridge()
  const events = { offers: [], candidates: [], gone: [], errors: [] }
  const spawned = []
  const broadcast = createNativeBroadcast({
    onOffer: (id, sdp) => events.offers.push({ id, sdp }),
    onCandidate: (id, candidate) => events.candidates.push({ id, candidate }),
    onViewerGone: (id) => events.gone.push(id),
    onError: (id, reason) => events.errors.push({ id, reason }),
    bridgeFactory: bridge.factory,
    seats,
    ...(firstFrameTimeoutMs ? { firstFrameTimeoutMs } : {}),
    startPipeline: startPipeline || ((options) => {
      const child = new EventEmitter()
      child.kill = () => { child.killed = true; child.emit('exit', 0) }
      spawned.push({ options, child })
      return child
    }),
  })
  return { bridge, events, spawned, broadcast }
}

// --- one capture, many viewers -------------------------------------------
// The whole point of phase 3: four friends used to mean four captures and four encodes.
{
  const { bridge, events, spawned, broadcast } = setup({ seats: 3 })
  await broadcast.start({ monitorIndex: 1, fps: 60 })
  assert.equal(spawned.length, 1, 'the shared capture starts with the broadcast, not with a viewer')
  assert.equal(spawned[0].options.endpoints.length, 3, 'every seat is wired into the one pipeline')
  assert.equal(spawned[0].options.monitorIndex, 1, 'capture settings still reach it')
  assert.ok(bridge.transform('profile-level-id=420432').includes('42e01f'), 'the codec rewrite must survive')

  // Seats offer while empty, so they must not be given a clock until somebody is expected to answer.
  assert.deepEqual(bridge.armed, [])
  bridge.handlers.onOffer('s1', 'v=0 seat one')
  assert.deepEqual(events.offers, [], 'an offer for an empty seat goes nowhere yet')

  assert.equal(broadcast.addViewer('c1'), true)
  assert.deepEqual(bridge.armed, ['s1'], 'taking a seat starts its clock')
  assert.deepEqual(events.offers, [{ id: 'c1', sdp: 'v=0 seat one' }], 'the offer made earlier is still the right one')

  assert.equal(broadcast.addViewer('c2'), true)
  assert.equal(spawned.length, 1, 'a second viewer must not start a second capture')
  bridge.handlers.onOffer('s2', 'v=0 seat two')
  assert.deepEqual(events.offers.at(-1), { id: 'c2', sdp: 'v=0 seat two' })
  assert.equal(broadcast.sharedCount, 2)
  assert.equal(broadcast.viewerCount, 2)

  bridge.handlers.onCandidate('s2', { candidate: 'candidate:1 1 UDP' })
  assert.equal(events.candidates.at(-1).id, 'c2', 'candidates route to the viewer in that seat')
  assert.equal(broadcast.answer('c1', 'v=0 answer'), true)
  assert.equal(broadcast.answer('unknown', 'v=0 answer'), false)
}

// --- a seat is single-use, and refilling waits for an empty room ----------
{
  const { events, spawned, broadcast } = setup({ seats: 1 })
  await broadcast.start({})
  assert.equal(broadcast.addViewer('c1'), true)
  broadcast.removeViewer('c1')
  // The room is empty, so the pipeline can be rebuilt to hand out fresh seats without disturbing anyone.
  assert.equal(spawned.length, 2, 'seats are replenished once nobody is watching')
  assert.ok(spawned[0].child.killed, 'and the spent pipeline is released')
  assert.deepEqual(events.gone, [], 'a viewer the app removed is not reported back as having left')

  assert.equal(broadcast.addViewer('c2'), true)
  assert.equal(broadcast.sharedCount, 1, 'the refilled seat is usable')
  assert.equal(spawned.length, 2, 'and refilling did not happen again with someone watching')
}

// --- overflow gets its own pipeline rather than being turned away --------
{
  const { events, spawned, broadcast } = setup({ seats: 1 })
  await broadcast.start({})
  assert.equal(broadcast.addViewer('c1'), true)
  assert.equal(broadcast.addViewer('c2'), true, 'a viewer with no seat must still be shown the broadcast')
  assert.equal(spawned.length, 2, 'which costs a capture of their own')
  assert.equal(spawned[1].options.endpoints.length, 1)
  assert.equal(broadcast.sharedCount, 1, 'and does not count as sharing the capture')
  assert.equal(broadcast.viewerCount, 2)

  // Their own pipeline dying takes them and nobody else.
  spawned[1].child.emit('exit', 1)
  assert.deepEqual(events.gone, ['c2'])
  assert.equal(broadcast.viewerCount, 1)
}

// --- the shared pipeline dying takes everyone on it, once each -----------
{
  const { events, spawned, broadcast } = setup({ seats: 3 })
  await broadcast.start({})
  broadcast.addViewer('c1')
  broadcast.addViewer('c2')
  spawned[0].child.emit('exit', 1)
  assert.deepEqual([...events.gone].sort(), ['c1', 'c2'], 'every viewer on it hears about it exactly once')
  assert.equal(broadcast.viewerCount, 0)
}

// --- a source that never produces a frame --------------------------------
// whipsink only offers once a frame reaches it, so a minimised window or a game in exclusive fullscreen
// leaves the pipeline in PLAYING forever with nothing said. Hanging in silence is the worst outcome.
{
  const { events, broadcast } = setup({ seats: 2, firstFrameTimeoutMs: 30 })
  await broadcast.start({})
  broadcast.addViewer('quiet')
  await new Promise((resolve) => setTimeout(resolve, 90))
  assert.deepEqual(events.errors, [{ id: 'quiet', reason: 'no-frames' }])
  assert.equal(broadcast.viewerCount, 0, 'a source producing nothing must not keep a pipeline alive')
}

// A seat that had already offered proves the source is live, so no verdict may be reached about it.
{
  const { bridge, events, broadcast } = setup({ seats: 2, firstFrameTimeoutMs: 30 })
  await broadcast.start({})
  bridge.handlers.onOffer('s1', 'v=0 offer')
  broadcast.addViewer('loud')
  await new Promise((resolve) => setTimeout(resolve, 90))
  assert.deepEqual(events.errors, [], 'a seat that already offered must never be called silent')
  assert.equal(broadcast.viewerCount, 1)
}

// --- stopping releases everything ----------------------------------------
{
  const { spawned, broadcast } = setup({ seats: 1 })
  await broadcast.start({})
  broadcast.addViewer('c1')
  broadcast.addViewer('c2')
  await broadcast.stop()
  assert.equal(broadcast.active, false)
  assert.equal(broadcast.viewerCount, 0)
  assert.ok(spawned.every((pipeline) => pipeline.child.killed), 'no pipeline may outlive the broadcast, holding the encoder')
}

// --- missing GStreamer falls back instead of failing ----------------------
{
  const { bridge, events, broadcast } = setup({ seats: 2, startPipeline: () => null })
  await broadcast.start({})
  assert.equal(broadcast.addViewer('c1'), false)
  assert.deepEqual(events.errors, [{ id: 'c1', reason: 'gstreamer-missing' }],
    'the caller needs to know why, so it can use the Chromium path instead')
  assert.equal(broadcast.viewerCount, 0, 'a viewer with no pipeline must not be tracked')
  assert.ok(bridge.closed.length > 0, 'and no session may be left dangling')
}

console.log('PASS: one capture shared across viewers, seats armed only when taken, single-use seats refilled while idle, overflow isolated, silent-source detection and clean stop.')
