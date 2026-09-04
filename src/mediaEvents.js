// Keep failure breadcrumbs even when a peer is removed before the next statistics sample.
// Never store SDP, candidates, exception messages, track labels or device IDs.
const fields = ['phase', 'errorName', 'errorDetail', 'sdpLineNumber', 'signalingState', 'iceState', 'connectionState', 'readyState', 'displaySurface', 'width', 'height', 'frameRate']
export function createMediaEventLog(limit = 100) {
  const events = []
  return {
    record(type, details = {}) {
      const safe = Object.fromEntries(fields.filter((key) => typeof details[key] === 'string' || Number.isFinite(details[key]))
        .map((key) => [key, typeof details[key] === 'string' ? details[key].slice(0, 80) : details[key]]))
      events.push({ time: new Date().toISOString(), type, ...safe })
      if (events.length > limit) events.splice(0, events.length - limit)
    },
    read: () => events.map((event) => ({ ...event })),
  }
}
export const mediaEvents = createMediaEventLog()

export function recordPeerFailure(phase, error, pc) {
  mediaEvents.record('peer-operation-failed', {
    phase, errorName: error?.name || 'UnknownError', errorDetail: error?.errorDetail,
    sdpLineNumber: error?.sdpLineNumber, signalingState: pc?.signalingState,
    iceState: pc?.iceConnectionState, connectionState: pc?.connectionState,
  })
}
