'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const path = require('node:path');
const {createNotifications} = require('./notifications.cjs');
const {SCHEME, APP_ID, TOAST_CLSID, activationUri} = require('./notification-core.cjs');
const thread = {threadId: 'task-secret-123', hostId: 'remote-ssh-discovered:qa-runner', kind: 'remote', eventId: 'event-123'};
function windowFixture(id, trusted = true) {
  const sent = [];
  const contents = {id, trusted, send: (...args) => sent.push(args)};
  return {webContents: contents, sent, minimized: true, focused: false, visible: false,
    isDestroyed: () => false, isFocused() { return this.focused; }, isMinimized() { return this.minimized; },
    restore() { this.minimized = false; }, show() { this.visible = true; }, focus() { this.focused = true; }};
}
async function harness(t, options = {}) {
  const executable = path.resolve('fixture', 'ChatGPT.exe');
  const profile = path.resolve('fixture with spaces', 'profile');
  let time = 0, registered = false;
  const calls = [], links = new Map(), shown = [], windows = [windowFixture(1)];
  const app = new EventEmitter();
  Object.assign(app, {
    whenReady: () => Promise.resolve(), getPath: () => path.resolve('fixture', 'AppData'),
    setAppUserModelId: id => calls.push(['aumid', id]), setToastActivatorCLSID: id => calls.push(['clsid', id]),
    isDefaultProtocolClient: scheme => registered && scheme === SCHEME,
    setAsDefaultProtocolClient: (...args) => { calls.push(['register', ...args]); registered = true; return true; },
    removeAsDefaultProtocolClient: (...args) => { calls.push(['unregister', ...args]); registered = false; return true; }
  });
  class NativeNotification extends EventEmitter {
    constructor(options) { super(); this.options = options; }
    static isSupported() { return true; }
    show() { shown.push(this); this.emit('show'); }
    close() { this.emit('close', {reason: 'applicationHidden'}); }
  }
  const originalShow = NativeNotification.prototype.show;
  const shell = {
    readShortcutLink: file => { if (!links.has(file)) throw Error('not found'); return links.get(file); },
    writeShortcutLink: (file, operation, detail) => { calls.push(['shortcut', operation, detail]); links.set(file, detail); return true; }
  };
  const io = {existsSync: file => links.has(file), mkdirSync: () => {}, unlinkSync: file => links.delete(file)};
  const settings = {app, shell, Notification: NativeNotification, getWindows: () => windows,
    trustedContent: contents => contents.trusted, profile, defaultProfile: profile, platform: 'win32',
    executable, argv: [executable], io, now: () => time, ...options};
  const service = createNotifications(settings);
  t.after(() => service.dispose()); await service.initialized;
  return {service, app, calls, links, shown, windows, profile, executable, NativeNotification, originalShow,
    advance: ms => { time += ms; }};
}
test('registration is explicit: merely loading Labels leaves Windows associations alone', async t => {
  const h = await harness(t);
  assert.equal(h.calls.length, 0); assert.equal(h.service.status().enabled, false);
  assert.throws(() => h.service.notify({...thread, title: 'test'}), /RegisterNotifications/);
});
test('registration uses its own AUMID, fixed CLSID, profile and protocol only', async t => {
  const h = await harness(t); h.service.register();
  const shortcut = h.calls.find(([type]) => type === 'shortcut')[2];
  assert.equal(shortcut.appUserModelId, APP_ID); assert.equal(shortcut.toastActivatorClsid, TOAST_CLSID);
  assert.equal(shortcut.target, h.executable); assert.match(shortcut.args, /--user-data-dir="/);
  const call = h.calls.find(([type]) => type === 'register');
  assert.equal(call[1], SCHEME); assert.deepEqual(call[3], [`--user-data-dir=${h.profile}`, '--']);
  assert.equal(h.service.status().protocolRegistered, true);
  assert.ok(h.calls.every(call => call[1] !== 'codex'));
});
test('unregistration removes only its own link and scheme', async t => {
  const h = await harness(t); h.service.register(); h.service.unregister();
  assert.equal(h.links.size, 0); assert.equal(h.NativeNotification.prototype.show, h.originalShow);
  assert.equal(h.calls.find(([type]) => type === 'unregister')[1], SCHEME);
});
test('foreign same-name shortcut is never overwritten', async t => {
  const h = await harness(t); h.service.register();
  const filename = h.links.keys().next().value; h.links.set(filename, {appUserModelId: 'foreign', target: 'foreign.exe'});
  assert.throws(() => h.service.register(), /덮어쓰지/);
  h.service.unregister(); assert.equal(h.links.get(filename).appUserModelId, 'foreign');
});
test('a custom QA profile cannot register Windows associations', async t => {
  const h = await harness(t, {defaultProfile: path.resolve('another-profile')});
  assert.throws(() => h.service.register(), /테스트 프로필/); assert.equal(h.calls.length, 0);
});
test('native hook keeps existing click callbacks and focuses a Labels-owned window', async t => {
  const h = await harness(t); h.service.register(); let clicks = 0;
  const n = new h.NativeNotification({title: 'upstream'}); n.on('click', () => { clicks++; assert.equal(h.windows[0].focused, true); });
  n.show(); n.show(); n.emit('click');
  assert.equal(clicks, 1); assert.equal(h.service.status().nativeShown, 2);
  assert.equal(h.service.status().nativeClicked, 1); assert.equal(n.listenerCount('click'), 2);
});
test('managed notices use protocol XML without a competing instance-click route', async t => {
  const h = await harness(t); h.service.register(); const result = h.service.notify({...thread, title: 'test'});
  assert.equal(result.accepted, true); assert.match(h.shown[0].options.toastXml, /activationType="protocol"/);
  assert.equal(h.shown[0].listenerCount('click'), 0); assert.equal(h.service.status().managedShown, 1);
});
test('explicit routing works without Notification.handleActivation', async t => {
  const h = await harness(t); h.service.register(); assert.equal(h.service.status().handleActivationAvailable, false);
  h.service.notify({...thread, title: 'test'}); assert.equal(h.shown.length, 1);
});
test('activation waits for renderer-ready and restores the matching Labels window', async t => {
  const h = await harness(t); h.service.activate(activationUri(thread));
  assert.equal(h.windows[0].sent.length, 0);
  h.service.rendererReady(h.windows[0].webContents);
  assert.deepEqual(h.windows[0].sent[0], ['codex-labels:activate-thread', thread]);
  assert.equal(h.windows[0].minimized, false); assert.equal(h.windows[0].visible, true);
  assert.equal(h.service.acknowledge(h.windows[0].webContents, thread.eventId, 'navigation-requested'), true);
  assert.equal(h.service.status().pending, false);
});
test('foreign sender and stale acknowledgements cannot consume pending navigation', async t => {
  const h = await harness(t); h.service.rendererReady(h.windows[0].webContents); h.service.activate(activationUri(thread));
  assert.equal(h.service.acknowledge({id: 9}, thread.eventId, 'navigation-requested'), false);
  assert.equal(h.service.acknowledge({id: 1}, 'wrong-event', 'navigation-requested'), false);
  assert.equal(h.service.status().pending, true);
});
test('not-found tries a second trusted renderer without broadcasting to all windows', async t => {
  const h = await harness(t); h.windows.push(windowFixture(2));
  for (const w of h.windows) h.service.rendererReady(w.webContents);
  h.service.activate(activationUri(thread));
  assert.equal(h.windows[0].sent.length, 1); assert.equal(h.windows[1].sent.length, 0);
  h.service.acknowledge(h.windows[0].webContents, thread.eventId, 'thread-not-found');
  assert.equal(h.windows[1].sent.length, 1);
});
test('untrusted views never receive a thread ID', async t => {
  const h = await harness(t); h.windows[0].webContents.trusted = false;
  h.service.rendererReady(h.windows[0].webContents); h.service.activate(activationUri(thread));
  assert.equal(h.windows[0].sent.length, 0);
});
test('second-instance URI and cold-start argv feed the same queue', async t => {
  const uri = activationUri(thread); const h = await harness(t, {argv: ['ignored-exe', uri]});
  h.service.rendererReady(h.windows[0].webContents); assert.equal(h.windows[0].sent.length, 1);
  h.service.acknowledge(h.windows[0].webContents, thread.eventId, 'navigation-requested');
  h.app.emit('second-instance', {}, [h.executable, activationUri({...thread, eventId: 'new'})]);
  assert.equal(h.windows[0].sent.length, 2);
});
test('registration requests from a different copy cannot redirect an already-running profile', async t => {
  const h = await harness(t);
  h.app.emit('second-instance', {}, ['another.exe', '--codex-labels-register-notifications']);
  assert.equal(h.calls.length, 0); assert.equal(h.service.status().lastResult, 'profile-in-use-by-another-copy');
});
test('malicious activation links never navigate or execute commands', async t => {
  const h = await harness(t); h.service.rendererReady(h.windows[0].webContents);
  for (const uri of ['codex://t', 'file:///C:/secret', activationUri(thread) + '&command=approve']) assert.equal(h.service.activate(uri), false);
  assert.equal(h.windows[0].sent.length, 0); assert.equal(h.calls.length, 0);
});
test('duplicate notices and duplicate activation events are bounded', async t => {
  const h = await harness(t); h.service.register();
  assert.equal(h.service.notify({...thread, title: 'test'}).accepted, true);
  assert.equal(h.service.notify({...thread, title: 'test'}).accepted, false);
  h.service.rendererReady(h.windows[0].webContents);
  h.service.activate(activationUri(thread)); h.service.activate(activationUri(thread));
  assert.equal(h.shown.length, 1); assert.equal(h.windows[0].sent.length, 1);
});
test('notification rate limit rejects flooding before constructing native objects', async t => {
  const h = await harness(t); h.service.register();
  for (let i = 0; i < 20; i++) h.service.notify({...thread, eventId: 'event-' + i, title: 'test'});
  assert.throws(() => h.service.notify({...thread, eventId: 'excess', title: 'test'}), /너무 많/);
  assert.equal(h.shown.length, 20);
});
test('notification object retention stays bounded even without close events', async t => {
  const h = await harness(t); h.service.register();
  for (let i = 0; i < 70; i++) { h.advance(61000); h.service.notify({...thread, eventId: 'event-' + i, title: 'test'}); }
  assert.equal(h.service.status().retainedNotifications, 64);
});
test('diagnostics never include notification text or task identity', async t => {
  const h = await harness(t); h.service.register(); h.service.notify({...thread, title: 'private title', body: 'private body'});
  h.service.activate(activationUri(thread)); const status = JSON.stringify(h.service.status());
  for (const secret of ['private title', 'private body', thread.threadId, thread.hostId]) assert.ok(!status.includes(secret));
});
test('disposal restores the upstream show function and releases app listeners', async t => {
  const h = await harness(t); h.service.register(); h.service.dispose();
  assert.equal(h.NativeNotification.prototype.show, h.originalShow);
  assert.equal(h.app.listenerCount('second-instance'), 0); assert.equal(h.app.listenerCount('open-url'), 0);
  assert.throws(() => h.service.notify({...thread, title: 'test'}), /종료/);
});
test('non-Windows execution makes no OS registrations', async t => {
  const h = await harness(t, {platform: 'linux'}); assert.equal(h.calls.length, 0);
  assert.equal(h.service.status().lastResult, 'windows-only');
});

test('a new click cancels obsolete pending work in a different window', async t => {
  const h = await harness(t); h.windows.push(windowFixture(2));
  for (const win of h.windows) h.service.rendererReady(win.webContents);
  h.service.activate(activationUri(thread));
  h.windows[0].focused = false; h.windows[1].focused = true;
  const next = {...thread, threadId: 'next', eventId: 'next-event'};
  h.service.activate(activationUri(next));
  assert.deepEqual(h.windows[0].sent[1], ['codex-labels:activate-thread', {eventId: thread.eventId, cancel: true}]);
  assert.deepEqual(h.windows[1].sent[0], ['codex-labels:activate-thread', next]);
  assert.equal(h.service.acknowledge(h.windows[0].webContents, thread.eventId, 'navigation-requested'), false);
});
