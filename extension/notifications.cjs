'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {createShortcutAdapter} = require('./windows-shortcuts.cjs');
const {SCHEME, APP_ID, TOAST_CLSID, parseActivation, activationUri, notificationInput,
  toastXml, activationQueue, boundedDedupe} = require('./notification-core.cjs');

// Dependency injection keeps tests off the real registry/notification system.
function createNotifications({app, shell, Notification, getWindows, trustedContent,
  profile, defaultProfile = profile, platform = process.platform, executable = process.execPath,
  argv = process.argv, io = fs, onStatus = () => {}, now = Date.now}) {
  const queue = activationQueue({now});
  const ready = new Set();
  const live = new Map();
  const hooked = new WeakSet();
  const own = new WeakSet();
  const sent = boundedDedupe({now, ttlMs: 5000});
  const rate = [];
  const shortcuts = createShortcutAdapter(shell);
  const state = {enabled: false, protocolRegistered: false, nativeHook: false,
    handleActivationAvailable: typeof Notification?.handleActivation === 'function',
    toastClsidAvailable: typeof app.setToastActivatorCLSID === 'function',
    nativeShown: 0, nativeClicked: 0, managedShown: 0, activations: 0,
    lastResult: 'registration-needed'};
  let disposed = false, restoreHook = () => {}, lastDelivery = null, toastIdentityApplied = false;
  const protocolArgs = [`--user-data-dir=${profile}`, '--'];
  const shortcut = platform === 'win32' ? path.join(app.getPath('appData'),
    'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Codex Labels.lnk') : null;
  const samePath = (a, b) => typeof a === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  function update(patch) { Object.assign(state, patch); onStatus({...state}); }
  function ownedShortcut() {
    try {
      const link = shortcuts.read(shortcut);
      return link.appUserModelId === APP_ID && samePath(link.target, executable);
    } catch { return false; }
  }
  function applyIdentity() {
    if (platform !== 'win32' || !state.enabled) return;
    app.setAppUserModelId(APP_ID);
    if (state.toastClsidAvailable && !toastIdentityApplied) {
      app.setToastActivatorCLSID(TOAST_CLSID);
      // Native Owl registers only the bare executable. COM cold starts must use
      // the Labels profile before Chromium selects its single-instance target.
      shortcuts.configureActivator({executable, profile, appId: APP_ID, clsid: TOAST_CLSID});
      toastIdentityApplied = true;
    }
  }
  function refreshIdentity() {
    if (platform !== 'win32') { update({lastResult: 'windows-only'}); return; }
    state.enabled = ownedShortcut();
    state.protocolRegistered = state.enabled && app.isDefaultProtocolClient(SCHEME, executable, protocolArgs);
    applyIdentity();
    update({lastResult: state.enabled ? (state.protocolRegistered ? 'ready' : 'protocol-registration-needed') : 'registration-needed'});
  }
  function register() {
    if (platform !== 'win32') throw Error('Windows에서만 알림을 등록할 수 있습니다.');
    if (!samePath(profile, defaultProfile)) throw Error('사용자 지정 테스트 프로필에서는 Windows 등록을 변경하지 않습니다.');
    if (io.existsSync(shortcut)) {
      const old = shortcuts.read(shortcut);
      // Explicit registration may move an OWNED Labels shortcut to a new clone.
      if (old.appUserModelId !== APP_ID) throw Error('같은 이름의 다른 바로가기는 덮어쓰지 않습니다.');
    }
    io.mkdirSync(path.dirname(shortcut), {recursive: true});
    const details = {target: executable, cwd: path.dirname(executable),
      args: `--user-data-dir="${profile}"`, description: 'Codex Labels',
      appUserModelId: APP_ID, toastActivatorClsid: TOAST_CLSID};
    if (!shortcuts.write(shortcut, io.existsSync(shortcut) ? 'update' : 'create', details)) {
      throw Error('Codex Labels 바로가기 등록에 실패했습니다.');
    }
    if (!app.setAsDefaultProtocolClient(SCHEME, executable, protocolArgs)) {
      refreshIdentity(); throw Error('Codex Labels 전용 프로토콜 등록에 실패했습니다.');
    }
    refreshIdentity();
    if (!state.enabled || !state.protocolRegistered) throw Error('Windows 알림 등록 결과를 확인할 수 없습니다.');
    update({registrationError: null});
    installNativeHook();
  }
  function unregister() {
    if (platform !== 'win32') return;
    if (app.isDefaultProtocolClient(SCHEME, executable, protocolArgs) &&
      !app.removeAsDefaultProtocolClient(SCHEME, executable, protocolArgs)) throw Error('프로토콜 해제에 실패했습니다.');
    if (ownedShortcut()) {
      shortcuts.removeActivator({executable, profile, appId: APP_ID, clsid: TOAST_CLSID});
      io.unlinkSync(shortcut);
    }
    restoreHook();
    update({enabled: false, protocolRegistered: false, nativeHook: false, lastResult: 'unregistered-restart-required'});
  }
  function windows() {
    return getWindows().filter(win => !win.isDestroyed() && trustedContent(win.webContents))
      .sort((a, b) => Number(b.isFocused()) - Number(a.isFocused()));
  }
  function focus(win) {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show(); win.focus();
  }
  function flush() {
    if (disposed) return;
    for (const win of windows()) {
      if (!ready.has(win.webContents.id)) continue;
      const value = queue.take(win.webContents.id);
      if (!value) continue;
      try {
        focus(win);
        win.webContents.send('codex-labels:activate-thread', value);
        lastDelivery = {contents: win.webContents, eventId: value.eventId};
        update({lastResult: 'delivered-to-renderer'});
      } catch {
        queue.acknowledge(value.eventId, win.webContents.id, 'failed');
        update({lastResult: 'delivery-failed'});
        continue;
      }
      break;
    }
  }
  function activate(uri) {
    if (disposed) return false;
    let value;
    try { value = parseActivation(uri); } catch (error) {
      let activationShape = null;
      try { const u = new URL(uri); activationShape = {scheme: u.protocol === SCHEME + ':',
        host: u.hostname === 'activate', path: u.pathname === '' ? 'empty' : u.pathname === '/' ? 'slash' : 'other',
        keys: [...u.searchParams.keys()].filter(k => ['v','threadId','hostId','kind','eventId'].includes(k)),
        parameterCount: [...u.searchParams].length}; } catch {}
      update({lastResult: 'invalid-activation', activationError: String(error?.message || 'parse failed'), activationShape}); return false;
    }
    if (!queue.enqueue(value)) return false;
    // Cancel work still waiting in a previously targeted window. Rejecting its
    // eventual ACK alone would not prevent an obsolete row.click() there.
    if (lastDelivery) {
      try {
        if (trustedContent(lastDelivery.contents)) lastDelivery.contents.send('codex-labels:activate-thread',
          {eventId: lastDelivery.eventId, cancel: true});
      } catch { /* A closed/navigated renderer cannot be cancelled. */ }
      lastDelivery = null;
    }
    update({activations: state.activations + 1, lastResult: 'waiting-for-renderer'});
    flush(); return true;
  }
  function processArgs(args) {
    if (!Array.isArray(args)) return;
    if (args.includes('--codex-labels-register-notifications') || args.includes('--codex-labels-unregister-notifications')) {
      if (args[0] && !samePath(args[0], executable)) { update({lastResult: 'profile-in-use-by-another-copy'}); return; }
      try {
        if (args.includes('--codex-labels-unregister-notifications')) unregister();
        else register();
      } catch (error) {
        // Registration receives no notification content. Keep its actionable
        // local error instead of hiding runtime API/shortcut incompatibilities.
        update({lastResult: 'registration-failed', registrationError: String(error?.message || error).slice(0, 500)});
      }
    }
    for (const arg of args) if (typeof arg === 'string' && arg.startsWith(`${SCHEME}:`)) activate(arg);
  }
  function installNativeHook() {
    if (!state.enabled || !Notification?.prototype || state.nativeHook) return;
    const descriptor = Object.getOwnPropertyDescriptor(Notification.prototype, 'show');
    const original = Notification.prototype.show;
    if (typeof original !== 'function' || (descriptor && !descriptor.writable && !descriptor.configurable)) {
      update({lastResult: 'native-hook-unavailable'}); return;
    }
    function show(...args) {
      if (!disposed && state.enabled) {
        try {
          // Upstream code can set its own AUMID after bootstrap: reapply before display.
          applyIdentity();
          if (!own.has(this) && !hooked.has(this)) {
            hooked.add(this);
            // Preserve upstream click listeners and their exact task routing.
            this.prependListener('click', () => {
              if (disposed) return;
              try { focus(windows()[0]); } catch { /* Never block the original callback. */ }
              update({nativeClicked: state.nativeClicked + 1, lastResult: 'native-click-forwarded'});
            });
            this.on('show', () => { if (!disposed) update({nativeShown: state.nativeShown + 1}); });
            this.on('failed', () => { if (!disposed) update({lastResult: 'native-notification-failed'}); });
          }
        } catch { update({lastResult: 'native-hook-failed'}); }
      }
      return Reflect.apply(original, this, args);
    }
    try {
      Notification.prototype.show = show;
      if (Notification.prototype.show !== show) throw Error('read-only');
      restoreHook = () => {
        if (Notification.prototype.show === show) {
          if (descriptor) Object.defineProperty(Notification.prototype, 'show', descriptor);
          else delete Notification.prototype.show;
        }
        state.nativeHook = false;
      };
      update({nativeHook: true});
    } catch { update({lastResult: 'native-hook-unavailable'}); }
  }
  function notify(input) {
    if (disposed) throw Error('알림 서비스가 종료되었습니다.');
    const n = notificationInput(input);
    if (!state.enabled || !state.protocolRegistered) throw Error('launch.ps1 -RegisterNotifications로 알림 연결을 먼저 등록하세요.');
    if (!Notification.isSupported()) throw Error('이 환경에서는 알림이 지원되지 않습니다.');
    const time = now();
    while (rate.length && rate[0] <= time - 60000) rate.shift();
    if (rate.length >= 20) throw Error('알림 요청이 너무 많습니다. 잠시 후 다시 시도하세요.');
    if (!sent.accept(n.eventId)) return {accepted: false, reason: 'duplicate'};
    rate.push(time);
    applyIdentity();
    // Protocol activation handles warm/cold starts without stealing upstream
    // Notification.handleActivation callbacks or relying on an Electron major.
    const notice = new Notification({toastXml: toastXml(n, true)});
    own.add(notice);
    live.set(n.eventId, {notice, expiresAt: time + 86400000});
    notice.on('show', () => update({managedShown: state.managedShown + 1, lastResult: 'notification-shown'}));
    notice.on('failed', () => { live.delete(n.eventId); update({lastResult: 'notification-failed'}); });
    notice.on('close', event => {
      if (event?.reason === 'userCanceled' || event?.reason === 'applicationHidden') live.delete(n.eventId);
    });
    // Some compatible runtimes deliver a native click even for protocol XML.
    // Both routes use the same eventId and the activation queue deduplicates them.
    notice.on('click', () => activate(activationUri(n)));
    try { notice.show(); } catch (error) { live.delete(n.eventId); throw error; }
    while (live.size > 64) {
      const id = live.keys().next().value;
      try { live.get(id).notice.close(); } catch { /* Bound retention even if native close fails. */ }
      live.delete(id);
    }
    return {accepted: true, eventId: n.eventId};
  }
  const secondInstance = (_event, args) => processArgs(args);
  const openUrl = (event, uri) => {
    if (typeof uri === 'string' && uri.startsWith(`${SCHEME}:`)) { event.preventDefault(); activate(uri); }
  };
  app.on('second-instance', secondInstance);
  app.on('open-url', openUrl);
  const sweep = setInterval(() => {
    if (disposed) return;
    for (const [id, item] of live) if (item.expiresAt <= now()) { try { item.notice.close(); } catch {} live.delete(id); }
    if (!queue.pending && ['waiting-for-renderer', 'delivered-to-renderer'].includes(state.lastResult)) update({lastResult: 'activation-expired'});
  }, 5000);
  sweep.unref?.();
  // Identity must be set before upstream bootstrap initializes native toasts.
  // Waiting for whenReady is too late on the supported Owl runtime.
  try { refreshIdentity(); installNativeHook(); } catch { update({lastResult: 'initialization-failed'}); }
  const initialized = app.whenReady().then(() => {
    if (disposed) return;
    try { refreshIdentity(); installNativeHook(); processArgs(argv); } catch { update({lastResult: 'initialization-failed'}); }
  });
  return {
    initialized, notify, activate, register, unregister,
    rendererReady(contents) { ready.add(contents.id); flush(); },
    disconnected(contents) {
      ready.delete(contents.id); queue.disconnected(contents.id);
      if (lastDelivery?.contents.id === contents.id) lastDelivery = null;
      flush();
    },
    acknowledge(contents, eventId, result) {
      if (!queue.acknowledge(eventId, contents.id, result)) return false;
      lastDelivery = null;
      update({lastResult: result}); flush(); return true;
    },
    status: () => ({...state, pending: Boolean(queue.pending), retainedNotifications: live.size}),
    dispose() {
      disposed = true; restoreHook(); clearInterval(sweep); queue.clear(); ready.clear(); live.clear(); lastDelivery = null;
      app.removeListener('second-instance', secondInstance); app.removeListener('open-url', openUrl);
    }
  };
}
module.exports = {createNotifications};
