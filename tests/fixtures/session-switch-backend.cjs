'use strict';
// Synthetic local JSON-RPC server. Never contacts a service or reads real credentials.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const home = process.argv[2], behavior = JSON.parse(process.argv[3] || '{}');
let account = 'a', active = false;
const loaded = new Set();
const send = m => process.stdout.write(JSON.stringify(m) + '\n');
const event = (method, params) => send({method, params});
function thread(id) {
  return {id, turns: behavior.badHistory ? [{id:'wrong-turn',status:'completed',items:[]}] : [], ephemeral: !!behavior.ephemeral, status: {type: active ? 'active' : 'idle'},
    path: path.join(home, 'sessions', `${id}.json`)};
}
function result(id) { return {thread: thread(id), model: 'fixture-model', modelProvider: 'openai', cwd: home,
  approvalPolicy: 'on-request', sandbox: {type: 'workspaceWrite'}}; }
readline.createInterface({input: process.stdin}).on('line', async line => {
  const m = JSON.parse(line), p = m.params || {};
  if (!m.method) return;
  if (behavior.delay && m.method === 'account/login/start') await new Promise(r => setTimeout(r, behavior.delay));
  if (behavior.reject === m.method) { send({id: m.id, error: {code: -32601, message: 'SYNTHETIC_SECRET_MUST_NOT_LEAK'}}); return; }
  let r;
  switch (m.method) {
    case 'initialize': r = {userAgent: 'fixture', experimental: p.capabilities?.experimentalApi}; break;
    case 'initialized': return;
    case 'account/login/start': account = p.accessToken; r = {type: 'chatgptAuthTokens'}; break;
    case 'account/read': r = {account: {type: 'chatgpt', email: `${behavior.badIdentity ? 'wrong' : account}@example.test`, planType: 'plus'}}; break;
    case 'account/rateLimits/read': r = {rateLimits: {primary: {usedPercent: account === 'b' ? 12 : 70, windowDurationMins: 300, resetsAt: 2000000000}}}; break;
    case 'thread/start': {
      const id = 'local-1'; loaded.add(id); fs.mkdirSync(path.join(home, 'sessions'), {recursive:true});
      fs.writeFileSync(path.join(home, 'sessions', `${id}.json`), JSON.stringify({id})); r = result(id); break;
    }
    case 'thread/loaded/list': r = {data: behavior.unknownThread ? ['unknown'] : [...loaded], nextCursor: behavior.more ? 'next' : null}; break;
    case 'thread/read': r = {thread: thread(p.threadId)}; break;
    case 'thread/backgroundTerminals/list': r = {data: behavior.background ? [{id:'process-1'}] : [], nextCursor: null}; break;
    case 'thread/resume': loaded.add(p.threadId); r = result(behavior.badRestore ? 'wrong-id' : p.threadId); break;
    case 'turn/start': {
      active = true; event('turn/started', {threadId:p.threadId, turn:{id:'turn-1'}});
      r = {turn:{id:'turn-1'}, fixtureAccount:account};
      setTimeout(() => { active = false; event('turn/completed', {threadId:p.threadId, turn:{id:'turn-1'}}); }, behavior.turnDelay || 10);
      break;
    }
    case 'fixture/approval': event('item/tool/requestUserInput', {threadId:'local-1'}); send({id: 'approval-1', method:'item/tool/requestUserInput',params:{threadId:'local-1'}}); r = {}; break;
    default: r = {};
  }
  if (Object.hasOwn(m,'id')) send({id:m.id,result:r});
});
