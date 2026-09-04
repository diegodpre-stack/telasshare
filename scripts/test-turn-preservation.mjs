import assert from 'node:assert/strict'
import { canPreserveWithoutTurn } from '../src/icePolicy.js'
const peer = (local, remote, relayConfig = true) => ({
  getConfiguration: () => ({ iceTransportPolicy: 'all', iceServers: [{ urls: relayConfig ? 'turn:example.org' : 'stun:example.org' }] }),
  getStats: async () => new Map(local ? [
    ['transport', { type: 'transport', selectedCandidatePairId: 'pair' }],
    ['pair', { state: 'succeeded', localCandidateId: 'local', remoteCandidateId: 'remote' }],
    ['local', { candidateType: local }], ['remote', { candidateType: remote }],
  ] : []),
})
assert.equal(await canPreserveWithoutTurn(peer('host', 'srflx')), true)
assert.equal(await canPreserveWithoutTurn(peer('relay', 'host')), false)
assert.equal(await canPreserveWithoutTurn(peer('host', 'relay', false)), false)
assert.equal(await canPreserveWithoutTurn(peer(null, null)), false)
assert.equal(await canPreserveWithoutTurn(peer(null, null, false)), true)
assert.equal(await canPreserveWithoutTurn(peer('host', undefined)), false)
console.log('PASS: preserve direct peers, reject either relay leg and unknown relay routes.')
