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
