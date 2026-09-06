// Owns the native broadcast: one bridge, and one capture feeding every viewer.
//
// The renderer keeps the signalling socket, so this never talks to the server. It emits what the
// renderer should send -- an offer, a candidate -- and is fed the answers that come back. Keeping the
// socket in one place means the app's rooms, auth and moderation stay exactly as they are.
//
// Phase 2 spawned a pipeline per viewer, so four friends meant four captures and four encodes: the same
// multiplication the Chromium path already had, minus only its readback. Here one capture is encoded
// once and packetised per viewer, because gst-launch cannot grow a pipeline after it starts and whipsink
// serves a single viewer. The seats therefore exist from the moment the broadcast does, each offering
// immediately and waiting -- its POST held open by the bridge -- until somebody sits in it.
//
// A seat is single-use: once its viewer leaves, whipsink has finished its WHIP session and will not
// offer again. So seats are refilled by restarting the shared pipeline while nobody is watching, and a
// viewer who arrives with none free gets a pipeline of their own, exactly as phase 2 did. That overflow
// costs an extra capture and encode, which is worth it against turning somebody away.
const { startPipeline: defaultStartPipeline, normalizeH264Profile } = require('./nativeCapture.cjs')
const { createWhipBridge } = require('./whipBridge.cjs')

// Enough for the rooms this app is used in, and each unused seat costs only a payloader and a queue --
// no extra capture, no extra encode. The pipeline is rebuilt whenever the room empties, so this is a
// ceiling on simultaneous viewers between quiet moments, not on viewers per broadcast.
const DEFAULT_SEATS = 8

// whipsink offers only once the first frame reaches it, so a source producing nothing leaves the whole
// pipeline sitting in PLAYING with nobody told. That is what a minimised window, an occluded one, or a
// game in exclusive fullscreen looks like from here: no error, no picture, no offer. Long enough that a
// slow first frame is not mistaken for a dead source.
const FIRST_FRAME_TIMEOUT_MS = 8_000

function createNativeBroadcast({
  onOffer, onCandidate, onViewerGone, onError,
  startPipeline = defaultStartPipeline,
  bridgeFactory = createWhipBridge,
  firstFrameTimeoutMs = FIRST_FRAME_TIMEOUT_MS,
  seats = DEFAULT_SEATS,
} = {}) {
  const viewers = new Map()
  // sessionId -> the offer that seat produced, kept until a viewer is given it. A shared seat offers
  // long before anyone asks to watch, and that offer stays valid: it describes the capture, not the peer.
  const offers = new Map()
  let bridge = null
  let settings = null
  let shared = null

  const connectionFor = (sessionId) => {
    for (const [connectionId, viewer] of viewers) if (viewer.sessionId === sessionId) return connectionId
    return null
  }

  const sharedViewers = () => [...viewers.values()].filter((viewer) => !viewer.child).length

  // Only while nobody is watching: rebuilding the pipeline drops every seat, spent or not.
  const refillSeats = () => {
    if (!bridge || !shared || sharedViewers() > 0) return
    if (shared.free.length === shared.seats) return
    stopShared()
    startShared()
  }

  const stopShared = () => {
    if (!shared) return
    for (const id of shared.ids) { offers.delete(id); bridge.closeSession(id) }
    try { shared.child?.kill() } catch { /* already gone */ }
    shared = null
  }

  // Seats are created unarmed so an empty one waits forever rather than timing out on a viewer who has
  // not arrived; arming happens when one is handed out.
  const startShared = () => {
    const created = Array.from({ length: seats }, () => bridge.createSession({ armed: false }))
    const child = startPipeline({ ...settings, endpoints: created.map((seat) => seat.endpoint) })
    if (!child) {
      for (const seat of created) bridge.closeSession(seat.id)
      return false
    }
    shared = { child, ids: created.map((seat) => seat.id), free: created.map((seat) => seat.id), seats }
    // The whole pipeline dying takes every viewer on it, and each has to hear about it once.
    child.once?.('exit', () => {
      if (shared?.child !== child) return
      const affected = [...viewers.entries()].filter(([, viewer]) => !viewer.child).map(([connectionId]) => connectionId)
      shared = null
      for (const connectionId of affected) dropViewer(connectionId, true)
    })
    return true
  }

  const dropViewer = (connectionId, notify) => {
    const viewer = viewers.get(connectionId)
    if (!viewer) return
    viewers.delete(connectionId)
    clearTimeout(viewer.firstFrame)
    offers.delete(viewer.sessionId)
    bridge?.closeSession(viewer.sessionId)
    // A dedicated pipeline exists for one viewer and must go with them; the shared one outlives them.
    if (viewer.child) { try { viewer.child.kill() } catch { /* already gone */ } }
    if (notify) onViewerGone?.(connectionId)
    refillSeats()
  }

  return {
    get active() { return bridge !== null },
    get viewerCount() { return viewers.size },
    // How many viewers the shared capture is currently carrying, which is what phase 3 exists to raise.
    get sharedCount() { return sharedViewers() },

    async start(options = {}) {
      if (bridge) return true
      const created = bridgeFactory({
        transform: normalizeH264Profile,
        onOffer: (sessionId, sdp) => {
          offers.set(sessionId, sdp)
          const connectionId = connectionFor(sessionId)
          if (!connectionId) return
          // An offer is proof a frame arrived, which is the only signal the source is alive.
          const viewer = viewers.get(connectionId)
          clearTimeout(viewer?.firstFrame)
          if (viewer) viewer.firstFrame = null
          onOffer?.(connectionId, sdp)
        },
        onCandidate: (sessionId, candidate) => {
          const connectionId = connectionFor(sessionId)
          if (connectionId) onCandidate?.(connectionId, candidate)
        },
        onClosed: (sessionId) => {
          const connectionId = connectionFor(sessionId)
          if (connectionId) dropViewer(connectionId, true)
        },
      })
      await created.listen()
      bridge = created
      settings = { ...options }
      // A missing pipeline is not a failed broadcast: viewers fall back to one each, and if that fails
      // too addViewer reports why so the caller can use the Chromium capture instead.
      startShared()
      return true
    },

    addViewer(connectionId) {
      if (!bridge || viewers.has(connectionId)) return false
      if (!shared) startShared()

      const seat = shared?.free.shift()
      if (seat) {
        bridge.arm(seat)
        viewers.set(connectionId, { sessionId: seat, child: null, firstFrame: null })
        const waiting = offers.get(seat)
        // The seat may have offered long ago, while nobody was in it. That offer is still the right one.
        if (waiting) onOffer?.(connectionId, waiting)
        else {
          const firstFrame = setTimeout(() => {
            if (!viewers.has(connectionId)) return
            onError?.(connectionId, 'no-frames')
            dropViewer(connectionId, true)
          }, firstFrameTimeoutMs)
          firstFrame.unref?.()
          viewers.get(connectionId).firstFrame = firstFrame
        }
        return true
      }

      // Every seat taken or spent: fall back to a pipeline of their own rather than refuse to show them
      // the broadcast. It costs another capture and encode, which is the price of not turning them away.
      const { id, endpoint } = bridge.createSession()
      const child = startPipeline({ ...settings, endpoints: [endpoint] })
      if (!child) {
        bridge.closeSession(id)
        onError?.(connectionId, 'gstreamer-missing')
        return false
      }
      const firstFrame = setTimeout(() => {
        if (!viewers.has(connectionId)) return
        onError?.(connectionId, 'no-frames')
        dropViewer(connectionId, true)
      }, firstFrameTimeoutMs)
      firstFrame.unref?.()
      viewers.set(connectionId, { sessionId: id, child, firstFrame })
      child.once?.('exit', () => { if (viewers.get(connectionId)?.child === child) dropViewer(connectionId, true) })
      return true
    },

    answer(connectionId, sdp) {
      const viewer = viewers.get(connectionId)
      return viewer ? bridge.provideAnswer(viewer.sessionId, sdp) === true : false
    },

    removeViewer(connectionId) { dropViewer(connectionId, false) },

    async stop() {
      for (const connectionId of [...viewers.keys()]) {
        const viewer = viewers.get(connectionId)
        viewers.delete(connectionId)
        clearTimeout(viewer.firstFrame)
        if (viewer.child) { try { viewer.child.kill() } catch { /* already gone */ } }
      }
      stopShared()
      offers.clear()
      const closing = bridge?.close()
      bridge = null
      settings = null
      await closing
    },
  }
}

module.exports = { createNativeBroadcast, DEFAULT_SEATS }
