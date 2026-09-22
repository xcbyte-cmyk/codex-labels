'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const childProcess = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const {WorkspaceCoordinator, WorkspaceConnection, SelectionStore, install} = require('../extension/session-switcher/index.cjs');
const {AppServerRpc} = require('../extension/session-switcher/rpc.cjs');
const {ProfileStore, DEFAULT_ID} = require('../extension/session-switcher/profiles.cjs');
const {Server, token, principal, auth, tick, B} = require('./fixtures/workspace-lifecycle-server.cjs');
const C = 'c'.repeat(32);
async function until(fn) { for (let i=0;i<500;i++) { if (fn()) return; await tick(); } assert.fail('condition did not settle'); }
async function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'labels-lifecycle-'));
  const home = path.join(root, 'home'), accountsDirectory = path.join(root, 'accounts'), storageDirectory = path.join(root, 'selection');
  auth(home, token('A'));
  for (const [id, name] of [[B,'B'],[C,'C']]) {
    auth(path.join(accountsDirectory,id,'codex-home'), token(name));
    fs.writeFileSync(path.join(accountsDirectory,id,'account.json'), JSON.stringify({id,name}));
  }
  const profiles = new ProfileStore({accountsDirectory,defaultHome:home});
  let group = new WorkspaceCoordinator({home,profiles,storageDirectory});
  const allGroups = [group], clients = [], servers = [];
  async function add({start=true, tweak=()=>{}}={}) {
    const server = new Server(home); tweak(server); servers.push(server);
    const connection = new WorkspaceConnection({child:server,home,profiles,storageDirectory,coordinator:group,rpcOptions:{timeoutMs:1000}});
    const client = new AppServerRpc(server,{timeoutMs:2000}); clients.push(client);
    async function init(){ await client.initialize(); await connection.bootstrap(); await group.settleJoins(); }
    if(start) await init();
    return {server,connection,client,init};
  }
  t.after(async()=>{
    for(const g of allGroups) await g.dispose().catch(()=>{});
    for(const c of clients) await c.close().catch(()=>{});
    fs.rmSync(root,{recursive:true,force:true});
  });
  return {root,home,profiles,accountsDirectory,storageDirectory,add,servers,clients,
    get group(){return group;}, restart(){group = new WorkspaceCoordinator({home,profiles,storageDirectory});allGroups.push(group);return group;}};
}
const switchTo = (g,id=B)=>g.switchAccount(id,{confirmContextTransfer:true});
const recover = g=>g.recover({confirmContextTransfer:true});
async function run(client,threadId='thread-0') {
  const r=await client.call('turn/start',{threadId,input:[]});
  await client.call('turn/interrupt',{threadId}); return r.turn.account;
}

test('two physical connections are kept alive, preserve 611 local rows and both switch to B',async t=>{
  const h=await setup(t),a=await h.add(),b=await h.add();
  const before=fs.readFileSync(a.server.rowsFile),originalAuth=fs.readFileSync(path.join(h.home,'auth.json'));
  assert.equal(h.group.phase,'idle');assert.equal(h.group.snapshot().connectionCount,2);
  const changed=await switchTo(h.group);
  assert.equal(changed.state.phase,'idle');assert.equal(changed.state.verifiedConnectionCount,2);
  assert.equal(a.server.exitCode,null);assert.equal(b.server.exitCode,null);
  assert.equal(await run(a.client),'B');assert.equal(await run(b.client,'thread-603'),'B');
  assert.equal((await b.client.call('thread/list',{cursor:'600',limit:10})).data.length,7);
  assert.equal((await a.client.call('thread/list',{archived:true})).data.length,4);
  assert.deepEqual(fs.readFileSync(a.server.rowsFile),before);assert.deepEqual(fs.readFileSync(path.join(h.home,'auth.json')),originalAuth);
});
test('old and replacement overlap: idle close is not a global unsupported or closed error',async t=>{
  const h=await setup(t),a=await h.add();await switchTo(h.group);
  const b=await h.add();a.server.kill();await tick();
  assert.equal(h.group.phase,'idle');assert.equal(h.group.snapshot().connectionCount,1);
  assert.equal(await run(b.client),'B');
});
test('all transports may disappear; remembered B is re-applied before the first replacement request',async t=>{
  const h=await setup(t),a=await h.add();await switchTo(h.group);a.server.kill();await tick();
  assert.equal(h.group.phase,'disconnected');assert.equal(h.group.active.id,B);
  const b=await h.add({start:false});await b.init();
  assert.equal(await run(b.client),'B');assert.equal(principal(b.server.value),'B');
});
test('initialize and initialized complete before join auth probes, even on a saved B selection',async t=>{
  const h=await setup(t);new SelectionStore(h.storageDirectory,h.home).write('selected',h.profiles.pin(B));h.restart();
  let initialized=false,early=0;
  const a=await h.add({start:false,tweak:s=>{
    const receive=s.receive.bind(s);s.receive=async m=>{if(m.method==='initialized')initialized=true;
      if(m.method!=='initialize'&&m.method!=='initialized'&&!initialized)early++;return receive(m);};
  }});
  assert.equal(a.server.calls.length,0);await a.init();assert.equal(early,0);assert.equal(await run(a.client),'B');
});
test('Desktop may pipeline initialized before the initialize response',async t=>{
  const h=await setup(t); let release;
  const wait=new Promise(resolve=>{release=resolve;});
  const a=await h.add({start:false,tweak:s=>{s.initializeWait=wait;}});
  const response=a.client.call('initialize',{clientInfo:{name:'desktop'},capabilities:{}});
  a.client.notify('initialized');
  await tick(); assert.equal(a.connection.initialized,false);
  release(); await response; await until(()=>a.connection.initialized && a.connection.verified);
  assert.equal(h.group.phase,'idle'); assert.equal(await run(a.client),'A');
});
test('a joining peer is quarantined and blocks new work on existing peers until pinned auth finishes',async t=>{
  const h=await setup(t),a=await h.add();await switchTo(h.group);
  let release;const b=await h.add({start:false,tweak:s=>{s.loginWait=new Promise(r=>release=r);}});
  const init=b.init();await until(()=>b.server.calls.some(c=>c.method==='account/login/start'));
  assert.equal(h.group.phase,'synchronizing');
  assert.ok((await a.client.exchange('turn/start',{threadId:'thread-0'})).error);
  const request=run(b.client);release();await init;assert.equal(await request,'B');
  assert.equal(h.group.snapshot().verifiedConnectionCount,2);
});
test('B cannot be silently replaced with native A when new connection has missing target credentials',async t=>{
  const h=await setup(t),a=await h.add();await switchTo(h.group);a.server.kill();
  fs.unlinkSync(path.join(h.profiles.resolve(B).home,'auth.json'));
  const b=await h.add();assert.equal(h.group.phase,'blocked');
  assert.ok((await b.client.exchange('turn/start',{threadId:'thread-0'})).error);
  assert.equal(b.server.calls.some(c=>c.method==='turn/start'),false);
  assert.ok((await b.client.call('thread/list')).data.length);
});
test('a new spawn during switching aborts the snapshot transaction, rolls back survivors and joins A',async t=>{
  const h=await setup(t),a=await h.add();let release;a.server.loginWait=new Promise(r=>release=r);
  const changing=switchTo(h.group),rejection=assert.rejects(changing,{code:'BUSY'});
  await until(()=>a.server.calls.some(c=>c.method==='account/login/start'));
  const b=await h.add({start:false}),init=b.init();release();await rejection;await init;
  assert.equal(principal(a.server.value),'A');assert.equal(principal(b.server.value),'A');
  assert.equal(h.group.phase,'idle');assert.equal(h.group.snapshot().activeProfile.id,DEFAULT_ID);
  await switchTo(h.group);assert.equal(await run(b.client),'B');
});
test('second connection online rejection rolls back BOTH and never automatically retries a turn',async t=>{
  const h=await setup(t),a=await h.add(),b=await h.add();b.server.rejectB=true;
  await assert.rejects(switchTo(h.group));
  assert.equal(principal(a.server.value),'A');assert.equal(principal(b.server.value),'A');assert.equal(h.group.phase,'idle');
  assert.equal(h.servers.some(s=>s.calls.some(c=>c.method==='turn/start')),false);
});
test('single durable commit failure restores all connections; no peer commits early',async t=>{
  const h=await setup(t),a=await h.add(),b=await h.add();
  const write=h.group.selection.write.bind(h.group.selection);
  h.group.selection.write=(status,p)=>{if(status==='selected')throw Error('disk failure');return write(status,p);};
  await assert.rejects(switchTo(h.group));assert.equal(principal(a.server.value),'A');assert.equal(principal(b.server.value),'A');
  assert.equal(h.group.generation,0);assert.equal(h.group.phase,'idle');
});
test('cancellation on second login rolls every touched transport back; no partial B success',async t=>{
  const h=await setup(t),a=await h.add(),b=await h.add();let release;b.server.loginWait=new Promise(r=>release=r);
  const changing=switchTo(h.group),rejection=assert.rejects(changing,{code:'CANCELLED'});
  await until(()=>b.server.calls.some(c=>c.method==='account/login/start'));assert.equal(h.group.cancel(),true);
  assert.ok((await a.client.exchange('turn/start',{threadId:'thread-0'})).error);release();await rejection;
  assert.equal(principal(a.server.value),'A');assert.equal(principal(b.server.value),'A');assert.equal(h.group.phase,'idle');
});
test('active work, approvals and background terminals in ANY peer prevent workspace switching',async t=>{
  const h=await setup(t),a=await h.add(),b=await h.add();
  await b.client.call('turn/start',{threadId:'thread-2'});await assert.rejects(switchTo(h.group),{code:'BUSY'});
  await b.client.call('turn/interrupt',{threadId:'thread-2'});
  b.server.background=true;await assert.rejects(switchTo(h.group),{code:'BUSY'});b.server.background=false;
  b.server.send({id:7,method:'item/commandExecution/requestApproval',params:{threadId:'thread-2'}});
  await assert.rejects(switchTo(h.group),{code:'BUSY'});b.client.respond(7,{result:{decision:'decline'}});await tick();
  await switchTo(h.group);assert.equal(principal(a.server.value),'B');
});
test('same request and approval IDs on two pipes never cross connection boundaries',async t=>{
  const h=await setup(t),a=await h.add(),b=await h.add();await switchTo(h.group);
  for(const peer of [a,b])peer.server.send({id:77,method:'item/commandExecution/requestApproval',params:{threadId:'thread-1'}});
  assert.equal(a.client.serverRequests.has(77),true);assert.equal(b.client.serverRequests.has(77),true);
  a.client.respond(77,{result:{decision:'decline'}});await tick();
  assert.equal(a.connection.rpc.serverRequests.has(77),false);assert.equal(b.connection.rpc.serverRequests.has(77),true);
  b.client.respond(77,{result:{decision:'decline'}});await tick();
  const [ra,rb]=await Promise.all([a.client.call('thread/list',{limit:1}),b.client.call('thread/list',{cursor:'600',limit:1})]);
  assert.equal(ra.data[0].id,'thread-0');assert.equal(rb.data[0].id,'thread-600');
});
test('late account/turn callbacks from a closed connection cannot invalidate the replacement',async t=>{
  const h=await setup(t),a=await h.add();await switchTo(h.group);a.server.kill();const b=await h.add();
  a.connection.notification({method:'account/updated',params:{authMode:null}});
  a.connection.notification({method:'turn/completed',params:{threadId:'thread-0',turn:{id:'stale'}}});
  assert.equal(h.group.phase,'idle');assert.equal(h.group.active.id,B);assert.equal(await run(b.client),'B');
});
test('native logout/login on one pipe gates all pipes until consent recovery aligns the workspace',async t=>{
  const h=await setup(t),a=await h.add(),b=await h.add();
  await a.client.call('account/logout');
  assert.ok((await b.client.exchange('turn/start',{threadId:'thread-0'})).error);
  await a.client.call('account/login/start',{type:'chatgpt',accessToken:token('B')});
  assert.ok((await b.client.exchange('turn/start',{threadId:'thread-0'})).error);
  await assert.rejects(h.group.recover(),{code:'CONSENT_REQUIRED'});await recover(h.group);
  assert.equal(await run(a.client),'B');assert.equal(await run(b.client),'B');
  const c=await h.add();assert.equal(await run(c.client),'B');
});
test('native pinned identity drift across an idle reconnect requires consent, not adoption of C',async t=>{
  const h=await setup(t),a=await h.add();a.server.kill();auth(h.home,token('C'));
  const b=await h.add();assert.equal(h.group.phase,'blocked');assert.equal(h.group.blockedReason,'IDENTITY_MISMATCH');
  assert.ok((await b.client.exchange('turn/start',{threadId:'thread-0'})).error);
  await recover(h.group);assert.equal(await run(b.client),'C');
});
test('pending selection across coordinator restart remains gated until explicit recovery on all pipes',async t=>{
  const h=await setup(t);new SelectionStore(h.storageDirectory,h.home).write('pending',h.profiles.pin(B));h.restart();
  const a=await h.add(),b=await h.add();assert.equal(h.group.phase,'blocked');
  assert.ok((await a.client.exchange('turn/start',{threadId:'thread-0'})).error);await recover(h.group);
  assert.equal(await run(a.client),'B');assert.equal(await run(b.client),'B');
});
test('closed peer with ambiguous active work persists recovery intent; reconnect is never automatic replay',async t=>{
  const h=await setup(t),a=await h.add(),b=await h.add();await switchTo(h.group);
  await a.client.call('turn/start',{threadId:'thread-1'});a.server.kill();await tick();
  assert.equal(h.group.phase,'blocked');assert.equal(h.group.saved.status,'pending');
  const c=await h.add();assert.ok((await c.client.exchange('turn/start',{threadId:'thread-1'})).error);
  assert.equal(c.server.calls.some(c=>c.method==='turn/start'),false);
  assert.ok((await b.client.call('thread/list')).data.length);
});
test('wrong principal on any peer blocks it before a model call and gates healthy siblings too',async t=>{
  const h=await setup(t),a=await h.add(),b=await h.add();await switchTo(h.group);b.server.value=token('C');
  assert.match((await b.client.exchange('turn/start',{threadId:'thread-0'})).error.message,/IDENTITY_MISMATCH/);
  assert.ok((await a.client.exchange('turn/start',{threadId:'thread-0'})).error);
  assert.equal(h.group.saved.status,'pending');assert.equal(b.server.calls.some(c=>c.method==='turn/start'),false);
});
test('dispose closes every live connection and removes workspace membership',async t=>{
  const h=await setup(t),a=await h.add(),b=await h.add();await h.group.dispose();
  assert.equal(a.server.exitCode,0);assert.equal(b.server.exitCode,0);assert.equal(h.group.snapshot().connectionCount,0);
});
test('production spawn hook admits overlapping app-servers, not just directly constructed test transports',async t=>{
  const h=await setup(t),app=new EventEmitter(),handlers=new Map(),servers=[];let quits=0;app.quit=()=>quits++;
  const executable=path.join(h.root,'codex.exe'),before=childProcess.spawn;
  const instance=install({app,ipcMain:{handle:(k,f)=>handlers.set(k,f)},BrowserWindow:{getAllWindows:()=>[]},check:e=>{if(!e.trusted)throw Error('untrusted');},trustedContent:()=>true,
    executable,accountsDirectory:h.accountsDirectory,defaultHome:h.home,storageDirectory:h.storageDirectory,
    spawnProcess:(_cmd,args,opts)=>{assert.equal(opts.env.CODEX_HOME,h.home);const s=new Server(h.home);servers.push(s);return s;}});
  t.after(()=>instance.dispose());
  const clients=[];
  for(let i=0;i<2;i++){
    const child=childProcess.spawn(executable,['app-server','--listen','stdio://'],{env:{CODEX_HOME:h.home}});
    const client=new AppServerRpc(child,{timeoutMs:2000});clients.push(client);await client.initialize();
  }
  const call=(name,value)=>handlers.get('codex-labels:session-switcher-'+name)({trusted:true},value);
  for(let i=0;i<100;i++){if((await call('inspect')).value.phase==='idle')break;await tick();}
  const result=await call('switch',{profileId:B,confirmContextTransfer:true});assert.equal(result.ok,true);
  assert.equal((await call('status')).value.state.connectionCount,2);assert.equal(servers.some(s=>s.exitCode!==null),false);
  assert.equal(await run(clients[1]),'B');
  servers[0].kill();await tick();assert.equal((await call('inspect')).value.phase,'idle');
  let prevented=0;app.emit('before-quit',{preventDefault:()=>prevented++});await until(()=>quits===1);
  assert.equal(prevented,1);assert.equal(servers[1].exitCode,0);
  await instance.dispose();assert.equal(childProcess.spawn,before);
});

test('real OS children through production spawn: two live pipes and a replacement all retain B',async t=>{
  const h=await setup(t),app=new EventEmitter(),handlers=new Map(),clients=[];
  const worker=path.join(__dirname,'fixtures/workspace-lifecycle-worker.cjs');
  app.quit=()=>{};
  const instance=install({app,ipcMain:{handle:(k,f)=>handlers.set(k,f)},BrowserWindow:{getAllWindows:()=>[]},check:e=>{if(!e.trusted)throw Error('untrusted');},trustedContent:()=>true,
    executable:process.execPath,accountsDirectory:h.accountsDirectory,defaultHome:h.home,storageDirectory:h.storageDirectory});
  t.after(async()=>{await instance.dispose();for(const c of clients)await c.close().catch(()=>{});});
  const call=(name,value)=>handlers.get('codex-labels:session-switcher-'+name)({trusted:true},value);
  async function start(){
    const child=childProcess.spawn(process.execPath,[worker,'app-server','--listen=stdio://'],{
      env:{...process.env,CODEX_HOME:h.home,CODEX_LABELS_LIFECYCLE_TEST:'1'},stdio:['pipe','pipe','pipe']});
    const client=new AppServerRpc(child,{timeoutMs:5000});clients.push(client);await client.initialize();
    for(let i=0;i<300;i++) {if((await call('inspect')).value.phase==='idle')break;await new Promise(r=>setTimeout(r,10));}
    assert.equal((await call('inspect')).value.phase,'idle');return {child,client};
  }
  const a=await start(),b=await start();assert.notEqual(a.child.pid,b.child.pid);
  assert.equal((await call('switch',{profileId:B,confirmContextTransfer:true})).ok,true);
  assert.equal(await run(a.client),'B');assert.equal(await run(b.client),'B');
  await a.client.close();const c=await start();
  assert.equal((await call('inspect')).value.connectionCount,2);assert.equal(await run(c.client),'B');
  assert.equal((await c.client.call('thread/list',{cursor:'600'})).data.length,7);
});
test('a new joining peer does not decline legitimate tool approvals in an existing running turn',async t=>{
  const h=await setup(t),a=await h.add();await switchTo(h.group);
  await a.client.call('turn/start',{threadId:'thread-0'});
  let release;const b=await h.add({start:false,tweak:s=>{s.loginWait=new Promise(r=>release=r);}});
  const init=b.init();await until(()=>b.server.calls.some(c=>c.method==='account/login/start'));
  a.server.send({id:123,method:'item/commandExecution/requestApproval',params:{threadId:'thread-0'}});
  assert.equal(a.client.serverRequests.has(123),true);a.client.respond(123,{result:{decision:'decline'}});
  await a.client.call('turn/interrupt',{threadId:'thread-0'});release();await init;
  assert.equal(h.group.phase,'idle');
});
test('confirmed exit during an auth transaction cancels atomically without poisoning a healthy survivor',async t=>{
  const h=await setup(t),a=await h.add(),b=await h.add();let release;b.server.loginWait=new Promise(r=>release=r);
  const changing=switchTo(h.group),rejection=assert.rejects(changing);
  await until(()=>b.server.calls.some(c=>c.method==='account/login/start'));
  a.server.kill();release();await rejection;
  assert.equal(principal(b.server.value),'A');assert.equal(h.group.phase,'idle');
  assert.equal(await run(b.client),'A');
});
test('transport EOF before OS exit is retired; a healthy sibling is not killed or bypassed',async t=>{
  const h=await setup(t),a=await h.add(),b=await h.add();await switchTo(h.group);
  a.server.nativeOut.end();await tick();await until(()=>a.server.exitCode===0);
  assert.equal(b.server.exitCode,null);assert.equal(h.group.retiring.size,0);assert.equal(h.group.phase,'idle');
  assert.equal(await run(b.client),'B');
});

test('native host refresh response cannot bypass pinned A identity with a C token during a turn',async t=>{
  const h=await setup(t),a=await h.add(),b=await h.add();const replies=[];
  const receive=a.server.receive.bind(a.server);a.server.receive=async m=>{if(!m.method)replies.push(m);return receive(m);};
  await a.client.call('turn/start',{threadId:'thread-1'});
  a.server.send({id:900,method:'account/chatgptAuthTokens/refresh',params:{previousAccountId:'A'}});
  assert.equal(a.client.serverRequests.has(900),true);
  a.client.respond(900,{result:{accessToken:token('C'),chatgptAccountId:'C'}});await tick();
  assert.ok(replies.at(-1).error);assert.equal(replies.at(-1).result,undefined);
  assert.equal(h.group.phase,'blocked');assert.equal(h.group.saved.status,'native-pending');
  assert.ok((await b.client.exchange('turn/start',{threadId:'thread-2'})).error);
});
test('native host refresh for the same verified principal still reaches its originating pipe',async t=>{
  const h=await setup(t),a=await h.add();const replies=[];
  const receive=a.server.receive.bind(a.server);a.server.receive=async m=>{if(!m.method)replies.push(m);return receive(m);};
  a.server.send({id:901,method:'account/chatgptAuthTokens/refresh',params:{previousAccountId:'A'}});
  a.client.respond(901,{result:{accessToken:token('A'),chatgptAccountId:'A'}});await tick();
  assert.equal(principal(replies.at(-1).result.accessToken),'A');assert.equal(h.group.phase,'idle');
});
test('throwing status observer cannot create a partially committed account transition',async t=>{
  const h=await setup(t),a=await h.add(),b=await h.add();h.group.on('changed',()=>{throw Error('closing UI');});
  await switchTo(h.group);assert.equal(h.group.phase,'idle');assert.equal(await run(a.client),'B');assert.equal(await run(b.client),'B');
});
