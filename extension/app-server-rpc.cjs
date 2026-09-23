'use strict';
const {spawn} = require('node:child_process');
const {EventEmitter} = require('node:events');
const {createInterface} = require('node:readline');
const {mkdirSync} = require('node:fs');

// Dedicated stdio connection. Never attaches to the shared app-server daemon.
class AppServerRpc extends EventEmitter {
  constructor({executable, home, cwd, timeoutMs = 30000, spawnProcess = spawn}) {
    super();
    mkdirSync(home, {recursive: true});
    this.sequence = 0; this.pending = new Map(); this.timeoutMs = timeoutMs;
    this.closed = false; this.closing = false;
    const env = {...process.env};
    for (const key of Object.keys(env)) {
      if (/^(CODEX_|OPENAI_|AZURE_OPENAI_|CHATGPT_|ELECTRON_|_PYI_)/i.test(key) || ['NODE_OPTIONS', 'NODE_PATH'].includes(key)) delete env[key];
    }
    Object.assign(env, {CODEX_HOME: home, CODEX_SQLITE_HOME: home});
    this.process = spawnProcess(executable, ['app-server', '--stdio'], {cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
    this.exited = new Promise(resolve => {
      this.process.once('close', () => { this.closed = true; this.failPending(); this.emit('closed'); resolve(); });
      this.process.once('error', () => { this.closed = true; this.failPending(); this.emit('closed'); resolve(); });
    });
    // Auth/backend errors must never cross to UI or shared diagnostics.
    this.process.stderr.on('data', () => {});
    this.process.stdin.on('error', () => this.failPending());
    this.lines = createInterface({input: this.process.stdout});
    this.lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { this.failPending(); return; }
      if (message.method) {
        this.emit(Object.hasOwn(message, 'id') ? 'request' : 'notification', message);
        return;
      }
      const waiting = this.pending.get(message.id);
      if (!waiting) return;
      this.pending.delete(message.id); clearTimeout(waiting.timer);
      if (message.error) {
        const error = Error('앱 서버 요청을 완료하지 못했습니다.');
        error.code = 'APP_SERVER_RPC_FAILED'; error.rpcCode = message.error.code;
        waiting.reject(error);
      } else waiting.resolve(message.result);
    });
  }
  failPending() {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer); request.reject(Error('앱 서버 연결이 종료되었습니다.'));
    }
    this.pending.clear();
  }
  write(message) {
    if (this.closed || this.closing) throw Error('앱 서버 연결이 종료되었습니다.');
    this.process.stdin.write(JSON.stringify(message) + '\n');
  }
  call(method, params = {}) {
    if (this.closed || this.closing) return Promise.reject(Error('앱 서버 연결이 종료되었습니다.'));
    const id = `labels:${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = Error('앱 서버 응답 시간이 초과되었습니다.'); error.code = 'OUTCOME_UNKNOWN'; reject(error);
      }, this.timeoutMs);
      this.pending.set(id, {resolve, reject, timer});
      try { this.write({id, method, params}); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  async initialize() {
    const info = await this.call('initialize', {clientInfo: {name: 'codex_labels_session_router', version: '1'}, capabilities: {experimentalApi: true}});
    this.write({method: 'initialized'}); return info;
  }
  async close() {
    if (this.closed) return;
    if (!this.closing) { this.closing = true; this.process.stdin.end(); }
    let timer;
    try {
      await Promise.race([this.exited, new Promise((_, reject) => {timer = setTimeout(() => reject(Error('앱 서버 종료를 확인하지 못했습니다.')), 10000);})]);
    } finally { clearTimeout(timer); }
  }
}

module.exports = {AppServerRpc};
