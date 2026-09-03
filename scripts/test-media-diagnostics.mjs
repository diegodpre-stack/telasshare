import assert from 'node:assert/strict'
import { summarizeStats } from '../src/mediaDiagnostics.js'
const make = (timestamp, framesEncoded, bytesSent, totalEncodeTime) => new Map([
  ['transport', { type: 'transport', selectedCandidatePairId: 'pair' }],
  ['pair', { localCandidateId: 'local', remoteCandidateId: 'remote', currentRoundTripTime: .02, availableOutgoingBitrate: 4e6 }],
  ['local', { candidateType: 'relay', protocol: 'udp', relayProtocol: 'tls', address: 'SECRET-IP', url: 'SECRET-URL' }],
  ['video', { id: 'video', type: 'outbound-rtp', kind: 'video', timestamp, framesEncoded, bytesSent, totalEncodeTime, frameWidth: 1280, frameHeight: 720, qualityLimitationReason: 'bandwidth' }],
])
const first = summarizeStats(make(1000, 10, 1000, .1))
assert.equal(first.rows[0].mbps, null)
const second = summarizeStats(make(3000, 70, 201000, .22), first.next)
assert.equal(second.rows[0].fps, 30)
assert.equal(second.rows[0].mbps, .8)
assert.equal(second.rows[0].frameProcessingMs, 2)
assert.equal(second.rows[0].route, 'TURN')
assert.equal(second.rows[0].localRelayProtocol, 'tls')
assert.equal(second.rows[0].rttMs, 20)
assert.equal(second.rows[0].width, 1280)
assert.ok(!JSON.stringify(second.rows).includes('SECRET'))
const reset = summarizeStats(make(4000, 1, 100, .01), second.next)
assert.equal(reset.rows[0].mbps, null)
assert.equal(reset.rows[0].frameProcessingMs, null)
assert.deepEqual(summarizeStats(new Map()).rows, [])
console.log('Diagnostics tests passed: interval deltas, counter reset, unavailable values, transport and privacy.')
