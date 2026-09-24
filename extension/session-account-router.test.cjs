'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {SessionAccountRouter, AccountRouterError} = require('./session-account-router.cjs');

const SID = 'logical-session-21';
const A = {id:'a'.repeat(32), name:'개인', identity:{accountId:'acct-A', userId:'user-A', workspaceId:null}};
const B = {id:'b'.repeat(32), name:'업무', identity:{accountId:'acct-B', userId:'user-B', workspaceId:'workspace-B'}};
const consent = {confirmContextTransfer:true};
const zero = () => ({runningTurns:0,pendingToolCalls:0,pendingApprovals:0,runningCommands:0});
const deferred = () => { let resolve, reject; const promise = new Promise((a,b)=>{resolve=a;reject=b}); return {promise,resolve,reject}; };

function backend(account, overrides={}) {
  const state = {identity:structuredClone(account.identity), activity:zero(), closes:0, restored:null};
  return Object.assign({
    capabilities:{protocolVersion:1,isolatedCredentials:true,identityPinned:true,passiveRestore:true,fullActivity:true},
    state,
    async getIdentity(){ return state.identity; },
    async getActivity(){ return state.activity; },
    async checkpoint(){ return {version:1,logicalSessionId:SID,payload:{messages:[{role:'user',text:'continue'}]}}; },
    async restore(value){ state.restored=value; return {restored:true,logicalSessionId:SID}; },
    async runTurn(input){ return {account:account.id,input}; },
    async readUsage(){ return {rateLimits:{limitId:'codex',primary:{usedPercent:25,windowDurationMins:300,resetsAt:1900000000}}}; },
    async close(){ state.closes++; },
  }, overrides);
}

async function fixture({a=backend(A), b=backend(B), createBackend}={}) {
  const router = await SessionAccountRouter.create({
    logicalSessionId:SID, initialProfile:A, initialBackend:a, exclusiveSessionOwner:true,
    resolveProfile: async id => id === B.id ? B : A,
    createBackend: createBackend || (async () => b),
  });
  return {router,a,b};
}
async function rejectsCode(promise, code) {
  await assert.rejects(promise, error => error instanceof AccountRouterError && error.code === code);
}

test('successful switch preserves logical session and routes only future turns to target', async () => {
  const {router,a,b} = await fixture();
  assert.equal((await router.runTurn('before')).account, A.id);
  const result = await router.switchAccount(B.id, consent);
  assert.equal(result.committed, true);
  assert.equal(result.state.logicalSessionId, SID);
  assert.equal(result.state.activeProfile.id, B.id);
  assert.equal(a.state.closes, 1);
  assert.deepEqual(b.state.restored.payload.messages, [{role:'user',text:'continue'}]);
  assert.equal((await router.runTurn('after')).account, B.id);
});

test('cross-account context transfer requires explicit consent', async () => {
  const {router,b} = await fixture();
  await rejectsCode(router.switchAccount(B.id), 'CONTEXT_CONSENT_REQUIRED');
  assert.equal(b.state.restored, null);
});

test('target identity mismatch fails before context checkpoint is transferred', async () => {
  const a = backend(A), b = backend(B);
  b.state.identity.accountId = 'wrong';
  let checkpointed = false;
  a.checkpoint = async () => { checkpointed = true; return {version:1,logicalSessionId:SID,payload:{}}; };
  const {router} = await fixture({a,b});
  await rejectsCode(router.switchAccount(B.id, consent), 'TARGET_IDENTITY_MISMATCH');
  assert.equal(checkpointed, false);
  assert.equal(b.state.closes, 1);
  assert.equal(router.snapshot().activeProfile.id, A.id);
});

test('pending approvals/tools/commands block account switching', async () => {
  for (const key of ['runningTurns','pendingToolCalls','pendingApprovals','runningCommands']) {
    const a = backend(A);
    const {router} = await fixture({a});
    a.state.activity[key] = 1;
    await rejectsCode(router.switchAccount(B.id, consent), 'SOURCE_NOT_IDLE');
    assert.equal(router.snapshot().phase, 'blocked');
  }
});

test('restore failure keeps source active and disposes target', async () => {
  const b = backend(B, {async restore(){ throw Error('secret token'); }});
  const {router,a} = await fixture({b});
  await rejectsCode(router.switchAccount(B.id, consent), 'SWITCH_FAILED');
  assert.equal(router.snapshot().activeProfile.id, A.id);
  assert.equal(a.state.closes, 0);
  assert.equal(b.state.closes, 1);
  assert.equal((await router.runTurn('still-a')).account, A.id);
});

test('cancelled late backend creation closes eventual candidate and never commits it', async () => {
  const gate = deferred(), started = deferred(), b = backend(B);
  const {router} = await fixture({b,createBackend:async()=>{started.resolve(); return gate.promise;}});
  const switching = router.switchAccount(B.id, consent);
  await started.promise;
  assert.equal(router.cancelSwitch(), true);
  gate.resolve(b);
  await rejectsCode(switching, 'CANCELLED');
  assert.equal(b.state.closes, 1);
  assert.equal(router.snapshot().activeProfile.id, A.id);
});

test('turn errors are not replayed on another account', async () => {
  let runs = 0;
  const a = backend(A, {async runTurn(){ runs++; throw Error('model failed'); }});
  const {router,b} = await fixture({a});
  await rejectsCode(router.runTurn('billable'), 'TURN_FAILED');
  assert.equal(runs, 1);
  assert.equal(b.state.restored, null);
  assert.equal(router.snapshot().activeProfile.id, A.id);
});

test('usage is display-only metadata and is cleared on account commit', async () => {
  const {router} = await fixture();
  const usage = await router.refreshUsage();
  assert.equal(usage.primary.usedPercent, 25);
  assert.equal(usage.primary.label, '5시간');
  await router.switchAccount(B.id, consent);
  assert.equal(router.snapshot().usage, null);
});

test('post-commit source cleanup failure reports target active but blocks requests until recovery', async () => {
  let failClose = true;
  const a = backend(A, {async close(){ a.state.closes++; if (failClose) throw Error('busy'); }});
  const {router} = await fixture({a});
  const result = await router.switchAccount(B.id, consent);
  assert.equal(result.committed, true);
  assert.equal(result.cleanupComplete, false);
  assert.equal(result.state.activeProfile.id, B.id);
  assert.equal(result.state.phase, 'blocked');
  await rejectsCode(router.runTurn('blocked'), 'BLOCKED');
  failClose = false;
  await router.recover();
  assert.equal(router.snapshot().phase, 'idle');
  assert.equal((await router.runTurn('ok')).account, B.id);
});
