// Appended to the existing sandbox preload. Never expose raw IPC or native events.
(() => {
  const {contextBridge, ipcRenderer} = require('electron');
  contextBridge.exposeInMainWorld('codexLabels', {
    read: knownVersion => ipcRenderer.invoke('codex-labels:read', knownVersion),
    onChanged: callback => {
      if (typeof callback !== 'function') throw new TypeError('callback must be a function');
      const listener = () => callback();
      ipcRenderer.on('codex-labels:changed', listener);
      return () => ipcRenderer.removeListener('codex-labels:changed', listener);
    },
    assign: (key, id) => ipcRenderer.invoke('codex-labels:assign', key, id),
    saveConfig: (config, revision) => ipcRenderer.invoke('codex-labels:save-config', config, revision),
    report: counts => ipcRenderer.invoke('codex-labels:report', counts),
    openConfig: () => ipcRenderer.invoke('codex-labels:open-config'),
    updateStatus: () => ipcRenderer.invoke('codex-labels:update-status'),
    checkUpdate: () => ipcRenderer.invoke('codex-labels:update-check'),
    stageUpdate: () => ipcRenderer.invoke('codex-labels:update-stage'),
    restartUpdate: () => ipcRenderer.invoke('codex-labels:restart-update'),
    notifyThread: value => ipcRenderer.invoke('codex-labels:notify-thread', value),
    notificationStatus: () => ipcRenderer.invoke('codex-labels:notification-status'),
    activationReady: () => ipcRenderer.invoke('codex-labels:activation-ready'),
    acknowledgeActivation: (eventId, result) => ipcRenderer.invoke('codex-labels:activation-ack', eventId, result),
    onActivateThread: callback => {
      if (typeof callback !== 'function') throw new TypeError('callback must be a function');
      const listener = (_event, value) => callback(value);
      ipcRenderer.on('codex-labels:activate-thread', listener);
      return () => ipcRenderer.removeListener('codex-labels:activate-thread', listener);
    }
  });
})();
