'use strict';
// Loaded once by early-bootstrap.js. Does not expose arbitrary file or shell access.
const {app,ipcMain,shell,BrowserWindow} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const {fileURLToPath} = require('node:url');
const {createStore} = require('./codex-labels-store.cjs');
const {configDirectory} = require('./codex-labels-location.json');
const store = createStore(configDirectory);
const statusPath = path.join(configDirectory,'runtime-status.json');
function recordStatus(counts) {
  const value={version:2,status:'active',settingsAvailable:true,updatedAt:new Date().toISOString(),processId:process.pid,configPath:store.configPath,userDataPath:app.getPath('userData'),...counts};
  const temp=statusPath+'.tmp-'+process.pid;
  try {fs.writeFileSync(temp,JSON.stringify(value,null,2));fs.renameSync(temp,statusPath);} catch(e){console.error('[codex-labels] status:',e.message);}
}
const preloadPath = path.join(__dirname,'preload.js');
const webRoot = path.resolve(__dirname,'../../webview');
function trustedUrl(value) {
  try {
    const u = new URL(value);
    // Keep working when the packaged UI changes its client-side route.
    if (u.protocol === 'app:' && u.hostname === '-') return true;
    return u.protocol === 'file:' && path.resolve(fileURLToPath(u)) === path.join(webRoot,'index.html');
  } catch { return false; }
}
function trustedContent(contents) {
  return !contents.isDestroyed() && path.resolve(contents.getLastWebPreferences().preload || '.') === preloadPath && trustedUrl(contents.getURL());
}
function check(event) {
  if (event.senderFrame !== event.sender.mainFrame || !trustedContent(event.sender)) throw Error('라벨 설정에 접근할 수 없는 화면입니다.');
}
ipcMain.handle('codex-labels:read',event=>{check(event);return store.snapshot();});
ipcMain.handle('codex-labels:assign',(event,key,id)=>{check(event);return store.assign(key,id);});
ipcMain.handle('codex-labels:save-config',(event,draft,expectedRevision)=>{check(event);return store.saveConfig(draft,expectedRevision);});
ipcMain.handle('codex-labels:report',(event,counts)=>{
  check(event);
  if(!counts || !Number.isSafeInteger(counts.rows) || !Number.isSafeInteger(counts.badges) || counts.rows<0 || counts.badges<0 || counts.rows>10000 || counts.badges>10000) throw Error('Invalid label counts');
  recordStatus({rows:counts.rows,badges:counts.badges});return true;
});
ipcMain.handle('codex-labels:open-config',async event=>{
  check(event); const result = await shell.openPath(store.configPath); if(result) throw Error(result);return true;
});
const source = fs.readFileSync(path.join(__dirname,'codex-labels-renderer.js'),'utf8');
const titledWindows = new WeakSet();
app.on('web-contents-created',(_event,contents)=>{
  contents.on('did-finish-load',()=>{
    if (!trustedContent(contents)) return;
    const window = BrowserWindow.fromWebContents(contents);
    if (window && !window.isDestroyed()) {
      window.setTitle('Codex Labels');
      if (!titledWindows.has(window)) {
        titledWindows.add(window);
        window.on('page-title-updated',event=>{
          if (trustedContent(contents) && !window.isDestroyed()) { event.preventDefault(); window.setTitle('Codex Labels'); }
        });
      }
    }
    contents.executeJavaScript(source).catch(e=>console.error('[codex-labels] initialization failed:',e.message));
  });
});
