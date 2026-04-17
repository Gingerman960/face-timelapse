const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  // Reference photo setup
  setReference: (params) => ipcRenderer.invoke('face:setReference', params),

  // Scanning
  startScan: (params) => ipcRenderer.invoke('face:startScan', params),
  cancelScan: () => ipcRenderer.invoke('face:cancelScan'),
  clearScanCache: (params) => ipcRenderer.invoke('face:clearScanCache', params),
  onScanProgress: (callback) => {
    const listener = (event, data) => callback(data)
    ipcRenderer.on('scan:progress', listener)
    return () => ipcRenderer.removeListener('scan:progress', listener)
  },

  // Alignment
  alignBatch: (params) => ipcRenderer.invoke('face:alignBatch', params),
  cancelAlign: () => ipcRenderer.invoke('face:cancelAlign'),
  onAlignProgress: (callback) => {
    const listener = (event, data) => callback(data)
    ipcRenderer.on('align:progress', listener)
    return () => ipcRenderer.removeListener('align:progress', listener)
  },

  // Video export
  exportVideo: (params) => ipcRenderer.invoke('video:export', params),
  onVideoProgress: (callback) => {
    const listener = (event, data) => callback(data)
    ipcRenderer.on('video:progress', listener)
    return () => ipcRenderer.removeListener('video:progress', listener)
  },

  // Export to folder
  exportToFolder: (params) => ipcRenderer.invoke('export:toFolder', params),
  onExportProgress: (callback) => {
    const listener = (event, data) => callback(data)
    ipcRenderer.on('export:progress', listener)
    return () => ipcRenderer.removeListener('export:progress', listener)
  },

  // Image utilities
  getImageBase64: (filePath) => ipcRenderer.invoke('image:getBase64', { filePath }),
  detectFaceBounds: (imagePath) => ipcRenderer.invoke('face:detectBounds', { imagePath }),
  straightenImage: (params) => ipcRenderer.invoke('image:straighten', params),

  // Dialogs
  chooseFolder: () => ipcRenderer.invoke('dialog:chooseFolder'),
  chooseFile: (filters) => ipcRenderer.invoke('dialog:chooseFile', { filters }),
  savePath: (params) => ipcRenderer.invoke('dialog:savePath', params),
})
