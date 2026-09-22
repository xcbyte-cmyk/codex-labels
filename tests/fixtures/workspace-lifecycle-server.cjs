'use strict';
// Real JSON-lines streams around a deterministic local server double. No OpenAI calls.
// Shared deterministic stdio fixture; no external services.
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {Writable, PassThrough} = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {WorkspaceGateway, SelectionStore, install} = require('../../extension/session-switcher/index.cjs');
const {AppServerRpc, JsonLines} = require('../../extension/session-switcher/rpc.cjs');
const {ProfileStore, DEFAULT_ID} = require('../../extension/session-switcher/profiles.cjs');
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

module.exports = {Server, token, principal, auth, tick, B};
