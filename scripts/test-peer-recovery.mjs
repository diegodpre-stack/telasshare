import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { buildIceConfiguration, initialIceStage } from '../src/icePolicy.js'

// Exercise the actual callback, with a deterministic clock and fake transport.
// Real browser configuration acceptance is covered by test-ice-reconfiguration.
const source = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')
const callback = source.slice(source.indexOf('  const createPeer ='), source.indexOf('  const startStats ='))
assert.ok(callback.includes('const advanceFallback'))
for (const mode of ['auto', 'turn', 'p2p']) {
  const timers = new Map(), sent = [], closed = []
  let sequence = 0
  class Peer {
    constructor(config) { this.config = config; this.iceConnectionState = 'new'; this.connectionState = 'new'; this.signalingState = 'stable'; this.remoteDescription = {} }
    getConfiguration() { return this.config }
    setConfiguration(config) { this.config = config }
    restartIce() {}
    async createOffer() { return { type: 'offer', sdp: 'test' } }
    async setLocalDescription(description) { this.localDescription = description }
  }
  const context = vm.createContext({
    RTCPeerConnection: Peer, buildIceConfiguration, initialIceStage,
    useCallback: fn => fn, iceServersRef: { current: [{ urls: ['stun:example.org', 'turn:example.org?transport=udp', 'turn:example.org?transport=tcp'], username: 'test', credential: 'test' }] },
    earlyCandidatesRef: { current: new Map() }, pcsRef: { current: new Map() },
    send: message => sent.push(message), closeConnection: id => closed.push(id), setNotice: () => {},
    setTimeout: (fn, delay) => { const id = ++sequence; timers.set(id, { fn, delay }); return id },
    clearTimeout: id => timers.delete(id),
  })
  vm.runInContext(`${callback}\nglobalThis.makePeer = createPeer`, context)
  const entry = context.makePeer('test', 'friend', 'transmitter', mode)
  assert.equal(entry.turnTransport, mode === 'p2p' ? 'direct' : 'udp')
  // Creating the peer must not start the clock: shareWith arms it once the offer is actually sent, so
  // the codec probe and offer building cannot eat the window ICE is supposed to get.
  assert.equal(timers.size, 0, 'the fallback clock must not start before the offer is on the wire')
  entry.armFallback()
  assert.equal([...timers.values()][0].delay, mode === 'p2p' ? 7_000 : 3_000)
  assert.equal(timers.size, 1)
  entry.armFallback()
  assert.equal(timers.size, 1, 'arming twice must not stack two fallback timers')
  entry.pc.iceConnectionState = 'connected'; entry.pc.oniceconnectionstatechange()
  assert.equal(timers.size, 0, 'success cancels fallback')
  entry.pc.iceConnectionState = 'failed'; entry.pc.oniceconnectionstatechange()
  assert.equal(timers.size, 1, 'a later failure re-arms recovery')
  assert.equal(entry.settled, false)
  await Promise.resolve(); await Promise.resolve()
  const [id, timer] = [...timers][0]; timers.delete(id); timer.fn()
  if (mode === 'p2p') assert.deepEqual(closed, ['test'])
  else {
    assert.equal(entry.turnTransport, 'all')
    assert.equal(entry.pc.config.iceTransportPolicy, mode === 'auto' ? 'all' : 'relay')
    assert.equal(timers.size, 1)
    assert.equal([...timers.values()][0].delay, 7_000)
    entry.pc.iceConnectionState = 'connected'; entry.pc.oniceconnectionstatechange()
    assert.equal(timers.size, 0)
  }
}
// Moving the clock out of createPeer only helps if shareWith still starts it. Nothing above can catch a
// refactor that drops the call, and a transmitter that never falls back would strand every viewer whose
// network needs the relay -- so assert on the source that arming follows the offer being sent.
const shareWith = source.slice(source.indexOf('  const shareWith = async'), source.indexOf('  const watch ='))
assert.ok(shareWith.includes('entry.armFallback()'), 'shareWith must arm the ICE fallback')
assert.ok(shareWith.indexOf('entry.armFallback()') > shareWith.indexOf("send({ type: 'signal'"),
  'the fallback clock must start after the offer is sent, never before')
console.log('PASS: fallback armed only once the offer is sent, initial UDP, success cancellation, post-success failure recovery, direct preservation and P2P isolation.')
