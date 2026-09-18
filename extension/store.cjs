'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {createHash,randomUUID} = require('node:crypto');
const HEX = /^#[0-9a-f]{6}$/i;
const MAX_CONFIG_BYTES = 256 * 1024;
const LABEL_FIELDS = ['name','backgroundColor','textColor','order','enabled','description'];
const APPEARANCE_BOUNDS = [['fontSizePx',8,32],['borderRadiusPx',0,30],['horizontalPaddingPx',0,30],['verticalPaddingPx',0,20],['gapPx',0,40]];
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => JSON.parse(JSON.stringify(value));
const revision = bytes => createHash('sha256').update(bytes).digest('hex');
function validateConfig(c) {
  if (!isObject(c) || c.schemaVersion !== 1 || !Array.isArray(c.labels) || c.labels.length > 100) throw Error('라벨 설정 형식이 올바르지 않습니다.');
  const a = c.appearance;
  if (!isObject(a) || a.position !== 'before-title' || a.style !== 'filled') throw Error('지원하지 않는 표시 형식입니다.');
  for (const [key,min,max] of APPEARANCE_BOUNDS) {
    if (!Number.isFinite(a[key]) || a[key] < min || a[key] > max) throw Error(`${key}: ${min}~${max} 범위로 설정하세요.`);
  }
  const ids = new Set();
  for (const l of c.labels) {
    if (!isObject(l) || typeof l.id !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(l.id) || ids.has(l.id)) throw Error('라벨 ID가 올바르지 않거나 중복됩니다.');
    ids.add(l.id);
    if (typeof l.name !== 'string' || !l.name.trim() || l.name.length > 30 || /[\x00-\x1f\x7f]/.test(l.name) || typeof l.backgroundColor !== 'string' || !HEX.test(l.backgroundColor) || typeof l.textColor !== 'string' || !HEX.test(l.textColor) || typeof l.enabled !== 'boolean' || !Number.isSafeInteger(l.order) || l.order < 0 || l.order > 10000 || typeof l.description !== 'string' || l.description.length > 500) throw Error('라벨 이름·색상·속성을 확인하세요. 이름은 30자, 설명은 500자, 순서는 0~10000 정수까지 사용할 수 있습니다.');
  }
  return c;
}
function validateKey(key) {
  if (typeof key !== 'string' || key.length > 1024 || !/^(thread|project):/.test(key) || /[\x00-\x1f]/.test(key)) throw Error('작업 식별자가 올바르지 않습니다.');
}
function createStore(directory) {
  const configPath = path.join(directory, 'labels.json');
  const assignmentsPath = path.join(directory, 'assignments.json');
  let lastConfig, lastRevision, configError = null;
  function readConfig() {
    if (fs.statSync(configPath).size > MAX_CONFIG_BYTES) throw Error('라벨 설정 파일은 256KB 이하여야 합니다.');
    const bytes = fs.readFileSync(configPath);
    if (bytes.length > MAX_CONFIG_BYTES) throw Error('라벨 설정 파일은 256KB 이하여야 합니다.');
    return {value:validateConfig(JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''))), bytes, revision:revision(bytes)};
  }
  function config() {
    try { const next = readConfig(); lastConfig = next.value; lastRevision = next.revision; configError = null; }
    catch (e) { configError = e.message; if (!lastConfig) throw e; }
    return lastConfig;
  }
  function state() {
    if (!fs.existsSync(assignmentsPath)) return {schemaVersion:1, assignments:{}};
    const value = JSON.parse(fs.readFileSync(assignmentsPath, 'utf8').replace(/^\uFEFF/, ''));
    if (value?.schemaVersion !== 1 || !isObject(value.assignments)) throw Error('상태 저장 파일을 확인하세요.');
    for (const [key,id] of Object.entries(value.assignments)) { validateKey(key); if (typeof id !== 'string') throw Error('저장된 라벨 ID가 올바르지 않습니다.'); }
    return value;
  }
  function snapshot() { const c = config(); return {config:clone(c), assignments:state().assignments, configPath, configRevision:lastRevision, configError}; }
  function saveConfig(draft, expectedRevision) {
    if (typeof expectedRevision !== 'string' || !/^[0-9a-f]{64}$/.test(expectedRevision)) throw Error('라벨 설정을 다시 연 뒤 저장하세요.');
    let draftText;
    try { draftText = JSON.stringify(draft); } catch { throw Error('라벨 설정 형식이 올바르지 않습니다.'); }
    if (!draftText || Buffer.byteLength(draftText,'utf8') > MAX_CONFIG_BYTES) throw Error('라벨 설정은 256KB 이하여야 합니다.');
    if (!isObject(draft) || !Array.isArray(draft.labels) || !isObject(draft.appearance)) throw Error('라벨 설정 형식이 올바르지 않습니다.');
    let current;
    try { current = readConfig(); } catch { throw Error('현재 라벨 설정 파일을 읽을 수 없습니다. 파일 오류를 해결한 뒤 설정을 다시 여세요.'); }
    const conflict = () => Error('다른 창이나 파일에서 라벨 설정이 변경되었습니다. 설정을 다시 열어 최신 내용을 확인하세요.');
    if (current.revision !== expectedRevision) throw conflict();
    const changes = new Map();
    for (const label of draft.labels) {
      if (!isObject(label) || typeof label.id !== 'string' || changes.has(label.id)) throw Error('라벨 ID가 올바르지 않거나 중복됩니다.');
      changes.set(label.id,label);
    }
    if (current.value.labels.some(label=>!changes.has(label.id))) throw Error('기존 라벨 ID는 삭제·변경할 수 없습니다.');
    if (changes.size > 100) throw Error('라벨은 최대 100개까지 추가할 수 있습니다.');
    const next = clone(current.value);
    next.labels = next.labels.map(label => {
      const change = changes.get(label.id);
      for (const key of LABEL_FIELDS) label[key] = change[key];
      return label;
    });
    const existingIds = new Set(current.value.labels.map(label => label.id));
    for (const [id, change] of changes) {
      if (!existingIds.has(id)) next.labels.push(Object.fromEntries(['id', ...LABEL_FIELDS].map(key => [key, change[key]])));
    }
    for (const key of ['position','style',...APPEARANCE_BOUNDS.map(([key])=>key)]) next.appearance[key] = draft.appearance[key];
    validateConfig(next);
    const bytes = Buffer.from(JSON.stringify(next,null,2)+'\n','utf8');
    if (bytes.length > MAX_CONFIG_BYTES) throw Error('라벨 설정은 256KB 이하여야 합니다.');
    // Read state before writing: an unrelated damaged assignment file must not
    // make a successful config write appear to have failed when returning it.
    const assignments = state().assignments;
    const suffix = '.tmp-' + process.pid + '-' + randomUUID();
    const temp = configPath + suffix;
    const backupTemp = configPath + '.bak' + suffix;
    const writeDurably = (file,data) => {
      const fd = fs.openSync(file,'wx',0o600);
      try { fs.writeFileSync(fd,data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    };
    try {
      writeDurably(temp,bytes);
      writeDurably(backupTemp,current.bytes);
      // Check again after staging, before replacing either destination. This
      // catches file edits made while staging a larger configuration.
      if (revision(fs.readFileSync(configPath)) !== expectedRevision) throw conflict();
      fs.renameSync(backupTemp,configPath+'.bak');
      if (revision(fs.readFileSync(configPath)) !== expectedRevision) throw conflict();
      fs.renameSync(temp,configPath);
    } finally {
      for (const file of [temp,backupTemp]) { try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') console.error('[codex-labels] temporary file cleanup:',error.message); } }
    }
    lastConfig = next;
    lastRevision = revision(bytes);
    configError = null;
    return {config:clone(next), assignments, configPath, configRevision:lastRevision, configError};
  }
  function assign(key,id) {
    validateKey(key);
    if (id !== null && !config().labels.some(l=>l.id===id && l.enabled)) throw Error('사용할 수 없는 라벨입니다.');
    const value = state();
    if (id === null) delete value.assignments[key]; else value.assignments[key] = id;
    const temp = assignmentsPath + '.tmp-' + process.pid;
    try { fs.writeFileSync(temp, JSON.stringify(value,null,2)+'\n', {encoding:'utf8',mode:0o600}); fs.renameSync(temp, assignmentsPath); }
    finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
    return snapshot();
  }
  return {snapshot,assign,saveConfig,configPath};
}
module.exports = {createStore,validateConfig,validateKey};
