import { Room, RoomEvent, Track, LocalVideoTrack } from 'livekit-client'
const $ = (id) => document.getElementById(id)
let room, localTrack, busy = false
const cards = new Map()
const samples = new Map()
const status = (text) => { $('status').textContent = text }
function remove(id) { const card = cards.get(id); if (card) { card.track.detach().forEach((el) => el.remove()); card.element.remove(); cards.delete(id) } samples.delete(id) }
function show(track, name, local = false) {
  const id = track.sid || 'preview'; remove(id)
  const element = document.createElement('article'), title = document.createElement('h2')
  title.textContent = local ? `${name} · prévia local` : `${name} · recebido pelo SFU local`
  const video = track.attach(); video.muted = true; video.playsInline = true; video.autoplay = true
  video.ondblclick = () => video.requestFullscreen?.()
  element.append(title, video); $('videos').append(element); cards.set(id, { element, track, local, name })
}
async function stopShare() {
  const track = localTrack; localTrack = null
  if (track) { track.stop(); remove(track.sid || 'preview'); try { await room?.localParticipant.unpublishTrack(track) } catch { /* already disconnected */ } }
  $('active').hidden = true; $('stop').disabled = true; $('share').disabled = !room || busy
}
function reset() { localTrack?.stop(); localTrack = null; for (const id of [...cards.keys()]) remove(id); $('controls').hidden = true; $('login').hidden = false; $('active').hidden = true; room = null }
$('login').onsubmit = async (event) => {
  event.preventDefault(); const button = event.target.querySelector('button'); button.disabled = true
  try {
    const response = await fetch('/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: $('name').value }) })
    if (!response.ok) throw new Error('Não foi possível entrar no teste.')
    const credentials = await response.json()
    room = new Room({ adaptiveStream: false, dynacast: false, publishDefaults: { simulcast: false, videoCodec: 'vp8', screenShareEncoding: { maxBitrate: 8_000_000, maxFramerate: 60 } } })
    room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => { if (track.kind === Track.Kind.Video) show(track, participant.name || participant.identity) })
    room.on(RoomEvent.TrackUnsubscribed, (track) => remove(track.sid))
    room.on(RoomEvent.Reconnecting, () => status('Reconectando ao servidor local…'))
    room.on(RoomEvent.Reconnected, () => status('Conectado ao SFU local.'))
    room.on(RoomEvent.Disconnected, () => { reset(); status('Desconectado. A captura foi encerrada.') })
    await room.connect(credentials.url, credentials.token, { rtcConfig: { iceServers: [] } })
    $('login').hidden = true; $('controls').hidden = false; $('share').disabled = false; status('Conectado ao SFU local. Nenhuma captura automática.')
  } catch (error) { const previous = room; reset(); await previous?.disconnect(); status(error.message) }
  finally { button.disabled = false }
}
$('share').onclick = async () => {
  if (busy || !room || localTrack) return
  busy = true; $('share').disabled = true
  const current = room
  let stream
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60, max: 60 } }, audio: false })
    if (room !== current) throw new Error('Você saiu durante a seleção.')
    const track = new LocalVideoTrack(stream.getVideoTracks()[0]); localTrack = track
    await current.localParticipant.publishTrack(track, { source: Track.Source.ScreenShare, simulcast: false, screenShareEncoding: { maxBitrate: 8_000_000, maxFramerate: 60 } })
    track.mediaStreamTrack.addEventListener('ended', () => stopShare(), { once: true })
    show(track, current.localParticipant.name, true); $('active').hidden = false; $('stop').disabled = false; status('Transmitindo pelo SFU deste PC. Abra outra aba para assistir.')
  } catch (error) { stream?.getTracks().forEach((track) => track.stop()); await stopShare(); status(error.name === 'NotAllowedError' ? 'Captura cancelada.' : error.message) }
  finally { busy = false; $('share').disabled = !!localTrack || !room }
}
$('stop').onclick = stopShare
$('leave').onclick = async () => { await stopShare(); await room?.disconnect() }
window.addEventListener('pagehide', () => { localTrack?.stop(); room?.disconnect() })
setInterval(async () => {
  const lines = []
  for (const [id, card] of cards) {
    try {
      const reports = await card.track.getRTCStatsReport()
      reports?.forEach((report) => {
        if (report.type !== (card.local ? 'outbound-rtp' : 'inbound-rtp') || report.isRemote) return
        const frames = card.local ? report.framesEncoded : report.framesDecoded
        const bytes = card.local ? report.bytesSent : report.bytesReceived
        const old = samples.get(id), seconds = old ? (report.timestamp - old.timestamp) / 1000 : 0
        const fps = seconds > 0 ? Math.round((frames - old.frames) / seconds) : report.framesPerSecond
        const mbps = seconds > 0 ? ((bytes - old.bytes) * 8 / seconds / 1e6).toFixed(2) : '…'
        const encode = seconds > 0 && frames > old.frames ? ((report.totalEncodeTime - old.encode) * 1000 / (frames - old.frames)).toFixed(1) : '…'
        samples.set(id, { timestamp: report.timestamp, frames, bytes, encode: report.totalEncodeTime })
        lines.push(`${card.name}: ${card.local ? 'ENVIO ao SFU' : 'RECEPÇÃO'} · ${report.frameWidth || '?'}×${report.frameHeight || '?'} · ${fps ?? '…'} FPS · ${mbps} Mbps${card.local ? ` · limitação: ${report.qualityLimitationReason || '?'} · codificação ${encode} ms/quadro` : ` · pacotes perdidos: ${report.packetsLost ?? '?'}`}`)
      })
    } catch { lines.push(`${card.name}: estatísticas indisponíveis`) }
  }
  $('stats').textContent = lines.join('\n') || 'Aguardando transmissão.'
}, 1500)
