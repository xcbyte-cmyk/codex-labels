// Appended to the existing sandbox preload. No generic invoke or token API.
(() => {
  const {contextBridge,ipcRenderer}=require('electron');
  contextBridge.exposeInMainWorld('codexSessionSwitcher',{
    status:()=>ipcRenderer.invoke('codex-labels:session-switcher-status'),
    inspect:threadId=>ipcRenderer.invoke('codex-labels:session-switcher-inspect',threadId),
    switchAccount:value=>ipcRenderer.invoke('codex-labels:session-switcher-switch',value),
    cancel:threadId=>ipcRenderer.invoke('codex-labels:session-switcher-cancel',threadId),
    usage:threadId=>ipcRenderer.invoke('codex-labels:session-switcher-usage',threadId),
    recover:threadId=>ipcRenderer.invoke('codex-labels:session-switcher-recover',threadId),
    onChanged:callback=>{
      if(typeof callback!=='function')throw new TypeError('callback must be a function');
      const handler=()=>callback();ipcRenderer.on('codex-labels:session-switcher-changed',handler);
      return ()=>ipcRenderer.removeListener('codex-labels:session-switcher-changed',handler);
    }
  });
})();
