'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function mainHarness(t) {
  const handlers = new Map(), calls = [], paths = [];
  const app = new EventEmitter();
  app.getPath = () => path.resolve('fixture', 'profile'); app.setPath = (...args) => paths.push(args);
  const notifications = {
    status: () => ({enabled: false}), dispose() {}, disconnected() {},
    notify: value => { calls.push(['notify', value]); return {accepted: true}; },
    rendererReady: value => calls.push(['ready', value]),
    acknowledge: (...args) => { calls.push(['ack', ...args]); return true; }
  };
  const mockFs = {mkdirSync() {}, writeFileSync() {}, renameSync() {}, unlinkSync() {},
    readFileSync: file => file.endsWith('notification-renderer.js') ? '/* notification */' : '/* labels */'};
  const dirname = path.resolve('fixture', '.vite', 'build');
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8'), {
    __dirname: dirname, process: {platform: 'win32', env: {LOCALAPPDATA: path.resolve('fixture', 'Local')},
      execPath: path.resolve('fixture', 'ChatGPT.exe'), pid: 123, versions: {electron: 'test'}},
    setTimeout, clearTimeout, console, URL,
    require: name => {
      if (name === 'electron') return {app, ipcMain: {handle: (channel, fn) => handlers.set(channel, fn)},
        shell: {openPath: async () => ''}, BrowserWindow: {getAllWindows: () => [], fromWebContents: () => null}, Notification: {}};
      if (name === 'node:fs') return mockFs;
      if (name === './codex-labels-store.cjs') return {createStore: () => ({configPath: '/config', snapshot: () => ({ok: true})})};
      if (name === './codex-labels/snapshot-cache.cjs') return {createSnapshotCache: store => ({snapshot: store.snapshot, invalidate() {}, close() {}})};
      if (name === './codex-labels/notifications.cjs') return {createNotifications: () => notifications};
      if (name === './codex-labels-location.json') return {configDirectory: path.resolve('fixture', 'config')};
      return require(name);
    }
  });
  t.after(() => app.emit('will-quit'));
  function event(url = 'app://-/threads', trustedPreload = true) {
    const contents = new EventEmitter(); contents.mainFrame = {};
    Object.assign(contents, {id: 1, isDestroyed: () => false, getURL: () => url,
      getLastWebPreferences: () => ({preload: trustedPreload ? path.join(dirname, 'preload.js') : 'foreign-preload.js'})});
    return {sender: contents, senderFrame: contents.mainFrame};
  }
  return {handlers, calls, paths, event, app};
}
test('all new IPC operations reject foreign frames, origins and preload scripts', t => {
  const h = mainHarness(t);
  for (const channel of ['codex-labels:notify-thread', 'codex-labels:notification-status', 'codex-labels:activation-ready', 'codex-labels:activation-ack']) {
    for (const event of [h.event('https://example.com'), h.event('app://evil/'), h.event('file:///tmp/foreign.html'), h.event('app://-/', false)]) {
      assert.throws(() => h.handlers.get(channel)(event, {}), /접근할 수 없는/);
    }
    const frame = h.event(); frame.senderFrame = {};
    assert.throws(() => h.handlers.get(channel)(frame, {}), /접근할 수 없는/);
  }
  assert.equal(h.calls.length, 0);
});
test('trusted main frame may use only the fixed notification/ack operations', t => {
  const h = mainHarness(t); const event = h.event(); const value = {threadId: 't'};
  h.handlers.get('codex-labels:notify-thread')(event, value);
  h.handlers.get('codex-labels:activation-ready')(event);
  h.handlers.get('codex-labels:activation-ack')(event, 'e', 'navigation-requested');
  assert.equal(h.calls[0][0], 'notify'); assert.equal(h.calls[0][1], value);
  assert.equal(h.calls[2][1], event.sender);
});
test('reporting bounds reject corrupt/oversized counters', t => {
  const h = mainHarness(t);
  for (const counts of [null, {rows: -1, badges: 0}, {rows: 10001, badges: 0}, {rows: 1.5, badges: 0}, {rows: 1, badges: Infinity}]) {
    assert.throws(() => h.handlers.get('codex-labels:report')(h.event(), counts), /Invalid/);
  }
});
test('profile is set synchronously before upstream bootstrap can request its lock', t => {
  const h = mainHarness(t);
  assert.equal(h.paths[0][0], 'userData'); assert.match(h.paths[0][1], /CodexLabels/);
});
test('notification capture source is injected before legacy stopImmediatePropagation handlers', async t => {
  const h = mainHarness(t), event = h.event(); let source;
  event.sender.executeJavaScript = async value => { source = value; };
  h.app.emit('web-contents-created', {}, event.sender);
  event.sender.emit('did-finish-load');
  assert.equal(source, '/* notification */\n/* labels */');
});
test('preload subscriptions hide the native event and return an unsubscribe function', () => {
  let api, listener, removed;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'preload.js'), 'utf8'), {
    require: () => ({contextBridge: {exposeInMainWorld: (_name, value) => { api = value; }},
      ipcRenderer: {invoke: () => Promise.resolve(), on: (_channel, fn) => { listener = fn; },
        removeListener: (_channel, fn) => { removed = fn; }}})
  });
  let args; const unsubscribe = api.onActivateThread((...values) => { args = values; });
  const value = {threadId: 't'}; listener({sender: 'must not leak'}, value);
  assert.deepEqual(args, [value]); unsubscribe(); assert.equal(removed, listener);
  assert.equal(api.ipcRenderer, undefined);
});
