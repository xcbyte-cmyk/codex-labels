(() => {
  'use strict';
  const api = window.codexLabels;
  if (!api?.onActivateThread || window.__codexLabelsNotificationsInstalled) return;
  window.__codexLabelsNotificationsInstalled = true;
  const selector = '[data-app-action-sidebar-thread-row]';
  let selected = null, cancelPending = () => {}, disposed = false, menuFrame = 0, activeEventId = null;
  function identity(row) {
    const rawId = row?.getAttribute('data-app-action-sidebar-thread-id');
    const kind = row?.getAttribute('data-app-action-sidebar-thread-kind') || 'local';
    // Actual sidebar IDs include the kind prefix; RPC/activation IDs do not.
    const threadId = rawId?.startsWith(kind + ':') ? rawId.slice(kind.length + 1) : rawId;
    return threadId ? {threadId,
      hostId: row.getAttribute('data-app-action-sidebar-thread-host-id') || 'local',
      kind} : null;
  }
  let messageTimer;
  function dismissMessage() {
    clearTimeout(messageTimer);
    document.getElementById('codex-labels-notification-status')?.remove();
  }
  function dismissOnEscape(event) {
    if (event.key === 'Escape') dismissMessage();
  }
  function message(text) {
    let box = document.getElementById('codex-labels-notification-status');
    if (!box) {
      box = document.createElement('div'); box.id = 'codex-labels-notification-status';
      box.setAttribute('role', 'status'); box.setAttribute('aria-live', 'polite');
      Object.assign(box.style, {position: 'fixed', bottom: '20px', right: '20px',
        maxWidth: '400px', padding: '12px', background: '#202123', color: '#fff',
        border: '1px solid #777', borderRadius: '8px', zIndex: '2147483647', fontSize: '13px',
        display: 'flex', alignItems: 'flex-start', gap: '12px'});
      const content = document.createElement('span');
      content.dataset.notificationMessage = '';
      Object.assign(content.style, {minWidth: '0', overflowWrap: 'anywhere'});
      const close = document.createElement('button');
      close.type = 'button'; close.textContent = '×'; close.setAttribute('aria-label', '알림 메시지 닫기');
      Object.assign(close.style, {border: '0', background: 'transparent', color: 'inherit',
        cursor: 'pointer', fontSize: '20px', lineHeight: '24px', padding: '0 4px', flexShrink: '0'});
      close.addEventListener('click', dismissMessage);
      box.append(content, close);
      document.body.append(box);
    }
    box.querySelector('[data-notification-message]').textContent = text;
    clearTimeout(messageTimer);
    messageTimer = setTimeout(dismissMessage, 12000);
  }
  function findRow(target) {
    for (const row of document.querySelectorAll(selector)) {
      const id = identity(row);
      if (id && id.threadId === target.threadId && id.hostId === target.hostId && id.kind === target.kind &&
          row.getClientRects().length && row.getAttribute('aria-disabled') !== 'true') return row;
    }
    return null;
  }
  function activate(target) {
    cancelPending(); activeEventId = target.eventId;
    let finished = false, frame = 0, timeout;
    const observer = new MutationObserver(() => {
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; attempt(); });
    });
    const cleanup = () => { observer.disconnect(); cancelAnimationFrame(frame); clearTimeout(timeout); };
    cancelPending = () => { finished = true; cleanup(); activeEventId = null; };
    function finish(result) {
      if (finished || disposed) return;
      finished = true; cleanup(); activeEventId = null;
      api.acknowledgeActivation(target.eventId, result).catch(() => {});
      if (result === 'thread-not-found') message('알림의 작업이 현재 목록에 없습니다. 해당 프로젝트를 펼친 뒤 알림을 다시 클릭하세요.');
      else if (result === 'failed') message('작업 열기에 실패했습니다. Codex Labels 창에서 작업을 확인하세요.');
      else dismissMessage();
    }
    function attempt() {
      if (finished || disposed) return;
      const row = findRow(target);
      if (!row) return;
      try {
        row.scrollIntoView({block: 'nearest'});
        row.focus({preventScroll: true});
        row.click();
        // A click is a navigation REQUEST, not proof of the private router's result.
        finish('navigation-requested');
      } catch { finish('failed'); }
    }
    observer.observe(document.documentElement, {subtree: true, childList: true, attributes: true,
      attributeFilter: ['data-app-action-sidebar-thread-id', 'data-app-action-sidebar-thread-host-id',
        'data-app-action-sidebar-thread-kind', 'aria-disabled', 'hidden', 'style']});
    timeout = setTimeout(() => finish('thread-not-found'), 8000);
    attempt();
  }
  function addTestButton() {
    const menu = document.getElementById('cdx-label-menu');
    if (!menu || !selected || menu.querySelector('[data-codex-labels-test-notification]')) return;
    const target = {...selected};
    const button = document.createElement('button'); button.type = 'button';
    button.setAttribute('role', 'menuitem'); button.dataset.codexLabelsTestNotification = '';
    button.textContent = '알림 연결 테스트';
    button.addEventListener('click', async event => {
      event.preventDefault(); event.stopPropagation(); button.disabled = true;
      try {
        await api.notifyThread({...target, title: 'Codex Labels 연결 테스트',
          body: '이 알림을 클릭하면 선택한 작업의 열기를 요청합니다.'});
        dismissMessage();
        button.textContent = '테스트 알림 전송 요청됨';
      } catch (error) {
        message(error?.message || '알림 전송 요청에 실패했습니다.');
        button.disabled = false;
      }
    });
    menu.append(button);
  }
  function capture(event) {
    if (event.type === 'keydown' && !['Enter', ' '].includes(event.key)) return;
    const badge = event.target instanceof Element ? event.target.closest('.cdx-label') : null;
    if (!badge) return;
    selected = identity(badge.closest(selector));
    // Runs after the existing label menu's event handler; no idle DOM polling.
    cancelAnimationFrame(menuFrame);
    menuFrame = requestAnimationFrame(() => { menuFrame = 0; if (!disposed) addTestButton(); });
  }
  const unsubscribe = api.onActivateThread(value => {
    if (value?.cancel === true) { if (value.eventId === activeEventId) cancelPending(); return; }
    activate(value);
  });
  document.addEventListener('click', capture, true);
  document.addEventListener('keydown', capture, true);
  document.addEventListener('keydown', dismissOnEscape, true);
  window.addEventListener('pagehide', () => {
    disposed = true; cancelPending(); cancelAnimationFrame(menuFrame); unsubscribe(); dismissMessage();
    document.removeEventListener('click', capture, true);
    document.removeEventListener('keydown', capture, true);
    document.removeEventListener('keydown', dismissOnEscape, true);
  }, {once: true});
  api.activationReady().catch(() => message('알림 연결 초기화에 실패했습니다. Codex Labels를 다시 실행하세요.'));
})();
