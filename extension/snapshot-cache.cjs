'use strict';
const fs = require('node:fs');
// One cache per main process, not one disk reader per renderer/window.
// Directory watching survives atomic file replacement. A bounded-age read is the
// fallback for missed events; save/assign still validate the current disk state.
function createSnapshotCache(store, directory, {maxAgeMs = 5000, now = Date.now,
  watch = fs.watch, onChange = () => {}} = {}) {
  let value, dirty = true, readAt = 0, closed = false, watcher, timer;
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
    snapshot() {
      if (closed) throw new Error('설정 캐시가 종료되었습니다.');
      if (!value || dirty || now() - readAt >= maxAgeMs) {
        // Do not make a corrupt assignment file look like a successful read.
        const next = store.snapshot(); value = next; readAt = now(); dirty = false;
      }
      return value;
    },
    invalidate,
    close() { closed = true; clearTimeout(timer); watcher?.close(); }
  };
}
module.exports = {createSnapshotCache};
