'use strict';
// Workspace-wide account switching: one authority, replaceable local connections, unchanged CODEX_HOME.
// The old per-thread router is deliberately not installed. No rollout is copied.
const fs = require('node:fs');
const path = require('node:path');
const {EventEmitter} = require('node:events');
const {Writable, PassThrough} = require('node:stream');
const childProcess = require('node:child_process');
const {syncBuiltinESMExports} = require('node:module');
const {AppServerRpc, JsonLines, hasId} = require('./rpc.cjs');
const {ProfileStore, tokenIdentity, DEFAULT_ID, PROFILE_ID} = require('./profiles.cjs');
const {fail, safeError, equalIdentity, atomicJson, regularFile, digest} = require('./common.cjs');
const INSTALL = Symbol.for('codex-labels.workspace-switcher.install.v2');
const LOCAL_READS = new Set(['thread/list', 'thread/loaded/list', 'thread/read', 'thread/turns/list', 'thread/items/list']);
const AUTH_EVENT = /^account\/(updated|login\/completed|rateLimits\/updated)$/;
const samePath = (a, b) => process.platform === 'win32'
  ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
const publicProfile = p => p ? {id: p.id, name: p.name} : null;

class SelectionStore {
  constructor(directory, home) {
    this.directory = path.resolve(directory); this.home = fs.realpathSync(home);
    this.file = path.join(this.directory, 'workspace-account.json');
  }
  read() {
    // Never silently discard the previous experimental per-thread histories.
    const legacy = path.join(this.directory, 'routes.json');
    if (fs.existsSync(legacy)) {
      const {file} = regularFile(legacy, this.directory, 8 * 1024 * 1024);
      const v = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!v || !Array.isArray(v.routes) || v.routes.length) fail('RECOVERY_REQUIRED');
    }
    if (!fs.existsSync(this.file)) return null;
    const {file} = regularFile(this.file, this.directory, 65536);
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (v?.version !== 2 || !samePath(v.home, this.home) || !['selected', 'pending', 'native', 'native-pending'].includes(v.status)) fail('RECOVERY_REQUIRED');
    if ((['selected', 'pending'].includes(v.status) || v.profile != null) && (!PROFILE_ID.test(v.profile?.id) || typeof v.profile?.name !== 'string' ||
      !v.profile?.identity?.accountId || !v.profile.identity.userId || v.profile.identity.workspaceId !== null)) fail('RECOVERY_REQUIRED');
    return v;
  }
  write(status, profile) {
    const value = {version: 2, home: this.home, status,
      profile: profile ? {id: profile.id, name: profile.name, identity: profile.identity} : null};
    atomicJson(this.file, value); return value;
  }
  restore(value) { return this.write(value?.status || 'native', value?.profile || null); }
}

class WorkspaceGateway extends EventEmitter {
  constructor({child, home, profiles, storageDirectory, rpcOptions, selectionStore}) {
    super(); this.home = fs.realpathSync(home); this.profiles = profiles;
    this.rpc = new AppServerRpc(child, rpcOptions); this.phase = 'starting'; this.blockedReason = null;
    this.active = null; this.credential = null; this.pendingCredential = null; this.inFlight = 0;
    this.turns = new Map(); this.completed = new Set(); this.authEvents = []; this.nativeLoginPending = false;
    this.operation = null; this.cancelled = false; this.disposed = false; this.catalogCount = null;
    this.selection = selectionStore || new SelectionStore(storageDirectory, this.home);
    try { this.saved = this.selection.read(); } catch { this.saved = null; this.block('RECOVERY_REQUIRED'); this.journalInvalid = true; }
    this.output = new PassThrough({highWaterMark: 1024 * 1024});
    this.output.on('drain', () => this.rpc.output.resume());
    const frames = new JsonLines(m => { this.accept(m).catch(() => {}); }, () => this.rpc.breakConnection('PROTOCOL_ERROR'));
    this.input = new Writable({write: (chunk, _encoding, done) => { frames.write(chunk); done(); },
      final: done => { frames.end(); this.rpc.input.end(); done(); }});
    this.rpc.on('request', m => this.serverRequest(m));
    this.rpc.on('notification', m => this.notification(m));
    this.rpc.on('closed', () => { this.block('RPC_CLOSED'); this.output.end(); });
    child.stdin = this.input; child.stdout = this.output;
    if (Array.isArray(child.stdio)) { child.stdio[0] = this.input; child.stdio[1] = this.output; }
  }
  snapshot() {
    return {version: 2, scope: 'workspace', attached: !this.rpc.closed, phase: this.phase,
      activeProfile: publicProfile(this.active), pendingProfile: publicProfile(this.saved?.status === 'pending' ? this.saved.profile : null),
      blockedReason: this.blockedReason, workspaceHome: this.home, localConversationCount: this.catalogCount,
      preservesLocalHistory: true, nativeLoginPending: this.nativeLoginPending};
  }
  changed() { this.emit('changed', this.snapshot()); }
  block(code) { this.phase = 'blocked'; this.blockedReason = code; this.changed(); }
  ready() { this.phase = 'idle'; this.blockedReason = null; this.changed(); }
  publish(m) { if (!this.output.destroyed && !this.output.writableEnded && !this.output.write(JSON.stringify(m) + '\n')) this.rpc.output.pause(); }
  guard() { if (this.cancelled || this.disposed) fail('CANCELLED'); }
  notification(m) {
    if (m.method === 'turn/completed') {
      const id = m.params?.turn?.id; if (id) {
        this.completed.add(id); if (this.completed.size > 2048) this.completed.delete(this.completed.values().next().value);
        if (this.turns.get(m.params?.threadId) === id) this.turns.delete(m.params.threadId);
      }
    }
    if (AUTH_EVENT.test(m.method)) {
      if (this.operation || this.phase === 'starting') { if (this.authEvents.length < 64) this.authEvents.push(m); return; }
      if (m.method === 'account/login/completed') this.nativeLoginPending = false;
      if (m.method === 'account/updated') {
        this.active = null; this.credential = null; this.block('CONSENT_REQUIRED');
      }
    }
    this.publish(m);
  }
  flushAuth() { for (const m of this.authEvents.splice(0)) this.publish(m); }
  serverRequest(m) {
    if (m.method !== 'account/chatgptAuthTokens/refresh' || !(this.pendingCredential || this.credential)) { this.publish(m); return; }
    try {
      const old = this.pendingCredential || this.credential;
      if (m.params?.previousAccountId && m.params.previousAccountId !== old.identity.accountId) fail('IDENTITY_MISMATCH');
      const fresh = this.profiles.token(old.id, old.identity);
      if (fresh.accessToken === old.accessToken) fail('AUTH_REQUIRED');
      if (this.pendingCredential) this.pendingCredential = fresh; else this.credential = fresh;
      this.rpc.respond(m.id, {result: this.authParams(fresh, false)});
    } catch {
      this.rpc.respond(m.id, {error: {code: -32001, message: 'Selected account requires login; no account fallback.'}});
      if (!this.operation) this.block('AUTH_REQUIRED');
    }
  }
  authParams(t, login = true) {
    return {...(login ? {type: 'chatgptAuthTokens'} : {}), accessToken: t.accessToken,
      chatgptAccountId: t.identity.accountId, ...(t.planType ? {chatgptPlanType: t.planType} : {})};
  }
  async liveIdentity(expected) {
    const account = await this.rpc.call('account/read', {refreshToken: false});
    if (!account?.account) fail('AUTH_REQUIRED');
    if (account.account.type !== 'chatgpt') fail('UNSUPPORTED');
    // Verify the LIVE server, not merely the credential file or an email address.
    const live = await this.rpc.call('getAuthStatus', {includeToken: true, refreshToken: false});
    const parsed = tokenIdentity(live?.authToken);
    if (expected && !equalIdentity(expected, parsed.identity)) fail('IDENTITY_MISMATCH');
    return {...parsed, accessToken: live.authToken};
  }
  async pages(method, params = {}) {
    const data = [], cursors = new Set(); let cursor = null;
    do {
      const r = await this.rpc.call(method, {...params, ...(cursor === null ? {} : {cursor})});
      if (!Array.isArray(r?.data) || (r.nextCursor != null && typeof r.nextCursor !== 'string')) fail('UNSUPPORTED');
      data.push(...r.data); cursor = r.nextCursor ?? null;
      if (cursor !== null) { if (!cursor || cursors.has(cursor)) fail('PROTOCOL_ERROR'); cursors.add(cursor); }
      if (cursors.size > 10000) fail('UNSUPPORTED'); // Explicit failure, never return a truncated catalog.
    } while (cursor !== null);
    return data;
  }
  async catalog() {
    const rows = [];
    for (const archived of [false, true]) {
      for (const t of await this.pages('thread/list', {limit: 100, archived})) {
        if (typeof t?.id !== 'string') fail('PROTOCOL_ERROR');
        rows.push([archived, t.id, t.path || null, t.name || null, t.cwd || null]);
      }
    }
    rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return {count: rows.length, hash: digest(JSON.stringify(rows))};
  }
  busy() {
    return this.inFlight > 0 || this.turns.size > 0 || this.rpc.globalCommands > 0 || this.rpc.serverRequests.size > 0 ||
      [...this.rpc.work.values()].some(s => s.turns.size || s.items.size || s.status === 'active') ||
      [...this.rpc.pending.values()].some(p => !p.internal);
  }
  async assertIdle() {
    if (this.busy() || this.nativeLoginPending) fail('BUSY');
    const loaded = await this.pages('thread/loaded/list');
    const ids = new Set(loaded); // Historical read-only records need not be loaded to switch authentication.
    for (const id of ids) {
      if (typeof id !== 'string') fail('UNSUPPORTED');
      const r = await this.rpc.call('thread/read', {threadId: id, includeTurns: true});
      if (r?.thread?.id !== id || !['idle', 'notLoaded'].includes(r.thread.status?.type) ||
        !Array.isArray(r.thread.turns) || r.thread.turns.some(t => t.status === 'inProgress')) fail('BUSY');
      const terminals = await this.rpc.call('thread/backgroundTerminals/list', {threadId: id});
      if (!Array.isArray(terminals?.data) || terminals.nextCursor != null) fail('UNSUPPORTED');
      if (terminals.data.length) fail('BUSY');
    }
    if (this.busy()) fail('BUSY');
  }
  async login(t) {
    this.pendingCredential = t;
    const result = await this.rpc.call('account/login/start', this.authParams(t));
    if (result?.type !== 'chatgptAuthTokens') fail('UNSUPPORTED');
    await this.liveIdentity(t.identity);
    await this.rpc.call('account/rateLimits/read'); // Online acceptance, never a model request.
    await this.liveIdentity(t.identity);
  }
  bootstrap() {
    if (this.bootPromise) return this.bootPromise;
    this.bootPromise = (async () => {
      if (this.journalInvalid || ['pending', 'native-pending'].includes(this.saved?.status)) { this.block('RECOVERY_REQUIRED'); return; }
      try {
        if (this.saved?.status === 'selected') {
          const p = this.saved.profile, t = this.profiles.token(p.id, p.identity);
          const before = await this.catalog();
          await this.login(t);
          const after = await this.catalog(); if (before.hash !== after.hash) fail('CHECKPOINT_INVALID');
          this.active = p; this.credential = this.pendingCredential; this.catalogCount = after.count;
        } else {
          const live = await this.liveIdentity();
          this.active = {id: this.profiles.currentProfileId || DEFAULT_ID, name: '현재 로그인', identity: live.identity};
          // Initial native login is not a cross-account transfer. Subsequent
          // native account changes require explicit consent through recover().
        }
        this.ready(); this.flushAuth();
      } catch (e) { this.block(safeError(e).code); this.authEvents = []; }
      finally { this.pendingCredential = null; }
    })();
    return this.bootPromise;
  }
  switchAccount(profileId, {confirmContextTransfer = false} = {}) {
    if (this.disposed) return Promise.reject(Object.assign(new Error(), {code: 'RPC_CLOSED'}));
    if (this.operation || this.phase !== 'idle') return Promise.reject(Object.assign(new Error(), {code: 'BUSY'}));
    if (!confirmContextTransfer) return Promise.reject(Object.assign(new Error(), {code: 'CONSENT_REQUIRED'}));
    if (this.busy()) return Promise.reject(Object.assign(new Error(), {code: 'BUSY'}));
    this.phase = 'switching'; this.cancelled = false; this.changed();
    this.operation = this.performSwitch(profileId).finally(() => { this.operation = null; this.pendingCredential = null; this.changed(); });
    return this.operation;
  }
  async performSwitch(profileId) {
    const original = this.active, originalCredential = this.credential, previous = this.saved;
    let touched = false, intent = false, source, before;
    try {
      const target = this.profiles.pin(profileId), token = this.profiles.token(profileId, target.identity);
      source = await this.liveIdentity(original.identity); this.guard();
      await this.assertIdle(); before = await this.catalog(); this.guard();
      this.saved = this.selection.write('pending', target); intent = true;
      touched = true; await this.login(token); this.guard();
      const after = await this.catalog(); if (before.hash !== after.hash) fail('CHECKPOINT_INVALID');
      await this.assertIdle(); this.guard();
      this.saved = this.selection.write('selected', target);
      this.active = target; this.credential = this.pendingCredential; this.catalogCount = after.count;
      this.ready(); this.flushAuth();
      return {changed: true, state: this.snapshot()};
    } catch (error) {
      this.authEvents = [];
      try {
        if (touched) {
          // Restore the previous verified principal, never replay the user's turn.
          await this.login({...original, ...source});
          if ((await this.catalog()).hash !== before.hash) fail('CHECKPOINT_INVALID');
        }
        if (intent) this.saved = this.selection.restore(previous);
        this.active = original; this.credential = touched ? this.pendingCredential : originalCredential;
        if (['IDENTITY_MISMATCH', 'RPC_CLOSED', 'RPC_TIMEOUT'].includes(error.code)) this.block(error.code); else this.ready();
        this.flushAuth();
      } catch { this.block('RECOVERY_REQUIRED'); this.authEvents = []; }
      throw error;
    }
  }
  cancel() {
    if (!this.operation || this.phase === 'idle') return false;
    this.cancelled = true; this.phase = 'cancelling'; this.changed(); return true;
  }
  recover({confirmContextTransfer = false} = {}) {
    if (this.disposed) return Promise.reject(Object.assign(new Error(), {code: 'RPC_CLOSED'}));
    if (!confirmContextTransfer) return Promise.reject(Object.assign(new Error(), {code: 'CONSENT_REQUIRED'}));
    if (this.operation || this.phase === 'starting' || this.nativeLoginPending || this.journalInvalid)
      return Promise.reject(Object.assign(new Error(), {code: 'RECOVERY_REQUIRED'}));
    this.phase = 'checking'; this.cancelled = false; this.changed();
    this.operation = this.performRecovery().finally(() => { this.operation = null; this.pendingCredential = null; this.changed(); });
    return this.operation;
  }
  async performRecovery() {
    try {
      await this.assertIdle(); const before = await this.catalog(); this.guard();
      const selected = this.saved && ['selected', 'pending'].includes(this.saved.status);
      let candidate, credential = null;
      if (selected) {
        candidate = this.saved.profile;
        await this.login(this.profiles.token(candidate.id, candidate.identity));
        credential = this.pendingCredential;
      } else {
        const live = await this.liveIdentity();
        await this.rpc.call('account/rateLimits/read');
        await this.liveIdentity(live.identity);
        candidate = {id: this.profiles.currentProfileId || DEFAULT_ID, name: '현재 로그인', identity: live.identity};
      }
      this.guard(); const after = await this.catalog();
      if (before.hash !== after.hash) fail('CHECKPOINT_INVALID');
      this.saved = this.selection.write(selected ? 'selected' : 'native', selected ? candidate : null);
      this.active = candidate; this.credential = credential; this.catalogCount = after.count;
      this.ready(); this.flushAuth(); return this.snapshot();
    } catch (e) { this.authEvents = []; this.block(safeError(e).code); throw e; }
  }
  async usage() {
    if (this.disposed) fail('RPC_CLOSED');
    if (this.phase !== 'idle' || !this.active) fail('BUSY');
    this.inFlight++;
    try {
      await this.liveIdentity(this.active.identity);
      const result = await this.rpc.call('account/rateLimits/read');
      await this.liveIdentity(this.active.identity); return result;
    } finally { this.inFlight--; }
  }
  async accept(m) {
    if (!m.method) { if (this.rpc.serverRequests.has(m.id)) this.rpc.respond(m.id, Object.hasOwn(m, 'error') ? {error: m.error} : {result: m.result}); return; }
    if (!hasId(m)) {
      if (m.method === 'initialized') { this.rpc.notify(m.method, m.params); this.bootstrap(); }
      return;
    }
    let counted = false, turnReservation;
    try {
      if (this.disposed) fail('RPC_CLOSED');
      if (m.method === 'initialize') {
        const r = await this.rpc.exchange(m.method, {...m.params, capabilities: {...m.params?.capabilities, experimentalApi: true}});
        this.publish({id: m.id, ...r}); return;
      }
      const localRead = LOCAL_READS.has(m.method), authWrite = /^account\/(login\/start|login\/cancel|logout)$/.test(m.method);
      if (!localRead && this.phase === 'starting') await this.bootstrap();
      if (!localRead && (this.operation || this.phase === 'checking')) fail('BUSY');
      if (!localRead && !authWrite && this.phase !== 'idle' && !['account/read', 'getAuthStatus', 'turn/interrupt'].includes(m.method)) fail('RECOVERY_REQUIRED');
      if (authWrite && this.journalInvalid) fail('RECOVERY_REQUIRED');
      if (authWrite && this.busy()) fail('BUSY');
      if (this.nativeLoginPending && authWrite && m.method !== 'account/login/cancel') fail('BUSY');
      // Reject automatic host token replacement of an explicitly selected account.
      if (m.method === 'account/login/start' && m.params?.type === 'chatgptAuthTokens' && this.saved?.status === 'selected') fail('CONSENT_REQUIRED');
      this.inFlight++; counted = true;
      if (!localRead && !authWrite && !['account/read', 'getAuthStatus', 'turn/interrupt'].includes(m.method) && this.active)
        await this.liveIdentity(this.active.identity);
      if (authWrite) {
        // Persist unconfirmed native login across a crash/restart as well.
        this.saved = this.selection.write('native-pending', null); this.active = null; this.credential = null;
        this.block('CONSENT_REQUIRED');
        this.nativeLoginPending = m.method === 'account/login/start';
      }
      if (m.method === 'turn/start') {
        if (this.turns.has(m.params?.threadId)) fail('BUSY');
        turnReservation = Symbol('turn'); this.turns.set(m.params?.threadId, turnReservation);
      }
      const r = await this.rpc.exchange(m.method, m.params);
      if (m.method === 'turn/start') {
        if (r.error) this.turns.delete(m.params?.threadId);
        else if (typeof r.result?.turn?.id !== 'string') { this.block('PROTOCOL_ERROR'); fail('PROTOCOL_ERROR'); }
        else if (this.completed.has(r.result.turn.id)) this.turns.delete(m.params?.threadId);
        else this.turns.set(m.params.threadId, r.result.turn.id);
      }
      if (authWrite && (r.error || m.method !== 'account/login/start')) this.nativeLoginPending = false;
      // Crucial: all listing pages and filters pass through UNMODIFIED, including
      // unopened and archived conversations. No observation-only 500-item list.
      this.publish({id: m.id, ...r});
    } catch (e) {
      if (turnReservation || ['IDENTITY_MISMATCH', 'RPC_CLOSED', 'RPC_TIMEOUT'].includes(e.code)) this.block(safeError(e).code);
      const error = safeError(e); this.publish({id: m.id, error: {code: -32000, message: `${error.code}: ${error.message}`}});
    } finally { if (counted) this.inFlight--; }
  }
  async dispose() {
    this.disposed = true; this.cancelled = true;
    try { await this.operation; } catch {}
    await this.rpc.close(); this.phase = 'disposed'; this.changed();
  }
}

// A process-local workspace authority; transports are replaceable, authority is not.
// Tokens stay in memory. Each physical connection retains its own request IDs,
// approvals, notifications, threads and native process lifecycle.
const ACCOUNT_READS = new Set(['account/read', 'getAuthStatus']);
const AUTH_WRITES = /^account\/(login\/start|login\/cancel|logout)$/;
const NON_WORK = new Set([...LOCAL_READS, ...ACCOUNT_READS, 'initialize']);

class WorkspaceCoordinator extends EventEmitter {
  constructor({home, profiles, storageDirectory, selectionStore}) {
    super(); this.home = fs.realpathSync(home); this.profiles = profiles;
    this.selection = selectionStore || new SelectionStore(storageDirectory, this.home);
    this.connections = new Set(); this.retiring = new Map(); this.topology = 0;
    this.fault = 0; this.operationFault = 0; this.generation = 0; this.active = null; this.credential = null; this.catalogCount = null;
    this.phase = 'starting'; this.blockedReason = null; this.operation = null;
    this.cancelled = false; this.disposed = false; this.nativeOwner = null; this.nativeLoginPending = false;
    this.joinTail = Promise.resolve(); this.journalInvalid = false;
    try { this.saved = this.selection.read(); }
    catch { this.saved = null; this.journalInvalid = true; this.blockedReason = 'RECOVERY_REQUIRED'; }
    if (this.journalInvalid || ['pending', 'native-pending'].includes(this.saved?.status)) {
      this.phase = 'blocked'; this.blockedReason = 'RECOVERY_REQUIRED';
    }
  }
  live() { return [...this.connections].filter(c => !c.rpc.closed && !c.disposed); }
  snapshot() {
    const list = this.live();
    return {version: 3, scope: 'workspace', attached: list.length > 0,
      phase: this.phase, blockedReason: this.blockedReason,
      activeProfile: publicProfile(this.active), pendingProfile: publicProfile(this.saved?.status === 'pending' ? this.saved.profile : null),
      workspaceHome: this.home, localConversationCount: this.catalogCount, preservesLocalHistory: true,
      nativeLoginPending: this.nativeLoginPending, connectionCount: list.length,
      verifiedConnectionCount: list.filter(c => c.verified && c.verifiedGeneration === this.generation).length,
      retiringConnectionCount: this.retiring.size, generation: this.generation};
  }
  changed() { const state = this.snapshot(); for (const listener of this.rawListeners('changed')) { try { listener.call(this, state); } catch {} } }
  phaseNow() {
    if (this.disposed) this.phase = 'disposed';
    else if (this.blockedReason) this.phase = 'blocked';
    else if (!this.operation) {
      const list = this.live();
      this.phase = !list.length ? 'disconnected' : list.every(c => c.verified) && !this.retiring.size ? 'idle' : 'synchronizing';
    }
    this.changed();
  }
  block(code, {durable = false} = {}) {
    this.fault++; this.blockedReason = code; this.phase = 'blocked';
    if (durable && !this.journalInvalid) {
      try {
        const p = this.active || this.saved?.profile;
        this.saved = this.selection.write(this.saved?.status === 'selected' && p ? 'pending' : 'native-pending',
          this.saved?.status === 'selected' ? p : null);
      } catch { this.journalInvalid = true; this.blockedReason = 'RECOVERY_REQUIRED'; }
    }
    this.changed();
  }
  attach(c) {
    if (this.disposed || !samePath(c.home, this.home)) fail('INVALID_ARGUMENT');
    this.connections.add(c); this.topology++; this.phaseNow();
  }
  member(c) { return this.connections.has(c) && !c.rpc.closed && !c.disposed; }
  unsafeWork(c) {
    return c.turns.size > 0 || c.rpc.globalCommands > 0 || c.inFlightWork > 0 ||
      [...c.rpc.work.values()].some(s => s.turns.size || s.items.size || s.status === 'active') ||
      [...c.rpc.serverRequests.values()].some(m => m.method !== 'account/chatgptAuthTokens/refresh') ||
      [...c.rpc.pending.values()].some(p => !p.internal && !NON_WORK.has(p.method));
  }
  detached(c) {
    if (!this.connections.delete(c)) return;
    this.topology++; c.verified = false;
    if (!this.disposed && this.unsafeWork(c)) this.block('RECOVERY_REQUIRED', {durable: true});
    // EOF/timeout is not evidence that the OS process has exited. Retire it and
    // retain the barrier until exit is confirmed. Never kill a healthy sibling.
    if (c.rpc.child.exitCode == null && c.rpc.child.signalCode == null) {
      const record = {connection: c, promise: null, failed: false};
      this.retiring.set(c, record);
      record.promise = c.rpc.close().then(() => { this.retiring.delete(c); }, () => {
        record.failed = true; this.block('CLEANUP_FAILED', {durable: true});
      }).finally(() => this.phaseNow());
    }
    this.phaseNow();
  }
  assertMember(c) { if (!this.member(c)) fail('RPC_CLOSED'); }
  checkEpoch(epoch, {ignoreCancel = false} = {}) {
    if (this.disposed || (!ignoreCancel && this.cancelled)) fail('CANCELLED');
    if (this.topology !== epoch || this.retiring.size) fail('BUSY');
    if (this.operation && this.fault !== this.operationFault) fail('RECOVERY_REQUIRED');
  }
  syncFields(c) {
    c.active = this.active; c.credential = this.credential; c.saved = this.saved;
    c.verified = true; c.verifiedGeneration = this.generation;
  }
  join(c) {
    if (c.joinPromise) return c.joinPromise;
    const previous = this.joinTail;
    c.joinPromise = (async () => {
      await previous;
      if (this.operation) { try { await this.operation; } catch {} }
      if (!this.member(c) || this.disposed) return;
      try {
        if (this.journalInvalid || this.blockedReason || ['pending', 'native-pending'].includes(this.saved?.status)) {
          this.block(this.blockedReason || 'RECOVERY_REQUIRED'); return;
        }
        let credential = null;
        const remembered = this.active || this.saved?.profile;
        if (this.saved?.status === 'selected') {
          const p = this.saved.profile;
          credential = this.profiles.token(p.id, p.identity);
          const before = await c.catalog(); this.assertMember(c);
          await c.login(credential); this.assertMember(c);
          if ((await c.catalog()).hash !== before.hash) fail('CHECKPOINT_INVALID');
          this.active = p; this.credential = c.pendingCredential; this.catalogCount = before.count;
        } else {
          const live = await c.liveIdentity(remembered?.identity); this.assertMember(c);
          this.active ||= remembered || {id: this.profiles.currentProfileId || DEFAULT_ID, name: '현재 로그인', identity: live.identity};
          // Pin native identity across reconnection AND a fresh application run.
          if (!this.saved?.profile) this.saved = this.selection.write('native', this.active);
        }
        if (this.blockedReason) return;
        this.syncFields(c); c.flushAuth();
      } catch (error) {
        if (this.member(c)) { c.authEvents = []; this.block(safeError(error).code, {durable: error.code === 'IDENTITY_MISMATCH'}); }
      } finally { c.pendingCredential = null; c.joinSettled = true; this.phaseNow(); }
    })();
    this.joinTail = c.joinPromise.catch(() => {});
    return c.joinPromise;
  }
  async settleJoins() { let tail; do { tail = this.joinTail; await tail; } while (tail !== this.joinTail); }
  fastIdle() { return !this.nativeLoginPending && !this.retiring.size && this.live().every(c => !c.busy()); }
  async idleAll(list, epoch) {
    if (this.nativeLoginPending) fail('BUSY');
    for (const c of list) { this.assertMember(c); await c.assertIdle(); this.checkEpoch(epoch); }
  }
  begin(phase, action) {
    if (this.disposed) return Promise.reject(Object.assign(new Error(), {code: 'RPC_CLOSED'}));
    if (this.operation) return Promise.reject(Object.assign(new Error(), {code: 'BUSY'}));
    this.phase = phase; this.cancelled = false; this.operationFault = this.fault;
    // Publish the lock before calling observers or any async protocol operation.
    const promise = Promise.resolve().then(action).finally(() => {
      for (const c of this.live()) c.pendingCredential = null;
      this.operation = null; this.phaseNow();
    });
    this.operation = promise; this.changed(); return promise;
  }
  switchAccount(id, {confirmContextTransfer = false} = {}) {
    if (!confirmContextTransfer) return Promise.reject(Object.assign(new Error(), {code: 'CONSENT_REQUIRED'}));
    if (this.phase !== 'idle' || !this.active || !this.fastIdle()) return Promise.reject(Object.assign(new Error(), {code: 'BUSY'}));
    return this.begin('switching', () => this.performSwitch(id)).then(result => ({...result, state: this.snapshot()}));
  }
  async performSwitch(id) {
    const list = this.live(), epoch = this.topology, original = this.active, originalCredential = this.credential, previous = this.saved;
    const sources = new Map(), catalogs = new Map(), touched = new Set(); let intent = false;
    try {
      const target = this.profiles.pin(id), token = this.profiles.token(id, target.identity);
      await this.idleAll(list, epoch);
      for (const c of list) {
        sources.set(c, await c.liveIdentity(original.identity)); this.checkEpoch(epoch);
        catalogs.set(c, await c.catalog()); this.checkEpoch(epoch);
      }
      this.saved = this.selection.write('pending', target); intent = true;
      for (const c of list) {
        touched.add(c); await c.login(token); this.checkEpoch(epoch);
        if ((await c.catalog()).hash !== catalogs.get(c).hash) fail('CHECKPOINT_INVALID'); this.checkEpoch(epoch);
      }
      await this.idleAll(list, epoch); this.checkEpoch(epoch);
      this.saved = this.selection.write('selected', target);
      this.active = target; this.credential = list[0].pendingCredential; this.generation++;
      this.catalogCount = catalogs.get(list[0]).count; this.blockedReason = null;
      for (const c of list) { this.syncFields(c); c.flushAuth(); }
      return {changed: true, state: {...this.snapshot(), phase: 'idle'}};
    } catch (error) {
      for (const c of this.live()) c.authEvents = [];
      let restored = true;
      for (const c of touched) {
        if (!this.member(c)) { if (c.rpc.child.exitCode == null && c.rpc.child.signalCode == null) restored = false; continue; }
        try {
          await c.login({...original, ...sources.get(c)});
          if ((await c.catalog()).hash !== catalogs.get(c).hash) fail('CHECKPOINT_INVALID');
        } catch { restored = false; }
      }
      try { if (!restored) fail('RECOVERY_REQUIRED'); if (intent) this.saved = this.selection.restore(previous); }
      catch { restored = false; }
      this.active = original; this.credential = originalCredential;
      for (const c of list) if (this.member(c)) {
        c.pendingCredential = null; c.authEvents = [];
        if (restored) { this.syncFields(c); if (touched.has(c)) c.credential = {...original, ...sources.get(c)}; } else c.verified = false;
      }
      if (!restored) this.block('RECOVERY_REQUIRED');
      else if (['IDENTITY_MISMATCH', 'RPC_TIMEOUT'].includes(error.code)) this.block(error.code, {durable: true});
      throw error;
    }
  }
  cancel() {
    if (!this.operation || !['switching', 'checking', 'cancelling'].includes(this.phase)) return false;
    this.cancelled = true; this.phase = 'cancelling'; this.changed(); return true;
  }
  async nativeWrite(c, method, params) {
    this.assertMember(c);
    if (this.journalInvalid) fail('RECOVERY_REQUIRED');
    if (this.nativeLoginPending && (method !== 'account/login/cancel' || c !== this.nativeOwner)) fail('BUSY');
    if (method === 'account/login/start' && params?.type === 'chatgptAuthTokens' && this.saved?.status === 'selected') fail('CONSENT_REQUIRED');
    if (!this.fastIdle() && !(method === 'account/login/cancel' && c === this.nativeOwner && this.nativeLoginPending)) fail('BUSY');
    return this.begin('authenticating', async () => {
      if (method !== 'account/login/cancel') await this.idleAll(this.live(), this.topology);
      this.saved = this.selection.write('native-pending', null);
      this.active = null; this.credential = null; this.generation++;
      this.nativeOwner = c; this.nativeLoginPending = method === 'account/login/start';
      for (const peer of this.live()) { peer.verified = false; peer.credential = null; }
      this.blockedReason = 'CONSENT_REQUIRED';
      try {
        const result = await c.rpc.exchange(method, params);
        if (result.error || method !== 'account/login/start') this.nativeLoginPending = false;
        return result;
      } finally { c.flushAuth(); this.block('CONSENT_REQUIRED'); }
    });
  }
  recover({confirmContextTransfer = false} = {}) {
    if (!confirmContextTransfer) return Promise.reject(Object.assign(new Error(), {code: 'CONSENT_REQUIRED'}));
    if (this.journalInvalid || this.nativeLoginPending) return Promise.reject(Object.assign(new Error(), {code: 'RECOVERY_REQUIRED'}));
    if (this.live().some(c => !c.initialized || !c.joinSettled)) return Promise.reject(Object.assign(new Error(), {code: 'BUSY'}));
    return this.begin('checking', () => this.performRecovery()).then(() => this.snapshot());
  }
  async performRecovery() {
    try {
      for (const [c, record] of this.retiring) {
        await record.promise;
        if (record.failed) { await c.rpc.close(); this.retiring.delete(c); }
      }
      const list = this.live(), epoch = this.topology;
      if (!list.length) fail('NOT_ATTACHED');
      await this.idleAll(list, epoch);
      const catalogs = new Map();
      for (const c of list) { catalogs.set(c, await c.catalog()); this.checkEpoch(epoch); }
      const selected = ['selected', 'pending'].includes(this.saved?.status);
      let target, token, owner = this.member(this.nativeOwner) ? this.nativeOwner : list[0];
      if (selected) {
        target = this.saved.profile; token = this.profiles.token(target.id, target.identity);
      } else {
        const live = await owner.liveIdentity(); this.checkEpoch(epoch);
        target = {id: this.profiles.currentProfileId || DEFAULT_ID, name: '현재 로그인', identity: live.identity};
        token = {...target, ...live};
        if (!this.member(this.nativeOwner)) {
          for (const c of list) { await c.liveIdentity(target.identity); this.checkEpoch(epoch); }
        }
      }
      for (const c of list) {
        if (selected || c !== owner) await c.login(token);
        else { await c.rpc.call('account/rateLimits/read'); await c.liveIdentity(target.identity); }
        this.checkEpoch(epoch);
        if ((await c.catalog()).hash !== catalogs.get(c).hash) fail('CHECKPOINT_INVALID'); this.checkEpoch(epoch);
      }
      await this.idleAll(list, epoch); this.checkEpoch(epoch);
      this.saved = this.selection.write(selected ? 'selected' : 'native', target);
      this.active = target; this.credential = selected ? token : null; this.catalogCount = catalogs.get(owner).count;
      this.generation++; this.blockedReason = null; this.nativeOwner = null;
      for (const c of list) { this.syncFields(c); if (!selected && c !== owner) c.credential = token; c.flushAuth(); }
      return {...this.snapshot(), phase: 'idle'};
    } catch (error) { for (const c of this.live()) { c.verified = false; c.authEvents = []; } this.block(safeError(error).code); throw error; }
  }
  async usage() {
    if (this.phase !== 'idle' || this.operation || !this.active) fail('BUSY');
    const c = this.live()[0]; this.assertMember(c); c.inFlight++;
    try { await c.liveIdentity(this.active.identity); const value = await c.rpc.call('account/rateLimits/read'); await c.liveIdentity(this.active.identity); return value; }
    catch (e) { if (e.code === 'IDENTITY_MISMATCH') this.block('IDENTITY_MISMATCH', {durable: true}); throw e; }
    finally { c.inFlight--; }
  }
  async dispose() {
    this.disposed = true; this.cancelled = true;
    try { await this.operation; } catch {}
    await this.joinTail;
    const list = [...this.connections, ...this.retiring.keys()];
    const result = await Promise.allSettled(list.map(c => c.dispose()));
    if (result.some(r => r.status === 'rejected')) { this.block('CLEANUP_FAILED'); fail('CLEANUP_FAILED'); }
    this.connections.clear(); this.retiring.clear(); this.phaseNow();
  }
}

class WorkspaceConnection extends WorkspaceGateway {
  constructor({coordinator, ...options}) {
    // The coordinator is the sole state-file writer. Legacy primitives below
    // retain only per-connection accounting and protocol validation.
    super({...options, selectionStore: {read: () => coordinator.saved}});
    this.coordinator = coordinator; this.initialized = false; this.initializeAccepted = false;
    this.preInitializeQueue = [];
    this.verified = false; this.verifiedGeneration = -1; this.inFlightWork = 0; this.accepting = 0;
    coordinator.attach(this);
  }
  snapshot() { return this.coordinator ? this.coordinator.snapshot() : super.snapshot(); }
  changed() { this.coordinator?.changed(); }
  block(code) { if (this.rpc?.closed) this.coordinator?.detached(this); else this.coordinator?.block(code); }
  bootstrap() { return this.initialized ? this.coordinator.join(this) : Promise.resolve(); }
  notification(m) {
    const group = this.coordinator;
    if (!group || !group.member(this)) return;
    if (m.method === 'turn/completed') {
      const id = m.params?.turn?.id;
      if (id) { this.completed.add(id); if (this.completed.size > 2048) this.completed.delete(this.completed.values().next().value);
        if (this.turns.get(m.params?.threadId) === id) this.turns.delete(m.params.threadId); }
    }
    if (AUTH_EVENT.test(m.method)) {
      if (m.method === 'account/login/completed' && group.nativeOwner === this) group.nativeLoginPending = false;
      if (group.operation || !this.verified) { if (this.authEvents.length < 64) this.authEvents.push(m); return; }
      if (m.method === 'account/updated') { group.nativeOwner = this; group.active = null; group.credential = null; group.block('CONSENT_REQUIRED', {durable: true}); }
    }
    this.publish(m);
  }
  serverRequest(m) {
    const group = this.coordinator;
    if (!group || !group.member(this)) return;
    if (m.method === 'account/chatgptAuthTokens/refresh') {
      const old = this.pendingCredential || this.credential || group.credential;
      if (!old && group.saved?.status !== 'selected' && !group.operation && group.phase === 'idle' &&
          group.active && (!m.params?.previousAccountId || m.params.previousAccountId === group.active.identity.accountId)) { this.publish(m); return; }
      try {
        if (!old || (m.params?.previousAccountId && m.params.previousAccountId !== old.identity.accountId)) fail('IDENTITY_MISMATCH');
        const fresh = group.profiles.token(old.id, old.identity);
        if (fresh.accessToken === old.accessToken) fail('AUTH_REQUIRED');
        if (this.pendingCredential) this.pendingCredential = fresh; else this.credential = fresh;
        this.rpc.respond(m.id, {result: this.authParams(fresh, false)});
      } catch { this.rpc.respond(m.id, {error: {code: -32001, message: 'Pinned account requires login; no fallback.'}}); group.block('AUTH_REQUIRED', {durable: true}); }
      return;
    }
    if (!this.verified || this.verifiedGeneration !== group.generation || group.operation || !['idle', 'synchronizing'].includes(group.phase)) {
      this.rpc.respond(m.id, {error: {code: -32000, message: 'Workspace account is not ready.'}}); return;
    }
    this.publish(m);
  }
  async accept(m) {
    const group = this.coordinator;
    if (!group) return;
    // Desktop can pipeline `initialized` and initial reads before the
    // app-server has answered `initialize`. The real pipe preserves that
    // ordering; keep the same ordering while the proxy awaits the response.
    if (m.method !== 'initialize' && !this.initialized && this.initializePending) {
      if (this.preInitializeQueue.length >= 512) { group.block('PROTOCOL_ERROR', {durable: true}); return; }
      this.preInitializeQueue.push(m); return;
    }
    if (!m.method) {
      const pending = this.rpc.serverRequests.get(m.id);
      if (!pending) return;
      if (pending.method === 'account/chatgptAuthTokens/refresh' && !Object.hasOwn(m, 'error')) {
        // Host-managed refresh replies are also authentication writes. Otherwise
        // a native A -> C refresh could bypass the gate during a running turn.
        try {
          const expected = this.pendingCredential?.identity || this.credential?.identity || group.active?.identity;
          const parsed = tokenIdentity(m.result?.accessToken);
          if (!expected || !equalIdentity(parsed.identity, expected) || m.result?.chatgptAccountId !== expected.accountId ||
              (pending.params?.previousAccountId && pending.params.previousAccountId !== expected.accountId)) fail('IDENTITY_MISMATCH');
        } catch {
          this.rpc.respond(m.id, {error: {code: -32001, message: 'Refresh principal did not match the workspace.'}});
          group.block('IDENTITY_MISMATCH', {durable: true}); return;
        }
      }
      this.rpc.respond(m.id, Object.hasOwn(m, 'error') ? {error: m.error} : {result: m.result}); return;
    }
    if (!hasId(m)) {
      if (m.method === 'initialized' && !this.initialized) {
        if (this.initializeAccepted) {
          this.rpc.notify(m.method, m.params); this.initialized = true; this.bootstrap();
        }
      }
      return;
    }
    let counted = false, work = false, turnReservation = false;
    try {
      group.assertMember(this);
      if (this.accepting >= 512) fail('BUSY'); this.accepting++; counted = true;
      if (m.method === 'initialize') {
        if (this.initializeAccepted || this.initializePending) fail('PROTOCOL_ERROR');
        this.initializePending = true;
        const r = await this.rpc.exchange(m.method, {...m.params, capabilities: {...m.params?.capabilities, experimentalApi: true}});
        this.initializePending = false; this.initializeAccepted = !r.error;
        this.publish({id: m.id, ...r});
        const queued = this.preInitializeQueue.splice(0);
        if (this.initializeAccepted) {
          for (const message of queued) await this.accept(message);
        } else {
          for (const message of queued) if (hasId(message))
            this.publish({id: message.id, error: {code: -32000, message: 'PROTOCOL_ERROR: initialization failed'}});
        }
        return;
      }
      if (!this.initialized) fail('PROTOCOL_ERROR');
      const localRead = LOCAL_READS.has(m.method), authWrite = AUTH_WRITES.test(m.method), accountRead = ACCOUNT_READS.has(m.method);
      // Local history stays readable while authentication is blocked. Everything
      // that can start work must cross the common barrier, including new peers.
      if (!localRead) await this.bootstrap();
      group.assertMember(this);
      if (authWrite) { const r = await group.nativeWrite(this, m.method, m.params); this.publish({id: m.id, ...r}); return; }
      const interrupt = m.method === 'turn/interrupt';
      if (!localRead && !accountRead && !interrupt) {
        if (group.operation) fail('BUSY');
        if (group.phase !== 'idle' || !this.verified || this.verifiedGeneration !== group.generation || !group.active) fail('RECOVERY_REQUIRED');
      }
      if (accountRead && (group.operation || !this.verified) && group.saved?.status === 'selected') fail('BUSY');
      this.inFlight++; work = true;
      if (!localRead && !accountRead && !interrupt) {
        this.inFlightWork++;
        await this.liveIdentity(group.active.identity);
        if (group.phase !== 'idle' || group.operation || !this.verified) fail('RECOVERY_REQUIRED');
      }
      if (m.method === 'turn/start') {
        if (this.turns.has(m.params?.threadId)) fail('BUSY');
        this.turns.set(m.params?.threadId, Symbol('turn')); turnReservation = true;
      }
      const r = await this.rpc.exchange(m.method, m.params);
      if (turnReservation) {
        if (r.error || this.completed.has(r.result?.turn?.id)) this.turns.delete(m.params?.threadId);
        else if (typeof r.result?.turn?.id === 'string') this.turns.set(m.params.threadId, r.result.turn.id);
        else { group.block('PROTOCOL_ERROR', {durable: true}); fail('PROTOCOL_ERROR'); }
      }
      this.publish({id: m.id, ...r});
    } catch (error) {
      if (error.code === 'IDENTITY_MISMATCH') group.block(error.code, {durable: true});
      const e = safeError(error); this.publish({id: m.id, error: {code: -32000, message: `${e.code}: ${e.message}`}});
    } finally {
      if (work) { this.inFlight--; if (!NON_WORK.has(m.method) && !AUTH_WRITES.test(m.method) && m.method !== 'turn/interrupt') this.inFlightWork = Math.max(0, this.inFlightWork - 1); }
      if (counted) this.accepting--;
    }
  }
  switchAccount(...args) { return this.coordinator.switchAccount(...args); }
  recover(...args) { return this.coordinator.recover(...args); }
  cancel() { return this.coordinator.cancel(); }
  usage() { return this.coordinator.usage(); }
  async dispose() { this.disposed = true; await this.rpc.close(); this.coordinator.detached(this); }
}

function install({app, ipcMain, BrowserWindow, check, trustedContent, executable, accountsDirectory,
  defaultHome, currentProfileId, storageDirectory, enabled = true, spawnProcess = childProcess.spawn}) {
  if (globalThis[INSTALL]) return globalThis[INSTALL];
  const previousSpawn = childProcess.spawn, rawSpawn = spawnProcess; let workspace = null, lastAttachmentError = null;
  const profiles = new ProfileStore({accountsDirectory, defaultHome, currentProfileId});
  function changed() {
    for (const w of BrowserWindow.getAllWindows()) try {
      if (!w.isDestroyed() && trustedContent(w.webContents)) w.webContents.send('codex-labels:session-switcher-changed');
    } catch {}
  }
  function wrappedSpawn(command, args, options) {
    const argv = Array.isArray(args) ? args : [], opts = Array.isArray(args) ? options || {} : args || {};
    const candidate = enabled && typeof command === 'string' && samePath(command, executable) && argv.includes('app-server') &&
      !argv.some(a => ['generate-ts', 'generate-json-schema', '--help', '-h', '--version'].includes(a));
    if (!candidate) return Reflect.apply(rawSpawn, this, arguments);
    const listenAt = argv.indexOf('--listen');
    const listen = listenAt >= 0 ? argv[listenAt + 1] : argv.find(a => a.startsWith('--listen='))?.slice(9);
    // A work-capable transport must never escape through an unwrapped path.
    if (opts.shell === true || (listen !== undefined && listen !== 'stdio://') || (listenAt >= 0 && listen === undefined)) fail('UNSUPPORTED');
    const home = fs.realpathSync(opts.env?.CODEX_HOME || process.env.CODEX_HOME || defaultHome);
    if (workspace && !samePath(home, workspace.home)) fail('INVALID_ARGUMENT');
    if (!workspace) {
      if (!currentProfileId) profiles.defaultHome = home;
      workspace = new WorkspaceCoordinator({home, profiles, storageDirectory}); workspace.on('changed', changed);
    }
    const child = Reflect.apply(rawSpawn, this, arguments);
    try {
      new WorkspaceConnection({child, home, profiles, storageDirectory, coordinator: workspace});
      lastAttachmentError = null;
    } catch (e) {
      lastAttachmentError = safeError(e);
      // Attachment failure is not a second-spawn policy. Healthy siblings remain
      // owned. This unusable child's actual exit must be verified before resume.
      workspace.block('CLEANUP_FAILED', {durable: true});
      child.on('error', () => {}); child.stdin?.on('error', () => {}); child.stdin?.end(); child.kill();
    }
    return child;
  }
  if (enabled) { childProcess.spawn = wrappedSpawn; syncBuiltinESMExports(); }
  const connected = () => { if (!workspace || !workspace.live().length) fail('NOT_ATTACHED'); return workspace; };
  const handle = (channel, action) => ipcMain.handle(channel, async (event, value) => {
    check(event); try { return {ok: true, value: await action(value)}; } catch (e) { return {ok: false, error: safeError(e)}; }
  });
  handle('codex-labels:session-switcher-status', () => ({scope: 'workspace', enabled, attached: !!workspace?.live().length,
    profiles: profiles.list(), state: workspace?.snapshot() || null, error: lastAttachmentError}));
  handle('codex-labels:session-switcher-inspect', () => connected().snapshot());
  handle('codex-labels:session-switcher-switch', value => {
    if (!value || Object.hasOwn(value, 'threadId')) fail('INVALID_ARGUMENT');
    return connected().switchAccount(value.profileId, {confirmContextTransfer: value.confirmContextTransfer === true});
  });
  handle('codex-labels:session-switcher-cancel', () => connected().cancel());
  handle('codex-labels:session-switcher-usage', () => connected().usage());
  handle('codex-labels:session-switcher-recover', value => connected().recover({confirmContextTransfer: value?.confirmContextTransfer === true}));
  let quitting = false;
  const beforeQuit = event => {
    if (quitting || !workspace) return; event.preventDefault(); quitting = true;
    workspace.dispose().then(() => app.quit(), () => { quitting = false; changed(); });
  };
  app.on('before-quit', beforeQuit);
  const api = {dispose: async () => {
    await workspace?.dispose();
    if (childProcess.spawn === wrappedSpawn) { childProcess.spawn = previousSpawn; syncBuiltinESMExports(); }
    app.off('before-quit', beforeQuit); delete globalThis[INSTALL];
  }};
  globalThis[INSTALL] = api; return api;
}
module.exports = {install, WorkspaceGateway, SelectionStore, WorkspaceCoordinator, WorkspaceConnection};
