(() => {
  'use strict';
  const api=window.codexSessionSwitcher;if(!api || document.getElementById('cdx-session-switcher-entry'))return;
  const el=(tag,text,attrs={})=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;Object.assign(n,attrs);return n;};
  const css=document.createElement('style');css.textContent=`
  #cdx-session-switcher-entry{position:fixed;bottom:14px;left:14px;z-index:2147483600;padding:8px 12px;border:1px solid #64748b;border-radius:9px;background:#182235;color:#f1f5f9;font:12px system-ui;cursor:pointer}
  #cdx-session-switcher{color:#e2e8f0;background:#111827;border:1px solid #475569;border-radius:14px;padding:24px;width:min(540px,85vw);font:14px/1.6 system-ui;z-index:2147483647}
  #cdx-session-switcher::backdrop{background:#0009}
  #cdx-session-switcher h2{font-size:20px;margin:0 0 8px}#cdx-session-switcher p{margin:10px 0}
  #cdx-session-switcher select{display:block;width:100%;padding:10px;margin:6px 0 14px;background:#1e293b;color:inherit;border:1px solid #64748b;border-radius:7px}
  #cdx-session-switcher button{padding:8px 12px;margin:5px 6px 0 0;border-radius:7px;border:1px solid #64748b;background:#263449;color:inherit;cursor:pointer}
  #cdx-session-switcher button:disabled{opacity:.45;cursor:default}#cdx-session-switcher .primary{background:#2457ba;border-color:#4775cf}
  #cdx-session-switcher label{display:block}#cdx-session-switcher .status{padding:10px;background:#1e293b;border-radius:8px;white-space:pre-wrap;overflow-wrap:anywhere}
  #cdx-session-switcher .muted{color:#94a3b8;font-size:12px}#cdx-session-switcher .consent{margin:14px 0}
  `;document.head.append(css);
  const entry=el('button','세션 Account Switcher',{id:'cdx-session-switcher-entry',type:'button'});document.body.append(entry);
  let dialog=null,unsubscribe=null,busy=false,current=null,chosenId=null,refreshTimer=null;
  function unwrap(r){if(!r?.ok)throw new Error(r?.error?.message||'연결 상태를 확인할 수 없습니다.');return r.value;}
  function open(preselect) {
    if(dialog){dialog.focus();return;}
    chosenId=preselect||null;
    dialog=el('dialog',null,{id:'cdx-session-switcher'});
    const heading=el('h2','같은 세션에서 계정 전환');
    const subtitle=el('p','현재 대화를 유지하고, 다음 요청부터 선택한 계정으로 보냅니다. 새 창을 여는 계정 선택기와는 별개입니다.');
    const threadLabel=el('label','전환할 로컬 대화'),threads=el('select',null,{ariaLabel:'전환할 로컬 대화'});threadLabel.append(threads);
    const profileLabel=el('label','다음 요청을 보낼 계정'),profiles=el('select',null,{ariaLabel:'다음 요청을 보낼 계정'});profileLabel.append(profiles);
    const status=el('div','연결을 확인하고 있습니다.',{className:'status',role:'status',ariaLive:'polite'});
    const consent=el('input',null,{type:'checkbox'}),consentLabel=el('label',null,{className:'consent'});
    consentLabel.append(consent,document.createTextNode(' 이 대화 기록·코드 문맥이 대상 계정에 전달될 수 있음에 동의합니다.'));
    const note=el('p','진행 중인 응답·도구·승인이 있으면 전환하지 않습니다. 대상 계정은 계정 선택기에서 먼저 로그인하세요. 원래 계정 메뉴는 창의 기본 계정이며, 이 대화의 계정은 아래 상태를 기준으로 확인하세요.',{className:'muted'});
    const change=el('button','이 세션의 계정 전환',{type:'button',className:'primary',disabled:true});
    const cancel=el('button','전환 취소',{type:'button',disabled:true}),usage=el('button','선택 세션 사용량',{type:'button'});
    const recover=el('button','복구 확인',{type:'button',hidden:true}),close=el('button','닫기',{type:'button'});
    dialog.append(heading,subtitle,threadLabel,profileLabel,status,consentLabel,note,change,cancel,usage,recover,close);document.body.append(dialog);dialog.showModal();
    function controls(){change.disabled=busy||!consent.checked||!current||current.phase!=='idle'||profiles.value===current.activeProfile.id;
      threads.disabled=busy;profiles.disabled=busy;usage.disabled=busy||!current||current.phase!=='idle';cancel.disabled=!busy;recover.hidden=current?.phase!=='blocked';}
    function showState(s){current=s;status.textContent=`이 대화의 계정: ${s.activeProfile.name}\n상태: ${s.phase}${s.blockedReason?' · '+s.blockedReason:''}\n세션 ID: ${s.logicalSessionId}`;controls();}
    async function inspect(){try{if(threads.value){chosenId=threads.value;showState(unwrap(await api.inspect(threads.value)));}}catch(e){current=null;status.textContent=e.message;controls();}}
    async function refresh(){
      try {
        const data=unwrap(await api.status());if(!dialog?.isConnected)return;
        const previous=threads.value||chosenId;
        threads.replaceChildren(...data.threads.map(t=>el('option',t.title,{value:t.id})));
        if(previous && data.threads.some(t=>t.id===previous))threads.value=previous;
        const oldProfile=profiles.value;profiles.replaceChildren(...data.profiles.map(p=>el('option',p.name,{value:p.id})));
        if(data.profiles.some(p=>p.id===oldProfile))profiles.value=oldProfile;
        if(!data.attached){current=null;status.textContent=data.error?.message||'로컬 앱 서버가 연결되지 않았습니다. 런타임 적용 후 Labels를 다시 실행하세요.';controls();return;}
        if(!threads.value){current=null;status.textContent='전환할 로컬 대화를 먼저 열어주세요.';controls();return;}
        await inspect();
      }catch(e){status.textContent=e.message;}
    }
    entry.textContent='세션 Account Switcher';
    threads.onchange=()=>{consent.checked=false;inspect();};profiles.onchange=()=>{consent.checked=false;controls();};consent.onchange=controls;
    change.onclick=async()=>{
      busy=true;controls();status.textContent='계정 확인 → 기록 복원 → 요청 경로 전환 중…';
      try{const r=unwrap(await api.switchAccount({threadId:threads.value,profileId:profiles.value,confirmContextTransfer:consent.checked}));showState(r.state);}
      catch(e){status.textContent=e.message;}
      finally{busy=false;consent.checked=false;controls();}
    };
    cancel.onclick=async()=>{try{unwrap(await api.cancel(threads.value));status.textContent='취소 및 대상 서버 정리를 확인하고 있습니다.';}catch(e){status.textContent=e.message;}};
    usage.onclick=async()=>{try{const value=unwrap(await api.usage(threads.value));status.textContent=value.length?value.map(v=>`${v.id}: ${v.primary?.usedPercent==null?'사용량 미제공':v.primary.usedPercent+'% 사용'}`).join('\n'):'사용량이 제공되지 않았습니다.';}catch(e){status.textContent=e.message;}};
    recover.onclick=async()=>{try{showState(unwrap(await api.recover(threads.value)));}catch(e){status.textContent=e.message;}};
    const dismiss=()=>{unsubscribe?.();unsubscribe=null;clearTimeout(refreshTimer);dialog?.remove();dialog=null;entry.focus();};
    close.onclick=()=>dialog.close();dialog.addEventListener('close',dismiss,{once:true});
    dialog.addEventListener('cancel',e=>{if(busy)e.preventDefault();});
    unsubscribe=api.onChanged(()=>{clearTimeout(refreshTimer);refreshTimer=setTimeout(()=>{if(!busy)refresh();},60);});
    refresh();
  }
  entry.onclick=()=>open();
  // Capturing the row's stable ID gives a Labels-native entry without altering
  // the upstream renderer's minified functions or guessing the selected route.
  document.addEventListener('contextmenu',event=>{
    if(!event.shiftKey)return;
    const row=event.target.closest?.('[data-app-action-sidebar-thread-id]');
    if(row && row.getAttribute('data-app-action-sidebar-thread-host-id')==='local'){
      event.preventDefault();open(row.getAttribute('data-app-action-sidebar-thread-id'));
    }
  },true);
})();
