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
  assert.equal(entry.turnTransport, mode === 'turn' ? 'udp' : 'direct')
  assert.equal([...timers.values()][0].delay, mode === 'auto' ? 8_000 : 30_000)
  assert.equal(timers.size, 1)
  entry.pc.iceConnectionState = 'connected'; entry.pc.oniceconnectionstatechange()
  assert.equal(timers.size, 0, 'success cancels fallback')
  entry.pc.iceConnectionState = 'failed'; entry.pc.oniceconnectionstatechange()
  assert.equal(timers.size, 1, 'a later failure re-arms recovery')
  assert.equal(entry.settled, false)
  await Promise.resolve(); await Promise.resolve()
  const [id, timer] = [...timers][0]; timers.delete(id); timer.fn()
  if (mode === 'p2p') assert.deepEqual(closed, ['test'])
  else {
    assert.equal(entry.turnTransport, mode === 'auto' ? 'udp' : 'all')
    assert.equal(entry.pc.config.iceTransportPolicy, mode === 'auto' ? 'all' : 'relay')
    assert.equal(timers.size, 1)
    entry.pc.iceConnectionState = 'connected'; entry.pc.oniceconnectionstatechange()
    assert.equal(timers.size, 0)
  }
}
console.log('PASS: initial UDP, success cancellation, post-success failure recovery, direct preservation and P2P isolation.')
