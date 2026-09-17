'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {createSnapshotCache} = require('./snapshot-cache.cjs');
function harness(t, options = {}) {
  let reads = 0, value = {configRevision: 'first'}, listener;
  const watcher = new EventEmitter(); watcher.close = () => { watcher.closed = true; };
  const store = {snapshot() { reads++; if (value instanceof Error) throw value; return value; }};
  const cache = createSnapshotCache(store, '/fixture', {watch: (_dir, _options, fn) => { listener = fn; return watcher; }, ...options});
  t.after(() => cache.close());
  return {cache, watcher, get reads() { return reads; }, change: (name, next) => { value = next; listener('rename', name); }};
}
test('100 unchanged renderer reads share one store snapshot', t => {
  const h = harness(t), first = h.cache.snapshot();
  assert.equal(typeof first.snapshotVersion, 'string');
  for (let i = 0; i < 100; i++) assert.equal(h.cache.snapshot(first.snapshotVersion), null);
  assert.equal(h.reads, 1);
});
test('identical refreshes keep their version while assignments and config errors change it', t => {
  const h = harness(t);
  const initial = {configRevision: 'same', configError: null, assignments: {}};
  h.change('labels.json', initial);
  const first = h.cache.snapshot();
  h.change('labels.json', {...initial, assignments: {}});
  assert.equal(h.cache.snapshot(first.snapshotVersion), null);
  h.change('assignments.json', {...initial, assignments: {'thread:one': 'review'}});
  const assigned = h.cache.snapshot(first.snapshotVersion);
  assert.notEqual(assigned.snapshotVersion, first.snapshotVersion);
  h.change('labels.json', {...initial, assignments: assigned.assignments, configError: 'invalid config'});
  const invalid = h.cache.snapshot(assigned.snapshotVersion);
  assert.notEqual(invalid.snapshotVersion, assigned.snapshotVersion);
  assert.equal(invalid.configError, 'invalid config');
  h.change('labels.json', {...initial, assignments: assigned.assignments});
  const recovered = h.cache.snapshot(invalid.snapshotVersion);
  assert.equal(recovered.configError, null);
  assert.notEqual(recovered.snapshotVersion, invalid.snapshotVersion);
});
test('store write snapshots are reused without another store read', t => {
  const h = harness(t), first = h.cache.snapshot();
  const saved = h.cache.update({configRevision: 'saved', assignments: {'thread:one': 'review'}});
  assert.notEqual(saved.snapshotVersion, first.snapshotVersion);
  assert.equal(h.cache.snapshot(), saved);
  assert.equal(h.cache.snapshot(saved.snapshotVersion), null);
  assert.equal(h.reads, 1);
});
test('atomic config and assignment replacements invalidate the shared cache', t => {
  const h = harness(t); h.cache.snapshot();
  h.change('labels.json', {configRevision: 'second'});
  assert.equal(h.cache.snapshot().configRevision, 'second');
  h.change(Buffer.from('assignments.json'), {configRevision: 'third'});
  assert.equal(h.cache.snapshot().configRevision, 'third'); assert.equal(h.reads, 3);
});
test('diagnostic writes and temporary files do not invalidate the cache', t => {
  const h = harness(t); h.cache.snapshot();
  for (const name of ['runtime-status.json', 'runtime-status.123.json', 'labels.json.tmp-123', 'labels.json.bak']) h.change(name, {});
  h.cache.snapshot(); assert.equal(h.reads, 1);
});
test('missed watcher events have a bounded-age fallback', t => {
  let time = 0; const h = harness(t, {now: () => time, maxAgeMs: 10}); h.cache.snapshot();
  time = 9; h.cache.snapshot(); assert.equal(h.reads, 1);
  time = 10; h.cache.snapshot(); assert.equal(h.reads, 2);
});
test('invalid state remains an error and is retried on recovery', t => {
  const h = harness(t), first = h.cache.snapshot(); h.change(null, Error('damaged assignment'));
  assert.throws(() => h.cache.snapshot(first.snapshotVersion), /damaged assignment/);
  assert.throws(() => h.cache.snapshot(first.snapshotVersion), /damaged assignment/);
  h.change(null, {configRevision: 'first'});
  assert.equal(h.cache.snapshot(first.snapshotVersion), null);
});
test('watch creation failure still permits cache reads and bounded-age refresh', t => {
  let time = 0, reads = 0;
  const cache = createSnapshotCache({snapshot: () => ({count: ++reads})}, '/fixture', {now: () => time, maxAgeMs: 5, watch() { throw Error('no watcher'); }});
  t.after(() => cache.close()); assert.equal(cache.snapshot().count, 1); time = 6; assert.equal(cache.snapshot().count, 2);
});
test('watcher errors close only the watcher and disposal removes resources', t => {
  const h = harness(t); h.watcher.emit('error', Error('unavailable'));
  assert.equal(h.watcher.closed, true); assert.doesNotThrow(() => h.cache.snapshot());
  h.cache.close(); assert.throws(() => h.cache.snapshot(), /종료/);
  assert.throws(() => h.cache.update({}), /종료/);
});
test('watch and local-write bursts coalesce and close cancels pending change signals', async t => {
  let changes = 0;
  const h = harness(t, {onChange: () => changes++});
  h.change('labels.json', {configRevision: 'changed'});
  h.change('assignments.json', {configRevision: 'changed'});
  h.cache.update({configRevision: 'saved'});
  await new Promise(resolve => setTimeout(resolve, 130));
  assert.equal(changes, 1);
  h.cache.invalidate(); h.cache.close();
  await new Promise(resolve => setTimeout(resolve, 130));
  assert.equal(changes, 1);
});
