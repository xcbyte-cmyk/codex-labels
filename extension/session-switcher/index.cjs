'use strict';
// Workspace-wide account switching: ONE server, ONE unchanged CODEX_HOME.
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
    if (['selected', 'pending'].includes(v.status) && (!PROFILE_ID.test(v.profile?.id) || typeof v.profile?.name !== 'string' ||
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

function install({app, ipcMain, BrowserWindow, check, trustedContent, executable, accountsDirectory,
  defaultHome, currentProfileId, storageDirectory, enabled = true}) {
  if (globalThis[INSTALL]) return globalThis[INSTALL];
  const rawSpawn = childProcess.spawn; let gateway = null, startError = null;
  const profiles = new ProfileStore({accountsDirectory, defaultHome, currentProfileId});
  function changed() {
    for (const w of BrowserWindow.getAllWindows()) try {
      if (!w.isDestroyed() && trustedContent(w.webContents)) w.webContents.send('codex-labels:session-switcher-changed');
    } catch {}
  }
  function wrappedSpawn(command, args, options) {
    const argv = Array.isArray(args) ? args : [], opts = Array.isArray(args) ? options || {} : args || {};
    const candidate = enabled && typeof command === 'string' && samePath(command, executable) && argv.includes('app-server') &&
      (!argv.includes('--listen') || argv.includes('stdio://')) && opts.shell !== true;
    const child = Reflect.apply(rawSpawn, this, arguments);
    if (!candidate) return child;
    try {
      if (gateway && !gateway.rpc.closed) fail('UNSUPPORTED');
      const home = opts.env?.CODEX_HOME || process.env.CODEX_HOME || defaultHome;
      // Default credential profile must follow a custom CODEX_HOME as well.
      if (!currentProfileId) profiles.defaultHome = fs.realpathSync(home);
      gateway = new WorkspaceGateway({child, home, profiles, storageDirectory});
      startError = null; gateway.on('changed', changed);
    } catch (e) {
      startError = safeError(e); child.on('error', () => {}); child.stdin?.on('error', () => {}); child.stdin?.end(); child.kill();
    }
    return child;
  }
  if (enabled) { childProcess.spawn = wrappedSpawn; syncBuiltinESMExports(); }
  const connected = () => { if (!gateway || gateway.rpc.closed || startError) fail('NOT_ATTACHED'); return gateway; };
  const handle = (channel, action) => ipcMain.handle(channel, async (event, value) => {
    check(event); try { return {ok: true, value: await action(value)}; } catch (e) { return {ok: false, error: safeError(e)}; }
  });
  handle('codex-labels:session-switcher-status', () => ({scope: 'workspace', enabled, attached: !!gateway && !gateway.rpc.closed && !startError,
    profiles: profiles.list(), state: gateway?.snapshot() || null, error: startError}));
  handle('codex-labels:session-switcher-inspect', () => connected().snapshot());
  handle('codex-labels:session-switcher-switch', value => {
    if (!value || Object.hasOwn(value, 'threadId')) fail('INVALID_ARGUMENT');
    return connected().switchAccount(value.profileId, {confirmContextTransfer: value.confirmContextTransfer === true});
  });
  handle('codex-labels:session-switcher-cancel', () => connected().cancel());
  handle('codex-labels:session-switcher-usage', () => connected().usage());
  handle('codex-labels:session-switcher-recover', value => connected().recover({confirmContextTransfer: value?.confirmContextTransfer === true}));
  let quitting = false;
  app.on('before-quit', event => {
    if (quitting || !gateway) return; event.preventDefault(); quitting = true;
    gateway.dispose().finally(() => app.quit()).catch(() => {});
  });
  const api = {dispose: async () => {
    if (childProcess.spawn === wrappedSpawn) { childProcess.spawn = rawSpawn; syncBuiltinESMExports(); }
    await gateway?.dispose(); delete globalThis[INSTALL];
  }};
  globalThis[INSTALL] = api; return api;
}
module.exports = {install, WorkspaceGateway, SelectionStore};
