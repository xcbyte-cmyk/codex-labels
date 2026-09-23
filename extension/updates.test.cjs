'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {EventEmitter} = require('node:events');
const {installStaged, createUpdater} = require('./updates.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'labels-update-'));
  t.after(() => fs.rmSync(root, {recursive:true,force:true}));
  const staged = path.join(root,'.updates','stage-test');fs.mkdirSync(staged,{recursive:true});
  const result = {available:true,latestVersion:'0.3.0',stagedDirectory:'stage-test',hashes:{}};
  for (const name of ['build-info.json','CodexLabelsHelper.exe']) {
    const content=Buffer.from('new-'+name);fs.writeFileSync(path.join(staged,name),content);
    fs.writeFileSync(path.join(root,name),'previous-'+name);
    result.hashes[name]=crypto.createHash('sha256').update(content).digest('hex');
  }
  fs.writeFileSync(path.join(root,'labels.json'),'personal');fs.writeFileSync(path.join(root,'assignments.json'),'assigned');
  return {root,staged,result};
}
test('verified staged helper is installed after subprocess exits, with backups and untouched personal files',t=>{
  const {root,staged,result}=fixture(t);
  assert.equal(installStaged(root,result).pendingRestart,true);
  for(const name of ['build-info.json','CodexLabelsHelper.exe']){
    assert.equal(fs.readFileSync(path.join(root,name),'utf8'),'new-'+name);
    assert.equal(fs.readFileSync(path.join(staged,'previous',name),'utf8'),'previous-'+name);
  }
  assert.equal(fs.readFileSync(path.join(root,'labels.json'),'utf8'),'personal');
  assert.equal(fs.readFileSync(path.join(root,'assignments.json'),'utf8'),'assigned');
});
test('failed executable replacement restores metadata and retains old executable',t=>{
  const {root,result}=fixture(t);
  const io={...fs,renameSync(from,to){if(to.endsWith('.exe'))throw Error('locked');return fs.renameSync(from,to);}};
  assert.throws(()=>installStaged(root,result,io),/locked/);
  for(const name of ['build-info.json','CodexLabelsHelper.exe'])assert.equal(fs.readFileSync(path.join(root,name),'utf8'),'previous-'+name);
});
test('tampered staging or traversal is rejected before replacements',t=>{
  const {root,staged,result}=fixture(t);
  assert.throws(()=>installStaged(root,{...result,stagedDirectory:'../outside'}));
  fs.appendFileSync(path.join(staged,'CodexLabelsHelper.exe'),'tamper');
  assert.throws(()=>installStaged(root,result),/변경/);
  assert.equal(fs.readFileSync(path.join(root,'build-info.json'),'utf8'),'previous-build-info.json');
});
test('helper bridge is single flight, fixed command, no shell, and clears inherited extraction environment',async()=>{
  let callback, args, options;
  const old=process.env._PYI_APPLICATION_HOME_DIR;process.env._PYI_APPLICATION_HOME_DIR='stale';
  try{
    const updater=createUpdater('fixture',{execute(_exe,a,o,cb){if(a[0]==='codex-status'){cb(null,'{"state":"same"}');return;}args=a;options=o;callback=cb;}});
    const pending=updater.check();
    assert.equal(args[0],'update-check');assert.equal(options.windowsHide,true);assert.equal(options.shell,undefined);
    assert.equal(options.env._PYI_APPLICATION_HOME_DIR,undefined);assert.equal(options.env.PYINSTALLER_RESET_ENVIRONMENT,'1');
    await assert.rejects(updater.stage(),/진행 중/);
    callback(null,'{"available":false,"currentVersion":"0.2.0"}');
    assert.equal((await pending).available,false);
    const retry=updater.stage();assert.equal(args[0],'update-stage');callback(Error('offline'),'연결 실패');
    await assert.rejects(retry,/연결 실패/);
    const next=updater.check();callback(null,'{"available":false}');await next;
  }finally{if(old===undefined)delete process.env._PYI_APPLICATION_HOME_DIR;else process.env._PYI_APPLICATION_HOME_DIR=old;}
});
test('local status reports running version separately and restart quits only after worker acknowledgement',async t=>{
  const {root}=fixture(t);const runtime=path.join(root,'runtime/app');fs.mkdirSync(runtime,{recursive:true});
  fs.writeFileSync(path.join(runtime,'codex-labels-build.json'),JSON.stringify({helperVersion:'0.1.0'}));
  let quits=0,requested;
  const updater=createUpdater(root,{
    execute(_exe,args,_options,cb){if(args[0]==='codex-status'){cb(null,'{"state":"same"}');return;}assert.equal(args[0],'update-status');cb(null,JSON.stringify({currentVersion:'0.2.1',downloadedVersion:'0.2.1',pendingRestart:true}));},
    start(_exe,args,options){
      requested=args;assert.equal(options.detached,true);assert.equal(options.windowsHide,true);assert.equal(options.cwd,root);
      const child=new EventEmitter();child.unref=()=>{};
      const token=args.at(-1);setTimeout(()=>fs.writeFileSync(path.join(root,'.restarts',token+'.json'),JSON.stringify({ready:true,token,processId:42})),10);
      return child;
    },quit(){quits++;}
  });
  const status=await updater.status();assert.equal(status.currentVersion,'0.1.0');assert.equal(status.downloadedVersion,'0.2.1');
  const action=updater.restart();assert.equal(quits,0);
  assert.equal((await action).restarting,true);assert.equal(quits,0);
  assert.ok(requested.includes(String(process.pid)));
  await new Promise(resolve=>setTimeout(resolve,300));assert.equal(quits,1);
});

test('reopening local status preserves a checked release without another network check',async()=>{
  const calls=[];let failCheck=false;
  const updater=createUpdater('fixture',{execute(_exe,args,_options,cb){
    const action=args[0];calls.push(action);
    if(action==='codex-status')return cb(null,'{"state":"same"}');
    if(action==='update-check'&&failCheck)return cb(Error('offline'),'연결 실패');
    cb(null,JSON.stringify(action==='update-check'
      ?{currentVersion:'0.2.1',latestVersion:'0.2.2',available:true}
      :{currentVersion:'0.2.1',downloadedVersion:'0.2.1',pendingRestart:false}));
  }});
  assert.equal((await updater.status()).latestVersion,undefined);
  await updater.check();
  const status=await updater.status();
  assert.equal(status.latestVersion,'0.2.2');assert.equal(status.available,true);
  assert.equal(status.downloadedVersion,'0.2.1');assert.equal(status.pendingRestart,false);
  assert.equal(calls.filter(action=>action==='update-check').length,1);
  failCheck=true;await assert.rejects(updater.check(),/연결 실패/);
  assert.equal((await updater.status()).available,true);
});

test('downloaded local state takes precedence over previously available release',async()=>{
  let downloaded='0.2.1';
  const updater=createUpdater('fixture',{execute(_exe,args,_options,cb){
    if(args[0]==='codex-status')return cb(null,'{"state":"same"}');
    cb(null,JSON.stringify(args[0]==='update-check'
      ?{currentVersion:'0.2.1',latestVersion:'0.2.2',available:true}
      :{currentVersion:'0.2.1',downloadedVersion:downloaded,pendingRestart:downloaded!=='0.2.1'}));
  }});
  await updater.check();downloaded='0.2.2';
  const status=await updater.status();
  assert.equal(status.available,false);assert.equal(status.pendingRestart,true);
  assert.equal(status.latestVersion,'0.2.2');
});
test('missing helper acknowledgement leaves the app running and retry available',async t=>{
  const {root}=fixture(t);let quits=0;
  const updater=createUpdater(root,{ackTimeout:10,quit(){quits++;},
    execute(_e,_a,_o,cb){cb(null,'{"pendingRestart":true}');},
    start(){const child=new EventEmitter();child.unref=()=>{};return child;}});
  await assert.rejects(updater.restart(),/앱을 종료하지/);assert.equal(quits,0);
  await updater.status();
});

test('rollback uses the same acknowledged restart gate and never stages an update',async t=>{
  const {root}=fixture(t);let action,quits=0;
  const updater=createUpdater(root,{ackTimeout:1000,
    execute(_exe,args,_options,cb){assert.equal(args[0],'update-status');cb(null,'{"rollbackAvailable":true,"pendingRestart":false}');},
    start(_exe,args){action=args[0];const child=new EventEmitter();child.unref=()=>{};
      const token=args.at(-1);setTimeout(()=>fs.writeFileSync(path.join(root,'.restarts',token+'.json'),JSON.stringify({ready:true,token,processId:42})),10);return child;},
    quit(){quits++;}
  });
  assert.equal((await updater.rollback()).restarting,true);assert.equal(action,'rollback');assert.equal(quits,0);
  await new Promise(resolve=>setTimeout(resolve,300));assert.equal(quits,1);
});
test('original Codex detection is local, cached once, and cannot download or restart',async()=>{
  const calls=[];
  const updater=createUpdater('fixture',{execute(_exe,args,_options,cb){
    calls.push(args[0]);
    cb(null,JSON.stringify(args[0]==='codex-status'?{state:'changed',baseVersion:'26.1.0',installedVersion:'27.1.0',newer:true}:{pendingRestart:false}));
  },start(){assert.fail('must not restart');},install(){assert.fail('must not install');}});
  await updater.prime();
  assert.deepEqual(calls,['codex-status']);
  assert.equal((await updater.status()).codex.state,'changed');
  await updater.status();
  assert.deepEqual(calls,['codex-status','update-status','update-status']);
});
test('original detection failure does not break ordinary Labels status',async()=>{
  const updater=createUpdater('fixture',{execute(_exe,args,_options,cb){
    if(args[0]==='codex-status')cb(Error('no installation'), '');else cb(null,'{"pendingRestart":false}');
  }});
  assert.equal((await updater.status()).codex.state,'unavailable');
});
