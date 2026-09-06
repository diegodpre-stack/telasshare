import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const { findGstreamer, normalizeH264Profile, buildPipelineArgs, startPipeline } =
  createRequire(import.meta.url)('../desktop/nativeCapture.cjs')

// --- finding the install -------------------------------------------------
// The MSVC installer puts GStreamer under the user's profile, not the documented machine-wide path, so
// an install that is plainly there looks missing if only the documented path is checked.
const userInstall = 'C:\\Users\\test\\AppData\\Local\\Programs\\gstreamer\\1.0\\msvc_x86_64\\bin'
assert.equal(
  findGstreamer({ LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local' }, (p) => p.startsWith(userInstall)),
  userInstall,
)
assert.equal(findGstreamer({ ENTRETELAS_GSTREAMER_DIR: 'D:\\gst\\bin' }, () => true), 'D:\\gst\\bin',
  'an explicit override wins, so a broken auto-detect never strands someone')
assert.equal(findGstreamer({}, () => false), null, 'no install must be reported, not guessed')
// Order matters: the override is consulted before anything found on disk.
assert.equal(findGstreamer({ ENTRETELAS_GSTREAMER_DIR: 'D:\\gst\\bin', LOCALAPPDATA: 'C:\\u' }, () => true), 'D:\\gst\\bin')

// --- the profile Chrome will actually accept ------------------------------
// AMF stamps plain baseline; Chrome answers that with a rejected m-line and gathers no candidates.
assert.equal(normalizeH264Profile('a=fmtp:97 packetization-mode=1;profile-level-id=420432'),
  'a=fmtp:97 packetization-mode=1;profile-level-id=42e01f')
assert.equal(normalizeH264Profile('profile-level-id=42E01F'), 'profile-level-id=42E01F',
  'an id already constrained is left exactly as it was, whatever its case')
for (const other of ['profile-level-id=4d0032', 'profile-level-id=640c1f']) {
  assert.equal(normalizeH264Profile(other), other, 'only baseline is rewritten; Main and High are not ours to claim')
}
assert.equal(normalizeH264Profile('m=video 9 UDP/TLS/RTP/SAVPF 97'), 'm=video 9 UDP/TLS/RTP/SAVPF 97')
for (const bad of [null, undefined, 42]) assert.equal(normalizeH264Profile(bad), bad)

// --- the pipeline ---------------------------------------------------------
const args = buildPipelineArgs({ endpoint: 'http://127.0.0.1:1/whip', monitorIndex: 1, fps: 30, bitrateKbps: 8000 })
const line = args.join(' ')
assert.ok(line.includes('whip-endpoint=http://127.0.0.1:1/whip'))
assert.ok(line.includes('monitor-index=1') && line.includes('framerate=30/1') && line.includes('bitrate=8000'))

// The frame must never leave the GPU: the converter has to sit between source and encoder, and the caps
// on both sides have to stay in D3D11 memory. Losing this is the whole regression this replaces.
assert.ok(line.includes('memory:D3D11Memory'), 'capture caps must stay in GPU memory')
assert.ok(args.indexOf('d3d11convert') < args.indexOf('amfh264enc'), 'colour conversion belongs before the encoder')
assert.ok(args.indexOf('d3d11convert') > args.indexOf('d3d11screencapturesrc'), 'and after the capture')

// whipclientsink wraps webrtcsink, which cannot take encoded input or D3D11 memory. Using it again would
// bring back "streaming stopped, reason not-negotiated" the moment a viewer attaches.
assert.ok(line.includes('whipsink') && !line.includes('whipclientsink'))
assert.ok(line.includes('cabac=false') && line.includes('b-frames=0'), 'constrained baseline forbids both')
assert.ok(line.includes('profile=constrained-baseline'))

// Defaults have to be the measured-good ones, since most launches pass nothing.
const defaults = buildPipelineArgs({ endpoint: 'http://x/whip' }).join(' ')
assert.ok(defaults.includes('framerate=60/1') && defaults.includes('bitrate=12000') && defaults.includes('monitor-index=0'))
// Nonsense must fall back rather than reach the command line, where it becomes an unreadable GStreamer error.
for (const bad of [{ fps: 0 }, { fps: -5 }, { fps: 1.5 }, { fps: null }]) {
  assert.ok(buildPipelineArgs({ endpoint: 'http://x/whip', ...bad }).join(' ').includes('framerate=60/1'))
}
assert.ok(buildPipelineArgs({ endpoint: 'http://x/whip', monitorIndex: -2 }).join(' ').includes('monitor-index=0'))
assert.throws(() => buildPipelineArgs({}), /endpoint is required/, 'a pipeline with nowhere to send is a bug, not a default')

// --- spawning -------------------------------------------------------------
let spawned = null
const fakeSpawn = (command, spawnArgs, options) => { spawned = { command, spawnArgs, options }; return { pid: 1 } }
assert.equal(startPipeline({ endpoint: 'http://x/whip' }, { env: {}, spawnFn: fakeSpawn, exists: () => false }), null,
  'without GStreamer the caller must be able to fall back, not receive a broken child')
assert.equal(spawned, null, 'nothing may be spawned when the install is missing')

startPipeline({ endpoint: 'http://x/whip' }, { env: { ENTRETELAS_GSTREAMER_DIR: 'D:\\gst\\bin', PATH: 'C:\\windows' }, spawnFn: fakeSpawn, exists: () => true })
assert.ok(spawned.command.endsWith('gst-launch-1.0.exe'))
assert.ok(spawned.command.startsWith('D:\\gst\\bin'))
// Without its own directory on PATH the plugin scanner finds no elements and the failure is silent.
assert.ok(spawned.options.env.PATH.startsWith('D:\\gst\\bin;'), 'the install directory must lead PATH')
assert.ok(spawned.options.env.PATH.includes('C:\\windows'), 'and the rest of PATH must survive')
assert.equal(spawned.options.windowsHide, true, 'no console window may flash over a live broadcast')

console.log('PASS: per-user install discovery, constrained-baseline rewriting, GPU-resident pipeline, sane defaults and missing-install fallback.')
