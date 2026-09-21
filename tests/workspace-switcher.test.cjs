'use strict';
// Real JSON-lines streams around a deterministic local server double. No OpenAI calls.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {Writable, PassThrough} = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {WorkspaceGateway, SelectionStore, install} = require('../extension/session-switcher/index.cjs');
const {AppServerRpc, JsonLines} = require('../extension/session-switcher/rpc.cjs');
const {ProfileStore, DEFAULT_ID} = require('../extension/session-switcher/profiles.cjs');
const B = 'b'.repeat(32);
function token(account, user = 'user-' + account) {
  return 'e30.' + Buffer.from(JSON.stringify({exp: Math.floor(Date.now()/1000) + 86400,
    'https://api.openai.com/auth': {chatgpt_account_id: account, chatgpt_user_id: user, chatgpt_plan_type: 'plus'}})).toString('base64url') + '.fixture';
}
const principal = value => JSON.parse(Buffer.from(value.split('.')[1], 'base64url'))['https://api.openai.com/auth'].chatgpt_account_id;
const auth = (home, value) => { fs.mkdirSync(home, {recursive: true}); fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({tokens: {access_token: value}})); };
const tick = () => new Promise(resolve => setImmediate(resolve));
class Server extends EventEmitter {
  constructor(home, {count = 607, archived = 4} = {}) {
    super(); this.home = home; this.exitCode = null; this.calls = []; this.loaded = new Set(); this.counter = 0;
    this.value = JSON.parse(fs.readFileSync(path.join(home, 'auth.json'))).tokens.access_token;
    this.rowsFile = path.join(home, 'local-catalog.json');
    if (!fs.existsSync(this.rowsFile)) fs.writeFileSync(this.rowsFile, JSON.stringify(Array.from({length: count + archived}, (_, i) => ({
      id: 'thread-' + i, name: '대화 ' + i, path: path.join(home, 'sessions', i + '.jsonl'), cwd: '/project', archived: i >= count,
      status: {type: 'notLoaded'}, turns: []}))));
    this.rows = JSON.parse(fs.readFileSync(this.rowsFile)); this.stdout = new PassThrough();
    const parser = new JsonLines(m => { this.receive(m).catch(e => this.send({id: m.id, error: {code: -32600, message: e.message}})); }, () => this.kill());
    this.stdin = new Writable({write: (c, _e, done) => { parser.write(c); done(); }, final: done => { this.kill(); done(); }});
    this.stderr = new PassThrough(); this.stdio = [this.stdin, this.stdout, this.stderr]; this.nativeOut = this.stdout;
    this.background = false; this.pageLoop = false; this.loginWait = null;
  }
  send(m) { this.nativeOut.write(JSON.stringify(m) + '\n'); }
  notify(method, params) { this.send({method, params}); }
  kill() { if (this.exitCode !== null) return; this.exitCode = 0; this.emit('exit', 0); this.nativeOut.end(); }
  async receive(m) {
    if (!m.method) return;
    if (m.id === undefined) return;
    this.calls.push({method: m.method, params: m.params});
    const p = m.params || {}, row = this.rows.find(r => r.id === p.threadId); let result;
    switch (m.method) {
      case 'initialize': result = {userAgent: 'stream-double'}; break;
      case 'account/read': result = {account: this.value ? {type: 'chatgpt', email: 'fixture@example.invalid'} : null}; break;
      case 'getAuthStatus': result = {authToken: this.value}; break;
      case 'account/rateLimits/read':
        if (!this.value || (this.rejectB && principal(this.value) === 'B')) throw Error('SECRET-AUTH-ERROR');
        result = {rateLimits: {primary: {usedPercent: principal(this.value) === 'A' ? 10 : 20}}}; break;
      case 'account/login/start':
        if (this.loginWait && principal(p.accessToken) === 'B') await this.loginWait;
        this.value = this.wrongIdentity && principal(p.accessToken) === 'B' ? token('C') : p.accessToken;
        if (p.type === 'chatgpt') auth(this.home, p.accessToken);
        this.notify('account/login/completed', {success: true, loginId: null});
        this.notify('account/updated', {authMode: 'chatgptAuthTokens'});
        result = {type: p.type}; break;
      case 'account/logout': this.value = null; this.notify('account/updated', {authMode: null}); result = {}; break;
      case 'account/login/cancel': result = {}; break;
      case 'thread/list': {
        let rows = this.rows.filter(r => r.archived === !!p.archived);
        if (p.searchTerm) rows = rows.filter(r => r.name.includes(p.searchTerm));
        if (this.hideOnB && this.value && principal(this.value) === 'B') rows = rows.slice(1);
        const at = Number(p.cursor || 0), end = at + (p.limit || 100);
        result = {data: rows.slice(at, end), nextCursor: this.pageLoop ? 'repeat' : end < rows.length ? String(end) : null}; break;
      }
      case 'thread/loaded/list': result = {data: [...this.loaded], nextCursor: null}; break;
      case 'thread/backgroundTerminals/list': result = {data: this.background ? [{id: 'still-running'}] : [], nextCursor: this.terminalCursor || null}; break;
      case 'thread/read': if (!row) throw Error('missing'); result = {thread: row}; break;
      case 'thread/resume':
        if (!row) throw Error('missing'); this.loaded.add(row.id); row.status = {type: 'idle'};
        result = {thread: row}; break;
      case 'turn/start': {
        if (!row) throw Error('missing'); const id = 'turn-' + (++this.counter);
        this.loaded.add(row.id); row.status = {type: 'active'}; row.turns.push({id, status: 'inProgress'});
        result = {turn: {id, status: 'inProgress', account: principal(this.value)}};
        this.send({id: m.id, result});
        if (!this.delayTurnEvent) this.notify('turn/started', {threadId: row.id, turn: result.turn});
        return;
      }
      case 'turn/interrupt': {
        for (const turn of row.turns) if (turn.status === 'inProgress') {
          turn.status = 'completed'; row.status = {type: 'idle'};
          this.notify('thread/status/changed', {threadId: row.id, status: row.status});
          this.notify('turn/completed', {threadId: row.id, turn});
        }
        result = {}; break;
      }
      default: result = {ok: true};
    }
    this.send({id: m.id, result});
  }
}
async function setup(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'labels-workspace-'));
  const home = path.join(root, 'custom-home'), accountsDirectory = path.join(root, 'accounts'), storageDirectory = path.join(root, 'selection');
  auth(home, token('A')); auth(path.join(accountsDirectory, B, 'codex-home'), token('B'));
  fs.writeFileSync(path.join(accountsDirectory, B, 'account.json'), JSON.stringify({id: B, name: '계정 B'}));
  const profiles = new ProfileStore({accountsDirectory, defaultHome: home});
  const clients = [], gateways = [];
  async function start() {
    const server = new Server(home, options);
    const gateway = new WorkspaceGateway({child: server, home, profiles, storageDirectory, rpcOptions: {timeoutMs: 1000}});
    const client = new AppServerRpc(server, {timeoutMs: 1500});
    clients.push(client); gateways.push(gateway); await client.initialize(); await gateway.bootstrap();
    return {server, gateway, client};
  }
  const first = await start();
  t.after(async () => { for (const g of gateways) await g.dispose().catch(() => {}); for (const c of clients) await c.close().catch(() => {}); fs.rmSync(root, {recursive: true, force: true}); });
  return {...first, home, root, profiles, storageDirectory, start};
}
const switchB = gateway => gateway.switchAccount(B, {confirmContextTransfer: true});
test('whole workspace: >500 unopened plus archived conversations survive A -> B; no history/auth file writes', async t => {
  const h = await setup(t), original = fs.readFileSync(h.server.rowsFile), oldAuth = fs.readFileSync(path.join(h.home, 'auth.json'));
  const originalInput = h.server.stdin; const before = await h.client.call('thread/list', {limit: 7, cursor: '600'});
  const result = await switchB(h.gateway);
  assert.equal(result.state.localConversationCount, 611); assert.equal(result.state.scope, 'workspace');
  assert.equal(result.state.workspaceHome, fs.realpathSync(h.home)); assert.equal(h.server.stdin, originalInput);
  assert.deepEqual(await h.client.call('thread/list', {limit: 7, cursor: '600'}), before);
  assert.deepEqual(fs.readFileSync(h.server.rowsFile), original); assert.deepEqual(fs.readFileSync(path.join(h.home, 'auth.json')), oldAuth);
  assert.ok(h.server.calls.some(c => c.method === 'thread/list' && c.params.cursor === '600'));
  assert.equal(h.server.calls.some(c => ['turn/start', 'thread/resume', 'thread/unsubscribe'].includes(c.method)), false);
  assert.equal(h.gateway.snapshot().activeProfile.id, B);
});
test('all subsequent conversations use B, not just a selected thread; native list filters are untouched', async t => {
  const h = await setup(t); await switchB(h.gateway);
  for (const threadId of ['thread-0', 'thread-602']) {
    await h.client.call('thread/resume', {threadId});
    const r = await h.client.call('turn/start', {threadId, input: []}); assert.equal(r.turn.account, 'B');
    await h.client.call('turn/interrupt', {threadId});
  }
  const r = await h.client.call('thread/list', {searchTerm: '607', archived: true, limit: 1});
  assert.equal(r.data.length, 1); assert.equal(r.data[0].id, 'thread-607');
});
test('requires explicit workspace consent and does not send login on refusal', async t => {
  const h = await setup(t); await assert.rejects(h.gateway.switchAccount(B), {code: 'CONSENT_REQUIRED'});
  assert.equal(h.server.calls.some(c => c.method === 'account/login/start'), false);
});
test('switch blocked by an active OTHER thread including response-before-notification gap', async t => {
  const h = await setup(t); h.server.delayTurnEvent = true;
  await h.client.call('turn/start', {threadId: 'thread-603', input: []});
  await assert.rejects(switchB(h.gateway), {code: 'BUSY'});
  await h.client.call('turn/interrupt', {threadId: 'thread-603'}); await switchB(h.gateway);
});
test('background terminal and unknown terminal pagination fail closed', async t => {
  const h = await setup(t); await h.client.call('thread/resume', {threadId: 'thread-1'}); h.server.background = true;
  await assert.rejects(switchB(h.gateway), {code: 'BUSY'});
  h.server.background = false; h.server.terminalCursor = 'more';
  await assert.rejects(switchB(h.gateway), {code: 'UNSUPPORTED'});
  assert.equal(principal(h.server.value), 'A');
});
test('pending server approval blocks switching', async t => {
  const h = await setup(t); h.server.send({id: 12, method: 'item/commandExecution/requestApproval', params: {threadId: 'thread-600'}});
  await assert.rejects(switchB(h.gateway), {code: 'BUSY'});
  h.client.respond(12, {result: {decision: 'decline'}}); await tick();
  await switchB(h.gateway);
});
test('online rejection rolls back A and never replays model work', async t => {
  const h = await setup(t); h.server.rejectB = true;
  await assert.rejects(switchB(h.gateway)); assert.equal(principal(h.server.value), 'A');
  assert.equal(h.gateway.snapshot().activeProfile.id, DEFAULT_ID); assert.equal(h.gateway.phase, 'idle');
  assert.equal(h.server.calls.some(c => c.method === 'turn/start'), false);
});
test('wrong live target principal blocks even when credential file is valid', async t => {
  const h = await setup(t); h.server.wrongIdentity = true;
  await assert.rejects(switchB(h.gateway), {code: 'IDENTITY_MISMATCH'});
  assert.equal(principal(h.server.value), 'A'); assert.equal(h.gateway.phase, 'blocked');
});
test('catalog loss during authentication rolls back instead of declaring success', async t => {
  const h = await setup(t); h.server.hideOnB = true;
  await assert.rejects(switchB(h.gateway), {code: 'CHECKPOINT_INVALID'});
  assert.equal(principal(h.server.value), 'A'); assert.equal(h.gateway.phase, 'idle');
});
test('repeated catalog cursor is an error, not silent truncation', async t => {
  const h = await setup(t); h.server.pageLoop = true;
  await assert.rejects(switchB(h.gateway), {code: 'PROTOCOL_ERROR'});
  assert.equal(h.server.calls.some(c => c.method === 'account/login/start'), false);
});
test('cancellation after auth begins restores A; concurrent switch and turns are denied', async t => {
  const h = await setup(t); let release; h.server.loginWait = new Promise(r => { release = r; });
  const changing = switchB(h.gateway); const rejected = assert.rejects(changing, {code: 'CANCELLED'});
  while (!h.server.calls.some(c => c.method === 'account/login/start')) await tick();
  await assert.rejects(switchB(h.gateway), {code: 'BUSY'});
  const blocked = await h.client.exchange('turn/start', {threadId: 'thread-2'}); assert.match(blocked.error.message, /BUSY/);
  assert.equal(h.gateway.cancel(), true); release(); await rejected;
  assert.equal(principal(h.server.value), 'A'); assert.equal(h.gateway.phase, 'idle');
});
test('restart reapplies B before native model requests; all catalog pages remain available', async t => {
  const h = await setup(t); await switchB(h.gateway); await h.gateway.dispose();
  const next = await h.start(); assert.equal(next.gateway.phase, 'idle'); assert.equal(principal(next.server.value), 'B');
  const r = await next.client.call('turn/start', {threadId: 'thread-604', input: []}); assert.equal(r.turn.account, 'B');
  const page = await next.client.call('thread/list', {limit: 10, cursor: '600'}); assert.equal(page.data.length, 7);
});
test('missing remembered credentials block model requests, not local history browsing', async t => {
  const h = await setup(t); await switchB(h.gateway); await h.gateway.dispose();
  fs.rmSync(path.join(h.profiles.resolve(B).home, 'auth.json'));
  const next = await h.start(); assert.equal(next.gateway.phase, 'blocked');
  assert.equal((await next.client.call('thread/list', {limit: 100})).data.length, 100);
  assert.ok((await next.client.exchange('turn/start', {threadId: 'thread-0'})).error);
  assert.equal(next.server.calls.some(c => c.method === 'turn/start'), false);
});
test('pending durable transaction requires explicit recovery, then authenticates recorded target', async t => {
  const h = await setup(t); await h.gateway.dispose();
  new SelectionStore(h.storageDirectory, h.home).write('pending', h.profiles.pin(B));
  const next = await h.start(); assert.equal(next.gateway.phase, 'blocked');
  await assert.rejects(next.gateway.recover(), {code: 'CONSENT_REQUIRED'});
  await next.gateway.recover({confirmContextTransfer: true});
  assert.equal(principal(next.server.value), 'B'); assert.equal(next.gateway.phase, 'idle');
});
test('native logout/login preserves local catalog and requires consent before using new account', async t => {
  const h = await setup(t); const before = fs.readFileSync(h.server.rowsFile);
  await h.client.call('account/logout'); assert.equal(h.gateway.phase, 'blocked');
  assert.equal((await h.client.call('thread/list', {limit: 10, cursor: '600'})).data.length, 7);
  await h.client.call('account/login/start', {type: 'chatgpt', accessToken: token('B')});
  const denied = await h.client.exchange('turn/start', {threadId: 'thread-0'}); assert.ok(denied.error);
  await h.gateway.recover({confirmContextTransfer: true});
  assert.equal((await h.client.call('turn/start', {threadId: 'thread-0'})).turn.account, 'B');
  assert.deepEqual(fs.readFileSync(h.server.rowsFile), before);
});
test('live identity drift blocks requests before they reach a model', async t => {
  const h = await setup(t); await switchB(h.gateway); h.server.value = token('C');
  assert.match((await h.client.exchange('turn/start', {threadId: 'thread-0'})).error.message, /IDENTITY_MISMATCH/);
  assert.equal(h.server.calls.some(c => c.method === 'turn/start'), false); assert.equal(h.gateway.phase, 'blocked');
});
test('token refresh is pinned; wrong previous account never receives another token', async t => {
  const h = await setup(t); await switchB(h.gateway);
  h.server.send({id: 90, method: 'account/chatgptAuthTokens/refresh', params: {previousAccountId: 'C'}});
  await tick(); assert.equal(h.gateway.phase, 'blocked'); assert.equal(h.client.serverRequests.size, 0);
});
test('journal contains no tokens or conversation text and pins the canonical workspace', async t => {
  const h = await setup(t); await switchB(h.gateway);
  const text = fs.readFileSync(path.join(h.storageDirectory, 'workspace-account.json'), 'utf8');
  assert.equal(text.includes('.fixture'), false); assert.equal(text.includes('대화 0'), false);
  assert.throws(() => new SelectionStore(h.storageDirectory, h.profiles.resolve(B).home).read(), {code: 'RECOVERY_REQUIRED'});
});
test('legacy nonempty routes are retained and never silently migrate to stale original histories', async t => {
  const h = await setup(t); await h.gateway.dispose(); fs.mkdirSync(h.storageDirectory, {recursive: true});
  const legacy = JSON.stringify({version: 1, routes: [{threadId: 'previous-experimental-thread'}]});
  fs.writeFileSync(path.join(h.storageDirectory, 'routes.json'), legacy);
  const next = await h.start(); assert.equal(next.gateway.phase, 'blocked');
  await assert.rejects(next.gateway.recover({confirmContextTransfer: true}), {code: 'RECOVERY_REQUIRED'});
  assert.equal(fs.readFileSync(path.join(h.storageDirectory, 'routes.json'), 'utf8'), legacy);
});
test('corrupt journal does not hide native local catalog and cannot be overwritten by native login', async t => {
  const h = await setup(t); await h.gateway.dispose(); fs.mkdirSync(h.storageDirectory, {recursive: true});
  fs.writeFileSync(path.join(h.storageDirectory, 'workspace-account.json'), '{broken');
  const next = await h.start(); assert.equal(next.gateway.phase, 'blocked');
  assert.ok((await next.client.call('thread/list')).data.length);
  assert.ok((await next.client.exchange('account/login/start', {type: 'chatgpt', accessToken: token('B')})).error);
  assert.equal(fs.readFileSync(path.join(h.storageDirectory, 'workspace-account.json'), 'utf8'), '{broken');
});
test('selection commit failure rolls back authentication; rollback failure keeps a blocked durable intent', async t => {
  const h = await setup(t); const write = h.gateway.selection.write.bind(h.gateway.selection);
  h.gateway.selection.write = (status, profile) => { if (status === 'selected') throw Error('write failed'); return write(status, profile); };
  await assert.rejects(switchB(h.gateway)); assert.equal(principal(h.server.value), 'A'); assert.equal(h.gateway.phase, 'idle');
  h.gateway.selection.restore = () => { throw Error('rollback failed'); };
  await assert.rejects(switchB(h.gateway)); assert.equal(h.gateway.phase, 'blocked');
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.storageDirectory, 'workspace-account.json'))).status, 'pending');
});
test('IPC is fixed-scope, rejects foreign frames and old per-thread payloads; errors are sanitized', async t => {
  const app = new EventEmitter(), handlers = new Map();
  const instance = install({app, ipcMain: {handle: (name, handler) => handlers.set(name, handler)},
    BrowserWindow: {getAllWindows: () => []}, check: event => { if (!event.trusted) throw Error('untrusted'); },
    trustedContent: () => false, executable: process.execPath, accountsDirectory: os.tmpdir(), defaultHome: os.tmpdir(), storageDirectory: os.tmpdir(), enabled: false});
  t.after(() => instance.dispose());
  for (const handler of handlers.values()) await assert.rejects(handler({}, {}), /untrusted/);
  const r = await handlers.get('codex-labels:session-switcher-switch')({trusted: true}, {threadId: 'old', profileId: B});
  assert.equal(r.error.code, 'INVALID_ARGUMENT');
  const status = await handlers.get('codex-labels:session-switcher-status')({trusted: true});
  assert.equal(status.value.scope, 'workspace'); assert.equal(status.value.attached, false);
});

test('native account changes cannot bypass context consent by restarting the app', async t => {
  const h = await setup(t);
  await h.client.call('account/logout');
  await h.client.call('account/login/start', {type: 'chatgpt', accessToken: token('B')});
  assert.equal(h.gateway.phase, 'blocked');
  await h.gateway.dispose();
  const next = await h.start();
  assert.equal(next.gateway.phase, 'blocked');
  assert.ok((await next.client.call('thread/list', {limit: 7, cursor: '600'})).data.length);
  assert.ok((await next.client.exchange('turn/start', {threadId: 'thread-1', input: []})).error);
  assert.equal(next.server.calls.some(c => c.method === 'turn/start'), false);
  await next.gateway.recover({confirmContextTransfer: true});
  assert.equal((await next.client.call('turn/start', {threadId: 'thread-1', input: []})).turn.account, 'B');
  await next.client.call('turn/interrupt', {threadId: 'thread-1'});
});
test('disposed gateways never accept a new switch, recovery or usage request', async t => {
  const h = await setup(t); await h.gateway.dispose(); const count = h.server.calls.length;
  await assert.rejects(switchB(h.gateway), {code: 'RPC_CLOSED'});
  await assert.rejects(h.gateway.recover({confirmContextTransfer: true}), {code: 'RPC_CLOSED'});
  await assert.rejects(h.gateway.usage(), {code: 'RPC_CLOSED'});
  assert.equal(h.server.calls.length, count);
});
