import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createMediaEventLog, mediaEvents, recordPeerFailure } from '../src/mediaEvents.js'
const {
  mediaFeaturePolicy, createMediaRuntimeLog,
  readZeroCopyState, recordZeroCopyFailure, clearZeroCopyFailures, ZERO_COPY_CRASH_LIMIT,
} = createRequire(import.meta.url)('../desktop/mediaRuntime.cjs')

const defaults = mediaFeaturePolicy({})
assert.equal(defaults.zeroCopyCapture, true, 'the readback capture path is the one that costs frames')
assert.equal(defaults.zeroCopyDisabledByCrashes, false)
assert.equal(defaults.lowResolutionHardware, true, 'the capture path must not disable hardware encoding')
assert.ok(defaults.enabledFeatures.includes('ZeroCopyDesktopCapture'))
assert.ok(!defaults.disabledFeatures.includes('ZeroCopyDesktopCapture'))
assert.ok(defaults.disabledFeatures.includes('ForceSoftwareForRtcLowResolutions'))
assert.ok(defaults.disabledFeatures.includes('WebRtcHideLocalIpsWithMdns'))
assert.ok(!defaults.disabledFeatures.some((name) => /encoder|decod/i.test(name)))
const forced = mediaFeaturePolicy({ ENTRETELAS_GPU_CAPTURE: '1' })
assert.equal(forced.zeroCopyCapture, true)
assert.ok(forced.enabledFeatures.includes('ZeroCopyDesktopCapture'))
const legacy = mediaFeaturePolicy({ ENTRETELAS_GPU_CAPTURE: '0' })
assert.equal(legacy.lowResolutionHardware, false)
assert.equal(legacy.zeroCopyCapture, false)
assert.equal(legacy.zeroCopyDisabledByCrashes, false, 'an explicit opt-out is not a crash fallback')
assert.ok(legacy.disabledFeatures.includes('ZeroCopyDesktopCapture'))
assert.ok(!legacy.disabledFeatures.includes('ForceSoftwareForRtcLowResolutions'))

// The fallback: enough GPU deaths under zero-copy and the app returns to the safe path by itself,
// while an explicit 1 still overrides that history for someone whose driver has since been fixed.
const belowLimit = mediaFeaturePolicy({}, { zeroCopyCrashes: ZERO_COPY_CRASH_LIMIT - 1 })
assert.equal(belowLimit.zeroCopyCapture, true, 'one crash can be a fluke')
const atLimit = mediaFeaturePolicy({}, { zeroCopyCrashes: ZERO_COPY_CRASH_LIMIT })
assert.equal(atLimit.zeroCopyCapture, false)
assert.equal(atLimit.zeroCopyDisabledByCrashes, true)
assert.ok(atLimit.disabledFeatures.includes('ZeroCopyDesktopCapture'))
assert.equal(atLimit.lowResolutionHardware, true, 'falling back on capture must not touch encoding')
const retried = mediaFeaturePolicy({ ENTRETELAS_GPU_CAPTURE: '1' }, { zeroCopyCrashes: 99 })
assert.equal(retried.zeroCopyCapture, true)
assert.equal(retried.zeroCopyDisabledByCrashes, false)

// Anything that is not a plain non-negative integer is a machine with no usable history.
assert.equal(readZeroCopyState('{"zeroCopyCrashes":3}').zeroCopyCrashes, 3)
for (const bad of ['', 'not json', '{"zeroCopyCrashes":-1}', '{"zeroCopyCrashes":1.5}', '{"zeroCopyCrashes":"3"}', 'null', null, undefined]) {
  assert.equal(readZeroCopyState(bad).zeroCopyCrashes, 0, `unusable state must read as no history: ${JSON.stringify(bad)}`)
}

const onPolicy = mediaFeaturePolicy({})
assert.equal(recordZeroCopyFailure({ zeroCopyCrashes: 1 }, { reason: 'crashed' }, onPolicy).zeroCopyCrashes, 2)
assert.equal(recordZeroCopyFailure({}, { reason: 'oom' }, onPolicy).zeroCopyCrashes, 1)
assert.equal(recordZeroCopyFailure('corrupt', { reason: 'launch-failed' }, onPolicy).zeroCopyCrashes, 1)
for (const reason of ['clean-exit', 'killed', 'memory-eviction', 'unknown', undefined]) {
  assert.equal(recordZeroCopyFailure({ zeroCopyCrashes: 1 }, { reason }, onPolicy), null, `${reason} does not accuse the capture path`)
}
assert.equal(recordZeroCopyFailure({ zeroCopyCrashes: 1 }, { reason: 'crashed' }, legacy), null, 'a run without zero-copy cannot blame it')
assert.equal(clearZeroCopyFailures({ zeroCopyCrashes: 2 }).zeroCopyCrashes, 0)
assert.equal(clearZeroCopyFailures({ zeroCopyCrashes: 0 }), null, 'nothing to clear means nothing to write')

const runtime = createMediaRuntimeLog(defaults, { electron: '44.1.1', chrome: '152.0.7977.65' })
runtime.record('gpu-process-gone', { reason: 'crashed', exitCode: -1, pid: 123, name: 'SECRET', path: 'SECRET' })
assert.equal(runtime.snapshot().events[0].reason, 'crashed')
assert.equal(runtime.snapshot().events[0].exitCode, -1)
assert.ok(!JSON.stringify(runtime.snapshot()).includes('SECRET'))
runtime.snapshot().events[0].reason = 'modified'
assert.equal(runtime.snapshot().events[0].reason, 'crashed', 'snapshots must not mutate history')
for (let i = 0; i < 25; i++) runtime.record('gpu-process-gone', { reason: 'killed', exitCode: i })
assert.equal(runtime.snapshot().events.length, 20)
assert.equal(runtime.snapshot().events.at(-1).exitCode, 24)

const events = createMediaEventLog(3)
events.record('capture-ended', { readyState: 'ended', width: 1920, height: 1080, label: 'SECRET', deviceId: 'SECRET', sdp: 'SECRET', message: 'SECRET' })
assert.equal(events.read()[0].readyState, 'ended')
assert.equal(events.read()[0].width, 1920)
assert.ok(!JSON.stringify(events.read()).includes('SECRET'))
events.read()[0].readyState = 'modified'
assert.equal(events.read()[0].readyState, 'ended')
for (let i = 0; i < 5; i++) events.record('test', { width: i })
assert.equal(events.read().length, 3)
assert.equal(events.read().at(-1).width, 4)
recordPeerFailure('set-remote-description', { name: 'RTCError', errorDetail: 'sdp-syntax-error', sdpLineNumber: 4, message: 'SECRET SDP' }, { signalingState: 'have-local-offer', iceConnectionState: 'new', connectionState: 'new' })
assert.equal(mediaEvents.read().at(-1).phase, 'set-remote-description')
assert.equal(mediaEvents.read().at(-1).sdpLineNumber, 4)
assert.ok(!JSON.stringify(mediaEvents.read()).includes('SECRET'))
console.log('PASS: independent hardware/capture policy, zero-copy on by default with a self-correcting crash fallback, bounded native/renderer failure logs and private-field exclusion.')
