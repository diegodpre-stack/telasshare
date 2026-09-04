import { useEffect, useRef, useState } from 'react'
import { summarizeStats } from './mediaDiagnostics.js'
import { startCaptureRateMeter } from './captureRate.js'

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
    // Reported as the browser sees it, in CSS pixels plus the ratio, rather than multiplied into a
    // guess at the physical size. On a scaled Windows display the packaged app reported a ratio of 1
    // for a 1440p screen, so that multiplication produced 1920x1080 for a monitor capturing at
    // 2560x1440 — a number that looked authoritative and was simply wrong.
    screenWidth: window.screen?.width || null,
    screenHeight: window.screen?.height || null,
    pixelRatio: window.devicePixelRatio || null,
  }
}

// An averaged frame rate hides the difference that decides where to look next, so report the shape of
// the arrivals rather than the average alone. A long tail beside a short median means the source can go
// faster and something is interrupting it. Evenly spaced frames below the requested rate mean each frame
// simply costs that long to produce — which is a throughput ceiling, not a rule being imposed. An earlier
// version of this text called the even case an imposed limit; measurements on a 1440p screen showed the
// gap tracking the per-frame work instead, so it now reports the cost and leaves the cause open.
const captureVerdict = (capture) => {
  const delivered = capture.delivered
  if (!delivered) return 'Medição da fonte indisponível neste navegador.'
  if (!delivered.frames) return 'Nenhum quadro entregue neste intervalo. Uma tela totalmente parada faz isso normalmente.'
  if (capture.grantedFps != null && delivered.fps >= capture.grantedFps - 5) return 'A fonte está entregando o que foi pedido. Quedas depois daqui vêm da codificação ou da rede.'
  if (delivered.longestGapMs != null && delivered.medianGapMs > 0 && delivered.longestGapMs > delivered.medianGapMs * 3)
    return 'Os quadros chegam em rajadas: o intervalo maior é muito acima do mediano. A fonte consegue ir mais rápido e está sendo interrompida.'
  return `Os quadros chegam espaçados por igual: cada um custa cerca de ${delivered.medianGapMs} ms para a fonte produzir, e é esse custo que fixa o teto em ${delivered.fps} FPS.`
    + (delivered.longestGapMs > delivered.medianGapMs * 1.8 ? ` O intervalo maior chegou a ${delivered.longestGapMs} ms, então há travadas ocasionais somadas a esse custo.` : '')
}

export default function MediaDiagnostics({ peers, localStream }) {
  const history = useRef([])
  const [latest, setLatest] = useState([])
  const [capture, setCapture] = useState(null)
  const meter = useRef(null)
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
        const track = localStream?.current?.getVideoTracks?.()[0] || null
        if (meter.current?.track !== track) {
          meter.current?.instance?.stop()
          meter.current = track ? { track, instance: startCaptureRateMeter(track) } : null
        }
        if (source) source.delivered = meter.current?.instance?.read() ?? null
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
    return () => {
      disposed = true; clearInterval(timer)
      meter.current?.instance?.stop(); meter.current = null
    }
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
        Resolução da fonte: {value(capture.width)} × {value(capture.height)} · Tela (CSS): {value(capture.screenWidth)} × {value(capture.screenHeight)} @ {value(capture.pixelRatio)}x · Estado: {value(capture.readyState)}<br />
        FPS realmente entregue pela fonte: {value(capture.delivered?.fps)} ({value(capture.delivered?.frames)} quadros em 2 s)<br />
        Intervalo entre quadros: menor {value(capture.delivered?.shortestGapMs, ' ms')} · mediano {value(capture.delivered?.medianGapMs, ' ms')} · maior {value(capture.delivered?.longestGapMs, ' ms')}<br />
        {captureVerdict(capture)}</p>
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
