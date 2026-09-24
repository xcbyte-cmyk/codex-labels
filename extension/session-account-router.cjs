'use strict';

// Issue #21: opt-in, backend-independent transaction core. NOT connected to
// Electron or the bundled Codex app-server yet. See docs/session-account-router.md.
const {normalizeRateLimits} = require('./account-usage.cjs');
const PROFILE_ID = /^[0-9a-f]{32}$/;
const METHODS = ['getIdentity', 'getActivity', 'checkpoint', 'restore', 'runTurn', 'readUsage', 'close'];
const COUNTERS = ['runningTurns', 'pendingToolCalls', 'pendingApprovals', 'runningCommands'];
const MESSAGES = Object.freeze({
  INVALID_ARGUMENT: 'Invalid router argument.', UNSUPPORTED_BACKEND: 'Backend contract is not supported.',
  BUSY: 'Wait for the current operation to settle.', BLOCKED: 'The router needs explicit recovery.',
  DISPOSED: 'The router has been closed.', CONTEXT_CONSENT_REQUIRED: 'Confirm transfer of this session to the target account.',
  CANCELLED: 'The account switch was cancelled.', SWITCH_FAILED: 'The account switch failed.',
  SOURCE_IDENTITY_MISMATCH: 'The active account identity changed; requests are blocked.',
  TARGET_IDENTITY_MISMATCH: 'The target account did not match the selected identity.',
  SOURCE_NOT_IDLE: 'The current backend is not confirmed idle.', TARGET_NOT_IDLE: 'The target backend is not confirmed idle.',
  INVALID_CHECKPOINT: 'The local session checkpoint is invalid.', RESTORE_FAILED: 'The target did not confirm session restoration.',
  CLEANUP_FAILED: 'A backend has not confirmed shutdown.', TURN_FAILED: 'The turn failed; it was not retried on another account.',
  USAGE_FAILED: 'Usage could not be verified.', RECOVERY_FAILED: 'Recovery did not establish a safe state.',
});

class AccountRouterError extends Error {
  constructor(code) { super(MESSAGES[code] || MESSAGES.SWITCH_FAILED); this.name = 'AccountRouterError'; this.code = code; }
}
function fail(code) { throw new AccountRouterError(code); }
function text(value, max = 256) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
}
function identity(value) {
  if (!value || !text(value.accountId) || !text(value.userId) ||
      !(value.workspaceId === null || text(value.workspaceId))) fail('INVALID_ARGUMENT');
  // Whitelist fields. Credentials / raw backend errors never enter public state.
  return Object.freeze({accountId: value.accountId, userId: value.userId, workspaceId: value.workspaceId});
}
function sameIdentity(left, right) {
  return left.accountId === right.accountId && left.userId === right.userId && left.workspaceId === right.workspaceId;
}
function profile(value) {
  if (!value || (typeof value.id !== 'string' || !PROFILE_ID.test(value.id)) || !text(value.name, 40) || !value.name.trim()) fail('INVALID_ARGUMENT');
  return Object.freeze({id: value.id, name: value.name, identity: identity(value.identity)});
}
function checkBackend(backend) {
  const c = backend?.capabilities;
  if (!c || c.protocolVersion !== 1 || c.isolatedCredentials !== true || c.identityPinned !== true ||
      c.passiveRestore !== true || c.fullActivity !== true || METHODS.some(key => typeof backend[key] !== 'function')) {
    fail('UNSUPPORTED_BACKEND');
  }
}
async function verifyIdentity(backend, expected, side) {
  let observed;
  try { observed = identity(await backend.getIdentity()); }
  catch { fail(`${side}_IDENTITY_MISMATCH`); }
  if (!sameIdentity(observed, expected)) fail(`${side}_IDENTITY_MISMATCH`);
}
async function verifyIdle(backend, side) {
  let activity;
  try { activity = await backend.getActivity(); } catch { fail(`${side}_NOT_IDLE`); }
  if (!activity || COUNTERS.some(key => !Number.isSafeInteger(activity[key]) || activity[key] !== 0)) fail(`${side}_NOT_IDLE`);
}
function safeError(error, fallback) {
  return error instanceof AccountRouterError && Object.hasOwn(MESSAGES, error.code)
    ? new AccountRouterError(error.code) : new AccountRouterError(fallback);
}
function readSignal(signal) {
  if (signal !== undefined && !(signal instanceof AbortSignal)) fail('INVALID_ARGUMENT');
  return signal;
}

class SessionAccountRouter {
  #sessionId; #profile; #backend; #resolveProfile; #createBackend;
  #phase = 'idle'; #blockedReason = null; #generation = 0; #usage = null;
  #listeners = new Set(); #pendingClose = new Set(); #controller = null;
  #operationToken = null; #disposeRequested = false;

  static async create({logicalSessionId, initialProfile, initialBackend, resolveProfile, createBackend,
    exclusiveSessionOwner = false} = {}) {
    if (!text(logicalSessionId, 200) || exclusiveSessionOwner !== true || typeof resolveProfile !== 'function' ||
        typeof createBackend !== 'function') fail('INVALID_ARGUMENT');
    const initial = profile(initialProfile);
    checkBackend(initialBackend);
    await verifyIdentity(initialBackend, initial.identity, 'SOURCE');
    await verifyIdle(initialBackend, 'SOURCE');
    return new SessionAccountRouter({logicalSessionId, initial, initialBackend, resolveProfile, createBackend}, CONSTRUCTOR_KEY);
  }

  constructor(options, key) {
    if (key !== CONSTRUCTOR_KEY) fail('INVALID_ARGUMENT');
    this.#sessionId = options.logicalSessionId;
    this.#profile = options.initial;
    this.#backend = options.initialBackend;
    this.#resolveProfile = options.resolveProfile;
    this.#createBackend = options.createBackend;
  }

  snapshot() {
    return Object.freeze({version: 1, logicalSessionId: this.#sessionId,
      activeProfile: Object.freeze({id: this.#profile.id, name: this.#profile.name}),
      generation: this.#generation, phase: this.#phase, blockedReason: this.#blockedReason,
      usage: this.#usage});
  }

  subscribe(listener) {
    if (this.#phase === 'disposed') fail('DISPOSED');
    if (typeof listener !== 'function') fail('INVALID_ARGUMENT');
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit() {
    const state = this.snapshot();
    for (const listener of [...this.#listeners]) { try { listener(state); } catch { /* An observer cannot change commit outcome. */ } }
  }

  #assertIdle() {
    if (this.#phase === 'disposed') fail('DISPOSED');
    if (this.#phase === 'blocked') fail('BLOCKED');
    if (this.#phase !== 'idle') fail('BUSY');
  }

  #block(code) { this.#phase = 'blocked'; this.#blockedReason = code; }

  async #close(backend) {
    // Never release the gate before shutdown has settled. A rejected close is
    // retained for recover(); no fire-and-forget cleanup or late pointer changes.
    try { await backend.close(); this.#pendingClose.delete(backend); return true; }
    catch { this.#pendingClose.add(backend); return false; }
  }

  cancelSwitch() {
    if (!this.#controller || !['switching', 'cancelling'].includes(this.#phase)) return false;
    this.#phase = 'cancelling'; this.#controller.abort(); this.#emit(); return true;
  }

  async switchAccount(profileId, {confirmContextTransfer = false, signal} = {}) {
    this.#assertIdle();
    if (typeof profileId !== 'string' || !PROFILE_ID.test(profileId)) fail('INVALID_ARGUMENT');
    readSignal(signal);
    if (signal?.aborted) fail('CANCELLED');
    if (profileId === this.#profile.id) return Object.freeze({changed: false, committed: false, cleanupComplete: true, state: this.snapshot()});
    if (confirmContextTransfer !== true) fail('CONTEXT_CONSENT_REQUIRED');

    const source = this.#backend, originalProfile = this.#profile;
    const controller = new AbortController();
    this.#controller = controller;
    const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
    const guard = () => { if (combined.aborted) fail('CANCELLED'); };
    let candidate = null, committed = false;
    this.#phase = 'switching'; this.#emit();
    try {
      guard();
      const target = profile(await this.#resolveProfile(profileId));
      guard();
      if (target.id !== profileId) fail('INVALID_ARGUMENT');
      await verifyIdentity(source, originalProfile.identity, 'SOURCE'); guard();
      await verifyIdle(source, 'SOURCE'); guard();
      // Assign BEFORE checking cancellation so a late-created candidate is
      // still owned and closed. The factory must never return a shared backend.
      candidate = await this.#createBackend(target.id, {signal: combined, logicalSessionId: this.#sessionId});
      guard();
      if (candidate === source) { candidate = null; fail('UNSUPPORTED_BACKEND'); }
      checkBackend(candidate);
      await verifyIdentity(candidate, target.identity, 'TARGET'); guard();
      await verifyIdle(candidate, 'TARGET'); guard();
      const checkpoint = await source.checkpoint({signal: combined}); guard();
      if (!checkpoint || checkpoint.version !== 1 || checkpoint.logicalSessionId !== this.#sessionId ||
          !Object.hasOwn(checkpoint, 'payload')) fail('INVALID_CHECKPOINT');
      let detached;
      try { detached = structuredClone({version: 1, logicalSessionId: this.#sessionId, payload: checkpoint.payload}); }
      catch { fail('INVALID_CHECKPOINT'); }
      const restored = await candidate.restore(detached, {signal: combined}); guard();
      if (restored?.restored !== true || restored.logicalSessionId !== this.#sessionId) fail('RESTORE_FAILED');
      await verifyIdentity(candidate, target.identity, 'TARGET'); guard();
      await verifyIdle(candidate, 'TARGET'); guard();
      await verifyIdentity(source, originalProfile.identity, 'SOURCE'); guard();
      await verifyIdle(source, 'SOURCE'); guard();

      // The only commit point. The UI's logicalSessionId never changes. No
      // external callback or await can observe a half-switched identity.
      this.#backend = candidate; this.#profile = target; this.#usage = null;
      this.#generation += 1; committed = true; this.#controller = null;
      const cleanupComplete = await this.#close(source);
      if (!cleanupComplete) this.#block('CLEANUP_FAILED');
      else { this.#phase = 'idle'; this.#blockedReason = null; }
      const outcome = Object.freeze({changed: true, committed: true, cleanupComplete, state: this.snapshot()});
      this.#emit();
      return outcome;
    } catch (error) {
      const safe = safeError(error, combined.aborted ? 'CANCELLED' : 'SWITCH_FAILED');
      // A candidate was never routable before commit; rollback is preserving
      // the original reference, not swapping credential files back and forth.
      if (!committed) {
        const cleanupComplete = !candidate || candidate === source || await this.#close(candidate);
        if (!cleanupComplete) this.#block('CLEANUP_FAILED');
        else if (['SOURCE_IDENTITY_MISMATCH', 'SOURCE_NOT_IDLE'].includes(safe.code)) this.#block(safe.code);
        else { this.#phase = 'idle'; this.#blockedReason = null; }
      }
      this.#emit(); throw safe;
    } finally { if (this.#controller === controller) this.#controller = null; }
  }

  async runTurn(input, {signal, onEvent} = {}) {
    this.#assertIdle(); readSignal(signal);
    if (signal?.aborted) fail('CANCELLED');
    if (onEvent !== undefined && typeof onEvent !== 'function') fail('INVALID_ARGUMENT');
    const backend = this.#backend, token = Symbol('turn');
    this.#operationToken = token; this.#phase = 'running'; this.#emit();
    let result, failure;
    try {
      await verifyIdentity(backend, this.#profile.identity, 'SOURCE');
      await verifyIdle(backend, 'SOURCE');
      if (signal?.aborted) fail('CANCELLED');
      result = await backend.runTurn(input, {signal, onEvent: event => {
        if (this.#backend === backend && this.#operationToken === token && this.#phase === 'running') {
          try { onEvent?.(event); } catch { /* UI failures must not retry model/tool calls. */ }
        }
      }});
    } catch (error) { failure = safeError(error, signal?.aborted ? 'CANCELLED' : 'TURN_FAILED'); }
    finally {
      this.#operationToken = null;
      try {
        await verifyIdentity(backend, this.#profile.identity, 'SOURCE');
        await verifyIdle(backend, 'SOURCE');
        this.#phase = 'idle'; this.#blockedReason = null;
      } catch (error) { const safe = safeError(error, 'SOURCE_NOT_IDLE'); this.#block(safe.code); failure ||= safe; }
      this.#emit();
    }
    if (failure) throw failure;
    return result;
  }

  async refreshUsage({signal} = {}) {
    this.#assertIdle(); readSignal(signal);
    if (signal?.aborted) fail('CANCELLED');
    this.#phase = 'checking'; this.#emit();
    try {
      await verifyIdentity(this.#backend, this.#profile.identity, 'SOURCE');
      const value = await this.#backend.readUsage({signal});
      if (signal?.aborted) fail('CANCELLED');
      await verifyIdentity(this.#backend, this.#profile.identity, 'SOURCE');
      this.#usage = normalizeRateLimits(value);
      return this.#usage;
    } catch (error) {
      const safe = safeError(error, signal?.aborted ? 'CANCELLED' : 'USAGE_FAILED');
      this.#usage = null;
      if (safe.code === 'SOURCE_IDENTITY_MISMATCH') this.#block(safe.code);
      throw safe;
    } finally { if (this.#phase === 'checking') this.#phase = 'idle'; this.#emit(); }
  }

  async recover() {
    if (this.#phase !== 'blocked') fail(this.#phase === 'disposed' ? 'DISPOSED' : 'INVALID_ARGUMENT');
    this.#phase = 'recovering'; this.#emit();
    try {
      for (const backend of [...this.#pendingClose]) if (!await this.#close(backend)) fail('CLEANUP_FAILED');
      if (this.#disposeRequested) {
        this.#phase = 'disposed'; this.#blockedReason = null; this.#usage = null;
        const state = this.snapshot(); this.#emit(); this.#listeners.clear(); return state;
      }
      await verifyIdentity(this.#backend, this.#profile.identity, 'SOURCE');
      await verifyIdle(this.#backend, 'SOURCE');
      this.#phase = 'idle'; this.#blockedReason = null;
      const state = this.snapshot(); this.#emit(); return state;
    } catch (error) { const safe = safeError(error, 'RECOVERY_FAILED'); this.#block(safe.code); this.#emit(); throw safe; }
  }

  async dispose() {
    if (this.#phase === 'disposed') return;
    if (!['idle', 'blocked'].includes(this.#phase)) fail('BUSY');
    this.#disposeRequested = true; this.#phase = 'closing'; this.#emit();
    const targets = new Set([...this.#pendingClose, this.#backend]);
    let complete = true;
    for (const backend of targets) if (!await this.#close(backend)) complete = false;
    if (!complete) { this.#block('CLEANUP_FAILED'); this.#emit(); fail('CLEANUP_FAILED'); }
    this.#phase = 'disposed'; this.#blockedReason = null; this.#usage = null; this.#emit(); this.#listeners.clear();
  }
}
const CONSTRUCTOR_KEY = Symbol('SessionAccountRouter');
module.exports = {SessionAccountRouter, AccountRouterError};
