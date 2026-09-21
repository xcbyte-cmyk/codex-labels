(() => {
  'use strict';
  const api = window.codexLabelsAccounts;
  if (!api || document.getElementById('codex-labels-account-switch')) return;
  const style = document.createElement('style');
  style.textContent = '#codex-labels-account-name{display:none}#codex-labels-account-switch{position:fixed;top:7px;left:50%;transform:translateX(-50%);z-index:2147483646;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:3px 12px;border:1px solid #64748b;border-radius:12px;background:#172033;color:#e2e8f0;font:12px/1.4 "Segoe UI","Malgun Gothic",sans-serif}#codex-labels-account-dialog{max-width:520px;width:calc(100vw - 48px);max-height:80vh;overflow:auto;border:1px solid #64748b;border-radius:12px;background:Canvas;color:CanvasText;padding:20px;font:14px/1.6 "Segoe UI","Malgun Gothic",sans-serif}#codex-labels-account-dialog button{margin:4px;padding:5px 9px}#codex-labels-account-dialog section{border-top:1px solid #888;padding:10px 0}#codex-labels-account-dialog p{margin:7px 0}';
  document.head.appendChild(style);
  const button = document.createElement('button'); button.type = 'button'; button.id = 'codex-labels-account-switch';
  button.textContent = '요청 계정 · 실험'; button.setAttribute('aria-haspopup', 'dialog'); document.body.appendChild(button);
  const dialog = document.createElement('dialog'); dialog.id = 'codex-labels-account-dialog';
  dialog.setAttribute('aria-label', '세션 유지형 계정 전환'); document.body.appendChild(dialog);
  let profiles = [], state = {}, working = false, previousFocus, view = 'list';
  const errors = {
    SIGN_IN_REQUIRED: '해당 계정별 창에서 다시 로그인한 뒤 새로고침하세요.',
    BACKEND_UNAVAILABLE: '지원되는 로컬 stdio 백엔드를 찾지 못했습니다. 현재 작업은 변경하지 않았습니다.',
    WORK_IN_PROGRESS: '진행 중인 작업·승인 요청을 마친 뒤 전환하세요.',
    BACKGROUND_TERMINALS: '백그라운드 터미널이 남아 있어 전환하지 않았습니다.',
    UNSUPPORTED_SESSION: '현재 세션의 안전한 복원을 확인할 수 없어 전환하지 않았습니다.',
    IDENTITY_MISMATCH: '대상 계정의 인증 정보를 확인하지 못해 기존 계정을 유지했습니다.',
    RESTORE_FAILED: '대화·실행 설정 복원을 확인하지 못해 기존 계정을 유지했습니다.'
  };
  function node(tag, text) { const n = document.createElement(tag); if (text) n.textContent = text; return n; }
  function action(text, callback, disabled = false) {
    const b = node('button', text); b.type = 'button'; b.disabled = disabled; b.addEventListener('click', callback); return b;
  }
  function label() {
    const selected = profiles.find(p => p.id === state.profileId);
    button.textContent = `요청 계정: ${selected?.name || '확인 필요'} · ${state.phase === 'switching' ? '전환 중' : '실험'}`;
  }
  function usage(value) {
    if (!value) return '사용량 미조회';
    const parts = [value.primary, value.secondary].filter(Boolean).map(w => `${w.windowDurationMins / 60}시간 ${w.usedPercent}% 사용`);
    return (parts.join(' / ') || '사용량 정보 없음') + ` · ${new Date(value.checkedAt).toLocaleTimeString()} 조회`;
  }
  async function run(fn) {
    if (working) return;
    working = true; render();
    try { await fn(); }
    catch (error) {
      const code = Object.keys(errors).find(k => String(error.message).includes(k));
      message = code ? errors[code] : '요청을 완료하지 못했습니다. 계정 상태를 새로고침해 확인하세요.';
    } finally { working = false; render(); }
  }
  let message = '';
  async function load() { const result = await api.list(); profiles = result.profiles; state = result.state; label(); }
  function render() {
    view = 'list';
    dialog.replaceChildren(node('h2', '세션 유지형 계정 전환 · 실험'));
    dialog.append(node('p', '이 창의 로컬 대화 기록과 프로젝트는 유지하고, 이후 요청에 사용할 계정을 선택합니다. 실제 Windows 앱 검증 전인 실험 기능입니다.'));
    const notice = node('p', message || (!state.available ? '지원되는 백엔드 연결을 기다리는 중입니다.' : state.busy ? '현재 작업 중입니다. 전환은 작업이 끝난 뒤 가능합니다.' : '계정 이름은 저장한 프로필 이름입니다. 전환 시 서버 인증을 별도로 확인합니다.'));
    notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite'); dialog.appendChild(notice);
    for (const p of profiles) {
      const row = node('section'); row.append(node('strong', p.name + (state.profileId === p.id ? ' · 선택됨' : '')),
        node('p', p.signedIn ? p.email || '저장된 로그인 있음' : '로그인 갱신 필요'), node('p', usage(p.usage)));
      row.append(action('사용량 조회', () => run(async () => { const r = await api.usage(p.id); p.usage = r.usage; message = ''; }), working || !state.available || state.busy || !p.signedIn));
      row.append(action('이 계정으로 전환', () => {
        view = 'confirm';
        dialog.replaceChildren(node('h2', `${p.name} 계정으로 계속할까요?`), node('p', '이 창에 로드된 모든 로컬 대화의 후속 요청이 이 계정으로 전송됩니다. 기존 대화·파일 내용이 다른 계정이나 조직의 처리 정책에 적용될 수 있습니다. 전송 권한이 있는 경우에만 진행하세요.'));
        dialog.append(action('취소', render), action('확인하고 전환', () => run(async () => {
          const result = await api.switchTo(p.id, true); state = result.state;
          message = `백엔드 전환 및 로컬 대화 ${result.resumedThreads}개 복원 확인. 실제 요청 계정은 Windows 통합 검증이 필요합니다.`;
          await load();
        })));
      }, working || !state.available || state.busy || !p.signedIn || state.profileId === p.id)); dialog.appendChild(row);
    }
    dialog.append(node('p', '계정 추가·이름 변경·삭제는 기존 계정별 실행 도구를 이용하세요. 앱을 다시 실행하면 이 창의 원래 프로필 계정으로 돌아갑니다.'));
    dialog.append(action('새로고침', () => run(load), working), action('닫기', () => dialog.close(), working)); label();
  }
  button.addEventListener('pointerdown', () => { previousFocus = document.activeElement; });
  button.addEventListener('click', async () => {
    previousFocus ||= document.activeElement; dialog.showModal(); await run(load);
  });
  dialog.addEventListener('cancel', event => { if (working) event.preventDefault(); });
  dialog.addEventListener('close', () => previousFocus?.focus?.({preventScroll: true}));
  const off = api.onState(next => { state = next; label(); if (dialog.open && view === 'list' && !working) render(); });
  window.addEventListener('pagehide', off, {once: true});
  load().catch(() => { button.textContent = '요청 계정 · 연결 확인 필요'; });
})();
