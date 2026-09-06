// Capture and encode without Chromium in the media path.
//
// Chromium reads every captured frame back into system memory and converts it to I420 on one thread
// before an encoder ever sees it. At 2560x1440 that is 14.7 MB a frame and about 23 ms of work, against
// a 16.6 ms budget at 60 FPS -- which is why the app's own capture tops out near 41 FPS. A GStreamer
// pipeline keeps the frame in D3D11 memory all the way into the GPU encoder; measured on an RX 9070,
// the same screen reached 60 FPS with zero dropped frames.
//
// No C++ here on purpose. whipsink speaks WHIP, which is plain HTTP, so Electron can be the endpoint it
// posts to and forward the SDP over the signalling socket the app already has. The "native helper" is
// gst-launch itself, spawned the way process-audio-capture already is.
const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

// Per-user is where the MSVC installer actually puts it; the machine-wide paths are what the docs show.
const GSTREAMER_CANDIDATES = (env) => [
  env.ENTRETELAS_GSTREAMER_DIR,
  env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'gstreamer', '1.0', 'msvc_x86_64', 'bin'),
  env.GSTREAMER_1_0_ROOT_MSVC_X86_64 && path.join(env.GSTREAMER_1_0_ROOT_MSVC_X86_64, 'bin'),
  'C:\\gstreamer\\1.0\\msvc_x86_64\\bin',
].filter(Boolean)

function findGstreamer(env = process.env, exists = fs.existsSync) {
  for (const dir of GSTREAMER_CANDIDATES(env)) {
    if (exists(path.join(dir, 'gst-launch-1.0.exe'))) return dir
  }
  return null
}

// Chrome only receives H.264 it recognises as constrained baseline -- profile_idc 0x42 with the
// constraint bits, so `42e0<level>`. AMF stamps its SPS as plain baseline (`4204<level>`) no matter what
// the caps ask for, and Chrome answers such an offer with an m-line of port 0, gathering no candidates
// at all: the whole session dies before any media flows.
//
// Rewriting the advertised id is sound for a stream carrying no CABAC and no B-frames, which is exactly
// what the pipeline configures: constrained baseline is a subset of what the encoder already produces,
// and level-asymmetry-allowed=1 means the level named here does not cap the real stream.
function normalizeH264Profile(sdp) {
  if (typeof sdp !== 'string') return sdp
  return sdp.replace(/profile-level-id=([0-9a-fA-F]{6})/g, (match, id) =>
    /^42/.test(id) && !/^42e0/i.test(id) ? 'profile-level-id=42e01f' : match)
}

const positiveInt = (value, fallback) => Number.isInteger(value) && value > 0 ? value : fallback

// A window is captured by its HWND, which needs the Windows Graphics Capture backend; a monitor is
// captured by index, where -1 means the primary one. Passing a handle wins, since someone who picked a
// window meant that window and not whatever screen it happens to sit on.
const sourceArgs = ({ windowHandle, monitorIndex }) => {
  if (Number.isInteger(windowHandle) && windowHandle > 0) return ['capture-api=wgc', `window-handle=${windowHandle}`]
  return [`monitor-index=${Number.isInteger(monitorIndex) && monitorIndex >= 0 ? monitorIndex : 0}`]
}

// Per-process loopback needs a recent enough Windows for WASAPI process capture. Where it is missing the
// property does not exist either, and gst-launch refuses the whole pipeline -- taking the picture down
// with the sound. Asked once and remembered, since the answer cannot change while the app runs.
let processLoopback = null
function supportsProcessLoopback(bin, run = spawnSync) {
  if (processLoopback !== null) return processLoopback
  try {
    const probe = run(path.join(bin, 'gst-inspect-1.0.exe'), ['wasapi2src'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 })
    processLoopback = typeof probe.stdout === 'string' && probe.stdout.includes('loopback-target-pid')
  } catch { processLoopback = false }
  return processLoopback
}

// System sound, minus the app itself. Without that exclusion the broadcast picks up the friends being
// listened to and sends them their own voices back; excluding this process tree keeps everything else --
// the game, the music -- and drops only what the app is playing.
const audioArgs = ({ excludePid, allowProcessLoopback }) => {
  const source = ['wasapi2src', 'loopback=true', 'low-latency=true']
  if (allowProcessLoopback && Number.isInteger(excludePid) && excludePid > 0) {
    source.push('loopback-mode=exclude-process-tree', `loopback-target-pid=${excludePid}`)
  }
  return [...source, '!', 'audioconvert', '!', 'audioresample', '!', 'opusenc', '!', 'tee', 'name=at']
}

// One encoded stream, packetised once per viewer. Payloading is per-branch because each RTP session
// needs its own sequence numbers and SSRC; the encoding above it is shared, which is the whole point --
// four viewers used to mean four captures and four encodes.
const videoBranch = (index) => [
  'vt.', '!', 'queue',
  '!', 'rtph264pay', 'aggregate-mode=zero-latency', 'config-interval=-1', 'pt=96',
  '!', 'application/x-rtp,media=video,encoding-name=H264,payload=96,clock-rate=90000',
  '!', `ws${index}.`,
]

const audioBranch = (index) => [
  'at.', '!', 'queue',
  '!', 'rtpopuspay', 'pt=97',
  '!', 'application/x-rtp,media=audio,encoding-name=OPUS,payload=97,clock-rate=48000,encoding-params=(string)2',
  '!', `ws${index}.`,
]

// One encoder, one WHIP session. Phase 3 turns this into a tee feeding several sinks; the encoder
// settings below stay shared, which is the point -- today the app encodes once per viewer.
function buildPipelineArgs({
  endpoint, endpoints, monitorIndex = 0, windowHandle = null, fps = 60, bitrateKbps = 12_000, showCursor = true,
  audio = false, excludePid = null, allowProcessLoopback = false,
  stunServer = null, turnServer = null,
} = {}) {
  const targets = (Array.isArray(endpoints) ? endpoints : [endpoint]).filter((value) => typeof value === 'string' && value)
  if (!targets.length) throw new Error('endpoint is required')
  const stun = typeof stunServer === 'string' && /^stuns?:\/\//i.test(stunServer) ? [`stun-server=${stunServer}`] : []
  const turn = typeof turnServer === 'string' && /^turns?:\/\//i.test(turnServer) ? [`turn-server=${turnServer}`] : []
  return [
    '-e',
    // One sink per viewer, all named up front so the branches below can find them. gst-launch builds a
    // fixed pipeline and cannot grow one later, so the seats exist from the start and each waits, its
    // offer held by the bridge, until somebody sits in it.
    //
    // Without a STUN server these gather host candidates only -- private addresses that work on loopback
    // and are unreachable from anywhere else, so a viewer over the internet waits at "connecting" until
    // it gives up. TURN carries the networks where even that is not enough.
    ...targets.flatMap((target, index) => ['whipsink', `name=ws${index}`, `whip-endpoint=${target}`, ...stun, ...turn]),
    'd3d11screencapturesrc',
    ...sourceArgs({ windowHandle, monitorIndex }),
    `show-cursor=${showCursor ? 'true' : 'false'}`,
    '!', `video/x-raw(memory:D3D11Memory),framerate=${positiveInt(fps, 60)}/1`,
    // BGRA to NV12 on the GPU. Letting the encoder pull system memory here is the whole bug we are
    // avoiding, so this element must stay between the source and the encoder.
    '!', 'd3d11convert',
    // cabac and b-frames off: constrained baseline forbids both, and B-frames add latency a live
    // broadcast cannot spend. Bitrate is fixed -- whipsink has no congestion control, and webrtcsink's
    // could not drive amfh264enc either ("Bitrate handling is not supported yet for amfh264enc").
    '!', 'amfh264enc', `bitrate=${positiveInt(bitrateKbps, 12_000)}`, 'cabac=false', 'b-frames=0',
    '!', 'video/x-h264,profile=constrained-baseline',
    '!', 'h264parse', 'config-interval=-1',
    // whipsink rather than whipclientsink: the latter wraps webrtcsink, whose codec discovery fails on
    // D3D11 memory and which rejects already-encoded input with "not-negotiated" once a viewer attaches.
    // The cost of that choice is this tee, since whipsink serves one viewer where webrtcsink serves many.
    '!', 'tee', 'name=vt',
    ...targets.flatMap((_target, index) => videoBranch(index)),
    ...(audio ? [
      ...audioArgs({ excludePid, allowProcessLoopback }),
      ...targets.flatMap((_target, index) => audioBranch(index)),
    ] : []),
  ]
}

function startPipeline(options = {}, { env = process.env, spawnFn = spawn, exists = fs.existsSync } = {}) {
  const bin = findGstreamer(env, exists)
  if (!bin) return null
  const args = buildPipelineArgs({
    ...options,
    allowProcessLoopback: options.audio ? supportsProcessLoopback(bin) : false,
  })
  const child = spawnFn(path.join(bin, 'gst-launch-1.0.exe'), args, {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    // The plugin scanner needs the install's own directory on PATH or it silently finds no elements.
    env: { ...env, PATH: `${bin};${env.PATH || ''}` },
  })
  return child
}

module.exports = { findGstreamer, normalizeH264Profile, buildPipelineArgs, startPipeline, supportsProcessLoopback }
