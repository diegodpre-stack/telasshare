const sizes = [
  { label: '720p', width: 1280, height: 720, bitrate: 3_000_000 },
  { label: '1440p', width: 2560, height: 1440, bitrate: 12_000_000 },
]

const codecFamily = (codec) => String(codec.mimeType || '').toLowerCase().split('/')[1]?.replace('av01', 'av1')
const families = ['h264', 'av1', 'vp9', 'vp8']
const codecRank = (codec) => {
  const rank = families.indexOf(codecFamily(codec))
  return rank < 0 ? families.length : rank
}
const videoCodecs = (codecs) => codecs.filter((codec) => families.includes(codecFamily(codec)))
const advertisedCodecs = () => globalThis.RTCRtpSender?.getCapabilities?.('video')?.codecs || []
const fmtpParameter = (codec, name) => String(codec.sdpFmtpLine || '').split(';')
  .map((part) => part.trim().toLowerCase().split('=')).find(([key]) => key === name)?.[1]

// WebRTC queries take RTP format parameters, not file-container strings such as avc1.42E01F.
// In particular, baseline (4200) and constrained baseline (42e0) can use different encoders.
export const codecContentType = (codec) => codec.mimeType + (codec.sdpFmtpLine ? `;${codec.sdpFmtpLine}` : '')

async function queryEncoding(codec, configuration, mediaCapabilities, timeoutMs) {
  if (!mediaCapabilities?.encodingInfo) return null
  let timer
  try {
    return await Promise.race([
      Promise.resolve().then(() => mediaCapabilities.encodingInfo({
        type: 'webrtc', video: { ...configuration, contentType: codecContentType(codec) },
      })).then((info) => ({
        supported: info.supported === true,
        smooth: typeof info.smooth === 'boolean' ? info.smooth : null,
        powerEfficient: typeof info.powerEfficient === 'boolean' ? info.powerEfficient : null,
      })),
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs) }),
    ])
  } catch {
    // A rejected query (or an unsupported API) is unknown, not proof of a software-only machine.
    return null
  } finally { clearTimeout(timer) }
}

const positive = (value, fallback) => Number.isFinite(value) && value > 0 ? value : fallback

// This is a preference, not a hardware switch: the receiver and browser still negotiate the encoder.
// Keep every advertised codec, including RTX/FEC and software fallbacks, for other receivers.
export async function preferHardwareVideoCodecs(pc, sender, preferred = 'auto', settings = {}, {
  codecs = advertisedCodecs(), mediaCapabilities = globalThis.navigator?.mediaCapabilities, timeoutMs = 1000,
} = {}) {
  const transceiver = pc.getTransceivers().find((item) => item.sender === sender)
  if (!codecs.length || !transceiver?.setCodecPreferences) return null
  const source = sender.track?.getSettings?.() || {}
  const scale = Math.max(1, positive(settings.scaleResolutionDownBy, 1))
  const configuration = {
    width: Math.max(1, Math.floor(positive(source.width, 1920) / scale)),
    height: Math.max(1, Math.floor(positive(source.height, 1080) / scale)),
    bitrate: positive(settings.maxBitrate, 8_000_000),
    framerate: positive(settings.fps, 60),
  }
  const support = new Map(await Promise.all(videoCodecs(codecs).map(async (codec) =>
    [codec, await queryEncoding(codec, configuration, mediaCapabilities, timeoutMs)])))
  if (pc.signalingState === 'closed') return null
  const chosenFirst = (codec) => preferred !== 'auto' && codecFamily(codec) === preferred ? 0 : 1
  const efficientFirst = (codec) => support.get(codec)?.supported && support.get(codec)?.powerEfficient === true ? 0 : 1
  const packetizationRank = (codec) => codecFamily(codec) === 'h264' && fmtpParameter(codec, 'packetization-mode') !== '1' ? 1 : 0
  const ordered = [...codecs].sort((a, b) => chosenFirst(a) - chosenFirst(b)
    || efficientFirst(a) - efficientFirst(b) || codecRank(a) - codecRank(b)
    || packetizationRank(a) - packetizationRank(b))
  try { transceiver.setCodecPreferences(ordered); return ordered[0]?.mimeType || null }
  catch { return null }
}

const codecLabel = (codec) => {
  const name = codec.mimeType.split('/')[1]
  if (codecFamily(codec) === 'h264') return `H.264 · ${fmtpParameter(codec, 'profile-level-id') || 'perfil padrão'} · modo ${fmtpParameter(codec, 'packetization-mode') || '0'}`
  const profile = fmtpParameter(codec, 'profile-id') ?? fmtpParameter(codec, 'profile')
  return profile == null ? name : `${name} · perfil ${profile}`
}

// Standardized samples of the actual advertised RTP profiles. powerEfficient is a browser hint;
// only live getStats() can identify the implementation selected for a particular connection.
export async function probeHardwareEncoders({
  codecs = advertisedCodecs(), mediaCapabilities = globalThis.navigator?.mediaCapabilities, timeoutMs = 1000,
} = {}) {
  if (!mediaCapabilities?.encodingInfo || !codecs.length) return null
  const unique = [...new Map(videoCodecs(codecs).map((codec) => [codecContentType(codec), codec])).values()]
  return Promise.all(unique.map(async (codec) => ({
    id: codecContentType(codec), label: codecLabel(codec),
    results: await Promise.all(sizes.map(async (size) => ({
      size: size.label, ...await queryEncoding(codec, {
        width: size.width, height: size.height, bitrate: size.bitrate, framerate: 60,
      }, mediaCapabilities, timeoutMs),
    }))),
  })))
}
