const { app, BrowserWindow, desktopCapturer, ipcMain, session, shell } = require('electron')
const { autoUpdater } = require('electron-updater')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const APP_URL = 'https://telasshare.onrender.com'

// Chromium reads each of these switches once, so every feature has to travel in a single list. Adding
// a second appendSwitch for the same switch name silently replaces the first.
const disabledFeatures = [
  // Chromium hides host candidates behind .local mDNS names. A browser resolves its own names, but the
  // packaged app does not, so every host candidate is dead on arrival and only the relay path survives.
  'WebRtcHideLocalIpsWithMdns',
]
const enabledFeatures = []
app.commandLine.appendSwitch('force-webrtc-ip-handling-policy', 'default')

// A page cannot choose how the browser copies the screen, which is why the same site captures at very
// different rates on different machines: measured here, a 1440p screen cost about 7.5 ms of work per
// megapixel per frame, holding the source near 36 FPS with a game running and to 52 while idle.
// ZeroCopyDesktopCapture keeps captured frames in GPU memory instead of copying them out to the CPU
// and back. Chromium ships it off by default while it rolls out, and the packaged app is the only
// place we can ask for it — a browser tab has no say over its own command line.
//
// Keeping frames on the GPU during capture only pays off if nothing downstream drags them back, and a
// software encoder does exactly that: it needs the pixels in CPU memory. Chromium was picking
// MediaFoundationSoftwareVideoEncoder here even though the GPU reports a hardware encoder available.
// ForceSoftwareForRtcLowResolutions, on by default outside Android, pins a call to a software encoder
// while the picture is small. A broadcast starts small on purpose — bandwidth estimation opens around
// 0.3 Mbps and the encoder picks a matching size — so the decision is taken at the one moment the
// answer is guaranteed to be "small", and the resolution climbing afterwards does not revisit it.
//
// Every name here was checked against this Electron's Chromium (152) first: an unknown feature is
// ignored without a word, which looks exactly like a change that did not help. A second candidate,
// MediaFoundationSharedImageEncode, exists only on Chromium main and was left out for that reason.
// Both are experimental, so ENTRETELAS_GPU_CAPTURE=0 turns them off without needing a new build.
if (process.env.ENTRETELAS_GPU_CAPTURE !== '0') {
  enabledFeatures.push('ZeroCopyDesktopCapture')
  disabledFeatures.push('ForceSoftwareForRtcLowResolutions')
}
if (enabledFeatures.length) app.commandLine.appendSwitch('enable-features', enabledFeatures.join(','))
if (disabledFeatures.length) app.commandLine.appendSwitch('disable-features', disabledFeatures.join(','))
const APP_ORIGIN = new URL(APP_URL).origin
let mainWindow
let processAudioCapture = null
let updateWindow = null
let postponedUpdateVersion = null

const audioHelperPath = () => app.isPackaged
  ? path.join(process.resourcesPath, 'native', 'process-audio-capture.exe')
  : path.join(__dirname, '..', 'native', 'bin', 'process-audio-capture.exe')
const processAudioAvailable = () => process.platform === 'win32' && fs.existsSync(audioHelperPath())

function stopProcessAudioCapture() {
  if (!processAudioCapture) return
  processAudioCapture.kill()
  processAudioCapture = null
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

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])
}

function showSourcePicker(sources, audioRequested) {
  return new Promise((resolve) => {
    let finished = false
    const picker = new BrowserWindow({
      parent: mainWindow,
      modal: true,
      width: 940,
      height: 680,
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
      const processAudio=${processAudioAvailable()};let selected=-1;let screen=false;const share=document.querySelector('#share');const audio=document.querySelector('#audio');const help=document.querySelector('#audio-help');document.querySelectorAll('.source').forEach(button=>button.onclick=()=>{document.querySelector('.source.selected')?.classList.remove('selected');button.classList.add('selected');selected=Number(button.dataset.index);screen=button.dataset.screen==='true';share.disabled=false;audio.disabled=!screen&&!processAudio;audio.checked=screen||processAudio;help.textContent=screen?'Inclui todos os sons do PC, inclusive Discord. Desmarque para transmitir somente vídeo.':processAudio?'Captura somente o áudio do aplicativo escolhido e de seus processos filhos. Outros programas, como Discord, ficam de fora.':'Captura por aplicativo indisponível nesta versão. A janela será transmitida sem áudio.'});const done=value=>location.href='entretelas-picker:'+value;share.onclick=()=>done(selected+','+(audio.checked?'1':'0'));document.querySelector('#cancel').onclick=()=>done('cancel');document.querySelector('.close').onclick=()=>done('cancel');</script></body></html>`
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
    const result = await showSourcePicker(sources, request.audioRequested)
    if (!result) return callback({})
    const isEntireScreen = result.source.id.startsWith('screen:')
    const nativeAudio = request.audioRequested && result.audio && !isEntireScreen && startProcessAudioCapture(result.source)
    callback({ video: result.source, ...(request.audioRequested && result.audio && isEntireScreen ? { audio: 'loopback' } : {}) })
    if (!nativeAudio && !isEntireScreen) stopProcessAudioCapture()
  } catch {
    callback({})
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

function configureAudioBridge() {
  // The page cannot read the installed version on its own, and the app updates on a different schedule
  // than the site it loads, so both numbers have to be visible to tell a stale half from a fresh one.
  ipcMain.handle('app-version', () => app.getVersion())
  ipcMain.handle('window-audio-active', () => Boolean(processAudioCapture))
  ipcMain.on('window-audio-stop', stopProcessAudioCapture)
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: '#06101c',
    title: 'EntreTelas',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedUrl(url)) { event.preventDefault(); if (url.startsWith('https://')) shell.openExternal(url) }
  })
  mainWindow.loadURL(APP_URL)
}

function scheduleRelaunchAfterUpdate(expectedVersion) {
  if (process.platform !== 'win32') return
  const executable = Buffer.from(process.execPath, 'utf8').toString('base64')
  const version = Buffer.from(String(expectedVersion || ''), 'utf8').toString('base64')
  const script = `$target=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${executable}'));$expected=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${version}'));Wait-Process -Id ${process.pid} -ErrorAction SilentlyContinue;Start-Sleep -Seconds 3;$deadline=(Get-Date).AddSeconds(90);while((Get-Date)-lt $deadline){if(Test-Path -LiteralPath $target){try{$installed=(Get-Item -LiteralPath $target).VersionInfo.ProductVersion;if((-not $expected) -or $installed.StartsWith($expected)){Start-Sleep -Seconds 2;break}}catch{}};Start-Sleep -Seconds 1};if(Test-Path -LiteralPath $target){Start-Process -FilePath $target}`
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
    resizable: false,
    maximizable: false,
    minimizable: false,
    show: false,
    frame: false,
    backgroundColor: '#07111f',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>
    :root{font-family:Segoe UI,Arial,sans-serif;color:#e9f3fb;background:#07111f}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at 50% -10%,#12413e 0,transparent 48%),#07111f}.card{width:100%;height:100%;padding:38px 42px 32px;display:flex;flex-direction:column;align-items:center;text-align:center;border:1px solid #1d3548}.icon{width:64px;height:64px;display:grid;place-items:center;border-radius:20px;background:linear-gradient(145deg,#52e5bb,#28aa8d);color:#052219;box-shadow:0 16px 45px #36d8ad33;font-size:31px;font-weight:800}.icon.working{font-size:0;background:transparent;border:4px solid #24453e;border-top-color:#52e5bb;border-radius:50%;animation:spin .8s linear infinite;box-shadow:none}.eyebrow{margin:20px 0 7px;color:#62e6c1;font-size:11px;font-weight:800;letter-spacing:.14em;text-transform:uppercase}h1{margin:0;font-size:25px}p{margin:12px auto 0;max-width:390px;color:#9bb0c2;font-size:13px;line-height:1.55}.version{color:#dceaf4;font-weight:700}.actions{margin-top:auto;width:100%;display:flex;gap:10px}.actions button{flex:1;padding:13px 16px;border-radius:12px;border:1px solid #2c4356;background:#132538;color:#b8c9d7;font-weight:750;font-size:13px}.actions .primary{border-color:#4de1b7;background:#4de1b7;color:#05251b}.hint{margin-top:13px;color:#688096;font-size:10px}@keyframes spin{to{transform:rotate(360deg)}}</style></head><body><main class="card"><div class="icon">↻</div><div class="eyebrow">Atualização pronta</div><h1>Uma versão nova chegou</h1><p>A versão <span class="version">${version}</span> já foi baixada. O EntreTelas pode reiniciar e aplicar o pacote de atualização automaticamente.</p><div class="actions"><button id="later">Depois</button><button id="install" class="primary">Atualizar e reiniciar</button></div><div class="hint">Suas transmissões abertas serão encerradas durante a reinicialização.</div></main><script>const done=value=>location.href='entretelas-update:'+value;document.querySelector('#later').onclick=()=>done('later');document.querySelector('#install').onclick=()=>done('install');window.showInstalling=()=>{document.querySelector('.icon').classList.add('working');document.querySelector('.eyebrow').textContent='Aplicando atualização';document.querySelector('h1').textContent='Instalando…';document.querySelector('p').textContent='O aplicativo fechará por alguns instantes e abrirá novamente sozinho.';document.querySelector('.actions').style.visibility='hidden';document.querySelector('.hint').textContent='Não abra outra cópia do EntreTelas enquanto esta etapa termina.'};</script></body></html>`
  updateWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('entretelas-update:')) return
    event.preventDefault()
    const action = url.slice('entretelas-update:'.length)
    if (action === 'install') {
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

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus() } })
  app.whenReady().then(() => { configureSession(); configureAudioBridge(); createWindow(); configureUpdates() })
  app.on('window-all-closed', () => { stopProcessAudioCapture(); app.quit() })
}
