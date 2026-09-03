const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', Object.freeze({
  isDesktop: true,
  isWindowAudioActive: () => ipcRenderer.invoke('window-audio-active'),
  onWindowAudioData: (callback) => {
    const listener = (_event, data) => callback(data)
    ipcRenderer.on('window-audio-data', listener)
    return () => ipcRenderer.removeListener('window-audio-data', listener)
  },
  onWindowAudioError: (callback) => {
    const listener = () => callback()
    ipcRenderer.on('window-audio-error', listener)
    return () => ipcRenderer.removeListener('window-audio-error', listener)
  },
  stopWindowAudio: () => ipcRenderer.send('window-audio-stop'),
}))
window.addEventListener('DOMContentLoaded', () => { document.documentElement.dataset.desktop = 'true' })
