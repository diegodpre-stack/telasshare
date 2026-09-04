import assert from 'node:assert/strict'
import { codecContentType, preferHardwareVideoCodecs, probeHardwareEncoders } from '../src/encoderSupport.js'

const h264 = (profile, mode = 1) => ({ mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: `level-asymmetry-allowed=1;packetization-mode=${mode};profile-level-id=${profile}` })
const constrained = h264('42e01f'), baseline0 = h264('42001f', 0), baseline = h264('42001f'), high = h264('640032')
const vp8 = { mimeType: 'video/VP8', clockRate: 90000 }
const av1 = { mimeType: 'video/AV1', clockRate: 90000, sdpFmtpLine: 'level-idx=5;profile=0;tier=0' }
const vp9 = { mimeType: 'video/VP9', clockRate: 90000, sdpFmtpLine: 'profile-id=0' }
const rtx = { mimeType: 'video/rtx', clockRate: 90000 }, red = { mimeType: 'video/red', clockRate: 90000 }, fec = { mimeType: 'video/ulpfec', clockRate: 90000 }
const codecs = [vp8, rtx, constrained, baseline0, baseline, high, av1, vp9, red, fec]
const original = structuredClone(codecs)
const queried = []
const mediaCapabilities = { async encodingInfo(query) {
  queried.push(query)
  return { supported: true, smooth: true, powerEfficient: /profile-level-id=(42001f|640032)/.test(query.video.contentType) }
} }
const settings = { fps: 60, maxBitrate: 8_000_000, scaleResolutionDownBy: 2 }
function fixture() {
  let ordered
  const sender = { track: { getSettings: () => ({ width: 2560, height: 1440 }) } }
  const transceiver = { sender, setCodecPreferences: (value) => { ordered = value } }
  const pc = { signalingState: 'stable', getTransceivers: () => [transceiver] }
  return { sender, pc, transceiver, ordered: () => ordered }
}

const automatic = fixture()
assert.equal(await preferHardwareVideoCodecs(automatic.pc, automatic.sender, 'auto', settings, { codecs, mediaCapabilities }), 'video/H264')
assert.equal(automatic.ordered()[0], baseline, 'prefer efficient ordinary baseline, not software constrained baseline')
assert.ok(automatic.ordered().indexOf(high) < automatic.ordered().indexOf(constrained))
assert.deepEqual(new Set(automatic.ordered()), new Set(codecs), 'retain all codec and repair fallbacks')
assert.deepEqual(codecs, original, 'do not mutate browser capabilities')
assert.equal(queried.length, 7, 'do not query RTX, RED or FEC')
assert.deepEqual(queried[0], { type: 'webrtc', video: { width: 1280, height: 720, bitrate: 8_000_000, framerate: 60, contentType: 'video/VP8' } })
assert.equal(codecContentType(baseline), 'video/H264;level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f')
assert.ok(queried.every((query) => !query.video.contentType.includes('codecs=')), 'use RTP format parameters')

for (const [preferred, first] of [['h264', baseline], ['vp8', vp8], ['av1', av1], ['vp9', vp9]]) {
  const test = fixture()
  await preferHardwareVideoCodecs(test.pc, test.sender, preferred, settings, { codecs, mediaCapabilities })
  assert.equal(test.ordered()[0], first, `honor explicit ${preferred} selection`)
  assert.deepEqual(new Set(test.ordered()), new Set(codecs))
}

const anotherMachine = fixture()
await preferHardwareVideoCodecs(anotherMachine.pc, anotherMachine.sender, 'auto', settings, {
  codecs, mediaCapabilities: { encodingInfo: async (query) => ({ supported: true, powerEfficient: query.video.contentType === 'video/VP8' }) },
})
assert.equal(anotherMachine.ordered()[0], vp8, 'hardware preference must not be hardcoded to H.264 or NVIDIA')

for (const unavailable of [null, {}, { encodingInfo: () => { throw Error('unsupported API') } }, { encodingInfo: async () => { throw Error('invalid query') } }, { encodingInfo: () => new Promise(() => {}) }]) {
  const test = fixture()
  await preferHardwareVideoCodecs(test.pc, test.sender, 'auto', settings, { codecs, mediaCapabilities: unavailable, timeoutMs: 5 })
  assert.equal(test.ordered()[0], constrained, 'without efficiency evidence, keep browser profile order within mode 1')
  assert.equal(test.ordered().length, codecs.length, 'missing, rejected or timed-out probes must not block negotiation')
}

const closed = fixture()
await preferHardwareVideoCodecs(closed.pc, closed.sender, 'auto', settings, {
  codecs, mediaCapabilities: { encodingInfo: async () => { closed.pc.signalingState = 'closed'; return { supported: true, powerEfficient: true } } },
})
assert.equal(closed.ordered(), undefined, 'do not set preferences after peer closes during probe')
const rejected = fixture()
rejected.transceiver.setCodecPreferences = () => { throw Error('unsupported preferences') }
assert.equal(await preferHardwareVideoCodecs(rejected.pc, rejected.sender, 'auto', settings, { codecs, mediaCapabilities }), null)
assert.equal(await preferHardwareVideoCodecs({ getTransceivers: () => [] }, {}, 'auto', settings, { codecs }), null)

const rows = await probeHardwareEncoders({ codecs: [...codecs, baseline], mediaCapabilities })
assert.equal(rows.length, 7, 'probe only unique advertised video profiles')
assert.equal(new Set(rows.map((row) => row.id)).size, rows.length)
const baselineRow = rows.find((row) => row.id === codecContentType(baseline))
assert.ok(baselineRow.label.includes('42001f'))
assert.deepEqual(baselineRow.results.map((result) => [result.size, result.supported, result.powerEfficient]), [['720p', true, true], ['1440p', true, true]])
assert.ok(rows.find((row) => row.id === codecContentType(constrained)).results.every((result) => result.powerEfficient === false))
assert.equal(await probeHardwareEncoders({ codecs, mediaCapabilities: null }), null)
assert.equal(await probeHardwareEncoders({ codecs: [], mediaCapabilities }), null)
const rejectedRows = await probeHardwareEncoders({ codecs: [vp8], mediaCapabilities: { encodingInfo: async () => { throw Error('not implemented') } } })
assert.ok(rejectedRows[0].results.every((result) => result.supported == null && result.powerEfficient == null), 'rejected queries are unknown, not software or unsupported')
const unsupportedRows = await probeHardwareEncoders({ codecs: [vp8], mediaCapabilities: { encodingInfo: async () => ({ supported: false, powerEfficient: false }) } })
assert.ok(unsupportedRows[0].results.every((result) => result.supported === false))

console.log('PASS: RTP profile probes, hardware-aware ordering, manual preferences, codec fallbacks, unavailable APIs, timeout and closed-peer safety.')
