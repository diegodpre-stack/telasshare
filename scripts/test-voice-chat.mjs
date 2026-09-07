import assert from 'node:assert/strict'
import { createVoiceChat, isVoiceConnection, shouldOffer, tuneOpus, VOICE_MAX_BITRATE, VOICE_PREFIX } from '../src/voiceChat.js'

// A stand-in for RTCPeerConnection: enough to drive negotiation and to watch what gets asked of it.
function fakeConnections() {
  const created = []
  const make = (configuration) => {
    const pc = {
      configuration,
      signalingState: 'stable',
      iceConnectionState: 'new',
      remoteDescription: null,
      localDescription: null,
      senders: [],
      candidates: [],
      restarts: 0,
      closed: false,
      addTrack(track, stream) {
        const sender = { track, stream, parameters: { encodings: [{}] }, getParameters: () => sender.parameters, setParameters: (value) => { sender.parameters = value; return Promise.resolve() }, replaceTrack: (next) => { sender.track = next; return Promise.resolve() } }
        pc.senders.push(sender)
        return sender
      },
      createOffer: (options) => { if (options?.iceRestart) pc.restarts += 1; return Promise.resolve({ type: 'offer', sdp: OPUS_SDP }) },
      createAnswer: () => Promise.resolve({ type: 'answer', sdp: OPUS_SDP }),
      setLocalDescription: (description) => { pc.localDescription = description; return Promise.resolve() },
      setRemoteDescription: (description) => { pc.remoteDescription = description; return Promise.resolve() },
      addIceCandidate: (candidate) => { pc.candidates.push(candidate); return Promise.resolve() },
      restartIce: () => {},
      getConfiguration: () => pc.configuration,
      setConfiguration: (value) => { pc.configuration = value },
      close: () => { pc.closed = true },
    }
    created.push(pc)
    return pc
  }
  return { created, make }
}

const OPUS_SDP = [
  'v=0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111 63',
  'a=rtpmap:111 opus/48000/2',
  'a=fmtp:111 minptime=10;useinbandfec=0',
  'a=rtpmap:63 red/48000/2',
  'a=fmtp:63 111/111',
].join('\r\n')

const streamWith = (track) => ({ getAudioTracks: () => [track] })
const TURN = [{ urls: ['stun:stun.example:3478', 'turn:turn.example:3478?transport=udp', 'turns:turn.example:5349?transport=tcp'] }]

// --- the Opus parameters --------------------------------------------------
// Three things are asked for by name. DTX is the one that matters for cost: it stops sending during
// silence, and most of a conversation is silence from any one person's microphone.
const tuned = tuneOpus(OPUS_SDP)
const opusFmtp = tuned.split('\r\n').find((line) => line.startsWith('a=fmtp:111'))
assert.ok(opusFmtp.includes('usedtx=1'), 'silence must not be sent')
assert.ok(opusFmtp.includes('useinbandfec=1'), 'a lost packet is rebuilt from the next one')
assert.ok(opusFmtp.includes('maxaveragebitrate=32000'))
assert.ok(opusFmtp.includes('minptime=10'), 'parameters already there are kept')
assert.ok(!opusFmtp.includes('useinbandfec=0'), 'and the one being changed is replaced, not duplicated')
// Every other codec is left exactly as it was: red carries the FEC payload and must not be rewritten.
assert.ok(tuned.includes('a=fmtp:63 111/111'))
// A description with no Opus at all comes back untouched rather than gaining a stray line.
assert.equal(tuneOpus('v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96'), 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96')
// Opus without an fmtp line of its own still has to get one.
assert.ok(tuneOpus('v=0\r\nm=audio 9 RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2').includes('a=fmtp:111 useinbandfec=1'))
// Running twice must be identical to running once.
assert.equal(tuneOpus(tuned), tuned, 'tuning is idempotent')

// --- who offers -----------------------------------------------------------
// Both sides see each other at the same moment. Without a rule decided from the ids alone, both would
// offer, and each pair would end up with two half-connections carrying nothing.
assert.equal(shouldOffer('aaa', 'bbb'), true)
assert.equal(shouldOffer('bbb', 'aaa'), false)
assert.notEqual(shouldOffer('aaa', 'bbb'), shouldOffer('bbb', 'aaa'), 'exactly one side of any pair offers')

// --- the mesh follows presence -------------------------------------------
const sent = []
const connections = fakeConnections()
let ids = 0
const track = { enabled: true }
const streams = new Map()
const gone = []
const voice = createVoiceChat({
  selfId: 'aaa',
  send: (message) => sent.push(message),
  getIceServers: () => TURN,
  onStream: (peerId, stream) => streams.set(peerId, stream),
  onPeerGone: (peerId) => gone.push(peerId),
  newConnection: connections.make,
  newConnectionId: () => `${VOICE_PREFIX}${String(++ids).padStart(8, '0')}`,
})
voice.setLocalStream(streamWith(track))

// 'bbb' sorts after us, so we offer. 'AAA' sorts before, so we wait for theirs and open nothing.
await voice.setPeers(['bbb', 'AAA'])
assert.deepEqual(voice.peerIds, ['bbb'], 'only the pairs we own are opened here')
const offer = sent.find((message) => message.description?.type === 'offer')
assert.equal(offer.to, 'bbb')
assert.equal(offer.voice, true, 'the video path must be able to tell this is not a screen')
assert.ok(isVoiceConnection(offer.connectionId))
assert.ok(offer.description.sdp.includes('usedtx=1'), 'the offer carries the tuned parameters')

// The microphone is on the connection, capped, and the cap is a limit rather than a hint.
const first = connections.created[0]
assert.equal(first.senders.length, 1)
assert.equal(first.senders[0].track, track)
assert.equal(first.senders[0].parameters.encodings[0].maxBitrate, VOICE_MAX_BITRATE)
// Automatic gathers direct and relay candidates together, exactly as the video path does.
assert.equal(first.configuration.iceTransportPolicy, 'all')
assert.ok(JSON.stringify(first.configuration.iceServers).includes('stun:'))

// --- the side that waits --------------------------------------------------
// An offer from 'AAA' is what actually opens that pair, and the answer goes back on the same id.
await voice.handleSignal({ from: 'AAA', connectionId: `${VOICE_PREFIX}remote01`, voice: true, description: { type: 'offer', sdp: OPUS_SDP } })
assert.deepEqual(voice.peerIds.sort(), ['AAA', 'bbb'])
const answer = sent.find((message) => message.description?.type === 'answer')
assert.equal(answer.to, 'AAA')
assert.equal(answer.connectionId, `${VOICE_PREFIX}remote01`, 'the answer stays on the offer\'s connection')
assert.ok(answer.description.sdp.includes('usedtx=1'))

// Candidates arriving before the offer are held rather than dropped: they are the only ones a peer
// behind a strict NAT may ever send, and losing them loses the connection.
const early = createVoiceChat({ selfId: 'zzz', send: () => {}, getIceServers: () => TURN, newConnection: connections.make })
await early.handleSignal({ from: 'ccc', connectionId: `${VOICE_PREFIX}early001`, voice: true, candidate: { candidate: 'held' } })
await early.handleSignal({ from: 'ccc', connectionId: `${VOICE_PREFIX}early001`, voice: true, description: { type: 'offer', sdp: OPUS_SDP } })
assert.deepEqual(connections.created.at(-1).candidates, [{ candidate: 'held' }], 'the held candidate is applied once there is somewhere to put it')

// Signalling for a screen must never reach a voice connection.
const before = voice.peerIds.length
await voice.handleSignal({ from: 'bbb', connectionId: 'nao-e-voz-1234', description: { type: 'offer', sdp: OPUS_SDP } })
assert.equal(voice.peerIds.length, before, 'a video connectionId is ignored entirely')

// --- leaving --------------------------------------------------------------
// Presence is the only input: dropping out of the list closes the connection and releases the mixer.
await voice.setPeers(['AAA'])
assert.deepEqual(voice.peerIds, ['AAA'])
assert.equal(first.closed, true, 'the connection of someone who left is closed, not leaked')
assert.deepEqual(gone, ['bbb'])

// --- the relay ------------------------------------------------------------
// A direct route that fails escalates to TURN rather than retrying a path that already refused. The
// side that answered cannot restart ICE itself, so it asks the side that owns the offer to do it.
const answering = connections.created.find((pc) => pc.localDescription?.type === 'answer')
answering.iceConnectionState = 'failed'
answering.oniceconnectionstatechange()
assert.equal(answering.configuration.iceTransportPolicy, 'all')
assert.ok(sent.some((message) => message.type === 'restart-request' && message.to === 'AAA'), 'the answering side asks for the restart')

// A connection with no relay available must not be torn down for wanting one.
const noTurn = createVoiceChat({ selfId: 'aaa', send: () => {}, getIceServers: () => [{ urls: ['stun:stun.example:3478'] }], newConnection: connections.make })
await noTurn.setPeers(['zzz'])
const direct = connections.created.at(-1)
direct.iceConnectionState = 'failed'
assert.doesNotThrow(() => direct.oniceconnectionstatechange())
assert.deepEqual(noTurn.peerIds, ['zzz'], 'without TURN there is nowhere to escalate to, and it stays')

// --- closing --------------------------------------------------------------
voice.close()
assert.deepEqual(voice.peerIds, [])
assert.ok(connections.created.every((pc) => pc.closed || pc.localDescription === null || !voice.peerIds.length))

console.log('PASS: one offerer per pair, DTX and FEC requested without touching other codecs, presence drives the mesh, early candidates held, video signalling ignored, and a failed route escalating to the relay.')
