'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFile} = require('node:child_process');
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
  return {currentVersion: result.latestVersion, latestVersion: result.latestVersion, available: false, pendingRestart: true};
}

function createUpdater(root, {execute = execFile, install = installStaged} = {}) {
  root = path.resolve(root);
  let active = null;
  function run(action) {
    if (active) return Promise.reject(Error('업데이트 확인 또는 다운로드가 진행 중입니다.'));
    const helper = path.join(root, 'CodexLabelsHelper.exe');
    const env = {...process.env, PYINSTALLER_RESET_ENVIRONMENT: '1'};
    for (const name of Object.keys(env)) if (name.startsWith('_PYI_')) delete env[name];
    active = new Promise((resolve, reject) => {
      execute(helper, [action, '--root', root], {windowsHide: true, timeout: 180000, maxBuffer: 65536, encoding: 'utf8', env}, (error, stdout) => {
        if (error) return reject(Error(String(stdout || '업데이트 도구를 실행하지 못했습니다. 설치 상태와 네트워크를 확인해 주세요.').trim().slice(-1000)));
        try {
          const value = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
          resolve(action === 'update-stage' ? install(root, value) : value);
        } catch (failure) { reject(failure); }
      });
    }).finally(() => { active = null; });
    return active;
  }
  return {check: () => run('update-check'), stage: () => run('update-stage')};
}
module.exports = {createUpdater, installStaged};
