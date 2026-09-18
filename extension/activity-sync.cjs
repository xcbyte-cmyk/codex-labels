'use strict';
// Read-only follower subscriptions hydrate activity in other open Codex windows.
// Never resume a thread, claim its writer, mark it read, or navigate the view.
(function(root) {
  function createActivitySync({limit = 48, concurrency = 3, now = Date.now} = {}) {
    const retained = new Map(), queued = new Map(), checked = new Map();
    let working = 0, disposed = false;
    const release = handle => { try { handle?.[Symbol.dispose]?.(); } catch {} };
    function pump() {
      while (!disposed && working < concurrency && queued.size && retained.size + working < limit) {
        const [key, item] = queued.entries().next().value; queued.delete(key);
        if (checked.has(key) && now() - checked.get(key) < 60000) continue;
        checked.set(key, now()); working++;
        Promise.resolve().then(async () => {
          if (disposed) return;
          const owner = await item.coordination.findThreadOwner({hostId: item.hostId, conversationId: item.id});
          if (disposed || !owner) return;
          const role = await item.controller.getStreamRole(item.id);
          if (disposed || role?.role === 'owner' || role?.role === 'follower') return;
          const handle = await item.controller.retainActiveConversation(item.id);
          if (disposed) release(handle); else retained.set(key, handle);
        }).catch(() => { /* Offline or closing owners must not break startup. */ })
          .finally(() => { working--; pump(); });
      }
    }
    return {
      observe(hostId, threads, controller, coordination) {
        if (disposed || !coordination?.findThreadOwner || !controller?.retainActiveConversation) return;
        for (const thread of threads) {
          const id = thread.id;
          if (typeof id !== 'string' || thread.ephemeral || thread.source && typeof thread.source === 'object' && 'subAgent' in thread.source) continue;
          const key = hostId + '\0' + id;
          if (retained.has(key) || queued.has(key) || checked.has(key) && now() - checked.get(key) < 60000) continue;
          if (queued.size >= 128) break;
          queued.set(key, {hostId, id, controller, coordination});
        }
        while (checked.size > 512) checked.delete(checked.keys().next().value);
        pump();
      },
      dispose() { disposed = true; queued.clear(); checked.clear(); for (const h of retained.values()) release(h); retained.clear(); },
      status: () => ({retained: retained.size, queued: queued.size, working})
    };
  }
  if (typeof module === 'object' && module.exports) module.exports = {createActivitySync};
  else if (!root.__codexLabelsActivitySync) {
    root.__codexLabelsActivitySync = createActivitySync();
    root.addEventListener('pagehide', () => root.__codexLabelsActivitySync.dispose(), {once: true});
  }
})(globalThis);
