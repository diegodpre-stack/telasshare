import assert from 'node:assert/strict'
import { applySenderSettings, scaleForTarget } from '../src/senderSettings.js'

// Every factor has to land on even encoded dimensions, or Chromium drops the hardware encoder.
const encoded = (width, height, target) => {
  const scale = scaleForTarget(width, height, target)
  assert.ok(scale >= 1, `scaleResolutionDownBy below 1 is invalid: ${scale}`)
  return [Math.round(width / scale), Math.round(height / scale)]
}
const assertEven = (width, height, target) => {
  const [outWidth, outHeight] = encoded(width, height, target)
  assert.equal(outWidth % 2, 0, `odd width ${outWidth} from ${width}×${height} → ${target}`)
  assert.equal(outHeight % 2, 0, `odd height ${outHeight} from ${width}×${height} → ${target}`)
  return [outWidth, outHeight]
}

// The measured regression: 1440p asked for 1080p used to round to 1.33 and produce 1925×1083.
assert.deepEqual(assertEven(2560, 1440, 1080), [1920, 1080])
assert.deepEqual(assertEven(2560, 1440, 720), [1280, 720])
// The presets that already worked must not move: 1440p and auto stay at the capture size.
assert.equal(scaleForTarget(2560, 1440, 1440), 1)
assert.equal(scaleForTarget(2560, 1440, undefined), 1)
assert.equal(scaleForTarget(1920, 1080, 1440), 1, 'a capture below the target is never scaled up')
// Window capture, where an odd source arrives with no preset involved.
assertEven(1919, 1079, undefined)
assertEven(1919, 1079, 1080)
assertEven(1443, 817, 720)
for (const target of [undefined, 720, 1080, 1440]) {
  for (const [width, height] of [[2560, 1440], [1920, 1080], [3440, 1440], [1366, 768], [1919, 1079], [801, 601], [2, 2]]) {
    assertEven(width, height, target)
  }
}
// Degenerate sizes must not scale rather than divide by zero or loop.
for (const [width, height] of [[0, 0], [1, 1], [NaN, 1080], [1920, NaN]]) assert.equal(scaleForTarget(width, height, 1080), 1)
let applied
const sender = { getParameters: () => ({ encodings: [{}] }), setParameters: async (p) => { applied = p } }
await applySenderSettings(sender, { fps: 60, maxBitrate: 8_000_000 })
assert.equal(applied.encodings[0].maxFramerate, 60)
await applySenderSettings(sender, { fps: 30, maxBitrate: 2_500_000 })
assert.equal(applied.encodings[0].maxFramerate, 30)
assert.equal(applied.encodings[0].maxBitrate, 2_500_000)
let calls = 0
await applySenderSettings({ ...sender, setParameters: async (p) => { calls++; if (p.degradationPreference) throw Error('unsupported'); applied = p } }, { fps: 120, maxBitrate: 14_000_000 })
assert.equal(calls, 2)
assert.equal(applied.encodings[0].maxFramerate, 120)
assert.equal(await applySenderSettings({ getParameters: () => ({}) }, { fps: 30 }), false)
console.log('PASS: even encoded dimensions on every preset and odd capture, changed FPS/bitrate, unsupported preference fallback, pre-negotiation encodings.')
