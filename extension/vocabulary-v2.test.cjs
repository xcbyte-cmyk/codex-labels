'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {EventEmitter}=require('node:events');
const {randomUUID}=require('node:crypto');
const {MODEL,EFFORT,createVocabularyStore,createSummarizer,loginEnvironment,selection}=require('./vocabulary-v2.cjs');
const {registerVocabulary}=require('./vocabulary-v2-ipc.cjs');
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

test('legacy data is read without writes, then backed up byte-for-byte on v2 migration',t=>{
  const dir=temp(t),file=path.join(dir,'vocabulary.json'),old=item(),bytes=JSON.stringify({version:1,entries:[old]});
  fs.writeFileSync(file,bytes);const store=createVocabularyStore(dir),before=store.read();
  assert.equal(before.version,1);assert.deepEqual(before.entries[0].tags,[]);assert.equal(before.entries[0].status,'new');
  assert.equal(fs.readFileSync(file,'utf8'),bytes);assert.deepEqual(fs.readdirSync(dir),['vocabulary.json']);
  const after=store.edit(old.id,{meaning:'사용자가 고친 뜻',tags:['UI/UX'],favorite:true,status:'known'},before.revision);
  assert.equal(after.version,2);assert.equal(after.entries[0].context,old.context);assert.equal(after.entries[0].savedAt,old.savedAt);
  const backups=fs.readdirSync(dir).filter(n=>n.endsWith('.bak'));assert.equal(backups.length,1);
  assert.equal(fs.readFileSync(path.join(dir,backups[0]),'utf8'),bytes);
  store.edit(old.id,{example:'새 예문'},after.revision);assert.equal(fs.readdirSync(dir).filter(n=>n.endsWith('.bak')).length,1);
});
test('distinct senses coexist, normalized duplicate meaning rejects and ambiguous legacy overwrite rejects',t=>{
  const store=createVocabularyStore(temp(t)),first=item('Bank');let data=store.save(first,store.read().revision,{mode:'add'});
  const second={...item('ＢＡＮＫ'),meaning:'강둑',context:'We walked along the bank.'};data=store.save(second,data.revision,{mode:'add'});
  assert.equal(data.entries.length,2);assert.equal(data.entries.find(e=>e.id===first.id).meaning,first.meaning);
  assert.throws(()=>store.save({...item('bank'),meaning:'  강둑  '},data.revision,{mode:'add'}),/같은 뜻/);
  assert.throws(()=>store.save(item('bank'),data.revision),/여러 뜻/);
  data=store.save({...item('bank'),meaning:'명시적으로 수정한 뜻'},data.revision,{mode:'replace',targetId:first.id});
  assert.equal(data.entries.length,2);assert.equal(data.entries.find(e=>e.id===second.id).context,second.context);
  assert.throws(()=>store.save(item('other'),data.revision,{mode:'replace',targetId:first.id}),/다시 선택/);
});
test('edits preserve identity, source, original context and model; forbidden fields fail closed',t=>{
  const store=createVocabularyStore(temp(t)),first={...item(),source:{title:'원문 대화',path:'/thread/abc-123'}};
  let data=store.save(first,store.read().revision,{mode:'add',edits:{meaning:'미리보기 수정',partOfSpeech:'명사',explanation:'설명',tags:['개발']}});
  const old=data.entries[0];data=store.edit(first.id,{favorite:true,status:'review',example:'내 예문'},data.revision);const edited=data.entries[0];
  for(const name of ['id','term','context','source','model','effort','savedAt'])assert.deepEqual(edited[name],old[name]);
  assert.equal(edited.favorite,true);assert.equal(edited.status,'review');assert.deepEqual(edited.tags,['개발']);
  for(const patch of [{model:'other'},{term:'other'},{source:{path:'/else'}},{meaning:''},{tags:Array(6).fill('x')},{favorite:'yes'},{status:'invalid'},{partOfSpeech:'x'.repeat(81)}])assert.throws(()=>store.edit(first.id,patch,data.revision));
  assert.throws(()=>store.edit(randomUUID(),{meaning:'x'},data.revision),/없습니다/);
  assert.equal(store.read().revision,data.revision);
});
test('v2 edit collisions and stale revisions never discard another meaning',t=>{
  const store=createVocabularyStore(temp(t)),first=item();let data=store.save(first,store.read().revision,{mode:'add'});
  const second={...item(),meaning:'두 번째 뜻'};data=store.save(second,data.revision,{mode:'add'});
  const old=data.revision;data=store.edit(first.id,{meaning:'변경된 뜻'},old);
  assert.throws(()=>store.edit(second.id,{meaning:'변경된 뜻'},data.revision),/중복/);
  assert.throws(()=>store.edit(second.id,{example:'stale'},old),/다른 창/);
  assert.equal(store.read().entries.length,2);assert.equal(store.read().revision,data.revision);
});
test('source is bounded local provenance, never forwarded to the model',async()=>{
  const fake=fakeSpawn({answer:{meaning:'뜻',example:'예문',partOfSpeech:'명사',explanation:'보충 설명',tags:['개발']}});
  const service=createSummarizer({executable:process.execPath,spawnProcess:fake.spawn});
  const result=await service.summarize(1,{term:'term',context:'원문 문장',source:{title:'private-chat-title',path:'/thread/private-123'}});
  assert.equal(result.source.title,'private-chat-title');assert.equal(result.partOfSpeech,'명사');assert.deepEqual(result.tags,['개발']);
  assert.ok(!fake.prompt.includes('private-chat-title'));assert.ok(!fake.prompt.includes('private-123'));assert.ok(fake.prompt.includes('원문 문장'));
  for(const source of [{path:'https://example.com'},{path:'//example.com/x'},{path:'/thread/abc?token=x'},{path:'/../secret'},{title:'a'.repeat(201)}])assert.throws(()=>selection({term:'term',source}));
});
test('IPC allows bounded preview edits, consumes draft only after a successful save and protects source',async t=>{
  const h=ipcHarness(t),a=h.event(1),draft=item(),pending=h.call('summarize',a,{term:'word'});h.resolve(draft);await pending;
  assert.throws(()=>h.call('save',a,draft.id,h.store.read().revision,{mode:'add',edits:{model:'other'}}));
  let data=h.call('save',a,draft.id,h.store.read().revision,{mode:'add',edits:{meaning:'내가 고친 뜻'}});
  assert.equal(data.entries[0].meaning,'내가 고친 뜻');assert.equal(data.entries[0].model,MODEL);
  assert.throws(()=>h.call('save',a,draft.id,data.revision),/다시/);
  data=h.call('edit',a,draft.id,{meaning:'나중에 고친 뜻'},data.revision);assert.equal(data.entries[0].meaning,'나중에 고친 뜻');
  assert.throws(()=>h.call('edit',{trusted:false},draft.id,{},data.revision),/blocked/);
});
test('preload forwards only named vocabulary save/edit channels and arguments',()=>{
  const vm=require('node:vm'),calls=[];let exposed;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'preload.js'),'utf8'),{require:name=>{
    assert.equal(name,'electron');return {contextBridge:{exposeInMainWorld:(_name,value)=>{exposed=value;}},ipcRenderer:{invoke:(...args)=>{calls.push(args);}}};
  }});
  const options={mode:'add',edits:{meaning:'뜻'}};exposed.vocabularySave('id','rev',options);exposed.vocabularyEdit('id',{favorite:true},'rev');
  assert.deepEqual(calls,[['codex-labels:vocabulary-save','id','rev',options],['codex-labels:vocabulary-edit','id',{favorite:true},'rev']]);
});
