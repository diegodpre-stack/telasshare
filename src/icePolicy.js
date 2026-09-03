// No candidate pool by default: peers are created immediately before negotiation.
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
