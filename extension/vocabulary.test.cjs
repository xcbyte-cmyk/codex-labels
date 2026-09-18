'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {EventEmitter}=require('node:events');
const {randomUUID}=require('node:crypto');
const {MODEL,EFFORT,createVocabularyStore,createSummarizer,loginEnvironment,selection}=require('./vocabulary.cjs');
const {registerVocabulary}=require('./vocabulary-ipc.cjs');
const item=(term='Popover')=>({id:randomUUID(),term,context:'선택 영역의 메뉴',meaning:'화면 위에 뜨는 작은 영역',example:'단어장 팝오버를 엽니다.',model:MODEL,effort:EFFORT,savedAt:Date.now()});
function temp(t){const p=fs.mkdtempSync(path.join(os.tmpdir(),'vocabulary-test-'));t.after(()=>fs.rmSync(p,{recursive:true,force:true}));return p;}
test('save survives reopening, duplicate term updates one item, delete persists',t=>{
  const dir=temp(t),store=createVocabularyStore(dir),first=item(),saved=store.save(first,store.read().revision);
  assert.equal(createVocabularyStore(dir).read().entries[0].meaning,first.meaning);
  const updated=store.save({...item('ＰＯＰＯＶＥＲ'),meaning:'수정한 뜻'},saved.revision);
  assert.equal(updated.entries.length,1);assert.equal(updated.entries[0].id,first.id);assert.equal(updated.entries[0].meaning,'수정한 뜻');
  store.remove(first.id,updated.revision);assert.deepEqual(createVocabularyStore(dir).read().entries,[]);
});
test('account dictionaries are separate and label files untouched',t=>{
  const root=temp(t),a=createVocabularyStore(path.join(root,'a')),b=createVocabularyStore(path.join(root,'b'));
  fs.writeFileSync(path.join(root,'labels.json'),'preserve');a.save(item(),a.read().revision);
  assert.equal(b.read().entries.length,0);assert.equal(fs.readFileSync(path.join(root,'labels.json'),'utf8'),'preserve');
});
test('stale write and delete fail without losing newer entries',t=>{
  const dir=temp(t),a=createVocabularyStore(dir),b=createVocabularyStore(dir),old=a.read(),one=item();
  b.save(one,old.revision);assert.throws(()=>a.save(item('Toolbar'),old.revision),/다른 창/);assert.throws(()=>a.remove(one.id,old.revision),/다른 창/);assert.equal(a.read().entries.length,1);
});
test('corrupt storage and active writer lock fail closed',t=>{
  const dir=temp(t),store=createVocabularyStore(dir),empty=store.read();fs.writeFileSync(path.join(dir,'vocabulary.json'),'broken');
  assert.throws(()=>store.save(item(),empty.revision),/원본 파일/);assert.equal(fs.readFileSync(path.join(dir,'vocabulary.json'),'utf8'),'broken');
  fs.unlinkSync(path.join(dir,'vocabulary.json'));fs.mkdirSync(path.join(dir,'vocabulary.json.lock'));assert.throws(()=>store.save(item(),empty.revision),/저장 중/);
});
test('invalid lengths and model metadata are rejected',t=>{
  assert.throws(()=>selection({term:'a'.repeat(161)}));assert.throws(()=>selection({term:''}));assert.throws(()=>selection({term:'a',context:'x'.repeat(1601)}));
  const store=createVocabularyStore(temp(t));assert.throws(()=>store.save({...item(),model:'other'},store.read().revision));
});
test('child environment drops inherited API routing and uses explicit account home',()=>{
  const env=loginEnvironment({PATH:'path',OPENAI_API_KEY:'secret',OPENAI_BASE_URL:'url',CODEX_HOME:'parent',CODEX_THREAD_ID:'parent-thread',ELECTRON_RUN_AS_NODE:'1',SYSTEMROOT:'windows'},'selected-account');
  assert.deepEqual(env,{PATH:'path',SYSTEMROOT:'windows',CODEX_HOME:'selected-account'});
});
function fakeSpawn({answer={meaning:'뜻',example:'예문'},exit=0,hold=false}={}){
  const state={};state.spawn=(exe,args,options)=>{
    Object.assign(state,{exe,args,options});const child=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();
    child.stdin.end=prompt=>{state.prompt=prompt;if(!hold)setImmediate(()=>state.finish());};child.kill=()=>setImmediate(()=>child.emit('close',null));
    state.finish=()=>{if(exit===0)fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify(answer));child.emit('close',exit);};state.child=child;return child;
  };return state;
}
test('exact model and effort, stdin input, ephemeral session, cleanup',async()=>{
  const fake=fakeSpawn(),s=createSummarizer({executable:process.execPath,home:'selected-home',spawnProcess:fake.spawn});
  const result=await s.summarize(1,{term:'$(do-not-execute)',context:'untrusted selection'});
  assert.equal(result.model,MODEL);assert.equal(result.effort,EFFORT);assert.equal(result.meaning,'뜻');assert.equal(fake.args[fake.args.indexOf('--model')+1],MODEL);
  for(const a of ['model_reasoning_effort="xhigh"','--ephemeral','--ignore-user-config','forced_login_method="chatgpt"'])assert.ok(fake.args.includes(a));
  assert.equal(fake.options.shell,false);assert.equal(fake.options.windowsHide,true);assert.ok(!fake.args.some(a=>a.includes('do-not-execute')));
  assert.ok(fake.prompt.includes('$(do-not-execute)'));assert.ok(!fs.existsSync(fake.options.cwd));
});
test('duplicate request refused; cancel stops summary without result',async()=>{
  const fake=fakeSpawn({hold:true}),s=createSummarizer({executable:process.execPath,spawnProcess:fake.spawn});
  const pending=s.summarize(1,{term:'one'}),caught=assert.rejects(pending,/취소/);
  await assert.rejects(s.summarize(1,{term:'two'}),/이미/);s.cancel(1);await caught;assert.ok(!fs.existsSync(fake.options.cwd));
});
test('timeout, malformed output and failed process reject',async()=>{
  const fake=fakeSpawn({hold:true}),s=createSummarizer({executable:process.execPath,spawnProcess:fake.spawn,timeoutMs:20}),keepAlive=setTimeout(()=>{},1000);
  try{await assert.rejects(s.summarize(1,{term:'word'}),/초과/);}finally{clearTimeout(keepAlive);}
  for(const options of [{answer:{meaning:'',example:''}},{exit:1}]){const f=fakeSpawn(options),s2=createSummarizer({executable:process.execPath,spawnProcess:f.spawn});await assert.rejects(s2.summarize(2,{term:'word'}));assert.ok(!fs.existsSync(f.options.cwd));}
});
function ipcHarness(t){
  const handlers=new Map(),store=createVocabularyStore(temp(t)),calls=[];let resolve;
  const service=registerVocabulary({ipcMain:{handle:(n,f)=>handlers.set(n,f)},check:e=>{if(!e.trusted)throw Error('blocked');},store,
    summarizer:{summarize:()=>new Promise(r=>{resolve=r;}),cancel:id=>calls.push(id),dispose(){}}});t.after(()=>service.dispose());
  function event(id){const sender=new EventEmitter();sender.id=id;sender.isDestroyed=()=>false;return {sender,trusted:true};}
  return {call:(name,...args)=>handlers.get('codex-labels:vocabulary-'+name)(...args),event,store,resolve:value=>resolve(value),handlers,calls};
}
test('every IPC checks sender and only its returned draft is saveable',async t=>{
  const h=ipcHarness(t),a=h.event(1),b=h.event(2);
  for(const [name,fn] of h.handlers){if(name.endsWith('summarize'))await assert.rejects(fn({trusted:false}),/blocked/);else assert.throws(()=>fn({trusted:false}),/blocked/);}
  const request=h.call('summarize',a,{term:'word'}),draft=item();h.resolve(draft);await request;
  assert.throws(()=>h.call('save',b,draft.id,h.store.read().revision),/다시/);h.call('save',a,draft.id,h.store.read().revision);assert.equal(h.store.read().entries.length,1);
});
test('cancel and navigation invalidate late model completion',async t=>{
  const h=ipcHarness(t),a=h.event(1),draft=item();let pending=h.call('summarize',a,{term:'word'});
  h.call('cancel',a);h.resolve(draft);await assert.rejects(pending,/취소/);assert.throws(()=>h.call('save',a,draft.id,h.store.read().revision));
  pending=h.call('summarize',a,{term:'word'});a.sender.emit('did-start-navigation',{},'https://example.com',false,true);h.resolve(draft);await assert.rejects(pending,/취소/);
});
