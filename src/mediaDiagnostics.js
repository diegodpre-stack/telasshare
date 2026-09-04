const number = (value) => Number.isFinite(value) ? value : null
const rounded = (value) => Number.isFinite(value) ? Math.round(value * 100) / 100 : null
export function summarizeStats(stats, previous = new Map()) {
  let pair
  for (const report of stats.values()) {
    if (report.type === 'transport' && report.selectedCandidatePairId) { pair = stats.get(report.selectedCandidatePairId); if (pair) break }
  }
  if (!pair) pair = [...stats.values()].find((r) => r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated)
  const local = stats.get(pair?.localCandidateId), remote = stats.get(pair?.remoteCandidateId)
  const rows = [], next = new Map()
  for (const r of stats.values()) {
    if (!['outbound-rtp', 'inbound-rtp'].includes(r.type) || (r.kind || r.mediaType) !== 'video' || r.isRemote) continue
    const sending = r.type === 'outbound-rtp', old = previous.get(r.id)
    const seconds = old ? (r.timestamp - old.timestamp) / 1000 : 0
    const delta = (field) => seconds > 0 && Number.isFinite(r[field]) && Number.isFinite(old?.[field]) && r[field] >= old[field] ? r[field] - old[field] : null
    const frames = delta(sending ? 'framesEncoded' : 'framesDecoded')
    const bytes = delta(sending ? 'bytesSent' : 'bytesReceived')
    const totalTime = delta(sending ? 'totalEncodeTime' : 'totalDecodeTime')
    const jitterTime = delta('jitterBufferDelay'), jitterCount = delta('jitterBufferEmittedCount')
    const source = stats.get(r.mediaSourceId), codec = stats.get(r.codecId), feedback = stats.get(r.remoteId)
    rows.push({
      direction: sending ? 'envio' : 'recepção', width: number(r.frameWidth), height: number(r.frameHeight),
      fps: rounded(frames !== null ? frames / seconds : r.framesPerSecond),
      mbps: bytes !== null ? rounded(bytes * 8 / seconds / 1e6) : null,
      frameProcessingMs: frames > 0 && totalTime !== null ? rounded(totalTime * 1000 / frames) : null,
      captureFps: number(source?.framesPerSecond), captureWidth: number(source?.width), captureHeight: number(source?.height),
      limitation: r.qualityLimitationReason ?? null, codec: codec?.mimeType ?? null,
      // Only the negotiated H.264 profile, not arbitrary fmtp or SDP.
      h264Profile: codec?.mimeType?.toLowerCase() === 'video/h264' ? /(?:^|;)\s*profile-level-id=([0-9a-f]{6})(?:;|$)/i.exec(codec.sdpFmtpLine || '')?.[1]?.toLowerCase() ?? null : null,
      framesEncoded: sending ? number(r.framesEncoded) : null,
      framesDecoded: sending ? null : number(r.framesDecoded),
      framesReceived: sending ? null : number(r.framesReceived),
      encoderImplementation: sending ? r.encoderImplementation ?? null : null,
      decoderImplementation: sending ? null : r.decoderImplementation ?? null,
      powerEfficientEncoder: sending && typeof r.powerEfficientEncoder === 'boolean' ? r.powerEfficientEncoder : null,
      powerEfficientDecoder: !sending && typeof r.powerEfficientDecoder === 'boolean' ? r.powerEfficientDecoder : null,
      targetMbps: rounded(r.targetBitrate / 1e6),
      route: pair ? local?.candidateType === 'relay' || remote?.candidateType === 'relay' ? 'TURN' : 'P2P' : null,
      iceProtocol: local?.protocol ?? remote?.protocol ?? null,
      localRelayProtocol: local?.relayProtocol ?? null,
      localCandidateType: local?.candidateType ?? null, remoteCandidateType: remote?.candidateType ?? null,
      rttMs: rounded(pair?.currentRoundTripTime * 1000), availableMbps: rounded(pair?.availableOutgoingBitrate / 1e6),
      packetsLostTotal: number(sending ? feedback?.packetsLost : r.packetsLost),
      packetsLostInterval: sending ? null : delta('packetsLost'),
      nackInterval: delta('nackCount'), pliInterval: delta('pliCount'),
      retransmittedBytesInterval: delta('retransmittedBytesSent'),
      framesDroppedInterval: delta('framesDropped'), freezesInterval: delta('freezeCount'),
      jitterBufferMs: jitterCount > 0 && jitterTime !== null ? rounded(jitterTime * 1000 / jitterCount) : null,
    })
    // Only retain counters needed for next delta; never candidate addresses, URLs or credentials.
    next.set(r.id, Object.fromEntries(['timestamp', 'framesEncoded', 'framesDecoded', 'bytesSent', 'bytesReceived', 'totalEncodeTime', 'totalDecodeTime', 'jitterBufferDelay', 'jitterBufferEmittedCount', 'packetsLost', 'nackCount', 'pliCount', 'retransmittedBytesSent', 'framesDropped', 'freezeCount'].map((key) => [key, r[key]])))
  }
  return { rows, next }
}
