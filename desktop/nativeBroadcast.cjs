// Owns the native broadcast: one bridge, and one pipeline per viewer.
//
// The renderer keeps the signalling socket, so this never talks to the server. It emits what the
// renderer should send -- an offer, a candidate -- and is fed the answers that come back. Keeping the
// socket in one place means the app's rooms, auth and moderation stay exactly as they are.
//
// One pipeline per viewer is deliberately the phase-2 shape, and it still encodes once per viewer, just
// as the Chromium path does today. Phase 3 replaces it with one encoder feeding a tee; the API here is
// already per-viewer so that change stays inside this file.
const { startPipeline: defaultStartPipeline, normalizeH264Profile } = require('./nativeCapture.cjs')
const { createWhipBridge } = require('./whipBridge.cjs')

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
} = {}) {
  const viewers = new Map()
  let bridge = null
  let settings = null

  // The bridge speaks in its own session ids; everything outside this file speaks in the app's
  // connectionIds, which is what the signalling messages already carry.
  const connectionFor = (sessionId) => {
    for (const [connectionId, viewer] of viewers) if (viewer.sessionId === sessionId) return connectionId
    return null
  }

  const dropViewer = (connectionId, notify) => {
    const viewer = viewers.get(connectionId)
    if (!viewer) return
    viewers.delete(connectionId)
    clearTimeout(viewer.firstFrame)
    bridge?.closeSession(viewer.sessionId)
    // The pipeline holds the capture and the encoder; leaving one behind burns GPU for nobody.
    try { viewer.child?.kill() } catch { /* already gone */ }
    if (notify) onViewerGone?.(connectionId)
  }

  return {
    get active() { return bridge !== null },
    get viewerCount() { return viewers.size },

    // Called when the user starts broadcasting. Returns false when GStreamer is missing, which is the
    // caller's cue to use the existing Chromium capture rather than to fail.
    async start(options = {}) {
      if (bridge) return true
      const created = bridgeFactory({
        transform: normalizeH264Profile,
        onOffer: (sessionId, sdp) => {
          const connectionId = connectionFor(sessionId)
          if (!connectionId) return
          // The offer is proof a frame arrived, which is the only signal the source is alive.
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
      return true
    },

    // A viewer asked to watch. Each gets its own session and endpoint, so a failure to connect one
    // never disturbs the others.
    addViewer(connectionId) {
      if (!bridge || viewers.has(connectionId)) return false
      const { id, endpoint } = bridge.createSession()
      const child = startPipeline({ ...settings, endpoint })
      if (!child) {
        bridge.closeSession(id)
        onError?.(connectionId, 'gstreamer-missing')
        return false
      }
      // gst-launch writes the reason it failed to stderr and then exits. Discarding that left every
      // pipeline failure looking identical from the outside -- a viewer that simply never sees a screen.
      let complaint = ''
      child.stderr?.on('data', (chunk) => {
        complaint = (complaint + chunk.toString()).slice(-4000)
      })
      const failureReason = () => {
        const line = complaint.split(String.fromCharCode(10)).find((entry) => /ERROR|erroneous pipeline|no element/i.test(entry))
        return line ? line.trim().slice(0, 300) : null
      }
      const firstFrame = setTimeout(() => {
        if (!viewers.has(connectionId)) return
        onError?.(connectionId, 'no-frames')
        dropViewer(connectionId, true)
      }, firstFrameTimeoutMs)
      firstFrame.unref?.()
      viewers.set(connectionId, { sessionId: id, child, firstFrame })
      // A pipeline that dies takes its viewer with it; the app should hear about that once, and hear why.
      child.once?.('exit', (code) => {
        if (viewers.get(connectionId)?.child !== child) return
        if (code) onError?.(connectionId, failureReason() || 'pipeline-failed')
        dropViewer(connectionId, true)
      })
      return true
    },

    // The viewer's answer, arriving over signalling. False means nobody was waiting for it.
    answer(connectionId, sdp) {
      const viewer = viewers.get(connectionId)
      return viewer ? bridge.provideAnswer(viewer.sessionId, sdp) === true : false
    },

    removeViewer(connectionId) { dropViewer(connectionId, false) },

    async stop() {
      for (const connectionId of [...viewers.keys()]) dropViewer(connectionId, false)
      const closing = bridge?.close()
      bridge = null
      settings = null
      await closing
    },
  }
}

module.exports = { createNativeBroadcast }
