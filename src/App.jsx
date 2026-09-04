import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import MediaDiagnostics from './MediaDiagnostics.jsx'

// Off unless asked for. While mounted the panel polls getStats on every connection every two seconds,
// keeps ten minutes of samples in memory for the downloadable report, and runs a meter that pulls every
// single frame off the capture track to time it — per-frame work on the machine that is already paying
// for capture and encoding. None of it runs when the component is not mounted.
//
// Kept reachable without a rebuild, because a fault worth diagnosing shows up on someone else's machine:
// add ?diagnostico to the address, or set entretelas-diagnostico to 1 in local storage to keep it on.
const diagnosticsEnabled = (() => {
  try {
    if (new URLSearchParams(location.search).has('diagnostico')) return true
    return localStorage.getItem('entretelas-diagnostico') === '1'
  } catch { return false }
})()
import { buildIceConfiguration, initialIceStage, canPreserveWithoutTurn } from './icePolicy.js'
import { applySenderSettings } from './senderSettings.js'
import { preferHardwareVideoCodecs } from './encoderSupport.js'
import { mediaEvents, recordPeerFailure } from './mediaEvents.js'
import { Ban, Cast, CircleStop, DoorOpen, Download, Expand, ExternalLink, Eye, KeyRound, LogOut, MonitorUp, Plus, Radio, ShieldCheck, SlidersHorizontal, UserX, Users, Volume2, VolumeX, Wifi, WifiOff, X } from 'lucide-react'

const localHost = ['localhost', '127.0.0.1'].includes(location.hostname)
const defaultSignalHost = localHost ? `${location.hostname}:8787` : location.host
const SIGNAL_URL = import.meta.env.VITE_SIGNAL_URL || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${defaultSignalHost}`
const resolutions = { auto: { label: 'Auto' }, '720p': { label: '720p', width: 1280, height: 720 }, '1080p': { label: '1080p', width: 1920, height: 1080 }, '1440p': { label: '1440p', width: 2560, height: 1440 } }
// A ceiling, not a target: WebRTC never sends more than its bandwidth estimate allows, so this only
// decides how much room there is when the connection turns out to be good. Picking it was a question
// nobody could answer without measuring, and the wrong answer quietly capped a healthy connection.
const MAX_BITRATE_PER_VIEWER = 20_000_000
const roleRanks = { member: 0, owner: 1, admin: 2, superadmin: 3 }
const defaultStunUrls = 'stun:stun.cloudflare.com:3478,stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302,stun:stun2.l.google.com:19302,stun:stun.nextcloud.com:443'
const staticIceServers = () => {
  const stun = (import.meta.env.VITE_STUN_URLS || defaultStunUrls).split(',').map((v) => v.trim()).filter(Boolean)
  const turn = (import.meta.env.VITE_TURN_URLS || '').split(',').map((v) => v.trim()).filter(Boolean)
  const servers = stun.length ? [{ urls: stun }] : []
  if (turn.length) servers.push({ urls: turn, username: import.meta.env.VITE_TURN_USERNAME || '', credential: import.meta.env.VITE_TURN_CREDENTIAL || '' })
  return servers
}
const codecChoices = { auto: 'Automático', h264: 'H.264', av1: 'AV1', vp9: 'VP9', vp8: 'VP8' }

// Bandwidth estimation opens near 0.3 Mbps and climbs only as fast as it is fed. On a screen share that
// means the first seconds are a smear and the estimate takes a long time to find the real ceiling — and
// it never looks for one above what is actually being sent, so a still screen keeps it parked low. On a
// 450 Mbps uplink it was measured sitting at 5 Mbps while the encoder cut 1440p down to 1080p to fit.
//
// Chromium reads x-google-start-bitrate and x-google-min-bitrate out of the codec fmtp line, in kbps.
// Only the video codecs are touched, and only the ones the answer will keep; audio and the FEC and
// retransmission payloads are left exactly as they were.
const videoPayloadTypes = (sdp) => {
  const payloads = new Set()
  let inVideo = false
  for (const line of sdp.split(/\r?\n/)) {
    if (line.startsWith('m=')) inVideo = line.startsWith('m=video')
    if (!inVideo) continue
    const rtpmap = /^a=rtpmap:(\d+) ([A-Za-z0-9-]+)\//.exec(line)
    if (rtpmap && !['rtx', 'red', 'ulpfec', 'flexfec-03'].includes(rtpmap[2].toLowerCase())) payloads.add(rtpmap[1])
  }
  return payloads
}

// Only the opening guess, never a floor. An earlier version also set x-google-min-bitrate, which stops
// the estimator descending when the path cannot take the traffic: measured on a relay that carried about
// 1.5 Mbps, it kept 5.1 Mbps going out, lost packets steadily and drove the picture down to 722x406.
// Opening high is a bet that costs one bad second; refusing to come down costs the whole broadcast.
const withStartBitrate = (sdp, startKbps) => {
  const payloads = videoPayloadTypes(sdp)
  if (!payloads.size) return sdp
  const extra = `x-google-start-bitrate=${startKbps}`
  const withFmtp = new Set()
  const lines = []
  for (const line of sdp.split(/\r?\n/)) {
    const fmtp = /^a=fmtp:(\d+) (.*)$/.exec(line)
    // Record the payload whether or not this line is rewritten. Marking only the rewritten ones makes a
    // codec that already carries the parameters look like it has no fmtp line at all, and a second pass
    // over the same description would then append a duplicate.
    if (fmtp && payloads.has(fmtp[1])) withFmtp.add(fmtp[1])
    if (fmtp && payloads.has(fmtp[1]) && !line.includes('x-google-start-bitrate')) {
      lines.push(`a=fmtp:${fmtp[1]} ${fmtp[2]};${extra}`)
    } else lines.push(line)
  }
  // A codec that carries no fmtp line of its own still needs one, or it keeps the 0.3 Mbps opening.
  const missing = [...payloads].filter((payload) => !withFmtp.has(payload))
  if (!missing.length) return lines.join('\r\n')
  const result = []
  for (const line of lines) {
    result.push(line)
    const rtpmap = /^a=rtpmap:(\d+) /.exec(line)
    if (rtpmap && missing.includes(rtpmap[1])) result.push(`a=fmtp:${rtpmap[1]} ${extra}`)
  }
  return result.join('\r\n')
}

const audioConstraints = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2, sampleRate: 48000 }

async function attachDesktopWindowAudio(stream, onError) {
  const bridge = window.electronAPI
  if (!bridge?.isWindowAudioActive || !(await bridge.isWindowAudioActive())) return null
  const AudioContextClass = window.AudioContext || window.webkitAudioContext
  if (!AudioContextClass) return null
  const context = new AudioContextClass({ sampleRate: 48000 })
  const destination = context.createMediaStreamDestination()
  const processor = context.createScriptProcessor(4096, 0, 2)
  const queue = []
  let current = null
  let offset = 0
  let closed = false
  let pendingByte = null
  let pendingSample = null
  const unsubscribeData = bridge.onWindowAudioData((value) => {
    if (closed) return
    let bytes = value?.data ? Uint8Array.from(value.data) : new Uint8Array(value.buffer, value.byteOffset || 0, value.byteLength)
    if (pendingByte !== null) { const joined = new Uint8Array(bytes.length + 1); joined[0] = pendingByte; joined.set(bytes, 1); bytes = joined; pendingByte = null }
    if (bytes.length % 2) { pendingByte = bytes[bytes.length - 1]; bytes = bytes.subarray(0, bytes.length - 1) }
    const copy = bytes.slice()
    let samples = new Int16Array(copy.buffer, copy.byteOffset, copy.byteLength / 2)
    if (pendingSample !== null) { const joined = new Int16Array(samples.length + 1); joined[0] = pendingSample; joined.set(samples, 1); samples = joined; pendingSample = null }
    if (samples.length % 2) { pendingSample = samples[samples.length - 1]; samples = samples.subarray(0, samples.length - 1) }
    if (samples.length) queue.push(samples)
    if (queue.length > 40) queue.splice(0, queue.length - 40)
  })
  const cleanup = () => {
    if (closed) return
    closed = true
    unsubscribeData?.(); unsubscribeError?.(); processor.disconnect(); context.close().catch(() => {}); bridge.stopWindowAudio?.()
  }
  const unsubscribeError = bridge.onWindowAudioError((reason) => { onError?.(reason); cleanup() })
  processor.onaudioprocess = (event) => {
    const left = event.outputBuffer.getChannelData(0)
    const right = event.outputBuffer.getChannelData(1)
    for (let frame = 0; frame < left.length; frame += 1) {
      while (!current || offset + 1 >= current.length) { current = queue.shift() || null; offset = 0; if (!current) break }
      if (!current) { left[frame] = 0; right[frame] = 0; continue }
      left[frame] = current[offset++] / 32768
      right[frame] = current[offset++] / 32768
    }
  }
  processor.connect(destination)
  await context.resume()
  const track = destination.stream.getAudioTracks()[0]
  track.addEventListener('ended', cleanup, { once: true })
  stream.addTrack(track)
  return track
}
const FRIEND_SITE_URL = 'https://osrsiron.com'
const PORTABLE_DOWNLOAD_URL = 'https://github.com/diegodpre-stack/telasshare/releases/latest/download/EntreTelas-Portable.exe'
const INSTALLER_DOWNLOAD_URL = 'https://github.com/diegodpre-stack/telasshare/releases/latest/download/EntreTelas-Setup.exe'
const playChime = (kind) => {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext
  if (!AudioContextClass) return
  const context = new AudioContextClass()
  const notes = kind === 'viewer' ? [659.25, 783.99] : [523.25, 659.25]
  const start = context.currentTime
  const master = context.createGain()
  master.gain.setValueAtTime(0.0001, start)
  master.gain.exponentialRampToValueAtTime(0.09, start + 0.015)
  master.gain.exponentialRampToValueAtTime(0.0001, start + 0.42)
  master.connect(context.destination)
  notes.forEach((frequency, index) => {
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    oscillator.type = 'sine'; oscillator.frequency.value = frequency
    gain.gain.value = index ? 0.45 : 0.7
    oscillator.connect(gain); gain.connect(master)
    oscillator.start(start + index * 0.09); oscillator.stop(start + 0.38)
  })
  context.resume().catch(() => {})
  setTimeout(() => context.close().catch(() => {}), 600)
}
export function GlobalActions() {
  const [confirmation, setConfirmation] = useState('')
  const openSite = () => {
    window.open(FRIEND_SITE_URL, '_blank', 'noopener,noreferrer')
    setConfirmation('')
  }
  const download = (url) => { window.open(url, '_blank', 'noopener,noreferrer'); setConfirmation('') }
  return <>
    <nav className="global-actions" aria-label="Atalhos"><button type="button" className="friend-site-button" onClick={() => setConfirmation('friend')}><ExternalLink size={15} /><span>OSRS Iron Tools</span></button><button type="button" className="app-download-button" onClick={() => setConfirmation('download')}><Download size={17} /><span><strong>Baixar aplicativo</strong><small>Windows 64-bit</small></span></button></nav>
    {confirmation === 'friend' && <div className="modal-backdrop" role="presentation"><section className="modal external-site-modal" role="dialog" aria-modal="true" aria-labelledby="external-site-title"><div className="request-icon"><ExternalLink size={25} /></div><p className="eyebrow">Link externo</p><h3 id="external-site-title">Abrir OSRS Iron Tools?</h3><p>Você será levado para um site de Tools para irons no OldschoolRunescape, deseja continuar?</p><div className="modal-actions"><button type="button" className="secondary" onClick={() => setConfirmation('')}>Não</button><button type="button" onClick={openSite}>Sim</button></div></section></div>}
    {confirmation === 'download' && <div className="modal-backdrop" role="presentation"><section className="modal external-site-modal download-modal" role="dialog" aria-modal="true" aria-labelledby="download-title"><div className="request-icon"><Download size={25} /></div><p className="eyebrow">Aplicativo para Windows</p><h3 id="download-title">Deseja baixar o EntreTelas?</h3><p><strong>Portátil:</strong> abre sem instalação, mas não recebe atualizações automáticas. Você precisará baixar novamente quando o aplicativo mudar.<br /><br /><strong>Instalador:</strong> instala uma vez e verifica, baixa e aplica novas versões automaticamente.</p><div className="download-options"><button type="button" className="secondary" onClick={() => setConfirmation('')}>Não</button><button type="button" onClick={() => download(PORTABLE_DOWNLOAD_URL)}>Portátil — sem atualização automática</button><button type="button" onClick={() => download(INSTALLER_DOWNLOAD_URL)}>Instalador — atualização automática</button></div></section></div>}
  </>
}
function RemoteScreen({ screen, name, size, onStop }) {
  const videoRef = useRef(null)
  const [muted, setMuted] = useState(false)
  const [volume, setVolume] = useState(1)
  const [audioBlocked, setAudioBlocked] = useState(false)
  const play = useCallback(async () => {
    const video = videoRef.current; if (!video) return
    try { await video.play(); setAudioBlocked(false) }
    catch {
      video.muted = true; setMuted(true)
      try { await video.play(); setAudioBlocked(true) } catch { setAudioBlocked(true) }
    }
  }, [])
  useEffect(() => { const video = videoRef.current; if (!video) return; video.srcObject = screen.stream || null; if (screen.stream) play() }, [screen.stream, play])
  useEffect(() => { const video = videoRef.current; if (!video) return; video.muted = muted; video.volume = volume }, [muted, volume, screen.stream])
  useEffect(() => {
    const handleVisibility = () => { if (document.hidden) videoRef.current?.pause(); else if (screen.stream) play() }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => document.removeEventListener('visibilitychange', handleVisibility)
  }, [play, screen.stream])
  const enableAudio = () => { const video = videoRef.current; if (!video) return; video.muted = false; setMuted(false); play() }
  const goFullscreen = () => { const frame = videoRef.current?.parentElement; return frame?.requestFullscreen?.() || videoRef.current?.webkitEnterFullscreen?.() }
  const connectionDetails = [screen.route === 'turn' ? 'TURN' : screen.route === 'p2p' ? 'P2P' : '', screen.protocol, Number.isFinite(screen.rttMs) ? `${screen.rttMs} ms` : '', Number.isFinite(screen.receivedMbps) ? `${screen.receivedMbps} Mbps` : '', Number.isFinite(screen.packetLoss) ? `${screen.packetLoss}% perda` : ''].filter(Boolean).join(' · ')
  return <article className={`screen-card size-${size}`}>
    {screen.error && <p role="alert" className="hint">{screen.error}</p>}
    <div className="screen-card-head"><div><i /><strong>Tela de {name}</strong><span>{Number.isFinite(screen.fps) ? `~${screen.fps} FPS` : screen.waiting ? 'aguardando transmissão' : 'conectando'}{screen.stream ? screen.hasAudio ? ' · com áudio' : ' · sem áudio' : ''}{connectionDetails ? ` · ${connectionDetails}` : ''}</span></div><div><button title="Tela cheia" onClick={goFullscreen}><Expand size={16} /></button><button title="Encerrar esta visualização" onClick={onStop}><X size={16} /></button></div></div>
    <div className="remote-frame" onDoubleClick={goFullscreen}><video ref={videoRef} autoPlay playsInline />{!screen.stream && <div className="video-placeholder overlay"><div className="spinner" /><strong>Aguardando a tela</strong></div>}{screen.hasAudio && audioBlocked && <button className="audio-unlock" onClick={enableAudio}><Volume2 size={16} />Ativar som</button>}</div>
    {screen.hasAudio && <div className="screen-audio"><button title={muted ? 'Ativar som' : 'Silenciar'} onClick={() => setMuted((current) => !current)}>{muted ? <VolumeX size={16} /> : <Volume2 size={16} />}</button><input type="range" min="0" max="1" step="0.01" value={muted ? 0 : volume} onChange={(event) => { const value = Number(event.target.value); setVolume(value); setMuted(value === 0) }} aria-label={`Volume da tela de ${name}`} /><span>{Math.round((muted ? 0 : volume) * 100)}%</span></div>}
  </article>
}

function SelfPreview({ stream, routeLabel, outboundFpsLabel, onClose }) {
  const videoRef = useRef(null)
  const [actualFps, setActualFps] = useState(null)
  const settings = stream?.getVideoTracks()[0]?.getSettings?.() || {}
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    video.srcObject = stream
    video.play().catch(() => {})
    if (!video.requestVideoFrameCallback) { setActualFps(settings.frameRate ? Math.round(settings.frameRate) : null); return }
    let callbackId; let frames = 0; let startedAt = performance.now(); let disposed = false
    const measure = (now) => {
      if (disposed) return
      frames += 1
      const elapsed = now - startedAt
      if (elapsed >= 1000) { setActualFps(Math.round(frames * 1000 / elapsed)); frames = 0; startedAt = now }
      callbackId = video.requestVideoFrameCallback(measure)
    }
    callbackId = video.requestVideoFrameCallback(measure)
    return () => { disposed = true; if (callbackId) video.cancelVideoFrameCallback?.(callbackId) }
  }, [settings.frameRate, stream])
  const goFullscreen = () => videoRef.current?.parentElement?.requestFullscreen?.()
  const fpsLabel = [Number.isFinite(actualFps) ? `~${actualFps} FPS na prévia local` : 'medindo prévia local', outboundFpsLabel].filter(Boolean).join(' · ')
  return <div className="modal-backdrop"><section className="self-preview-modal" role="dialog" aria-modal="true" aria-labelledby="self-preview-title"><div className="screen-card-head"><div><i /><strong id="self-preview-title">Prévia da sua transmissão</strong><span>{settings.width && settings.height ? `${settings.width}×${settings.height}` : 'resolução automática'} · {fpsLabel} · {routeLabel}</span></div><div><button title="Tela cheia" onClick={goFullscreen}><Expand size={16} /></button><button title="Fechar prévia" onClick={onClose}><X size={16} /></button></div></div><div className="self-preview-video" onDoubleClick={goFullscreen}><video ref={videoRef} autoPlay playsInline muted /></div><p>{outboundFpsLabel ? 'FPS realmente enviado aos espectadores pela conexão WebRTC.' : 'FPS medido na captura local; ainda não há espectador para medir o envio.'} A rota é calculada separadamente para cada espectador.</p></section></div>
}

// The app and the site it loads ship separately, so "did it update" has two answers and guessing at
// either wasted real debugging time. Show both, always, rather than only when something looks wrong.
function BuildStamp() {
  const [appVersion, setAppVersion] = useState(null)
  useEffect(() => {
    let cancelled = false
    window.electronAPI?.getAppVersion?.().then((value) => { if (!cancelled) setAppVersion(value) }).catch(() => {})
    return () => { cancelled = true }
  }, [])
  const inApp = !!window.electronAPI?.isDesktop
  return <p className="build-stamp">site {__BUILD_ID__} · {inApp ? `app ${appVersion || '…'}` : 'no navegador'}</p>
}

export default function App() {
  const [name, setName] = useState(localStorage.getItem('screen-share-name') || '')
  const [roomName, setRoomName] = useState('')
  const [password, setPassword] = useState('')
  const [adminMode, setAdminMode] = useState(false)
  const [accessError, setAccessError] = useState('')
  const [joining, setJoining] = useState(false)
  const [siteSession, setSiteSession] = useState(() => localStorage.getItem('screen-share-site-session') || '')
  const [accessSession, setAccessSession] = useState('')
  const [rooms, setRooms] = useState([])
  const [selectedRoom, setSelectedRoom] = useState(null)
  const [roomPassword, setRoomPassword] = useState('')
  const [creatingRoom, setCreatingRoom] = useState(false)
  const [newRoomName, setNewRoomName] = useState('')
  const [newRoomPassword, setNewRoomPassword] = useState('')
  const [siteRole, setSiteRole] = useState('member')
  const [joined, setJoined] = useState(false)
  const [connection, setConnection] = useState('offline')
  const [selfId, setSelfId] = useState('')
  const [isAdmin, setIsAdmin] = useState(false)
  const [moderationRole, setModerationRole] = useState('member')
  const [users, setUsers] = useState([])
  const [remoteScreens, setRemoteScreens] = useState({})
  const [viewers, setViewers] = useState({})
  const [broadcasting, setBroadcasting] = useState(false)
  const [notice, setNotice] = useState('Entre em uma sala privada para encontrar seus amigos.')
  const [resolution, setResolution] = useState('1080p')
  const [fps, setFps] = useState(60)
  const [preferredCodec, setPreferredCodec] = useState('auto')
  const [screenSize, setScreenSize] = useState('medium')
  const [watchMode, setWatchMode] = useState('auto')
  const [shareAudio, setShareAudio] = useState(true)
  const [audioStatus, setAudioStatus] = useState('idle')
  const [showSelfPreview, setShowSelfPreview] = useState(false)
  const [showPeople, setShowPeople] = useState(true)
  const socketRef = useRef(null)
  const pcsRef = useRef(new Map())
  const earlyCandidatesRef = useRef(new Map())
  const signalQueueRef = useRef(Promise.resolve())
  const iceServersRef = useRef(staticIceServers())
  const localStreamRef = useRef(null)
  const statsRef = useRef(new Map())
  const knownUsersRef = useRef(null)
  const transmissionSettingsRef = useRef({ fps, maxBitrate: MAX_BITRATE_PER_VIEWER, scaleResolutionDownBy: 1 })
  const captureSettingsQueue = useRef(Promise.resolve())
  // shareWith runs from the socket handler, which closed over an older render, so the current choice
  // has to travel in a ref the way the transmission settings already do.
  const preferredCodecRef = useRef(preferredCodec)
  useEffect(() => { preferredCodecRef.current = preferredCodec }, [preferredCodec])
  // Asking the capture for a smaller frame than the screen makes the browser shrink every frame inside
  // the capture loop, on the thread that produces them. Measured on a 1440p screen asked for 1080p, that
  // cost about 4 ms per frame and took the source from 52 FPS to 47 before an encoder existed. Capture at
  // whatever the screen is and let the sender scale instead: that path is built for it and can use the GPU.
  const senderScaleFor = useCallback((target) => {
    const height = localStreamRef.current?.getVideoTracks()[0]?.getSettings?.().height
    if (!target || !Number.isFinite(height) || height <= target) return 1
    return Math.round((height / target) * 100) / 100
  }, [])
  const readTransmissionSettings = useCallback(() => ({
    fps,
    maxBitrate: MAX_BITRATE_PER_VIEWER,
    scaleResolutionDownBy: senderScaleFor(resolutions[resolution].height),
  }), [fps, resolution, senderScaleFor])
  useEffect(() => {
    transmissionSettingsRef.current = readTransmissionSettings()
    for (const entry of pcsRef.current.values()) entry.configureSender?.()
    const track = localStreamRef.current?.getVideoTracks()[0]
    if (!track || track.readyState !== 'live') return
    captureSettingsQueue.current = captureSettingsQueue.current.catch(() => {}).then(async () => {
      if (track !== localStreamRef.current?.getVideoTracks()[0] || track.readyState !== 'live') return
      try {
        await track.applyConstraints({ frameRate: { ideal: fps, max: fps } })
      } catch { setNotice('A origem não aceitou o novo FPS. A transmissão continua com a captura anterior.') }
    })
  }, [fps, resolution, readTransmissionSettings])
  const send = useCallback((message) => { if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify(message)) }, [])

  // One sweep across every peer we are transmitting to, only while the preview panel that shows the
  // result is open. Closing it stops the sampling; the numbers resume from the next sweep.
  useEffect(() => {
    if (!showSelfPreview) return
    const carries = new Map()
    let disposed = false
    const sweep = async () => {
      for (const [connectionId, entry] of pcsRef.current) {
        if (disposed) return
        if (entry.role !== 'transmitter') continue
        if (!carries.has(connectionId)) carries.set(connectionId, {})
        await collectRouteStatsRef.current(connectionId, entry.pc, carries.get(connectionId))()
      }
    }
    sweep()
    const timer = setInterval(sweep, 1000)
    return () => { disposed = true; clearInterval(timer) }
  }, [showSelfPreview])

  const closeConnection = useCallback((connectionId, notify = false) => {
    const entry = pcsRef.current.get(connectionId)
    if (!entry) { setRemoteScreens((current) => { const next = { ...current }; delete next[connectionId]; return next }); return }
    if (notify) send({ type: 'stop', to: entry.peerId, connectionId })
    clearInterval(statsRef.current.get(connectionId)); statsRef.current.delete(connectionId); clearTimeout(entry.disconnectTimer); clearTimeout(entry.fallbackTimer); clearTimeout(entry.restartRetry)
    entry.pc.close(); pcsRef.current.delete(connectionId)
    if (entry.role === 'viewer') setRemoteScreens((current) => { const next = { ...current }; delete next[connectionId]; return next })
    else setViewers((current) => { const next = { ...current }; delete next[connectionId]; return next })
  }, [send])

  const stopSharing = useCallback((notify = true) => {
    if (localStreamRef.current) mediaEvents.record('broadcast-stopped')
    for (const [id, entry] of pcsRef.current) if (entry.role === 'transmitter') closeConnection(id, notify)
    localStreamRef.current?.getTracks().forEach((track) => track.stop()); localStreamRef.current = null
    window.electronAPI?.stopWindowAudio?.()
    setShowSelfPreview(false)
    setAudioStatus('idle')
    setBroadcasting(false)
    send({ type: 'broadcast-stop' }); setViewers({}); setNotice('Sua transmissão foi encerrada. As telas que você assiste continuam abertas.')
  }, [closeConnection, send])
  const closeAll = useCallback(() => {
    if (localStreamRef.current) mediaEvents.record('capture-closed-with-room')
    earlyCandidatesRef.current.clear()
    for (const id of [...pcsRef.current.keys()]) closeConnection(id, false)
    localStreamRef.current?.getTracks().forEach((track) => track.stop()); localStreamRef.current = null
    setAudioStatus('idle')
    setBroadcasting(false)
  }, [closeConnection])

  // A capture nobody is watching burns GPU and, on relay, quota. Never let one outlive the room.
  useEffect(() => {
    if (!broadcasting || Object.keys(viewers).length) return
    const timer = setTimeout(() => {
      stopSharing(true)
      setNotice('Sua transmissão foi encerrada automaticamente: ficou 5 minutos sem nenhum espectador.')
    }, 5 * 60_000)
    return () => clearTimeout(timer)
  }, [broadcasting, viewers, stopSharing])

  const createPeer = useCallback((connectionId, peerId, role, mode = 'auto') => {
    const pc = new RTCPeerConnection(buildIceConfiguration(iceServersRef.current, initialIceStage(mode), mode === 'turn'))
    const entry = { pc, peerId, role, mode, pendingCandidates: earlyCandidatesRef.current.get(connectionId) || [], disconnectTimer: null, restarting: false, settled: false }; earlyCandidatesRef.current.delete(connectionId); pcsRef.current.set(connectionId, entry)
    entry.iceDiagnostics = { gathered: 0, received: entry.pendingCandidates.length, applied: 0, rejected: 0, errors: [] }
    entry.turnTransport = initialIceStage(mode)
    pc.onicecandidateerror = (event) => {
      // Never store candidate addresses, URLs, SDP, or error text (may contain IPs).
      entry.iceDiagnostics.errors.push({ time: Date.now(), code: event.errorCode })
      entry.iceDiagnostics.errors = entry.iceDiagnostics.errors.slice(-12)
    }
    const failConnection = () => {
      const reason = pc.remoteDescription ? 'ice-timeout' : 'signaling-timeout'
      send({ type: 'stop', to: peerId, connectionId, reason })
      closeConnection(connectionId, false)
      setNotice('A conexão expirou. O espectador recebeu o diagnóstico; a sua captura continua ativa.')
    }
    entry.restart = async () => {
      if (entry.restarting || pc.connectionState === 'closed') return false
      if (pc.signalingState !== 'stable') {
        // Negotiation is in flight: retry instead of dropping the restart on the floor.
        clearTimeout(entry.restartRetry); entry.restartRetry = setTimeout(() => entry.restart(), 1_000)
        return false
      }
      entry.restarting = true
      try {
        pc.restartIce()
        const offer = await pc.createOffer({ iceRestart: true }); await pc.setLocalDescription(offer)
        send({ type: 'signal', to: peerId, connectionId, mode: entry.mode, turnTransport: entry.turnTransport, allowDirect: entry.autoFallback === true, description: pc.localDescription })
        return true
      } catch { entry.restarting = false; return false }
    }
    pc.onicecandidate = ({ candidate }) => { if (candidate) { entry.iceDiagnostics.gathered++; send({ type: 'signal', to: peerId, connectionId, candidate: candidate.toJSON() }) } }
    pc.oniceconnectionstatechange = () => {
      if (['connected', 'completed'].includes(pc.iceConnectionState)) {
        clearTimeout(entry.disconnectTimer); entry.disconnectTimer = null
        // A working route must never be escalated by a timer that is still armed.
        clearTimeout(entry.fallbackTimer); entry.fallbackTimer = null
        entry.restarting = false; entry.settled = true
      }
      if (pc.iceConnectionState === 'failed') {
        if (role === 'transmitter') {
          entry.settled = false
          entry.restart()
          // Success cleared the initial timer. Recovery also needs a bounded
          // attempt; otherwise subsequent failures never reach fallback again.
          if (!entry.fallbackTimer) entry.fallbackTimer = setTimeout(advanceFallback, 30_000)
        } else send({ type: 'restart-request', to: peerId, connectionId })
      }
      if (pc.iceConnectionState === 'disconnected' && !entry.disconnectTimer) entry.disconnectTimer = setTimeout(() => {
        entry.disconnectTimer = null
        if (pc.iceConnectionState === 'disconnected') role === 'transmitter' ? entry.restart() : send({ type: 'restart-request', to: peerId, connectionId })
      }, 5_000)
    }
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'closed' && pcsRef.current.get(connectionId)?.pc === pc) closeConnection(connectionId, false) }
    const advanceFallback = () => {
      if (['connected', 'completed'].includes(pc.iceConnectionState) || pc.connectionState === 'closed') return
      // A route that already carried media is having a blip, not a routing failure. Wait for the ICE
      // restart to recover it instead of pinning the viewer to a relay for the rest of the session.
      if (entry.settled && pc.iceConnectionState !== 'failed') { entry.fallbackTimer = setTimeout(advanceFallback, 15_000); return }
      if (mode !== 'p2p' && entry.turnTransport !== 'all' && iceServersRef.current.some((server) => JSON.stringify(server.urls).includes('turn'))) {
        const nextStage = entry.turnTransport === 'direct' ? 'udp' : 'all'
        try {
          pc.setConfiguration(buildIceConfiguration(iceServersRef.current, nextStage, mode !== 'auto', pc.getConfiguration()))
        } catch {
          failConnection()
          setNotice('Não foi possível configurar a conexão auxiliar. A visualização foi encerrada; sua captura continua ativa.')
          return
        }
        entry.mode = 'turn'; entry.autoFallback = mode === 'auto'; entry.restarting = false
        entry.turnTransport = nextStage
        entry.restart()
        // Relay over UDP needs room to complete; rushing this stage is what lets TCP win the race.
        entry.fallbackTimer = setTimeout(advanceFallback, 30_000)
      } else {
        failConnection()
      }
    }
    if (role === 'transmitter') entry.fallbackTimer = setTimeout(advanceFallback, mode === 'auto' ? 8_000 : 30_000)
    return entry
  }, [closeConnection, send])

  const startStats = useCallback((connectionId, pc) => {
    let previousBytes = null
    let previousAt = null
    const timer = setInterval(async () => {
      try {
        let measured = null; let pair = null; let receivedMbps = null; let packetLoss = null; const stats = await pc.getStats()
        stats.forEach((report) => {
          if (report.type === 'transport' && report.selectedCandidatePairId) pair = stats.get(report.selectedCandidatePairId)
          if (!pair && report.type === 'candidate-pair' && report.state === 'succeeded' && (report.selected || report.nominated)) pair = report
          if (report.type === 'inbound-rtp' && report.kind === 'video') {
            if (Number.isFinite(report.framesPerSecond)) measured = report.framesPerSecond
            const received = Math.max(0, Number(report.packetsReceived) || 0); const lost = Math.max(0, Number(report.packetsLost) || 0)
            if (received + lost > 0) packetLoss = Math.round((lost / (received + lost)) * 1000) / 10
            if (Number.isFinite(report.bytesReceived) && previousAt !== null && report.timestamp > previousAt) receivedMbps = Math.round(((report.bytesReceived - previousBytes) * 8 / (report.timestamp - previousAt) / 1000) * 10) / 10
            if (Number.isFinite(report.bytesReceived)) { previousBytes = report.bytesReceived; previousAt = report.timestamp }
          }
        })
        const local = pair ? stats.get(pair.localCandidateId) : null; const remote = pair ? stats.get(pair.remoteCandidateId) : null
        const route = pair ? local?.candidateType === 'relay' || remote?.candidateType === 'relay' ? 'turn' : 'p2p' : null
        const protocol = String(local?.protocol || remote?.protocol || '').toUpperCase()
        const rttMs = Number.isFinite(pair?.currentRoundTripTime) ? Math.round(pair.currentRoundTripTime * 1000) : null
        setRemoteScreens((current) => current[connectionId] ? { ...current, [connectionId]: { ...current[connectionId], ...(Number.isFinite(measured) ? { fps: Math.round(measured) } : {}), route, protocol, rttMs, receivedMbps, packetLoss } } : current)
        // Static content can produce no frames; ICE state handles actual connectivity failures.
      } catch { /* optional browser statistics */ }
    }, 1000)
    statsRef.current.set(connectionId, timer)
  }, [])

  // Everything this produces is read in one place: the "Ver minha transmissão" panel. It used to run a
  // getStats() sweep every second, for every viewer, for the whole broadcast — the heaviest sampling left
  // in the app, on the machine already doing the capturing and encoding, to keep a line of text current
  // that nobody was looking at. Now it runs while that panel is open and not otherwise.
  const collectRouteStatsRef = useRef(null)
  const collectRouteStats = (connectionId, pc, carry) => {
    const inspect = async () => {
      try {
        const stats = await pc.getStats()
        let pair = null; let outboundFps = null; let limitation = null; let sentMbps = null
        let { previousFrames = null, previousBytes = null, previousAt = null } = carry
        stats.forEach((report) => {
          if (report.type === 'transport' && report.selectedCandidatePairId) pair = stats.get(report.selectedCandidatePairId)
          if (!pair && report.type === 'candidate-pair' && report.state === 'succeeded' && (report.selected || report.nominated)) pair = report
          if (report.type === 'outbound-rtp' && report.kind === 'video') {
            if (Number.isFinite(report.framesPerSecond)) outboundFps = Math.round(report.framesPerSecond)
            if (report.qualityLimitationReason && report.qualityLimitationReason !== 'none') limitation = report.qualityLimitationReason
            if (Number.isFinite(report.framesEncoded) && Number.isFinite(report.bytesSent) && previousAt !== null && report.timestamp > previousAt) {
              const elapsed = report.timestamp - previousAt
              outboundFps = Math.round((report.framesEncoded - previousFrames) * 1000 / elapsed)
              sentMbps = Math.round(((report.bytesSent - previousBytes) * 8 / elapsed / 1000) * 10) / 10
            }
            if (Number.isFinite(report.framesEncoded) && Number.isFinite(report.bytesSent)) { previousFrames = report.framesEncoded; previousBytes = report.bytesSent; previousAt = report.timestamp }
            Object.assign(carry, { previousFrames, previousBytes, previousAt })
          }
        })
        if (!pair) return
        const local = stats.get(pair.localCandidateId); const remote = stats.get(pair.remoteCandidateId)
        const route = local?.candidateType === 'relay' || remote?.candidateType === 'relay' ? 'turn' : 'p2p'
        const protocol = String(local?.protocol || remote?.protocol || '').toUpperCase()
        const rttMs = Number.isFinite(pair.currentRoundTripTime) ? Math.round(pair.currentRoundTripTime * 1000) : null
        const availableMbps = Number.isFinite(pair.availableOutgoingBitrate) ? Math.round(pair.availableOutgoingBitrate / 100_000) / 10 : null
        setViewers((current) => current[connectionId] ? { ...current, [connectionId]: { ...current[connectionId], route, protocol, rttMs, availableMbps, sentMbps, limitation, ...(Number.isFinite(outboundFps) ? { fps: outboundFps } : {}) } } : current)
      } catch { /* route statistics are optional on older browsers */ }
    }
    return inspect
  }
  collectRouteStatsRef.current = collectRouteStats

  const handleSignal = useCallback(async (message) => {
    let entry, phase = 'create-receiver'
    try {
      entry = pcsRef.current.get(message.connectionId)
      if (!entry) {
        if (message.description?.type !== 'offer') {
          if (message.candidate && earlyCandidatesRef.current.size < 32) {
            const pending = earlyCandidatesRef.current.get(message.connectionId) || []
            if (pending.length < 64) pending.push(message.candidate)
            earlyCandidatesRef.current.set(message.connectionId, pending)
          }
          return
        }
        entry = createPeer(message.connectionId, message.from, 'viewer', message.mode || 'auto')
        entry.pc.ontrack = ({ streams, track }) => {
          setRemoteScreens((current) => {
            const existing = current[message.connectionId]
            const stream = streams[0] || existing?.stream || new MediaStream()
            if (!stream.getTracks().some((item) => item.id === track.id)) stream.addTrack(track)
            return { ...current, [message.connectionId]: { ...existing, peerId: message.from, waiting: false, stream, hasAudio: track.kind === 'audio' || Boolean(existing?.hasAudio) } }
          })
          if (track.kind === 'video') startStats(message.connectionId, entry.pc)
        }
        setRemoteScreens((current) => ({ ...current, [message.connectionId]: { peerId: message.from, waiting: false, stream: null, hasAudio: false } }))
      }
      if (message.description) {
        if (message.description.type === 'offer' && ['auto', 'turn', 'p2p'].includes(message.mode)) {
          phase = 'configure-receiver-ice'
          entry.mode = message.mode; entry.autoFallback = message.mode === 'auto' || message.allowDirect === true
          entry.turnTransport = message.mode === 'p2p' ? 'direct' : ['direct', 'udp', 'all'].includes(message.turnTransport) ? message.turnTransport : initialIceStage(message.mode)
          entry.pc.setConfiguration(buildIceConfiguration(iceServersRef.current, entry.turnTransport, message.mode === 'turn' && !entry.autoFallback, entry.pc.getConfiguration()))
        }
        phase = 'set-remote-description'
        await entry.pc.setRemoteDescription(message.description)
        if (message.description.type === 'answer') { entry.restarting = false; await entry.configureSender?.() }
        for (const candidate of entry.pendingCandidates.splice(0)) {
          try { await entry.pc.addIceCandidate(candidate); entry.iceDiagnostics.applied++ }
          catch { entry.iceDiagnostics.rejected++ /* A stale ICE generation must not kill a live stream. */ }
        }
        if (message.description.type === 'offer') {
          phase = 'create-answer'; const answer = await entry.pc.createAnswer()
          phase = 'set-local-answer'; await entry.pc.setLocalDescription(answer)
          send({ type: 'signal', to: message.from, connectionId: message.connectionId, description: entry.pc.localDescription })
        }
      } else if (message.candidate) {
        entry.iceDiagnostics.received++
        if (entry.pc.remoteDescription) {
          try { await entry.pc.addIceCandidate(message.candidate); entry.iceDiagnostics.applied++ }
          catch { entry.iceDiagnostics.rejected++ }
        } else if (entry.pendingCandidates.length < 64) entry.pendingCandidates.push(message.candidate)
      }
    } catch (error) {
      recordPeerFailure(phase, error, entry?.pc)
      closeConnection(message.connectionId, false)
      setNotice(`Uma das transmissões não conseguiu conectar (${phase}). O motivo foi registrado no relatório de diagnóstico.`)
    }
  }, [closeConnection, createPeer, send, startStats])

  useEffect(() => {
    if (!joined) return
    let disposed = false; let reconnectAttempt = 0; let reconnectTimer; let heartbeatTimer
    const connect = () => {
      if (disposed) return
      const socketUrl = new URL(SIGNAL_URL); if (accessSession) socketUrl.searchParams.set('session', accessSession)
      const socket = new WebSocket(socketUrl); socketRef.current = socket; setConnection('connecting')
      socket.onopen = () => {
        if (disposed) return socket.close()
        reconnectAttempt = 0; setConnection('online'); socket.send(JSON.stringify({ type: 'hello', name }))
        clearInterval(heartbeatTimer); heartbeatTimer = setInterval(() => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'heartbeat' })) }, 20_000)
        setNotice('Conectado. Somente pessoas desta sala podem ver você.')
      }
      socket.onclose = (event) => {
        clearInterval(heartbeatTimer)
        if (disposed) return
        if (socketRef.current === socket) socketRef.current = null
        if (event.code === 1008) { setConnection('offline'); setUsers([]); closeAll(); setAccessSession(''); setJoined(false); setNotice('Sua entrada na sala expirou. Entre novamente.'); return }
        const delay = Math.min(1_000 * (2 ** reconnectAttempt++), 10_000)
        setConnection('connecting'); setNotice('Sinalização interrompida. Reconectando sem encerrar as transmissões…')
        reconnectTimer = setTimeout(connect, delay)
      }
      socket.onerror = () => { if (!disposed) setNotice('Oscilação no servidor de sinalização. Tentando reconectar…') }
      socket.onmessage = ({ data }) => {
        let message; try { message = JSON.parse(data) } catch { return }
        if (message.type === 'welcome') { setSelfId(message.id); setModerationRole(message.role); setIsAdmin(['owner', 'admin', 'superadmin'].includes(message.role)); setRoomName(message.roomName) }
        else if (message.type === 'users') {
          const nextIds = new Set(message.users.map((user) => user.id))
          if (knownUsersRef.current && message.users.some((user) => user.id !== selfId && !knownUsersRef.current.has(user.id))) playChime('join')
          knownUsersRef.current = nextIds
          setUsers(message.users)
        }
        else if (message.type === 'watch-request') { if (localStreamRef.current) playChime('viewer'); shareWith(message.from, message.mode) }
        else if (message.type === 'signal') { setRemoteScreens((current) => { const next = { ...current }; delete next[`waiting-${message.from}`]; return next }); signalQueueRef.current = signalQueueRef.current.then(() => handleSignal(message)).catch(() => {}) }
        else if (message.type === 'restart-request') pcsRef.current.get(message.connectionId)?.restart?.()
        else if (message.type === 'stop') {
          closeConnection(message.connectionId, false)
          if (message.reason) setRemoteScreens((current) => ({ ...current, [message.connectionId]: { peerId: message.from, error: message.reason === 'ice-timeout' ? 'A negociação terminou, mas a conexão de rede não foi estabelecida em 30 segundos. Feche esta janela e tente outro modo.' : 'A negociação não recebeu resposta a tempo. Feche esta janela, atualizem ambos o app e tentem novamente.' } }))
          setNotice('Visualização encerrada. Se não conectou, consulte o diagnóstico na janela.')
        }
        else if (message.type === 'peer-left') { for (const [id, entry] of pcsRef.current) if (entry.peerId === message.id) closeConnection(id, false); setRemoteScreens((current) => Object.fromEntries(Object.entries(current).filter(([, value]) => value.peerId !== message.id))) }
        else if (message.type === 'kicked' || message.type === 'banned') { setAccessSession(''); setJoined(false); setNotice(message.type === 'banned' ? 'Você foi banido da sala.' : 'Você foi removido da sala.') }
        else if (message.type === 'error') setNotice(message.message)
      }
    }
    connect()
    return () => { disposed = true; clearTimeout(reconnectTimer); clearInterval(heartbeatTimer); socketRef.current?.close(); socketRef.current = null; knownUsersRef.current = null; closeAll() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joined])

  useEffect(() => {
    if (!joined || !accessSession) return
    let disposed = false
    const refreshTurnAccess = async () => {
      try {
        const response = await fetch('/api/ice-servers', { headers: { authorization: `Bearer ${accessSession}` } })
        const result = await response.json()
        if (disposed || !response.ok || !Array.isArray(result.iceServers)) return
        const hadTurn = iceServersRef.current.some((entry) => JSON.stringify(entry.urls).includes('turn:') || JSON.stringify(entry.urls).includes('turns:'))
        iceServersRef.current = result.iceServers.length ? result.iceServers : staticIceServers()
        if (hadTurn && !result.turnEnabled) {
          await Promise.all([...pcsRef.current].map(async ([id, entry]) => {
            let preserve = false
            try { preserve = await canPreserveWithoutTurn(entry.pc) } catch { /* Unknown relay usage: fail closed. */ }
            if (disposed || pcsRef.current.get(id) !== entry) return
            if (!preserve) { closeConnection(id, true); return }
            // Direct-only peers need no restart. For a direct pair that also had
            // relay candidates, start a STUN-only generation to retire those.
            if (entry.turnTransport !== 'direct') {
              try {
                entry.pc.setConfiguration(buildIceConfiguration(iceServersRef.current, 'direct', false, entry.pc.getConfiguration()))
                entry.turnTransport = 'direct'
                entry.mode = 'p2p'; entry.autoFallback = false
                if (entry.role === 'transmitter') entry.restart()
                else send({ type: 'restart-request', to: entry.peerId, connectionId: id })
              } catch { closeConnection(id, true) }
            }
          }))
          setNotice(result.reason === 'monthly-limit' ? 'O limite mensal de segurança do servidor auxiliar foi atingido. O P2P continua disponível.' : 'O servidor auxiliar foi desativado por segurança. O P2P continua disponível.')
        }
      } catch { /* a ausência de resposta nunca habilita TURN */ }
    }
    refreshTurnAccess()
    const timer = setInterval(refreshTurnAccess, 5 * 60 * 1000)
    return () => { disposed = true; clearInterval(timer) }
  }, [accessSession, closeConnection, joined, send])

  const loginSite = async (event) => {
    event.preventDefault(); const cleanName = name.trim()
    if (cleanName.length < 2) return setAccessError('Use um nome com pelo menos 2 caracteres.')
    setJoining(true); setAccessError('')
    try {
      const response = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: cleanName, adminPassword: adminMode ? password : '' }) })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Não foi possível entrar.')
      localStorage.setItem('screen-share-site-session', result.session); localStorage.setItem('screen-share-name', cleanName)
      setSiteSession(result.session); setSiteRole(result.role); setName(cleanName); setPassword(''); setAdminMode(false)
    } catch (error) { setAccessError(error.message) } finally { setJoining(false) }
  }
  const authHeaders = useCallback((json = false) => ({ authorization: `Bearer ${siteSession}`, ...(json ? { 'content-type': 'application/json' } : {}) }), [siteSession])
  const loadRooms = useCallback(async () => {
    try {
      const response = await fetch('/api/rooms', { headers: authHeaders() }); const result = await response.json()
      if (response.status === 401) { localStorage.removeItem('screen-share-site-session'); setSiteSession(''); return }
      if (!response.ok) throw new Error(); setRooms(result.rooms || []); setSiteRole(result.role || 'member')
    } catch { setAccessError('Não foi possível carregar as salas agora.') }
  }, [authHeaders])
  useEffect(() => {
    if (!siteSession || joined) return
    loadRooms()
    const timer = setInterval(loadRooms, 3_000)
    return () => clearInterval(timer)
  }, [siteSession, joined, loadRooms])
  const joinRoom = async (room, chosenPassword = roomPassword) => {
    setJoining(true); setAccessError('')
    try {
      const response = await fetch(`/api/rooms/${encodeURIComponent(room.id)}/join`, { method: 'POST', headers: authHeaders(true), body: JSON.stringify({ password: chosenPassword }) }); const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Não foi possível entrar na sala.')
      try {
        const iceResponse = await fetch('/api/ice-servers', { headers: { authorization: `Bearer ${result.session}` } })
        const iceResult = await iceResponse.json()
        if (iceResponse.ok && Array.isArray(iceResult.iceServers) && iceResult.iceServers.length) iceServersRef.current = iceResult.iceServers
      } catch { /* STUN/P2P remains available when TURN configuration is unavailable */ }
      setAccessSession(result.session); setRoomName(result.roomName); setRoomPassword(''); setSelectedRoom(null); setJoined(true)
    } catch (error) { setAccessError(error.message) } finally { setJoining(false) }
  }
  const createRoom = async (event) => {
    event.preventDefault(); setJoining(true); setAccessError('')
    try {
      const response = await fetch('/api/rooms', { method: 'POST', headers: authHeaders(true), body: JSON.stringify({ roomName: newRoomName, password: newRoomPassword }) }); const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Não foi possível criar a sala.')
      setCreatingRoom(false); setNewRoomName(''); await loadRooms(); await joinRoom(result.room, newRoomPassword); setNewRoomPassword('')
    } catch (error) { setAccessError(error.message); setJoining(false) }
  }
  const leaveRoom = () => { stopSharing(false); socketRef.current?.close(); knownUsersRef.current = null; setAccessSession(''); setRoomName(''); setJoined(false); setUsers([]); setRemoteScreens({}); setNotice('Você saiu da sala.') }
  const logoutSite = () => { leaveRoom(); localStorage.removeItem('screen-share-site-session'); setSiteSession(''); setSiteRole('member'); setAccessError('') }

  const getCapture = async () => {
    if (localStreamRef.current?.getVideoTracks()[0]?.readyState === 'live') return localStreamRef.current
    // No width or height here on purpose: see senderScaleFor. The chosen resolution is applied to the
    // sender once the track exists, so the capture keeps the screen's own size and stays cheap.
    const video = { frameRate: { ideal: fps, max: fps }, displaySurface: 'monitor' }
    let stream
    const picker = { selfBrowserSurface: 'exclude', surfaceSwitching: 'exclude' }
    if (shareAudio) {
      try { stream = await navigator.mediaDevices.getDisplayMedia({ ...picker, video, audio: audioConstraints, systemAudio: 'include', windowAudio: 'window', surfaceSwitching: 'include' }) }
      catch (error) {
        if (error?.name === 'NotAllowedError') throw error
        stream = await navigator.mediaDevices.getDisplayMedia({ video, audio: true })
      }
    } else stream = await navigator.mediaDevices.getDisplayMedia({ ...picker, video, audio: false })
    if (shareAudio && !stream.getAudioTracks().length) await attachDesktopWindowAudio(stream, (reason) => { setAudioStatus('unavailable'); setNotice(`O áudio isolado da janela falhou (${reason || 'erro desconhecido'}). O vídeo continua sem áudio.`) })
    localStreamRef.current = stream
    // The scale factor needs the real capture size, which only exists now, and the first viewer can
    // arrive before the settings effect runs again.
    transmissionSettingsRef.current = readTransmissionSettings()
    try { stream.getVideoTracks()[0].contentHint = 'motion' } catch { /* optional capture hint */ }
    const audioTrack = stream.getAudioTracks()[0]
    setAudioStatus(audioTrack ? 'on' : shareAudio ? 'unavailable' : 'off')
    if (audioTrack) audioTrack.onended = () => setAudioStatus('unavailable')
    const videoTrack = stream.getVideoTracks()[0]
    mediaEvents.record('capture-started', videoTrack.getSettings())
    videoTrack.onended = () => {
      // An old capture finishing must never stop a replacement stream.
      if (localStreamRef.current !== stream) return
      mediaEvents.record('capture-ended', { ...videoTrack.getSettings(), readyState: videoTrack.readyState })
      stopSharing(true)
      setNotice('A fonte de captura foi encerrada pelo navegador ou sistema (ou pelo controle de compartilhamento). O evento foi registrado no relatório de diagnóstico; inicie a captura novamente.')
    }
    return stream
  }
  const startBroadcast = async () => {
    try {
      const stream = await getCapture(); send({ type: 'broadcast-start' }); setBroadcasting(true)
      setNotice(!shareAudio ? 'Sua transmissão está disponível para todos na sala (sem áudio).'
        : stream.getAudioTracks().length ? 'Sua transmissão está disponível para todos na sala, com o áudio do que você escolheu compartilhar.'
        : 'Transmissão iniciada, mas a origem escolhida não forneceu áudio. Tente uma aba ou use uma opção de áudio oferecida pelo navegador.')
    }
    catch (error) { setNotice(error?.name === 'NotAllowedError' ? 'Você cancelou a escolha da tela.' : 'Não foi possível iniciar a captura.') }
  }
  const shareWith = async (peerId, mode = 'auto') => {
    let entry, phase = 'create-sender'
    const connectionId = crypto.randomUUID()
    try {
      const stream = localStreamRef.current; if (!stream) return
      entry = createPeer(connectionId, peerId, 'transmitter', mode); const videoTrack = stream.getVideoTracks()[0]
      const sender = entry.pc.addTrack(videoTrack, stream)
      phase = 'select-codec'
      entry.videoCodec = await preferHardwareVideoCodecs(entry.pc, sender, preferredCodecRef.current, transmissionSettingsRef.current)
      if (entry.pc.signalingState === 'closed' || localStreamRef.current !== stream || videoTrack.readyState === 'ended') { closeConnection(connectionId); return }
      let settingsQueue = Promise.resolve()
      const configureSender = () => {
        settingsQueue = settingsQueue.catch(() => {}).then(async () => {
          if (entry.pc.connectionState === 'closed') return
          try {
            const settings = { ...transmissionSettingsRef.current }
            if (await applySenderSettings(sender, settings)) entry.appliedSettings = settings
          } catch (error) { recordPeerFailure('set-sender-parameters', error, entry.pc); setNotice('Este navegador não aceitou os limites de envio; usando adaptação padrão.') }
        })
        return settingsQueue
      }
      entry.configureSender = configureSender
      await configureSender()
      const audioTrack = stream.getAudioTracks()[0]
      if (audioTrack) {
        const audioSender = entry.pc.addTrack(audioTrack, stream)
        try { const parameters = audioSender.getParameters(); parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}]; parameters.encodings[0].maxBitrate = 256_000; await audioSender.setParameters(parameters) } catch { /* best effort */ }
      }
      phase = 'create-offer'
      const offer = await entry.pc.createOffer()
      const settings = transmissionSettingsRef.current
      // Open above Chromium's 0.3 Mbps so the first seconds are watchable, but modestly: the ceiling the
      // user picked describes their uplink, not the relay path in the middle, and overshooting it costs
      // resolution for as long as the estimator takes to recover.
      offer.sdp = withStartBitrate(offer.sdp, Math.min(2500, Math.round(settings.maxBitrate / 1000 / 4)))
      phase = 'set-local-offer'
      await entry.pc.setLocalDescription(offer); send({ type: 'signal', to: peerId, connectionId, mode, turnTransport: entry.turnTransport, description: entry.pc.localDescription })
      setViewers((current) => ({ ...current, [connectionId]: { peerId, route: 'connecting' } })); setNotice('Novo espectador conectado à sua transmissão.')
    } catch (error) {
      recordPeerFailure(phase, error, entry?.pc)
      if (entry) closeConnection(connectionId)
      setNotice(`Não foi possível conectar o novo espectador (${phase}). ${localStreamRef.current?.getVideoTracks()[0]?.readyState === 'live' ? 'Sua captura continua ativa. ' : ''}O motivo foi registrado no relatório de diagnóstico.`)
    }
  }
  const watch = (user) => { setRemoteScreens((current) => ({ ...current, [`waiting-${user.id}`]: { peerId: user.id, waiting: true } })); send({ type: 'watch-request', to: user.id, mode: watchMode }); setNotice(`Conectando à tela de ${user.name}…`) }
  const moderate = (user, action) => send({ type: 'moderate', to: user.id, action })

  const peers = useMemo(() => users.filter((user) => user.id !== selfId), [users, selfId])
  const userName = (id) => users.find((user) => user.id === id)?.name || 'amigo'
  const remoteEntries = Object.entries(remoteScreens)
  const viewerNames = [...new Set(Object.values(viewers).map((viewer) => userName(viewer.peerId)))]
  const viewerRoutes = [...new Set(Object.values(viewers).map((viewer) => viewer.route).filter((route) => route && route !== 'connecting'))]
  const routeBaseLabel = !viewerNames.length ? 'sem espectadores' : viewerRoutes.length === 0 ? 'detectando conexão' : viewerRoutes.length > 1 ? 'conexão mista: P2P + TURN' : viewerRoutes[0] === 'turn' ? 'servidor auxiliar (TURN)' : 'conexão direta P2P'
  const routeDetails = Object.values(viewers).map((viewer) => `${userName(viewer.peerId)}: ${[viewer.route === 'turn' ? 'TURN' : viewer.route === 'p2p' ? 'P2P' : '', viewer.protocol, Number.isFinite(viewer.fps) ? `${viewer.fps} FPS` : '', Number.isFinite(viewer.sentMbps) ? `${viewer.sentMbps} Mbps enviados` : '', Number.isFinite(viewer.rttMs) ? `${viewer.rttMs} ms` : '', Number.isFinite(viewer.availableMbps) ? `${viewer.availableMbps} Mbps disponíveis` : '', viewer.limitation ? `limite: ${viewer.limitation}` : ''].filter(Boolean).join(' · ')}`)
  const routeLabel = `${routeBaseLabel}${routeDetails.length ? ` · ${routeDetails.join(' / ')}` : ''}`
  const outboundFpsValues = Object.values(viewers).map((viewer) => viewer.fps).filter(Number.isFinite)
  const outboundFpsLabel = outboundFpsValues.length ? Math.min(...outboundFpsValues) === Math.max(...outboundFpsValues) ? `~${outboundFpsValues[0]} FPS enviados` : `~${Math.min(...outboundFpsValues)}–${Math.max(...outboundFpsValues)} FPS enviados` : ''

  if (!siteSession) return <main className="shell login-shell"><section className="login-card"><div className="brand-mark"><MonitorUp size={28} /></div><p className="eyebrow">EntreTelas</p><h1>Entre para encontrar seus amigos.</h1><p className="intro">Usuários comuns precisam apenas escolher um nome. As salas continuam protegidas por suas próprias senhas.</p><form className="login-form" onSubmit={loginSite}><label htmlFor="name">Seu nome de usuário</label><input id="name" value={name} onChange={(event) => setName(event.target.value)} maxLength={32} placeholder="Ex.: Diego" autoFocus />{adminMode && <><label htmlFor="password">Senha administrativa</label><input id="password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} maxLength={128} placeholder="Senha de ADM" autoComplete="current-password" autoFocus /></>}<button type="submit" disabled={joining}>{joining ? 'Entrando…' : adminMode ? 'Entrar como ADM' : 'Entrar no EntreTelas'}</button><button type="button" className="admin-login-toggle" onClick={() => { setAdminMode((current) => !current); setPassword(''); setAccessError('') }}>{adminMode ? 'Voltar para usuário comum' : 'ADM'}</button>{accessError && <p className="access-error" role="alert">{accessError}</p>}</form><div className="login-links"><div className="trust-line"><ShieldCheck size={17} /><span>Dentro de uma sala, somente os participantes veem quem está presente.</span></div></div></section><BuildStamp /></main>

  if (!joined) return <main className="shell lobby-shell"><header><div className="brand"><div className="brand-mark small"><MonitorUp size={21} /></div><div><strong>EntreTelas</strong><span>Olá, {name}{siteRole === 'superadmin' ? ' · SUPER ADM' : siteRole === 'admin' ? ' · ADM' : ''}</span></div></div><button className="leave-room" onClick={logoutSite}><LogOut size={15} />Sair do site</button></header><section className="lobby-heading"><div><p className="eyebrow">Lobby privado</p><h1>Escolha uma sala</h1><p>Somente o nome da sala aparece aqui. Usuários e transmissões continuam ocultos até você entrar.</p></div><button className="create-room-button" onClick={() => { setCreatingRoom(true); setAccessError('') }}><Plus size={17} />Criar sala</button></section>{accessError && !selectedRoom && !creatingRoom && <p className="lobby-error">{accessError}</p>}<section className="rooms-grid">{rooms.length ? rooms.map((room) => <button className="room-card" key={room.id} onClick={() => { setSelectedRoom(room); setRoomPassword(''); setAccessError('') }}><div className="room-icon"><DoorOpen size={22} /></div><div><strong>{room.name}</strong><span>{siteRole === 'superadmin' ? 'Acesso de SUPER ADM' : 'Clique para informar a senha'}</span></div><KeyRound size={17} /></button>) : <div className="rooms-empty"><DoorOpen size={35} /><strong>Nenhuma sala criada</strong><span>Crie a primeira sala e compartilhe a senha somente com quem você quiser.</span></div>}</section><BuildStamp />{selectedRoom && <div className="modal-backdrop"><form className="modal room-modal" onSubmit={(event) => { event.preventDefault(); joinRoom(selectedRoom) }}><button type="button" className="modal-close" onClick={() => setSelectedRoom(null)}><X size={17} /></button><div className="request-icon"><KeyRound size={25} /></div><p className="eyebrow">Sala privada</p><h3>{selectedRoom.name}</h3>{siteRole === 'superadmin' ? <p>Você pode entrar usando sua permissão de SUPER ADM.</p> : <><label htmlFor="room-password">Senha da sala</label><input id="room-password" type="password" value={roomPassword} onChange={(event) => setRoomPassword(event.target.value)} autoFocus /></>} {accessError && <p className="access-error">{accessError}</p>}<button type="submit" disabled={joining}>{joining ? 'Entrando…' : siteRole === 'superadmin' ? 'Entrar como SUPER ADM' : 'Entrar na sala'}</button></form></div>}{creatingRoom && <div className="modal-backdrop"><form className="modal room-modal" onSubmit={createRoom}><button type="button" className="modal-close" onClick={() => setCreatingRoom(false)}><X size={17} /></button><div className="request-icon"><Plus size={25} /></div><p className="eyebrow">Nova sala</p><h3>Criar sala privada</h3><label htmlFor="new-room-name">Nome da sala</label><input id="new-room-name" value={newRoomName} onChange={(event) => setNewRoomName(event.target.value)} maxLength={40} autoFocus /><label htmlFor="new-room-password">Senha da sala</label><input id="new-room-password" type="password" value={newRoomPassword} onChange={(event) => setNewRoomPassword(event.target.value)} minLength={4} maxLength={128} />{accessError && <p className="access-error">{accessError}</p>}<button type="submit" disabled={joining}>{joining ? 'Criando…' : 'Criar e entrar'}</button></form></div>}</main>

  return <main className="shell"><header><div className="brand"><div className="brand-mark small"><MonitorUp size={21} /></div><div><strong>EntreTelas</strong><span>Sala · {roomName}</span></div></div><div className="header-actions"><div className={`connection ${connection}`}><span className="pulse" />{connection === 'online' ? <Wifi size={15} /> : <WifiOff size={15} />}{connection === 'online' ? 'Conectado' : connection === 'connecting' ? 'Conectando' : 'Offline'}</div><button className="leave-room" onClick={leaveRoom}><LogOut size={15} />Sair da sala</button></div></header>
    {diagnosticsEnabled && <MediaDiagnostics peers={pcsRef} localStream={localStreamRef} />}
    <BuildStamp />
    {showSelfPreview && localStreamRef.current && <SelfPreview stream={localStreamRef.current} routeLabel={routeLabel} outboundFpsLabel={outboundFpsLabel} onClose={() => setShowSelfPreview(false)} />}
    {!localStreamRef.current && <button className="start-broadcast standalone" onClick={startBroadcast}><Radio size={18} />Iniciar transmissão</button>}
    {localStreamRef.current && <div className="live-banner"><div><Radio size={18} /><strong>Você está transmitindo para {viewerNames.length} {viewerNames.length === 1 ? 'pessoa' : 'pessoas'}</strong><span>{viewerNames.join(', ')} · {resolutions[resolution].label} · preferência {fps} FPS · {audioStatus === 'on' ? 'com áudio' : audioStatus === 'unavailable' ? 'sem áudio (a origem escolhida não fornece som)' : 'sem áudio'}</span></div><div className="live-actions"><button className="preview-button" onClick={() => setShowSelfPreview(true)}><Eye size={17} />Ver minha transmissão</button><button className="danger" onClick={() => stopSharing(true)}><CircleStop size={17} />Parar para todos</button></div></div>}
    <section className="notice" aria-live="polite"><span className="notice-dot" />{notice}</section>
    <input className="quality-toggle-check" id="quality-toggle" type="checkbox" />
    <label className="size-control">Conexão para a próxima live<select value={watchMode} onChange={(event) => setWatchMode(event.target.value)}><option value="auto">Automático: P2P, depois TURN</option><option value="p2p">Somente P2P</option><option value="turn">Somente TURN</option></select><span>Escolha antes de clicar em Assistir. Não altera lives já abertas.</span></label>
    <div className="panel-toggles"><button type="button" className={`people-toggle${showPeople ? ' active' : ''}`} onClick={() => setShowPeople((current) => !current)} aria-expanded={showPeople}><Users size={16} /><span>{showPeople ? 'Fechar amigos' : `Amigos online · ${peers.length + 1}`}</span></button><label className="quality-toggle" htmlFor="quality-toggle"><SlidersHorizontal size={16} /><span>Configurar transmissão</span></label></div>
    <div className={`workspace multi-workspace${showPeople ? '' : ' people-hidden'}`}>
      {showPeople && <section className="panel people"><div className="panel-heading"><div><p className="eyebrow">Sala privada · {roomName}</p><h2>Amigos online</h2></div><span className="count"><Users size={15} />{peers.length + 1}</span></div><div className="people-list">{peers.length === 0 ? <div className="empty"><Users size={28} /><strong>Ninguém por aqui ainda</strong><span>Compartilhe o nome e a senha desta sala com seus amigos.</span></div> : peers.map((user) => <article className="person" key={user.id}><div className="avatar">{user.name.slice(0, 1).toUpperCase()}</div><div><strong>{user.name}{user.role === 'superadmin' ? ' · SUPER ADM' : user.role === 'admin' ? ' · ADM' : user.role === 'owner' ? ' · DONO' : ''}</strong><span><i className={user.broadcasting ? 'live-user' : ''} />{user.broadcasting ? ' transmitindo agora' : ' online'}</span></div><div className="person-actions"><button disabled={!user.broadcasting || Object.values(remoteScreens).some((screen) => screen.peerId === user.id)} onClick={() => watch(user)}><Cast size={16} />{user.broadcasting ? 'Assistir' : 'Sem tela'}</button>{isAdmin && roleRanks[moderationRole] > roleRanks[user.role] && <><button className="admin-action" title="Expulsar" onClick={() => moderate(user, 'kick')}><UserX size={15} /></button><button className="admin-action ban" title="Banir" onClick={() => moderate(user, 'ban')}><Ban size={15} /></button></>}</div></article>)}</div></section>}
      <section className="panel stage multi-stage"><div className="panel-heading stage-tools"><div><p className="eyebrow">Visualização simultânea</p><h2>{remoteEntries.length ? `${remoteEntries.length} ${remoteEntries.length === 1 ? 'tela aberta' : 'telas abertas'}` : 'As transmissões aparecerão aqui'}</h2></div><label className="size-control">Tamanho<select value={screenSize} onChange={(event) => setScreenSize(event.target.value)}><option value="small">Pequeno</option><option value="medium">Médio</option><option value="large">Grande</option></select></label></div><div className={`screens-grid grid-${screenSize}`}>{remoteEntries.length ? remoteEntries.map(([id, screen]) => <RemoteScreen key={id} screen={screen} size={screenSize} name={userName(screen.peerId)} onStop={() => id.startsWith('waiting-') ? setRemoteScreens((current) => { const next = { ...current }; delete next[id]; return next }) : closeConnection(id, true)} />) : <div className="multi-empty"><div className="screen-outline"><Cast size={35} /></div><strong>Pronto para várias telas</strong><span>Você pode assistir seus amigos enquanto continua transmitindo a sua.</span></div>}</div></section>
      <aside className="panel settings"><div className="panel-heading"><div><p className="eyebrow">Sua transmissão</p><h2>Qualidade</h2></div><SlidersHorizontal size={19} /></div><fieldset disabled={!!localStreamRef.current}><label>Resolução</label><div className="segmented">{Object.entries(resolutions).map(([key, value]) => <button type="button" className={resolution === key ? 'selected' : ''} key={key} onClick={() => setResolution(key)}>{value.label}</button>)}</div><p className="hint">A captura sempre usa o tamanho nativo da sua tela; a redução acontece no envio. Pedir um tamanho menor na captura obriga o navegador a encolher cada quadro e custa FPS antes mesmo de codificar.</p><label>FPS preferido</label><div className="segmented"><button type="button" className={fps === 30 ? 'selected' : ''} onClick={() => setFps(30)}>30</button><button type="button" className={fps === 60 ? 'selected' : ''} onClick={() => setFps(60)}>60</button></div><p className="hint">É uma preferência. O navegador, a tela e a GPU determinam o valor efetivo.</p><label>Codec de vídeo</label><div className="segmented five">{Object.entries(codecChoices).map(([key, label]) => <button type="button" className={preferredCodec === key ? 'selected' : ''} key={key} onClick={() => setPreferredCodec(key)}>{label}</button>)}</div><p className="hint">Automático prioriza os perfis que o navegador informa como eficientes. Confirme “Implementação” e “Encoder eficiente informado” durante uma transmissão com espectador; OpenH264 é software.</p><label>Áudio</label><div className="segmented"><button type="button" className={shareAudio ? 'selected' : ''} onClick={() => setShareAudio(true)}>Transmitir som</button><button type="button" className={!shareAudio ? 'selected' : ''} onClick={() => setShareAudio(false)}>Somente vídeo</button></div><p className="hint">Aba: somente o áudio dela, com o aviso de compartilhamento obrigatório do navegador. Janela: tentamos capturar apenas o som da janela quando o navegador oferecer essa opção. Tela inteira: áudio do sistema.</p></fieldset><div className="safety"><ShieldCheck size={18} /><p><strong>Entrada livre para assistir</strong><span>Quem estiver na sala pode clicar e acompanhar.</span></p></div></aside>
    </div>
  </main>
}
