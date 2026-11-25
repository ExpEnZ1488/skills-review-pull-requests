const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nexus', {
  isDesktop: true,
  openSteam: data => ipcRenderer.invoke('steam:open', data),
  steamVerify: url => ipcRenderer.invoke('steam:verify', url),
  onSteamState: cb => ipcRenderer.on('steam:state', (_e, s) => cb(s))
});
