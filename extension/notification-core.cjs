'use strict';
// No Electron dependency: parsing, XML and activation state are independently tested.
const {randomUUID} = require('node:crypto');
const SCHEME = 'codex-labels';
const APP_ID = 'com.xcbyte.codex-labels';
const TOAST_CLSID = '{6C044074-1473-4A87-AF13-7664FCE48F23}';
const MAX_URI_LENGTH = 2048;
const ID = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,255}$/;
const ROUTE_FIELDS = ['threadId', 'hostId', 'kind', 'eventId'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function validHostId(value) {
  if (typeof value !== 'string' || value.length > 256 || /[\x00-\x20\x7f]/.test(value)) return false;
  if (ID.test(value)) return true;
  // Codex constructs these host IDs as prefix + encodeURIComponent(alias).
  // Keep that encoded identity intact; the activation URI adds its own encoding.
  const match = /^(?:remote-ssh-discovered|remote-control|remote-wsl):(.+)$/.exec(value);
  if (!match) return false;
  try {
    const alias = decodeURIComponent(match[1]);
    return !/[\x00-\x1f\x7f]/.test(alias) && encodeURIComponent(alias) === match[1];
  } catch { return false; }
}
function route(input, generateId = randomUUID) {
  if (!object(input)) throw new TypeError('작업 식별자가 필요합니다.');
  const value = {threadId: input.threadId, hostId: input.hostId ?? 'local',
    kind: input.kind ?? 'local', eventId: input.eventId ?? generateId()};
  for (const name of ROUTE_FIELDS) {
    if (name === 'hostId' ? !validHostId(value[name]) : typeof value[name] !== 'string' || !ID.test(value[name])) {
      throw new TypeError(`잘못된 알림 식별자: ${name}`);
    }
  }
  return Object.freeze(value);
}
function activationUri(input) {
  const value = route(input);
  const query = new URLSearchParams({v: '1', ...value});
  return `${SCHEME}://activate?${query}`;
}
function parseActivation(value) {
  if (typeof value !== 'string' || value.length > MAX_URI_LENGTH ||
      !value.startsWith(`${SCHEME}://activate?`) || /[\x00-\x20\x7f]/.test(value) ||
      /%(?![0-9a-f]{2})/i.test(value)) throw new TypeError('잘못된 알림 링크입니다.');
  const url = new URL(value);
  if (url.protocol !== `${SCHEME}:` || url.hostname !== 'activate' ||
      url.pathname || url.username || url.password || url.port || url.hash) {
    throw new TypeError('허용되지 않은 알림 링크입니다.');
  }
  const keys = ['v', ...ROUTE_FIELDS];
  const entries = [...url.searchParams];
  if (entries.length !== keys.length || entries.some(([key]) => !keys.includes(key)) ||
      keys.some(key => url.searchParams.getAll(key).length !== 1) || url.searchParams.get('v') !== '1') {
    throw new TypeError('지원하지 않는 알림 인자입니다.');
  }
  return route(Object.fromEntries(entries));
}
function xmlText(value, maxLength, name) {
  if (typeof value !== 'string' || value.length > maxLength) throw new TypeError(`잘못된 ${name}입니다.`);
  for (const ch of value) {
    const n = ch.codePointAt(0);
    if (!(n === 9 || n === 10 || n === 13 || (n >= 32 && n <= 0xd7ff) ||
      (n >= 0xe000 && n <= 0xfffd) || (n >= 0x10000 && n <= 0x10ffff))) {
      throw new TypeError(`${name}에 지원하지 않는 문자가 있습니다.`);
    }
  }
  return value.replace(/[&<>"']/g, ch => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'}[ch]));
}
function notificationInput(input) {
  if (!object(input)) throw new TypeError('알림 내용이 필요합니다.');
  const allowed = [...ROUTE_FIELDS, 'title', 'body', 'silent'];
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new TypeError('허용되지 않은 알림 속성입니다.');
  if (typeof input.title !== 'string' || !input.title.trim()) throw new TypeError('알림 제목이 필요합니다.');
  xmlText(input.title, 120, '제목');
  xmlText(input.body ?? '', 1000, '내용');
  if (input.silent !== undefined && typeof input.silent !== 'boolean') throw new TypeError('silent는 boolean이어야 합니다.');
  return {...route(input), title: input.title, body: input.body ?? '', silent: input.silent ?? false};
}
function toastXml(input, protocol = false) {
  const n = notificationInput(input);
  const launch = xmlText(activationUri(n), MAX_URI_LENGTH, '링크');
  return `<toast activationType="${protocol ? 'protocol' : 'foreground'}" launch="${launch}">` +
    '<visual><binding template="ToastGeneric">' +
    `<text>${xmlText(n.title, 120, '제목')}</text><text>${xmlText(n.body, 1000, '내용')}</text>` +
    '</binding></visual>' + (n.silent ? '<audio silent="true"/>' : '') + '</toast>';
}
function boundedDedupe({limit = 128, ttlMs = 2000, now = Date.now} = {}) {
  const entries = new Map();
  return {
    accept(key) {
      const time = now();
      for (const [id, expiry] of entries) if (expiry <= time) entries.delete(id);
      if (entries.has(key)) return false;
      entries.set(key, time + ttlMs);
      while (entries.size > limit) entries.delete(entries.keys().next().value);
      return true;
    },
    get size() { return entries.size; }
  };
}
// Last click wins; a delayed acknowledgement cannot consume a newer click.
function activationQueue({now = Date.now, ttlMs = 30000} = {}) {
  const dedupe = boundedDedupe({now});
  let pending = null;
  const current = () => {
    if (pending && now() >= pending.expiresAt) pending = null;
    return pending;
  };
  return {
    enqueue(input) {
      const value = route(input);
      if (!dedupe.accept(activationUri(value))) return false;
      pending = {route: value, expiresAt: now() + ttlMs, target: null, attempted: new Set()};
      return true;
    },
    take(windowId) {
      const p = current();
      if (!p || p.target !== null || p.attempted.has(windowId)) return null;
      p.target = windowId; p.attempted.add(windowId);
      return p.route;
    },
    acknowledge(eventId, windowId, result) {
      const p = current();
      if (!p || p.route.eventId !== eventId || p.target !== windowId) return false;
      if (!['navigation-requested', 'thread-not-found', 'failed'].includes(result)) return false;
      if (result === 'navigation-requested') pending = null;
      else p.target = null;
      return true;
    },
    disconnected(windowId) {
      const p = current();
      if (p?.target === windowId) p.target = null;
      p?.attempted.delete(windowId);
    },
    get pending() { return current()?.route ?? null; },
    clear() { pending = null; }
  };
}
module.exports = {SCHEME, APP_ID, TOAST_CLSID, MAX_URI_LENGTH, route, activationUri,
  parseActivation, xmlText, notificationInput, toastXml, boundedDedupe, activationQueue};
