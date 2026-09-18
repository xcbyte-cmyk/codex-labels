'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {resolveAccount, disabledNotifications} = require('./account-profile.cjs');
function fixture(t, id = 'a'.repeat(32)) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'labels-account-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const directory = path.join(root, 'accounts', id); fs.mkdirSync(directory, {recursive: true});
  fs.writeFileSync(path.join(directory, 'account.json'), JSON.stringify({version:1, id, name:'회사 A'}));
  fs.mkdirSync(path.join(directory, 'codex-home'));
  fs.writeFileSync(path.join(directory, 'codex-home', 'config.toml'), 'cli_auth_credentials_store = "file"\nforced_login_method = "chatgpt"\n');
  return {root, id, directory};
}
test('account bootstrap isolates identity before upstream startup', t => {
  const {root, id, directory} = fixture(t);
  const env = {PATH:'keep', CODEX_HOME:'parent', CODEX_SQLITE_HOME:'parent', OPENAI_API_KEY:'secret',
    CODEX_APP_SERVER_WS_URL:'ws://parent', CODEX_ACCESS_TOKEN:'secret', CODEX_LABELS_LAUNCH_TOKEN:'token'};
  const result = resolveAccount(root, ['app', '--codex-labels-account='+id], env);
  assert.equal(result.directory, directory);
  assert.equal(env.CODEX_HOME, path.join(directory, 'codex-home'));
  assert.equal(env.CODEX_SQLITE_HOME, env.CODEX_HOME);
  assert.equal(env.CODEX_APP_SERVER_FORCE_CLI, '1');
  assert.equal(env.CODEX_LABELS_LAUNCH_TOKEN, 'token');
  assert.equal(env.OPENAI_API_KEY, undefined); assert.equal(env.CODEX_APP_SERVER_WS_URL, undefined);
  assert.equal(env.CODEX_ACCESS_TOKEN, undefined);
});
test('default bootstrap preserves the original profile and environment', () => {
  const env = {CODEX_HOME:'existing'};
  assert.equal(resolveAccount('unused', [], env), null);
  assert.deepEqual(env, {CODEX_HOME:'existing'});
});
test('invalid, duplicate, missing and mismatched account identity is rejected', t => {
  const {root, id} = fixture(t);
  for (const args of [['--codex-labels-account=../x'], ['--codex-labels-account='+id, '--codex-labels-account='+id]]) {
    assert.throws(() => resolveAccount(root, args, {}));
  }
  assert.throws(() => resolveAccount(root, [], {CODEX_LABELS_ACCOUNT_ID:id}));
  assert.throws(() => resolveAccount(root, ['--codex-labels-account='+id], {CODEX_LABELS_ACCOUNT_ID:'b'.repeat(32)}));
  assert.throws(() => resolveAccount(root, ['--codex-labels-account='+'b'.repeat(32)], {}));
});
test('account windows cannot register or route global notification activation', () => {
  const notifications = disabledNotifications();
  assert.equal(notifications.status().enabled, false);
  assert.equal(notifications.acknowledge(), false);
  assert.throws(() => notifications.notify({}), /지원하지/);
});
test('missing isolated credential configuration cannot fall back to OS credentials', t => {
  const {root,id,directory} = fixture(t);
  fs.unlinkSync(path.join(directory,'codex-home','config.toml'));
  assert.throws(() => resolveAccount(root,['--codex-labels-account='+id],{}));
  fs.writeFileSync(path.join(directory,'codex-home','config.toml'),'cli_auth_credentials_store = "auto"\nforced_login_method = "chatgpt"\n');
  assert.throws(() => resolveAccount(root,['--codex-labels-account='+id],{}), /로그인 저장소/);
});
