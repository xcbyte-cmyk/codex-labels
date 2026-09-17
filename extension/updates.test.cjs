'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
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
    const updater=createUpdater('fixture',{execute(_exe,a,o,cb){args=a;options=o;callback=cb;}});
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
