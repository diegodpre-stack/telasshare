export function selectIceServers(servers, stage) {
  return servers.map((server) => ({ ...server, urls: (Array.isArray(server.urls) ? server.urls : [server.urls]).filter((url) => {
    if (typeof url !== 'string') return false
    if (/^stuns?:/i.test(url)) return true
    if (stage === 'direct') return false
    if (stage === 'all') return /^turns?:/i.test(url)
    return /^turn:/i.test(url) && !/[?&]transport=(?!udp(?:&|$))/i.test(url)
  }) })).filter((server) => server.urls.length)
}
