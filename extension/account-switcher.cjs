'use strict';
const path = require('node:path');
const childProcess = require('node:child_process');
const {syncBuiltinESMExports} = require('node:module');
const {SessionRouter} = require('./account-session-router.cjs');
const {createProfiles, failure} = require('./account-switch-profiles.cjs');

function normalizeUsage(reply) {
  function window(value) {
    if (!value || !Number.isFinite(value.usedPercent) || value.usedPercent < 0 || value.usedPercent > 100 ||
        !Number.isFinite(value.windowDurationMins) || value.windowDurationMins <= 0) return null;
    return {usedPercent: value.usedPercent, windowDurationMins: value.windowDurationMins,
      resetsAt: Number.isSafeInteger(value.resetsAt) ? value.resetsAt : null};
  }
  const value = reply?.rateLimitsByLimitId?.codex || reply?.rateLimits;
  return {primary: window(value?.primary), secondary: window(value?.secondary), checkedAt: new Date().toISOString()};
}
function supportedSpawn(file, args, options, executable, home) {
  if (typeof file !== 'string' || path.resolve(file) !== path.resolve(executable) || !Array.isArray(args) || args[0] !== 'app-server') return false;
  if (options?.shell || args.some(a => typeof a !== 'string' || a.includes('cli_auth_credentials_store'))) return false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--listen' && args[++i] !== 'stdio://') return false;
    if (args[i]?.startsWith('--listen=') && args[i] !== '--listen=stdio://') return false;
  }
  if (options?.stdio !== undefined && options.stdio !== 'pipe' && !(Array.isArray(options.stdio) && options.stdio.length === 3 && options.stdio.every(s => s === 'pipe'))) return false;
  const env = options?.env || process.env;
  return typeof env.CODEX_HOME === 'string' && path.resolve(env.CODEX_HOME) === path.resolve(home) &&
    (!env.CODEX_SQLITE_HOME || path.resolve(env.CODEX_SQLITE_HOME) === path.resolve(home));
}
function install({ipcMain, check, accountProfile, executable, getWindows, trustedContent, processModule = childProcess}) {
  const profiles = createProfiles(path.dirname(path.dirname(accountProfile.directory)));
  const originalSpawn = processModule.spawn, channels = [], usageCache = new Map();
  let router = null, disposed = false, timer;
  const unavailable = () => ({available: false, phase: 'unavailable', profileId: accountProfile.id, busy: false, experimental: true});
  function state() { return router?.state() || unavailable(); }
  function broadcast() {
    if (timer || disposed) return;
    timer = setTimeout(() => {
      timer = null;
      for (const window of getWindows()) {
        try { if (!window.isDestroyed() && trustedContent(window.webContents)) window.webContents.send('codex-labels:account-state', state()); } catch {}
      }
    }, 100); timer.unref?.();
  }
  function wrappedSpawn(file, args, options) {
    if (disposed || !supportedSpawn(file, args, options, executable, accountProfile.home)) return originalSpawn.call(processModule, file, args, options);
    if (router) {
      router.unsafe = true; router.changed(); // Multiple local engines require explicit multi-engine coordination.
      return originalSpawn.call(processModule, file, args, options);
    }
    const initialOptions = {...options, env: {...(options?.env || process.env)}};
    router = new SessionRouter({profileId: accountProfile.id, home: accountProfile.home,
      credential: id => profiles.credential(id),
      spawnBackend: ({candidate = false} = {}) => originalSpawn.call(processModule, file,
        candidate ? ['-c', 'cli_auth_credentials_store="ephemeral"', ...args] : [...args],
        {...initialOptions, env: {...initialOptions.env}})});
    router.on('state', broadcast); broadcast(); return router;
  }
  processModule.spawn = wrappedSpawn;
  if (processModule === childProcess) syncBuiltinESMExports();
  function handle(name, fn) {
    const channel = `codex-labels:${name}`; channels.push(channel);
    ipcMain.handle(channel, async (event, ...args) => {
      check(event); if (disposed) throw failure('BACKEND_UNAVAILABLE');
      try { return await fn(...args); }
      catch (error) {
        const allowed = ['INVALID_PROFILE','UNSAFE_PROFILE','PROFILE_REMOVING','SIGN_IN_REQUIRED','CONSENT_REQUIRED',
          'SWITCH_IN_PROGRESS','BACKEND_UNAVAILABLE','WORK_IN_PROGRESS','UNSUPPORTED_SESSION','BACKGROUND_TERMINALS',
          'BACKEND_REQUEST_FAILED','BACKEND_TIMEOUT','BACKEND_EXITED','IDENTITY_MISMATCH','USAGE_UNAVAILABLE','RESTORE_FAILED'];
        throw failure(allowed.includes(error.code) ? error.code : 'SWITCH_FAILED');
      }
    });
  }
  handle('accounts-list', () => ({state: state(), profiles: profiles.list().map(p => ({...p, usage: usageCache.get(p.id) || null}))}));
  handle('account-usage', async id => {
    profiles.read(id); if (!router) throw failure('BACKEND_UNAVAILABLE');
    const result = await router.usage(id), usage = normalizeUsage(result.usage);
    usageCache.set(id, usage); return {profileId: id, usage};
  });
  handle('account-switch', async value => {
    if (!value || value.consent !== true) throw failure('CONSENT_REQUIRED');
    profiles.read(value.profileId); if (!router) throw failure('BACKEND_UNAVAILABLE');
    const result = await router.switchTo(value.profileId), usage = normalizeUsage(result.usage);
    usageCache.set(value.profileId, usage);
    return {state: state(), usage, resumedThreads: result.resumedThreads};
  });
  return {state, dispose() {
    disposed = true; clearTimeout(timer);
    for (const channel of channels) ipcMain.removeHandler(channel);
    if (processModule.spawn === wrappedSpawn) { processModule.spawn = originalSpawn; if (processModule === childProcess) syncBuiltinESMExports(); }
    router?.kill();
  }};
}
module.exports = {install, supportedSpawn, normalizeUsage};
