'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {SessionRouter} = require('./account-session-router.cjs');
const fixture = path.join(__dirname, '../tests/fixtures/session-switch-backend.cjs');
const delay = ms => new Promise(r => setTimeout(r, ms));
async function setup(t, initial = {}, candidate = {}, timeout = 1000) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(),'labels-session-'));
  fs.writeFileSync(path.join(home,'auth.json'),'KEEP-ORIGINAL-AUTH');
  const children = [], pending = new Map(), notifications = []; let count=0, buffer='';
  const router = new SessionRouter({home, profileId:'a', timeout,
    credential: id => ({profileId:id, identity:id, accessToken:id, chatgptAccountId:`account-${id}`, email:`${id}@example.test`, chatgptPlanType:'plus'}),
    spawnBackend: ({candidate:isCandidate=false}={}) => {
      const child = spawn(process.execPath, [fixture, home, JSON.stringify(isCandidate ? candidate : initial)], {stdio:['pipe','pipe','pipe']});
      children.push(child); return child;
    }});
  router.stdout.on('data', b => {
    buffer += b.toString(); let end;
    while ((end=buffer.indexOf('\n'))!==-1) {
      const m=JSON.parse(buffer.slice(0,end)); buffer=buffer.slice(end+1);
      if (m.method) notifications.push(m);
      else { const fn=pending.get(m.id); if(fn){pending.delete(m.id);fn(m);} }
    }
  });
  t.after(async () => {router.kill(); for(const child of children) child.kill(); await delay(30); fs.rmSync(home,{recursive:true,force:true});});
  function call(method,params={}) {
    const id=++count; return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{pending.delete(id);reject(Error('fixture host response timeout'));},3000);
      pending.set(id,m=>{clearTimeout(timer);resolve(m);}); router.stdin.write(JSON.stringify({id,method,params})+'\n');
    });
  }
  assert.ok((await call('initialize',{clientInfo:{name:'labels_test',version:'1'}})).result);
  router.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');
  return {router,home,children,call,notifications};
}
test('switch keeps frontend streams and local thread id; next request uses B',async t=>{
  const {router,call,home,notifications}=await setup(t);
  const start=await call('thread/start',{cwd:home,model:'fixture-model'}), id=start.result.thread.id;
  const before={stdin:router.stdin,stdout:router.stdout,pid:router.pid};
  const result=await router.switchTo('b');
  assert.equal(result.switched,true); assert.equal(result.resumedThreads,1); assert.equal(router.profileId,'b');
  assert.strictEqual(router.stdin,before.stdin); assert.strictEqual(router.stdout,before.stdout); assert.notEqual(router.pid,before.pid);
  assert.equal((await call('turn/start',{threadId:id})).result.fixtureAccount,'b');
  assert.equal(fs.readFileSync(path.join(home,'auth.json'),'utf8'),'KEEP-ORIGINAL-AUTH');
  assert.ok(notifications.some(m=>m.method==='account/updated'));
});
test('failed authentication leaves A and old process intact; secrets redacted',async t=>{
  const {router,call}=await setup(t,{}, {reject:'account/login/start'}); const pid=router.pid;
  await assert.rejects(router.switchTo('b'),e=>e.code==='BACKEND_REQUEST_FAILED'&&!e.message.includes('SYNTHETIC_SECRET'));
  assert.equal(router.pid,pid); assert.equal(router.profileId,'a');
  assert.equal((await call('account/read')).result.account.email,'a@example.test');
});
test('identity mismatch cannot commit',async t=>{
  const {router}=await setup(t,{}, {badIdentity:true}); const pid=router.pid;
  await assert.rejects(router.switchTo('b'),{code:'IDENTITY_MISMATCH'}); assert.equal(router.pid,pid);
});
test('failed restore leaves original loaded session running',async t=>{
  const {router,call}=await setup(t,{}, {badRestore:true}); await call('thread/start'); const pid=router.pid;
  await assert.rejects(router.switchTo('b'),{code:'RESTORE_FAILED'}); assert.equal(router.pid,pid);
  assert.equal((await call('thread/loaded/list')).result.data[0],'local-1');
});
test('in-flight turn blocks switching before candidate spawn',async t=>{
  const {router,call,children}=await setup(t,{turnDelay:500}); await call('thread/start'); await call('turn/start',{threadId:'local-1'});
  await assert.rejects(router.switchTo('b'),{code:'WORK_IN_PROGRESS'}); assert.equal(children.length,1);
});
test('background terminals block switching without killing them',async t=>{
  const {router,call,children}=await setup(t,{background:true}); await call('thread/start');
  await assert.rejects(router.switchTo('b'),{code:'BACKGROUND_TERMINALS'}); assert.equal(children.length,1);
});
test('untracked loaded thread fails closed',async t=>{
  const {router}=await setup(t,{unknownThread:true}); await assert.rejects(router.switchTo('b'),{code:'UNSUPPORTED_SESSION'});
});
test('ephemeral threads cannot silently lose their context',async t=>{
  const {router,call}=await setup(t,{ephemeral:true}); await call('thread/start');
  await assert.rejects(router.switchTo('b'),{code:'UNSUPPORTED_SESSION'});
});
test('pagination is never mistaken for complete thread inventory',async t=>{
  const {router}=await setup(t,{more:true}); await assert.rejects(router.switchTo('b'),{code:'UNSUPPORTED_SESSION'});
});
test('new host requests are rejected, not queued onto a different account',async t=>{
  const {router,call}=await setup(t,{}, {delay:100}); const switching=router.switchTo('b');
  const denied=await call('turn/start',{threadId:'local-1'}); assert.equal(denied.error.code,-32097);
  await assert.rejects(router.switchTo('a'),{code:'SWITCH_IN_PROGRESS'}); await switching;
});
test('usage probe does not switch or kill active backend',async t=>{
  const {router}=await setup(t); const pid=router.pid;
  const result=await router.usage('b'); assert.equal(result.switched,false); assert.equal(result.usage.rateLimits.primary.usedPercent,12);
  assert.equal(router.pid,pid); assert.equal(router.profileId,'a');
});
test('candidate timeout rolls back and permits subsequent host reads',async t=>{
  const {router,call}=await setup(t,{}, {delay:500},100); const pid=router.pid;
  await assert.rejects(router.switchTo('b'),{code:'BACKEND_TIMEOUT'}); assert.equal(router.pid,pid);
  assert.equal((await call('account/read')).result.account.email,'a@example.test');
});
test('native manual login invalidates tracked selection instead of lying',async t=>{
  const {router,call}=await setup(t); await call('account/logout');
  assert.equal(router.profileId,null); assert.equal(router.state().available,false);
});
test('untracked host-level shell processes disable switching',async t=>{
  const {router,call}=await setup(t); await call('command/exec');
  await assert.rejects(router.switchTo('b'),{code:'BACKEND_UNAVAILABLE'});
});
test('split UTF-8 host frames preserve JSON boundaries',async t=>{
  const {router,notifications}=await setup(t);
  const bytes=Buffer.from(JSON.stringify({id:999,method:'fixture/read',params:{text:'한글'}})+'\n');
  for(const byte of bytes) router.stdin.write(Buffer.from([byte]));
  await delay(20); assert.equal(router.unsafe,false); assert.ok(Array.isArray(notifications));
});

test('history mismatch cannot silently commit a truncated conversation',async t=>{
  const {router,call}=await setup(t,{}, {badHistory:true}); await call('thread/start'); const pid=router.pid;
  await assert.rejects(router.switchTo('b'),{code:'RESTORE_FAILED'}); assert.equal(router.pid,pid);
});
test('per-turn configuration overrides fail closed instead of being lost',async t=>{
  const {router,call}=await setup(t); await call('thread/start'); await call('turn/start',{threadId:'local-1',model:'override'});
  await delay(30); await assert.rejects(router.switchTo('b'),{code:'UNSUPPORTED_SESSION'});
});
test('pending host approval blocks switching before any candidate exists',async t=>{
  const {router,call,children}=await setup(t); await call('fixture/approval');
  await assert.rejects(router.switchTo('b'),{code:'WORK_IN_PROGRESS'}); assert.equal(children.length,1);
});
