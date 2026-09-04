// No candidate pool by default: peers are created immediately before negotiation.
// Automatic starts with STUN only; adding TURN later must not exclude direct routes.
export const initialIceStage = (mode) => mode === 'turn' ? 'udp' : 'direct'

export async function canPreserveWithoutTurn(pc) {
  const config = pc.getConfiguration()
  const hasRelay = config.iceServers?.some(server =>
    (Array.isArray(server.urls) ? server.urls : [server.urls]).some(url => /^turns?:/i.test(url)))
  const stats = await pc.getStats()
  const transports = [...stats.values()].filter(report => report.type === 'transport' && report.selectedCandidatePairId)
  if (!transports.length) return !hasRelay && config.iceTransportPolicy !== 'relay'
  return transports.every(transport => {
    const pair = stats.get(transport.selectedCandidatePairId)
    const local = stats.get(pair?.localCandidateId), remote = stats.get(pair?.remoteCandidateId)
    return pair?.state === 'succeeded' && local?.candidateType && remote?.candidateType &&
      local.candidateType !== 'relay' && remote.candidateType !== 'relay'
  })
}

// Preserve immutable options when changing stages on an existing connection.
export function buildIceConfiguration(servers, stage, relayOnly = false, current = {}) {
  return { ...current, iceServers: selectIceServers(servers, stage), iceTransportPolicy: relayOnly ? 'relay' : 'all' }
}

export function selectIceServers(servers, stage) {
  return servers.map((server) => ({ ...server, urls: (Array.isArray(server.urls) ? server.urls : [server.urls]).filter((url) => {
    if (typeof url !== 'string') return false
    if (/^stuns?:/i.test(url)) return true
    if (stage === 'direct') return false
    if (stage === 'all') return /^turns?:/i.test(url)
    return /^turn:/i.test(url) && !/[?&]transport=(?!udp(?:&|$))/i.test(url)
  }) })).filter((server) => server.urls.length)
}
