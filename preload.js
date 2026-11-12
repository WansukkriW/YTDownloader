const { contextBridge, ipcRenderer } = require('electron');

const on = (ch) => (cb) => ipcRenderer.on(ch, (_e, d) => cb(d));

contextBridge.exposeInMainWorld('api', {
  init: () => ipcRenderer.invoke('init'),
  paste: () => ipcRenderer.invoke('paste'),
  start: (job) => ipcRenderer.invoke('start', job),
  cancel: () => ipcRenderer.invoke('cancel'),
  openFolder: () => ipcRenderer.invoke('open-folder'),
  openFile: (p) => ipcRenderer.invoke('open-file', p),
  showFile: (p) => ipcRenderer.invoke('show-file', p),
  exists: (paths) => ipcRenderer.invoke('exists', paths),
  onProgress: on('progress'),
  onFile: on('file'),
  onLog: on('log'),
  onDone: on('done'),
  onFocus: on('focus'),
});
