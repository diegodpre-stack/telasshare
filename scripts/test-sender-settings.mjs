import assert from 'node:assert/strict'
import { applySenderSettings } from '../src/senderSettings.js'
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
console.log('PASS: changed FPS/bitrate, unsupported preference fallback, pre-negotiation encodings.')
