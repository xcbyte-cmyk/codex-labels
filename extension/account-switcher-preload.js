(() => {
  const {contextBridge, ipcRenderer} = require('electron');
  contextBridge.exposeInMainWorld('codexLabelsAccounts', Object.freeze({
    list: () => ipcRenderer.invoke('codex-labels:accounts-list'),
    usage: id => ipcRenderer.invoke('codex-labels:account-usage', id),
    switchTo: (profileId, consent) => ipcRenderer.invoke('codex-labels:account-switch', {profileId, consent: consent === true}),
    onState: callback => {
      if (typeof callback !== 'function') throw new TypeError('callback required');
      const listener = (_event, state) => callback(state);
      ipcRenderer.on('codex-labels:account-state', listener);
      return () => ipcRenderer.removeListener('codex-labels:account-state', listener);
    }
  }));
})();
