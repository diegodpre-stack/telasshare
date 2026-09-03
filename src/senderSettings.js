export async function applySenderSettings(sender, settings) {
  const parameters = sender.getParameters()
  if (!parameters.encodings?.length) return false
  for (const encoding of parameters.encodings) {
    encoding.maxBitrate = settings.maxBitrate
    encoding.maxFramerate = settings.fps
  }
  parameters.degradationPreference = 'maintain-framerate'
  try { await sender.setParameters(parameters) }
  catch {
    const fallback = sender.getParameters()
    for (const encoding of fallback.encodings || []) {
      encoding.maxBitrate = settings.maxBitrate
      encoding.maxFramerate = settings.fps
    }
    await sender.setParameters(fallback)
  }
  return true
}
