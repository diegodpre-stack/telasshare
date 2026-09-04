import assert from 'node:assert/strict'
import { selectIceServers, initialIceStage, buildIceConfiguration } from '../src/icePolicy.js'
const servers = [{ urls: ['stun:example.org:3478', 'turn:example.org:3478?transport=udp', 'turn:example.org:3478?transport=tcp', 'turns:example.org:443?transport=tcp'], username: 'test', credential: 'test-only' }]
assert.deepEqual(selectIceServers(servers, 'direct')[0].urls, ['stun:example.org:3478'])
assert.equal(selectIceServers(servers, 'udp')[0].urls.length, 2)
assert.equal(selectIceServers(servers, 'all')[0].urls.length, 4)
assert.equal(selectIceServers(servers, 'udp')[0].credential, 'test-only')
assert.equal(servers[0].urls.length, 4)
for (const mode of ['auto', 'turn', 'p2p']) {
  const config = buildIceConfiguration(servers, initialIceStage(mode), mode === 'turn')
  assert.equal(config.iceTransportPolicy, mode === 'turn' ? 'relay' : 'all')
  assert.equal(config.iceServers[0].urls.length, mode === 'p2p' ? 1 : 2)
  assert.ok(config.iceServers[0].urls.every(url => !url.includes('tcp')))
}
assert.equal(buildIceConfiguration(servers, 'all', false).iceTransportPolicy, 'all')
assert.equal(selectIceServers([{ urls: 'turns:example.org:443' }], 'udp').length, 0)
assert.equal(selectIceServers([{ urls: 'turn:example.org:3478' }], 'udp').length, 1)
console.log('ICE policy tests passed: direct/UDP/all, no TLS/TCP in UDP stage, credentials preserved.')
