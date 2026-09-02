import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Ban, Cast, CircleStop, DoorOpen, Expand, LogOut, MonitorUp, Plus, Radio, ShieldCheck, SlidersHorizontal, UserX, Users, Wifi, WifiOff, X } from 'lucide-react'

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

function RemoteScreen({ screen, name, size, onStop }) {
  const videoRef = useRef(null)
  useEffect(() => { if (videoRef.current) videoRef.current.srcObject = screen.stream || null }, [screen.stream])
  return <article className={`screen-card size-${size}`}>
    <div className="screen-card-head"><div><i /><strong>Tela de {name}</strong><span>{screen.fps ? `~${screen.fps} FPS` : screen.waiting ? 'aguardando transmissão' : 'conectando'}</span></div><div><button title="Tela cheia" onClick={() => videoRef.current?.parentElement?.requestFullscreen?.()}><Expand size={16} /></button><button title="Encerrar esta visualização" onClick={onStop}><X size={16} /></button></div></div>
    <div className="remote-frame"><video ref={videoRef} autoPlay playsInline />{!screen.stream && <div className="video-placeholder overlay"><div className="spinner" /><strong>Aguardando a tela</strong></div>}</div>
  </article>
}

export default function App() {
  const [name, setName] = useState(localStorage.getItem('screen-share-name') || '')
  const [roomName, setRoomName] = useState(localStorage.getItem('screen-share-room') || '')
  const [password, setPassword] = useState('')
  const [entryMode, setEntryMode] = useState('join')
  const [accessError, setAccessError] = useState('')
  const [joining, setJoining] = useState(false)
  const [accessSession, setAccessSession] = useState(() => localStorage.getItem('screen-share-room') ? (localStorage.getItem('screen-share-session') || '') : '')
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
  const socketRef = useRef(null)
  const pcsRef = useRef(new Map())
  const localStreamRef = useRef(null)
  const statsRef = useRef(new Map())
  const send = useCallback((message) => { if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify(message)) }, [])

  const closeConnection = useCallback((connectionId, notify = false) => {
    const entry = pcsRef.current.get(connectionId)
    if (!entry) return
    if (notify) send({ type: 'stop', to: entry.peerId, connectionId })
    clearInterval(statsRef.current.get(connectionId)); statsRef.current.delete(connectionId)
    entry.pc.close(); pcsRef.current.delete(connectionId)
    if (entry.role === 'viewer') setRemoteScreens((current) => { const next = { ...current }; delete next[connectionId]; return next })
    else setViewers((current) => { const next = { ...current }; delete next[connectionId]; return next })
  }, [send])

  const stopSharing = useCallback((notify = true) => {
    for (const [id, entry] of pcsRef.current) if (entry.role === 'transmitter') closeConnection(id, notify)
    localStreamRef.current?.getTracks().forEach((track) => track.stop()); localStreamRef.current = null
    send({ type: 'broadcast-stop' }); setViewers({}); setNotice('Sua transmissão foi encerrada. As telas que você assiste continuam abertas.')
  }, [closeConnection, send])
  const closeAll = useCallback(() => {
    for (const id of [...pcsRef.current.keys()]) closeConnection(id, false)
    localStreamRef.current?.getTracks().forEach((track) => track.stop()); localStreamRef.current = null
  }, [closeConnection])

  const createPeer = useCallback((connectionId, peerId, role) => {
    const pc = new RTCPeerConnection({ iceServers: iceServers() })
    const entry = { pc, peerId, role, pendingCandidates: [] }; pcsRef.current.set(connectionId, entry)
    pc.onicecandidate = ({ candidate }) => candidate && send({ type: 'signal', to: peerId, connectionId, candidate: candidate.toJSON() })
    pc.onconnectionstatechange = () => { if (['failed', 'closed'].includes(pc.connectionState) && pcsRef.current.get(connectionId)?.pc === pc) closeConnection(connectionId, false) }
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
        entry.pc.ontrack = ({ streams }) => { setRemoteScreens((current) => ({ ...current, [message.connectionId]: { peerId: message.from, stream: streams[0] } })); startStats(message.connectionId, entry.pc) }
        setRemoteScreens((current) => ({ ...current, [message.connectionId]: { peerId: message.from, waiting: false, stream: null } }))
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
    socket.onclose = (event) => { setConnection('offline'); setUsers([]); closeAll(); if (event.code === 1008) { localStorage.removeItem('screen-share-session'); setAccessSession(''); setJoined(false) }; setNotice('Conexão encerrada. Entre novamente para reconectar.') }
    socket.onerror = () => setNotice('Falha ao conectar ao servidor de sinalização.')
    socket.onmessage = ({ data }) => {
      let message; try { message = JSON.parse(data) } catch { return }
      if (message.type === 'welcome') { setSelfId(message.id); setIsAdmin(message.role === 'admin'); setRoomName(message.roomName) }
      else if (message.type === 'users') setUsers(message.users)
      else if (message.type === 'watch-request') shareWith(message.from)
      else if (message.type === 'signal') { setRemoteScreens((current) => { const next = { ...current }; delete next[`waiting-${message.from}`]; return next }); handleSignal(message) }
      else if (message.type === 'stop') closeConnection(message.connectionId, false)
      else if (message.type === 'peer-left') { for (const [id, entry] of pcsRef.current) if (entry.peerId === message.id) closeConnection(id, false); setRemoteScreens((current) => Object.fromEntries(Object.entries(current).filter(([, value]) => value.peerId !== message.id))) }
      else if (message.type === 'kicked' || message.type === 'banned') { localStorage.removeItem('screen-share-session'); setAccessSession(''); setJoined(false); setNotice(message.type === 'banned' ? 'Você foi banido da sala.' : 'Você foi removido da sala.') }
      else if (message.type === 'error') setNotice(message.message)
    }
    return () => { socket.close(); socketRef.current = null; closeAll() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joined])

  const enterRoom = async (event) => {
    event.preventDefault(); const cleanName = name.trim(); const cleanRoomName = roomName.trim()
    if (cleanName.length < 2) return setAccessError('Use um nome com pelo menos 2 caracteres.')
    if (cleanRoomName.length < 2) return setAccessError('Informe o nome da sala.')
    if (password.length < 4) return setAccessError('A senha precisa ter pelo menos 4 caracteres.')
    setJoining(true); setAccessError('')
    try {
      const endpoint = entryMode === 'create' ? '/api/rooms' : '/api/rooms/join'
      const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: cleanName, roomName: cleanRoomName, password }) })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Não foi possível entrar.')
      localStorage.setItem('screen-share-session', result.session); setAccessSession(result.session)
      localStorage.setItem('screen-share-name', cleanName); localStorage.setItem('screen-share-room', result.roomName)
      setName(cleanName); setRoomName(result.roomName); setPassword(''); setJoined(true)
    } catch (error) { setAccessError(error.message) } finally { setJoining(false) }
  }
  const forgetRoom = () => { localStorage.removeItem('screen-share-session'); localStorage.removeItem('screen-share-room'); setAccessSession(''); setRoomName(''); setPassword(''); setAccessError('') }
  const leaveRoom = () => { stopSharing(false); socketRef.current?.close(); forgetRoom(); setJoined(false); setUsers([]); setRemoteScreens({}); setNotice('Você saiu da sala.') }

  const getCapture = async () => {
    if (localStreamRef.current?.getVideoTracks()[0]?.readyState === 'live') return localStreamRef.current
    const preset = resolutions[resolution]; const video = { frameRate: { ideal: fps, max: fps }, displaySurface: 'monitor' }
    if (preset.width) { video.width = { ideal: preset.width }; video.height = { ideal: preset.height } }
    const stream = await navigator.mediaDevices.getDisplayMedia({ video, audio: false }); localStreamRef.current = stream
    stream.getVideoTracks()[0].onended = () => stopSharing(true); return stream
  }
  const startBroadcast = async () => {
    try { await getCapture(); send({ type: 'broadcast-start' }); setNotice('Sua transmissão está disponível para todos na sala.') }
    catch (error) { setNotice(error?.name === 'NotAllowedError' ? 'Você cancelou a escolha da tela.' : 'Não foi possível iniciar a captura.') }
  }
  const shareWith = async (peerId) => {
    try {
      const stream = localStreamRef.current; if (!stream) return
      const connectionId = crypto.randomUUID(); const entry = createPeer(connectionId, peerId, 'transmitter'); const track = stream.getVideoTracks()[0]
      const sender = entry.pc.addTrack(track, stream); const maxBitrate = quality === 'custom' ? Math.round(customMbps * 1_000_000) : bitratePresets[quality]
      try { const parameters = sender.getParameters(); parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}]; parameters.encodings[0].maxBitrate = maxBitrate; parameters.encodings[0].maxFramerate = fps; await sender.setParameters(parameters) } catch { /* best effort */ }
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

  if (!joined) return <main className="shell login-shell"><section className="login-card"><div className="brand-mark"><MonitorUp size={28} /></div><p className="eyebrow">EntreTelas</p><h1>Suas conversas, em salas privadas.</h1><p className="intro">Crie uma sala ou entre com o nome e a senha recebidos de um amigo. Nada da sala aparece antes da entrada.</p>{accessSession ? <div className="resume-room"><DoorOpen size={25} /><div><strong>Retomar “{roomName}”</strong><span>Sua entrada ainda está salva neste navegador.</span></div><button onClick={() => setJoined(true)}>Retomar sala</button><button className="secondary" onClick={forgetRoom}>Usar outra sala</button></div> : <><div className="entry-tabs"><button className={entryMode === 'join' ? 'selected' : ''} onClick={() => setEntryMode('join')}><DoorOpen size={16} />Entrar</button><button className={entryMode === 'create' ? 'selected' : ''} onClick={() => setEntryMode('create')}><Plus size={16} />Criar sala</button></div><form className="login-form" onSubmit={enterRoom}><label htmlFor="name">Seu nome de usuário</label><input id="name" value={name} onChange={(event) => setName(event.target.value)} maxLength={32} placeholder="Ex.: Diego" autoFocus /><label htmlFor="room-name">Nome da sala</label><input id="room-name" value={roomName} onChange={(event) => setRoomName(event.target.value)} maxLength={40} placeholder="Ex.: Noite de jogos" autoComplete="off" /><label htmlFor="password">Senha da sala</label><input id="password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} maxLength={128} placeholder={entryMode === 'create' ? 'Crie uma senha privada' : 'Digite a senha recebida'} autoComplete="current-password" /><button type="submit" disabled={joining}>{joining ? 'Aguarde…' : entryMode === 'create' ? 'Criar e entrar' : 'Entrar na sala'}</button>{accessError && <p className="access-error" role="alert">{accessError}</p>}</form></>}<div className="trust-line"><ShieldCheck size={17} /><span>Usuários e transmissões só aparecem depois que a senha é validada.</span></div></section></main>

  return <main className="shell"><header><div className="brand"><div className="brand-mark small"><MonitorUp size={21} /></div><div><strong>EntreTelas</strong><span>Sala · {roomName}</span></div></div><div className="header-actions"><div className={`connection ${connection}`}><span className="pulse" />{connection === 'online' ? <Wifi size={15} /> : <WifiOff size={15} />}{connection === 'online' ? 'Conectado' : connection === 'connecting' ? 'Conectando' : 'Offline'}</div><button className="leave-room" onClick={leaveRoom}><LogOut size={15} />Sair da sala</button></div></header>
    {localStreamRef.current && <div className="live-banner"><div><Radio size={18} /><strong>Você está transmitindo para {viewerNames.length} {viewerNames.length === 1 ? 'pessoa' : 'pessoas'}</strong><span>{viewerNames.join(', ')} · {resolutions[resolution].label} · preferência {fps} FPS</span></div><button className="danger" onClick={() => stopSharing(true)}><CircleStop size={17} />Parar para todos</button></div>}
    <section className="notice" aria-live="polite"><span className="notice-dot" />{notice}</section><div className="workspace multi-workspace">
      <section className="panel people"><div className="panel-heading"><div><p className="eyebrow">Sala privada · {roomName}</p><h2>Amigos online</h2></div><span className="count"><Users size={15} />{peers.length + 1}</span></div><div className="people-list">{peers.length === 0 ? <div className="empty"><Users size={28} /><strong>Ninguém por aqui ainda</strong><span>Compartilhe o nome e a senha desta sala com seus amigos.</span></div> : peers.map((user) => <article className="person" key={user.id}><div className="avatar">{user.name.slice(0, 1).toUpperCase()}</div><div><strong>{user.name}{user.role === 'admin' ? ' · ADM' : ''}</strong><span><i className={user.broadcasting ? 'live-user' : ''} />{user.broadcasting ? ' transmitindo agora' : ' online'}</span></div><div className="person-actions"><button disabled={!user.broadcasting || Object.values(remoteScreens).some((screen) => screen.peerId === user.id)} onClick={() => watch(user)}><Cast size={16} />{user.broadcasting ? 'Assistir' : 'Sem tela'}</button>{isAdmin && <><button className="admin-action" title="Expulsar" onClick={() => moderate(user, 'kick')}><UserX size={15} /></button><button className="admin-action ban" title="Banir" onClick={() => moderate(user, 'ban')}><Ban size={15} /></button></>}</div></article>)}</div></section>
      <section className="panel stage multi-stage"><div className="panel-heading stage-tools"><div><p className="eyebrow">Visualização simultânea</p><h2>{remoteEntries.length ? `${remoteEntries.length} ${remoteEntries.length === 1 ? 'tela aberta' : 'telas abertas'}` : 'As transmissões aparecerão aqui'}</h2></div><label className="size-control">Tamanho<select value={screenSize} onChange={(event) => setScreenSize(event.target.value)}><option value="small">Pequeno</option><option value="medium">Médio</option><option value="large">Grande</option></select></label></div><div className={`screens-grid grid-${screenSize}`}>{remoteEntries.length ? remoteEntries.map(([id, screen]) => <RemoteScreen key={id} screen={screen} size={screenSize} name={userName(screen.peerId)} onStop={() => id.startsWith('waiting-') ? setRemoteScreens((current) => { const next = { ...current }; delete next[id]; return next }) : closeConnection(id, true)} />) : <div className="multi-empty"><div className="screen-outline"><Cast size={35} /></div><strong>Pronto para várias telas</strong><span>Você pode assistir seus amigos enquanto continua transmitindo a sua.</span></div>}</div></section>
      <aside className="panel settings"><div className="panel-heading"><div><p className="eyebrow">Sua transmissão</p><h2>Qualidade</h2></div><SlidersHorizontal size={19} /></div><fieldset disabled={!!localStreamRef.current}><label>Resolução</label><div className="segmented">{Object.entries(resolutions).map(([key, value]) => <button type="button" className={resolution === key ? 'selected' : ''} key={key} onClick={() => setResolution(key)}>{value.label}</button>)}</div><label>FPS preferido</label><div className="segmented three">{[30, 60, 120].map((value) => <button type="button" className={fps === value ? 'selected' : ''} key={value} onClick={() => setFps(value)}>{value}</button>)}</div><p className="hint">120 FPS é uma preferência. O navegador, tela e GPU determinam o valor efetivo.</p><label>Bitrate por espectador</label><div className="quality-list">{Object.keys(bitrateLabels).map((key) => <button type="button" className={quality === key ? 'selected' : ''} key={key} onClick={() => setQuality(key)}><span>{bitrateLabels[key]}</span><small>{key === 'low' ? '2,5 Mbps' : key === 'medium' ? '8 Mbps' : key === 'high' ? '14 Mbps' : 'defina abaixo'}</small></button>)}</div>{quality === 'custom' && <label className="custom">Mbps<input type="number" min="0.5" max="100" step="0.5" value={customMbps} onChange={(event) => setCustomMbps(Math.min(100, Math.max(.5, Number(event.target.value))))} /></label>}</fieldset>{!localStreamRef.current && <button className="start-broadcast" onClick={startBroadcast}><Radio size={17} />Iniciar transmissão</button>}<div className="safety"><ShieldCheck size={18} /><p><strong>Entrada livre para assistir</strong><span>Quem estiver na sala pode clicar e acompanhar.</span></p></div></aside>
    </div>
  </main>
}
