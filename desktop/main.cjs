const { app, BrowserWindow, desktopCapturer, dialog, session, shell } = require('electron')
const { autoUpdater } = require('electron-updater')
const path = require('node:path')

const APP_URL = 'https://telasshare.onrender.com'
const APP_ORIGIN = new URL(APP_URL).origin
let mainWindow

const isTrustedUrl = (value) => {
  try { return new URL(value).origin === APP_ORIGIN } catch { return false }
}

async function chooseDisplaySource(request, callback) {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: true,
    })
    if (!sources.length) return callback({})
    const cancelId = sources.length
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      title: 'Escolher o que compartilhar',
      message: 'Selecione uma tela ou janela',
      detail: 'A captura só começará depois desta confirmação explícita.',
      buttons: [...sources.map((source) => source.name), 'Cancelar'],
      cancelId,
      defaultId: 0,
      noLink: true,
    })
    if (result.response === cancelId) return callback({})
    const source = sources[result.response]
    callback({ video: source, ...(request.audioRequested ? { audio: 'loopback' } : {}) })
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
  if (!app.isPackaged) return
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
