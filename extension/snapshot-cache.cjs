'use strict';
const fs = require('node:fs');
const {randomUUID} = require('node:crypto');
const {isDeepStrictEqual} = require('node:util');
// One cache per main process, not one disk reader per renderer/window.
// Directory watching survives atomic file replacement. A bounded-age read is the
// fallback for missed events; save/assign still validate the current disk state.
function createSnapshotCache(store, directory, {maxAgeMs = 5000, now = Date.now,
  watch = fs.watch, onChange = () => {}} = {}) {
  let value, source, dirty = true, readAt = 0, closed = false, watcher, timer;
  const ensureOpen = () => { if (closed) throw new Error('설정 캐시가 종료되었습니다.'); };
  const accept = next => {
    // Compare only after a disk refresh/write, never for each renderer request.
    // Include every observable field, including configError and assignments.
    if (!value || !isDeepStrictEqual(source, next)) {
      source = next;
      value = {...next, snapshotVersion: randomUUID()};
    }
    readAt = now(); dirty = false;
    return value;
  };
  const invalidate = () => {
    if (closed) return;
    dirty = true;
    if (!timer) {
      timer = setTimeout(() => { timer = undefined; if (!closed) onChange(); }, 100);
      timer.unref?.();
    }
  };
  try {
    watcher = watch(directory, {persistent: false}, (_event, filename) => {
      if (filename === null || filename === undefined || ['labels.json', 'assignments.json'].includes(String(filename))) invalidate();
    });
    watcher.on('error', () => { const failed = watcher; watcher = undefined; failed?.close(); invalidate(); });
  } catch { /* The bounded-age fallback remains available. */ }
  return {
    snapshot(knownVersion) {
      ensureOpen();
      if (!value || dirty || now() - readAt >= maxAgeMs) {
        // Do not make a corrupt assignment file look like a successful read.
        accept(store.snapshot());
      }
      return knownVersion === value.snapshotVersion ? null : value;
    },
    // Store writes already return validated snapshots. Reuse them, but notify
    // every renderer so another window can conditionally request the change.
    update(next) { ensureOpen(); invalidate(); return accept(next); },
    invalidate,
    close() { closed = true; clearTimeout(timer); watcher?.close(); }
  };
}
module.exports = {createSnapshotCache};
