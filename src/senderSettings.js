// Hardware H.264 encoders take even frame dimensions. An odd width or height makes Chromium give up on
// the GPU encoder and fall back to OpenH264 on the CPU, silently and mid-broadcast.
//
// Measured on a 2560×1440 capture asked for 1080p: rounding the ratio to two decimals gave 1.33, and
// 2560/1.33 = 1924.8 with 1440/1.33 = 1082.7, so the encoder was handed 1925×1083 — both odd. Encoding
// moved from MediaFoundation (AMDh264Encoder) at ~16 ms per frame to OpenH264 at up to 54 ms, and the
// broadcast went from 43 FPS to 18. The 720p and 1440p presets were unaffected because they divide
// evenly (2 and 1), which is exactly the pattern the diagnostics report showed.
//
// So never round the ratio, and pick an output height whose matching width also lands even. The search
// walks down in steps of two: 16:9 sources match on the first try, and an odd-sized window capture —
// which is where this bites without any preset being involved — gives up at most a couple of lines.
export function scaleForTarget(width, height, target) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 2 || height < 2) return 1
  // No target means "auto": keep the capture size, but still correct an odd one.
  const ceiling = Number.isFinite(target) && target > 0 ? Math.min(target, height) : height
  for (let outHeight = Math.floor(ceiling / 2) * 2; outHeight >= 2; outHeight -= 2) {
    const outWidth = Math.round(width * outHeight / height)
    if (outWidth >= 2 && outWidth % 2 === 0) return height / outHeight
  }
  return 1
}

// scaleResolutionDownBy is where the chosen resolution is applied. Constraining the capture instead
// makes the browser resize every frame on the thread producing them; the encoder pipeline is built to
// scale and can hand the work to the GPU. A factor below 1 is invalid, so anything smaller means the
// capture is already at or under the target and no scaling is wanted.
const applyTo = (encodings, settings) => {
  for (const encoding of encodings || []) {
    encoding.maxBitrate = settings.maxBitrate
    encoding.maxFramerate = settings.fps
    encoding.scaleResolutionDownBy = Number.isFinite(settings.scaleResolutionDownBy) && settings.scaleResolutionDownBy > 1
      ? settings.scaleResolutionDownBy
      : 1
  }
}

export async function applySenderSettings(sender, settings) {
  const parameters = sender.getParameters()
  if (!parameters.encodings?.length) return false
  applyTo(parameters.encodings, settings)
  parameters.degradationPreference = 'maintain-framerate'
  try { await sender.setParameters(parameters) }
  catch {
    const fallback = sender.getParameters()
    applyTo(fallback.encodings, settings)
    await sender.setParameters(fallback)
  }
  return true
}
