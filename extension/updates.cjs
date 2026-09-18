'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFile, spawn} = require('node:child_process');
const FILES = ['build-info.json', 'CodexLabelsHelper.exe'];
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function installStaged(root, result, io = fs) {
  if (!result.available || !result.stagedDirectory) return result;
  if (!/^stage-[a-zA-Z0-9_-]+$/.test(result.stagedDirectory)) throw Error('Invalid update staging directory');
  const directory = path.join(root, '.updates', result.stagedDirectory);
  for (const target of [root, path.join(root, '.updates'), directory]) {
    if (io.lstatSync(target).isSymbolicLink()) throw Error('Linked update directories are not allowed');
  }
  const bytes = new Map();
  for (const name of FILES) {
    const target = path.join(directory, name);
    if (!io.lstatSync(target).isFile() || io.statSync(target).size > 80 * 1024 * 1024) throw Error('Invalid staged file');
    const data = io.readFileSync(target);
    if (hash(data) !== result.hashes?.[name]) throw Error('업데이트 파일이 변경되었습니다. 다시 다운로드해 주세요.');
    bytes.set(name, data);
    const destination = path.join(root, name);
    if (io.existsSync(destination) && !io.lstatSync(destination).isFile()) throw Error('Invalid update destination');
  }
  const backup = path.join(directory, 'previous'); io.mkdirSync(backup);
  const existed = new Set(), replaced = [];
  try {
    for (const name of FILES) {
      const target = path.join(root, name);
      if (io.existsSync(target)) { io.copyFileSync(target, path.join(backup, name)); existed.add(name); }
    }
    // Install metadata first and the executable last. User configs/runtime are
    // never part of the transaction. Keep the previous helper for recovery.
    for (const name of FILES) {
      const temporary = path.join(root, name + '.update-' + crypto.randomUUID());
      try { io.writeFileSync(temporary, bytes.get(name)); io.renameSync(temporary, path.join(root, name)); replaced.push(name); }
      finally { try { io.unlinkSync(temporary); } catch {} }
    }
  } catch (error) {
    for (const name of replaced.reverse()) {
      if (existed.has(name)) io.copyFileSync(path.join(backup, name), path.join(root, name));
      else io.unlinkSync(path.join(root, name));
    }
    throw error;
  }
  return {downloadedVersion: result.latestVersion, latestVersion: result.latestVersion, available: false, pendingRestart: true};
}

function createUpdater(root, {execute = execFile, install = installStaged, start = spawn, quit = () => {}, ackTimeout = 15000} = {}) {
  root = path.resolve(root);
  let active = null;
  let checkedRelease = null;
  let originalStatus;
  let runningVersion = null;
  try { runningVersion = JSON.parse(fs.readFileSync(path.join(root, 'runtime/app/codex-labels-build.json'), 'utf8')).helperVersion || null; } catch {}
  const decorate = value => ({...value, currentVersion: runningVersion ?? value.currentVersion ?? null,
    pendingRestart: !value.updateBlocked && (!!value.pendingRestart || !!(runningVersion && value.downloadedVersion && value.downloadedVersion !== runningVersion))});
  function environment() {
    const env = {...process.env, PYINSTALLER_RESET_ENVIRONMENT: '1'};
    for (const name of Object.keys(env)) if (name.startsWith('_PYI_')) delete env[name];
    return env;
  }
  function prime() {
    if (!originalStatus) originalStatus = new Promise(resolve => {
      execute(path.join(root, 'CodexLabelsHelper.exe'), ['codex-status', '--root', root],
        {windowsHide:true, timeout:15000, maxBuffer:16384, encoding:'utf8', env:environment()}, (error, stdout) => {
          try { if (error) throw error; resolve(JSON.parse(stdout.trim().split(/\r?\n/).at(-1))); }
          catch { resolve({state:'unavailable'}); }
        });
    });
    return originalStatus;
  }
  async function withOriginal(action) {
    const [value, codex] = await Promise.all([run(action), prime()]);
    return {...value, codex};
  }
  function run(action) {
    if (active) return Promise.reject(Error('업데이트 확인 또는 다운로드가 진행 중입니다.'));
    const helper = path.join(root, 'CodexLabelsHelper.exe');
    const env = environment();
    active = new Promise((resolve, reject) => {
      execute(helper, [action, '--root', root], {windowsHide: true, timeout: 180000, maxBuffer: 65536, encoding: 'utf8', env}, (error, stdout) => {
        if (error) return reject(Error(String(stdout || '업데이트 도구를 실행하지 못했습니다. 설치 상태와 네트워크를 확인해 주세요.').trim().slice(-1000)));
        try {
          let value = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
          if (action === 'update-stage') value = install(root, value);
          if (action !== 'update-status' && typeof value.latestVersion === 'string') {
            checkedRelease = {latestVersion: value.latestVersion, available: !!value.available};
          }
          if (action === 'update-status' && checkedRelease) {
            value = {...checkedRelease, ...value,
              available: checkedRelease.available && value.downloadedVersion !== checkedRelease.latestVersion};
          }
          resolve(decorate(value));
        } catch (failure) { reject(failure); }
      });
    }).finally(() => { active = null; });
    return active;
  }
  async function restart(rollback = false) {
    const state = await run('update-status');
    if (rollback ? !state.rollbackAvailable : !state.pendingRestart) throw Error(rollback ? '복구할 이전 버전이 없습니다.' : '설치할 업데이트가 없습니다.');
    active = new Promise((resolve, reject) => {
      const token = crypto.randomBytes(16).toString('hex');
      const directory = path.join(root, '.restarts');
      if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) return reject(Error('Invalid restart directory'));
      fs.mkdirSync(directory, {recursive:true});
      const acknowledgement = path.join(directory, token + '.json');
      const child = start(path.join(root, 'CodexLabelsHelper.exe'), [rollback ? 'rollback' : 'launch', '--root', root, '--wait-pid', String(process.pid), '--restart-token', token],
        {detached:true, stdio:'ignore', windowsHide:true, env:environment()});
      child.unref();
      const deadline = Date.now() + ackTimeout;
      let finished = false, timer;
      const fail = error => {
        if (finished) return; finished = true; clearTimeout(timer);
        try { fs.writeFileSync(path.join(directory, token + '.cancel'), 'cancelled'); } catch {}
        reject(error);
      };
      child.once('error', () => fail(Error('설치 도구를 시작하지 못했습니다. 현재 앱은 계속 사용할 수 있습니다.')));
      function poll() {
        if (finished) return;
        try {
          const ack = JSON.parse(fs.readFileSync(acknowledgement, 'utf8'));
          if (ack.ready === true && ack.token === token && Number.isSafeInteger(ack.processId)) {
            finished = true;
            try { fs.unlinkSync(acknowledgement); } catch {}
            resolve({restarting:true});
            // Reply first. Shutdown occurs only after the external worker has
            // opened the exact current Labels process handle and is waiting.
            setTimeout(quit, 250);
            return;
          }
        } catch {}
        if (Date.now() >= deadline) return fail(Error('설치 도구의 준비를 확인하지 못했습니다. 앱을 종료하지 않았습니다. 다시 시도해 주세요.'));
        timer = setTimeout(poll, 100);
      }
      poll();
    }).finally(() => { active = null; });
    return active;
  }
  return {check: () => withOriginal('update-check'), stage: () => withOriginal('update-stage'), status: () => withOriginal('update-status'), prime, restart, rollback: () => restart(true)};
}
module.exports = {createUpdater, installStaged};
