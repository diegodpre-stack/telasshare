import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const { findGstreamer, normalizeH264Profile, buildPipelineArgs, startPipeline, supportsProcessLoopback } =
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

// --- choosing what to capture ---------------------------------------------
// A window is addressed by HWND and needs the Windows Graphics Capture backend; without that flag the
// handle is ignored and the whole primary screen goes out instead, which is a privacy failure, not a
// cosmetic one.
const windowArgs = buildPipelineArgs({ endpoint: 'http://x/whip', windowHandle: 12345, monitorIndex: 2 }).join(' ')
assert.ok(windowArgs.includes('window-handle=12345'))
assert.ok(windowArgs.includes('capture-api=wgc'))
assert.ok(!windowArgs.includes('monitor-index'), 'a chosen window must win over any monitor also passed')

const monitorArgs = buildPipelineArgs({ endpoint: 'http://x/whip', monitorIndex: 2 }).join(' ')
assert.ok(monitorArgs.includes('monitor-index=2') && !monitorArgs.includes('window-handle'))
// A handle that is not one must fall back to a monitor rather than reach the command line.
for (const bad of [0, -1, null, 'abc', 1.5]) {
  const args = buildPipelineArgs({ endpoint: 'http://x/whip', windowHandle: bad, monitorIndex: 1 }).join(' ')
  assert.ok(args.includes('monitor-index=1') && !args.includes('window-handle'), `bad handle ${bad} must not be used`)
}

// --- sound ----------------------------------------------------------------
// Silence is the default: a broadcast that quietly carried the whole desktop's audio because nobody
// said otherwise would be a privacy failure.
assert.ok(!buildPipelineArgs({ endpoint: 'http://x/whip' }).join(' ').includes('wasapi2src'))

const withAudio = buildPipelineArgs({ endpoint: 'http://x/whip', audio: true }).join(' ')
assert.ok(withAudio.includes('wasapi2src') && withAudio.includes('loopback=true'))
assert.ok(withAudio.includes('opusenc') && withAudio.includes('rtpopuspay'))
// Browsers need Opus at 48k stereo, and the payload type must not collide with the video's.
assert.ok(withAudio.includes('encoding-name=OPUS') && withAudio.includes('clock-rate=48000'))
assert.ok(withAudio.includes('payload=97') && withAudio.includes('payload=96'))
// Both branches link into one named sink, each through its own queue: sharing a thread lets the slower
// branch stall the faster, which on a live broadcast is a stutter in whichever loses.
assert.equal((withAudio.match(/! ws\./g) || []).length, 2, 'sound and picture must both reach the sink')
assert.equal((withAudio.match(/queue/g) || []).length, 2, 'each branch needs its own queue')
assert.ok(withAudio.includes('whipsink name=ws'), 'the sink has to be named for either branch to find it')

// Excluding this app keeps the friends being listened to out of what is sent back to them.
const excluded = buildPipelineArgs({ endpoint: 'http://x/whip', audio: true, excludePid: 4321, allowProcessLoopback: true }).join(' ')
assert.ok(excluded.includes('loopback-mode=exclude-process-tree') && excluded.includes('loopback-target-pid=4321'))
// Where per-process loopback is unavailable the property does not exist and gst-launch refuses the whole
// pipeline, so sound must fall back to the whole system rather than take the picture down with it.
const noProcessLoopback = buildPipelineArgs({ endpoint: 'http://x/whip', audio: true, excludePid: 4321, allowProcessLoopback: false }).join(' ')
assert.ok(noProcessLoopback.includes('wasapi2src') && !noProcessLoopback.includes('loopback-target-pid'))
for (const bad of [0, -1, null, 'x']) {
  const args = buildPipelineArgs({ endpoint: 'http://x/whip', audio: true, excludePid: bad, allowProcessLoopback: true }).join(' ')
  assert.ok(!args.includes('loopback-target-pid'), `a pid of ${bad} must not reach the command line`)
}

// The probe reads gst-inspect once and remembers, since the answer cannot change while the app runs.
let probes = 0
const answer = (stdout) => () => { probes += 1; return { stdout } }
assert.equal(supportsProcessLoopback('D:\gst\bin', answer('loopback-target-pid : Process ID')), true)
assert.equal(supportsProcessLoopback('D:\gst\bin', answer('')), true, 'the answer is cached, not asked again')
assert.equal(probes, 1)

// --- reachable candidates -------------------------------------------------
// Host candidates alone are private addresses: fine on loopback, unreachable from anywhere else, so a
// viewer over the internet waits at "connecting" until it gives up.
const noIce = buildPipelineArgs({ endpoint: 'http://x/whip' }).join(' ')
assert.ok(!noIce.includes('stun-server') && !noIce.includes('turn-server'))

const withIce = buildPipelineArgs({
  endpoint: 'http://x/whip',
  stunServer: 'stun://stun.example:3478',
  turnServer: 'turn://user:pass@relay.example:3478',
}).join(' ')
assert.ok(withIce.includes('stun-server=stun://stun.example:3478'))
assert.ok(withIce.includes('turn-server=turn://user:pass@relay.example:3478'))

// A malformed value would make gst-launch refuse the pipeline, taking the whole broadcast with it, so
// anything not in URL form is left out rather than passed along.
for (const bad of ['stun.example:3478', 'stun:stun.example:3478', '', null, 42, 'http://x']) {
  const args = buildPipelineArgs({ endpoint: 'http://x/whip', stunServer: bad, turnServer: bad }).join(' ')
  assert.ok(!args.includes('stun-server') && !args.includes('turn-server'), `${bad} must not reach the command line`)
}

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

console.log('PASS: per-user install discovery, constrained-baseline rewriting, GPU-resident pipeline, window and monitor selection, system sound with the app excluded, reachable ICE, sane defaults and missing-install fallback.')
