// The voice mesh: one audio-only connection to each person who is also in voice.
//
// Why its own connections rather than the ones the screen already uses. Those exist only while somebody
// is watching a screen, and voice has to work when nobody is broadcasting at all. And on the native path
// there is no connection here to add a track to -- it lives inside the GStreamer process, which has no
// access to a microphone the browser opened. Nothing about the video path is touched by any of this.
//
// The route is decided exactly as video decides it: the same ICE servers, direct first, then the relay.
import { buildIceConfiguration, initialIceStage } from './icePolicy.js'

// Opus picks its own bitrate, and voice does not need much. Two more things are worth asking for by
// name: in-band FEC, which rebuilds a lost packet from the next one instead of leaving a gap, and DTX,
// which stops sending during silence -- the single largest saving there is, since most of a conversation
// is one person talking and everyone else quiet.
export const VOICE_BITRATE = 32_000
// A ceiling on the sender as well: fmtp is a request to the encoder, this is a limit on the connection.
export const VOICE_MAX_BITRATE = 48_000
// Voice connections share the signalling channel with video, so they have to be told apart on arrival.
// The prefix travels inside the connectionId, which every relayed message already carries.
export const VOICE_PREFIX = 'voz-'
export const isVoiceConnection = (id) => typeof id === 'string' && id.startsWith(VOICE_PREFIX)

const OPUS_PARAMETERS = { useinbandfec: '1', usedtx: '1', stereo: '0', maxaveragebitrate: String(VOICE_BITRATE) }

const formatParameters = (params) => [...params].map(([key, value]) => (value === null ? key : `${key}=${value}`)).join(';')

// Rewrites the Opus fmtp line, leaving every other codec and every other parameter as it was. A codec
// that carries no fmtp line of its own gets one, or it keeps the browser's defaults.
export function tuneOpus(sdp) {
  const lines = String(sdp || '').split(/\r?\n/)
  const payloads = new Set()
  let inAudio = false
  for (const line of lines) {
    if (line.startsWith('m=')) inAudio = line.startsWith('m=audio')
    if (!inAudio) continue
    const rtpmap = /^a=rtpmap:(\d+) opus\//i.exec(line)
    if (rtpmap) payloads.add(rtpmap[1])
  }
  if (!payloads.size) return sdp
  const rewritten = new Set()
  const out = []
  for (const line of lines) {
    const fmtp = /^a=fmtp:(\d+) (.*)$/.exec(line)
    if (!fmtp || !payloads.has(fmtp[1])) { out.push(line); continue }
    rewritten.add(fmtp[1])
    const params = new Map(fmtp[2].split(';').filter(Boolean).map((pair) => {
      const at = pair.indexOf('=')
      return at === -1 ? [pair.trim(), null] : [pair.slice(0, at).trim(), pair.slice(at + 1).trim()]
    }))
    for (const [key, value] of Object.entries(OPUS_PARAMETERS)) params.set(key, value)
    out.push(`a=fmtp:${fmtp[1]} ${formatParameters(params)}`)
  }
  const missing = [...payloads].filter((payload) => !rewritten.has(payload))
  if (!missing.length) return out.join('\r\n')
  const result = []
  for (const line of out) {
    result.push(line)
    const rtpmap = /^a=rtpmap:(\d+) /.exec(line)
    if (rtpmap && missing.includes(rtpmap[1])) {
      result.push(`a=fmtp:${rtpmap[1]} ${formatParameters(new Map(Object.entries(OPUS_PARAMETERS)))}`)
    }
  }
  return result.join('\r\n')
}

// Both sides notice each other at the same moment, and both would offer. Comparing the two ids gives
// each pair the same answer on both machines without a round trip to agree on it.
export const shouldOffer = (selfId, peerId) => String(selfId) < String(peerId)

// Long enough that a slow relay handshake is not mistaken for a dead route.
const FALLBACK_MS = 6_000

export function createVoiceChat({
  selfId,
  send,
  getIceServers = () => [],
  onStream,
  onPeerGone,
  onStateChange,
  newConnection = (configuration) => new RTCPeerConnection(configuration),
  newConnectionId = () => `${VOICE_PREFIX}${crypto.randomUUID()}`,
} = {}) {
  const peers = new Map()
  const earlyCandidates = new Map()
  let localStream = null
  let closed = false

  const announce = () => onStateChange?.()

  const drop = (peerId, notify) => {
    const peer = peers.get(peerId)
    if (!peer) return
    peers.delete(peerId)
    clearTimeout(peer.fallbackTimer)
    try { peer.pc.close() } catch { /* already closed */ }
    if (notify) onPeerGone?.(peerId)
    announce()
  }

  const attachLocalTrack = (peer) => {
    const track = localStream?.getAudioTracks()[0] || null
    if (!track) return
    if (peer.sender) { peer.sender.replaceTrack(track).catch(() => {}); return }
    peer.sender = peer.pc.addTrack(track, localStream)
    // A limit on the connection rather than a hint to the encoder. Voice never needs more, and a
    // microphone left uncapped can take bandwidth the screen is using.
    try {
      const parameters = peer.sender.getParameters()
      parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}]
      parameters.encodings[0].maxBitrate = VOICE_MAX_BITRATE
      parameters.encodings[0].networkPriority = 'high'
      peer.sender.setParameters(parameters).catch(() => {})
    } catch { /* older browsers ignore encoding parameters */ }
  }

  const escalate = (peerId) => {
    const peer = peers.get(peerId)
    if (!peer || peer.stage === 'all') return
    const servers = getIceServers()
    if (!servers.some((server) => JSON.stringify(server.urls).includes('turn'))) return
    peer.stage = 'all'
    try { peer.pc.setConfiguration(buildIceConfiguration(servers, 'all', false, peer.pc.getConfiguration())) } catch { return }
    if (peer.offerer) restart(peer)
    else send({ type: 'restart-request', to: peerId, connectionId: peer.connectionId })
  }

  const armFallback = (peerId) => {
    const peer = peers.get(peerId)
    if (!peer || peer.fallbackTimer) return
    peer.fallbackTimer = setTimeout(() => {
      const current = peers.get(peerId)
      if (!current) return
      current.fallbackTimer = null
      if (!['connected', 'completed'].includes(current.pc.iceConnectionState)) escalate(peerId)
    }, FALLBACK_MS)
  }

  async function restart(peer) {
    if (peer.negotiating || peer.pc.signalingState !== 'stable') return
    peer.negotiating = true
    try {
      peer.pc.restartIce()
      const offer = await peer.pc.createOffer({ iceRestart: true })
      offer.sdp = tuneOpus(offer.sdp)
      await peer.pc.setLocalDescription(offer)
      send({ type: 'signal', to: peer.peerId, connectionId: peer.connectionId, voice: true, description: peer.pc.localDescription })
    } catch { /* the next state change tries again */ }
    peer.negotiating = false
  }

  const build = (peerId, connectionId, offerer) => {
    const stage = initialIceStage('auto')
    const pc = newConnection(buildIceConfiguration(getIceServers(), stage))
    const peer = { peerId, connectionId, pc, offerer, stage, sender: null, pending: earlyCandidates.get(connectionId) || [], fallbackTimer: null, negotiating: false, connected: false }
    earlyCandidates.delete(connectionId)
    peers.set(peerId, peer)
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) send({ type: 'signal', to: peerId, connectionId, voice: true, candidate: candidate.toJSON() })
    }
    pc.ontrack = ({ streams, track }) => {
      if (track.kind !== 'audio') return
      onStream?.(peerId, streams[0] || new MediaStream([track]))
      announce()
    }
    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState
      if (['connected', 'completed'].includes(state)) {
        clearTimeout(peer.fallbackTimer); peer.fallbackTimer = null
        peer.connected = true
        announce()
      }
      // Voice is cheap to rebuild and useless while broken, so a failure escalates straight to the relay
      // rather than spending another round of direct attempts on a path that has already refused.
      if (state === 'failed') { peer.connected = false; announce(); escalate(peerId) }
      if (state === 'disconnected') { peer.connected = false; announce(); armFallback(peerId) }
    }
    attachLocalTrack(peer)
    return peer
  }

  const flush = async (peer) => {
    for (const candidate of peer.pending.splice(0)) {
      try { await peer.pc.addIceCandidate(candidate) } catch { /* a stale generation is not fatal */ }
    }
  }

  return {
    get peerIds() { return [...peers.keys()] },
    // Reported per peer so the interface can say who is still connecting rather than only who is there.
    get connections() { return [...peers.values()].map(({ peerId, connected, stage }) => ({ peerId, connected, relay: stage === 'all' })) },

    // The microphone. Handed in after the mesh exists, and replaceable without renegotiating: a device
    // change must not drop every conversation in the room.
    setLocalStream(stream) {
      localStream = stream || null
      for (const peer of peers.values()) attachLocalTrack(peer)
    },

    // The people currently in voice, self excluded. Everything else follows from this one call: someone
    // new gets a connection, someone gone loses theirs.
    async setPeers(ids) {
      if (closed) return
      const wanted = new Set(ids)
      for (const peerId of [...peers.keys()]) if (!wanted.has(peerId)) drop(peerId, true)
      for (const peerId of wanted) {
        if (peers.has(peerId)) continue
        // Only one side opens the connection; the other builds its own when the offer lands. Both
        // creating one would leave two half-connections per pair and neither would carry audio.
        if (!shouldOffer(selfId, peerId)) continue
        const peer = build(peerId, newConnectionId(), true)
        peer.negotiating = true
        try {
          const offer = await peer.pc.createOffer()
          offer.sdp = tuneOpus(offer.sdp)
          await peer.pc.setLocalDescription(offer)
          // Building an offer yields, and someone can leave voice in that gap. Sending it anyway would
          // leave them holding a connection nobody on this side is going to answer for.
          if (peers.get(peerId) !== peer) return
          send({ type: 'signal', to: peerId, connectionId: peer.connectionId, voice: true, description: peer.pc.localDescription })
          armFallback(peerId)
        } catch { drop(peerId, false) }
        peer.negotiating = false
      }
      announce()
    },

    async handleSignal(message) {
      if (closed || !isVoiceConnection(message.connectionId)) return
      let peer = peers.get(message.from)
      // An offer for a connection we do not have is the other side opening the pair. An offer for one we
      // do have, from the side that owns it, is an ICE restart on the same connection.
      if (message.description?.type === 'offer' && (!peer || peer.connectionId !== message.connectionId)) {
        if (peer) drop(message.from, false)
        peer = build(message.from, message.connectionId, false)
      }
      if (!peer || peer.connectionId !== message.connectionId) {
        if (message.candidate) {
          const pending = earlyCandidates.get(message.connectionId) || []
          if (pending.length < 32) pending.push(message.candidate)
          if (earlyCandidates.size < 16) earlyCandidates.set(message.connectionId, pending)
        }
        return
      }
      try {
        if (message.description) {
          await peer.pc.setRemoteDescription(message.description)
          await flush(peer)
          if (message.description.type === 'offer') {
            const answer = await peer.pc.createAnswer()
            answer.sdp = tuneOpus(answer.sdp)
            await peer.pc.setLocalDescription(answer)
            send({ type: 'signal', to: peer.peerId, connectionId: peer.connectionId, voice: true, description: peer.pc.localDescription })
            armFallback(peer.peerId)
          }
        } else if (message.candidate) {
          if (peer.pc.remoteDescription) { try { await peer.pc.addIceCandidate(message.candidate) } catch { /* stale generation */ } }
          else if (peer.pending.length < 32) peer.pending.push(message.candidate)
        }
      } catch { drop(message.from, true) }
    },

    // The answering side cannot restart ICE by itself; it asks the side that owns the offer to do it.
    // It only asks after its own route has failed, so the pair needs the relay -- not another attempt
    // on the same candidates. Escalating here is what actually changes the outcome.
    restart(peerId) {
      const peer = peers.get(peerId)
      if (!peer?.offerer) return
      if (peer.stage !== 'all') escalate(peerId)
      else restart(peer)
    },

    close() {
      closed = true
      for (const peerId of [...peers.keys()]) drop(peerId, true)
      earlyCandidates.clear()
      localStream = null
    },
  }
}
