'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {install} = require('./auto-account-main.cjs');

function harness(t, argv = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'labels-picker-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.writeFileSync(path.join(root, 'CodexLabelsHelper.exe'), 'synthetic');
  const app = new EventEmitter(), handlers = new Map(), launches = [];
  app.quit = () => {};
  install({app, root, home: path.join(root, 'home'), profile: path.join(root, 'profile'),
    argv, platform: 'win32', local: root, check: () => {},
    ipcMain: {handle: (name, fn) => handlers.set(name, fn)},
    spawnProcess: (_exe, args) => {
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.unref = () => {};
      launches.push({args, child}); return child;
    }});
  return {app, handlers, launches};
}

test('legacy launcher request and in-app button share a single picker', t => {
  const h = harness(t, ['app', '--codex-labels-open-accounts']);
  assert.equal(h.launches.length, 0);
  h.app.emit('ready');
  assert.equal(h.launches.length, 1);
  assert.equal(h.launches[0].args[0], 'auto-accounts');
  assert.deepEqual(h.handlers.get('codex-labels:auto-accounts-open')({}), {opened: false, alreadyOpen: true});
  h.launches[0].child.emit('close');
  h.handlers.get('codex-labels:auto-accounts-open')({});
  assert.equal(h.launches.length, 2);
});

test('existing desktop handles a forwarded selector request', t => {
  const h = harness(t);
  h.app.emit('second-instance', {}, ['app']);
  assert.equal(h.launches.length, 0);
  h.app.emit('second-instance', {}, ['app', '--codex-labels-open-accounts']);
  assert.equal(h.launches.length, 1);
  assert.ok(h.launches[0].args.includes('--parent-pid'));
});
