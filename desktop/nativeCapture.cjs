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

// The bundled copy comes first, so a packaged app never depends on what the machine happens to have.
// An explicit override still wins over both, for testing against a different build.
//
// Per-user is where the MSVC installer actually puts it; the machine-wide paths are what the docs show.
// Both stay as a fallback for running from source, where nothing has been bundled yet.
const GSTREAMER_CANDIDATES = (env, resourcesPath) => [
  env.ENTRETELAS_GSTREAMER_DIR,
  resourcesPath && path.join(resourcesPath, 'gstreamer', 'bin'),
  env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'gstreamer', '1.0', 'msvc_x86_64', 'bin'),
  env.GSTREAMER_1_0_ROOT_MSVC_X86_64 && path.join(env.GSTREAMER_1_0_ROOT_MSVC_X86_64, 'bin'),
  'C:\\gstreamer\\1.0\\msvc_x86_64\\bin',
].filter(Boolean)

function findGstreamer(env = process.env, exists = fs.existsSync, resourcesPath = process.resourcesPath) {
  for (const dir of GSTREAMER_CANDIDATES(env, resourcesPath)) {
    if (exists(path.join(dir, 'gst-launch-1.0.exe'))) return dir
  }
  return null
}

// A machine with its own GStreamer installed also has GST_* variables pointing at it, and inheriting
// those loads our plugins against someone else's core libraries -- the one failure here that is a real
// crash rather than a quiet fallback. So the child is given our paths and none of theirs.
//
// GST_PLUGIN_SYSTEM_PATH is set empty rather than removed: empty means "look nowhere else", while absent
// means "look in the built-in default", which is exactly the other installation.
function pipelineEnv(env, bin) {
  const clean = { ...env }
  for (const key of Object.keys(clean)) if (key.startsWith('GST_')) delete clean[key]
  return {
    ...clean,
    PATH: `${bin};${env.PATH || ''}`,
    GST_PLUGIN_PATH: path.join(path.dirname(bin), 'lib', 'gstreamer-1.0'),
    GST_PLUGIN_SYSTEM_PATH: '',
    // The plugin cache has to live somewhere writable, or every launch rescans hundreds of plugins --
    // and under Program Files it cannot be written at all.
    ...(env.ENTRETELAS_GST_REGISTRY ? { GST_REGISTRY: env.ENTRETELAS_GST_REGISTRY } : {}),
  }
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
    // With this install's own environment, exactly as the pipeline is launched. Without it the scanner
    // finds no elements at all and the answer is a confident no on a machine where it works -- which
    // silently dropped both per-application sound and the exclusion that stops a screen share sending
    // the friends being listened to their own voices back.
    const probe = run(path.join(bin, 'gst-inspect-1.0.exe'), ['wasapi2src'], { encoding: 'utf8', windowsHide: true, timeout: 10_000, env: pipelineEnv(process.env, bin) })
    processLoopback = typeof probe.stdout === 'string' && probe.stdout.includes('loopback-target-pid')
  } catch { processLoopback = false }
  return processLoopback
}

// Whichever encoder this machine actually has. The pipeline named amfh264enc outright, so on anything
// other than an AMD card gst-launch was handed an element that does not exist and died immediately --
// no offer, no preview, and a viewer waiting for a screen that was never coming.
//
// Only bitrate is set on the others. Its unit is kbit/s across all of them, while everything else --
// cabac, b-frames, presets -- is named differently per vendor, and a property that does not exist fails
// the whole pipeline exactly like a missing element does. The profile is steered by the caps filter
// instead, which every one of them understands.
const VIDEO_ENCODERS = [
  // AMD first where present: it is the one whose behaviour has been measured end to end here.
  { element: 'amfh264enc', args: (kbps) => [`bitrate=${kbps}`, 'cabac=false', 'b-frames=0'] },
  { element: 'nvd3d11h264enc', args: (kbps) => [`bitrate=${kbps}`] },
  { element: 'nvh264enc', args: (kbps) => [`bitrate=${kbps}`] },
  { element: 'qsvh264enc', args: (kbps) => [`bitrate=${kbps}`] },
  // Media Foundation is the floor: present on every supported Windows, hardware where the driver offers
  // it and software where it does not. Slower than nothing at all.
  { element: 'mfh264enc', args: (kbps) => [`bitrate=${kbps}`] },
]

let chosenEncoder = null
function pickVideoEncoder(bin, has = (element) => encoderWorks(bin, element)) {
  if (chosenEncoder !== null) return chosenEncoder
  chosenEncoder = VIDEO_ENCODERS.find(({ element }) => has(element)) || null
  return chosenEncoder
}

// Registered is not the same as usable, and the difference is what left somebody unable to broadcast at
// all: gst-inspect answered yes for nvh264enc on a machine whose NVENC could not be queried, so the
// pipeline was built around an encoder that then refused to link -- "could not link d3d11convert0 to
// nvh264enc0" -- with no attempt at the next one down the list.
//
// So the question asked is the one that matters: build the shape this app actually uses, one frame of
// it, and see whether it runs. An encoder that cannot be linked here cannot be linked in a broadcast.
function encoderWorks(bin, element, run = spawnSync) {
  try {
    const probe = run(path.join(bin, 'gst-launch-1.0.exe'), [
      'videotestsrc', 'num-buffers=1',
      '!', 'd3d11upload',
      '!', 'd3d11convert',
      '!', 'video/x-raw(memory:D3D11Memory),format=NV12,width=(int)[2,8192,2],height=(int)[2,8192,2]',
      '!', element,
      '!', 'fakesink',
    ], { encoding: 'utf8', windowsHide: true, timeout: 20_000, env: pipelineEnv(process.env, bin) })
    return probe.status === 0
  } catch { return false }
}

// The owning process of a window, so the sound of that one application can be captured and nothing
// else. Windows answers this through GetWindowThreadProcessId, which needs native code; PowerShell
// already has it, and this is asked once when a broadcast starts rather than per frame.
//
// Matching on MainWindowHandle is the limit of it: an application whose chosen window is not its main
// one comes back empty, and the caller then falls back to system sound rather than to silence.
function windowProcessId(handle, run = spawnSync) {
  if (!Number.isInteger(handle) || handle <= 0) return null
  try {
    const probe = run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `(Get-Process | Where-Object { $_.MainWindowHandle -eq ${handle} } | Select-Object -First 1 -ExpandProperty Id)`,
    ], { encoding: 'utf8', windowsHide: true, timeout: 8_000 })
    const pid = Number(String(probe.stdout ?? '').trim())
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch { return null }
}

// Which sound goes out, and it is not the same question in the two cases.
//
// Sharing one application: only that application, which is what the picker promises when somebody ticks
// the box next to a window. The picker said so and this path did not do it -- it sent the whole desktop,
// which sounds identical for as long as nothing else happens to be playing, and then does not.
//
// Sharing the whole screen: everything except this app. That exclusion is not a nicety -- without it the
// broadcast picks up the friends being listened to and sends them their own voices back.
const audioArgs = ({ excludePid, includePid, allowProcessLoopback }) => {
  const source = ['wasapi2src', 'loopback=true', 'low-latency=true']
  if (allowProcessLoopback && Number.isInteger(includePid) && includePid > 0) {
    source.push('loopback-mode=include-process-tree', `loopback-target-pid=${includePid}`)
  } else if (allowProcessLoopback && Number.isInteger(excludePid) && excludePid > 0) {
    source.push('loopback-mode=exclude-process-tree', `loopback-target-pid=${excludePid}`)
  }
  return [
    ...source,
    '!', 'audioconvert',
    '!', 'audioresample',
    '!', 'opusenc',
    '!', 'rtpopuspay', 'pt=97',
    '!', 'application/x-rtp,media=audio,encoding-name=OPUS,payload=97,clock-rate=48000,encoding-params=(string)2',
    '!', 'queue',
    '!', 'ws.',
  ]
}

// One encoder, one WHIP session. Phase 3 turns this into a tee feeding several sinks; the encoder
// settings below stay shared, which is the point -- today the app encodes once per viewer.
function buildPipelineArgs({
  endpoint, monitorIndex = 0, windowHandle = null, fps = 60, bitrateKbps = 12_000, showCursor = true,
  audio = false, excludePid = null, includePid = null, allowProcessLoopback = false,
  stunServer = null, turnServer = null, encoder = VIDEO_ENCODERS[0],
} = {}) {
  if (!endpoint) throw new Error('endpoint is required')
  return [
    '-e',
    // Named first so both branches can link into it. Sound and picture are separate sources at separate
    // rates, so each ends in its own queue: sharing one thread lets the slower branch stall the faster.
    //
    // Without a STUN server this gathers host candidates only -- private addresses that work on loopback
    // and are unreachable from anywhere else, so a viewer over the internet waits at "connecting" until
    // it gives up. TURN carries the networks where even that is not enough.
    'whipsink', 'name=ws', `whip-endpoint=${endpoint}`,
    ...(typeof stunServer === 'string' && /^stuns?:\/\//i.test(stunServer) ? [`stun-server=${stunServer}`] : []),
    ...(typeof turnServer === 'string' && /^turns?:\/\//i.test(turnServer) ? [`turn-server=${turnServer}`] : []),
    'd3d11screencapturesrc',
    ...sourceArgs({ windowHandle, monitorIndex }),
    `show-cursor=${showCursor ? 'true' : 'false'}`,
    '!', `video/x-raw(memory:D3D11Memory),framerate=${positiveInt(fps, 60)}/1`,
    // BGRA to NV12 on the GPU. Letting the encoder pull system memory here is the whole bug we are
    // avoiding, so this element must stay between the source and the encoder.
    '!', 'd3d11convert',
    // Even numbers, or nothing downstream works. A window is whatever size the person left it -- the one
    // this was found on reported 1282x721 -- and NV12 subsamples chroma two by two, so an odd height
    // cannot be represented at all. The convert failed, the error surfaced at the source as "Internal
    // data stream error", and window capture looked broken while full-screen capture was fine, because a
    // monitor is always even. The step of 2 in the range lets the scaler round to the nearest even size
    // rather than pinning a resolution, so a window resized mid-broadcast simply renegotiates.
    '!', 'video/x-raw(memory:D3D11Memory),format=NV12,width=(int)[2,8192,2],height=(int)[2,8192,2]',
    // cabac and b-frames off: constrained baseline forbids both, and B-frames add latency a live
    // broadcast cannot spend. Bitrate is fixed -- whipsink has no congestion control, and webrtcsink's
    // could not drive amfh264enc either ("Bitrate handling is not supported yet for amfh264enc").
    '!', encoder.element, ...encoder.args(positiveInt(bitrateKbps, 12_000)),
    '!', 'video/x-h264,profile=constrained-baseline',
    '!', 'h264parse', 'config-interval=-1',
    '!', 'rtph264pay', 'aggregate-mode=zero-latency', 'config-interval=-1', 'pt=96',
    '!', 'application/x-rtp,media=video,encoding-name=H264,payload=96,clock-rate=90000',
    '!', 'queue',
    // whipsink rather than whipclientsink: the latter wraps webrtcsink, whose codec discovery fails on
    // D3D11 memory and which rejects already-encoded input with "not-negotiated" once a viewer attaches.
    '!', 'ws.',
    ...(audio ? audioArgs({ excludePid, includePid, allowProcessLoopback }) : []),
  ]
}

function startPipeline(options = {}, { env = process.env, spawnFn = spawn, exists = fs.existsSync } = {}) {
  const bin = findGstreamer(env, exists)
  if (!bin) return null
  const encoder = pickVideoEncoder(bin)
  // Without an encoder there is no pipeline to build, and saying so lets the caller fall back to the
  // capture that always works rather than spawn something certain to die.
  if (!encoder) return null
  const args = buildPipelineArgs({
    ...options,
    encoder,
    allowProcessLoopback: options.audio ? supportsProcessLoopback(bin) : false,
  })
  const child = spawnFn(path.join(bin, 'gst-launch-1.0.exe'), args, {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    // The plugin scanner needs this install's own directory on PATH or it silently finds no elements.
    env: pipelineEnv(env, bin),
  })
  return child
}

module.exports = { findGstreamer, normalizeH264Profile, buildPipelineArgs, startPipeline, supportsProcessLoopback, pipelineEnv, pickVideoEncoder, encoderWorks, windowProcessId, VIDEO_ENCODERS }
