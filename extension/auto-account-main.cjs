'use strict';
// Fixed launcher only. Never wraps spawn, stdin/stdout, or the Desktop protocol.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
function install({app, ipcMain, check, root, home, profile, profileId = null, enabled = true,
  spawnProcess = childProcess.spawn, platform = process.platform, local = process.env.LOCALAPPDATA,
  argv = process.argv}) {
  let running = null;
  function start(recovery = false) {
    if (!enabled || platform !== 'win32' || !local) throw Error('Windows 계정 전환기 실행 조건을 확인하세요.');
    if (running) return {opened: false, alreadyOpen: true};
    const helper = path.join(root, 'CodexLabelsHelper.exe');
    if (!fs.existsSync(helper)) throw Error('새 계정 전환 도구가 포함된 후보를 빌드하세요.');
    const args = ['auto-accounts', '--root', root, '--home', home, '--profile', profile,
      '--parent-pid', recovery ? '0' : String(process.pid)];
    if (profileId) args.push('--account-id', profileId);
    if (recovery) args.push('--recovery');
    const env = {...process.env};
    for (const key of Object.keys(env)) if (key.startsWith('_PYI') || key.startsWith('PYINSTALLER_')) delete env[key];
    env.PYINSTALLER_RESET_ENVIRONMENT = '1';
    const child = spawnProcess(helper, args, {cwd: root, env, shell: false, windowsHide: true,
      detached: true, stdio: ['ignore', 'pipe', 'ignore']});
    running = child;
    let buffer = '', quitRequested = false;
    child.stdout?.on('data', chunk => {
      buffer += chunk.toString('utf8');
      if (buffer.length > 2048) { buffer = ''; return; }
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
        if (line === 'CODEX_LABELS_AUTO_ACCOUNT_QUIT' && !recovery && !quitRequested) {
          quitRequested = true;
          // Native quit hooks/prompts remain in force. The helper waits for exit.
          app.quit();
        }
      }
    });
    child.once('error', () => { if (running === child) running = null; });
    child.once('close', () => { if (running === child) running = null; });
    child.unref?.();
    return {opened: true, logoutPerformed: false};
  }
  // A crashed credential transaction must not silently start a native model client.
  if (enabled && platform === 'win32' && local && fs.existsSync(home)) {
    const canonical = fs.realpathSync(home).replace(/\\/g, '/').toLowerCase();
    const key = crypto.createHash('sha256').update(canonical).digest('hex');
    const pending = path.join(local, 'CodexLabels', 'AutoAccounts', key, 'pending.dpapi');
    if (fs.existsSync(pending)) { start(true); app.exit(0); return {recoveryRequired: true}; }
  }
  ipcMain.handle('codex-labels:auto-accounts-open', event => { check(event); return start(false); });
  if (enabled && platform === 'win32') {
    const openRequested = args => Array.isArray(args) && args.includes('--codex-labels-open-accounts');
    const open = () => { try { start(false); } catch (error) { console.error('Account picker launch failed:', error.message); } };
    if (openRequested(argv)) app.once('ready', open);
    app.on('second-instance', (_event, args) => { if (openRequested(args)) open(); });
  }
  return {recoveryRequired: false};
}
module.exports = {install};
