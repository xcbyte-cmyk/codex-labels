'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createSnapshotCache} = require('./snapshot-cache.cjs');
function mainHarness(t) {
  const handlers = new Map(), calls = [], paths = [], windows = [], sent = [];
  let changed, cache, reads = 0;
  let snapshot = {configRevision: 'initial', configError: null, config: {}, assignments: {}};
  const store = {configPath: '/config', snapshot: () => { reads++; return snapshot; },
    assign: (key, id) => (snapshot = {...snapshot, assignments: {[key]: id}}),
    saveConfig: config => (snapshot = {...snapshot, config})};
  const app = new EventEmitter();
  app.getPath = () => path.resolve('fixture', 'profile'); app.setPath = (...args) => paths.push(args);
  const notifications = {
    status: () => ({enabled: false}), dispose() {}, disconnected() {},
    notify: value => { calls.push(['notify', value]); return {accepted: true}; },
    rendererReady: value => calls.push(['ready', value]),
    acknowledge: (...args) => { calls.push(['ack', ...args]); return true; }
  };
  const mockFs = {mkdirSync() {}, writeFileSync() {}, renameSync() {}, unlinkSync() {},
    readFileSync: file => file.endsWith('notification-renderer.js') ? '/* notification */' : file.endsWith('vocabulary-renderer.js') ? '/* vocabulary */' : '/* labels */'};
  const dirname = path.resolve('fixture', '.vite', 'build');
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8'), {
    __dirname: dirname, process: {platform: 'win32', env: {LOCALAPPDATA: path.resolve('fixture', 'Local')},
      execPath: path.resolve('fixture', 'ChatGPT.exe'), resourcesPath:path.resolve('fixture','resources'), pid: 123, versions: {electron: 'test'}},
    setTimeout, clearTimeout, console, URL,
    require: name => {
      if (name === 'electron') return {app, ipcMain: {handle: (channel, fn) => handlers.set(channel, fn)},
        shell: {openPath: async () => ''}, BrowserWindow: {getAllWindows: () => windows, fromWebContents: () => null}, Notification: {}};
      if (name === 'node:fs') return mockFs;
      if (name === './codex-labels/vocabulary-ipc.cjs') return {registerVocabulary: () => ({dispose(){}})};
      if (name === './codex-labels-store.cjs') return {createStore: () => store};
      if (name === './codex-labels/snapshot-cache.cjs') return {createSnapshotCache: (value, directory, options) => {
        changed = options.onChange;
        cache = createSnapshotCache(value, directory, {...options, watch: () => { const watcher = new EventEmitter(); watcher.close = () => {}; return watcher; }});
        return cache;
      }};
      if (name === './codex-labels/notifications.cjs') return {createNotifications: () => notifications};
      if (name === './codex-labels/updates.cjs') return {createUpdater: () => ({check: () => ({available:false}), stage: () => ({pendingRestart:true}), status: () => ({}), restart: () => ({restarting:true})})};
      if (name === './codex-labels-location.json') return {configDirectory: path.resolve('fixture', 'config')};
      return require(name);
    }
  });
  t.after(() => app.emit('will-quit'));
  function event(url = 'app://-/threads', trustedPreload = true) {
    const contents = new EventEmitter(); contents.mainFrame = {};
    Object.assign(contents, {id: 1, isDestroyed: () => false, getURL: () => url, send: (...args) => sent.push([contents, ...args]),
      getLastWebPreferences: () => ({preload: trustedPreload ? path.join(dirname, 'preload.js') : 'foreign-preload.js'})});
    return {sender: contents, senderFrame: contents.mainFrame};
  }
  return {handlers, calls, paths, event, app, windows, sent, changed: () => changed(), cache, get reads() { return reads; }};
}
test('all new IPC operations reject foreign frames, origins and preload scripts', t => {
  const h = mainHarness(t);
  for (const channel of ['codex-labels:read', 'codex-labels:assign', 'codex-labels:save-config', 'codex-labels:notify-thread', 'codex-labels:notification-status', 'codex-labels:activation-ready', 'codex-labels:activation-ack', 'codex-labels:update-check', 'codex-labels:update-stage', 'codex-labels:update-status', 'codex-labels:restart-update']) {
    for (const event of [h.event('https://example.com'), h.event('app://evil/'), h.event('file:///tmp/foreign.html'), h.event('app://-/', false)]) {
      assert.throws(() => h.handlers.get(channel)(event, {}), /접근할 수 없는/);
    }
    const frame = h.event(); frame.senderFrame = {};
    assert.throws(() => h.handlers.get(channel)(frame, {}), /접근할 수 없는/);
  }
  assert.equal(h.calls.length, 0);
});
test('conditional IPC reads and own writes share the versioned cache', t => {
  const h = mainHarness(t), event = h.event(), read = h.handlers.get('codex-labels:read');
  const first = read(event);
  assert.equal(read(event, first.snapshotVersion), null);
  const assigned = h.handlers.get('codex-labels:assign')(event, 'thread:one', 'review');
  assert.equal(read(event, assigned.snapshotVersion), null);
  assert.equal(assigned.assignments['thread:one'], 'review');
  assert.notEqual(assigned.snapshotVersion, first.snapshotVersion);
  const saved = h.handlers.get('codex-labels:save-config')(event, {labels: []}, first.configRevision);
  assert.equal(read(event), saved);
  assert.notEqual(saved.snapshotVersion, assigned.snapshotVersion);
  assert.equal(h.reads, 1);
});
test('change signals go only to trusted live top-level contents and tolerate a closing window', t => {
  const h = mainHarness(t), trusted = h.event().sender, closed = h.event().sender, closing = h.event().sender;
  closed.isDestroyed = () => true;
  closing.send = () => { throw Error('closed during send'); };
  const contents = [h.event('https://example.com').sender, h.event('app://-/', false).sender, closed, closing, trusted];
  for (const webContents of contents) h.windows.push({webContents, isDestroyed: () => false});
  h.windows.push({webContents: trusted, isDestroyed: () => true});
  h.changed();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0][0], trusted);
  assert.deepEqual(h.sent[0].slice(1), ['codex-labels:changed']);
  trusted.getURL = () => 'https://example.com';
  h.changed();
  assert.equal(h.sent.length, 1);
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
  assert.equal(source, '/* notification */\n/* vocabulary */\n/* labels */');
});
test('preload subscriptions hide the native event and return an unsubscribe function', () => {
  let api, removed;
  const listeners = new Map(), invokes = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'preload.js'), 'utf8'), {
    require: () => ({contextBridge: {exposeInMainWorld: (_name, value) => { api = value; }},
      ipcRenderer: {invoke: (...args) => { invokes.push(args); return Promise.resolve(); }, on: (channel, fn) => { listeners.set(channel, fn); },
        removeListener: (channel, fn) => { removed = fn; if (listeners.get(channel) === fn) listeners.delete(channel); }}})
  });
  let args; const unsubscribe = api.onActivateThread((...values) => { args = values; });
  const listener = listeners.get('codex-labels:activate-thread');
  const value = {threadId: 't'}; listener({sender: 'must not leak'}, value);
  assert.deepEqual(args, [value]); unsubscribe(); assert.equal(removed, listener);
  assert.equal(listeners.has('codex-labels:activate-thread'), false);
  const offChanged = api.onChanged((...values) => { args = values; });
  listeners.get('codex-labels:changed')({sender: 'must not leak'}, {unexpected: 'payload'});
  assert.deepEqual(args, []);
  offChanged(); assert.equal(listeners.has('codex-labels:changed'), false);
  assert.throws(() => api.onChanged(null), /callback/);
  api.read('known-version'); api.read();
  assert.deepEqual(invokes, [['codex-labels:read', 'known-version'], ['codex-labels:read', undefined]]);
  assert.equal(api.ipcRenderer, undefined);
});
