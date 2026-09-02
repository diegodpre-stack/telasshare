const { contextBridge } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', Object.freeze({ isDesktop: true }))
window.addEventListener('DOMContentLoaded', () => { document.documentElement.dataset.desktop = 'true' })
