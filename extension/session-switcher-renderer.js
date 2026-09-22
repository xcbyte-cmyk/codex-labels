(() => {
  'use strict';
  const api = window.codexSessionSwitcher;
  if (!api || document.getElementById('cdx-session-switcher-entry')) return;
  const el = (tag, text, attrs = {}) => { const n = document.createElement(tag); if (text != null) n.textContent = text; Object.assign(n, attrs); return n; };
  const style = el('style');
  style.textContent = `
  #cdx-session-switcher-entry{position:fixed;bottom:14px;left:14px;z-index:2147483600;padding:8px 12px;border:1px solid #64748b;border-radius:9px;background:#182235;color:#f1f5f9;font:12px system-ui;cursor:pointer}
  #cdx-session-switcher{color:#e2e8f0;background:#111827;border:1px solid #475569;border-radius:14px;padding:24px;width:min(560px,85vw);font:14px/1.6 system-ui;z-index:2147483647}
  #cdx-session-switcher::backdrop{background:#0009}#cdx-session-switcher h2{font-size:20px;margin:0 0 8px}
  #cdx-session-switcher select{display:block;width:100%;padding:10px;margin:8px 0;background:#1e293b;color:inherit;border:1px solid #64748b;border-radius:7px}
  #cdx-session-switcher button{padding:8px 12px;margin:5px 6px 0 0;border-radius:7px;border:1px solid #64748b;background:#263449;color:inherit;cursor:pointer}
  #cdx-session-switcher button:disabled{opacity:.45;cursor:default}#cdx-session-switcher .status{padding:10px;background:#1e293b;border-radius:8px;white-space:pre-wrap;overflow-wrap:anywhere}
  #cdx-session-switcher .muted{color:#94a3b8;font-size:12px}#cdx-session-switcher .consent{display:block;margin:14px 0}
  `; document.head.append(style);
  const entry = el('button', 'Account Switcher', {id: 'cdx-session-switcher-entry', type: 'button'});
  document.body.append(entry); let opened = false;
  function unwrap(result) { if (!result?.ok) throw new Error(result?.error?.message || '연결 상태를 확인할 수 없습니다.'); return result.value; }
  entry.onclick = () => {
    if (opened) return; opened = true;
    const dialog = el('dialog', null, {id: 'cdx-session-switcher'});
    const title = el('h2', '전체 로컬 대화를 유지하며 계정 전환');
    const description = el('p', '이 창의 로컬 대화·프로젝트·라벨·저장 위치는 그대로 두고, 이후 요청에 사용할 계정만 바꿉니다. 대화를 하나씩 선택하지 않습니다.');
    const profileLabel = el('label', '요청에 사용할 계정');
    const profiles = el('select', null, {ariaLabel: '요청에 사용할 계정'}); profileLabel.append(profiles);
    const status = el('div', '연결을 확인하고 있습니다.', {className: 'status', role: 'status', ariaLive: 'polite'});
    const consent = el('input', null, {type: 'checkbox'}), consentLabel = el('label', null, {className: 'consent'});
    consentLabel.append(consent, document.createTextNode(' 이 로컬 작업 공간의 대화를 이어갈 때 기존 기록·코드 문맥이 선택한 계정으로 전달될 수 있음에 동의합니다.'));
    const note = el('p', '계정별 창 선택기는 별도 기능입니다. 다른 프로필의 대화를 자동으로 합치지 않습니다. 현재 창의 로컬 기록은 계정 간 공유되며, 전환만으로 모델 요청을 실행하지 않습니다.', {className: 'muted'});
    const change = el('button', '전체 작업 공간의 계정 전환', {type: 'button', disabled: true});
    const cancel = el('button', '전환 취소', {type: 'button', disabled: true});
    const recover = el('button', '로그인 확인·복구', {type: 'button', disabled: true});
    const usage = el('button', '현재 계정 사용량', {type: 'button', disabled: true});
    const close = el('button', '닫기', {type: 'button'});
    dialog.append(title, description, profileLabel, status, consentLabel, note, change, cancel, recover, usage, close);
    document.body.append(dialog); dialog.showModal();
    let state = null, busy = false, live = true, requestVersion = 0, timer;
    function controls() {
      const switching = ['switching', 'cancelling', 'checking', 'authenticating'].includes(state?.phase);
      change.disabled = busy || !consent.checked || state?.phase !== 'idle' || !profiles.value || profiles.value === state?.activeProfile?.id;
      recover.disabled = busy || !consent.checked || !state || state.nativeLoginPending || !['blocked', 'idle'].includes(state.phase);
      cancel.disabled = !(busy || switching); usage.disabled = busy || state?.phase !== 'idle';
      profiles.disabled = busy || switching; consent.disabled = busy || switching;
      close.disabled = busy || switching;
    }
    function showState(value) {
      state = value;
      if (!state) { status.textContent = '로컬 앱 서버 연결을 기다리고 있습니다.'; controls(); return; }
      status.textContent = `현재 계정: ${state.activeProfile?.name || '로그인 확인 필요'}\n상태: ${state.phase}${state.blockedReason ? ' · ' + state.blockedReason : ''}\n유지되는 저장 위치: ${state.workspaceHome}` +
        (Number.isInteger(state.connectionCount) ? `\n앱 서버 연결: ${state.connectionCount}개 · 계정 확인 완료: ${state.verifiedConnectionCount ?? 0}개` : '') +
        (state.phase === 'synchronizing' ? '\n새 연결의 계정을 확인하는 동안 새 작업 요청은 차단합니다.' : '') +
        (state.retiringConnectionCount ? `\n종료 확인 중인 연결: ${state.retiringConnectionCount}개` : '') +
        (Number.isInteger(state.localConversationCount) ? `\n전환 검사에서 확인한 로컬 대화: ${state.localConversationCount}개` : '');
      controls();
    }
    async function refresh() {
      const version = ++requestVersion;
      try {
        const data = unwrap(await api.status()); if (!live || version !== requestVersion || busy) return;
        if (data.scope !== 'workspace') throw new Error('전체 대화 유지 버전의 런타임을 적용해야 합니다.');
        const chosen = profiles.value || data.state?.activeProfile?.id;
        profiles.replaceChildren(...data.profiles.map(p => el('option', p.name, {value: p.id})));
        if (data.profiles.some(p => p.id === chosen)) profiles.value = chosen;
        showState(data.state);
        if (!data.attached) { state = null; status.textContent = data.error?.message || '로컬 앱 서버가 연결되지 않았습니다.'; controls(); }
      } catch (e) { if (live && version === requestVersion) { state = null; status.textContent = e.message; controls(); } }
    }
    async function perform(action) {
      busy = true; ++requestVersion; controls(); status.textContent = '작업 상태와 계정을 확인하고 있습니다. 로컬 대화는 이동하지 않습니다.';
      try { const value = unwrap(await action()); if (live) showState(value.state || value); }
      catch (e) {
        if (live) {
          try { state = unwrap(await api.inspect()); } catch { state = null; }
          if (live) status.textContent = e.message;
        }
      }
      finally { busy = false; consent.checked = false; controls(); }
    }
    change.onclick = () => perform(() => api.switchAccount({profileId: profiles.value, confirmContextTransfer: consent.checked}));
    recover.onclick = () => perform(() => api.recover({confirmContextTransfer: consent.checked}));
    cancel.onclick = async () => { try { unwrap(await api.cancel()); } catch (e) { if (live) status.textContent = e.message; } };
    usage.onclick = async () => {
      busy = true; controls();
      try {
        const value = unwrap(await api.usage());
        const limits = value.rateLimitsByLimitId || (value.rateLimits ? {codex: value.rateLimits} : {});
        if (live) status.textContent = Object.entries(limits).map(([id, limit]) => `${id}: ${Number.isFinite(limit.primary?.usedPercent) ? limit.primary.usedPercent + '% 사용' : '사용량 미제공'}`).join('\n') || '사용량이 제공되지 않았습니다.';
      } catch (e) { if (live) status.textContent = e.message; }
      finally { busy = false; controls(); }
    };
    profiles.onchange = () => { consent.checked = false; controls(); }; consent.onchange = controls;
    const off = api.onChanged(() => { clearTimeout(timer); timer = setTimeout(() => { if (!busy) refresh(); }, 80); });
    dialog.addEventListener('cancel', e => { if (busy || close.disabled) e.preventDefault(); });
    dialog.addEventListener('close', () => { live = false; ++requestVersion; clearTimeout(timer); off(); dialog.remove(); opened = false; entry.focus(); }, {once: true});
    close.onclick = () => dialog.close(); refresh();
  };
})();
