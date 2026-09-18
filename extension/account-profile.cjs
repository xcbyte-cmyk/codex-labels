'use strict';
const fs = require('node:fs');
const path = require('node:path');

function resolveAccount(root, argv = process.argv, env = process.env) {
  const protocols = argv.filter(arg => arg.startsWith('--codex-labels-account-protocol'));
  if (protocols.length && (protocols.length !== 1 || protocols[0] !== '--codex-labels-account-protocol=1')) throw Error('지원하지 않는 계정 연결 규칙입니다.');
  if (protocols.length) {
    if (!env.LOCALAPPDATA || !path.isAbsolute(env.LOCALAPPDATA)) throw Error('계정 저장소 경로가 없습니다.');
    root = path.join(fs.realpathSync(env.LOCALAPPDATA), 'CodexLabels', 'AccountWindows');
  }
  if (argv.some(arg => arg.startsWith('--codex-labels-account') && !arg.startsWith('--codex-labels-account=') && arg !== '--codex-labels-account-protocol=1')) throw Error('계정 실행 인자를 확인하세요.');
  const args = (argv || []).filter(arg => arg.startsWith('--codex-labels-account='));
  if (!args.length && !env.CODEX_LABELS_ACCOUNT_ID && !protocols.length) return null;
  if (args.length !== 1) throw Error('계정 창은 계정별 실행 도구로 열어 주세요.');
  const id = args[0].split('=')[1];
  if (!/^[0-9a-f]{32}$/.test(id) || env.CODEX_LABELS_ACCOUNT_ID && env.CODEX_LABELS_ACCOUNT_ID !== id) {
    throw Error('계정 창 ID가 일치하지 않습니다.');
  }
  const directory = path.join(root, 'accounts', id);
  for (const target of [root, path.join(root, 'accounts'), directory]) {
    if (fs.lstatSync(target).isSymbolicLink()) throw Error('계정 폴더 연결은 지원하지 않습니다.');
  }
  if (fs.existsSync(path.join(root, 'accounts', '.delete-' + id + '.json'))) throw Error('삭제 중인 계정입니다.');
  const data = JSON.parse(fs.readFileSync(path.join(directory, 'account.json'), 'utf8'));
  if (data.version !== 1 || data.id !== id || typeof data.name !== 'string' || !data.name.trim() || data.name.length > 40 || /[\x00-\x1f]/.test(data.name)) {
    throw Error('계정 창 설정이 손상되었습니다.');
  }
  const home = path.join(directory, 'codex-home'), profile = path.join(directory, 'user-data');
  for (const target of [home, profile]) {
    fs.mkdirSync(target, {recursive: true});
    if (fs.lstatSync(target).isSymbolicLink()) throw Error('계정 저장소 연결은 지원하지 않습니다.');
  }
  // The helper validates the complete TOML. Direct executable launches must
  // also fail closed if the isolated login configuration is absent.
  const config = fs.readFileSync(path.join(home, 'config.toml'), 'utf8').split(/^\s*\[/m)[0];
  if (!/^cli_auth_credentials_store\s*=\s*"file"\s*$/m.test(config) ||
      !/^forced_login_method\s*=\s*"chatgpt"\s*$/m.test(config)) {
    throw Error('계정별 실행 도구에서 로그인 저장소 설정을 확인하세요.');
  }
  for (const key of Object.keys(env)) {
    if (['NODE_OPTIONS', 'NODE_PATH'].includes(key.toUpperCase())) delete env[key];
    if (/^(CODEX_|OPENAI_|AZURE_OPENAI_|CHATGPT_|ELECTRON_)/i.test(key) && !['CODEX_LABELS_LAUNCH_TOKEN'].includes(key)) delete env[key];
  }
  Object.assign(env, {CODEX_HOME: home, CODEX_SQLITE_HOME: home, CODEX_ELECTRON_USER_DATA_PATH: profile,
    CODEX_APP_SERVER_FORCE_CLI: '1', CODEX_LABELS_ACCOUNT_ID: id});
  return {id, name: data.name, directory, home, profile, vocabularyVersion: data.vocabularyVersion === 2 ? 2 : 1};
}

function disabledNotifications() {
  return {status: () => ({enabled: false, nativeHook: false, lastResult: 'account-window-notifications-disabled'}),
    dispose() {}, disconnected() {}, rendererReady() {}, acknowledge() { return false; },
    notify() { throw Error('계정별 창에서는 Windows 알림 연결을 지원하지 않습니다.'); }};
}
module.exports = {resolveAccount, disabledNotifications};
