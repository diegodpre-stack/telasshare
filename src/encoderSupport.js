// Every attempt at reaching the GPU so far had to go through a live broadcast to learn anything, and
// each one only answered for whatever codec and resolution the call happened to negotiate. The Media
// Capabilities API answers the same question directly: for a given codec, size and frame rate, would
// this machine's WebRTC use an encoder that is powerEfficient — which is the very field that has been
// reporting false in getStats all along.
//
// Two resolutions per codec on purpose. Chromium holds calls on a software encoder while the picture is
// small, and a broadcast is always small at the start, so a result that differs between the two sizes
// says something a single probe would hide.
const probes = [
  { label: 'H.264 baseline', contentType: 'video/H264;codecs="avc1.42E01F"' },
  { label: 'H.264 high', contentType: 'video/H264;codecs="avc1.640C1F"' },
  { label: 'VP9', contentType: 'video/VP9;codecs="vp09.00.10.08"' },
  { label: 'AV1', contentType: 'video/AV1;codecs="av01.0.04M.08"' },
  { label: 'VP8', contentType: 'video/VP8' },
]
const sizes = [
  { label: '720p', width: 1280, height: 720, bitrate: 3_000_000 },
  { label: '1440p', width: 2560, height: 1440, bitrate: 12_000_000 },
]

export async function probeHardwareEncoders() {
  if (!navigator.mediaCapabilities?.encodingInfo) return null
  const rows = []
  for (const probe of probes) {
    const results = []
    for (const size of sizes) {
      try {
        // type 'webrtc' asks about the realtime pipeline specifically, not file playback, so the answer
        // is about the encoder a broadcast would actually get.
        const info = await navigator.mediaCapabilities.encodingInfo({
          type: 'webrtc',
          video: { contentType: probe.contentType, width: size.width, height: size.height, bitrate: size.bitrate, framerate: 60 },
        })
        results.push({ size: size.label, supported: !!info.supported, smooth: !!info.smooth, powerEfficient: !!info.powerEfficient })
      } catch {
        // An unsupported codec string rejects rather than answering, which is itself an answer.
        results.push({ size: size.label, supported: false, smooth: false, powerEfficient: false })
      }
    }
    rows.push({ label: probe.label, results })
  }
  return rows
}
