// The page's side of native capture.
//
// Broadcasting through Chromium costs about 23 ms per frame in readback and colour conversion before an
// encoder ever runs, which caps a 1440p screen near 41 FPS. A GStreamer pipeline keeps the frame on the
// GPU; measured on the same machine it held 60 with no dropped frames. The main process owns that
// pipeline, this owns the conversation with it.
//
// Signalling stays exactly where it was. The pipeline produces an offer and candidates, this hands them
// to the caller to put on the socket the app already has, and answers come back the same way -- so the
// server, the rooms and the moderation never learn that anything changed.

// The preview is a viewer like any other, except its signalling loops back inside this page instead of
// going to the server. That is why it needs an id no peer could ever have.
export const PREVIEW_ID = 'native-preview'

const bridge = () => (typeof window === 'undefined' ? null : window.electronAPI)

// The pipeline gathers only host candidates unless it is told where to ask for more, and host candidates
// are private addresses no one outside the network can reach. On loopback that is invisible -- both ends
// are the same machine -- and over the internet it is fatal: the viewer sits at "connecting" until it
// gives up, because nothing it was offered is reachable.
//
// whipsink wants one STUN and one TURN as URLs rather than the object list the browser takes, so the
// app's own ICE configuration is translated here instead of being configured twice and drifting apart.
const asUrl = (value) => (Array.isArray(value) ? value : [value]).filter((url) => typeof url === 'string')

export function nativeIceServers(servers = []) {
  const entries = servers.flatMap((server) => asUrl(server?.urls).map((url) => ({ url, server })))
  const stun = entries.find(({ url }) => /^stuns?:/i.test(url))
  // UDP relay first: TCP and TLS exist for networks that block it and cost latency everywhere else.
  const turns = entries.filter(({ url, server }) => /^turns?:/i.test(url) && server?.username && server?.credential)
  const turn = turns.find(({ url }) => /transport=udp/i.test(url)) || turns.find(({ url }) => !/transport=/i.test(url)) || turns[0]
  return {
    stunServer: stun ? stun.url.replace(/^(stuns?):(?:\/\/)?/i, '$1://').split(/[?]/)[0] : null,
    // Credentials are percent-encoded because Cloudflare's contain characters that would otherwise end
    // the authority early and produce a URL pointing somewhere else entirely.
    turnServer: turn
      ? turn.url.replace(/^(turns?):(?:\/\/)?/i, (_match, scheme) =>
        `${scheme}://${encodeURIComponent(turn.server.username)}:${encodeURIComponent(turn.server.credential)}@`).split(/[?]/)[0]
      : null,
  }
}

// The native path sends a fixed bitrate -- whipsink has no congestion control, and webrtcsink's could
// not drive amfh264enc anyway -- so the number chosen at the start is the number sent for the whole
// broadcast. Sending ten megabits for a 1080p30 desktop is waste that never corrects itself, and the
// same ten for 1440p60 game footage is not enough.
//
// Bits per pixel fall as the picture grows, because neighbouring pixels are more alike the more of them
// there are, so this is not linear. The exponent fits measured targets for H.264 constrained baseline
// on game content -- 1080p30 near 5 Mbps, 1080p60 and 1440p30 near 8, 1440p60 near 14 -- and constrained
// baseline is what the browsers accept, which costs perhaps a quarter over High profile.
//
// Floor and ceiling are both real: below the floor a moving picture falls apart whatever the maths says,
// and the ceiling is the per-viewer limit the app has always had.
const MIN_KBPS = 1_500
const MAX_KBPS = 20_000
export function nativeBitrateKbps(width, height, fps) {
  const pixels = Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? width * height
    // A window's size is not known until it is captured, and most are smaller than the screen they sit
    // on, so 1080p is the middle guess rather than the generous one.
    : 1920 * 1080
  const rate = Number.isFinite(fps) && fps > 0 ? Math.min(fps, 120) : 60
  const megapixelsPerSecond = (pixels * rate) / 1_000_000
  const kbps = Math.round(230 * (megapixelsPerSecond ** 0.75))
  return Math.min(MAX_KBPS, Math.max(MIN_KBPS, kbps))
}

export async function isNativeCaptureAvailable() {
  try { return (await bridge()?.isNativeCaptureAvailable?.()) === true } catch { return false }
}

export function createNativeBroadcast({ onOffer, onCandidate, onViewerGone, onError } = {}) {
  const api = bridge()
  const unsubscribes = []
  let previewPeer = null
  let previewStream = null

  // The preview answers its own offer here rather than over the socket; everything else is forwarded.
  const routeOffer = async (connectionId, sdp) => {
    if (connectionId !== PREVIEW_ID) return onOffer?.(connectionId, sdp)
    if (!previewPeer) return
    try {
      await previewPeer.setRemoteDescription({ type: 'offer', sdp })
      await previewPeer.setLocalDescription(await previewPeer.createAnswer())
      // No trickle path back to the pipeline over WHIP, so the answer has to carry every candidate.
      await gathered(previewPeer)
      await api?.answerNativeViewer?.(PREVIEW_ID, previewPeer.localDescription.sdp)
    } catch (error) { onError?.(PREVIEW_ID, error?.message || 'preview-failed') }
  }

  const routeCandidate = (connectionId, candidate) => {
    if (connectionId !== PREVIEW_ID) return onCandidate?.(connectionId, candidate)
    previewPeer?.addIceCandidate(candidate).catch(() => { /* late or duplicate */ })
  }

  const routeGone = (connectionId) => {
    if (connectionId === PREVIEW_ID) closePreviewPeer()
    else onViewerGone?.(connectionId)
  }

  if (api) {
    unsubscribes.push(
      api.onNativeOffer?.(routeOffer),
      api.onNativeCandidate?.(routeCandidate),
      api.onNativeViewerGone?.(routeGone),
      api.onNativeError?.((connectionId, reason) => onError?.(connectionId, reason)),
    )
  }

  function closePreviewPeer() {
    previewPeer?.close()
    previewPeer = null
    previewStream = null
  }

  return {
    // The same picker the browser path opens, so choosing a source feels identical either way. Null
    // means the person closed it without choosing, which is an answer and not a failure.
    async pickSource(audioRequested = false) {
      try { return (await api?.pickNativeSource?.(audioRequested === true)) || null } catch { return null }
    },
    // False means the caller should use the capture that already works rather than fail the broadcast.
    async start(settings) {
      return (await api?.startNativeBroadcast?.(settings)) === true
    },
    addViewer: async (connectionId) => (await api?.addNativeViewer?.(connectionId)) === true,
    answer: async (connectionId, sdp) => (await api?.answerNativeViewer?.(connectionId, sdp)) === true,
    removeViewer: (connectionId) => api?.removeNativeViewer?.(connectionId),

    // Costs one more pipeline for as long as it is open, which is why it is opened on demand and torn
    // down on close instead of running alongside the broadcast the whole time.
    async openPreview(onStream) {
      if (previewPeer) { if (previewStream) onStream?.(previewStream); return true }
      previewPeer = new RTCPeerConnection({ iceServers: [] })
      previewPeer.ontrack = ({ streams, track }) => {
        previewStream = streams[0] || new MediaStream([track])
        onStream?.(previewStream)
      }
      const started = await api?.addNativeViewer?.(PREVIEW_ID)
      if (started !== true) { closePreviewPeer(); return false }
      return true
    },
    closePreview() {
      closePreviewPeer()
      api?.removeNativeViewer?.(PREVIEW_ID)
    },

    stop() {
      closePreviewPeer()
      api?.stopNativeBroadcast?.()
    },
    dispose() {
      closePreviewPeer()
      for (const off of unsubscribes) off?.()
      unsubscribes.length = 0
    },
  }
}

// Loopback gathers instantly, but a browser that never reports completion must not hang the preview.
function gathered(peer) {
  if (peer.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      if (peer.iceGatheringState !== 'complete') return
      peer.removeEventListener('icegatheringstatechange', done)
      resolve()
    }
    peer.addEventListener('icegatheringstatechange', done)
    setTimeout(resolve, 2_000)
  })
}
