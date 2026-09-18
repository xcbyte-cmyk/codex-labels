'use strict';
// Loaded by early-bootstrap.js BEFORE the upstream single-instance lock.
const {app, ipcMain, shell, BrowserWindow, Notification} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const {fileURLToPath} = require('node:url');
const {createStore} = require('./codex-labels-store.cjs');
const {createSnapshotCache} = require('./codex-labels/snapshot-cache.cjs');
const {createNotifications} = require('./codex-labels/notifications.cjs');
const {configDirectory: installedConfigDirectory} = require('./codex-labels-location.json');
const {resolveAccount, disabledNotifications} = require('./codex-labels/account-profile.cjs');
const accountProfile = resolveAccount(installedConfigDirectory);
// The copied runtime has no MSIX package identity. Use its bundled CLI
// after account environment selection, before the upstream bootstrap runs.
if (process.platform === 'win32') {
  process.env.CODEX_CLI_PATH = path.join(process.resourcesPath, 'codex.exe');
  process.env.CODEX_APP_SERVER_FORCE_CLI = '1';
}
const windowTitle = accountProfile ? `Codex Labels · ${accountProfile.name}` : 'Codex Labels';
// Installer smoke uses a fresh config, profile and CODEX_HOME, never account data.
const smokeDirectory = process.env.CODEX_LABELS_SMOKE_DIRECTORY;
const configDirectory = smokeDirectory || accountProfile?.directory || installedConfigDirectory;
const {createUpdater} = require('./codex-labels/updates.cjs');
const updater = createUpdater(installedConfigDirectory, {quit: () => app.quit()});
app.once('ready', () => { if (!smokeDirectory && !accountProfile) updater.prime().catch(() => {}); });
// Protocol/shortcut launches do not inherit launch.ps1's environment. Keep them
// on the SAME Labels profile, without modifying CODEX_HOME or the original app.
const defaultProfile = process.platform === 'win32' && process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'CodexLabels', 'User Data') : app.getPath('userData');
const profile = process.env.CODEX_ELECTRON_USER_DATA_PATH || defaultProfile;
if (process.platform === 'win32') {
  fs.mkdirSync(profile, {recursive: true});
  process.env.CODEX_ELECTRON_USER_DATA_PATH = profile;
  app.setPath('userData', profile);
}
const store = createStore(configDirectory);
const cache = createSnapshotCache(store, configDirectory, {onChange: broadcastConfigChange});
const {registerVocabulary} = require('./codex-labels/vocabulary-ipc.cjs');
const vocabulary = registerVocabulary({ipcMain,check,directory:configDirectory,
  executable:path.join(process.resourcesPath,'codex.exe'),home:accountProfile?.home || process.env.CODEX_HOME || path.join(app.getPath('home'),'.codex')});
const statusPath = path.join(configDirectory, 'runtime-status.json');
let status = {version: 3, status: 'starting', settingsAvailable: true,
    accountProfileId: accountProfile?.id || null,
    codexHome: accountProfile?.home || null,
  launchToken: process.env.CODEX_LABELS_LAUNCH_TOKEN || null,
  processId: process.pid, executable: process.execPath, electronVersion: process.versions.electron || null,
  configPath: store.configPath, userDataPath: app.getPath('userData'), rows: 0, badges: 0};
let statusTimer, ownsSharedStatus = false;
app.on('second-instance', (_event, argv) => {
  const token = argv?.find(value => /^--codex-labels-launch-token=[0-9a-f]{32}$/.test(value))?.split('=')[1];
  if (token) recordStatus({recentLaunchTokens: [...(status.recentLaunchTokens || []), token].slice(-8)});
});
function flushStatus() {
  clearTimeout(statusTimer); statusTimer = undefined;
  const value = JSON.stringify({...status, updatedAt: new Date().toISOString()}, null, 2);
  // Per-PID evidence distinguishes Labels instances; no notification content or IDs.
  const destinations = [path.join(configDirectory, `runtime-status.${process.pid}.json`)];
  // A short-lived secondary process must not overwrite the active process receipt.
  if (ownsSharedStatus) destinations.push(statusPath);
  for (const destination of destinations) {
    const temp = `${destination}.tmp-${process.pid}`;
    try { fs.writeFileSync(temp, value, {mode: 0o600}); fs.renameSync(temp, destination); }
    catch { try { fs.unlinkSync(temp); } catch {} }
  }
}
function recordStatus(patch) {
  status = {...status, ...patch};
  if (!statusTimer) { statusTimer = setTimeout(flushStatus, 100); statusTimer.unref?.(); }
  if (smokeDirectory && patch.status === 'active') {
    try {
      if (patch.rows !== 1 || patch.badges !== 1) throw Error('Smoke label badge missing');
      const id = store.snapshot().config.labels.find(label => label.enabled)?.id || null;
      const key = 'thread:local:local:labels-smoke';
      store.assign(key, id);
      if (id && store.snapshot().assignments[key] !== id) throw Error('Smoke assignment readback failed');
      store.assign(key, null);
      status.smokePassed = true;
    } catch (error) { status.smokePassed = false; status.smokeError = error.message; }
    flushStatus();
    setTimeout(() => app.exit(status.smokePassed ? 0 : 1), 250);
  }
}
const preloadPath = path.join(__dirname, 'preload.js');
const webRoot = path.resolve(__dirname, '../../webview');
function trustedUrl(value) {
  try {
    const u = new URL(value);
    if (u.protocol === 'app:' && u.hostname === '-') return true;
    if (u.protocol !== 'file:') return false;
    const file = path.resolve(fileURLToPath(u));
    return file === path.join(webRoot, 'index.html') ||
      (smokeDirectory && file === path.join(path.resolve(smokeDirectory), 'smoke.html'));
  } catch { return false; }
}
function trustedContent(contents) {
  return !contents.isDestroyed() && path.resolve(contents.getLastWebPreferences().preload || '.') === preloadPath && trustedUrl(contents.getURL());
}
function check(event) {
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame || !trustedContent(event.sender)) {
    throw Error('라벨 설정에 접근할 수 없는 화면입니다.');
  }
}
function broadcastConfigChange() {
  for (const window of BrowserWindow.getAllWindows()) {
    // Send only a signal to trusted top-level renderers. Recheck on every send
    // because a window can navigate or close between the watcher and callback.
    try {
      if (!window.isDestroyed() && trustedContent(window.webContents)) window.webContents.send('codex-labels:changed');
    } catch { /* A closing renderer must not prevent updates to other windows. */ }
  }
}
const notifications = accountProfile ? disabledNotifications() : createNotifications({app, shell, Notification, profile, defaultProfile,
  getWindows: () => BrowserWindow.getAllWindows(), trustedContent,
  onStatus: notification => recordStatus({notification})});
ipcMain.handle('codex-labels:read', (event, knownVersion) => { check(event); return cache.snapshot(knownVersion); });
ipcMain.handle('codex-labels:assign', (event, key, id) => {
  check(event); return cache.update(store.assign(key, id));
});
ipcMain.handle('codex-labels:save-config', (event, draft, revision) => {
  check(event); return cache.update(store.saveConfig(draft, revision));
});
ipcMain.handle('codex-labels:report', (event, counts) => {
  check(event);
  if (!counts || !Number.isSafeInteger(counts.rows) || !Number.isSafeInteger(counts.badges) ||
      counts.rows < 0 || counts.badges < 0 || counts.rows > 10000 || counts.badges > 10000) throw Error('Invalid label counts');
  ownsSharedStatus = true;
  recordStatus({status: 'active', rows: counts.rows, badges: counts.badges}); return true;
});
ipcMain.handle('codex-labels:open-config', async event => {
  check(event); const result = await shell.openPath(store.configPath); if (result) throw Error(result); return true;
});
ipcMain.handle('codex-labels:update-check', event => { check(event); return updater.check(); });
function checkUpdateWindow() {
  if (accountProfile) throw Error('계정별 창을 모두 닫고 기본 Labels에서 업데이트하세요.');
}
ipcMain.handle('codex-labels:update-stage', event => { check(event); checkUpdateWindow(); return updater.stage(); });
ipcMain.handle('codex-labels:update-status', event => { check(event); return updater.status(); });
ipcMain.handle('codex-labels:restart-update', event => { check(event); checkUpdateWindow(); return updater.restart(); });
ipcMain.handle('codex-labels:rollback-update', event => { check(event); checkUpdateWindow(); return updater.rollback(); });
ipcMain.handle('codex-labels:notify-thread', (event, value) => { check(event); return notifications.notify(value); });
ipcMain.handle('codex-labels:notification-status', event => { check(event); return notifications.status(); });
ipcMain.handle('codex-labels:activation-ready', event => { check(event); ownsSharedStatus = true; notifications.rendererReady(event.sender); return true; });
ipcMain.handle('codex-labels:activation-ack', (event, eventId, result) => {
  check(event);
  return notifications.acknowledge(event.sender, eventId, result);
});
// Register capture handlers before the label renderer's stopImmediatePropagation.
const source = fs.readFileSync(path.join(__dirname, 'codex-labels/notification-renderer.js'), 'utf8') + '\n' +
  fs.readFileSync(path.join(__dirname, 'codex-labels/vocabulary-renderer.js'), 'utf8') + '\n' +
  fs.readFileSync(path.join(__dirname, 'codex-labels-renderer.js'), 'utf8') + (accountProfile ? `\n(() => {
    if (document.getElementById('codex-labels-account-name')) return;
    const badge = document.createElement('div'); badge.id = 'codex-labels-account-name';
    badge.textContent = ${JSON.stringify(accountProfile?.name)};
    badge.title = '계정별 작업 창 · 실제 로그인 계정은 계정 메뉴에서 확인하세요';
    badge.style.cssText = 'position:fixed;top:7px;left:50%;transform:translateX(-50%);z-index:2147483646;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:2px 12px;border:1px solid #64748b;border-radius:12px;background:#172033;color:#e2e8f0;font:12px/1.4 "Segoe UI","Malgun Gothic",sans-serif;pointer-events:none';
    document.body.appendChild(badge);
  })();` : '');
const titledWindows = new WeakSet();
app.on('web-contents-created', (_event, contents) => {
  contents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
    if (mainFrame && !inPlace) notifications.disconnected(contents);
  });
  contents.once('destroyed', () => notifications.disconnected(contents));
  contents.on('did-finish-load', () => {
    if (!trustedContent(contents)) return;
    const window = BrowserWindow.fromWebContents(contents);
    if (window && !window.isDestroyed()) {
      window.setTitle(windowTitle);
      if (!titledWindows.has(window)) {
        titledWindows.add(window);
        window.on('page-title-updated', event => {
          if (trustedContent(contents) && !window.isDestroyed()) { event.preventDefault(); window.setTitle(windowTitle); }
        });
      }
    }
    contents.executeJavaScript(source).then(() => {
      // Fresh accounts show onboarding, not a sidebar. A loaded trusted
      // renderer is UI readiness; it is deliberately not login verification.
      if (accountProfile) {
        ownsSharedStatus = true;
        recordStatus({status: 'active', accountWindowReady: true});
      }
    }).catch(() => recordStatus({status: 'renderer-initialization-failed'}));
  });
});
app.once('will-quit', () => { vocabulary.dispose(); notifications.dispose(); cache.close(); recordStatus({status: 'stopped'}); flushStatus(); });
recordStatus({notification: notifications.status()});
// Exercise the shipped Electron/preload/renderer bridge without account onboarding.
if (smokeDirectory) app.whenReady().then(() => {
  const file = path.join(smokeDirectory, 'smoke.html');
  fs.writeFileSync(file, '<!doctype html><html><body><aside><div data-app-action-sidebar-thread-row data-app-action-sidebar-thread-id="labels-smoke" data-app-action-sidebar-thread-host-id="local" data-app-action-sidebar-thread-title="Smoke"><span>Smoke</span></div></aside><main></main></body></html>');
  const window = new BrowserWindow({show: false, webPreferences: {
    preload: preloadPath, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false
  }});
  window.loadFile(file).catch(() => app.exit(1));
});
