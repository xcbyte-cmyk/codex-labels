(() => {
  'use strict';
  if (window.__codexLabelsInstalled || !window.codexLabels) return;
  window.__codexLabelsInstalled = true;
  const api = window.codexLabels;
  const threadSel='[data-app-action-sidebar-thread-row]';
  const projectSel='[data-app-action-sidebar-project-row]';
  let snapshot,signature='',menu=null,menuKey=null,opener=null,settings=null,openingSettings=false,scheduled=false,reading=false,writing=false,lastReport='';
  const style=document.createElement('style');style.id='codex-label-styles';
  style.textContent=`
    .cdx-label{display:inline-flex!important;align-items:center;justify-content:center;flex-shrink:0;white-space:nowrap;line-height:1.4;vertical-align:middle;font-family:inherit;font-weight:600;cursor:pointer;user-select:none;max-width:140px;overflow:hidden;text-overflow:ellipsis}
    .cdx-label[data-unset]{opacity:0.28;background:transparent!important;color:inherit!important;border:1px dashed currentColor;padding:0 4px!important}
    [data-app-action-sidebar-thread-row]:hover .cdx-label,[data-app-action-sidebar-project-row]:hover .cdx-label,.cdx-label:focus-visible{opacity:1}
    .cdx-label:focus-visible{outline:2px solid #7dd3fc;outline-offset:2px}
    #cdx-label-menu{position:fixed;z-index:2147483647;box-sizing:border-box;width:220px;padding:8px;border:1px solid #52565e;border-radius:10px;background:#202123;color:#f5f6f7;box-shadow:0 8px 30px #0006;font:13px/1.5 'Segoe UI','Malgun Gothic',sans-serif;max-height:80vh;overflow:auto}
    #cdx-label-menu button{display:flex;align-items:center;gap:9px;width:100%;background:transparent;color:inherit;border:0;border-radius:5px;padding:8px;text-align:left;cursor:pointer;font:inherit}
    #cdx-label-menu button:hover,#cdx-label-menu button:focus-visible{background:#3a3d42;outline:1px solid #7dd3fc}
    #cdx-label-menu button:disabled{opacity:.5;cursor:wait}#cdx-label-menu .swatch{width:12px;height:12px;border-radius:3px;flex-shrink:0}
    #cdx-label-menu .notice{margin:6px 8px;color:#ffbd86;font-size:12px}#cdx-label-menu .caption{padding:4px 8px;color:#b6bdc7;font-size:11px}
    #cdx-label-error{position:fixed;bottom:18px;right:18px;z-index:2147483647;max-width:420px;padding:12px;border:1px solid #fb923c;border-radius:8px;background:#202123;color:#fff;font:13px/1.5 sans-serif}
    #cdx-label-settings{position:fixed;inset:0;margin:auto;padding:0;width:min(720px,calc(100vw - 32px));max-width:none;max-height:calc(100vh - 32px);border:1px solid #4b4e54;border-radius:14px;background:#202123;color:#f5f6f7;box-shadow:0 20px 80px #0008;font:13px/1.5 'Segoe UI','Malgun Gothic',sans-serif;color-scheme:dark;overflow:auto}
    #cdx-label-settings::backdrop{background:#0008}
    #cdx-label-settings *,#cdx-label-settings *::before,#cdx-label-settings *::after{box-sizing:border-box}
    #cdx-label-settings [hidden]{display:none!important}
    #cdx-label-settings form{margin:0;padding:0}#cdx-label-settings h2{margin:0;font-size:20px;font-weight:600;line-height:1.4}#cdx-label-settings p{margin:6px 0 0}
    #cdx-label-settings .cdx-settings-head{padding:22px 24px 16px;border-bottom:1px solid #3c3f44}
    #cdx-label-settings .cdx-settings-subtitle,#cdx-label-settings .cdx-settings-help{color:#aeb5bf;font-size:12px}
    #cdx-label-settings .cdx-settings-body{display:grid;grid-template-columns:142px minmax(0,1fr);gap:22px;padding:20px 24px}
    #cdx-label-settings .cdx-settings-nav{display:flex;flex-direction:column;gap:5px;align-self:start}
    #cdx-label-settings button{border:1px solid #555963;border-radius:7px;background:#303237;color:inherit;padding:8px 12px;font:inherit;cursor:pointer}
    #cdx-label-settings button:hover{background:#3c4046}#cdx-label-settings button:focus-visible,#cdx-label-settings input:focus-visible,#cdx-label-settings textarea:focus-visible{outline:2px solid #7dd3fc;outline-offset:2px}
    #cdx-label-settings button:disabled{opacity:.5;cursor:default}#cdx-label-settings .cdx-settings-nav button{display:flex;align-items:center;gap:8px;width:100%;border-color:transparent;background:transparent;text-align:left;overflow-wrap:anywhere}
    #cdx-label-settings .cdx-settings-nav button[aria-pressed="true"]{border-color:#606873;background:#34383e}
    #cdx-label-settings .cdx-settings-dot{width:10px;height:10px;flex:none;border-radius:3px}
    #cdx-label-settings .cdx-settings-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:13px}
    #cdx-label-settings .cdx-settings-field{display:flex;flex-direction:column;gap:5px;min-width:0;font-size:12px;color:#cbd1d8}
    #cdx-label-settings .cdx-settings-wide{grid-column:1/-1}
    #cdx-label-settings input:not([type="checkbox"]):not([type="color"]),#cdx-label-settings textarea{width:100%;min-height:35px;border:1px solid #565b64;border-radius:6px;background:#17191c;color:#f5f6f7;padding:7px 9px;font-family:inherit;font-size:13px;line-height:1.4}
    #cdx-label-settings textarea{resize:vertical;min-height:60px;max-height:150px}
    #cdx-label-settings input[type="color"]{width:38px;height:35px;flex:none;padding:3px;border:1px solid #565b64;border-radius:6px;background:#17191c;cursor:pointer}
    #cdx-label-settings .cdx-settings-color{display:flex;gap:7px}#cdx-label-settings .cdx-settings-color input[type="text"]{min-width:0;font-family:monospace}
    #cdx-label-settings .cdx-settings-check{display:flex;gap:8px;align-items:center;color:#e0e5eb}#cdx-label-settings input[type="checkbox"]{width:15px;height:15px;accent-color:#7dd3fc}
    #cdx-label-settings .cdx-settings-preview{margin-top:17px;padding:13px 15px;border:1px solid #40454d;border-radius:8px;background:#181a1d}
    #cdx-label-settings .cdx-settings-preview-row{display:flex;align-items:center;margin-top:8px;min-height:32px;color:#e4e7ec}
    #cdx-label-settings .cdx-settings-preview-badge{display:inline-flex;align-items:center;justify-content:center;line-height:1.4;font-weight:600;white-space:nowrap;flex-shrink:0;max-width:160px;overflow:hidden;text-overflow:ellipsis}
    #cdx-label-settings details{margin-top:17px;border-top:1px solid #3c3f44;padding-top:12px}#cdx-label-settings summary{cursor:pointer;color:#dbe1e9}#cdx-label-settings .cdx-settings-appearance{margin-top:12px}
    #cdx-label-settings .cdx-settings-status{margin:0 24px 16px;padding:11px 13px;border:1px solid #9c7145;border-radius:7px;background:#3c3025;color:#ffd4a5;font-size:12px;overflow-wrap:anywhere}
    #cdx-label-settings .cdx-settings-status button{margin-top:8px;font-size:12px}
    #cdx-label-settings .cdx-settings-footer{display:flex;gap:8px;justify-content:flex-end;align-items:center;padding:16px 24px;border-top:1px solid #3c3f44}
    #cdx-label-settings .cdx-settings-file{margin-right:auto;font-size:12px;color:#bfc7d2;background:transparent;border-color:transparent;padding-left:0}
    #cdx-label-settings .cdx-settings-save{background:#7dd3fc;color:#082f49;border-color:#7dd3fc;font-weight:600}#cdx-label-settings .cdx-settings-save:hover{background:#a2e0ff}
    @media(max-width:540px){#cdx-label-settings .cdx-settings-body{grid-template-columns:1fr;padding:16px;gap:14px}#cdx-label-settings .cdx-settings-nav{flex-direction:row;flex-wrap:wrap}#cdx-label-settings .cdx-settings-nav button{width:auto}#cdx-label-settings .cdx-settings-head,#cdx-label-settings .cdx-settings-footer{padding:16px}#cdx-label-settings .cdx-settings-status{margin:0 16px 16px}}
  `;
  document.head.append(style);
  function error(e){let box=document.getElementById('cdx-label-error');if(!box){box=document.createElement('div');box.id='cdx-label-error';box.role='alert';document.body.append(box);}box.textContent='라벨: '+(e?.message||String(e));}
  function identity(row){
    const d=row.dataset;
    if(row.matches(threadSel))return d.appActionSidebarThreadId ? `thread:${d.appActionSidebarThreadHostId||'local'}:${d.appActionSidebarThreadKind||'local'}:${d.appActionSidebarThreadId}` : null;
    return d.appActionSidebarProjectId ? `project:${d.appActionSidebarProjectId}` : null;
  }
  function titleNode(row){
    const title=row.getAttribute('data-app-action-sidebar-thread-title')||row.getAttribute('data-app-action-sidebar-project-label');
    if(!title)return null;
    const walker=document.createTreeWalker(row,NodeFilter.SHOW_TEXT);
    for(let node;node=walker.nextNode();){if(node.parentElement.closest('.cdx-label'))continue;if(node.textContent.trim()===title.trim())return node;}
    return null;
  }
  function paint(){
    if(!snapshot)return;
    for(const row of document.querySelectorAll(threadSel+','+projectSel)){
      const key=identity(row);if(!key)continue;
      let badge=[...row.querySelectorAll('.cdx-label')].find(b=>b.closest(threadSel+','+projectSel)===row);
      const node=titleNode(row);if(!node){badge?.remove();continue;}
      if(!badge){badge=document.createElement('span');badge.className='cdx-label';badge.role='button';badge.tabIndex=0;node.parentNode.insertBefore(badge,node);}
      badge.dataset.key=key;
      const id=snapshot.assignments[key],label=snapshot.config.labels.find(l=>l.id===id && l.enabled),a=snapshot.config.appearance;
      badge.textContent=label?label.name:'＋';
      badge.toggleAttribute('data-unset',!label);
      badge.setAttribute('aria-label',label?`상태 ${label.name} 변경`:'라벨 지정');badge.setAttribute('aria-haspopup','menu');
      badge.title=label?`${label.description} · 클릭하여 변경`:'라벨 지정';
      Object.assign(badge.style,{backgroundColor:label?.backgroundColor||'transparent',color:label?.textColor||'inherit',fontSize:a.fontSizePx+'px',borderRadius:a.borderRadiusPx+'px',padding:`${a.verticalPaddingPx}px ${a.horizontalPaddingPx}px`,marginInlineEnd:a.gapPx+'px'});
    }
    const counts={rows:document.querySelectorAll(threadSel+','+projectSel).length,badges:document.querySelectorAll('.cdx-label').length},report=JSON.stringify(counts);
    if(api.report && report!==lastReport){lastReport=report;api.report(counts).catch(()=>{lastReport='';});}
  }
  function schedule(){if(scheduled)return;scheduled=true;requestAnimationFrame(()=>{scheduled=false;observer.disconnect();try{paint();}finally{observe();}});}
  function closeMenu(focus=false){menu?.remove();menu=null;menuKey=null;if(focus&&opener?.isConnected)opener.focus();}
  function showMenu(badge){
    closeMenu();opener=badge;menuKey=badge.dataset.key;
    menu=document.createElement('div');menu.id='cdx-label-menu';menu.role='menu';menu.setAttribute('aria-label','작업 상태');
    const caption=document.createElement('div');caption.className='caption';caption.textContent='상태 선택';menu.append(caption);
    const add=(text,color,action)=>{const b=document.createElement('button');b.type='button';b.role='menuitem';if(color){const dot=document.createElement('span');dot.className='swatch';dot.style.backgroundColor=color;b.append(dot);}b.append(document.createTextNode(text));b.addEventListener('click',action);menu.append(b);};
    const choose=id=>async()=>{
      if(writing)return;writing=true;const key=menuKey;menu.querySelectorAll('button').forEach(b=>b.disabled=true);
      try{snapshot=await api.assign(key,id);signature=JSON.stringify(snapshot);closeMenu(true);schedule();document.getElementById('cdx-label-error')?.remove();}
      catch(e){error(e);menu?.querySelectorAll('button').forEach(b=>b.disabled=false);}finally{writing=false;}
    };
    for(const l of [...snapshot.config.labels].filter(l=>l.enabled).sort((a,b)=>a.order-b.order))add(l.name,l.backgroundColor,choose(l.id));
    add('라벨 해제',null,choose(null));add('라벨 설정…',null,()=>showSettings().catch(error));
    if(snapshot.configError){const p=document.createElement('p');p.className='notice';p.textContent='설정 오류로 마지막 정상 설정을 표시합니다: '+snapshot.configError;menu.append(p);}
    document.body.append(menu);const r=badge.getBoundingClientRect();menu.style.left=Math.max(8,Math.min(r.left,innerWidth-menu.offsetWidth-8))+'px';menu.style.top=Math.max(8,Math.min(r.bottom+6,innerHeight-menu.offsetHeight-8))+'px';menu.querySelector('button')?.focus();
  }
  function element(tag,className,text){const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;}
  function button(text,className,action){const node=element('button',className,text);node.type='button';if(action)node.addEventListener('click',action);return node;}
  function closeSettings(){
    if(!settings||settings.saving)return;
    const dialog=settings.dialog;settings=null;dialog.close();dialog.remove();
    if(opener?.isConnected)opener.focus();
  }
  function settingsChangedExternally(){
    if(!settings||settings.saving)return;
    const changed=snapshot.configRevision!==settings.revision;
    if(changed||snapshot.configError){
      settings.conflict=true;settings.save.disabled=true;
      settings.message(snapshot.configError?'설정 파일에 오류가 있습니다. 파일을 수정한 뒤 다시 불러와 주세요. '+snapshot.configError:'다른 곳에서 라벨 설정을 변경했습니다. 현재 편집 내용은 유지했습니다. 파일 설정을 다시 불러온 뒤 수정해 주세요.',true);
    }
  }
  async function showSettings(){
    if(settings){settings.dialog.focus();return;}
    if(openingSettings)return;openingSettings=true;closeMenu();
    let fresh;
    try{fresh=await api.read();}finally{openingSettings=false;}
    snapshot=fresh;signature=JSON.stringify(fresh);schedule();
    const dialog=element('dialog');dialog.id='cdx-label-settings';dialog.setAttribute('aria-labelledby','cdx-label-settings-title');dialog.setAttribute('aria-describedby','cdx-label-settings-description');
    const form=element('form'),head=element('div','cdx-settings-head');form.noValidate=true;
    const title=element('h2',null,'라벨 설정');title.id='cdx-label-settings-title';
    const description=element('p','cdx-settings-subtitle','이름과 색상을 바꾸면 같은 라벨을 사용하는 모든 작업에 적용됩니다.');description.id='cdx-label-settings-description';
    head.append(title,description);form.append(head);
    const body=element('div','cdx-settings-body'),nav=element('div','cdx-settings-nav');nav.setAttribute('aria-label','편집할 라벨');
    const editor=element('div'),fields=element('div','cdx-settings-fields');editor.append(fields);body.append(nav,editor);form.append(body);
    const state={dialog,draft:JSON.parse(JSON.stringify(fresh.config)),revision:fresh.configRevision,selected:fresh.config.labels[0]?.id,saving:false,conflict:false};settings=state;
    const inputs={},appearanceInputs={},navItems=new Map();
    const current=()=>state.draft.labels.find(label=>label.id===state.selected);
    function field(container,labelText,input,wide=false){
      const label=element('label','cdx-settings-field'+(wide?' cdx-settings-wide':''));label.append(element('span',null,labelText),input);container.append(label);return label;
    }
    function textField(key,labelText,options={}){
      const input=element(options.multiline?'textarea':'input');if(!options.multiline)input.type=options.type||'text';
      input.name=key;if(options.required)input.required=true;if(options.maxLength)input.maxLength=options.maxLength;
      if(options.type==='number'){input.step='1';input.min='-1000000';input.max='1000000';input.required=true;}
      field(fields,labelText,input,options.wide);inputs[key]=input;
      input.addEventListener('input',()=>{const label=current();label[key]=options.type==='number'?(input.value===''?NaN:Number(input.value)):input.value;if(key==='name')input.setCustomValidity(input.value.trim()?'':'라벨 이름을 입력해 주세요.');updatePreview();});
      return input;
    }
    textField('name','라벨 이름',{required:true,maxLength:30,wide:true});
    for(const [key,labelText] of [['backgroundColor','배경색'],['textColor','글자색']]){
      const group=element('div','cdx-settings-color'),picker=element('input'),hex=element('input');picker.type='color';picker.setAttribute('aria-label',labelText+' 선택');hex.type='text';hex.name=key;hex.required=true;hex.pattern='#[0-9a-fA-F]{6}';hex.maxLength=7;hex.spellcheck=false;hex.setAttribute('aria-label',labelText+' HEX');hex.title='#7DD3FC처럼 #과 6자리 색상 코드를 입력해 주세요.';group.append(picker,hex);
      const wrapper=element('div','cdx-settings-field');wrapper.append(element('span',null,labelText),group);fields.append(wrapper);inputs[key]=hex;inputs[key+'Picker']=picker;
      picker.addEventListener('input',()=>{hex.value=picker.value.toUpperCase();current()[key]=hex.value;updatePreview();});
      hex.addEventListener('input',()=>{current()[key]=hex.value;if(/^#[0-9a-f]{6}$/i.test(hex.value))picker.value=hex.value;updatePreview();});
    }
    textField('description','설명',{multiline:true,wide:true});
    textField('order','메뉴 표시 순서',{type:'number'});
    const enabled=element('input');enabled.type='checkbox';enabled.name='enabled';inputs.enabled=enabled;
    const enabledField=element('label','cdx-settings-check');enabledField.append(enabled,document.createTextNode('라벨 사용'));fields.append(enabledField);
    enabled.addEventListener('change',()=>{current().enabled=enabled.checked;updatePreview();});
    const preview=element('div','cdx-settings-preview'),previewCaption=element('div','cdx-settings-help','미리보기'),previewRow=element('div','cdx-settings-preview-row'),previewBadge=element('span','cdx-settings-preview-badge'),previewHelp=element('p','cdx-settings-help');previewRow.append(previewBadge,document.createTextNode('프로젝트명'));preview.append(previewCaption,previewRow,previewHelp);editor.append(preview);
    const appearance=element('details'),appearanceTitle=element('summary',null,'배지 모양 · 모든 라벨에 적용'),appearanceFields=element('div','cdx-settings-fields cdx-settings-appearance');appearance.append(appearanceTitle,appearanceFields);editor.append(appearance);
    const appearanceSpecs=[['fontSizePx','글자 크기 (px)',8,32],['borderRadiusPx','둥근 모서리 (px)',0,30],['horizontalPaddingPx','좌우 여백 (px)',0,30],['verticalPaddingPx','상하 여백 (px)',0,20],['gapPx','제목과의 간격 (px)',0,40]];
    for(const [key,labelText,min,max] of appearanceSpecs){
      const input=element('input');input.type='number';input.name=key;input.required=true;input.min=String(min);input.max=String(max);input.step='1';appearanceInputs[key]=input;field(appearanceFields,labelText,input);
      input.addEventListener('input',()=>{state.draft.appearance[key]=input.value===''?NaN:Number(input.value);updatePreview();});
    }
    const status=element('div','cdx-settings-status');status.hidden=true;status.role='alert';
    const statusText=element('div'),reload=button('파일 설정 다시 불러오기',null,async()=>{
      if(state.saving)return;
      reload.disabled=true;
      try{
        const next=await api.read();if(settings!==state)return;
        if(next.configError)throw new Error('설정 파일 오류가 남아 있습니다: '+next.configError);
        snapshot=next;signature=JSON.stringify(next);state.draft=JSON.parse(JSON.stringify(next.config));state.revision=next.configRevision;state.conflict=false;state.save.disabled=false;status.hidden=true;
        rebuildNav();selectLabel(state.draft.labels.some(label=>label.id===state.selected)?state.selected:state.draft.labels[0]?.id);fillAppearance();schedule();inputs.name.focus();
      }catch(e){state.message(e?.message||String(e),true);}finally{reload.disabled=false;}
    });reload.title='현재 편집 내용을 취소하고 파일에 저장된 설정을 가져옵니다.';status.append(statusText,reload);form.append(status);
    state.message=(text,canReload=false)=>{statusText.textContent=text;reload.hidden=!canReload;status.hidden=false;};
    const footer=element('div','cdx-settings-footer'),fileButton=button('설정 파일 열기','cdx-settings-file',()=>api.openConfig().catch(e=>state.message(e?.message||String(e)))),cancel=button('취소',null,closeSettings),save=button('저장','cdx-settings-save');save.type='submit';state.save=save;footer.append(fileButton,cancel,save);form.append(footer);dialog.append(form);
    function fillAppearance(){for(const [key] of appearanceSpecs)appearanceInputs[key].value=state.draft.appearance[key];updatePreview();}
    function rebuildNav(){
      nav.replaceChildren();navItems.clear();
      for(const label of [...state.draft.labels].sort((a,b)=>a.order-b.order)){
        const select=button('',null,()=>selectLabel(label.id)),dot=element('span','cdx-settings-dot'),text=element('span');select.append(dot,text);select.setAttribute('aria-pressed','false');nav.append(select);navItems.set(label.id,{select,dot,text});
      }
    }
    function selectLabel(id){
      state.selected=id;const label=current();if(!label)return;
      for(const key of ['name','description','order','backgroundColor','textColor'])inputs[key].value=label[key];
      inputs.name.setCustomValidity(label.name.trim()?'':'라벨 이름을 입력해 주세요.');inputs.enabled.checked=label.enabled;
      for(const key of ['backgroundColor','textColor'])inputs[key+'Picker'].value=/^#[0-9a-f]{6}$/i.test(label[key])?label[key]:'#000000';
      updatePreview();
    }
    function updatePreview(){
      for(const label of state.draft.labels){const item=navItems.get(label.id);if(!item)continue;item.text.textContent=(label.name||'이름 없음')+(label.enabled?'':' · 숨김');item.dot.style.backgroundColor=/^#[0-9a-f]{6}$/i.test(label.backgroundColor)?label.backgroundColor:'#6b7280';item.select.setAttribute('aria-pressed',String(label.id===state.selected));}
      const label=current();if(!label)return;const a=state.draft.appearance;
      previewBadge.textContent=label.name||'라벨';Object.assign(previewBadge.style,{backgroundColor:label.backgroundColor,color:label.textColor,fontSize:a.fontSizePx+'px',borderRadius:a.borderRadiusPx+'px',padding:`${a.verticalPaddingPx}px ${a.horizontalPaddingPx}px`,marginInlineEnd:a.gapPx+'px'});
      previewHelp.textContent=label.enabled?'저장 전에는 실제 사이드바에 반영되지 않습니다.':'사용을 끄면 선택 메뉴와 배지에서 숨겨집니다. 기존 지정 정보는 유지됩니다.';
    }
    form.addEventListener('submit',async event=>{
      event.preventDefault();if(state.saving||state.conflict)return;
      const invalid=state.draft.labels.find(label=>!label.name.trim()||label.name.length>30||!/^#[0-9a-f]{6}$/i.test(label.backgroundColor)||!/^#[0-9a-f]{6}$/i.test(label.textColor)||!Number.isFinite(label.order));
      if(invalid){selectLabel(invalid.id);form.reportValidity();return;}
      if(Object.values(appearanceInputs).some(input=>!input.validity.valid))appearance.open=true;
      if(!form.reportValidity())return;
      if(typeof api.saveConfig!=='function'){state.message('설정 저장 기능을 사용할 수 없습니다. 최신 라벨 앱으로 다시 실행해 주세요.');return;}
      state.saving=true;writing=true;dialog.setAttribute('aria-busy','true');save.textContent='저장 중…';
      const controls=[...form.querySelectorAll('button,input,textarea')];controls.forEach(control=>control.disabled=true);
      try{
        const next=await api.saveConfig({labels:state.draft.labels,appearance:state.draft.appearance},state.revision);
        snapshot=next;signature=JSON.stringify(next);state.saving=false;closeSettings();schedule();document.getElementById('cdx-label-error')?.remove();
      }catch(e){state.message(e?.message||String(e),true);}
      finally{state.saving=false;writing=false;if(settings===state){controls.forEach(control=>control.disabled=false);save.textContent='저장';dialog.removeAttribute('aria-busy');settingsChangedExternally();}}
    });
    // Native modal focus handling is supplemented for predictable Tab/Escape behavior.
    dialog.addEventListener('cancel',event=>{event.preventDefault();closeSettings();});
    dialog.addEventListener('keydown',event=>{
      event.stopPropagation();
      if(event.key==='Escape'){event.preventDefault();closeSettings();return;}
      if(event.key==='Tab'){
        const focusable=[...dialog.querySelectorAll('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),summary')].filter(node=>node.getClientRects().length);
        if(!focusable.length){event.preventDefault();return;}
        const first=focusable[0],last=focusable[focusable.length-1];if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
      }
    });
    rebuildNav();selectLabel(state.selected);fillAppearance();document.body.append(dialog);dialog.showModal();inputs.name.focus();settingsChangedExternally();
  }
  for(const type of ['pointerdown','mousedown','click','dblclick','contextmenu'])document.addEventListener(type,e=>{
    if(!(e.target instanceof Element))return;
    const badge=e.target.closest('.cdx-label');
    if(badge){e.preventDefault();e.stopImmediatePropagation();if(type==='click')showMenu(badge);return;}
    if(menu&&!menu.contains(e.target)&&type==='pointerdown')closeMenu();
  },true);
  document.addEventListener('keydown',e=>{
    const badge=e.target instanceof Element&&e.target.closest('.cdx-label');
    if(badge&&(e.key==='Enter'||e.key===' ')){e.preventDefault();e.stopImmediatePropagation();showMenu(badge);return;}
    if(!menu)return;
    if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();closeMenu(true);return;}
    if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();e.stopImmediatePropagation();const buttons=[...menu.querySelectorAll('button:not(:disabled)')],i=buttons.indexOf(document.activeElement);const next=e.key==='Home'?0:e.key==='End'?buttons.length-1:(i+(e.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length;buttons[next]?.focus();}
  },true);
  document.addEventListener('scroll',()=>closeMenu(),true);window.addEventListener('resize',()=>closeMenu());
  async function read(){if(reading||writing)return;reading=true;try{const next=await api.read(),s=JSON.stringify(next);if(s!==signature){snapshot=next;signature=s;schedule();settingsChangedExternally();if(menu&&opener?.isConnected)showMenu(opener);}}catch(e){error(e);}finally{reading=false;}}
  const observer=new MutationObserver(mutations=>{if(mutations.some(m=>!(m.target instanceof Element?m.target:m.target.parentElement)?.closest('#cdx-label-menu,#cdx-label-error,#cdx-label-settings,.cdx-label')))schedule();});
  function observe(){observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['data-app-action-sidebar-thread-title','data-app-action-sidebar-thread-id','data-app-action-sidebar-project-label','data-app-action-sidebar-project-id']});}
  observe();read();setInterval(()=>{if(!document.hidden)read();},1500);window.addEventListener('focus',read);
})();
