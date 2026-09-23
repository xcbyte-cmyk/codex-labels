'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {randomUUID}=require('node:crypto');
const {normalizedMap,termKey,createMatcher}=require('./vocabulary-renderer.js');
const {registerVocabulary}=require('./vocabulary-ipc.cjs');
const {createVocabularyStore,MODEL,EFFORT}=require('./vocabulary.cjs');
const terms=(...words)=>words.map((term,i)=>({id:String(i),term,meaning:term+' 뜻'}));
const matches=(words,text)=>createMatcher(terms(...words)).find(text).map(m=>text.slice(m.start,m.end));

test('whole words, case and punctuation without stemming or substring false positives',()=>{
  assert.deepEqual(matches(['run','bank','UI'],'run running RUN bank banker bankruptcy UI GUID ui.'),['run','RUN','bank','UI','ui']);
  assert.deepEqual(matches(['C++','.NET'],'C++ C++builder .NET foo.NET'),['C++','.NET']);
});
test('longest phrase wins at a given start and shorter interior words are not duplicated',()=>{
  assert.deepEqual(matches(['account','take into account','take','race','race condition'],'take into account and account; race condition.'),['take into account','account','race condition']);
});
test('NFKC, whitespace and grapheme offsets preserve exact original visible text',()=>{
  const text='ＰＯＰＯＶＥＲ; race\t\n  condition; cafe\u0301; 가.';
  assert.deepEqual(matches(['Popover','race condition','café','가'],text),['ＰＯＰＯＶＥＲ','race\t\n  condition','cafe\u0301','가']);
});
test('ligatures, astral symbols and Greek contextual sigma do not corrupt DOM offsets',()=>{
  assert.deepEqual(matches(['fi','😀','ΟΣ'],'ﬁ 😀 ΟΣ οσ ος'),['ﬁ','😀','ΟΣ','οσ','ος']);
  assert.deepEqual(matches(['f','i','c'],'ﬁ ℃'),[]);
  const m=normalizedMap(' 😀 X ');assert.equal(m.text,'😀 x');assert.equal(m.starts.length,m.text.length);assert.equal(m.ends.length,m.text.length);
});
test('unicode word boundaries reject inflections, connected Hangul and underscore identifiers',()=>{
  assert.deepEqual(matches(['단어','bank'],'단어 단어장 단어는 bank_bank bank1 bank.'),['단어','bank']);
});
test('duplicate terms share one highlight and retain every saved sense',()=>{
  const matcher=createMatcher([{term:'Bank',id:'one',meaning:'은행'},{term:'ＢＡＮＫ',id:'two',meaning:'강둑'}]);
  assert.equal(matcher.groups.size,1);assert.equal(matcher.groups.get('bank').length,2);assert.equal(matcher.find('bank').length,1);
});
test('same normalized dictionary signature is stable across metadata edits and ordering',()=>{
  const a=createMatcher(terms('Bank','race condition')),b=createMatcher(terms('RACE CONDITION','ＢＡＮＫ').map(e=>({...e,meaning:'수정'})));
  assert.equal(a.signature,b.signature);assert.equal(termKey('  race\t condition  '),'race condition');
});
test('all repeated occurrences and phrases after large whitespace are found',()=>{
  const text='before '.repeat(1000)+'race'+' '.repeat(2200)+'condition bank bank';
  assert.deepEqual(matches(['race condition','bank'],text),['race'+' '.repeat(2200)+'condition','bank','bank']);
});
test('2,000-entry dictionary matches mixed content without per-term text searches',()=>{
  const values=Array.from({length:2000},(_,i)=>'term'+i);
  const matcher=createMatcher(terms(...values));
  const input='unrelated '.repeat(5000)+'term1999 term0 term42 notterm1 term19999';
  assert.deepEqual(matcher.find(input).map(m=>m.key),['term1999','term0','term42']);
});
test('invalid/empty terms are ignored and markup remains literal data',()=>{
  const matcher=createMatcher([{term:null},{term:''},{term:'a'.repeat(161)},{term:'<script>',meaning:'<img onerror=evil()>'}]);
  assert.equal(matcher.groups.size,1);assert.deepEqual(matcher.find('literal <script> here').map(m=>m.key),['<script>']);
});

function harness(t,{directory,store,watchDirectory}={}){
  const dir=directory||fs.mkdtempSync(path.join(os.tmpdir(),'vocabulary-broadcast-'));
  if(!directory)t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const handlers=new Map(),calls=[];
  const service=registerVocabulary({directory:dir,store:store||createVocabularyStore(dir),watchDirectory:watchDirectory||(()=>{const w=new EventEmitter();w.close=()=>{};return w;}),
    ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},check:e=>{if(!e.trusted||e.sender.foreign)throw Error('untrusted');},
    summarizer:{summarize:async()=>({id:randomUUID(),term:'bank',meaning:'은행',example:'예문',context:'',model:MODEL,effort:EFFORT,savedAt:Date.now()}),cancel(){},dispose(){}}});
  t.after(()=>service.dispose());
  const event=id=>{const sender=new EventEmitter();sender.id=id;sender.isDestroyed=()=>!!sender.dead;sender.send=(...args)=>calls.push([id,...args]);return {sender,trusted:true};};
  return {call:(name,...args)=>handlers.get('codex-labels:vocabulary-'+name)(...args),calls,event,service,dir};
}
test('successful save/edit/delete invalidates all authorized readers without including vocabulary data',async t=>{
  const h=harness(t),a=h.event(1),b=h.event(2);let data=h.call('read',a);h.call('read',b);
  const draft=await h.call('summarize',a,{term:'bank'});data=h.call('save',a,draft.id,data.revision,{mode:'add'});
  assert.deepEqual(h.calls,[[1,'codex-labels:vocabulary-changed'],[2,'codex-labels:vocabulary-changed']]);h.calls.length=0;
  data=h.call('edit',a,draft.id,{meaning:'수정한 뜻'},data.revision);assert.equal(h.calls.length,2);h.calls.length=0;
  h.call('delete',a,draft.id,data.revision);assert.equal(h.calls.length,2);
});
test('failed writes never broadcast and stale/foreign/destroyed/navigation readers are not sent data',async t=>{
  const h=harness(t),a=h.event(1),b=h.event(2),c=h.event(3),d=h.event(4),e=h.event(5);
  const data=h.call('read',a);for(const ev of [b,c,d,e])h.call('read',ev);
  assert.throws(()=>h.call('delete',a,randomUUID(),'invalid'));assert.equal(h.calls.length,0);
  b.sender.foreign=true;c.sender.dead=true;d.sender.emit('destroyed');e.sender.emit('did-start-navigation',{},'https://example.com',false,true);
  const draft=await h.call('summarize',a,{});h.call('save',a,draft.id,data.revision,{mode:'add'});
  assert.deepEqual(h.calls,[[1,'codex-labels:vocabulary-changed']]);
});
test('separate account/store registrations do not broadcast across stores',async t=>{
  const a=harness(t),b=harness(t),ea=a.event(1),eb=b.event(2);const data=a.call('read',ea);b.call('read',eb);
  const draft=await a.call('summarize',ea,{});a.call('save',ea,draft.id,data.revision,{mode:'add'});
  assert.equal(a.calls.length,1);assert.equal(b.calls.length,0);
});
test('file-watch filters temporary files and coalesces vocabulary.json changes; disposal releases listeners',async t=>{
  let changed,closed=0;
  const h=harness(t,{watchDirectory:(dir,options,callback)=>{changed=callback;assert.equal(options.persistent,false);const watcher=new EventEmitter();watcher.close=()=>closed++;return watcher;}});
  const e=h.event(1);h.call('read',e);changed('rename','vocabulary.json.tmp-a');changed('rename','labels.json');
  await new Promise(r=>setTimeout(r,65));assert.equal(h.calls.length,0);
  changed('rename','vocabulary.json');changed('change',Buffer.from('vocabulary.json'));
  await new Promise(r=>setTimeout(r,65));assert.deepEqual(h.calls,[[1,'codex-labels:vocabulary-changed']]);
  changed('rename','vocabulary.json');h.service.dispose();await new Promise(r=>setTimeout(r,65));
  assert.equal(h.calls.length,1);assert.equal(closed,1);assert.equal(e.sender.listenerCount('did-start-navigation'),0);
});
test('real directory watcher notices another store instance atomic writes',async t=>{
  const h=harness(t,{watchDirectory:fs.watch}),e=h.event(1);h.call('read',e);
  const other=createVocabularyStore(h.dir),entry={id:randomUUID(),term:'external',context:'',meaning:'외부 창',example:'',model:MODEL,effort:EFFORT,savedAt:Date.now()};
  other.save(entry,other.read().revision,{mode:'add'});
  const end=Date.now()+1500;while(!h.calls.length&&Date.now()<end)await new Promise(r=>setTimeout(r,20));
  assert.equal(h.calls.length,1);assert.equal(h.call('read',e).entries[0].term,'external');
});
test('preload invalidation subscription strips native event/payload and unregisters exactly its listener',()=>{
  let api;const events=new Map();
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'preload.js'),'utf8'),{require:()=>({contextBridge:{exposeInMainWorld:(name,a)=>{if(name==='codexLabels')api=a;}},ipcRenderer:{on:(n,f)=>events.set(n,f),removeListener:(n,f)=>{assert.equal(events.get(n),f);events.delete(n);}}})});
  let received;const off=api.onVocabularyChanged((...args)=>received=args);
  events.get('codex-labels:vocabulary-changed')({sender:'native'},{secret:'must not cross'});assert.deepEqual(received,[]);off();assert.equal(events.size,0);assert.throws(()=>api.onVocabularyChanged(null),/callback/);
});
