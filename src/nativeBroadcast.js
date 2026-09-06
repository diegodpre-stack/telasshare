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
