'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {normalizeRateLimits} = require('./account-usage.cjs');
const wrap = primary => ({rateLimits: {limitId: 'codex', primary}});

test('absent quota is unknown, not 0% used or 100% available', () => {
  for (const value of [null, undefined, {}, {rateLimits: null}]) {
    const result = normalizeRateLimits(value, {fetchedAt: 42});
    assert.equal(result.status, 'unknown'); assert.equal(result.primary, null); assert.equal(result.fetchedAt, 42);
  }
});
test('five-hour and weekly labels require matching server duration', () => {
  const result = normalizeRateLimits({rateLimits: {primary: {usedPercent: 91, windowDurationMins: 300, resetsAt: 100},
    secondary: {usedPercent: 18, windowDurationMins: 10080, resetsAt: 200}}});
  assert.equal(result.status, 'known'); assert.equal(result.primary.label, '5시간'); assert.equal(result.primary.remainingPercent, 9);
  assert.equal(result.secondary.label, '주간'); assert.equal(result.secondary.remainingPercent, 82);
});
test('nonstandard quota windows retain their actual durations', () => {
  const result = normalizeRateLimits(wrap({usedPercent: 12.5, windowDurationMins: 15, resetsAt: 100}));
  assert.equal(result.primary.label, '15분'); assert.equal(result.primary.usedPercent, 12.5);
});
test('invalid percentages do not become apparently valid values by clamping or coercion', () => {
  for (const usedPercent of [-1, 101, Infinity, NaN, '23', null]) {
    const result = normalizeRateLimits(wrap({usedPercent, windowDurationMins: 300}));
    assert.equal(result.status, 'partial'); assert.equal(result.primary.usedPercent, null); assert.equal(result.primary.remainingPercent, null);
  }
});
test('map-specific Codex limits take precedence over legacy combined limits', () => {
  const result = normalizeRateLimits({rateLimits: {primary: {usedPercent: 99, windowDurationMins: 300}},
    rateLimitsByLimitId: {codex: {primary: {usedPercent: 5, windowDurationMins: 300}}, other: {primary: {usedPercent: 0}}}});
  assert.equal(result.primary.usedPercent, 5);
});
test('an unrelated product must not be reported as Codex usage', () => {
  const result = normalizeRateLimits({rateLimits: {limitId: 'other', primary: {usedPercent: 0, windowDurationMins: 300}}});
  assert.equal(result.status, 'unknown');
});
test('reset times are seconds and preserved; malformed values are unknown', () => {
  const good = normalizeRateLimits(wrap({usedPercent: 0, windowDurationMins: 300, resetsAt: 1900000000}));
  assert.equal(good.primary.resetsAt, 1900000000);
  const bad = normalizeRateLimits(wrap({usedPercent: 0, windowDurationMins: -1, resetsAt: 'soon'}));
  assert.equal(bad.primary.resetsAt, null); assert.equal(bad.primary.label, '기간 미확인');
});
test('raw account data and credentials are never copied into the display object', () => {
  const result = normalizeRateLimits({secret: 'SECRET', rateLimits: {accessToken: 'SECRET', primary: {usedPercent: 20, windowDurationMins: 300, token: 'SECRET'}}});
  assert.equal(JSON.stringify(result).includes('SECRET'), false); assert.equal(Object.isFrozen(result.primary), true);
});
test('invalid timestamps and blank limit IDs are rejected', () => {
  for (const fetchedAt of [-1, Infinity, NaN, 1.5]) assert.throws(() => normalizeRateLimits({}, {fetchedAt}), TypeError);
  assert.throws(() => normalizeRateLimits({}, {limitId: ''}), TypeError);
});
