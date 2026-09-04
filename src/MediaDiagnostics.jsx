import { useEffect, useRef, useState } from 'react'
import { summarizeStats } from './mediaDiagnostics.js'

// What the capture track actually granted, which is not what we asked for. A source pinned to 30 FPS
// caps the whole broadcast before a single frame reaches an encoder, and no sender setting can lift it.
// Whitelisted fields only: never deviceId or any other identifier the settings object may carry.
const captureState = (streamRef) => {
  const track = streamRef?.current?.getVideoTracks?.()[0]
  if (!track) return null
  const settings = track.getSettings?.() || {}
  const requested = track.getConstraints?.() || {}
  const asked = requested.frameRate
  return {
    readyState: track.readyState,
    grantedFps: Number.isFinite(settings.frameRate) ? Math.round(settings.frameRate * 100) / 100 : null,
    requestedFps: typeof asked === 'object' && asked ? asked.ideal ?? asked.max ?? asked.exact ?? null : asked ?? null,
    width: Number.isFinite(settings.width) ? settings.width : null,
    height: Number.isFinite(settings.height) ? settings.height : null,
    displaySurface: settings.displaySurface ?? null,
    logicalSurface: typeof settings.logicalSurface === 'boolean' ? settings.logicalSurface : null,
  }
}

export default function MediaDiagnostics({ peers, localStream }) {
  const history = useRef([])
  const [latest, setLatest] = useState([])
  const [capture, setCapture] = useState(null)
  useEffect(() => {
    let disposed = false, busy = false, sequence = 0
    const states = new Map()
    const sample = async () => {
      if (busy) return
      busy = true
      const rows = []
      try {
        for (const [id, entry] of peers.current) {
          let state = states.get(id)
          if (!state) { state = { label: `Conexão ${++sequence}`, previous: new Map() }; states.set(id, state) }
          try {
            const stats = await entry.pc.getStats()
            const result = summarizeStats(stats, state.previous)
            if (disposed) return
            state.previous = result.next
            const candidateCounts = {}, pairStates = {}
            for (const report of stats.values()) {
              if (['local-candidate', 'remote-candidate'].includes(report.type)) {
                const key = `${report.type}/${report.candidateType}/${report.protocol}`
                candidateCounts[key] = (candidateCounts[key] || 0) + 1
              }
              if (report.type === 'candidate-pair') pairStates[report.state] = (pairStates[report.state] || 0) + 1
            }
            const negotiation = {
              iceState: entry.pc.iceConnectionState, gatheringState: entry.pc.iceGatheringState,
              signalingState: entry.pc.signalingState, policy: entry.pc.getConfiguration().iceTransportPolicy, transportStage: entry.turnTransport ?? null,
              localDescription: entry.pc.localDescription?.type ?? null, remoteDescription: entry.pc.remoteDescription?.type ?? null,
              candidateCounts, pairStates, appliedSenderSettings: entry.appliedSettings ? { ...entry.appliedSettings } : null, counters: entry.iceDiagnostics ? structuredClone(entry.iceDiagnostics) : null,
            }
            for (const row of result.rows.length ? result.rows : [{ direction: entry.role === 'transmitter' ? 'envio' : 'recepção' }]) rows.push({ connection: state.label, state: entry.pc.connectionState, negotiation, ...row })
          } catch { /* A peer may close while sampling. */ }
        }
        for (const id of states.keys()) if (!peers.current.has(id)) states.delete(id)
        const source = captureState(localStream)
        if (!disposed) {
          setLatest(rows)
          setCapture(source)
          // The capture track is worth sampling even with no viewer yet: a source pinned to 30 FPS
          // shows up here before anyone connects, which is exactly when it is cheapest to notice.
          if (rows.length || source) history.current.push({ time: new Date().toISOString(), rows, capture: source, pageHidden: document.hidden })
          // Ten minutes at two-second intervals; no network upload or persistent storage.
          history.current = history.current.filter((s) => Date.parse(s.time) >= Date.now() - 600_000).slice(-300)
        }
      } finally { busy = false }
    }
    const timer = setInterval(sample, 2000)
    return () => { disposed = true; clearInterval(timer) }
  }, [peers, localStream])
  const download = () => {
    const blob = new Blob([JSON.stringify({ schema: 1, generatedAt: new Date().toISOString(), sampleIntervalMs: 2000, note: 'null = indisponível; perda total é cumulativa; relayProtocol é apenas do cliente local; FPS de captura vem de media-source, não da prévia.', samples: history.current }, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob), link = document.createElement('a')
    link.href = url; link.download = `entretelas-diagnostico-${Date.now()}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const value = (v, unit = '') => v == null ? 'indisponível' : `${v}${unit}`
  return <details style={{ margin: '12px 0', padding: 12, border: '1px solid #314759', borderRadius: 10 }}>
    <summary>Diagnóstico da transmissão (avançado)</summary>
    <p>Histórico automático dos últimos 10 minutos nesta sala. Ao ocorrer uma queda, baixe o relatório aqui e peça ao espectador afetado para baixar o dele também. Não inclui nomes, IPs, senhas ou conteúdo da tela.</p>
    <button onClick={download} disabled={!history.current.length}>Baixar relatório</button>
    <p>“CPU” indica limitação de processamento informada pelo navegador, não uma medição de uso da GPU. “Bandwidth” indica adaptação à rede. Uma cena parada pode gerar poucos quadros normalmente.</p>
    {capture && <div style={{ marginTop: 12, overflowWrap: 'anywhere' }}>
      <strong>Captura local · {value(capture.displaySurface)}</strong>
      <p>FPS concedido pela fonte: {value(capture.grantedFps)} · FPS pedido: {value(capture.requestedFps)}<br />
        Resolução da fonte: {value(capture.width)} × {value(capture.height)} · Estado: {value(capture.readyState)}<br />
        {capture.grantedFps != null && capture.requestedFps != null && capture.grantedFps < capture.requestedFps - 1
          ? 'A fonte concedeu menos FPS do que o pedido. Esse é o teto da transmissão: nenhum ajuste de codec ou bitrate passa dele.'
          : 'A fonte aceitou o FPS pedido. Quedas abaixo disso vêm da codificação ou da rede, não da captura.'}</p>
    </div>}
    {!latest.length && <p>Aguardando uma transmissão com espectador.</p>}
    {latest.map((row, index) => <div key={`${row.connection}-${index}`} style={{ marginTop: 12, overflowWrap: 'anywhere' }}>
      <strong>{row.connection} · {row.direction} · {row.route || row.state}</strong>
      <p>{value(row.width)} × {value(row.height)} · {value(row.fps, ' FPS')} · {value(row.mbps, ' Mbps')}<br />
        Codec: {value(row.codec)} · Limitação: {value(row.limitation)} · {row.direction === 'envio' ? 'Codificação' : 'Decodificação'}: {value(row.frameProcessingMs, ' ms/quadro')}<br />
        Implementação: {value(row.encoderImplementation ?? row.decoderImplementation)} · Encoder eficiente informado: {row.powerEfficientEncoder == null ? 'indisponível' : row.powerEfficientEncoder ? 'sim' : 'não'}<br />
        Captura (quando informada): {value(row.captureFps, ' FPS')} · Ping: {value(row.rttMs, ' ms')} · Banda estimada: {value(row.availableMbps, ' Mbps')}<br />
        ICE: {value(row.iceProtocol)} · Transporte até TURN local: {value(row.localRelayProtocol)}<br />
        Candidato local: {value(row.localCandidateType)} · Remoto: {value(row.remoteCandidateType)}<br />
        Pacotes perdidos acumulados: {value(row.packetsLostTotal)} · Pedidos de retransmissão no intervalo: {value(row.nackInterval)}</p>
    </div>)}
  </details>
}
