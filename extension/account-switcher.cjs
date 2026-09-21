'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');

const ID = /^[0-9a-f]{32}$/;

function createAccountSwitcher({root, currentAccount, BrowserWindow, helperPath, localAppData, spawnProcess = spawn}) {
  let switching = false;
  function accountRoot() {
    if (!localAppData || !path.isAbsolute(localAppData)) throw Error('계정 저장소 경로를 확인할 수 없습니다.');
    return path.join(fs.realpathSync(localAppData), 'CodexLabels', 'AccountWindows');
  }
  function list() {
    const accounts = [{id: 'default', name: '현재 계정 · 기본 프로필', current: !currentAccount}];
    const directory = path.join(accountRoot(), 'accounts');
    if (!fs.existsSync(directory)) return {accounts, currentId: currentAccount?.id || 'default', switching};
    for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
      if (!entry.isDirectory() || !ID.test(entry.name)) continue;
      const folder = path.join(directory, entry.name);
      if (fs.lstatSync(folder).isSymbolicLink() || fs.existsSync(path.join(directory, `.delete-${entry.name}.json`))) continue;
      try {
        const value = JSON.parse(fs.readFileSync(path.join(folder, 'account.json'), 'utf8'));
        if (value.version !== 1 || value.id !== entry.name || typeof value.name !== 'string' ||
            !value.name.trim() || value.name.length > 40 || /[\x00-\x1f]/.test(value.name)) continue;
        accounts.push({id: value.id, name: value.name, current: value.id === currentAccount?.id});
      } catch { /* A damaged profile is omitted rather than exposed to the renderer. */ }
    }
    return {accounts, currentId: currentAccount?.id || 'default', switching};
  }
  function run(args) {
    return new Promise((resolve, reject) => {
      let output = '', errorOutput = '';
      const child = spawnProcess(helperPath, args, {cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
      child.once('error', reject);
      child.stdout?.on('data', chunk => { if (output.length < 65536) output += chunk; });
      child.stderr?.on('data', chunk => { if (errorOutput.length < 4096) errorOutput += chunk; });
      child.once('close', code => code === 0 ? resolve(output) : reject(Error(errorOutput.trim() || '대상 계정 창을 열지 못했습니다.')));
    });
  }
  async function switchTo(event, id) {
    if (switching) throw Error('계정 창을 전환하고 있습니다.');
    if (id !== 'default' && !ID.test(id)) throw Error('계정 창을 다시 선택해 주세요.');
    const state = list();
    if (!state.accounts.some(account => account.id === id)) throw Error('선택한 계정 창을 찾지 못했습니다.');
    if (id === state.currentId) return {changed: false, currentId: id};
    if (!fs.existsSync(helperPath)) throw Error('계정 실행 도구를 찾지 못했습니다. Labels를 다시 설치해 주세요.');
    switching = true;
    try {
      const args = id === 'default'
        ? ['launch-direct', '--root', root]
        : ['account-launch', '--root', root, '--account-id', id];
      await run(args);
      const window = BrowserWindow.fromWebContents(event.sender);
      if (window && !window.isDestroyed()) window.hide();
      return {changed: true, currentId: id};
    } finally { switching = false; }
  }
  return {list, switchTo};
}

module.exports = {createAccountSwitcher};
