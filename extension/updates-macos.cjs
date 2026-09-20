'use strict';
function createUpdater() {
  const status = () => ({updateBlocked: true, available: false, pendingRestart: false,
    message: 'macOS 개발 버전입니다. 새 앱 버전은 호환성 확인 후 다시 준비하세요.'});
  const blocked = async () => { throw Error(status().message); };
  return {status, prime: async () => status(), check: async () => status(),
    stage: blocked, restart: blocked, rollback: blocked};
}
module.exports = {createUpdater};
