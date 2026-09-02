import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Ban, Cast, CircleStop, DoorOpen, Expand, KeyRound, LogOut, MonitorUp, Plus, Radio, ShieldCheck, SlidersHorizontal, UserX, Users, Volume2, VolumeX, Wifi, WifiOff, X } from 'lucide-react'

const localHost = ['localhost', '127.0.0.1'].includes(location.hostname)
const defaultSignalHost = localHost ? `${location.hostname}:8787` : location.host
const SIGNAL_URL = import.meta.env.VITE_SIGNAL_URL || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${defaultSignalHost}`
const resolutions = { auto: { label: 'Auto' }, '720p': { label: '720p', width: 1280, height: 720 }, '1080p': { label: '1080p', width: 1920, height: 1080 }, '1440p': { label: '1440p', width: 2560, height: 1440 } }
const bitratePresets = { low: 2_500_000, medium: 8_000_000, high: 14_000_000 }
const bitrateLabels = { low: 'Baixa', medium: 'Média', high: 'Alta', custom: 'Personalizada' }
const iceServers = () => {
  const stun = (import.meta.env.VITE_STUN_URLS || 'stun:stun.l.google.com:19302').split(',').map((v) => v.trim()).filter(Boolean)
  const turn = (import.meta.env.VITE_TURN_URLS || '').split(',').map((v) => v.trim()).filter(Boolean)
  const servers = stun.length ? [{ urls: stun }] : []
  if (turn.length) servers.push({ urls: turn, username: import.meta.env.VITE_TURN_USERNAME || '', credential: import.meta.env.VITE_TURN_CREDENTIAL || '' })
  return servers
}
const audioConstraints = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2, sampleRate: 48000 }
function RemoteScreen({ screen, name, size, onStop }) {
  const videoRef = useRef(null)
  const [muted, setMuted] = useState(false)
  const [volume, setVolume] = useState(1)
  const [audioBlocked, setAudioBlocked] = useState(false)
  const play = useCallback(() => {
    const video = videoRef.current; if (!video) return
    video.play().then(() => setAudioBlocked(false)).catch(() => setAudioBlocked(!video.muted))
  }, [])
  useEffect(() => { const video = videoRef.current; if (!video) return; video.srcObject = screen.stream || null; if (screen.stream) play() }, [screen.stream, play])
  useEffect(() => { const video = videoRef.current; if (!video) return; video.muted = muted; video.volume = volume }, [muted, volume, screen.stream])
  const enableAudio = () => { const video = videoRef.current; if (!video) return; video.muted = false; setMuted(false); play() }
  const goFullscreen = () => { const frame = videoRef.current?.parentElement; return frame?.requestFullscreen?.() || videoRef.current?.webkitEnterFullscreen?.() }
  return <article className={`screen-card size-${size}`}>
    <div className="screen-card-head"><div><i /><strong>Tela de {name}</strong><span>{screen.fps ? `~${screen.fps} FPS` : screen.waiting ? 'aguardando transmissão' : 'conectando'}{screen.stream ? screen.hasAudio ? ' · com áudio' : ' · sem áudio' : ''}</span></div><div><button title="Tela cheia" onClick={goFullscreen}><Expand size={16} /></button><button title="Encerrar esta visualização" onClick={onStop}><X size={16} /></button></div></div>
    <div className="remote-frame" onDoubleClick={goFullscreen}><video ref={videoRef} autoPlay playsInline />{!screen.stream && <div className="video-placeholder overlay"><div className="spinner" /><strong>Aguardando a tela</strong></div>}{screen.hasAudio && audioBlocked && <button className="audio-unlock" onClick={enableAudio}><Volume2 size={16} />Ativar som</button>}</div>
    {screen.hasAudio && <div className="screen-audio"><button title={muted ? 'Ativar som' : 'Silenciar'} onClick={() => setMuted((current) => !current)}>{muted ? <VolumeX size={16} /> : <Volume2 size={16} />}</button><input type="range" min="0" max="1" step="0.01" value={muted ? 0 : volume} onChange={(event) => { const value = Number(event.target.value); setVolume(value); setMuted(value === 0) }} aria-label={`Volume da tela de ${name}`} /><span>{Math.round((muted ? 0 : volume) * 100)}%</span></div>}
  </article>
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
  const [users, setUsers] = useState([])
  const [remoteScreens, setRemoteScreens] = useState({})
  const [viewers, setViewers] = useState({})
  const [notice, setNotice] = useState('Entre em uma sala privada para encontrar seus amigos.')
  const [resolution, setResolution] = useState('1080p')
  const [fps, setFps] = useState(60)
  const [quality, setQuality] = useState('medium')
  const [customMbps, setCustomMbps] = useState(8)
  const [screenSize, setScreenSize] = useState('medium')
  const [shareAudio, setShareAudio] = useState(true)
  const [audioStatus, setAudioStatus] = useState('idle')
  const socketRef = useRef(null)
  const pcsRef = useRef(new Map())
  const localStreamRef = useRef(null)
  const statsRef = useRef(new Map())
  const send = useCallback((message) => { if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify(message)) }, [])

  const closeConnection = useCallback((connectionId, notify = false) => {
    const entry = pcsRef.current.get(connectionId)
    if (!entry) return
    if (notify) send({ type: 'stop', to: entry.peerId, connectionId })
    clearInterval(statsRef.current.get(connectionId)); statsRef.current.delete(connectionId); clearTimeout(entry.disconnectTimer)
    entry.pc.close(); pcsRef.current.delete(connectionId)
    if (entry.role === 'viewer') setRemoteScreens((current) => { const next = { ...current }; delete next[connectionId]; return next })
    else setViewers((current) => { const next = { ...current }; delete next[connectionId]; return next })
  }, [send])

  const stopSharing = useCallback((notify = true) => {
    for (const [id, entry] of pcsRef.current) if (entry.role === 'transmitter') closeConnection(id, notify)
    localStreamRef.current?.getTracks().forEach((track) => track.stop()); localStreamRef.current = null
    setAudioStatus('idle')
    send({ type: 'broadcast-stop' }); setViewers({}); setNotice('Sua transmissão foi encerrada. As telas que você assiste continuam abertas.')
  }, [closeConnection, send])
  const closeAll = useCallback(() => {
    for (const id of [...pcsRef.current.keys()]) closeConnection(id, false)
    localStreamRef.current?.getTracks().forEach((track) => track.stop()); localStreamRef.current = null
    setAudioStatus('idle')
  }, [closeConnection])

  const createPeer = useCallback((connectionId, peerId, role) => {
    const pc = new RTCPeerConnection({ iceServers: iceServers() })
    const entry = { pc, peerId, role, pendingCandidates: [], disconnectTimer: null, restarting: false }; pcsRef.current.set(connectionId, entry)
    entry.restart = async () => {
      if (entry.restarting || pc.signalingState !== 'stable' || pc.connectionState === 'closed') return
      entry.restarting = true
      try {
        pc.restartIce()
        const offer = await pc.createOffer({ iceRestart: true }); await pc.setLocalDescription(offer)
        send({ type: 'signal', to: peerId, connectionId, description: pc.localDescription })
      } catch { entry.restarting = false }
    }
    pc.onicecandidate = ({ candidate }) => candidate && send({ type: 'signal', to: peerId, connectionId, candidate: candidate.toJSON() })
    pc.oniceconnectionstatechange = () => {
      if (['connected', 'completed'].includes(pc.iceConnectionState)) { clearTimeout(entry.disconnectTimer); entry.disconnectTimer = null; entry.restarting = false }
      if (pc.iceConnectionState === 'failed') role === 'transmitter' ? entry.restart() : send({ type: 'restart-request', to: peerId, connectionId })
      if (pc.iceConnectionState === 'disconnected' && !entry.disconnectTimer) entry.disconnectTimer = setTimeout(() => {
        entry.disconnectTimer = null
        if (pc.iceConnectionState === 'disconnected') role === 'transmitter' ? entry.restart() : send({ type: 'restart-request', to: peerId, connectionId })
      }, 5_000)
    }
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'closed' && pcsRef.current.get(connectionId)?.pc === pc) closeConnection(connectionId, false) }
    return entry
  }, [closeConnection, send])

  const startStats = useCallback((connectionId, pc) => {
    const timer = setInterval(async () => {
      try {
        let measured = null; const stats = await pc.getStats()
        stats.forEach((report) => { if (report.type === 'inbound-rtp' && report.kind === 'video' && report.framesPerSecond) measured = report.framesPerSecond })
        if (measured) setRemoteScreens((current) => current[connectionId] ? { ...current, [connectionId]: { ...current[connectionId], fps: Math.round(measured) } } : current)
      } catch { /* optional browser statistics */ }
    }, 1500)
    statsRef.current.set(connectionId, timer)
  }, [])

  const handleSignal = useCallback(async (message) => {
    try {
      let entry = pcsRef.current.get(message.connectionId)
      if (!entry) {
        if (message.description?.type !== 'offer') return
        entry = createPeer(message.connectionId, message.from, 'viewer')
        entry.pc.ontrack = ({ streams, track }) => {
          setRemoteScreens((current) => ({ ...current, [message.connectionId]: { ...current[message.connectionId], peerId: message.from, waiting: false, stream: streams[0], hasAudio: track.kind === 'audio' || Boolean(current[message.connectionId]?.hasAudio) } }))
          if (track.kind === 'video') startStats(message.connectionId, entry.pc)
        }
        setRemoteScreens((current) => ({ ...current, [message.connectionId]: { peerId: message.from, waiting: false, stream: null, hasAudio: false } }))
      }
      if (message.description) {
        await entry.pc.setRemoteDescription(message.description)
        for (const candidate of entry.pendingCandidates.splice(0)) await entry.pc.addIceCandidate(candidate)
        if (message.description.type === 'offer') { const answer = await entry.pc.createAnswer(); await entry.pc.setLocalDescription(answer); send({ type: 'signal', to: message.from, connectionId: message.connectionId, description: entry.pc.localDescription }) }
      } else if (message.candidate) {
        if (entry.pc.remoteDescription) await entry.pc.addIceCandidate(message.candidate); else entry.pendingCandidates.push(message.candidate)
      }
    } catch { closeConnection(message.connectionId, false); setNotice('Uma das transmissões não conseguiu conectar.') }
  }, [closeConnection, createPeer, send, startStats])

  useEffect(() => {
    if (!joined) return
    const socketUrl = new URL(SIGNAL_URL); if (accessSession) socketUrl.searchParams.set('session', accessSession)
    const socket = new WebSocket(socketUrl); socketRef.current = socket; setConnection('connecting')
    socket.onopen = () => { setConnection('online'); socket.send(JSON.stringify({ type: 'hello', name })); setNotice('Conectado. Somente pessoas desta sala podem ver você.') }
    socket.onclose = (event) => { setConnection('offline'); setUsers([]); closeAll(); if (event.code === 1008) { setAccessSession(''); setJoined(false) }; setNotice('Conexão encerrada. Entre novamente para reconectar.') }
    socket.onerror = () => setNotice('Falha ao conectar ao servidor de sinalização.')
    socket.onmessage = ({ data }) => {
      let message; try { message = JSON.parse(data) } catch { return }
      if (message.type === 'welcome') { setSelfId(message.id); setIsAdmin(['admin', 'superadmin'].includes(message.role)); setRoomName(message.roomName) }
      else if (message.type === 'users') setUsers(message.users)
      else if (message.type === 'watch-request') shareWith(message.from)
      else if (message.type === 'signal') { setRemoteScreens((current) => { const next = { ...current }; delete next[`waiting-${message.from}`]; return next }); handleSignal(message) }
      else if (message.type === 'restart-request') pcsRef.current.get(message.connectionId)?.restart?.()
      else if (message.type === 'stop') closeConnection(message.connectionId, false)
      else if (message.type === 'peer-left') { for (const [id, entry] of pcsRef.current) if (entry.peerId === message.id) closeConnection(id, false); setRemoteScreens((current) => Object.fromEntries(Object.entries(current).filter(([, value]) => value.peerId !== message.id))) }
      else if (message.type === 'kicked' || message.type === 'banned') { setAccessSession(''); setJoined(false); setNotice(message.type === 'banned' ? 'Você foi banido da sala.' : 'Você foi removido da sala.') }
      else if (message.type === 'error') setNotice(message.message)
    }
    return () => { socket.close(); socketRef.current = null; closeAll() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joined])

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
  const leaveRoom = () => { stopSharing(false); socketRef.current?.close(); setAccessSession(''); setRoomName(''); setJoined(false); setUsers([]); setRemoteScreens({}); setNotice('Você saiu da sala.') }
  const logoutSite = () => { leaveRoom(); localStorage.removeItem('screen-share-site-session'); setSiteSession(''); setSiteRole('member'); setAccessError('') }

  const getCapture = async () => {
    if (localStreamRef.current?.getVideoTracks()[0]?.readyState === 'live') return localStreamRef.current
    const preset = resolutions[resolution]; const video = { frameRate: { ideal: fps, max: fps }, displaySurface: 'monitor' }
    if (preset.width) { video.width = { ideal: preset.width }; video.height = { ideal: preset.height } }
    let stream
    const picker = { selfBrowserSurface: 'exclude', surfaceSwitching: 'exclude' }
    if (shareAudio) {
      try { stream = await navigator.mediaDevices.getDisplayMedia({ ...picker, video, audio: audioConstraints, systemAudio: 'include', windowAudio: 'window' }) }
      catch (error) {
        if (error?.name === 'NotAllowedError') throw error
        stream = await navigator.mediaDevices.getDisplayMedia({ video, audio: true })
      }
    } else stream = await navigator.mediaDevices.getDisplayMedia({ ...picker, video, audio: false })
    localStreamRef.current = stream
    const audioTrack = stream.getAudioTracks()[0]
    setAudioStatus(audioTrack ? 'on' : shareAudio ? 'unavailable' : 'off')
    if (audioTrack) audioTrack.onended = () => setAudioStatus('unavailable')
    stream.getVideoTracks()[0].onended = () => stopSharing(true); return stream
  }
  const startBroadcast = async () => {
    try {
      const stream = await getCapture(); send({ type: 'broadcast-start' })
      setNotice(!shareAudio ? 'Sua transmissão está disponível para todos na sala (sem áudio).'
        : stream.getAudioTracks().length ? 'Sua transmissão está disponível para todos na sala, com o áudio do que você escolheu compartilhar.'
        : 'Transmissão iniciada, mas a origem escolhida não forneceu áudio. Tente uma aba ou use uma opção de áudio oferecida pelo navegador.')
    }
    catch (error) { setNotice(error?.name === 'NotAllowedError' ? 'Você cancelou a escolha da tela.' : 'Não foi possível iniciar a captura.') }
  }
  const shareWith = async (peerId) => {
    try {
      const stream = localStreamRef.current; if (!stream) return
      const connectionId = crypto.randomUUID(); const entry = createPeer(connectionId, peerId, 'transmitter'); const videoTrack = stream.getVideoTracks()[0]
      const sender = entry.pc.addTrack(videoTrack, stream); const maxBitrate = quality === 'custom' ? Math.round(customMbps * 1_000_000) : bitratePresets[quality]
      try { const parameters = sender.getParameters(); parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}]; parameters.encodings[0].maxBitrate = maxBitrate; parameters.encodings[0].maxFramerate = fps; await sender.setParameters(parameters) } catch { /* best effort */ }
      const audioTrack = stream.getAudioTracks()[0]
      if (audioTrack) {
        const audioSender = entry.pc.addTrack(audioTrack, stream)
        try { const parameters = audioSender.getParameters(); parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}]; parameters.encodings[0].maxBitrate = 256_000; await audioSender.setParameters(parameters) } catch { /* best effort */ }
      }
      const offer = await entry.pc.createOffer(); await entry.pc.setLocalDescription(offer); send({ type: 'signal', to: peerId, connectionId, description: entry.pc.localDescription })
      setViewers((current) => ({ ...current, [connectionId]: { peerId } })); setNotice('Novo espectador conectado à sua transmissão.')
    } catch { setNotice('Não foi possível conectar o novo espectador.') }
  }
  const watch = (user) => { setRemoteScreens((current) => ({ ...current, [`waiting-${user.id}`]: { peerId: user.id, waiting: true } })); send({ type: 'watch-request', to: user.id }); setNotice(`Conectando à tela de ${user.name}…`) }
  const moderate = (user, action) => send({ type: 'moderate', to: user.id, action })

  const peers = useMemo(() => users.filter((user) => user.id !== selfId), [users, selfId])
  const userName = (id) => users.find((user) => user.id === id)?.name || 'amigo'
  const remoteEntries = Object.entries(remoteScreens)
  const viewerNames = [...new Set(Object.values(viewers).map((viewer) => userName(viewer.peerId)))]

  if (!siteSession) return <main className="shell login-shell"><section className="login-card"><div className="brand-mark"><MonitorUp size={28} /></div><p className="eyebrow">EntreTelas</p><h1>Entre para encontrar seus amigos.</h1><p className="intro">Usuários comuns precisam apenas escolher um nome. As salas continuam protegidas por suas próprias senhas.</p><form className="login-form" onSubmit={loginSite}><label htmlFor="name">Seu nome de usuário</label><input id="name" value={name} onChange={(event) => setName(event.target.value)} maxLength={32} placeholder="Ex.: Diego" autoFocus />{adminMode && <><label htmlFor="password">Senha administrativa</label><input id="password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} maxLength={128} placeholder="Senha de ADM" autoComplete="current-password" autoFocus /></>}<button type="submit" disabled={joining}>{joining ? 'Entrando…' : adminMode ? 'Entrar como ADM' : 'Entrar no EntreTelas'}</button><button type="button" className="admin-login-toggle" onClick={() => { setAdminMode((current) => !current); setPassword(''); setAccessError('') }}>{adminMode ? 'Voltar para usuário comum' : 'ADM'}</button>{accessError && <p className="access-error" role="alert">{accessError}</p>}</form><div className="trust-line"><ShieldCheck size={17} /><span>Dentro de uma sala, somente os participantes veem quem está presente.</span></div></section></main>

  if (!joined) return <main className="shell lobby-shell"><header><div className="brand"><div className="brand-mark small"><MonitorUp size={21} /></div><div><strong>EntreTelas</strong><span>Olá, {name}{siteRole === 'superadmin' ? ' · SUPER ADM' : siteRole === 'admin' ? ' · ADM' : ''}</span></div></div><button className="leave-room" onClick={logoutSite}><LogOut size={15} />Sair do site</button></header><section className="lobby-heading"><div><p className="eyebrow">Lobby privado</p><h1>Escolha uma sala</h1><p>Somente o nome da sala aparece aqui. Usuários e transmissões continuam ocultos até você entrar.</p></div><button className="create-room-button" onClick={() => { setCreatingRoom(true); setAccessError('') }}><Plus size={17} />Criar sala</button></section>{accessError && !selectedRoom && !creatingRoom && <p className="lobby-error">{accessError}</p>}<section className="rooms-grid">{rooms.length ? rooms.map((room) => <button className="room-card" key={room.id} onClick={() => { setSelectedRoom(room); setRoomPassword(''); setAccessError('') }}><div className="room-icon"><DoorOpen size={22} /></div><div><strong>{room.name}</strong><span>{siteRole === 'superadmin' ? 'Acesso de SUPER ADM' : 'Clique para informar a senha'}</span></div><KeyRound size={17} /></button>) : <div className="rooms-empty"><DoorOpen size={35} /><strong>Nenhuma sala criada</strong><span>Crie a primeira sala e compartilhe a senha somente com quem você quiser.</span></div>}</section>{selectedRoom && <div className="modal-backdrop"><form className="modal room-modal" onSubmit={(event) => { event.preventDefault(); joinRoom(selectedRoom) }}><button type="button" className="modal-close" onClick={() => setSelectedRoom(null)}><X size={17} /></button><div className="request-icon"><KeyRound size={25} /></div><p className="eyebrow">Sala privada</p><h3>{selectedRoom.name}</h3>{siteRole === 'superadmin' ? <p>Você pode entrar usando sua permissão de SUPER ADM.</p> : <><label htmlFor="room-password">Senha da sala</label><input id="room-password" type="password" value={roomPassword} onChange={(event) => setRoomPassword(event.target.value)} autoFocus /></>} {accessError && <p className="access-error">{accessError}</p>}<button type="submit" disabled={joining}>{joining ? 'Entrando…' : siteRole === 'superadmin' ? 'Entrar como SUPER ADM' : 'Entrar na sala'}</button></form></div>}{creatingRoom && <div className="modal-backdrop"><form className="modal room-modal" onSubmit={createRoom}><button type="button" className="modal-close" onClick={() => setCreatingRoom(false)}><X size={17} /></button><div className="request-icon"><Plus size={25} /></div><p className="eyebrow">Nova sala</p><h3>Criar sala privada</h3><label htmlFor="new-room-name">Nome da sala</label><input id="new-room-name" value={newRoomName} onChange={(event) => setNewRoomName(event.target.value)} maxLength={40} autoFocus /><label htmlFor="new-room-password">Senha da sala</label><input id="new-room-password" type="password" value={newRoomPassword} onChange={(event) => setNewRoomPassword(event.target.value)} minLength={4} maxLength={128} />{accessError && <p className="access-error">{accessError}</p>}<button type="submit" disabled={joining}>{joining ? 'Criando…' : 'Criar e entrar'}</button></form></div>}</main>

  return <main className="shell"><header><div className="brand"><div className="brand-mark small"><MonitorUp size={21} /></div><div><strong>EntreTelas</strong><span>Sala · {roomName}</span></div></div><div className="header-actions"><div className={`connection ${connection}`}><span className="pulse" />{connection === 'online' ? <Wifi size={15} /> : <WifiOff size={15} />}{connection === 'online' ? 'Conectado' : connection === 'connecting' ? 'Conectando' : 'Offline'}</div><button className="leave-room" onClick={leaveRoom}><LogOut size={15} />Sair da sala</button></div></header>
    {localStreamRef.current && <div className="live-banner"><div><Radio size={18} /><strong>Você está transmitindo para {viewerNames.length} {viewerNames.length === 1 ? 'pessoa' : 'pessoas'}</strong><span>{viewerNames.join(', ')} · {resolutions[resolution].label} · preferência {fps} FPS · {audioStatus === 'on' ? 'com áudio' : audioStatus === 'unavailable' ? 'sem áudio (a origem escolhida não fornece som)' : 'sem áudio'}</span></div><button className="danger" onClick={() => stopSharing(true)}><CircleStop size={17} />Parar para todos</button></div>}
    <section className="notice" aria-live="polite"><span className="notice-dot" />{notice}</section><div className="workspace multi-workspace">
      <section className="panel people"><div className="panel-heading"><div><p className="eyebrow">Sala privada · {roomName}</p><h2>Amigos online</h2></div><span className="count"><Users size={15} />{peers.length + 1}</span></div><div className="people-list">{peers.length === 0 ? <div className="empty"><Users size={28} /><strong>Ninguém por aqui ainda</strong><span>Compartilhe o nome e a senha desta sala com seus amigos.</span></div> : peers.map((user) => <article className="person" key={user.id}><div className="avatar">{user.name.slice(0, 1).toUpperCase()}</div><div><strong>{user.name}{user.role === 'superadmin' ? ' · SUPER ADM' : user.role === 'admin' ? ' · ADM' : ''}</strong><span><i className={user.broadcasting ? 'live-user' : ''} />{user.broadcasting ? ' transmitindo agora' : ' online'}</span></div><div className="person-actions"><button disabled={!user.broadcasting || Object.values(remoteScreens).some((screen) => screen.peerId === user.id)} onClick={() => watch(user)}><Cast size={16} />{user.broadcasting ? 'Assistir' : 'Sem tela'}</button>{isAdmin && <><button className="admin-action" title="Expulsar" onClick={() => moderate(user, 'kick')}><UserX size={15} /></button><button className="admin-action ban" title="Banir" onClick={() => moderate(user, 'ban')}><Ban size={15} /></button></>}</div></article>)}</div></section>
      <section className="panel stage multi-stage"><div className="panel-heading stage-tools"><div><p className="eyebrow">Visualização simultânea</p><h2>{remoteEntries.length ? `${remoteEntries.length} ${remoteEntries.length === 1 ? 'tela aberta' : 'telas abertas'}` : 'As transmissões aparecerão aqui'}</h2></div><label className="size-control">Tamanho<select value={screenSize} onChange={(event) => setScreenSize(event.target.value)}><option value="small">Pequeno</option><option value="medium">Médio</option><option value="large">Grande</option></select></label></div><div className={`screens-grid grid-${screenSize}`}>{remoteEntries.length ? remoteEntries.map(([id, screen]) => <RemoteScreen key={id} screen={screen} size={screenSize} name={userName(screen.peerId)} onStop={() => id.startsWith('waiting-') ? setRemoteScreens((current) => { const next = { ...current }; delete next[id]; return next }) : closeConnection(id, true)} />) : <div className="multi-empty"><div className="screen-outline"><Cast size={35} /></div><strong>Pronto para várias telas</strong><span>Você pode assistir seus amigos enquanto continua transmitindo a sua.</span></div>}</div></section>
      <aside className="panel settings"><div className="panel-heading"><div><p className="eyebrow">Sua transmissão</p><h2>Qualidade</h2></div><SlidersHorizontal size={19} /></div><fieldset disabled={!!localStreamRef.current}><label>Resolução</label><div className="segmented">{Object.entries(resolutions).map(([key, value]) => <button type="button" className={resolution === key ? 'selected' : ''} key={key} onClick={() => setResolution(key)}>{value.label}</button>)}</div><label>FPS preferido</label><div className="segmented three">{[30, 60, 120].map((value) => <button type="button" className={fps === value ? 'selected' : ''} key={value} onClick={() => setFps(value)}>{value}</button>)}</div><p className="hint">120 FPS é uma preferência. O navegador, tela e GPU determinam o valor efetivo.</p><label>Áudio</label><div className="segmented"><button type="button" className={shareAudio ? 'selected' : ''} onClick={() => setShareAudio(true)}>Transmitir som</button><button type="button" className={!shareAudio ? 'selected' : ''} onClick={() => setShareAudio(false)}>Somente vídeo</button></div><p className="hint">Aba: somente o áudio dela, com o aviso de compartilhamento obrigatório do navegador. Janela: tentamos capturar apenas o som da janela quando o navegador oferecer essa opção. Tela inteira: áudio do sistema.</p><label>Bitrate por espectador</label><div className="quality-list">{Object.keys(bitrateLabels).map((key) => <button type="button" className={quality === key ? 'selected' : ''} key={key} onClick={() => setQuality(key)}><span>{bitrateLabels[key]}</span><small>{key === 'low' ? '2,5 Mbps' : key === 'medium' ? '8 Mbps' : key === 'high' ? '14 Mbps' : 'defina abaixo'}</small></button>)}</div>{quality === 'custom' && <label className="custom">Mbps<input type="number" min="0.5" max="100" step="0.5" value={customMbps} onChange={(event) => setCustomMbps(Math.min(100, Math.max(.5, Number(event.target.value))))} /></label>}</fieldset>{!localStreamRef.current && <button className="start-broadcast" onClick={startBroadcast}><Radio size={17} />Iniciar transmissão</button>}<div className="safety"><ShieldCheck size={18} /><p><strong>Entrada livre para assistir</strong><span>Quem estiver na sala pode clicar e acompanhar.</span></p></div></aside>
    </div>
  </main>
}
