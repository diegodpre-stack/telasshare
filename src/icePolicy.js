// No candidate pool by default: peers are created immediately before negotiation.
// Automatic gathers direct and TURN/UDP candidates together. ICE still prefers a working direct
// pair, while UDP relay no longer depends on reconfiguring an already-negotiated connection.
export const initialIceStage = (mode) => mode === 'p2p' ? 'direct' : 'udp'

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

// What the two ends of the chosen pair say about how the picture is actually travelling.
//
// Returns null when it cannot tell, and that is the whole point of it existing. The old expression read
// "either end is a relay ? TURN : P2P", so a pair whose candidate reports had not arrived yet -- or an
// answer of nothing at all -- came out as a confident "P2P". Somebody who had asked for TURN only was
// then shown P2P by a label that had simply not looked. Not knowing is not the same as direct, and the
// display can say nothing far more honestly than it can say the wrong thing.
export function routeFromPair(local, remote) {
  // The two claims are not symmetric. One end known to be a relay settles it -- whatever the other end
  // turns out to be, the picture is going through the relay to reach it. Saying "direct", though, is a
  // claim about both ends at once, so it needs both of them.
  if (local?.candidateType === 'relay' || remote?.candidateType === 'relay') return 'turn'
  if (!local?.candidateType || !remote?.candidateType) return null
  return 'p2p'
}

// Preserve immutable options when changing stages on an existing connection.
export function buildIceConfiguration(servers, stage, relayOnly = false, current = {}) {
  return { ...current, iceServers: selectIceServers(servers, stage), iceTransportPolicy: relayOnly ? 'relay' : 'all' }
}

export function selectIceServers(servers, stage) {
  return servers.map((server) => ({ ...server, urls: (Array.isArray(server.urls) ? server.urls : [server.urls]).filter((url) => {
    if (typeof url !== 'string') return false
    // Cloudflare returns port 53 as an alternate, but Chromium and Firefox block it. Letting the
    // browser probe it only creates a guaranteed timeout while the useful 3478 candidate is waiting.
    if (/^(?:stun:stun|turn:turn)\.cloudflare\.com:53(?:[/?]|$)/i.test(url)) return false
    if (/^stuns?:/i.test(url)) return true
    if (stage === 'direct') return false
    if (stage === 'all') return /^turns?:/i.test(url)
    return /^turn:/i.test(url) && !/[?&]transport=(?!udp(?:&|$))/i.test(url)
  }) })).filter((server) => server.urls.length)
}
