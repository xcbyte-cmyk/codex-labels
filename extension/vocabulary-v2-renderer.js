((factory) => {
  'use strict';
  const inlineCore=factory();
  if(typeof window==='undefined'){module.exports=inlineCore;return;}
  let highlights=null;
  const api=window.codexLabels;
  if(!api?.vocabularyRead||window.__codexVocabularyInstalled)return;
  window.__codexVocabularyInstalled=true;
  const targetSelector='[data-selected-text-overlay-target]';
  const toolbarSelector='div[role="presentation"].pointer-events-auto';
  let selected=null, dialogState=null, frame=0, disposed=false, cached=null, cacheAt=0, cacheRead=null, cacheEpoch=0;
  const key=value=>(value||'').normalize('NFKC').toLocaleLowerCase('en').replace(/\s+/g,' ').trim();
  const buttons=new Set();
  const style=document.createElement('style');style.id='cdx-vocabulary-style';
  style.textContent=`
    .cdx-vocabulary-action{white-space:nowrap;flex-shrink:0}
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
  style.textContent+=`
    #cdx-vocabulary .vb-meta{font-size:12px;color:var(--vb-muted);margin-top:8px;overflow-wrap:anywhere}
    #cdx-vocabulary .vb-context{margin-top:16px;border-top:1px solid var(--vb-line);padding-top:10px}
    #cdx-vocabulary .vb-context summary{cursor:pointer;font-size:12px}#cdx-vocabulary .vb-context p{white-space:pre-wrap;overflow-wrap:anywhere;max-height:140px;overflow:auto;font-size:12px;margin-top:8px}
    #cdx-vocabulary .vb-editor label{display:block;font-size:12px;margin-top:12px}#cdx-vocabulary .vb-editor input:not([type=checkbox]),#cdx-vocabulary textarea,#cdx-vocabulary select{display:block;width:100%;min-width:0;padding:8px;border:1px solid var(--vb-line);border-radius:8px;background:var(--vb-bg);color:inherit;font:inherit}
    #cdx-vocabulary textarea{resize:vertical}#cdx-vocabulary textarea:focus-visible,#cdx-vocabulary select:focus-visible{outline:2px solid #548de8;outline-offset:2px}
    #cdx-vocabulary .vb-filters{display:flex;gap:8px;align-items:center;margin-bottom:12px}#cdx-vocabulary .vb-filters select{width:auto;max-width:100%;flex:1}#cdx-vocabulary .vb-filters label{white-space:nowrap;font-size:12px}
    #cdx-vocabulary .vb-card-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
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
    const content=block.textContent||'', prefix=range.cloneRange();
    // Locate the actual occurrence, not the first matching word in a paragraph.
    prefix.selectNodeContents(block);prefix.setEnd(range.startContainer,range.startOffset);
    const selectedText=range.toString();
    const offset=prefix.toString().length+selectedText.length-selectedText.trimStart().length;
    const start=Math.max(0,offset-450);
    const localPath=location.pathname;
    return {term,context:content.slice(start,start+1600).trim(),source:{title:document.title.slice(0,200),
      path:localPath.length<=300&&/^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]*$/.test(localPath)?localPath:''}};
  }
  function addToolbar(toolbar){
    if(!selected||dialogState||!toolbar.matches(toolbarSelector)||toolbar.querySelector('.cdx-vocabulary-action'))return;
    const native=[...toolbar.querySelectorAll('button')].find(b=>['채팅에 추가','Add to chat'].includes(b.textContent.trim()));
    if(!native||!toolbar.getClientRects().length)return;
    const b=button('단어장',native.className+' cdx-vocabulary-action',()=>{});
    b.title='선택한 단어의 뜻을 요약하고 저장';buttons.add(b);native.insertAdjacentElement('afterend',b);markButtons();
  }
  function scan(node){
    if(!(node instanceof Element)||node.closest('#cdx-vocabulary'))return;
    if(node.matches(toolbarSelector))addToolbar(node);
    const parent=node.closest(toolbarSelector);if(parent)addToolbar(parent);
    node.querySelectorAll(toolbarSelector).forEach(addToolbar);
  }
  function markButtons(){
    const exists=selected&&cached?.entries.some(e=>key(e.term)===key(selected.term));
    for(const b of buttons){const label=exists?'✓ 단어장':'단어장';if(b.textContent!==label)b.textContent=label;b.title=exists?'저장된 뜻 보기 · 새 의미 추가':'선택한 단어의 뜻을 요약하고 저장';}
  }
  function remember(snapshot){cacheEpoch++;cached=snapshot;cacheAt=Date.now();markButtons();highlights?.setSnapshot(snapshot);}
  function checkSaved(){
    markButtons();if(cacheRead||Date.now()-cacheAt<3000)return;
    const epoch=cacheEpoch;
    cacheRead=api.vocabularyRead().then(data=>{if(!disposed&&epoch===cacheEpoch)remember(data);}).catch(()=>{if(epoch===cacheEpoch){cached=null;markButtons();}}).finally(()=>{cacheRead=null;});
  }
  function updateSelection(){
    frame=0;if(disposed||dialogState)return;
    selected=capture();
    for(const b of buttons)if(!selected||!b.isConnected){b.remove();buttons.delete(b);}
    if(selected){document.querySelectorAll(toolbarSelector).forEach(addToolbar);checkSaved();}
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
  function discard(s){return !s.dirty||window.confirm('저장하지 않은 수정 내용을 버릴까요?');}
  function close(){
    const s=dialogState;if(!s||s.writing||!discard(s))return;
    dialogState=null;api.vocabularyCancel().catch(()=>{});s.dialog.close();s.dialog.remove();
    if(s.opener?.isConnected)s.opener.focus({preventScroll:true});selected=null;
  }
  function message(s,value,isError=false){if(dialogState!==s)return;s.notice.textContent=value;s.notice.toggleAttribute('data-error',isError);}
  function controls(s){
    const locked=s.busy||s.writing||s.refreshing;
    s.save.disabled=locked||!(s.draft||s.saved&&s.editing);
    s.save.textContent=s.saved?(s.editing?'수정 저장':'저장됨'):'단어장에 저장';
    s.edit.disabled=locked||!(s.draft||s.saved);s.edit.textContent=s.editing?'편집 취소':'뜻 편집';
    s.retry.disabled=locked;s.retry.hidden=!!s.saved||!s.input;
    s.add.hidden=!s.saved;s.add.disabled=locked;
    s.cancel.hidden=!s.busy;s.refresh.disabled=locked;
    for(const field of Object.values(s.fields))field.disabled=locked;
    for(const button of s.list.querySelectorAll('button'))button.disabled=locked;
  }
  function fill(s,item){
    for(const name of ['meaning','example','partOfSpeech','explanation'])s.fields[name].value=item[name]||'';
    s.fields.tags.value=(item.tags||[]).join(', ');s.fields.favorite.checked=!!item.favorite;s.fields.status.value=item.status||'new';
  }
  function collect(s){return {meaning:s.fields.meaning.value,example:s.fields.example.value,partOfSpeech:s.fields.partOfSpeech.value,
    explanation:s.fields.explanation.value,tags:s.fields.tags.value.split(',').map(t=>t.trim()).filter(Boolean),
    favorite:s.fields.favorite.checked,status:s.fields.status.value};}
  function detail(s,item){
    s.title.textContent=item.term;s.meaning.textContent=item.meaning;
    s.meta.textContent=[item.partOfSpeech,(item.tags||[]).join(' · ')].filter(Boolean).join(' · ');
    s.explanation.textContent=item.explanation||'';s.explanation.hidden=!item.explanation;
    s.example.textContent=item.example||'';s.example.hidden=!item.example;
    s.context.textContent=item.context||'저장된 원문 문맥이 없습니다.';
    s.source.textContent=[item.source?.title,item.source?.path].filter(Boolean).join(' · ');
    s.contextBox.hidden=false;s.editor.hidden=!s.editing;s.preview.hidden=s.editing;
    fill(s,item);controls(s);
  }
  function showItem(s,item){
    s.saved=item;s.draft=null;s.editing=false;s.dirty=false;s.editRevision=s.snapshot.revision;
    s.input=s.selectionInput&&key(s.selectionInput.term)===key(item.term)?s.selectionInput:{term:item.term,context:item.context||'',source:item.source};
    detail(s,item);
  }
  async function mutate(s,action,onSuccess){
    if(s.busy||s.writing||s.refreshing)return;
    s.writing=true;controls(s);
    try{const snapshot=await action();if(dialogState!==s)return false;s.snapshot=snapshot;remember(snapshot);drawList(s);onSuccess?.();return true;}
    catch(e){message(s,e.message||'단어장 변경에 실패했습니다.',true);return false;}
    finally{if(dialogState===s){s.writing=false;controls(s);}}
  }
  function drawList(s){
    const q=key(s.search.value);s.list.replaceChildren();
    const items=(s.snapshot?.entries||[]).filter(e=>key([e.term,e.meaning,e.explanation,e.context,...(e.tags||[])].join(' ')).includes(q))
      .filter(e=>!s.favorites.checked||e.favorite).filter(e=>!s.statusFilter.value||(e.status||'new')===s.statusFilter.value);
    s.count.textContent='저장한 뜻 '+(s.snapshot?.entries.length??0);
    if(!items.length){s.list.append(el('p','vb-empty',q||s.favorites.checked||s.statusFilter.value?'일치하는 단어가 없습니다.':'저장한 단어가 여기에 표시됩니다.'));return;}
    for(const item of items){
      const card=el('article','vb-card'),head=el('div','vb-card-head'),actions=el('div','vb-card-actions');
      head.append(el('strong','',item.term));card.append(head,el('p','',item.meaning));
      if(item.example)card.append(el('p','',item.example));
      const metadata=[item.partOfSpeech,...(item.tags||[]),({new:'미학습',review:'복습 필요',known:'숙지함'})[item.status||'new']].filter(Boolean);
      card.append(el('p','',metadata.join(' · ')));
      const view=button('열기','',()=>{if(s.busy||s.writing||s.refreshing||!discard(s))return;showItem(s,item);message(s,'저장된 뜻입니다. AI를 다시 호출하지 않았습니다.');});
      view.setAttribute('aria-label',item.term+' 뜻 열기');
      const favorite=button(item.favorite?'★':'☆','',()=>{
        if(s.dirty){message(s,'편집을 저장하거나 취소한 뒤 즐겨찾기를 변경하세요.',true);return;}
        mutate(s,()=>api.vocabularyEdit(item.id,{favorite:!item.favorite},s.snapshot.revision),()=>{
          if(s.saved?.id===item.id)showItem(s,s.snapshot.entries.find(e=>e.id===item.id));message(s,'즐겨찾기를 변경했습니다.');
        });
      });favorite.setAttribute('aria-label',item.term+' 즐겨찾기');favorite.setAttribute('aria-pressed',String(!!item.favorite));
      const del=button('삭제','',()=>{
        if(s.busy||s.writing||s.refreshing)return;
        if(!del.hasAttribute('data-confirm')){del.setAttribute('data-confirm','');del.textContent='삭제 확인';return;}
        if(!discard(s))return;
        mutate(s,()=>api.vocabularyDelete(item.id,s.snapshot.revision),()=>{
          if(s.saved?.id===item.id){s.saved=null;s.draft=null;s.dirty=false;s.editing=false;s.editor.hidden=true;s.preview.hidden=false;
            s.meaning.textContent='삭제된 항목입니다. 다시 요약하여 저장할 수 있습니다.';s.contextBox.hidden=true;s.example.hidden=true;s.explanation.hidden=true;s.meta.textContent='';}
          message(s,'“'+item.term+'”을 삭제했습니다.');
        });
      });del.setAttribute('aria-label',item.term+' 삭제');actions.append(view,favorite,del);card.append(actions);s.list.append(card);
    }
    controls(s);
  }
  async function refresh(s){
    if(s.busy||s.writing||s.refreshing)return false;
    if(s.dirty){message(s,'수정 내용을 저장하거나 편집 취소 후 새로고침하세요.',true);return false;}
    s.refreshing=true;controls(s);
    try{const data=await api.vocabularyRead();if(dialogState!==s)return false;s.snapshot=data;remember(data);drawList(s);
      if(s.saved){const current=data.entries.find(e=>e.id===s.saved.id);if(current)showItem(s,current);else {s.saved=null;s.editing=false;s.editor.hidden=true;s.preview.hidden=false;s.meaning.textContent='다른 창에서 삭제된 항목입니다.';}}
      message(s,'현재 창의 단어장 · 이 PC에 저장됩니다.');return true;
    }catch(e){message(s,e.message,true);return false;}finally{if(dialogState===s){s.refreshing=false;controls(s);}}
  }
  async function summarize(s){
    if(!s.input||s.busy||s.writing||s.refreshing||!discard(s))return;
    s.busy=true;s.cancelled=false;s.draft=null;s.saved=null;s.editing=false;s.dirty=false;s.editor.hidden=true;s.preview.hidden=false;
    s.title.textContent=s.input.term;s.meaning.textContent='뜻을 요약하고 있습니다…';s.example.hidden=true;s.explanation.hidden=true;s.meta.textContent='';
    s.contextBox.hidden=false;s.context.textContent=s.input.context||'주변 문맥이 없습니다.';s.source.textContent=[s.input.source?.title,s.input.source?.path].filter(Boolean).join(' · ');controls(s);
    message(s,'현재 Codex 로그인으로 요약 중 · GPT-5.6 Luna / xhigh');
    try{
      const draft=await api.vocabularySummarize(s.input);if(dialogState!==s||s.cancelled)return;
      s.draft=draft;detail(s,draft);message(s,'현재 문맥의 뜻입니다. 필요하면 편집한 뒤 새 의미로 저장하세요.');
    }catch(e){if(dialogState===s&&!s.cancelled){s.meaning.textContent='요약을 완료하지 못했습니다.';message(s,e.message,true);}}
    finally{if(dialogState===s){s.busy=false;controls(s);}}
  }
  async function save(s){
    if(!s.snapshot||!s.draft&&!(s.saved&&s.editing))return;
    const patch=s.editing?collect(s):{};
    const draft=s.draft,existing=s.saved;
    await mutate(s,()=>draft?api.vocabularySave(draft.id,s.snapshot.revision,{mode:'add',edits:patch}):api.vocabularyEdit(existing.id,patch,s.editRevision),()=>{
      const item=s.snapshot.entries.find(e=>e.id===(existing||draft).id)||s.snapshot.entries.find(e=>key(e.term)===key(draft?.term));
      if(item)showItem(s,item);message(s,'저장했습니다. 원문 문맥과 출처는 함께 보관됩니다.');
    });
  }
  function toggleEdit(s){
    if(s.busy||s.writing||s.refreshing||!(s.draft||s.saved))return;
    if(s.editing){if(!discard(s))return;s.editing=false;s.dirty=false;detail(s,s.draft||s.saved);return;}
    s.editing=true;s.dirty=false;detail(s,s.draft||s.saved);s.fields.meaning.focus();
  }
  async function open(input,entryId=null,editEntry=false){
    if(dialogState)return;
    const dialog=el('dialog');dialog.id='cdx-vocabulary';dialog.setAttribute('aria-labelledby','cdx-vocabulary-title');
    const s={dialog,input,selectionInput:input,opener:document.activeElement,snapshot:null,draft:null,saved:null,busy:false,writing:false,refreshing:false,editing:false,dirty:false,fields:{}};dialogState=s;
    const head=el('header','vb-head'),titles=el('div'),title=el('h2','','단어장');title.id='cdx-vocabulary-title';
    titles.append(title,el('p','vb-subtitle','읽던 문맥과 함께 저장하는 나만의 용어집'));head.append(titles,button('×','vb-close',close));head.lastChild.setAttribute('aria-label','단어장 닫기');
    const main=el('div','vb-main'),summary=el('section','vb-pane'),library=el('section','vb-pane vb-library');
    s.title=el('h3','',input?.term||'읽은 내용을 오래 기억하세요');summary.append(el('div','vb-eyebrow','GPT-5.6 LUNA · XHIGH'),s.title);
    s.preview=el('div');s.meta=el('p','vb-meta');s.meaning=el('p','vb-meaning',input?'단어장을 불러오고 있습니다…':'답변에서 단어나 구절을 선택하거나, 저장한 뜻을 열어 보세요.');
    s.explanation=el('p','vb-meaning');s.explanation.hidden=true;s.example=el('p','vb-example');s.example.hidden=true;
    s.preview.append(s.meta,s.meaning,s.explanation,s.example);s.editor=el('div','vb-editor');s.editor.hidden=true;
    for(const [name,label,limit,rows] of [['partOfSpeech','품사 / 표현 유형',80,0],['meaning','문맥상 뜻',1600,3],['explanation','짧은 설명',800,2],['example','예문',600,2],['tags','태그 (쉼표로 구분, 최대 5개)',124,0]]){
      const wrapper=el('label','',label),field=el(rows?'textarea':'input');field.maxLength=limit;if(rows)field.rows=rows;
      field.addEventListener('input',()=>{s.dirty=true;});s.fields[name]=field;wrapper.append(field);s.editor.append(wrapper);
    }
    const statusLabel=el('label','','학습 상태');s.fields.status=el('select');s.fields.status.setAttribute('aria-label','학습 상태');
    for(const [value,label] of [['new','미학습'],['review','복습 필요'],['known','숙지함']]){const option=el('option','',label);option.value=value;s.fields.status.append(option);}
    s.fields.status.addEventListener('change',()=>{s.dirty=true;});statusLabel.append(s.fields.status);s.editor.append(statusLabel);
    const favoriteLabel=el('label');s.fields.favorite=el('input');s.fields.favorite.type='checkbox';s.fields.favorite.addEventListener('change',()=>{s.dirty=true;});favoriteLabel.append(s.fields.favorite,document.createTextNode(' 즐겨찾기'));s.editor.append(favoriteLabel);
    s.contextBox=el('details','vb-context');s.contextBox.hidden=true;s.contextBox.open=true;s.context=el('p');s.source=el('p','vb-meta');s.contextBox.append(el('summary','','원문 문맥 / 출처'),s.context,s.source);
    const actions=el('div','vb-actions');s.save=button('단어장에 저장','vb-primary',()=>save(s));s.edit=button('뜻 편집','',()=>toggleEdit(s));
    s.retry=button('다시 요약','',()=>summarize(s));s.add=button('새 의미 추가','',()=>summarize(s));
    s.cancel=button('요약 취소','',()=>{s.cancelled=true;s.cancel.disabled=true;s.meaning.textContent='요약을 취소했습니다.';message(s,'취소한 결과는 저장하지 않습니다.');api.vocabularyCancel().catch(e=>message(s,e.message,true)).finally(()=>{s.cancel.disabled=false;});});
    actions.append(s.save,s.edit,s.retry,s.add,s.cancel);summary.append(s.preview,s.editor,s.contextBox,actions,el('p','vb-note','단어와 주변 문맥만 AI에 전달합니다. 출처는 로컬에만 저장하며, 새 의미는 기존 뜻을 덮어쓰지 않습니다.'));
    const libraryHead=el('div','vb-library-head');s.count=el('h3','','저장한 뜻');s.refresh=button('새로고침','vb-refresh',()=>refresh(s));libraryHead.append(s.count,s.refresh);
    s.search=el('input','vb-search');s.search.type='search';s.search.placeholder='단어, 뜻, 태그, 원문 검색';s.search.setAttribute('aria-label','저장한 단어 검색');s.search.addEventListener('input',()=>drawList(s));
    const filters=el('div','vb-filters'),favoritesLabel=el('label');s.favorites=el('input');s.favorites.type='checkbox';s.favorites.addEventListener('change',()=>drawList(s));favoritesLabel.append(s.favorites,document.createTextNode(' 즐겨찾기만'));
    s.statusFilter=el('select');s.statusFilter.setAttribute('aria-label','학습 상태 필터');for(const [value,label] of [['','전체 상태'],['new','미학습'],['review','복습 필요'],['known','숙지함']]){const option=el('option','',label);option.value=value;s.statusFilter.append(option);}s.statusFilter.addEventListener('change',()=>drawList(s));filters.append(favoritesLabel,s.statusFilter);
    s.list=el('div','vb-list');library.append(libraryHead,s.search,filters,s.list);main.append(summary,library);
    s.notice=el('div','vb-notice','단어장을 불러오고 있습니다…');s.notice.setAttribute('role','status');s.notice.setAttribute('aria-live','polite');
    dialog.append(head,main,s.notice);document.body.append(dialog);controls(s);
    dialog.addEventListener('cancel',e=>{e.preventDefault();close();});dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)close();}});
    for(const b of buttons)b.remove();buttons.clear();selected=null;dialog.showModal();window.getSelection()?.removeAllRanges();
    if(!await refresh(s)||dialogState!==s)return;
    if(entryId){
      const item=s.snapshot.entries.find(e=>e.id===entryId);
      if(item){showItem(s,item);if(editEntry)toggleEdit(s);message(s,'저장된 뜻입니다. AI를 다시 호출하지 않았습니다.');}
      else message(s,'이 항목은 삭제되었거나 다른 창에서 변경되었습니다.',true);
    }else if(input){
      const matches=s.snapshot.entries.filter(e=>key(e.term)===key(input.term));
      if(matches.length){showItem(s,matches.find(e=>e.context===input.context)||matches[0]);message(s,'저장된 뜻 '+matches.length+'개입니다. 현재 문맥과 다르면 “새 의미 추가”를 누르세요.');}
      else await summarize(s);
    }
  }
  function showLibrary(){open(null);}
  window.addEventListener('codex-labels:open-vocabulary',showLibrary);
  highlights=inlineCore.install({api,onSnapshot:remember,openEntry:(id,edit)=>open(null,id,edit)});
  window.addEventListener('pagehide',()=>{
    disposed=true;highlights?.dispose();observer.disconnect();cancelAnimationFrame(frame);api.vocabularyCancel().catch(()=>{});
    for(const name of ['pointerdown','mousedown','click'])document.removeEventListener(name,toolbarEvent,true);
    document.removeEventListener('selectionchange',schedule);window.removeEventListener('codex-labels:open-vocabulary',showLibrary);
    dialogState?.dialog.remove();dialogState=null;for(const b of buttons)b.remove();buttons.clear();style.remove();
  },{once:true});
})(() => {
  // This factory is also exported under Node for matcher regression tests. It
  // has no native/IPC access and does not touch the DOM until install() is called.
  const graphemes = new Intl.Segmenter('en', {granularity:'grapheme'});
  const WORD = /[\p{L}\p{N}\p{M}_]/u;
  const fold = value => value.normalize('NFKC').toLocaleLowerCase('en').replace(/ς/g,'σ');
  function normalizedMap(value) {
    let text = ''; const starts = [], ends = [];
    for (const {segment,index} of graphemes.segment(value)) {
      for (const char of fold(segment)) {
        if (/\s/u.test(char)) {
          if (!text || text.endsWith(' ')) { if(text)ends[ends.length-1]=index+segment.length; continue; }
          text+=' '; starts.push(index); ends.push(index+segment.length);
        } else {
          text+=char;
          for(let i=0;i<char.length;i++){starts.push(index);ends.push(index+segment.length);}
        }
      }
    }
    if(text.endsWith(' ')){text=text.slice(0,-1);starts.pop();ends.pop();}
    return {text,starts,ends};
  }
  const termKey = value => normalizedMap(value).text;
  const beforeChar = (text,index) => {
    if(!index)return '';
    const last=text.charCodeAt(index-1);
    return last>=0xDC00&&last<=0xDFFF&&index>1?text.slice(index-2,index):text[index-1];
  };
  function createMatcher(entries) {
    const groups = new Map(), root = {next:new Map()};
    for(const entry of entries.slice(0,2000)) {
      if(typeof entry?.term!=='string'||!entry.term.trim()||entry.term.length>160)continue;
      const key=termKey(entry.term);if(!key)continue;
      if(!groups.has(key))groups.set(key,[]);groups.get(key).push(entry);
    }
    for(const key of groups.keys()) {
      let node=root;
      // UTF-16 positions deliberately agree with DOM Range offsets.
      for(let i=0;i<key.length;i++){
        if(!node.next.has(key[i]))node.next.set(key[i],{next:new Map()});
        node=node.next.get(key[i]);
      }
      node.key=key;
    }
    function find(value) {
      const {text,starts,ends}=normalizedMap(value),found=[];
      for(let i=0;i<text.length;i++) {
        if(WORD.test(beforeChar(text,i))||(i>0&&starts[i]===starts[i-1]))continue;
        let node=root,last=null;
        for(let j=i;j<text.length;j++) {
          node=node.next.get(text[j]);if(!node)break;
          const end=j+1;
          if(node.key&&!WORD.test(String.fromCodePoint(text.codePointAt(end)||0))&&
            (end===text.length||ends[end-1]!==ends[end]))last={key:node.key,end};
        }
        if(last){found.push({key:last.key,start:starts[i],end:ends[last.end-1]});i=last.end-1;}
      }
      return found;
    }
    return {groups,find,signature:JSON.stringify([...groups.keys()].sort())};
  }

  function install({api,onSnapshot,openEntry}) {
    const ROOT='[data-selected-text-overlay-target],[data-message-author-role="user"],[data-message-author-role="assistant"]';
    const BLOCK='p,div,section,article,header,footer,li,ul,ol,dt,dd,dl,td,th,tr,tbody,thead,table,blockquote,h1,h2,h3,h4,h5,h6,figure,figcaption';
    const OWN='[data-cdx-vocabulary-ui],#cdx-vocabulary,.cdx-vocabulary-action';
    const EXCLUDE=OWN+',a,pre,code,kbd,samp,input,textarea,button,select,option,[contenteditable]:not([contenteditable="false"]),[role="button"],[role="link"],[role="textbox"],[role="toolbar"],div[role="presentation"].pointer-events-auto,script,style,noscript,svg,math,iframe,canvas,video,audio,[hidden],[aria-hidden="true"],[inert]';
    const NAME='codex-vocabulary-saved';
    const supported=!!globalThis.CSS?.highlights&&typeof globalThis.Highlight==='function';
    let matcher=createMatcher([]),snapshot=null,stopped=false,timer=0,readTimer=0,epoch=0,reading=false,readAgain=false,popup=null,pointer=null;
    const records=new Map(),pending=new Set(),nodeMatches=new WeakMap();
    const paint=supported?new Highlight():null;
    if(paint)CSS.highlights.set(NAME,paint);
    const style=document.createElement('style');style.dataset.cdxVocabularyUi='';
    style.textContent=`
      ::highlight(codex-vocabulary-saved){text-decoration-line:underline;text-decoration-style:dotted;text-decoration-color:#64858e;text-decoration-thickness:1px}
      .dark ::highlight(codex-vocabulary-saved){text-decoration-color:#97c5d0}
      #cdx-vocabulary-access,#cdx-vocabulary-inline{--vi-bg:var(--color-surface,#fff);--vi-ink:var(--color-text,#202123);--vi-line:var(--color-border,#cdd3d7);--vi-muted:var(--color-text-secondary,#58636b);font:13px/1.6 'Segoe UI','Malgun Gothic',sans-serif;color:var(--vi-ink);background:var(--vi-bg);border:1px solid var(--vi-line);border-radius:10px;box-sizing:border-box}
      .dark #cdx-vocabulary-access,.dark #cdx-vocabulary-inline{--vi-bg:var(--color-surface,#23252a);--vi-ink:var(--color-text,#f1f3f5);--vi-line:var(--color-border,#50545b);--vi-muted:var(--color-text-secondary,#b8c0c8);color-scheme:dark}
      #cdx-vocabulary-access{position:fixed;right:16px;bottom:76px;z-index:10000;padding:5px 10px;cursor:pointer;max-width:calc(100vw - 32px)}
      #cdx-vocabulary-access[hidden]{display:none!important}
      #cdx-vocabulary-inline{position:fixed;z-index:10001;width:min(360px,calc(100vw - 24px));max-height:min(480px,calc(100vh - 24px));padding:16px;box-shadow:0 12px 42px #0003;overflow:auto;overscroll-behavior:contain;overflow-wrap:anywhere}
      #cdx-vocabulary-inline h3,#cdx-vocabulary-inline p{margin:0}#cdx-vocabulary-inline h3{font-size:17px;padding-right:28px}
      #cdx-vocabulary-inline .vi-sub{color:var(--vi-muted);font-size:11px;margin:5px 0 12px}
      #cdx-vocabulary-inline .vi-sense{border-top:1px solid var(--vi-line);padding-top:10px;margin-top:10px}
      #cdx-vocabulary-inline .vi-meta{color:var(--vi-muted);font-size:11px;margin-bottom:6px}
      #cdx-vocabulary-inline .vi-meaning,#cdx-vocabulary-inline .vi-example,#cdx-vocabulary-inline .vi-explanation{white-space:pre-wrap}
      #cdx-vocabulary-inline .vi-example,#cdx-vocabulary-inline .vi-explanation{color:var(--vi-muted);font-size:12px;margin-top:7px}
      #cdx-vocabulary-inline .vi-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}
      #cdx-vocabulary-inline button{font:inherit;color:inherit;background:transparent;border:1px solid var(--vi-line);border-radius:6px;padding:4px 8px;cursor:pointer}
      #cdx-vocabulary-inline button:disabled{opacity:.5;cursor:default}
      #cdx-vocabulary-inline .vi-close{position:absolute;right:10px;top:10px;border:0;font-size:17px;padding:0 7px}
      #cdx-vocabulary-inline .vi-word{display:block;width:100%;text-align:left;margin-top:7px}
      #cdx-vocabulary-inline .vi-status{font-size:12px;white-space:pre-wrap;margin-top:10px}
      #cdx-vocabulary-access:focus-visible,#cdx-vocabulary-inline button:focus-visible,#cdx-vocabulary-inline:focus-visible{outline:2px solid #588ca1;outline-offset:3px}
      @media(forced-colors:active){::highlight(codex-vocabulary-saved){text-decoration-color:LinkText}#cdx-vocabulary-access,#cdx-vocabulary-inline{border-color:ButtonText}}
    `;
    document.head.append(style);
    function el(tag,cls,text){const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;}
    function button(text,cls,action){const n=el('button',cls,text);n.type='button';n.addEventListener('click',action);return n;}
    const access=button('저장된 단어','',()=>{if(!supported)openEntry(null,false);else show(null,access);});
    access.id='cdx-vocabulary-access';access.dataset.cdxVocabularyUi='';access.hidden=supported;
    access.setAttribute('aria-label','이 대화의 저장된 단어 보기');access.setAttribute('aria-haspopup','dialog');access.setAttribute('aria-expanded','false');
    access.setAttribute('aria-keyshortcuts','Alt+Shift+V');access.title=supported?'밑줄 단어의 저장된 뜻 보기 · Alt+Shift+V':'이 실행본에서는 본문 강조를 지원하지 않습니다. 단어장은 열 수 있습니다.';
    document.body.append(access);
    const element=node=>node?.nodeType===1?node:node?.parentElement;
    function own(node){return !!element(node)?.closest(OWN);}
    function rootFor(node){const e=element(node);return e?.closest(ROOT)||null;}
    function unitFor(node){const e=element(node),root=rootFor(e);if(!root)return null;const block=e.closest(BLOCK);return block&&root.contains(block)?block:root;}
    function excluded(node){return !!element(node)?.closest(EXCLUDE);}
    function viable(unit){return unit.isConnected&&!!rootFor(unit)&&!excluded(unit);}
    function removeRanges(record){
      for(const hit of record.hits)paint?.delete(hit.range);
      for(const node of record.nodes)nodeMatches.delete(node);
      record.hits=[];record.nodes.clear();
    }
    function forget(unit){const record=records.get(unit);if(record)removeRanges(record);records.delete(unit);pending.delete(unit);intersection?.unobserve(unit);}
    function queue(unit){
      if(!unit||!supported||stopped)return;
      if(!viable(unit)){forget(unit);return;}
      let record=records.get(unit);
      if(!record){record={hits:[],nodes:new Set(),visible:!intersection,dirty:true};records.set(unit,record);intersection?.observe(unit);}
      else{removeRanges(record);record.dirty=true;}
      if(popup?.unit===unit)hide(false);
      pending.add(unit);schedule();
    }
    function queueTree(node,invalidate=false){
      const e=element(node);if(!e||own(e))return;
      // Existing records must be invalidated even after their eligibility changes.
      if(invalidate)for(const unit of records.keys())if((unit===e||e.contains(unit))&&!viable(unit))forget(unit);
      queue(unitFor(e));
      if(e.matches(ROOT)||rootFor(e)){
        if(!excluded(e)){if(e.matches(BLOCK)||e.matches(ROOT))queue(e);for(const n of e.querySelectorAll(BLOCK))queue(n);}
      }else for(const root of e.querySelectorAll(ROOT)){
        queue(root);for(const n of root.querySelectorAll(BLOCK))queue(n);
      }
    }
    const intersection=typeof IntersectionObserver==='function'?new IntersectionObserver(changes=>{
      for(const {target,isIntersecting} of changes){const r=records.get(target);if(!r)continue;r.visible=isIntersecting;if(isIntersecting&&r.dirty)pending.add(target);}
      schedule();
    },{rootMargin:'600px'}):null;
    function schedule(){if(!timer&&!stopped&&pending.size)timer=setTimeout(flush,40);}
    function runs(unit){
      const result=[];let spans=[],text='';
      const flush=()=>{if(text)result.push({text,spans});spans=[];text='';};
      const stack=[...unit.childNodes].reverse();
      if(excluded(unit))return result;
      while(stack.length){
        const node=stack.pop();
        if(node.nodeType===3){if(node.data){spans.push({node,start:text.length,end:text.length+node.data.length});text+=node.data;}continue;}
        if(node.nodeType!==1)continue;
        if(node.matches(EXCLUDE)||node.matches(BLOCK)||node.matches(ROOT)||node.tagName==='BR'||node.tagName==='HR'){flush();continue;}
        const css=getComputedStyle(node);
        if(css.display==='none'||css.visibility==='hidden'||css.visibility==='collapse'){flush();continue;}
        for(let i=node.childNodes.length-1;i>=0;i--)stack.push(node.childNodes[i]);
      }
      flush();return result;
    }
    function spanAt(spans,offset,isEnd=false){
      let lo=0,hi=spans.length-1;
      while(lo<hi){const mid=(lo+hi)>>1;if(spans[mid].end<offset||(!isEnd&&spans[mid].end===offset))lo=mid+1;else hi=mid;}
      return {span:spans[lo],index:lo};
    }
    function scanUnit(unit,record){
      record.dirty=false;removeRanges(record);
      if(!matcher.groups.size)return;
      const css=getComputedStyle(unit);if(!unit.getClientRects().length||css.display==='none'||css.visibility==='hidden'||css.visibility==='collapse')return;
      for(const run of runs(unit))for(const match of matcher.find(run.text)){
        const first=spanAt(run.spans,match.start),last=spanAt(run.spans,match.end,true);
        const bounds={startContainer:first.span.node,startOffset:match.start-first.span.start,endContainer:last.span.node,endOffset:match.end-last.span.start};
        let range;
        if(typeof StaticRange==='function')range=new StaticRange(bounds);
        else{range=document.createRange();range.setStart(bounds.startContainer,bounds.startOffset);range.setEnd(bounds.endContainer,bounds.endOffset);}
        const hit={key:match.key,range,unit};record.hits.push(hit);paint.add(range);
        for(let i=first.index;i<=last.index;i++){
          const node=run.spans[i].node;record.nodes.add(node);
          if(!nodeMatches.has(node))nodeMatches.set(node,[]);nodeMatches.get(node).push(hit);
        }
      }
    }
    function flush(){
      timer=0;if(stopped)return;
      const started=performance.now();let count=0;
      for(const unit of [...pending]){
        pending.delete(unit);const record=records.get(unit);if(!record)continue;
        if(!viable(unit)){forget(unit);continue;}
        if(!record.visible)continue;
        scanUnit(unit,record);
        if(++count>=24||performance.now()-started>8)break;
      }
      updateAccess();schedule();
    }
    function foundKeys(){const keys=new Set();for(const record of records.values())for(const hit of record.hits)keys.add(hit.key);return keys;}
    function updateAccess(){
      const count=foundKeys().size;
      const label=supported?'저장된 단어 · '+count:'단어장';if(access.textContent!==label)access.textContent=label;
      const hidden=supported&&(!count||!!document.querySelector('#cdx-vocabulary'));
      if(access.hidden!==hidden)access.hidden=hidden;
    }
    function liveRange(hit){
      const b=hit.range;if(!b.startContainer.isConnected||!b.endContainer.isConnected)return null;
      try{const r=document.createRange();r.setStart(b.startContainer,b.startOffset);r.setEnd(b.endContainer,b.endOffset);return r;}catch{return null;}
    }
    function hitAt(x,y){
      let caret=document.caretPositionFromPoint?.(x,y);
      if(!caret){const r=document.caretRangeFromPoint?.(x,y);if(r)caret={offsetNode:r.startContainer,offset:r.startOffset};}
      if(!caret||excluded(caret.offsetNode))return null;
      for(const hit of nodeMatches.get(caret.offsetNode)||[]){
        const r=liveRange(hit);if(!r||!r.isPointInRange(caret.offsetNode,caret.offset))continue;
        for(const rect of r.getClientRects())if(x>=rect.left&&x<=rect.right&&y>=rect.top&&y<=rect.bottom)return hit;
      }
      return null;
    }
    function hide(restore=true){
      if(!popup)return;const old=popup;popup=null;const focused=old.node.contains(document.activeElement);old.node.remove();access.setAttribute('aria-expanded','false');
      if(restore&&focused&&!access.hidden)access.focus({preventScroll:true});
    }
    function position(p){
      const box=p.node.getBoundingClientRect(),w=document.documentElement.clientWidth,h=window.innerHeight;
      const anchor=p.anchor||access.getBoundingClientRect();
      const left=Math.max(12,Math.min(anchor.left,w-box.width-12));
      const top=Math.max(12,Math.min(anchor.bottom+8,h-box.height-12));
      p.node.style.left=left+'px';p.node.style.top=top+'px';
    }
    function show(hit,opener){
      if(stopped||document.querySelector('#cdx-vocabulary'))return;
      const anchor=hit?liveRange(hit)?.getBoundingClientRect():opener?.getBoundingClientRect();
      if(hit&&!anchor)return;
      hide(false);
      const node=el('div');node.id='cdx-vocabulary-inline';node.dataset.cdxVocabularyUi='';node.tabIndex=-1;
      node.setAttribute('role','dialog');node.setAttribute('aria-label','저장된 단어 뜻');
      const p={node,key:hit?.key||null,unit:hit?.unit||null,anchor,writing:false};popup=p;access.setAttribute('aria-expanded','true');document.body.append(node);
      drawPopup(p);position(p);node.focus({preventScroll:true});
    }
    function drawPopup(p){
      if(popup!==p)return;
      const hadFocus=p.node.contains(document.activeElement);p.node.replaceChildren();
      const close=button('×','vi-close',()=>hide());close.setAttribute('aria-label','저장된 뜻 닫기');p.node.append(close);
      if(!p.key){
        p.node.append(el('h3','','이 대화의 저장된 단어'),el('p','vi-sub','밑줄 표시된 단어의 뜻을 선택하세요. · AI 호출 없음'));
        for(const key of [...foundKeys()].sort()){
          const entries=matcher.groups.get(key);if(!entries?.length)continue;
          const b=button(entries[0].term+' · '+entries.length+'개 뜻','vi-word',()=>{p.key=key;drawPopup(p);position(p);p.node.focus();});
          p.node.append(b);
        }
      }else{
        const entries=matcher.groups.get(p.key);if(!entries?.length){hide();return;}
        p.node.append(el('h3','',entries[0].term),el('p','vi-sub','저장된 뜻 '+entries.length+'개 · 현재 문맥의 뜻을 자동 판정하지 않습니다.'));
        for(const item of entries){
          const card=el('section','vi-sense');card.append(el('p','vi-meta',[item.partOfSpeech,...(item.tags||[])].filter(Boolean).join(' · ')),el('p','vi-meaning',item.meaning));
          if(item.explanation)card.append(el('p','vi-explanation',item.explanation));if(item.example)card.append(el('p','vi-example',item.example));
          const actions=el('div','vi-actions');
          actions.append(button('단어장 열기','',()=>{hide(false);openEntry(item.id,false);}),button('수정','',()=>{hide(false);openEntry(item.id,true);}));
          const del=button('삭제','',async()=>{
            if(p.writing)return;
            if(!del.dataset.confirm){del.dataset.confirm='yes';del.textContent='삭제 확인';return;}
            p.writing=true;for(const b of p.node.querySelectorAll('button'))b.disabled=true;
            try{const data=await api.vocabularyDelete(item.id,snapshot.revision);if(!stopped)onSnapshot(data);}
            catch(error){if(popup===p){p.status.textContent=error.message||'삭제하지 못했습니다. 단어장을 새로고침해 주세요.';p.status.setAttribute('role','alert');}}
            finally{p.writing=false;if(popup===p)for(const b of p.node.querySelectorAll('button'))b.disabled=false;}
          });del.setAttribute('aria-label',item.term+' 뜻 삭제');actions.append(del);card.append(actions);p.node.append(card);
        }
      }
      p.status=el('p','vi-status');p.status.setAttribute('role','status');p.node.append(p.status);
      if(hadFocus)p.node.focus({preventScroll:true});
    }
    function setSnapshot(data){
      if(stopped||!Array.isArray(data?.entries))return;
      epoch++;snapshot=data;
      const next=createMatcher(data.entries),changed=next.signature!==matcher.signature;matcher=next;
      if(changed){for(const [unit,r] of records){removeRanges(r);r.dirty=true;pending.add(unit);}schedule();}
      if(popup){drawPopup(popup);if(popup)position(popup);}
      updateAccess();
    }
    async function refresh(){
      if(stopped)return;
      if(reading){readAgain=true;return;}reading=true;const requestEpoch=epoch;
      try{const data=await api.vocabularyRead();if(!stopped&&requestEpoch===epoch)onSnapshot(data);else readAgain=true;}
      catch{if(!stopped){access.title='단어장 읽기에 실패했습니다. 창을 다시 선택하거나 단어장을 새로고침하세요.';}}
      finally{reading=false;if(readAgain&&!stopped){readAgain=false;requestRefresh();}}
    }
    function requestRefresh(){if(stopped||readTimer)return;readTimer=setTimeout(()=>{readTimer=0;refresh();},25);}
    function changed(){epoch++;requestRefresh();}
    const unsubscribe=typeof api.onVocabularyChanged==='function'?api.onVocabularyChanged(changed):null;
    const mutations=new MutationObserver(changes=>{
      let removed=false;
      for(const change of changes){
        if(own(change.target))continue;
        if(change.type==='characterData'){queue(unitFor(change.target));continue;}
        if(change.type==='attributes'){queueTree(change.target,true);continue;}
        queue(unitFor(change.target));
        for(const node of change.addedNodes)if(node.nodeType===1&&!own(node))queueTree(node);
        for(const node of change.removedNodes)if(node.nodeType===1&&!own(node))removed=true;
      }
      if(removed){for(const unit of records.keys())if(!unit.isConnected)forget(unit);if(popup?.unit&&!popup.unit.isConnected)hide(false);}
      if(document.querySelector('#cdx-vocabulary'))hide(false);
      updateAccess();
    });
    mutations.observe(document.body,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['hidden','aria-hidden','inert','contenteditable','role','class','style','data-selected-text-overlay-target','data-message-author-role']});
    function onPointer(e){if(!own(e.target))pointer={x:e.clientX,y:e.clientY,id:e.pointerId};}
    function onClick(e){
      if(own(e.target))return;
      if(popup)hide(false);
      if(e.defaultPrevented||e.button!==0||e.detail!==1||e.ctrlKey||e.metaKey||e.shiftKey||e.altKey||excluded(e.target)||document.querySelector('#cdx-vocabulary'))return;
      if(pointer&&Math.hypot(e.clientX-pointer.x,e.clientY-pointer.y)>6)return;
      if(!window.getSelection()?.isCollapsed)return;
      const hit=hitAt(e.clientX,e.clientY);if(hit)show(hit);
    }
    function onKey(e){
      if(e.key==='Escape'&&popup){e.preventDefault();e.stopPropagation();hide();return;}
      if(e.altKey&&e.shiftKey&&!e.ctrlKey&&!e.metaKey&&e.code==='KeyV'&&!excluded(e.target)&&!access.hidden){e.preventDefault();if(supported)show(null,access);else openEntry(null,false);}
    }
    function onVisibility(){if(!document.hidden)changed();else hide(false);}
    function onFocus(){changed();}
    function onScroll(e){if(popup&&!popup.node.contains(e.target))hide(false);}
    function onResize(){hide(false);}
    document.addEventListener('pointerdown',onPointer,true);document.addEventListener('click',onClick,true);document.addEventListener('keydown',onKey,true);
    document.addEventListener('visibilitychange',onVisibility);window.addEventListener('focus',onFocus);
    document.addEventListener('scroll',onScroll,true);window.addEventListener('resize',onResize);
    queueTree(document.body);requestRefresh();
    function dispose(){
      stopped=true;clearTimeout(timer);clearTimeout(readTimer);mutations.disconnect();intersection?.disconnect();unsubscribe?.();hide(false);
      for(const r of records.values())removeRanges(r);records.clear();pending.clear();
      if(paint&&CSS.highlights.get(NAME)===paint)CSS.highlights.delete(NAME);
      document.removeEventListener('pointerdown',onPointer,true);document.removeEventListener('click',onClick,true);document.removeEventListener('keydown',onKey,true);
      document.removeEventListener('visibilitychange',onVisibility);window.removeEventListener('focus',onFocus);
      document.removeEventListener('scroll',onScroll,true);window.removeEventListener('resize',onResize);style.remove();access.remove();
    }
    return {setSnapshot,dispose};
  }
  return {normalizedMap,termKey,createMatcher,install};
});
