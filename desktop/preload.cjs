const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', Object.freeze({
  isDesktop: true,
  getAppVersion: () => ipcRenderer.invoke('app-version'),
  getMediaRuntimeDiagnostics: () => ipcRenderer.invoke('media-runtime-diagnostics'),
  isWindowAudioActive: () => ipcRenderer.invoke('window-audio-active'),
  onWindowAudioData: (callback) => {
    const listener = (_event, data) => callback(data)
    ipcRenderer.on('window-audio-data', listener)
    return () => ipcRenderer.removeListener('window-audio-data', listener)
  },
  onWindowAudioError: (callback) => {
    const listener = (_event, reason) => callback(reason)
    ipcRenderer.on('window-audio-error', listener)
    return () => ipcRenderer.removeListener('window-audio-error', listener)
  },
  stopWindowAudio: () => ipcRenderer.send('window-audio-stop'),

  // Native capture. The page keeps the signalling socket, so the main process hands it offers and
  // candidates to send and receives the answers that come back -- the pipeline never talks to the
  // server itself. isNativeCaptureAvailable is what decides whether the option is offered at all.
  isNativeCaptureAvailable: () => ipcRenderer.invoke('native-capture-available'),
  pickNativeSource: () => ipcRenderer.invoke('native-pick-source'),
  startNativeBroadcast: (options) => ipcRenderer.invoke('native-broadcast-start', options),
  stopNativeBroadcast: () => ipcRenderer.send('native-broadcast-stop'),
  addNativeViewer: (connectionId) => ipcRenderer.invoke('native-viewer-add', connectionId),
  answerNativeViewer: (connectionId, sdp) => ipcRenderer.invoke('native-viewer-answer', connectionId, sdp),
  removeNativeViewer: (connectionId) => ipcRenderer.send('native-viewer-remove', connectionId),
  onNativeOffer: (callback) => {
    const listener = (_event, connectionId, sdp) => callback(connectionId, sdp)
    ipcRenderer.on('native-offer', listener)
    return () => ipcRenderer.removeListener('native-offer', listener)
  },
  onNativeCandidate: (callback) => {
    const listener = (_event, connectionId, candidate) => callback(connectionId, candidate)
    ipcRenderer.on('native-candidate', listener)
    return () => ipcRenderer.removeListener('native-candidate', listener)
  },
  onNativeViewerGone: (callback) => {
    const listener = (_event, connectionId) => callback(connectionId)
    ipcRenderer.on('native-viewer-gone', listener)
    return () => ipcRenderer.removeListener('native-viewer-gone', listener)
  },
  onNativeError: (callback) => {
    const listener = (_event, connectionId, reason) => callback(connectionId, reason)
    ipcRenderer.on('native-error', listener)
    return () => ipcRenderer.removeListener('native-error', listener)
  },
}))
window.addEventListener('DOMContentLoaded', () => { document.documentElement.dataset.desktop = 'true' })
