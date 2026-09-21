'use strict';

// Public app-server rate-limit response -> display-only metadata. Never invent
// a five-hour/week window, zero usage, or a plan when the server omits it.
function windowValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const percent = Number.isFinite(value.usedPercent) && value.usedPercent >= 0 && value.usedPercent <= 100
    ? value.usedPercent : null;
  const minutes = Number.isSafeInteger(value.windowDurationMins) && value.windowDurationMins > 0
    ? value.windowDurationMins : null;
  const resetsAt = Number.isSafeInteger(value.resetsAt) && value.resetsAt >= 0 ? value.resetsAt : null;
  return Object.freeze({usedPercent: percent, remainingPercent: percent === null ? null : 100 - percent,
    windowDurationMins: minutes, resetsAt,
    label: minutes === 300 ? '5시간' : minutes === 10080 ? '주간' : minutes === null ? '기간 미확인' : `${minutes}분`});
}

function normalizeRateLimits(response, {limitId = 'codex', fetchedAt = Date.now()} = {}) {
  if (typeof limitId !== 'string' || !limitId || limitId.length > 200 || !Number.isSafeInteger(fetchedAt) || fetchedAt < 0) {
    throw new TypeError('Invalid rate-limit options');
  }
  const map = response && typeof response === 'object' && response.rateLimitsByLimitId;
  const mapped = map && typeof map === 'object' && !Array.isArray(map) && Object.hasOwn(map, limitId);
  let value = mapped ? map[limitId] : response?.rateLimits;
  // An unrelated product's limits must not be displayed as Codex usage.
  if (value?.limitId != null && value.limitId !== limitId) value = null;
  const primary = windowValue(value?.primary), secondary = windowValue(value?.secondary);
  const present = [primary, secondary].filter(Boolean);
  return Object.freeze({limitId, fetchedAt, status: present.length === 0 ? 'unknown'
    : present.some(item => item.usedPercent === null || item.windowDurationMins === null) ? 'partial' : 'known',
    primary, secondary});
}

module.exports = {normalizeRateLimits};
