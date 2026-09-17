'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {route, activationUri, parseActivation, toastXml, notificationInput,
  boundedDedupe, activationQueue} = require('./notification-core.cjs');
const base = {threadId: 'thread-123', hostId: 'remote-1', kind: 'remote', eventId: 'event-1'};
test('activation round-trips the entire identity, not just a title or thread id', () => {
  assert.deepEqual(parseActivation(activationUri(base)), base);
  assert.equal(route({threadId: 't'}, () => 'e').hostId, 'local');
  assert.ok(Object.isFrozen(route(base)));
});

test('actual Codex remote host formats survive notification and URI round trips', () => {
  const hosts = ['local', 'custom-host-1', 'remote-ssh-discovered:qa-runner',
    'remote-control:workspace-42', 'remote-wsl:Ubuntu-24.04',
    'remote-ssh-discovered:' + encodeURIComponent('연구 서버 (QA)'),
    'remote-control:' + encodeURIComponent('user@lab:2222'),
    'remote-wsl:' + encodeURIComponent('Ubuntu 개발')];
  for (const hostId of hosts) {
    const expected = {...base, hostId};
    const input = notificationInput({...expected, title: 'remote test'});
    assert.equal(input.hostId, hostId);
    const uri = activationUri(input);
    assert.deepEqual(parseActivation(uri), expected);
    assert.ok(toastXml(input, true).includes('activationType="protocol"'));
  }
});

test('remote host validation rejects malformed escapes, control bytes and unsupported prefixes', () => {
  for (const hostId of ['', 'remote-ssh-discovered:', 'unknown:host', 'https://host',
    'remote-control:raw:colon', 'remote-wsl:raw space', 'remote-wsl:raw\\path',
    'remote-wsl:bad%', 'remote-wsl:bad%GG', 'remote-wsl:%C0%AF', 'remote-wsl:%ED%A0%80',
    'remote-wsl:%00', 'remote-wsl:%0A', 'remote-wsl:%7F', 'remote-wsl:host\n', 'a'.repeat(257)]) {
    assert.throws(() => notificationInput({...base, hostId, title: 'test'}), undefined, hostId);
    const uri = 'codex-labels://activate?' + new URLSearchParams({v: '1', ...base, hostId});
    assert.throws(() => parseActivation(uri), undefined, hostId);
  }
});

test('host namespace support does not relax thread, event or kind validation', () => {
  for (const name of ['threadId', 'eventId', 'kind']) {
    for (const value of ['remote-wsl:Ubuntu', 'encoded%20value']) {
      assert.throws(() => route({...base, [name]: value}));
    }
  }
});
test('arbitrary URLs, credentials, paths, fragments and oversized payloads are rejected', () => {
  const good = activationUri(base);
  for (const value of [null, {}, 'codex://thread/t', 'https://example.com', 'javascript:alert(1)',
    good.replace('activate?', 'activate/path?'), good.replace('activate?', 'evil@activate?'),
    good + '#fragment', good + '&command=delete', good + '&v=1', good.replace('v=1', 'v=2'),
    good.replace('v=1&', ''), good.replace('event-1', '%GG'), good.replace('event-1', '%00'),
    good.replace('event-1', '%2522'), good.replace('event-1', 'event+1'), good + 'x'.repeat(2048)]) {
    assert.throws(() => parseActivation(value), undefined, String(value));
  }
});
test('identity validation rejects control characters and selector/shell injection', () => {
  for (const id of ['', '../file', 'x:y', 'x y', 'x" onclick="bad', '[x]', 'x\n', 'x\u007f', 'a'.repeat(257)]) {
    assert.throws(() => route({...base, threadId: id}));
  }
});
test('toast XML escapes text and URI delimiters and uses an explicit activation type', () => {
  const input = {...base, title: '질문 <확인> & "yes"', body: "승인 '필요'", silent: true};
  const xml = toastXml(input, true);
  assert.match(xml, /activationType="protocol"/);
  assert.match(xml, /&amp;hostId=/);
  assert.match(xml, /&lt;확인&gt; &amp; &quot;yes&quot;/);
  assert.match(xml, /&apos;필요&apos;/);
  assert.match(xml, /<audio silent="true"\/>/);
  assert.match(toastXml(input), /activationType="foreground"/);
});
test('unsafe XML, oversized content, caller XML and arbitrary properties are rejected', () => {
  for (const input of [null, {...base, title: ''}, {...base, title: 'a'.repeat(121)},
    {...base, title: 'x', body: 'a'.repeat(1001)}, {...base, title: '\u0000'},
    {...base, title: '\ud800'}, {...base, title: 'x', toastXml: '<toast/>'},
    {...base, title: 'x', command: 'approve'}, {...base, title: 'x', silent: 'true'}]) {
    assert.throws(() => notificationInput(input));
  }
  assert.equal(notificationInput({...base, title: '😀 완료'}).title, '😀 완료');
});
test('deduplication has TTL, bounded memory and permits a later deliberate click', () => {
  let time = 0;
  const dedupe = boundedDedupe({limit: 2, ttlMs: 10, now: () => time});
  assert.equal(dedupe.accept('a'), true); assert.equal(dedupe.accept('a'), false);
  dedupe.accept('b'); dedupe.accept('c'); assert.equal(dedupe.size, 2);
  time = 10; assert.equal(dedupe.accept('c'), true);
});
test('queue waits for a window and consumes only the matching window acknowledgement', () => {
  const queue = activationQueue();
  assert.equal(queue.enqueue(base), true);
  assert.deepEqual(queue.take(7), base); assert.equal(queue.take(8), null);
  assert.equal(queue.acknowledge('event-1', 8, 'navigation-requested'), false);
  assert.equal(queue.acknowledge('event-1', 7, 'approved'), false);
  assert.equal(queue.acknowledge('event-1', 7, 'navigation-requested'), true);
  assert.equal(queue.pending, null);
});
test('last click wins and stale responses cannot consume the new request', () => {
  const queue = activationQueue(); queue.enqueue(base); queue.take(1);
  const next = {...base, threadId: 'next', eventId: 'event-2'};
  queue.enqueue(next);
  assert.equal(queue.acknowledge('event-1', 1, 'navigation-requested'), false);
  assert.deepEqual(queue.take(1), next);
});
test('not-found may try another window, but does not spin on the same one', () => {
  const queue = activationQueue(); queue.enqueue(base); queue.take(1);
  queue.acknowledge('event-1', 1, 'thread-not-found');
  assert.equal(queue.take(1), null); assert.deepEqual(queue.take(2), base);
});
test('a renderer reload releases its in-flight delivery', () => {
  const queue = activationQueue(); queue.enqueue(base); queue.take(1); queue.disconnected(1);
  assert.deepEqual(queue.take(1), base);
});
test('unhandled activations expire instead of unexpectedly opening a task much later', () => {
  let time = 0; const queue = activationQueue({now: () => time, ttlMs: 10});
  queue.enqueue(base); time = 10;
  assert.equal(queue.pending, null); assert.equal(queue.take(1), null);
});
test('duplicate callbacks do not cause two navigation requests', () => {
  const queue = activationQueue(); assert.equal(queue.enqueue(base), true);
  assert.equal(queue.enqueue(base), false);
  const otherHost = {...base, hostId: 'other'};
  assert.equal(queue.enqueue(otherHost), true);
});
