'use strict';
const fs=require('node:fs');
const {createVocabularyStore,createSummarizer}=require('./vocabulary.cjs');
function registerVocabulary({ipcMain,check,directory,executable,home,store=createVocabularyStore(directory),summarizer=createSummarizer({executable,home}),watchDirectory=fs.watch}) {
  const drafts=new Map(), requests=new Map(), watched=new WeakSet();
  // Each registration is scoped to its supplied vocabulary directory. Readers
  // in another account/store are never broadcast to by this instance.
  const readers=new Map(),cleanup=new Map();
  let watcher=null,changeTimer=null,disposed=false;
  function publish() {
    if(disposed)return;
    for(const [id,record] of readers) {
      try {
        if(record.sender.isDestroyed()){readers.delete(id);continue;}
        record.verify();
        record.sender.send('codex-labels:vocabulary-changed');
      } catch { readers.delete(id); }
    }
  }
  function observeDirectory() {
    if(watcher||disposed||!directory)return;
    try {
      watcher=watchDirectory(directory,{persistent:false},(_event,name)=>{
        if(name!=null&&String(name)!=='vocabulary.json')return;
        clearTimeout(changeTimer);
        changeTimer=setTimeout(publish,40);changeTimer.unref?.();
      });
      watcher.on('error',()=>{watcher?.close();watcher=null;});
    } catch { /* Missing directory: a later authorized read/write retries. */ }
  }
  function owner(event) {
    check(event);
    const sender=event.sender;
    if(!watched.has(sender)) {
      watched.add(sender);
      const clear=()=>{summarizer.cancel(sender.id);drafts.delete(sender.id);requests.delete(sender.id);readers.delete(sender.id);};
      const navigation=(_e,_url,inPlace,mainFrame)=>{if(mainFrame&&!inPlace)clear();};
      const destroyed=()=>{clear();cleanup.delete(sender.id);};
      sender.once('destroyed',destroyed);sender.on('did-start-navigation',navigation);
      cleanup.set(sender.id,()=>{sender.removeListener('destroyed',destroyed);sender.removeListener('did-start-navigation',navigation);});
    }
    readers.set(sender.id,{sender,verify:()=>check(event)});observeDirectory();
    return sender.id;
  }
  ipcMain.handle('codex-labels:vocabulary-read',event=>{owner(event);return store.read();});
  ipcMain.handle('codex-labels:vocabulary-summarize',async(event,input)=>{
    const id=owner(event);
    if(requests.has(id))throw Error('이미 뜻을 요약하고 있습니다. 잠시 기다려 주세요.');
    const request={};requests.set(id,request);drafts.delete(id);
    try {
      const draft=await summarizer.summarize(id,input);
      if(event.sender.isDestroyed()||requests.get(id)!==request)throw Error('단어장 요약이 취소되었습니다.');
      check(event);drafts.set(id,draft);return draft;
    } finally {if(requests.get(id)===request)requests.delete(id);}
  });
  ipcMain.handle('codex-labels:vocabulary-cancel',event=>{const id=owner(event);summarizer.cancel(id);drafts.delete(id);requests.delete(id);return true;});
  ipcMain.handle('codex-labels:vocabulary-save',(event,draftId,revision,options)=>{
    const draft=drafts.get(owner(event));
    if(!draft||draft.id!==draftId||Date.now()-draft.savedAt>30*60*1000)throw Error('요약을 다시 확인한 뒤 저장하세요.');
    const snapshot=store.save({...draft,savedAt:Date.now()},revision,options);
    drafts.delete(event.sender.id);
    observeDirectory();publish();return snapshot;
  });
  ipcMain.handle('codex-labels:vocabulary-edit',(event,id,patch,revision)=>{owner(event);const snapshot=store.edit(id,patch,revision);publish();return snapshot;});
  ipcMain.handle('codex-labels:vocabulary-delete',(event,id,revision)=>{owner(event);const snapshot=store.remove(id,revision);publish();return snapshot;});
  return {dispose(){disposed=true;clearTimeout(changeTimer);watcher?.close();watcher=null;readers.clear();for(const off of cleanup.values())off();cleanup.clear();drafts.clear();requests.clear();summarizer.dispose();}};
}
module.exports={registerVocabulary};
