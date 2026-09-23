(() => {
  'use strict';
  const api = window.codexLabels;
  if (!api?.openAutomaticAccounts || document.getElementById('cdx-auto-account-open')) return;
  const button = document.createElement('button');
  button.id = 'cdx-auto-account-open'; button.type = 'button'; button.textContent = '계정 전환';
  button.title = '계정 추가·관리 및 같은 작업 공간에서 계정 전환';
  button.style.cssText = 'position:fixed;bottom:14px;right:14px;z-index:2147483600;padding:8px 14px;border:1px solid #64748b;border-radius:8px;background:#172033;color:#eef2ff;font:13px system-ui;cursor:pointer';
  const status = document.createElement('span'); status.setAttribute('role', 'status');
  status.style.cssText = 'position:fixed;bottom:54px;right:14px;z-index:2147483600;max-width:330px;background:#172033;color:#eef2ff;font:12px system-ui;padding:5px';
  status.hidden = true;
  button.onclick = async () => {
    button.disabled = true;
    try {
      const result = await api.openAutomaticAccounts();
      status.textContent = result.alreadyOpen ? '열려 있는 계정 전환 창에서 계정을 선택하세요.' : '계정 전환 창에서 사용할 계정을 선택하세요.';
    } catch { status.textContent = '계정 전환 도구를 열지 못했습니다. 새 후보에 helper가 포함됐는지 확인하세요.'; }
    finally { status.hidden = false; button.disabled = false; }
  };
  document.body.append(button, status);
})();
