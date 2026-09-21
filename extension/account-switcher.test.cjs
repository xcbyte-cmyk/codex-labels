'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');
const {createAccountSwitcher} = require('./account-switcher.cjs');

function fixture(t, currentAccount = null) {
  const local = fs.mkdtempSync(path.join(os.tmpdir(), 'labels-switcher-')); t.after(()=>fs.rmSync(local,{recursive:true,force:true}));
  const root = path.join(local, 'install'); fs.mkdirSync(root);
  const accounts = path.join(local, 'CodexLabels', 'AccountWindows', 'accounts'); fs.mkdirSync(accounts,{recursive:true});
  const id = '1'.repeat(32), folder=path.join(accounts,id); fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder,'account.json'),JSON.stringify({version:1,id,name:'업무 계정'}));
  const helper=path.join(root,'CodexLabelsHelper.exe');fs.writeFileSync(helper,'');
  const window={hidden:false,isDestroyed:()=>false,hide(){this.hidden=true;}};
  const BrowserWindow={fromWebContents:()=>window};
  const calls=[];
  const spawnProcess=(_exe,args)=>{calls.push(args);const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();queueMicrotask(()=>child.emit('close',0));return child;};
  return {switcher:createAccountSwitcher({root,currentAccount,BrowserWindow,helperPath:helper,localAppData:local,spawnProcess}),id,window,calls,root};
}
test('lists default and isolated accounts without credential data', t=>{
  const {switcher,id}=fixture(t);const state=switcher.list();
  assert.deepEqual(state.accounts,[{id:'default',name:'현재 계정 · 기본 프로필',current:true},{id,name:'업무 계정',current:false}]);
  assert.equal(JSON.stringify(state).includes('auth'),false);
});
test('opens target account and hides source only after helper succeeds',async t=>{
  const {switcher,id,window,calls,root}=fixture(t);
  const result=await switcher.switchTo({sender:{}},id);
  assert.equal(result.changed,true);assert.equal(window.hidden,true);
  assert.deepEqual(calls[0],['account-launch','--root',root,'--account-id',id]);
});
