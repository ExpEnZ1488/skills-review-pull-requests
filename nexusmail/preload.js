const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nexus', {
  isDesktop: true,
  openSteam: data => ipcRenderer.invoke('steam:open', data),
  steamVerify: url => ipcRenderer.invoke('steam:verify', url),
  onSteamState: cb => ipcRenderer.on('steam:state', (_e, s) => cb(s)),
  openOutlookSignup: data => ipcRenderer.invoke('outlook:signup', data),
  watchOutlookSteam: data => ipcRenderer.invoke('outlook:watchSteam', data),
  openOutlook: data => ipcRenderer.invoke('outlook:open', data),
  recoveryGet: () => ipcRenderer.invoke('recovery:get'),
  recoverySet: data => ipcRenderer.invoke('recovery:set', data),
  recoveryTest: () => ipcRenderer.invoke('recovery:test'),
  onOutlookState: cb => ipcRenderer.on('outlook:state', (_e, s) => cb(s))
});
