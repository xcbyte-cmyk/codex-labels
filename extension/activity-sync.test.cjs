'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createActivitySync} = require('./activity-sync.cjs');
const settle = () => new Promise(resolve => setImmediate(resolve));
test('startup follows known owners without resuming, navigating, or duplicating subscriptions', async () => {
  const calls = [], closed = [];
  const controller = {getStreamRole: async () => null,
    retainActiveConversation: async id => { calls.push(id); return {[Symbol.dispose]: () => closed.push(id)}; }};
  const coordination = {findThreadOwner: async ({conversationId}) => conversationId === 'idle' ? null : 'owner'};
  const sync = createActivitySync();
  sync.observe('local', [{id:'working'}, {id:'idle'}], controller, coordination);
  await settle(); sync.observe('local', [{id:'working'}], controller, coordination); await settle();
  assert.deepEqual(calls,['working']); sync.dispose(); assert.deepEqual(closed,['working']);
});
test('in-flight retention is released when window closes and discovery is bounded', async () => {
  let complete, closed = 0, queries = 0;
  const sync = createActivitySync({concurrency:1});
  const controller = {getStreamRole: async () => null, retainActiveConversation: () => new Promise(r => {complete=r;})};
  sync.observe('local', [{id:'one'},{id:'two'}], controller, {findThreadOwner: async () => {queries++;return 'owner';}});
  await settle(); assert.equal(queries,1); sync.dispose();
  complete({[Symbol.dispose]:()=>closed++}); await settle(); assert.equal(closed,1); assert.equal(queries,1);
});
test('a disconnected owner does not block another host and existing roles are untouched', async () => {
  const calls=[]; const sync=createActivitySync({concurrency:1});
  const coordination={findThreadOwner:async({hostId})=>{if(hostId==='offline')throw Error('offline');return 'owner';}};
  const controller={getStreamRole:async id=>id==='owned'?{role:'owner'}:null,
    retainActiveConversation:async id=>{calls.push(id);return {[Symbol.dispose](){}};}};
  sync.observe('offline',[{id:'work'}],controller,coordination);
  sync.observe('local',[{id:'owned'},{id:'work'}],controller,coordination);
  await settle(); assert.deepEqual(calls,['work']); sync.dispose();
});
