'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process');
const {AppServerRpc,JsonLines}=require('../extension/session-switcher/rpc.cjs');
const {ProfileStore,tokenIdentity,DEFAULT_ID}=require('../extension/session-switcher/profiles.cjs');
const {DesktopBackend,validateRollout}=require('../extension/session-switcher/backend.cjs');
const {SessionController,RouteJournal}=require('../extension/session-switcher/controller.cjs');
const {DesktopGateway}=require('../extension/session-switcher/gateway.cjs');
const {safeError,digest}=require('../extension/session-switcher/common.cjs');
const FIXTURE=path.join(__dirname,'fixtures/app-server.cjs');
const B='b'.repeat(32),C='c'.repeat(32);
function token(accountId,userId='user-'+accountId,exp=Math.floor(Date.now()/1000)+3600){return Buffer.from('{"alg":"none"}').toString('base64url')+'.'+Buffer.from(JSON.stringify({exp,'https://api.openai.com/auth':{chatgpt_account_id:accountId,chatgpt_user_id:userId,chatgpt_plan_type:'test'}})).toString('base64url')+'.fixture';}
function writeAuth(home,id){fs.mkdirSync(home,{recursive:true});fs.writeFileSync(path.join(home,'auth.json'),JSON.stringify({tokens:{access_token:token(id),account_id:id}}));}
function environment(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'session-switcher-test-')),home=path.join(root,'default'),accounts=path.join(root,'accounts');writeAuth(home,'A');
 for(const [id,name]of[[B,'Account B'],[C,'Account C']]){const d=path.join(accounts,id);fs.mkdirSync(d,{recursive:true});fs.writeFileSync(path.join(d,'account.json'),JSON.stringify({id,name}));writeAuth(path.join(d,'codex-home'),name.at(-1));}
 const profiles=new ProfileStore({accountsDirectory:accounts,defaultHome:home});
 const journal=new RouteJournal(path.join(root,'switches'));
 const factory=opts=>DesktopBackend.create({...opts,profiles,spawn:(_exe,_args,o)=>spawn(process.execPath,[FIXTURE],o),executable:process.execPath,env:process.env,rpcOptions:{timeoutMs:2000}});
 const controller=new SessionController({profiles,journal,createBackend:factory});
 const child=spawn(process.execPath,[FIXTURE],{cwd:root,env:{...process.env,CODEX_HOME:home},stdio:['pipe','pipe','pipe']});child.stderr.resume();
 const gateway=new DesktopGateway({child,controller,home,rpcOptions:{timeoutMs:2000}});
 let sequence=0;const pending=new Map(),events=[],requests=[];
 const lines=new JsonLines(m=>{if(m.method){if(m.id!==undefined)requests.push(m);else events.push(m);}else{const p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);p.resolve(m);}}},e=>{throw e;});
 child.stdout.on('data',c=>lines.write(c));
 const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;const timer=setTimeout(()=>reject(Error('client response timeout: '+method)),4000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({id,method,params})+'\n');});
 const close=async()=>{await controller.dispose().catch(()=>{});await gateway.primary.close().catch(()=>{});for(const p of pending.values())clearTimeout(p.timer);fs.rmSync(root,{recursive:true,force:true});};
 return {root,home,accounts,profiles,journal,controller,gateway,child,call,events,requests,close,factory};
}
async function setup(t){const e=environment();t.after(e.close);await e.call('initialize',{clientInfo:{name:'fixture',version:'1'}});e.child.stdin.write('{"method":"initialized"}\n');await e.call('thread/start',{cwd:e.root});return e;}
async function until(fn,ms=2500){const start=Date.now();while(!fn()){if(Date.now()-start>ms)throw Error('condition timeout');await new Promise(r=>setTimeout(r,10));}}

test('UTF-8 split chunks, multiple messages, oversized and truncated frames',()=>{
 const got=[],errors=[];const parser=new JsonLines(m=>got.push(m),e=>errors.push(e));const b=Buffer.from('{"id":1,"result":"한글"}\n{"id":"2","result":true}\n');
 for(const byte of b)parser.write(Buffer.from([byte]));assert.equal(got[0].result,'한글');assert.equal(got.length,2);assert.equal(errors.length,0);
 const small=new JsonLines(()=>{},e=>errors.push(e),8);small.write('123456789');assert.equal(errors.length,1);
 const partial=new JsonLines(()=>{},e=>errors.push(e));partial.write('{');partial.end();assert.equal(errors.length,2);
});
test('profile traversal, expired token and mismatched account are refused',t=>{
 const e=environment();t.after(e.close);assert.throws(()=>e.profiles.resolve('../bad'));assert.throws(()=>tokenIdentity(token('A','U',1)),{code:'AUTH_REQUIRED'});
 const p=e.profiles.pin(B);assert.equal(p.identity.accountId,'B');assert.throws(()=>e.profiles.token(C,p.identity),{code:'IDENTITY_MISMATCH'});
 assert.ok(!JSON.stringify(e.profiles.list()).includes('access_token'));
});
test('native request IDs survive proxy and malformed errors are sanitized',async t=>{
 const e=await setup(t);const r=await e.call('test/echo',{n:42});assert.deepEqual(r.result,{n:42});
 try{await e.gateway.primary.call('test/raw-error',{});assert.fail();}catch(error){assert.ok(!JSON.stringify(safeError(error)).includes('SECRET'));}
});
test('thread/read preserves start policy metadata needed for checkpoint',async t=>{
 const e=await setup(t);await e.call('thread/read',{threadId:'thread-1'});await e.gateway.ensure('thread-1');
 const checkpoint=await e.controller.get('thread-1').backend.checkpoint();assert.equal(checkpoint.payload.settings.params.sandbox,'read-only');
});
test('actual subprocess switch keeps thread ID, changes next request account and preserves original file',async t=>{
 const e=await setup(t);await e.gateway.ensure('thread-1');const source=e.gateway.primary.threads.get('thread-1').thread.path;const before=fs.readFileSync(source);
 const switched=await e.controller.switchAccount('thread-1',B,{confirmContextTransfer:true});
 assert.equal(switched.state.activeProfile.id,B);assert.equal(switched.state.logicalSessionId,'thread-1');assert.equal(switched.cleanupComplete,true);
 const s=e.controller.get('thread-1');assert.notEqual(s.backend.record.thread.path,source);assert.equal(s.backend.profile.identity.accountId,'B');
 assert.equal(fs.existsSync(path.join(s.backend.home,'auth.json')),false,'no auth store is cloned');
 const reply=await e.call('turn/start',{threadId:'thread-1',input:[{type:'text',text:'continue'}]});assert.ok(reply.result.turn.id);
 await until(()=>e.controller.get('thread-1').phase==='idle');
 assert.ok(fs.readFileSync(s.backend.record.thread.path,'utf8').includes('Synthetic B'));assert.ok(fs.readFileSync(source).equals(before));
 assert.ok(e.events.some(m=>m.method==='turn/completed'));
 assert.equal(e.journal.routes.get('thread-1').profileId,B);
});
test('other conversation keeps the source account after a session switch',async t=>{
 const e=await setup(t);await e.call('thread/start',{cwd:e.root,testId:'thread-2'});await e.gateway.ensure('thread-1');await e.controller.switchAccount('thread-1',B,{confirmContextTransfer:true});
 await e.call('turn/start',{threadId:'thread-2',input:[{type:'text',text:'continue'}]});await until(()=>e.events.some(m=>m.method==='turn/completed'&&m.params.threadId==='thread-2'));
 assert.ok(fs.readFileSync(e.gateway.primary.threads.get('thread-2').thread.path,'utf8').includes('Synthetic A'));
});
test('context consent required; in-flight source turn prevents switching',async t=>{
 const e=await setup(t);await e.gateway.ensure('thread-1');await assert.rejects(e.controller.switchAccount('thread-1',B),{code:'CONSENT_REQUIRED'});
 await e.call('turn/start',{threadId:'thread-1',input:[{type:'text',text:'hold'}]});
 await assert.rejects(e.controller.switchAccount('thread-1',B,{confirmContextTransfer:true}),{code:'BUSY'});
 assert.equal(e.controller.get('thread-1').profile.id,DEFAULT_ID);
});
test('server approvals are namespaced and responses go back to the target only',async t=>{
 const e=await setup(t);await e.gateway.ensure('thread-1');await e.controller.switchAccount('thread-1',B,{confirmContextTransfer:true});
 await e.call('turn/start',{threadId:'thread-1',input:[{type:'text',text:'approval'}]});await until(()=>e.requests.length>0);
 const request=e.requests.at(-1);assert.match(request.id,/^labels-server:/);assert.equal(request.params.threadId,'thread-1');
 await assert.rejects(e.controller.switchAccount('thread-1',C,{confirmContextTransfer:true}),{code:'BUSY'});
 e.child.stdin.write(JSON.stringify({id:request.id,result:{decision:'accept'}})+'\n');await until(()=>e.controller.get('thread-1').phase==='idle');
 assert.equal(e.gateway.primary.serverRequests.size,0);assert.equal(e.controller.get('thread-1').backend.rpc.serverRequests.size,0);
});
test('restore failure preserves source route and does not leave a journal entry',async t=>{
 const e=await setup(t);await e.gateway.ensure('thread-1');const original=e.controller.createBackend;let candidate;
 e.controller.createBackend=async o=>{candidate=await original(o);candidate.restore=async()=>{throw Error('raw SECRET');};return candidate;};
 await assert.rejects(e.controller.switchAccount('thread-1',B,{confirmContextTransfer:true}));
 assert.equal(e.controller.get('thread-1').profile.id,DEFAULT_ID);assert.equal(e.controller.get('thread-1').phase,'idle');assert.equal(e.journal.routes.size,0);assert.equal(candidate.rpc.closed,true);
});
test('cancel while factory returns late closes candidate and keeps source',async t=>{
 const e=await setup(t);await e.gateway.ensure('thread-1');const original=e.controller.createBackend;let started=false,candidate;
 e.controller.createBackend=async o=>{candidate=await original(o);started=true;await new Promise(r=>setTimeout(r,50));return candidate;};
 const pending=e.controller.switchAccount('thread-1',B,{confirmContextTransfer:true});await until(()=>started);assert.equal(e.controller.cancel('thread-1'),true);
 await assert.rejects(pending,{code:'CANCELLED'});assert.equal(candidate.rpc.closed,true);assert.equal(e.controller.get('thread-1').profile.id,DEFAULT_ID);
});
test('second switch carries target history forward and never replays a model request',async t=>{
 const e=await setup(t);await e.gateway.ensure('thread-1');await e.controller.switchAccount('thread-1',B,{confirmContextTransfer:true});
 await e.call('turn/start',{threadId:'thread-1',input:[{type:'text',text:'continue'}]});await until(()=>e.controller.get('thread-1').phase==='idle');
 const count=e.events.filter(m=>m.method==='turn/completed').length;
 await e.controller.switchAccount('thread-1',C,{confirmContextTransfer:true});
 const log=fs.readFileSync(e.controller.get('thread-1').backend.record.thread.path,'utf8');assert.ok(log.includes('Synthetic B'));assert.ok(!log.includes('Synthetic C'));assert.equal(e.events.filter(m=>m.method==='turn/completed').length,count);
});
test('unknown switched-thread methods fail instead of falling back to source',async t=>{
 const e=await setup(t);await e.gateway.ensure('thread-1');await e.controller.switchAccount('thread-1',B,{confirmContextTransfer:true});
 const r=await e.call('thread/delete',{threadId:'thread-1'});assert.match(r.error.message,/UNSUPPORTED/);
});
test('journal commit failure rolls back before target becomes routable',async t=>{
 const e=await setup(t);await e.gateway.ensure('thread-1');e.journal.commit=()=>{throw Error('disk full');};
 await assert.rejects(e.controller.switchAccount('thread-1',B,{confirmContextTransfer:true}));assert.equal(e.controller.get('thread-1').profile.id,DEFAULT_ID);
});
test('source cleanup failure blocks committed target until explicit recovery',async t=>{
 const e=await setup(t);await e.gateway.ensure('thread-1');const source=e.controller.get('thread-1').backend,close=source.close.bind(source);let failures=1;
 source.close=async()=>{if(failures-->0)throw Error('close failed');return close();};
 const r=await e.controller.switchAccount('thread-1',B,{confirmContextTransfer:true});assert.equal(r.committed,true);assert.equal(r.cleanupComplete,false);
 const denied=await e.call('turn/start',{threadId:'thread-1',input:[]});assert.ok(denied.error);
 await e.controller.recover('thread-1');assert.equal(e.controller.get('thread-1').phase,'idle');
});
test('saved routes resume the target account and history after controller restart',async t=>{
 const e=await setup(t);await e.gateway.ensure('thread-1');await e.controller.switchAccount('thread-1',B,{confirmContextTransfer:true});
 await e.call('turn/start',{threadId:'thread-1',input:[{type:'text',text:'continue'}]});await until(()=>e.controller.get('thread-1').phase==='idle');
 await e.controller.dispose();
 const c=new SessionController({profiles:e.profiles,journal:new RouteJournal(e.journal.root),createBackend:e.factory});t.after(()=>c.dispose());
 const s=await c.restoreSaved('thread-1');assert.equal(s.profile.id,B);assert.ok(fs.readFileSync(s.backend.record.thread.path,'utf8').includes('Synthetic B'));
 await c.dispose();
});
test('truncated history and unresolved tool calls cannot be checkpoints',()=>{
 assert.throws(()=>validateRollout('{"type":"session_meta","payload":{"id":"t"}}','t'),{code:'CHECKPOINT_INVALID'});
 const text=[{type:'session_meta',payload:{id:'t'}},{type:'response_item',payload:{type:'function_call',call_id:'x'}}].map(JSON.stringify).join('\n')+'\n';
 assert.throws(()=>validateRollout(text,'t'),{code:'CHECKPOINT_INVALID'});
});
test('RPC timeout closes the uncertain connection without retry',async t=>{
 const e=await setup(t);await assert.rejects(e.gateway.primary.call('test/no-response',{}, {timeoutMs:20}),{code:'RPC_TIMEOUT'});assert.equal(e.gateway.primary.closed,true);
});

test('shutdown waits for a late backend factory before releasing session ownership',async t=>{
 const e=await setup(t);await e.gateway.ensure('thread-1');const original=e.controller.createBackend;let created=false,candidate;
 e.controller.createBackend=async o=>{candidate=await original(o);created=true;await new Promise(r=>setTimeout(r,70));return candidate;};
 const switching=e.controller.switchAccount('thread-1',B,{confirmContextTransfer:true});
 const rejected=assert.rejects(switching,{code:'CANCELLED'});await until(()=>created);
 const closing=e.controller.dispose();assert.throws(()=>e.controller.gate('thread-1','turn/start'),{code:'BUSY'});
 await rejected;await closing;assert.equal(candidate.rpc.closed,true);assert.equal(e.journal.locks.size,0);
 assert.equal(e.journal.routes.size,0);assert.equal(e.controller.get('thread-1').phase,'disposed');
});
test('newer cached access token is adopted only for the same verified profile',async t=>{
 const e=await setup(t);await e.gateway.ensure('thread-1');await e.controller.switchAccount('thread-1',B,{confirmContextTransfer:true});
 const backend=e.controller.get('thread-1').backend;const old=backend.pinnedToken;
 const fresh=token('B','user-B',Math.floor(Date.now()/1000)+7200);
 fs.writeFileSync(path.join(e.profiles.resolve(B).home,'auth.json'),JSON.stringify({tokens:{access_token:fresh,account_id:'B'}}));
 assert.equal((await backend.getIdentity()).accountId,'B');assert.notEqual(backend.pinnedToken,old);assert.equal(backend.pinnedToken,fresh);
 writeAuth(e.profiles.resolve(B).home,'C');await assert.rejects(backend.getIdentity(),{code:'IDENTITY_MISMATCH'});
});
test('recovery refuses a journal home redirected outside the session root',async t=>{
 if(process.platform==='win32')return t.skip('Symlink privilege is environment dependent on Windows');
 const e=await setup(t);await e.gateway.ensure('thread-1');await e.controller.switchAccount('thread-1',B,{confirmContextTransfer:true});
 const saved=e.journal.routes.get('thread-1');await e.controller.dispose();
 const moved=path.join(e.root,'moved-home');fs.renameSync(saved.home,moved);fs.symlinkSync(moved,saved.home,'dir');
 assert.throws(()=>new RouteJournal(e.journal.root),{code:'RECOVERY_REQUIRED'});
});
