const { app, BrowserWindow, desktopCapturer, dialog, session, shell } = require('electron')
const { autoUpdater } = require('electron-updater')
const path = require('node:path')

const APP_URL = 'https://telasshare.onrender.com'
const APP_ORIGIN = new URL(APP_URL).origin
let mainWindow

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
      let selected=-1;let screen=false;const share=document.querySelector('#share');const audio=document.querySelector('#audio');const help=document.querySelector('#audio-help');document.querySelectorAll('.source').forEach(button=>button.onclick=()=>{document.querySelector('.source.selected')?.classList.remove('selected');button.classList.add('selected');selected=Number(button.dataset.index);screen=button.dataset.screen==='true';share.disabled=false;audio.disabled=!screen;audio.checked=screen;help.textContent=screen?'Inclui todos os sons do PC, inclusive Discord. Desmarque para transmitir somente vídeo.':'Janelas são transmitidas sem áudio para impedir que Discord e outros programas vazem. Para áudio isolado de um site, use o EntreTelas no Chrome/Edge e compartilhe uma guia.'});const done=value=>location.href='entretelas-picker:'+value;share.onclick=()=>done(selected+','+(screen&&audio.checked?'1':'0'));document.querySelector('#cancel').onclick=()=>done('cancel');document.querySelector('.close').onclick=()=>done('cancel');</script></body></html>`
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
    callback({ video: result.source, ...(request.audioRequested && result.audio && isEntireScreen ? { audio: 'loopback' } : {}) })
  } catch {
    callback({})
  }
}

function configureSession() {
  const appSession = session.defaultSession
  appSession.setDisplayMediaRequestHandler(chooseDisplaySource)
  appSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(isTrustedUrl(webContents.getURL()) && ['media', 'fullscreen'].includes(permission))
  })
  appSession.setPermissionCheckHandler((webContents, permission) => {
    return isTrustedUrl(webContents?.getURL?.() || '') && ['media', 'fullscreen'].includes(permission)
  })
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

function configureUpdates() {
  if (!app.isPackaged || process.env.PORTABLE_EXECUTABLE_FILE) return
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('update-downloaded', async () => {
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Atualização pronta',
      message: 'Uma versão nova do EntreTelas foi baixada.',
      detail: 'Reinicie agora para usar as mudanças mais recentes.',
      buttons: ['Reiniciar e atualizar', 'Depois'],
      defaultId: 0,
      cancelId: 1,
    })
    if (result.response === 0) autoUpdater.quitAndInstall()
  })
  autoUpdater.checkForUpdatesAndNotify().catch(() => {})
}

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus() } })
  app.whenReady().then(() => { configureSession(); createWindow(); configureUpdates() })
  app.on('window-all-closed', () => app.quit())
}
