const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const os=require('node:os');
const {createStore,validateConfig}=require('./store.cjs');
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-label-test-'));fs.copyFileSync(path.join(__dirname,'../labels.example.json'),path.join(dir,'labels.json'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return{dir,store:createStore(dir)};}
test('requested five statuses and colors are preserved',t=>{const {store}=fixture(t);assert.deepEqual(store.snapshot().config.labels.map(x=>[x.name,x.backgroundColor]),[['요청','#7DD3FC'],['진행','#22C55E'],['검토','#FB923C'],['완료','#1E3A8A'],['보류','#6B7280']]);});
test('assignment survives a new store instance; no automatic default',t=>{const {dir,store}=fixture(t);assert.deepEqual(store.snapshot().assignments,{});store.assign('thread:local:local:a','requested');assert.equal(createStore(dir).snapshot().assignments['thread:local:local:a'],'requested');store.assign('thread:local:local:a',null);assert.deepEqual(createStore(dir).snapshot().assignments,{});});
test('same thread id on separate hosts stays separate; project assignment independent',t=>{const {store}=fixture(t);store.assign('thread:local:local:a','requested');store.assign('thread:remote:local:a','completed');store.assign('project:project-a','on_hold');assert.equal(Object.keys(store.snapshot().assignments).length,3);});
test('external color edit is reloaded; broken config retains last good config',t=>{const {dir,store}=fixture(t);const c=store.snapshot().config;c.labels[0].backgroundColor='#AABBCC';fs.writeFileSync(path.join(dir,'labels.json'),JSON.stringify(c));assert.equal(store.snapshot().config.labels[0].backgroundColor,'#AABBCC');fs.writeFileSync(path.join(dir,'labels.json'),'{broken');const s=store.snapshot();assert.equal(s.config.labels[0].backgroundColor,'#AABBCC');assert.ok(s.configError);fs.writeFileSync(path.join(dir,'labels.json'),JSON.stringify(c));assert.equal(store.snapshot().configError,null);});
test('invalid config on first read and damaged state fail without overwriting',t=>{const {dir,store}=fixture(t);fs.writeFileSync(path.join(dir,'assignments.json'),'broken');assert.throws(()=>store.assign('thread:local:local:a','requested'));assert.equal(fs.readFileSync(path.join(dir,'assignments.json'),'utf8'),'broken');fs.writeFileSync(path.join(dir,'labels.json'),'broken');assert.throws(()=>createStore(dir).snapshot());});
test('unknown, disabled labels and invalid keys are rejected',t=>{const {dir,store}=fixture(t);assert.throws(()=>store.assign('anything','requested'));assert.throws(()=>store.assign('thread:a','missing'));const c=store.snapshot().config;c.labels[0].enabled=false;fs.writeFileSync(path.join(dir,'labels.json'),JSON.stringify(c));assert.throws(()=>store.assign('thread:a','requested'));assert.deepEqual(store.snapshot().assignments,{});});
test('malformed color, oversized spacing and duplicate ids are rejected',t=>{const {store}=fixture(t);for(const change of [c=>c.labels[0].backgroundColor='red',c=>c.appearance.gapPx=999,c=>c.labels[1].id=c.labels[0].id]){const c=structuredClone(store.snapshot().config);change(c);assert.throws(()=>validateConfig(c));}});

test('save persists editable fields and backs up the exact previous config without changing assignments',t=>{
  const {dir,store}=fixture(t);
  store.assign('thread:local:local:retain','in_progress');
  const configPath=path.join(dir,'labels.json');
  const before=fs.readFileSync(configPath);
  const assignmentsBefore=fs.readFileSync(path.join(dir,'assignments.json'));
  const initial=store.snapshot();
  assert.match(initial.configRevision,/^[0-9a-f]{64}$/);
  initial.config.labels[0].name='접수';
  initial.config.labels[0].backgroundColor='#112233';
  initial.config.labels[0].textColor='#FFEEDD';
  initial.config.labels[0].description='사용자가 변경한 설명';
  initial.config.labels[0].order=51;
  initial.config.labels[0].enabled=false;
  initial.config.appearance.fontSizePx=13;
  const saved=store.saveConfig(initial.config,initial.configRevision);
  assert.notEqual(saved.configRevision,initial.configRevision);
  assert.equal(saved.config.labels[0].name,'접수');
  assert.equal(saved.config.appearance.fontSizePx,13);
  assert.equal(saved.configError,null);
  assert.deepEqual(createStore(dir).snapshot(),saved);
  assert.deepEqual(fs.readFileSync(configPath+'.bak'),before);
  assert.deepEqual(fs.readFileSync(path.join(dir,'assignments.json')),assignmentsBefore);
  assert.deepEqual(fs.readdirSync(dir).filter(name=>name.includes('.tmp-')),[]);
});

test('save preserves noneditable root, appearance and label properties and keeps IDs in their existing array order',t=>{
  const {dir,store}=fixture(t);
  const configPath=path.join(dir,'labels.json');
  const current=store.snapshot().config;
  current.additional={keep:true};
  current.appearance.extra='keep appearance';
  current.labels[0].extra='keep label';
  fs.writeFileSync(configPath,JSON.stringify(current));
  const opened=store.snapshot();
  const draft=structuredClone(opened.config);
  draft.labels.reverse();
  draft.labels.find(label=>label.id==='requested').extra='discard changed extra';
  draft.behavior.autoCompleteOnAgentReply=true;
  draft.integration={target:'changed'};
  draft.additional={keep:false};
  draft.appearance.extra='discard';
  const saved=store.saveConfig(draft,opened.configRevision).config;
  assert.deepEqual(saved.labels.map(label=>label.id),current.labels.map(label=>label.id));
  assert.deepEqual(saved.behavior,current.behavior);
  assert.deepEqual(saved.integration,current.integration);
  assert.deepEqual(saved.additional,current.additional);
  assert.equal(saved.appearance.extra,'keep appearance');
  assert.equal(saved.labels[0].extra,'keep label');
});

test('stale settings cannot overwrite an external file edit or a newer editor save',t=>{
  const {dir,store}=fixture(t);
  const configPath=path.join(dir,'labels.json');
  const stale=store.snapshot();
  const current=structuredClone(stale.config);
  current.labels[1].name='외부 변경';
  fs.writeFileSync(configPath,JSON.stringify(current));
  const externalBytes=fs.readFileSync(configPath);
  assert.throws(()=>store.saveConfig(stale.config,stale.configRevision),/다른 창이나 파일/);
  assert.deepEqual(fs.readFileSync(configPath),externalBytes);
  assert.equal(fs.existsSync(configPath+'.bak'),false);
  const latest=store.snapshot();
  latest.config.labels[1].name='새 설정';
  store.saveConfig(latest.config,latest.configRevision);
  assert.throws(()=>store.saveConfig(stale.config,latest.configRevision),/다른 창이나 파일/);
  assert.equal(store.snapshot().config.labels[1].name,'새 설정');
});

test('broken external config remains untouched and is not saved using last good state',t=>{
  const {dir,store}=fixture(t);
  const opened=store.snapshot();
  fs.writeFileSync(path.join(dir,'labels.json'),'{broken');
  assert.ok(store.snapshot().configError);
  assert.throws(()=>store.saveConfig(opened.config,opened.configRevision),/파일 오류/);
  assert.equal(fs.readFileSync(path.join(dir,'labels.json'),'utf8'),'{broken');
  assert.equal(fs.existsSync(path.join(dir,'labels.json.bak')),false);
});

test('IDs cannot be added, removed, duplicated or renamed in settings',t=>{
  const {dir,store}=fixture(t);
  const opened=store.snapshot();
  const before=fs.readFileSync(path.join(dir,'labels.json'));
  for(const change of [
    draft=>draft.labels.push({...draft.labels[0],id:'new_label'}),
    draft=>draft.labels.pop(),
    draft=>draft.labels[1].id=draft.labels[0].id,
    draft=>draft.labels[0].id='renamed'
  ]) {
    const draft=structuredClone(opened.config);
    change(draft);
    assert.throws(()=>store.saveConfig(draft,opened.configRevision),/라벨 ID/);
    assert.deepEqual(fs.readFileSync(path.join(dir,'labels.json')),before);
  }
});

test('invalid revision, values and oversized payload fail before touching files',t=>{
  const {dir,store}=fixture(t);
  const opened=store.snapshot();
  const before=fs.readFileSync(path.join(dir,'labels.json'));
  assert.throws(()=>store.saveConfig(opened.config,null),/다시 연/);
  for(const change of [
    draft=>draft.labels[0].name='   ',
    draft=>draft.labels[0].name='줄\n바꿈',
    draft=>draft.labels[0].description='x'.repeat(501),
    draft=>draft.labels[0].order=-1,
    draft=>draft.labels[0].order=10001,
    draft=>draft.labels[0].order=1.5,
    draft=>draft.labels[0].backgroundColor='rgb(0,0,0)',
    draft=>draft.appearance.position='after-title',
    draft=>draft.appearance.fontSizePx=100,
    draft=>draft.ignored='x'.repeat(256*1024)
  ]) {
    const draft=structuredClone(opened.config);
    change(draft);
    assert.throws(()=>store.saveConfig(draft,opened.configRevision));
    assert.deepEqual(fs.readFileSync(path.join(dir,'labels.json')),before);
  }
  assert.deepEqual(fs.readdirSync(dir),['labels.json']);
});

test('a failed atomic config replacement leaves config and assignments untouched and backup recoverable',t=>{
  const {dir,store}=fixture(t);
  store.assign('project:unchanged','requested');
  const opened=store.snapshot();
  const configPath=path.join(dir,'labels.json');
  const before=fs.readFileSync(configPath);
  const assignmentBytes=fs.readFileSync(path.join(dir,'assignments.json'));
  opened.config.labels[0].name='저장 실패';
  const rename=fs.renameSync;
  t.mock.method(fs,'renameSync',(source,target)=>{
    if(target===configPath) throw Error('simulated replacement failure');
    return rename(source,target);
  });
  assert.throws(()=>store.saveConfig(opened.config,opened.configRevision),/simulated/);
  assert.deepEqual(fs.readFileSync(configPath),before);
  assert.deepEqual(fs.readFileSync(configPath+'.bak'),before);
  assert.deepEqual(fs.readFileSync(path.join(dir,'assignments.json')),assignmentBytes);
  assert.deepEqual(fs.readdirSync(dir).filter(name=>name.includes('.tmp-')),[]);
  assert.equal(store.snapshot().config.labels[0].name,'요청');
});

test('external edit while staging is detected without overwriting it',t=>{
  const {dir,store}=fixture(t);
  const opened=store.snapshot();
  const configPath=path.join(dir,'labels.json');
  const external=structuredClone(opened.config);
  external.labels[0].name='편집기 변경';
  const write=fs.writeFileSync;
  let calls=0;
  t.mock.method(fs,'writeFileSync',(...args)=>{
    const result=write(...args);
    if(++calls===2) write(configPath,JSON.stringify(external));
    return result;
  });
  assert.throws(()=>store.saveConfig(opened.config,opened.configRevision),/다른 창이나 파일/);
  assert.equal(JSON.parse(fs.readFileSync(configPath,'utf8')).labels[0].name,'편집기 변경');
  assert.equal(fs.existsSync(configPath+'.bak'),false);
  assert.deepEqual(fs.readdirSync(dir).filter(name=>name.includes('.tmp-')),[]);
});

test('each save backs up the immediately preceding version and that file restores a valid config',t=>{
  const {dir,store}=fixture(t);
  let opened=store.snapshot();
  opened.config.labels[0].name='첫 번째';
  store.saveConfig(opened.config,opened.configRevision);
  const prior=fs.readFileSync(path.join(dir,'labels.json'));
  opened=store.snapshot();
  opened.config.labels[0].name='두 번째';
  store.saveConfig(opened.config,opened.configRevision);
  assert.deepEqual(fs.readFileSync(path.join(dir,'labels.json.bak')),prior);
  fs.copyFileSync(path.join(dir,'labels.json.bak'),path.join(dir,'labels.json'));
  assert.equal(createStore(dir).snapshot().config.labels[0].name,'첫 번째');
});

test('damaged assignment data prevents a misleading partial config save',t=>{
  const {dir,store}=fixture(t);
  const opened=store.snapshot();
  const before=fs.readFileSync(path.join(dir,'labels.json'));
  fs.writeFileSync(path.join(dir,'assignments.json'),'broken');
  opened.config.labels[0].name='저장하지 않음';
  assert.throws(()=>store.saveConfig(opened.config,opened.configRevision));
  assert.deepEqual(fs.readFileSync(path.join(dir,'labels.json')),before);
  assert.equal(fs.readFileSync(path.join(dir,'assignments.json'),'utf8'),'broken');
  assert.equal(fs.existsSync(path.join(dir,'labels.json.bak')),false);
});
