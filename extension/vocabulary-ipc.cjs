'use strict';
const {createVocabularyStore,createSummarizer}=require('./vocabulary.cjs');
function registerVocabulary({ipcMain,check,directory,executable,home,store=createVocabularyStore(directory),summarizer=createSummarizer({executable,home})}) {
  const drafts=new Map(), requests=new Map(), watched=new WeakSet();
  function owner(event) {
    check(event);
    const sender=event.sender;
    if(!watched.has(sender)) {
      watched.add(sender);
      const clear=()=>{summarizer.cancel(sender.id);drafts.delete(sender.id);requests.delete(sender.id);};
      sender.once('destroyed',clear);
      sender.on('did-start-navigation',(_e,_url,inPlace,mainFrame)=>{if(mainFrame&&!inPlace)clear();});
    }
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
  ipcMain.handle('codex-labels:vocabulary-save',(event,draftId,revision)=>{
    const draft=drafts.get(owner(event));
    if(!draft||draft.id!==draftId||Date.now()-draft.savedAt>30*60*1000)throw Error('요약을 다시 확인한 뒤 저장하세요.');
    return store.save({...draft,savedAt:Date.now()},revision);
  });
  ipcMain.handle('codex-labels:vocabulary-delete',(event,id,revision)=>{owner(event);return store.remove(id,revision);});
  return {dispose(){drafts.clear();requests.clear();summarizer.dispose();}};
}
module.exports={registerVocabulary};
