'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createProfiles}=require('./account-switch-profiles.cjs');
const {install,supportedSpawn,normalizeUsage}=require('./account-switcher.cjs');
const id='a'.repeat(32);
const token=p=>`e30.${Buffer.from(JSON.stringify(p)).toString('base64url')}.synthetic-signature`;
function setup(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'labels-profile-')),directory=path.join(root,'accounts',id),home=path.join(directory,'codex-home');
  fs.mkdirSync(home,{recursive:true});fs.writeFileSync(path.join(directory,'account.json'),JSON.stringify({version:1,id,name:'Personal'}));
  const claims={sub:'subject-a',exp:2000000000,email:'a@example.test','https://api.openai.com/auth':{chatgpt_account_id:'account-a',chatgpt_plan_type:'plus'}};
  const auth={auth_mode:'chatgpt',tokens:{account_id:'account-a',access_token:token(claims),id_token:token(claims),refresh_token:'SYNTHETIC-REFRESH-SECRET'}};
  const file=path.join(home,'auth.json');fs.writeFileSync(file,JSON.stringify(auth));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  return {root,directory,home,file,auth,claims,profiles:createProfiles(root,{now:()=>1900000000000})};
}
test('public list excludes access/refresh tokens, identities and filesystem paths',t=>{
  const {profiles,auth,root}=setup(t); const result=profiles.list();assert.equal(result[0].signedIn,true);
  const text=JSON.stringify(result);for(const secret of [auth.tokens.access_token,auth.tokens.refresh_token,root,'subject-a','account-a'])assert.ok(!text.includes(secret));
});
test('credential is read-only and tied to account plus subject',t=>{
  const {profiles,file}=setup(t);const before=fs.readFileSync(file);const c=profiles.credential(id);
  assert.equal(c.chatgptAccountId,'account-a');assert.equal(c.identity.length,64);assert.deepEqual(fs.readFileSync(file),before);
});
test('path traversal and malformed ids rejected',t=>{
  const {profiles}=setup(t);for(const bad of ['../x','..',null,123,'A'.repeat(32)])assert.throws(()=>profiles.read(bad),{code:'INVALID_PROFILE'});
});
test('token claims from different accounts cannot be mixed',t=>{
  const {profiles,auth,file,claims}=setup(t);auth.tokens.access_token=token({...claims,'https://api.openai.com/auth':{chatgpt_account_id:'other'}});
  fs.writeFileSync(file,JSON.stringify(auth));assert.throws(()=>profiles.credential(id),{code:'SIGN_IN_REQUIRED'});
});
test('same workspace but different users cannot be mixed',t=>{
  const {profiles,auth,file,claims}=setup(t);auth.tokens.id_token=token({...claims,sub:'other-user'});fs.writeFileSync(file,JSON.stringify(auth));
  assert.throws(()=>profiles.credential(id),{code:'SIGN_IN_REQUIRED'});
});
test('expired credentials require explicit re-login, not another-account fallback',t=>{
  const {profiles,auth,file,claims}=setup(t);auth.tokens.access_token=token({...claims,exp:1800000000});fs.writeFileSync(file,JSON.stringify(auth));
  assert.equal(profiles.list()[0].signedIn,false);assert.throws(()=>profiles.credential(id),{code:'SIGN_IN_REQUIRED'});
});
test('removing profiles are unavailable',t=>{
  const {profiles,root}=setup(t);fs.writeFileSync(path.join(root,'accounts',`.delete-${id}.json`),'{}');assert.deepEqual(profiles.list(),[]);
});
test('oversized credential file rejected',t=>{
  const {profiles,file}=setup(t);fs.writeFileSync(file,' '.repeat(65537));assert.throws(()=>profiles.credential(id),{code:'INVALID_PROFILE'});
});
test('symlink auth file rejected where supported',t=>{
  const {profiles,file,home}=setup(t);fs.renameSync(file,path.join(home,'other.json'));
  try{fs.symlinkSync(path.join(home,'other.json'),file);}catch(e){if(['EPERM','EACCES'].includes(e.code)){t.skip('Windows symlink privilege unavailable');return;}throw e;}
  assert.throws(()=>profiles.credential(id),{code:'UNSAFE_PROFILE'});
});
test('strict spawn match excludes unrelated programs, other homes and socket listeners',()=>{
  const exe=path.resolve('codex.exe'),home=path.resolve('home'),opts={env:{CODEX_HOME:home},stdio:['pipe','pipe','pipe']};
  assert.equal(supportedSpawn(exe,['app-server'],opts,exe,home),true);
  assert.equal(supportedSpawn(exe,['app-server','--listen','stdio://'],opts,exe,home),true);
  for(const args of [['exec'],['app-server','--listen','ws://localhost:1234'],['app-server','-c','cli_auth_credentials_store="file"']])assert.equal(supportedSpawn(exe,args,opts,exe,home),false);
  assert.equal(supportedSpawn('other.exe',['app-server'],opts,exe,home),false);
  assert.equal(supportedSpawn(exe,['app-server'],{...opts,shell:true},exe,home),false);
  assert.equal(supportedSpawn(exe,['app-server'],{...opts,env:{CODEX_HOME:'elsewhere'}},exe,home),false);
});
test('usage normalization never fabricates zero and strips extra fields',()=>{
  assert.equal(normalizeUsage({}).primary,null);
  const n=normalizeUsage({rateLimits:{primary:{usedPercent:25,windowDurationMins:300,resetsAt:2000000000,secret:'NO'},secret:'NO'}});
  assert.equal(n.primary.usedPercent,25);assert.ok(!JSON.stringify(n).includes('NO'));
  assert.equal(normalizeUsage({rateLimits:{primary:{usedPercent:-1,windowDurationMins:300}}}).primary,null);
});
test('every IPC checks sender; switch needs consent; dispose restores spawn',async t=>{
  const {directory,home}=setup(t),handlers=new Map();let checks=0;const spawn=()=>{throw Error('must not spawn');},pm={spawn};
  const service=install({accountProfile:{id,directory,home},executable:path.resolve('codex.exe'),processModule:pm,
    ipcMain:{handle:(k,v)=>handlers.set(k,v),removeHandler:k=>handlers.delete(k)},check:e=>{checks++;if(!e.trusted)throw Error('untrusted');},getWindows:()=>[],trustedContent:()=>false});
  await assert.rejects(handlers.get('codex-labels:accounts-list')({trusted:false}),/untrusted/);
  const result=await handlers.get('codex-labels:accounts-list')({trusted:true});assert.equal(result.state.available,false);
  await assert.rejects(handlers.get('codex-labels:account-switch')({trusted:true},{profileId:id,consent:false}),{code:'CONSENT_REQUIRED'});
  await assert.rejects(handlers.get('codex-labels:account-usage')({trusted:true},'../bad'),{code:'INVALID_PROFILE'});
  assert.equal(checks,4);service.dispose();assert.equal(pm.spawn,spawn);assert.equal(handlers.size,0);
});
