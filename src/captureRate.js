// Every frame rate we had so far answered a different question than the one being asked. The local
// preview reports what a <video> element managed to paint, which the browser throttles on its own.
// The WebRTC media-source rate only exists once a viewer is connected and an encoder is attached.
// Neither says what the capture source itself hands over, so read the frames straight off the track.
//
// The arrival intervals matter more than the average: a source held to a lower rate delivers evenly
// spaced frames, a source being starved delivers them in bursts, and both average out to the same
// frames per second. Keeping the spread is what separates the two.
const supported = () => typeof window !== 'undefined' && typeof window.MediaStreamTrackProcessor === 'function'

export function startCaptureRateMeter(track) {
  if (!supported() || !track || track.readyState !== 'live') return null
  let stopped = false
  let reader = null
  let intervals = []
  let previousFrame = null
  let windowStart = performance.now()
  const drain = async () => {
    try {
      // The consumer below only stamps a time and releases the frame. It has to stay that cheap:
      // a slow reader makes the processor drop frames, which would undercount the very rate we
      // are here to measure.
      reader = new window.MediaStreamTrackProcessor({ track }).readable.getReader()
      while (!stopped) {
        const { value, done } = await reader.read()
        if (done) break
        const now = performance.now()
        if (previousFrame !== null) intervals.push(now - previousFrame)
        previousFrame = now
        value.close()
      }
    } catch { /* The track can end or be replaced while a read is pending. */ }
  }
  drain()
  const round = (value) => Math.round(value * 10) / 10
  return {
    // Reads and clears the window, so each call reports only the frames since the previous one.
    read() {
      const now = performance.now()
      const seconds = (now - windowStart) / 1000
      const window = intervals
      intervals = []
      windowStart = now
      if (seconds <= 0) return null
      const sorted = [...window].sort((a, b) => a - b)
      const at = (fraction) => sorted.length ? round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]) : null
      return {
        fps: round(window.length / seconds),
        frames: window.length,
        shortestGapMs: at(0),
        medianGapMs: at(0.5),
        longestGapMs: sorted.length ? round(sorted[sorted.length - 1]) : null,
      }
    },
    stop() {
      stopped = true
      try { reader?.cancel() } catch { /* already released */ }
    },
  }
}
