const { app, BrowserWindow, desktopCapturer, ipcMain, screen, session, shell } = require('electron')
const { autoUpdater } = require('electron-updater')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

// Local frontend testing only; packaged builds always use the hosted service.
const localAppUrl = !app.isPackaged && process.env.ENTRETELAS_APP_URL
if (localAppUrl) {
  const url = new URL(localAppUrl)
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('ENTRETELAS_APP_URL must be a loopback HTTP(S) URL')
  }
}
// A build can be aimed at a server other than the published one -- a test build against a machine that
// is not yet the live one, say. Baked in when the app is built rather than read from the environment
// when it runs: this window carries a preload and the app's own privileges, so an address somebody
// could set at launch is an address somebody could point it anywhere.
const buildServer = (() => {
  try { return require('../package.json').telasshareServer || null } catch { return null }
})()
const APP_URL = localAppUrl || buildServer || 'https://telasshare.duckdns.org'

// Apply one list per switch: appendSwitch replaces a previous value for the same switch.
const { mediaFeaturePolicy, createMediaRuntimeLog } = require('./mediaRuntime.cjs')
const { findGstreamer, supportsProcessLoopback, windowProcessId } = require('./nativeCapture.cjs')
const { createNativeBroadcast } = require('./nativeBroadcast.cjs')
const mediaPolicy = mediaFeaturePolicy()
const mediaRuntime = createMediaRuntimeLog(mediaPolicy)
// GStreamer writes a cache of every plugin it finds. Beside a bundled copy under Program Files it
// cannot write at all, and without the cache it rescans hundreds of plugins on every launch of the
// pipeline. userData is the one directory guaranteed to be writable.
process.env.ENTRETELAS_GST_REGISTRY = path.join(app.getPath('userData'), 'gstreamer-registry.bin')
app.commandLine.appendSwitch('force-webrtc-ip-handling-policy', 'default')
if (mediaPolicy.enabledFeatures.length) app.commandLine.appendSwitch('enable-features', mediaPolicy.enabledFeatures.join(','))
if (mediaPolicy.disabledFeatures.length) app.commandLine.appendSwitch('disable-features', mediaPolicy.disabledFeatures.join(','))
app.on('child-process-gone', (_event, details) => {
  if (details.type === 'GPU') mediaRuntime.record('gpu-process-gone', details)
})
const APP_ORIGIN = new URL(APP_URL).origin
let mainWindow
let processAudioCapture = null
let nativeBroadcast = null
let updateWindow = null
let postponedUpdateVersion = null

const audioHelperPath = () => app.isPackaged
  ? path.join(process.resourcesPath, 'native', 'process-audio-capture.exe')
  : path.join(__dirname, '..', 'native', 'bin', 'process-audio-capture.exe')
const processAudioAvailable = () => process.platform === 'win32' && fs.existsSync(audioHelperPath())

function stopProcessAudioCapture() {
  if (!processAudioCapture) return
  const capture = processAudioCapture
  processAudioCapture = null
  capture.kill()
  // Windows has no signals: kill() terminates the helper itself and nothing it may have started, and a
  // surviving grandchild holds the stdio pipes open, which keeps this process from ever finishing its
  // own shutdown. taskkill /T takes the whole tree. Best effort — the kill() above already covers the
  // ordinary case, and the app must not wait on this to exit.
  if (process.platform === 'win32' && capture.pid) {
    try { spawn('taskkill', ['/pid', String(capture.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', detached: true }).unref() }
    catch { /* the direct kill above stands */ }
  }
}

function startProcessAudioCapture(source) {
  stopProcessAudioCapture()
  const match = /^window:([^:]+):/.exec(source.id)
  if (!match || !processAudioAvailable()) return false
  const capture = spawn(audioHelperPath(), [match[1]], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  processAudioCapture = capture
  capture.stdout.on('data', (chunk) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('window-audio-data', chunk)
  })
  capture.on('error', () => {
    if (processAudioCapture === capture) processAudioCapture = null
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('window-audio-error')
  })
  capture.on('exit', (code) => {
    if (processAudioCapture === capture) processAudioCapture = null
    if (code && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('window-audio-error', `native-exit-${code}`)
  })
  return true
}

const isTrustedUrl = (value) => {
  try { return new URL(value).origin === APP_ORIGIN } catch { return false }
}

// The gate between a link somebody typed and the operating system. Parsed rather than pattern-matched,
// and restricted to the two schemes the web uses: openExternal will happily start whatever program is
// registered for a scheme, and nothing arriving from another person should be able to do that.
const WEB_SCHEMES = ['http:', 'https:']
const openIfWeb = (value) => {
  let url
  try { url = new URL(value) } catch { return false }
  if (!WEB_SCHEMES.includes(url.protocol)) return false
  shell.openExternal(url.href)
  return true
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])
}

// Windows the app opens belong over the app, not wherever the primary monitor happens to be. Someone
// broadcasting from a second screen was getting these on a monitor they were not looking at -- and on
// top of the very thing they were sharing. Clamped to the work area of the display the app is on, since
// centring a window larger than the app would otherwise push part of it off the edge.
function centredOnApp(width, height) {
  if (!mainWindow || mainWindow.isDestroyed()) return {}
  const over = mainWindow.getBounds()
  const area = screen.getDisplayMatching(over).workArea
  const clamp = (value, min, max) => Math.round(Math.min(Math.max(value, min), max))
  return {
    x: clamp(over.x + (over.width - width) / 2, area.x, area.x + Math.max(0, area.width - width)),
    y: clamp(over.y + (over.height - height) / 2, area.y, area.y + Math.max(0, area.height - height)),
  }
}

// `perAppAudio` says whether *this* path can carry one application's sound, and the two paths answer
// differently: the browser needs the bundled helper, while native capture asks WASAPI directly. Deciding
// it from the helper alone disabled the checkbox for people whose native capture could have done it --
// which is how somebody ended up unable to share a window with sound at all.
function showSourcePicker(sources, audioRequested, perAppAudio) {
  return new Promise((resolve) => {
    let finished = false
    const picker = new BrowserWindow({
      parent: mainWindow,
      modal: true,
      width: 940,
      height: 680,
      ...centredOnApp(940, 680),
      minWidth: 680,
      minHeight: 520,
      show: false,
      frame: false,
      resizable: true,
      backgroundColor: '#07111f',
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    })
    const finish = (value) => {
      if (finished) return
      finished = true
      resolve(value)
      if (!picker.isDestroyed()) picker.destroy()
    }
    const cards = sources.map((source, index) => {
      const screen = source.id.startsWith('screen:')
      const icon = source.appIcon && !source.appIcon.isEmpty() ? source.appIcon.toDataURL() : ''
      return `<button class="source" data-index="${index}" data-screen="${screen}"><span class="preview"><img src="${source.thumbnail.toDataURL()}" alt=""></span><span class="source-name">${icon ? `<img class="icon" src="${icon}" alt="">` : ''}${escapeHtml(source.name)}</span><span class="kind">${screen ? 'Tela inteira' : 'Janela'}</span></button>`
    }).join('')
    const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>
      :root{font-family:Segoe UI,Arial,sans-serif;color:#e9f3fb;background:#07111f}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 15% 0,#0d3039,transparent 35%),#07111f;min-height:100vh}.top{position:sticky;top:0;z-index:3;display:flex;align-items:center;justify-content:space-between;padding:22px 26px 17px;background:#07111ff2;border-bottom:1px solid #1f3548;backdrop-filter:blur(12px)}h1{font-size:20px;margin:0 0 5px}.subtitle{font-size:12px;color:#8fa5b8}.close{width:38px;height:38px;border:1px solid #31475a;border-radius:11px;background:#112235;color:#b9cad8;font-size:20px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:13px;padding:20px 26px 120px}.source{text-align:left;padding:9px;border:1px solid #23394c;border-radius:15px;background:#0e1c2b;color:#e6eff7;overflow:hidden}.source:hover,.source.selected{border-color:#49e0b4;background:#12332d;transform:translateY(-1px)}.preview{display:block;aspect-ratio:16/9;background:#03080d;border-radius:10px;overflow:hidden}.preview>img{width:100%;height:100%;object-fit:contain}.source-name{display:flex;align-items:center;gap:7px;font-weight:650;font-size:12px;margin:10px 3px 3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.icon{width:16px;height:16px}.kind{font-size:10px;color:#71899d;margin-left:3px}.footer{position:fixed;z-index:4;left:0;right:0;bottom:0;padding:14px 26px 18px;display:flex;align-items:center;justify-content:space-between;gap:20px;background:#0a1725f5;border-top:1px solid #23384b;backdrop-filter:blur(12px)}.audio{display:flex;align-items:flex-start;gap:10px;max-width:580px}.audio input{margin-top:3px;accent-color:#49e0b4}.audio strong,.audio small{display:block}.audio strong{font-size:12px}.audio small{font-size:10px;line-height:1.4;color:#8499ab;margin-top:3px}.actions{display:flex;gap:8px}.actions button{padding:11px 16px;border-radius:10px;font-weight:700;border:1px solid #31475a;background:#152638;color:#b8c8d5}.actions .share{background:#49e0b4;border-color:#49e0b4;color:#06261c}.actions .share:disabled{opacity:.4}@media(max-width:720px){.grid{grid-template-columns:1fr 1fr;padding-inline:15px}.footer{align-items:stretch;flex-direction:column}.actions button{flex:1}}
    </style></head><body><header class="top"><div><h1>Escolha o que compartilhar</h1><div class="subtitle">Nada será capturado antes de você confirmar.</div></div><button class="close" aria-label="Cancelar">×</button></header><main class="grid">${cards}</main><footer class="footer"><label class="audio" ${audioRequested ? '' : 'hidden'}><input id="audio" type="checkbox"><span><strong>Compartilhar áudio</strong><small id="audio-help">Selecione uma origem para ver as opções de áudio.</small></span></label><div class="actions"><button id="cancel">Cancelar</button><button id="share" class="share" disabled>Compartilhar</button></div></footer><script>
      const processAudio=${perAppAudio === true};let selected=-1;let screen=false;const share=document.querySelector('#share');const audio=document.querySelector('#audio');const help=document.querySelector('#audio-help');document.querySelectorAll('.source').forEach(button=>button.onclick=()=>{document.querySelector('.source.selected')?.classList.remove('selected');button.classList.add('selected');selected=Number(button.dataset.index);screen=button.dataset.screen==='true';share.disabled=false;audio.disabled=!screen&&!processAudio;audio.checked=screen||processAudio;help.textContent=screen?'Inclui todos os sons do PC, inclusive Discord. Desmarque para transmitir somente vídeo.':processAudio?'Captura somente o áudio do aplicativo escolhido e de seus processos filhos. Outros programas, como Discord, ficam de fora.':'Captura por aplicativo indisponível nesta versão. A janela será transmitida sem áudio.'});const done=value=>location.href='entretelas-picker:'+value;share.onclick=()=>done(selected+','+(audio.checked?'1':'0'));document.querySelector('#cancel').onclick=()=>done('cancel');document.querySelector('.close').onclick=()=>done('cancel');</script></body></html>`
    picker.webContents.on('will-navigate', (event, url) => {
      if (!url.startsWith('entretelas-picker:')) return
      event.preventDefault()
      const value = url.slice('entretelas-picker:'.length)
      if (value === 'cancel') return finish(null)
      const [index, audio] = value.split(',')
      finish({ source: sources[Number(index)], audio: audio === '1' })
    })
    picker.on('closed', () => finish(null))
    picker.once('ready-to-show', () => picker.show())
    picker.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  })
}

async function chooseDisplaySource(request, callback) {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: true,
    })
    if (!sources.length) return callback({})
    const result = await showSourcePicker(sources, request.audioRequested, processAudioAvailable())
    if (!result) return callback({})
    const isEntireScreen = result.source.id.startsWith('screen:')
    const nativeAudio = request.audioRequested && result.audio && !isEntireScreen && startProcessAudioCapture(result.source)
    callback({ video: result.source, ...(request.audioRequested && result.audio && isEntireScreen ? { audio: 'loopback' } : {}) })
    if (!nativeAudio && !isEntireScreen) stopProcessAudioCapture()
  } catch {
    callback({})
  }
}

// desktopCapturer ids already carry what the pipeline needs. A window is "window:<HWND>:<n>", and that
// handle is what window-handle takes -- the same shape the audio helper parses out of these ids. A
// screen is "screen:<index>:<n>", and that index is the capture index, verified against this machine:
// screen:0 is the 2560x1440 at x=0, screen:1 the 1920x1080 at x=2560, screen:2 the one at x=4480, and
// monitor-index 0/1/2 report exactly those resolutions.
//
// Matching through screen.getAllDisplays() instead was the bug behind every native broadcast showing
// the primary monitor: that list is ordered differently from the capture indices, so nothing matched
// and the fallback took over. The id is the authority, not the display list.
function describeSource(source, audio) {
  const window = /^window:(\d+):/.exec(source.id)
  const chosen = { audio: audio === true, name: source.name }
  // A window's size is not known until it is captured, so only screens can say how many pixels the
  // encoder will be given -- which is what the bitrate is chosen from.
  if (window) return { ...chosen, kind: 'window', windowHandle: Number(window[1]) }
  // The number inside "screen:<n>:" is not a capture index. It looked like one here -- this machine
  // reports screen:0, screen:1, screen:2 for its three monitors -- and on a laptop with an external
  // display it came back as 5, which is a Windows display identifier and not an index of anything. The
  // capture then failed outright: "Failed to prepare capture object ... monitor-index: 5".
  //
  // What the capture wants is a zero-based position, so that is what is sent: where this display sits in
  // Electron's own list. The size travels with it so the pipeline can check the two agree before
  // trusting the number, since nothing here guarantees the two orders match on every machine.
  const displays = screen.getAllDisplays()
  const at = displays.findIndex((item) => String(item.id) === source.display_id)
  const matched = at === -1 ? null : displays[at]
  const scale = matched && matched.scaleFactor > 0 ? matched.scaleFactor : 1
  return {
    ...chosen,
    kind: 'monitor',
    monitorIndex: at === -1 ? 0 : at,
    ...(matched ? { width: Math.round(matched.bounds.width * scale), height: Math.round(matched.bounds.height * scale) } : {}),
  }
}

function configureSession() {
  const appSession = session.defaultSession
  appSession.setDisplayMediaRequestHandler(chooseDisplaySource)
  const allowed = ['media', 'fullscreen', 'local-network', 'local-network-access', 'loopback-network']
  appSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(isTrustedUrl(webContents.getURL()) && isTrustedUrl(details.requestingUrl || webContents.getURL()) && allowed.includes(permission))
  })
  appSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    // Chromium omits the origin on some internal checks; falling back keeps WebRTC out of restricted mode.
    const origin = requestingOrigin && requestingOrigin !== 'null' ? requestingOrigin : webContents?.getURL?.() || ''
    return isTrustedUrl(webContents?.getURL?.() || '') && isTrustedUrl(origin) && allowed.includes(permission)
  })
}

// These start processes and open a loopback listener, so they answer only the real page, never a frame
// that talked its way into the window.
const fromTrustedPage = (event) => event.sender === mainWindow?.webContents
  && event.senderFrame === event.sender.mainFrame
  && isTrustedUrl(event.senderFrame.url)

const toPage = (channel, ...args) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args)
}

// Built once and kept: the renderer owns the signalling socket, so everything this emits is something
// the page should put on the wire, and every answer comes back the same way.
function nativeBroadcastInstance() {
  if (nativeBroadcast) return nativeBroadcast
  nativeBroadcast = createNativeBroadcast({
    onOffer: (connectionId, sdp) => toPage('native-offer', connectionId, sdp),
    onCandidate: (connectionId, candidate) => toPage('native-candidate', connectionId, candidate),
    onViewerGone: (connectionId) => toPage('native-viewer-gone', connectionId),
    onError: (connectionId, reason) => toPage('native-error', connectionId, reason),
  })
  return nativeBroadcast
}

function configureAudioBridge() {
  // The page cannot read the installed version on its own, and the app updates on a different schedule
  // than the site it loads, so both numbers have to be visible to tell a stale half from a fresh one.
  ipcMain.handle('app-version', () => app.getVersion())
  ipcMain.handle('media-runtime-diagnostics', (event) => {
    if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame || !isTrustedUrl(event.senderFrame.url)) return null
    return mediaRuntime.snapshot()
  })
  ipcMain.handle('window-audio-active', () => Boolean(processAudioCapture))
  ipcMain.on('window-audio-stop', stopProcessAudioCapture)

  // Native capture keeps the frame on the GPU instead of paying Chromium's readback, but it is opt-in:
  // the page only offers the choice when this says the toolchain is actually installed.
  ipcMain.handle('native-capture-available', (event) => fromTrustedPage(event) && findGstreamer() !== null)
  // The same picker the browser path uses, so choosing a source feels identical either way -- including
  // the audio checkbox, whose answer decides this broadcast rather than a setting made earlier
  // elsewhere. Offering it and ignoring it was worse than not offering it at all.
  ipcMain.handle('native-pick-source', async (event, audioRequested) => {
    if (!fromTrustedPage(event)) return null
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 320, height: 180 },
        fetchWindowIcons: true,
      })
      if (!sources.length) return null
      const result = await showSourcePicker(sources, audioRequested === true, supportsProcessLoopback(findGstreamer()))
      return result ? describeSource(result.source, audioRequested === true && result.audio) : null
    } catch { return null }
  })
  ipcMain.handle('native-broadcast-start', async (event, options) => {
    if (!fromTrustedPage(event) || findGstreamer() === null) return false
    try {
      // The page may ask for sound; which process to leave out of it is decided here, because the page
      // cannot know this process's pid and should not be trusted with it if it did.
      const asked = options && typeof options === 'object' ? options : {}
      // Sharing one window with sound means that application's sound, which the picker promises and this
      // path used not to deliver. Resolved here rather than in the page for the same reason the pid below
      // is: the page cannot be trusted to name a process, and it does not know these ids anyway.
      const includePid = asked.audio === true ? windowProcessId(asked.windowHandle) : null
      return await nativeBroadcastInstance().start({ ...asked, includePid, excludePid: process.pid })
    }
    catch { return false }
  })
  ipcMain.handle('native-viewer-add', (event, connectionId) =>
    fromTrustedPage(event) && typeof connectionId === 'string' && nativeBroadcastInstance().addViewer(connectionId))
  ipcMain.handle('native-viewer-answer', (event, connectionId, sdp) =>
    fromTrustedPage(event) && typeof connectionId === 'string' && nativeBroadcastInstance().answer(connectionId, sdp))
  ipcMain.on('native-viewer-remove', (event, connectionId) => {
    if (fromTrustedPage(event) && typeof connectionId === 'string') nativeBroadcastInstance().removeViewer(connectionId)
  })
  ipcMain.on('native-broadcast-stop', (event) => { if (fromTrustedPage(event)) stopNativeBroadcast() })
}

// Nothing may outlive the window that asked for it: a pipeline left running holds the capture and the
// GPU encoder, and the bridge would keep a port open for a page that no longer exists.
function stopNativeBroadcast() {
  const running = nativeBroadcast
  nativeBroadcast = null
  running?.stop().catch(() => {})
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: '#06101c',
    title: 'TelasShare',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  // A link in the chat is an ordinary target=_blank anchor. There are no tabs here, so the window it
  // asks for is refused and the address is handed to the default browser instead -- which is what the
  // same markup does in a browser tab anyway.
  //
  // http as well as https: people paste both, and swallowing one of them silently is worse than opening
  // it. Everything else is still refused. openExternal hands the address to whatever the system has
  // registered for that scheme, so file:, and anything a program installed on this machine claimed, must
  // never reach it -- a message from another person is not allowed to start a program.
  if (buildServer) {
    const label = `TelasShare TESTE — ${new URL(buildServer).host}`
    mainWindow.setTitle(label)
    mainWindow.on('page-title-updated', (event) => { event.preventDefault(); mainWindow.setTitle(label) })
  }
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openIfWeb(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedUrl(url)) { event.preventDefault(); openIfWeb(url) }
  })
  mainWindow.webContents.on('render-process-gone', (_event, details) => mediaRuntime.record('renderer-process-gone', details))
  mainWindow.loadURL(APP_URL)
}

function scheduleRelaunchAfterUpdate(expectedVersion) {
  if (process.platform !== 'win32') return
  const executable = Buffer.from(process.execPath, 'utf8').toString('base64')
  const version = Buffer.from(String(expectedVersion || ''), 'utf8').toString('base64')
  // This helper outlives the app on purpose, and that is exactly why it has to be careful about when it
  // starts one. Three rules, each fixing a way the previous version resurrected an app nobody asked for:
  //
  //   $ok    — only launch if the new version is really on disk. Before, the 90 second loop could time
  //            out with nothing installed and start the old build anyway, so a failed or cancelled
  //            update looked like an app that refused to close.
  //   running— never add a second copy. electron-updater is asked to relaunch as well, and the user may
  //            have reopened the app themselves; either way this helper has nothing left to do.
  //   waiting— bound the wait. Windows recycles process ids, so waiting on a bare id can attach to an
  //            unrelated process and fire minutes later, at what looks like a random moment.
  const script = [
    `$target=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${executable}'))`,
    `$expected=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${version}'))`,
    `$old=Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue`,
    `if($old){$null=$old.WaitForExit(60000)}`,
    `Start-Sleep -Seconds 3`,
    `$ok=[string]::IsNullOrEmpty($expected)`,
    `$deadline=(Get-Date).AddSeconds(90)`,
    `while(-not $ok -and (Get-Date) -lt $deadline){if(Test-Path -LiteralPath $target){try{$installed=(Get-Item -LiteralPath $target).VersionInfo.ProductVersion;if($installed.StartsWith($expected)){$ok=$true;Start-Sleep -Seconds 2}}catch{}};if(-not $ok){Start-Sleep -Seconds 1}}`,
    `$name=[IO.Path]::GetFileNameWithoutExtension($target)`,
    `$running=Get-Process -Name $name -ErrorAction SilentlyContinue`,
    `if($ok -and -not $running -and (Test-Path -LiteralPath $target)){Start-Process -FilePath $target}`,
  ].join(';')
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const helper = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], { detached: true, windowsHide: true, stdio: 'ignore' })
  helper.unref()
}

function showUpdateReady(updateInfo) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (postponedUpdateVersion === updateInfo?.version) return
  if (updateWindow && !updateWindow.isDestroyed()) { updateWindow.focus(); return }
  const version = escapeHtml(updateInfo?.version || 'mais recente')
  updateWindow = new BrowserWindow({
    parent: mainWindow,
    modal: true,
    width: 520,
    height: 390,
    ...centredOnApp(520, 390),
    resizable: false,
    maximizable: false,
    minimizable: false,
    show: false,
    frame: false,
    backgroundColor: '#07111f',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>
    :root{font-family:Segoe UI,Arial,sans-serif;color:#e9f3fb;background:#07111f}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at 50% -10%,#12413e 0,transparent 48%),#07111f}.card{width:100%;height:100%;padding:38px 42px 32px;display:flex;flex-direction:column;align-items:center;text-align:center;border:1px solid #1d3548}.icon{width:64px;height:64px;display:grid;place-items:center;border-radius:20px;background:linear-gradient(145deg,#52e5bb,#28aa8d);color:#052219;box-shadow:0 16px 45px #36d8ad33;font-size:31px;font-weight:800}.icon.working{font-size:0;background:transparent;border:4px solid #24453e;border-top-color:#52e5bb;border-radius:50%;animation:spin .8s linear infinite;box-shadow:none}.eyebrow{margin:20px 0 7px;color:#62e6c1;font-size:11px;font-weight:800;letter-spacing:.14em;text-transform:uppercase}h1{margin:0;font-size:25px}p{margin:12px auto 0;max-width:390px;color:#9bb0c2;font-size:13px;line-height:1.55}.version{color:#dceaf4;font-weight:700}.actions{margin-top:auto;width:100%;display:flex;gap:10px}.actions button{flex:1;padding:13px 16px;border-radius:12px;border:1px solid #2c4356;background:#132538;color:#b8c9d7;font-weight:750;font-size:13px}.actions .primary{border-color:#4de1b7;background:#4de1b7;color:#05251b}.hint{margin-top:13px;color:#688096;font-size:10px}@keyframes spin{to{transform:rotate(360deg)}}</style></head><body><main class="card"><div class="icon">↻</div><div class="eyebrow">Atualização pronta</div><h1>Uma versão nova chegou</h1><p>A versão <span class="version">${version}</span> já foi baixada. O TelasShare pode reiniciar e aplicar o pacote de atualização automaticamente.</p><div class="actions"><button id="later">Depois</button><button id="install" class="primary">Atualizar e reiniciar</button></div><div class="hint">Suas transmissões abertas serão encerradas durante a reinicialização.</div></main><script>const done=value=>location.href='entretelas-update:'+value;document.querySelector('#later').onclick=()=>done('later');document.querySelector('#install').onclick=()=>done('install');window.showInstalling=()=>{document.querySelector('.icon').classList.add('working');document.querySelector('.eyebrow').textContent='Aplicando atualização';document.querySelector('h1').textContent='Instalando…';document.querySelector('p').textContent='O aplicativo fechará por alguns instantes e abrirá novamente sozinho.';document.querySelector('.actions').style.visibility='hidden';document.querySelector('.hint').textContent='Não abra outra cópia do TelasShare enquanto esta etapa termina.'};</script></body></html>`
  updateWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('entretelas-update:')) return
    event.preventDefault()
    const action = url.slice('entretelas-update:'.length)
    if (action === 'install') {
      installingUpdate = true
      updateWindow?.webContents.executeJavaScript('window.showInstalling()').catch(() => {})
      scheduleRelaunchAfterUpdate(updateInfo?.version)
      setTimeout(() => autoUpdater.quitAndInstall(true, true), 1_800)
    } else {
      postponedUpdateVersion = updateInfo?.version || 'latest'
      updateWindow?.destroy(); updateWindow = null
    }
  })
  updateWindow.on('closed', () => { updateWindow = null })
  updateWindow.once('ready-to-show', () => updateWindow?.show())
  updateWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
}

function configureUpdates() {
  if (!app.isPackaged || process.env.PORTABLE_EXECUTABLE_FILE) return
  const CHECK_INTERVAL_MS = 15 * 60 * 1000
  const FOCUS_THROTTLE_MS = 5 * 60 * 1000
  let lastCheck = 0
  let checking = false
  const checkForUpdates = async (force = false) => {
    if (checking || (!force && Date.now() - lastCheck < FOCUS_THROTTLE_MS)) return
    checking = true
    lastCheck = Date.now()
    try { await autoUpdater.checkForUpdates() } catch { /* retry silently on the next interval */ }
    finally { checking = false }
  }
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.disableDifferentialDownload = false
  autoUpdater.on('update-downloaded', showUpdateReady)
  checkForUpdates(true)
  const timer = setInterval(() => checkForUpdates(true), CHECK_INTERVAL_MS)
  mainWindow.on('focus', () => checkForUpdates(false))
  mainWindow.on('closed', () => clearInterval(timer))
}

// Closing the window has to end the process, every time. app.quit() only asks: it fires the quit events,
// waits for every window to close and then for the event loop to drain, and anything still holding a
// handle — a modal nobody destroyed, a pipe to a helper that outlived its kill, a renderer that will not
// come down — leaves the app running with nothing on screen and a live entry in Task Manager.
//
// So do the asking properly first, then stop asking. Destroy the windows outright rather than closing
// them, kill the helpers, and if the process is somehow still here a moment later, exit it. The window
// is already gone by then; there is nothing left to protect by waiting.
let shuttingDown = false
let installingUpdate = false
function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  stopProcessAudioCapture()
  stopNativeBroadcast()
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.destroy()
  }
  // The updater spawns the real installer as a separate detached process and needs this one to leave,
  // so the deadline helps it rather than interrupting it. Give it longer regardless, since it has more
  // to hand over than a normal close.
  // Deliberately not unref'd. An unref'd timer is not guaranteed to fire once nothing else is holding
  // the loop, and this one has to fire in exactly the case where it matters. Holding the loop for its
  // own deadline costs nothing: that is the same wait either way.
  setTimeout(() => app.exit(0), installingUpdate ? 10_000 : 2_000)
}

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus() } })
  app.whenReady().then(() => { configureSession(); configureAudioBridge(); createWindow(); configureUpdates() })
  app.on('window-all-closed', () => { shutdown(); app.quit() })
  // Also covers quitting by any other route: the taskbar menu, Alt+F4 on the last window, a signal, or
  // the updater restarting the app.
  app.on('before-quit', shutdown)
}
