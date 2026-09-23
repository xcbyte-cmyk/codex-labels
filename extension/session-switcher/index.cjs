'use strict';
const fs=require('node:fs');
const path=require('node:path');
const childProcess=require('node:child_process');
const {syncBuiltinESMExports}=require('node:module');
const {ProfileStore}=require('./profiles.cjs');
const {DesktopBackend}=require('./backend.cjs');
const {SessionController,RouteJournal}=require('./controller.cjs');
const {DesktopGateway}=require('./gateway.cjs');
const {safeError,fail,assertText}=require('./common.cjs');
const INSTALL=Symbol.for('codex-labels.session-switcher.install');
function install({app,ipcMain,BrowserWindow,check,trustedContent,executable,accountsDirectory,defaultHome,currentProfileId,storageDirectory,enabled=true}) {
  if(globalThis[INSTALL])return globalThis[INSTALL];
  const rawSpawn=childProcess.spawn;
  let gateway=null,controller=null,startError=null;
  const profiles=new ProfileStore({accountsDirectory,defaultHome,currentProfileId});
  function build(home) {
    const journal=new RouteJournal(storageDirectory);
    const c=new SessionController({profiles,journal,createBackend:options=>DesktopBackend.create({...options,profiles,
      spawn:rawSpawn,executable,env:process.env})});
    c.on('changed',()=>{
      for(const w of BrowserWindow.getAllWindows())try{
        if(!w.isDestroyed() && trustedContent(w.webContents))w.webContents.send('codex-labels:session-switcher-changed');
      }catch{}
    });
    return c;
  }
  const samePath=(a,b)=>process.platform==='win32'?path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase():path.resolve(a)===path.resolve(b);
  function wrappedSpawn(command,args,options) {
    const argv=Array.isArray(args)?args:[];
    const opts=Array.isArray(args)?(options||{}):(args||{});
    const candidate=enabled && typeof command==='string' && samePath(command,executable) && argv.includes('app-server') &&
      (!argv.includes('--listen') || argv.includes('stdio://')) && opts.shell!==true;
    const child=Reflect.apply(rawSpawn,this,arguments);
    if(!candidate)return child;
    try {
      // One local primary transport is a supported invariant. A second one is
      // not hijacked or merged into the first account's routing namespace.
      if(gateway) {
        startError={code:'UNSUPPORTED',message:'추가 로컬 서버 연결을 차단했습니다. Labels를 완전히 종료한 뒤 다시 실행하세요.'};
        child.on('error',()=>{});child.stdin?.on('error',()=>{});child.stdin?.end();child.kill();return child;
      }
      const home=opts.env?.CODEX_HOME || process.env.CODEX_HOME || defaultHome;
      controller=build(home);
      gateway=new DesktopGateway({child,controller,home});
    } catch(e) {
      startError=safeError(e);
      // Never bypass durable account routing after a corrupt journal or failed
      // attachment. The still-uninitialized child cannot receive native turns.
      child.on('error',()=>{});child.stdin?.on('error',()=>{});child.stdin?.end();child.kill();
    }
    return child;
  }
  if(enabled){childProcess.spawn=wrappedSpawn;syncBuiltinESMExports();}
  const handle=(channel,action)=>ipcMain.handle(channel,async(event,value)=>{
    check(event);
    try {return {ok:true,value:await action(value)};}catch(error){return {ok:false,error:safeError(error)};}
  });
  function connected() {if(!gateway || !controller || startError)fail('NOT_ATTACHED');return gateway;}
  function id(value) {return assertText(value,200);}
  handle('codex-labels:session-switcher-status',()=>({attached:!!gateway&&!startError,enabled,profiles:profiles.list(),
    threads:gateway?.listThreads()||[],error:startError}));
  handle('codex-labels:session-switcher-inspect',async value=>{
    await connected().ensure(id(value));return controller.snapshot(value);
  });
  handle('codex-labels:session-switcher-switch',async value=>{
    if(!value || typeof value!=='object')fail('INVALID_ARGUMENT');
    const threadId=id(value.threadId);await connected().ensure(threadId);
    return controller.switchAccount(threadId,value.profileId,{confirmContextTransfer:value.confirmContextTransfer===true});
  });
  handle('codex-labels:session-switcher-cancel',value=>{connected();return controller.cancel(id(value));});
  handle('codex-labels:session-switcher-usage',value=>{connected();return controller.usage(id(value));});
  handle('codex-labels:session-switcher-recover',value=>{connected();return controller.recover(id(value));});
  let shuttingDown=false;
  app.on('before-quit',event=>{
    if(shuttingDown || !controller)return;
    event.preventDefault();shuttingDown=true;
    controller.dispose().finally(()=>app.quit()).catch(()=>{});
  });
  const api={dispose:async()=>{if(childProcess.spawn===wrappedSpawn){childProcess.spawn=rawSpawn;syncBuiltinESMExports();}await controller?.dispose();}};
  globalThis[INSTALL]=api;return api;
}
module.exports={install};
