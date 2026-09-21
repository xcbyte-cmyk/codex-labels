'use strict';
// Experimental stdio child facade: keep Desktop's streams, replace only an idle backend.
const {EventEmitter} = require('node:events');
const {Writable, PassThrough} = require('node:stream');
const {StringDecoder} = require('node:string_decoder');
const {randomUUID, createHash} = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {failure} = require('./account-switch-profiles.cjs');
const key = id => `${typeof id}:${id}`;
const clone = value => JSON.parse(JSON.stringify(value));
const MAX_FRAME = 64 * 1024 * 1024;
function historyStamp(thread) {
  if (!Array.isArray(thread?.turns) || thread.turns.some(t => !t || typeof t.id !== 'string' || t.status === 'inProgress')) throw failure('UNSUPPORTED_SESSION');
  return createHash('sha256').update(JSON.stringify(thread.turns)).digest('hex');
}
const RESTORE_KEYS = ['model','modelProvider','cwd','approvalPolicy','sandbox','config','baseInstructions','developerInstructions','personality'];

class Backend {
  constructor(child, owner) {
    this.child = child; this.owner = owner; this.pending = new Map();
    this.prefix = `labels-${randomUUID()}:`; this.sequence = 0; this.closed = false;
    this.buffer = ''; this.decoder = new StringDecoder('utf8'); this.profileId = null;
    child.stdout.on('data', chunk => {
      this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
      if (Buffer.byteLength(this.buffer) > MAX_FRAME) { this.stop(); return; }
      let end;
      while ((end = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { owner.protocolFailure(this, line); continue; }
        if (!message || typeof message !== 'object' || Array.isArray(message)) { owner.protocolFailure(this, line); continue; }
        if (typeof message.id === 'string' && message.id.startsWith(this.prefix)) {
          const pending = this.pending.get(message.id);
          if (pending) {
            this.pending.delete(message.id); clearTimeout(pending.timer);
            if (message.error || !Object.hasOwn(message, 'result')) pending.reject(failure('BACKEND_REQUEST_FAILED'));
            else pending.resolve(message.result);
          }
          continue; // Late internal responses must not reach Desktop.
        }
        if (message.method === 'account/chatgptAuthTokens/refresh' && Object.hasOwn(message, 'id') && this.profileId) {
          this.refresh(message); continue;
        }
        owner.message(this, message);
      }
    });
    child.stderr?.on('data', chunk => { if (owner.backend === this) owner.stderr.write(chunk); });
    child.on('error', () => this.finish('BACKEND_EXITED'));
    child.on('close', (code, signal) => { this.finish('BACKEND_EXITED'); owner.backendClosed(this, code, signal); });
    child.stdin.on('error', () => this.finish('BACKEND_EXITED'));
  }
  send(message) {
    if (this.closed || this.child.stdin.destroyed) throw failure('BACKEND_EXITED');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  request(method, params = {}) {
    if (this.closed) return Promise.reject(failure('BACKEND_EXITED'));
    const id = this.prefix + (++this.sequence);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(failure('BACKEND_TIMEOUT')); }, this.owner.timeout);
      this.pending.set(id, {resolve, reject, timer});
      try { this.send({id, method, params}); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  refresh(message) {
    try {
      const c = this.owner.credential(this.profileId);
      if (c.identity !== this.identity || message.params?.previousAccountId !== c.chatgptAccountId) throw failure('SIGN_IN_REQUIRED');
      this.send({id: message.id, result: {accessToken: c.accessToken, chatgptAccountId: c.chatgptAccountId, chatgptPlanType: c.chatgptPlanType}});
    } catch {
      try { this.send({id: message.id, error: {code: -32001, message: 'Selected account requires sign-in. Automatic account fallback is disabled.'}}); } catch {}
    }
  }
  finish(code) {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(failure(code)); }
    this.pending.clear();
  }
  stop() { this.finish('BACKEND_EXITED'); try { this.child.kill(); } catch {} }
}

class SessionRouter extends EventEmitter {
  constructor({spawnBackend, credential, home, profileId, timeout = 15000}) {
    super();
    this.spawnBackend = spawnBackend; this.credential = credential; this.home = path.resolve(home); this.timeout = timeout;
    this.profileId = profileId; this.phase = 'starting'; this.ready = false; this.disposed = false; this.unsafe = false;
    this.hostPending = new Map(); this.serverPending = new Set(); this.active = new Set(); this.records = new Map();
    this.input = ''; this.inputDecoder = new StringDecoder('utf8'); this.initialization = null; this.exclusive = false;
    this.stdout = new PassThrough(); this.stderr = new PassThrough();
    this.stdin = new Writable({write: (chunk, encoding, done) => {
      try { this.input += this.inputDecoder.write(chunk); this.consumeInput(); done(); }
      catch (error) { done(error); }
    }});
    this.stdin.on('error', () => { this.unsafe = true; this.changed(); });
    this.stdin.once('finish', () => this.kill());
    this.stdio = [this.stdin, this.stdout, this.stderr]; this.connected = false;
    this.backend = new Backend(spawnBackend(), this);
    this.backend.child.once('spawn', () => this.emit('spawn'));
  }
  get spawnfile() { return this.backend?.child.spawnfile; }
  get spawnargs() { return this.backend?.child.spawnargs; }
  get pid() { return this.backend?.child.pid; }
  get exitCode() { return this.disposed ? this.backend.child.exitCode : null; }
  get signalCode() { return this.disposed ? this.backend.child.signalCode : null; }
  get killed() { return this.disposed; }
  ref() { this.backend.child.ref?.(); return this; }
  unref() { this.backend.child.unref?.(); return this; }
  changed() { this.emit('state', this.state()); }
  state() {
    return {available: this.ready && !this.unsafe && !this.disposed, phase: this.phase,
      profileId: this.profileId, busy: this.busy(), experimental: true};
  }
  busy() { return this.active.size > 0 || this.hostPending.size > 0 || this.serverPending.size > 0 || !!this.input; }
  output(message) { if (!this.stdout.destroyed) this.stdout.write(JSON.stringify(message) + '\n'); }
  protocolFailure(backend, line) {
    if (backend !== this.backend) { backend.unexpected = true; return; }
    this.unsafe = true; this.stdout.write(line + '\n'); this.changed();
  }
  consumeInput() {
    if (Buffer.byteLength(this.input) > MAX_FRAME) throw failure('PROTOCOL_UNSUPPORTED');
    let end;
    while ((end = this.input.indexOf('\n')) !== -1) {
      const line = this.input.slice(0, end); this.input = this.input.slice(end + 1);
      if (!line.trim()) continue;
      let m;
      try { m = JSON.parse(line); } catch { this.unsafe = true; throw failure('PROTOCOL_UNSUPPORTED'); }
      if (!m || typeof m !== 'object' || Array.isArray(m)) throw failure('PROTOCOL_UNSUPPORTED');
      if (m.method && this.exclusive) {
        if (Object.hasOwn(m, 'id')) this.output({id: m.id, error: {code: -32097, message: 'Account switch in progress. Retry after it completes.'}});
        else { this.unsafe = true; this.changed(); }
        continue;
      }
      if (typeof m.id === 'string' && m.id.startsWith(this.backend.prefix)) throw failure('PROTOCOL_UNSUPPORTED');
      if (m.method === 'initialize') {
        this.initialization = clone(m.params || {});
        m.params = {...m.params, capabilities: {...m.params?.capabilities, experimentalApi: true}};
      }
      if (m.method && Object.hasOwn(m, 'id')) {
        this.hostPending.set(key(m.id), {method: m.method, params: clone(m.params || {})});
        if (m.method === 'turn/start') {
          this.active.add(m.params?.threadId);
          const record = this.records.get(m.params?.threadId);
          // Per-turn configuration is not equivalent to the initial thread settings.
          // Until native effective-config tracking is implemented, never silently drop it.
          if (record && Object.keys(m.params || {}).some(name => !['threadId','input'].includes(name))) record.unsupported = true;
        }
        // These host-level processes cannot be proven quiescent via thread terminal listing.
        if (['command/exec','process/start','thread/shellCommand'].includes(m.method)) this.unsafe = true;
        if (['account/login/start','account/logout'].includes(m.method)) { this.ready = false; this.profileId = null; }
      } else if (!m.method && Object.hasOwn(m, 'id')) this.serverPending.delete(key(m.id));
      this.backend.send(m);
    }
  }
  message(backend, m) {
    if (backend !== this.backend) {
      // Candidate restoration may not ask Desktop to execute anything or approve tools.
      if (m.method && Object.hasOwn(m, 'id')) {
        backend.unexpected = true;
        try { backend.send({id: m.id, error: {code: -32097, message: 'Background candidate cannot request host actions.'}}); } catch {}
      }
      return;
    }
    if (!m || typeof m !== 'object') { this.unsafe = true; return; }
    if (!m.method && Object.hasOwn(m, 'id')) {
      const call = this.hostPending.get(key(m.id)); this.hostPending.delete(key(m.id));
      if (call?.method === 'initialize' && !m.error) { this.ready = true; this.phase = 'ready'; }
      if (call?.method === 'turn/start' && m.error) this.active.delete(call.params.threadId);
      if (['thread/start','thread/resume','thread/fork'].includes(call?.method) && m.result?.thread?.id) {
        const params = {};
        for (const name of RESTORE_KEYS) if (Object.hasOwn(call.params, name)) params[name] = clone(call.params[name]);
        this.records.set(m.result.thread.id, {params, effective: Object.fromEntries(['model','modelProvider','cwd','approvalPolicy','sandbox'].filter(k => Object.hasOwn(m.result,k)).map(k => [k,clone(m.result[k])])), unsupported: !!call.params.dynamicTools?.length});
      }
    } else if (m.method && Object.hasOwn(m, 'id')) this.serverPending.add(key(m.id));
    const p = m.params || {};
    if (m.method === 'turn/started') this.active.add(p.threadId);
    if (m.method === 'turn/completed' || m.method === 'thread/closed') this.active.delete(p.threadId);
    if (m.method === 'thread/status/changed') {
      if (p.status?.type === 'active') this.active.add(p.threadId);
      else if (['idle','notLoaded'].includes(p.status?.type)) this.active.delete(p.threadId);
    }
    this.output(m); this.changed();
  }
  backendClosed(backend, code, signal) {
    if (backend !== this.backend || this.disposed) return;
    this.disposed = true; this.ready = false; this.phase = 'closed';
    this.stdout.end(); this.stderr.end(); this.emit('exit', code, signal); this.emit('close', code, signal); this.changed();
  }
  kill(signal) {
    if (this.disposed) return false;
    this.candidate?.stop();
    this.backend.finish('BACKEND_EXITED');
    try { return this.backend.child.kill(signal); } catch { return false; }
  }
  async authenticated(profileId) {
    const c = this.credential(profileId), candidate = new Backend(this.spawnBackend({candidate: true}), this);
    candidate.profileId = profileId; candidate.identity = c.identity; this.candidate = candidate;
    try {
      const init = clone(this.initialization);
      init.capabilities = {...init.capabilities, experimentalApi: true};
      await candidate.request('initialize', init); candidate.send({method: 'initialized', params: {}});
      await candidate.request('account/login/start', {type: 'chatgptAuthTokens', accessToken: c.accessToken,
        chatgptAccountId: c.chatgptAccountId, chatgptPlanType: c.chatgptPlanType});
      const reply = await candidate.request('account/read', {refreshToken: false});
      if (!reply.account || reply.account.type !== 'chatgpt' || !c.email || reply.account.email?.toLowerCase() !== c.email.toLowerCase()) throw failure('IDENTITY_MISMATCH');
      const usage = await candidate.request('account/rateLimits/read');
      if (!usage || !usage.rateLimits && !usage.rateLimitsByLimitId) throw failure('USAGE_UNAVAILABLE');
      if (candidate.closed || candidate.unexpected || this.credential(profileId).identity !== c.identity) throw failure('IDENTITY_MISMATCH');
      return {candidate, usage, planType: reply.account.planType};
    } catch (error) { candidate.stop(); throw error; }
  }
  async snapshots() {
    const loaded = await this.backend.request('thread/loaded/list');
    if (!Array.isArray(loaded.data) || loaded.nextCursor != null || loaded.data.length > 32) throw failure('UNSUPPORTED_SESSION');
    const snapshots = [];
    for (const id of loaded.data) {
      const record = this.records.get(id);
      if (!record || record.unsupported) throw failure('UNSUPPORTED_SESSION');
      const {thread} = await this.backend.request('thread/read', {threadId: id, includeTurns: true});
      if (!thread || thread.id !== id || thread.ephemeral !== false || thread.status?.type !== 'idle' || typeof thread.path !== 'string') throw failure('UNSUPPORTED_SESSION');
      const sessionsPath = path.join(this.home, 'sessions');
      if (fs.lstatSync(sessionsPath).isSymbolicLink()) throw failure('UNSUPPORTED_SESSION');
      const file = fs.realpathSync(thread.path), sessions = fs.realpathSync(sessionsPath);
      const relative = path.relative(sessions, file);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw failure('UNSUPPORTED_SESSION');
      const terminals = await this.backend.request('thread/backgroundTerminals/list', {threadId: id});
      if (!Array.isArray(terminals.data) || terminals.nextCursor != null) throw failure('UNSUPPORTED_SESSION');
      if (terminals.data.length) throw failure('BACKGROUND_TERMINALS');
      snapshots.push({id, record, history: historyStamp(thread)});
    }
    return snapshots;
  }
  async transaction(profileId, operation) {
    if (this.exclusive) throw failure('SWITCH_IN_PROGRESS');
    if (!this.state().available || !this.initialization) throw failure('BACKEND_UNAVAILABLE');
    if (this.busy()) throw failure('WORK_IN_PROGRESS');
    this.exclusive = true; this.phase = operation === 'switch' ? 'switching' : 'checking'; this.changed();
    const old = this.backend;
    let prepared;
    try {
      const snapshots = operation === 'switch' ? await this.snapshots() : [];
      prepared = await this.authenticated(profileId);
      for (const {id, record, history} of snapshots) {
        const restored = await prepared.candidate.request('thread/resume', {...record.params, threadId: id});
        if (restored.thread?.id !== id || restored.thread.status?.type !== 'idle' || restored.thread.ephemeral !== false || historyStamp(restored.thread) !== history) throw failure('RESTORE_FAILED');
        for (const field of ['model','modelProvider','cwd','approvalPolicy','sandbox']) {
          if (Object.hasOwn(record.effective, field) && JSON.stringify(restored[field]) !== JSON.stringify(record.effective[field])) throw failure('RESTORE_FAILED');
        }
      }
      if (this.disposed || this.backend !== old || this.unsafe || this.busy() || old.closed || prepared.candidate.closed || prepared.candidate.unexpected) throw failure('WORK_IN_PROGRESS');
      if (operation === 'switch') {
        this.backend = prepared.candidate; this.profileId = profileId;
        this.output({method: 'account/updated', params: {authMode: 'chatgptAuthTokens', planType: prepared.planType || null}});
        this.output({method: 'account/rateLimits/updated', params: prepared.usage});
        old.stop();
      } else prepared.candidate.stop();
      return {profileId, usage: prepared.usage, switched: operation === 'switch', resumedThreads: snapshots.length};
    } catch (error) {
      prepared?.candidate.stop();
      if (error.code && /^[A-Z_]+$/.test(error.code)) throw error;
      throw failure('SWITCH_FAILED'); // No backend/file error text can leak credentials or paths.
    } finally {
      this.candidate = null; this.exclusive = false; this.phase = this.disposed ? 'closed' : 'ready'; this.changed();
    }
  }
  switchTo(id) { return this.transaction(id, 'switch'); }
  usage(id) { return this.transaction(id, 'usage'); }
}
module.exports = {SessionRouter};
