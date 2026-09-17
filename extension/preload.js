// Appended to the existing sandbox preload. Only fixed label operations are exposed.
(() => {
  const {contextBridge, ipcRenderer} = require('electron');
  contextBridge.exposeInMainWorld('codexLabels', {
    read: () => ipcRenderer.invoke('codex-labels:read'),
    assign: (key,id) => ipcRenderer.invoke('codex-labels:assign',key,id),
    saveConfig: (config,revision) => ipcRenderer.invoke('codex-labels:save-config',config,revision),
    report: counts => ipcRenderer.invoke('codex-labels:report',counts),
    openConfig: () => ipcRenderer.invoke('codex-labels:open-config')
  });
})();
