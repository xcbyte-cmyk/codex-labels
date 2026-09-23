'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const CODES = Object.freeze({
  INVALID_ARGUMENT: '요청 값이 올바르지 않습니다.',
  UNSUPPORTED: '이 앱 서버에서 필요한 규약을 확인하지 못했습니다. 전환하지 않았습니다.',
  BUSY: '응답·도구·승인·명령이 끝난 뒤 다시 시도하세요.',
  NOT_ATTACHED: '로컬 앱 서버 연결이 아직 없습니다.',
  NOT_FOUND: '등록된 계정 또는 열린 로컬 스레드를 찾지 못했습니다.',
  AUTH_REQUIRED: '계정 선택기에서 해당 계정에 다시 로그인하세요.',
  IDENTITY_MISMATCH: '선택한 계정과 서버 계정이 달라 요청을 차단했습니다.',
  CONSENT_REQUIRED: '현재 대화 문맥을 대상 계정에 전달하는 데 동의해야 합니다.',
  CHECKPOINT_INVALID: '완전하고 안정적인 대화 기록을 확인하지 못했습니다.',
  POLICY_UNSUPPORTED: '기존 승인·샌드박스 정책을 보존할 수 없어 전환하지 않았습니다.',
  RPC_FAILED: '앱 서버 요청에 실패했습니다. 다른 계정에서 자동 재시도하지 않습니다.',
  RPC_TIMEOUT: '앱 서버 응답 시간이 초과되었습니다. 실행 여부가 불명확해 해당 연결을 차단했습니다.',
  RPC_CLOSED: '앱 서버 연결이 종료되었습니다.',
  PROTOCOL_ERROR: '앱 서버 메시지 형식을 확인하지 못했습니다.',
  CLEANUP_FAILED: '이전 서버의 종료를 확인하지 못했습니다. 복구 전까지 요청을 차단합니다.',
  RECOVERY_REQUIRED: '보존된 세션에 복구가 필요합니다. 원래 계정으로 자동 전송하지 않습니다.',
  CANCELLED: '계정 전환을 취소했습니다.',
  SWITCH_FAILED: '계정 전환에 실패했습니다. 현재 상태를 확인하세요.',
});
class SwitchError extends Error {
  constructor(code = 'SWITCH_FAILED') { super(CODES[code] || CODES.SWITCH_FAILED); this.code = code; this.name = 'SwitchError'; }
}
const fail = code => { throw new SwitchError(code); };
function safeError(error) { const code = Object.hasOwn(CODES, error?.code) ? error.code : 'SWITCH_FAILED'; return {code, message:CODES[code]}; }
function assertText(s, max = 256) { if (typeof s !== 'string' || !s || s.length > max || /[\x00-\x1f\x7f]/u.test(s)) fail('INVALID_ARGUMENT'); return s; }
function equalIdentity(a,b) { return !!a && !!b && a.accountId === b.accountId && a.userId === b.userId && a.workspaceId === b.workspaceId; }
function digest(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function inside(root, file) { const r = path.relative(path.resolve(root),path.resolve(file)); return r !== '' && r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r); }
function regularFile(file, root, max = 64 * 1024 * 1024) {
  const resolved = fs.realpathSync(file);
  if (root && !inside(fs.realpathSync(root),resolved)) fail('INVALID_ARGUMENT');
  if (fs.lstatSync(file).isSymbolicLink()) fail('INVALID_ARGUMENT');
  const s = fs.statSync(resolved); if (!s.isFile() || s.size > max) fail('INVALID_ARGUMENT');
  return {file:resolved, stat:s};
}
function atomicJson(file,value) {
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  const tmp = file + '.tmp-' + crypto.randomUUID();
  let fd;
  try { fd=fs.openSync(tmp,'wx',0o600); fs.writeFileSync(fd,JSON.stringify(value,null,2)); fs.fsyncSync(fd); fs.closeSync(fd); fd=null; fs.renameSync(tmp,file); }
  finally { if(fd != null) fs.closeSync(fd); fs.rmSync(tmp,{force:true}); }
}
function checkAbort(signal) { if(signal?.aborted) fail('CANCELLED'); }
module.exports={CODES,SwitchError,fail,safeError,assertText,equalIdentity,digest,inside,regularFile,atomicJson,checkAbort};
