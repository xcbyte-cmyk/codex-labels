'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createShortcutAdapter} = require('./windows-shortcuts.cjs');
test('native Electron shortcut functions remain the preferred route', () => {
  const calls=[]; const adapter=createShortcutAdapter({readShortcutLink:f=>({target:f}),writeShortcutLink:(...x)=>calls.push(x)},
    {run:()=>assert.fail('fallback should not run')});
  assert.equal(adapter.read('file').target,'file');adapter.write('file','update',{});assert.equal(calls.length,1);
});
test('Owl fallback passes Unicode paths as data with a bounded hidden process', () => {
  let request;
  const adapter=createShortcutAdapter({}, {run:(exe,args,options)=>{
    assert.equal(exe,'powershell.exe');assert.ok(options.windowsHide);assert.equal(options.timeout,15000);
    assert.ok(!args.join(' ').includes('한글')); request=JSON.parse(options.env.CODEX_LABELS_SHORTCUT_REQUEST);
    return 'true';
  }});
  assert.equal(adapter.write('C:\\한글\\Labels.lnk','create',{target:'C:\\한글\\app.exe'}),true);
  assert.equal(request.path,'C:\\한글\\Labels.lnk');
});
