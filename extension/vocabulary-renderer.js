(() => {
  'use strict';
  const api=window.codexLabels;
  if(!api?.vocabularyRead||window.__codexVocabularyInstalled)return;
  window.__codexVocabularyInstalled=true;
  const targetSelector='[data-selected-text-overlay-target]';
  const toolbarSelector='div[role="presentation"].pointer-events-auto';
  let selected=null, dialogState=null, frame=0, disposed=false;
  const buttons=new Set();
  const style=document.createElement('style');style.id='cdx-vocabulary-style';
  style.textContent=`
    .cdx-vocabulary-action{position:relative;white-space:nowrap;flex-shrink:0;margin-inline-start:2px;padding-inline-start:10px!important}
    .cdx-vocabulary-action::before{content:"";position:absolute;inset-block:4px;inset-inline-start:0;width:1px;background:currentColor;opacity:.34;pointer-events:none}
    #cdx-vocabulary{position:fixed;inset:0;margin:auto;--vb-bg:var(--color-surface,#fff);--vb-soft:var(--color-surface-secondary,#f5f5f5);--vb-ink:var(--color-text,#202123);--vb-muted:var(--color-text-secondary,#70747b);--vb-line:var(--color-border,#d9dce0);box-sizing:border-box;width:min(780px,calc(100vw - 32px));max-width:none;max-height:calc(100vh - 48px);padding:0;border:1px solid var(--vb-line);border-radius:18px;background:var(--vb-bg);color:var(--vb-ink);box-shadow:0 24px 90px #0005;font:13px/1.6 'Segoe UI','Malgun Gothic',sans-serif;overflow:auto}
    .dark #cdx-vocabulary{--vb-bg:var(--color-surface,#202123);--vb-soft:var(--color-surface-secondary,#292a2e);--vb-ink:var(--color-text,#f0f1f3);--vb-muted:var(--color-text-secondary,#a6a9b1);--vb-line:var(--color-border,#41434a);color-scheme:dark}
    #cdx-vocabulary::backdrop{background:#0006}#cdx-vocabulary *{box-sizing:border-box}#cdx-vocabulary [hidden]{display:none!important}
    #cdx-vocabulary h2,#cdx-vocabulary h3,#cdx-vocabulary p{margin:0}#cdx-vocabulary h2{font-weight:600;font-size:21px;letter-spacing:-.5px}#cdx-vocabulary h3{font-weight:600;font-size:18px;overflow-wrap:anywhere}
    #cdx-vocabulary .vb-head{display:flex;justify-content:space-between;gap:16px;padding:22px 24px 18px;border-bottom:1px solid var(--vb-line)}#cdx-vocabulary .vb-subtitle{font-size:12px;color:var(--vb-muted);margin-top:3px}
    #cdx-vocabulary button{border:1px solid var(--vb-line);border-radius:8px;background:transparent;color:inherit;padding:7px 11px;font:inherit;cursor:pointer;white-space:nowrap}#cdx-vocabulary button:hover{background:var(--vb-soft)}#cdx-vocabulary button:disabled{opacity:.45;cursor:default}#cdx-vocabulary button:focus-visible,#cdx-vocabulary input:focus-visible{outline:2px solid #548de8;outline-offset:2px}
    #cdx-vocabulary .vb-close{align-self:start;border:0;font-size:17px;padding:2px 9px}#cdx-vocabulary .vb-main{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr)}#cdx-vocabulary .vb-pane{padding:22px 24px;min-width:0}#cdx-vocabulary .vb-library{border-left:1px solid var(--vb-line)}
    #cdx-vocabulary .vb-eyebrow{font-size:11px;color:var(--vb-muted);margin-bottom:8px}#cdx-vocabulary .vb-meaning{margin-top:16px;white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px;line-height:1.8}#cdx-vocabulary .vb-example{margin-top:13px;padding:12px 14px;border-radius:9px;background:var(--vb-soft);white-space:pre-wrap;overflow-wrap:anywhere;color:var(--vb-muted)}
    #cdx-vocabulary .vb-actions{display:flex;gap:7px;flex-wrap:wrap;margin-top:20px}#cdx-vocabulary .vb-primary{background:var(--vb-ink);color:var(--vb-bg);border-color:transparent}#cdx-vocabulary .vb-primary:hover{opacity:.85;background:var(--vb-ink)}
    #cdx-vocabulary .vb-search{width:100%;margin:12px 0;padding:9px 11px;border:1px solid var(--vb-line);border-radius:8px;background:var(--vb-bg);color:inherit;font:inherit}#cdx-vocabulary .vb-library-head{display:flex;align-items:center;justify-content:space-between;gap:8px}#cdx-vocabulary .vb-library-head h3{font-size:14px}#cdx-vocabulary .vb-refresh{font-size:11px;padding:4px 7px}
    #cdx-vocabulary .vb-list{display:flex;flex-direction:column;gap:10px;max-height:340px;overflow:auto}#cdx-vocabulary .vb-card{border:1px solid var(--vb-line);border-radius:10px;padding:12px}#cdx-vocabulary .vb-card-head{display:flex;align-items:start;justify-content:space-between;gap:8px}#cdx-vocabulary .vb-card strong{overflow-wrap:anywhere;font-size:13px}#cdx-vocabulary .vb-card p{white-space:pre-wrap;overflow-wrap:anywhere;color:var(--vb-muted);font-size:12px;margin-top:7px}#cdx-vocabulary .vb-card button{padding:1px 6px;font-size:11px}#cdx-vocabulary .vb-card button[data-confirm]{color:#cc5656}
    #cdx-vocabulary .vb-empty{color:var(--vb-muted);padding:18px 0;font-size:12px}#cdx-vocabulary .vb-notice{padding:12px 24px;border-top:1px solid var(--vb-line);color:var(--vb-muted);font-size:12px;white-space:pre-wrap}#cdx-vocabulary .vb-notice[data-error]{color:#ce5e39}#cdx-vocabulary .vb-note{font-size:11px;color:var(--vb-muted);margin-top:16px}
    @media(max-width:620px){#cdx-vocabulary .vb-main{grid-template-columns:1fr}#cdx-vocabulary .vb-library{border-left:0;border-top:1px solid var(--vb-line)}#cdx-vocabulary .vb-pane{padding:18px}#cdx-vocabulary .vb-list{max-height:240px}}
  `;
  document.head.append(style);
  function el(tag,cls,value){const n=document.createElement(tag);if(cls)n.className=cls;if(value!==undefined)n.textContent=value;return n;}
  function button(label,cls,action){const n=el('button',cls,label);n.type='button';n.addEventListener('click',action);return n;}
  function capture(){
    const s=window.getSelection();if(!s||s.isCollapsed||s.rangeCount!==1)return null;
    const range=s.getRangeAt(0), parent=range.commonAncestorContainer.nodeType===1?range.commonAncestorContainer:range.commonAncestorContainer.parentElement;
    const target=parent?.closest(targetSelector);
    if(!target||parent.closest('input,textarea,[contenteditable="true"],#cdx-vocabulary'))return null;
    const term=s.toString().trim();if(!term||term.length>160)return null;
    const block=parent.closest('p,li,pre,td,blockquote')||parent;
    // Use the selected DOM position, not the first matching phrase in the block.
    // Include trimmed leading whitespace so the retained term stays in context.
    const before=range.cloneRange();before.selectNodeContents(block);
    before.setEnd(range.startContainer,range.startOffset);
    const selectedText=range.toString();
    const content=block.textContent||'', offset=before.toString().length+selectedText.length-selectedText.trimStart().length;
    const start=Math.max(0,offset-450);
    return {term,context:content.slice(start,start+1600).trim()};
  }
  function addToolbar(toolbar){
    if(!selected||dialogState||!toolbar.matches(toolbarSelector)||toolbar.querySelector('.cdx-vocabulary-action'))return;
    const native=[...toolbar.querySelectorAll('button')].find(b=>['채팅에 추가','Add to chat'].includes(b.textContent.trim()));
    if(!native||!toolbar.getClientRects().length)return;
    const b=button('단어장',native.className+' cdx-vocabulary-action',()=>{});
    b.title='선택한 단어의 뜻을 요약하고 저장';buttons.add(b);native.insertAdjacentElement('afterend',b);
  }
  function scan(node){
    if(!(node instanceof Element)||node.closest('#cdx-vocabulary'))return;
    if(node.matches(toolbarSelector))addToolbar(node);
    const parent=node.closest(toolbarSelector);if(parent)addToolbar(parent);
    node.querySelectorAll(toolbarSelector).forEach(addToolbar);
  }
  function updateSelection(){
    frame=0;if(disposed||dialogState)return;
    selected=capture();
    for(const b of buttons)if(!selected||!b.isConnected){b.remove();buttons.delete(b);}
    if(selected)document.querySelectorAll(toolbarSelector).forEach(addToolbar);
  }
  function schedule(){if(!frame)frame=requestAnimationFrame(updateSelection);}
  const observer=new MutationObserver(records=>{
    if(!selected||dialogState)return;
    for(const m of records)for(const node of m.addedNodes)scan(node);
  });
  observer.observe(document.body,{childList:true,subtree:true});
  function toolbarEvent(e){
    if(!(e.target instanceof Element)||!e.target.closest('.cdx-vocabulary-action'))return;
    e.preventDefault();e.stopImmediatePropagation();
    if(e.type==='click'){const input=capture()||selected;if(input)open(input);}
  }
  for(const name of ['pointerdown','mousedown','click'])document.addEventListener(name,toolbarEvent,true);
  document.addEventListener('selectionchange',schedule);
  function close(){
    const s=dialogState;if(!s||s.writing)return;
    dialogState=null;api.vocabularyCancel().catch(()=>{});s.dialog.close();s.dialog.remove();
    if(s.opener?.isConnected)s.opener.focus({preventScroll:true});selected=null;
  }
  function message(s,value,isError=false){if(dialogState!==s)return;s.notice.textContent=value;s.notice.toggleAttribute('data-error',isError);}
  function drawList(s){
    const q=s.search.value.trim().toLocaleLowerCase();s.list.replaceChildren();
    const items=(s.snapshot?.entries||[]).filter(e=>(e.term+' '+e.meaning).toLocaleLowerCase().includes(q));
    s.count.textContent='저장한 단어 '+(s.snapshot?.entries.length??0);
    if(!items.length){s.list.append(el('p','vb-empty',q?'일치하는 단어가 없습니다.':'저장한 단어가 여기에 표시됩니다.'));return;}
    for(const item of items){
      const card=el('article','vb-card'),head=el('div','vb-card-head');
      const del=button('삭제','',async()=>{
        if(s.writing||s.refreshing)return;
        if(!del.hasAttribute('data-confirm')){del.setAttribute('data-confirm','');del.textContent='삭제 확인';return;}
        s.writing=true;del.disabled=true;
        try{s.snapshot=await api.vocabularyDelete(item.id,s.snapshot.revision);if(dialogState!==s)return;drawList(s);message(s,'“'+item.term+'”을 삭제했습니다.');}
        catch(e){message(s,e.message,true);del.disabled=false;}finally{s.writing=false;}
      });
      del.setAttribute('aria-label',item.term+' 삭제');head.append(el('strong','',item.term),del);card.append(head,el('p','',item.meaning));
      if(item.example)card.append(el('p','',item.example));s.list.append(card);
    }
  }
  async function refresh(s){
    if(s.writing||s.refreshing)return false;s.refreshing=true;s.refresh.disabled=true;
    try{const data=await api.vocabularyRead();if(dialogState!==s)return false;s.snapshot=data;drawList(s);message(s,'현재 창의 단어장 · 이 PC에 저장됩니다.');return true;}
    catch(e){message(s,e.message,true);return false;}finally{s.refreshing=false;s.refresh.disabled=false;}
  }
  async function summarize(s){
    if(!s.input||s.busy||s.writing)return;
    s.busy=true;s.draft=null;s.save.disabled=true;s.retry.disabled=true;s.cancel.hidden=false;
    s.meaning.textContent='뜻을 요약하고 있습니다…';s.example.hidden=true;
    message(s,'현재 Codex 로그인으로 요약 중 · GPT-5.6 Luna / xhigh');
    try{
      const draft=await api.vocabularySummarize(s.input);if(dialogState!==s)return;
      s.draft=draft;s.meaning.textContent=draft.meaning;s.example.textContent=draft.example;s.example.hidden=!draft.example;
      s.save.disabled=!s.snapshot;s.save.textContent='단어장에 저장';message(s,'요약을 확인한 뒤 저장하세요.');
    }catch(e){if(dialogState===s){s.meaning.textContent='요약을 완료하지 못했습니다.';message(s,e.message,true);}}
    finally{if(dialogState===s){s.busy=false;s.retry.disabled=false;s.cancel.hidden=true;}}
  }
  async function open(input){
    if(dialogState)return;
    const dialog=el('dialog');dialog.id='cdx-vocabulary';dialog.setAttribute('aria-labelledby','cdx-vocabulary-title');
    const s={dialog,input,opener:document.activeElement,snapshot:null,draft:null,busy:false,writing:false,refreshing:false};dialogState=s;
    const head=el('header','vb-head'),titles=el('div'),title=el('h2','','단어장');title.id='cdx-vocabulary-title';
    titles.append(title,el('p','vb-subtitle','읽다가 만난 단어를, 내 언어로.'));head.append(titles,button('×','vb-close',close));head.lastChild.setAttribute('aria-label','단어장 닫기');
    const main=el('div','vb-main'),summary=el('section','vb-pane'),library=el('section','vb-pane vb-library');
    summary.append(el('div','vb-eyebrow','GPT-5.6 LUNA · XHIGH'),el('h3','',input?.term||'읽은 내용을 오래 기억하세요'));
    s.meaning=el('p','vb-meaning',input?'단어장을 불러오고 있습니다…':'답변에서 단어나 짧은 구절을 드래그하고, 선택 메뉴의 ‘단어장’을 눌러 보세요.');
    s.example=el('p','vb-example');s.example.hidden=true;
    const actions=el('div','vb-actions');
    s.save=button('단어장에 저장','vb-primary',async()=>{
      if(!s.draft||!s.snapshot||s.writing||s.refreshing)return;s.writing=true;s.save.disabled=true;
      try{s.snapshot=await api.vocabularySave(s.draft.id,s.snapshot.revision);if(dialogState!==s)return;drawList(s);s.save.textContent='저장됨';message(s,'“'+s.draft.term+'”을 저장했습니다.');}
      catch(e){message(s,e.message,true);s.save.disabled=false;}finally{s.writing=false;}
    });s.save.disabled=true;
    s.retry=button('다시 요약','',()=>summarize(s));s.cancel=button('요약 취소','',()=>{s.cancel.disabled=true;api.vocabularyCancel().catch(e=>message(s,e.message,true)).finally(()=>{s.cancel.disabled=false;});});s.cancel.hidden=true;
    actions.append(s.save,s.retry,s.cancel);actions.hidden=!input;
    summary.append(s.meaning,s.example,actions,el('p','vb-note','선택한 단어와 주변 문맥만 요약에 사용합니다. 같은 단어를 다시 저장하면 기존 뜻을 갱신합니다.'));
    const libraryHead=el('div','vb-library-head');s.count=el('h3','','저장한 단어');s.refresh=button('새로고침','vb-refresh',()=>refresh(s));libraryHead.append(s.count,s.refresh);
    s.search=el('input','vb-search');s.search.type='search';s.search.placeholder='단어 또는 뜻 검색';s.search.setAttribute('aria-label','저장한 단어 검색');s.search.addEventListener('input',()=>drawList(s));
    s.list=el('div','vb-list');library.append(libraryHead,s.search,s.list);main.append(summary,library);
    s.notice=el('div','vb-notice','단어장을 불러오고 있습니다…');s.notice.setAttribute('role','status');s.notice.setAttribute('aria-live','polite');
    dialog.append(head,main,s.notice);document.body.append(dialog);
    dialog.addEventListener('cancel',e=>{e.preventDefault();close();});dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)close();}});
    for(const b of buttons)b.remove();buttons.clear();selected=null;
    dialog.showModal();window.getSelection()?.removeAllRanges();
    if(await refresh(s)&&input&&dialogState===s)await summarize(s);
  }
  function showLibrary(){open(null);}
  window.addEventListener('codex-labels:open-vocabulary',showLibrary);
  window.addEventListener('pagehide',()=>{
    disposed=true;observer.disconnect();cancelAnimationFrame(frame);api.vocabularyCancel().catch(()=>{});
    for(const name of ['pointerdown','mousedown','click'])document.removeEventListener(name,toolbarEvent,true);
    document.removeEventListener('selectionchange',schedule);window.removeEventListener('codex-labels:open-vocabulary',showLibrary);
    dialogState?.dialog.remove();dialogState=null;for(const b of buttons)b.remove();buttons.clear();style.remove();
  },{once:true});
})();
