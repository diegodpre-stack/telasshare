import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { selectIceServers, initialIceStage, buildIceConfiguration, routeFromPair } from '../src/icePolicy.js'
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
assert.deepEqual(selectIceServers([{ urls: ['stun:stun.cloudflare.com:53', 'turn:turn.cloudflare.com:53?transport=udp', 'turn:turn.cloudflare.com:3478?transport=udp'] }], 'udp')[0].urls, ['turn:turn.cloudflare.com:3478?transport=udp'])

// --- what the badge is allowed to claim -----------------------------------
// Either end being a relay means the picture is relayed, whichever end it is.
assert.equal(routeFromPair({ candidateType: 'relay' }, { candidateType: 'host' }), 'turn')
assert.equal(routeFromPair({ candidateType: 'host' }, { candidateType: 'relay' }), 'turn')
assert.equal(routeFromPair({ candidateType: 'relay' }, { candidateType: 'relay' }), 'turn')
// Direct is direct, however it was found.
assert.equal(routeFromPair({ candidateType: 'host' }, { candidateType: 'host' }), 'p2p')
assert.equal(routeFromPair({ candidateType: 'srflx' }, { candidateType: 'prflx' }), 'p2p')
// A relay at one end settles it even when the other end never reported: the picture is going through
// the relay to get there, whatever is on the far side.
assert.equal(routeFromPair({ candidateType: 'relay' }, null), 'turn')
assert.equal(routeFromPair(undefined, { candidateType: 'relay' }), 'turn')
// But calling something direct is a claim about both ends, so it takes both. Everything short of that
// is null, never 'p2p' -- the assertion that matters here, because the old expression turned every one
// of these into a confident "P2P" on somebody's screen.
for (const [local, remote] of [
  [null, { candidateType: 'host' }], [{ candidateType: 'host' }, null], [null, null],
  [undefined, undefined], [{}, {}], [{ candidateType: '' }, { candidateType: 'host' }],
  [{ protocol: 'udp' }, { protocol: 'udp' }],
]) assert.equal(routeFromPair(local, remote), null, 'not knowing is not the same as direct')

// --- the mode the viewer asked for has to survive the native path ---------
// The pipeline is the sender and gathers its own candidates, so the only thing that can hold a viewer
// to TURN is what the offer announces. Sending a fixed 'auto' there quietly discarded the choice, and
// nothing in the page looked wrong afterwards -- the badge said P2P and was telling the truth.
const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')
const offer = app.slice(app.indexOf('onOffer:'), app.indexOf('onCandidate:'))
assert.ok(offer.includes('nativeSender: true'), 'found the native offer')
assert.ok(!/mode: 'auto'/.test(offer), 'the native offer must not hardcode a mode')
assert.ok(/mode: viewer\.mode/.test(offer), 'it carries what the viewer asked for')

console.log('ICE policy tests passed: direct/UDP/all, no TLS/TCP in UDP stage, credentials preserved; a route is only called direct when both ends say so, and the native offer carries the mode the viewer chose.')
