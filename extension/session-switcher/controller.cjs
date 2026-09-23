'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {EventEmitter}=require('node:events');
const {randomUUID}=require('node:crypto');
const {DesktopBackend,idle}=require('./backend.cjs');
const {fail,safeError,equalIdentity,atomicJson,inside,digest,checkAbort}=require('./common.cjs');
const {PROFILE_ID}=require('./profiles.cjs');
/** Durable routes make app restarts fail closed, never reopen the stale source
 * conversation under the wrong account. No credential is written to this file. */
class RouteJournal {
  constructor(root) {
    this.root=path.resolve(root);fs.mkdirSync(this.root,{recursive:true,mode:0o700});
    this.file=path.join(this.root,'routes.json');this.routes=new Map();this.locks=new Map();
    if(fs.existsSync(this.file)) {
      let data;try{data=JSON.parse(fs.readFileSync(this.file,'utf8'));}catch{fail('RECOVERY_REQUIRED');}
      if(data.version!==1 || !Array.isArray(data.routes)) fail('RECOVERY_REQUIRED');
      for(const r of data.routes) {
        if(typeof r.threadId!=='string'||!PROFILE_ID.test(r.profileId)||!inside(this.root,r.home)||!inside(r.home,r.rollout)) fail('RECOVERY_REQUIRED');
        if(this.routes.has(r.threadId) || !fs.existsSync(r.home) || fs.lstatSync(r.home).isSymbolicLink() ||
          !inside(fs.realpathSync(this.root),fs.realpathSync(r.home))) fail('RECOVERY_REQUIRED');
        this.routes.set(r.threadId,r);
      }
    }
  }
  claim(threadId) {
    if(this.locks.has(threadId))return;
    const file=path.join(this.root,`${digest(threadId)}.lock`);
    // Never steal a stale lock automatically: PID reuse and another live
    // window make that unsafe. Recovery instructions cover closed-app cleanup.
    let fd;try{fd=fs.openSync(file,'wx',0o600);}catch{fail('RECOVERY_REQUIRED');}
    fs.writeFileSync(fd,JSON.stringify({pid:process.pid,threadId}));fs.closeSync(fd);this.locks.set(threadId,file);
  }
  home(threadId) {return path.join(this.root,digest(threadId),randomUUID());}
  commit(descriptor) {
    const next=new Map(this.routes);next.set(descriptor.threadId,descriptor);
    atomicJson(this.file,{version:1,routes:[...next.values()]});this.routes=next;
  }
  release(threadId) {const f=this.locks.get(threadId);if(f){fs.rmSync(f,{force:true});this.locks.delete(threadId);}}
}
function normalizeUsage(raw) {
  const limits=raw?.rateLimitsByLimitId || (raw?.rateLimits?{codex:raw.rateLimits}:{});
  return Object.entries(limits).slice(0,20).map(([id,v])=>({id,
    primary:window(v?.primary),secondary:window(v?.secondary)}));
}
function window(v) {return v?{usedPercent:Number.isFinite(v.usedPercent)?Math.max(0,Math.min(100,v.usedPercent)):null,
  resetsAt:Number.isFinite(v.resetsAt)?v.resetsAt:null,windowDurationMins:Number.isFinite(v.windowDurationMins)?v.windowDurationMins:null}:null;}
class SessionController extends EventEmitter {
  constructor({profiles,journal,createBackend}) {super();Object.assign(this,{profiles,journal,createBackend});this.sessions=new Map();this.restorePending=new Map();}
  attachSource(threadId,rpc,home,record) {
    if(this.sessions.has(threadId))return this.sessions.get(threadId);
    const p=this.profiles.pin(this.profiles.currentProfileId);
    const backend=new DesktopBackend({rpc,profile:p,profiles:this.profiles,logicalSessionId:threadId,home,record});
    const s={threadId,profile:p,backend,phase:'idle',generation:0,usage:null,blockedReason:null,abort:null,cleanup:new Set()};
    this.sessions.set(threadId,s);return s;
  }
  get(threadId) {const s=this.sessions.get(threadId);if(!s)fail('NOT_FOUND');return s;}
  snapshot(threadId) {
    const s=this.get(threadId);
    return {version:1,logicalSessionId:s.threadId,activeProfile:{id:s.profile.id,name:s.profile.name},phase:s.phase,
      generation:s.generation,blockedReason:s.blockedReason,usage:s.usage};
  }
  emitState(s) {this.emit('changed',this.snapshot(s.threadId));}
  async restoreSaved(threadId) {
    if(this.restorePending.has(threadId))return this.restorePending.get(threadId);
    const saved=this.journal.routes.get(threadId);if(!saved)return null;
    if(this.sessions.has(threadId))return this.sessions.get(threadId);
    const task=(async()=>{
      this.journal.claim(threadId);
      const profile=this.profiles.pin(saved.profileId);
      if(!equalIdentity(profile.identity,saved.identity))fail('IDENTITY_MISMATCH');
      const s={threadId,profile,backend:null,phase:'restoring',generation:1,usage:null,blockedReason:null,abort:null,cleanup:new Set()};
      this.sessions.set(threadId,s);
      let backend;
      try {
        backend=await this.createBackend({profile,logicalSessionId:threadId,home:saved.home,cwd:saved.settings.cwd});
        await backend.resumeSaved(saved);
        if(!idle(await backend.getActivity()))fail('BUSY');
        s.backend=backend;s.phase='idle';this.emit('backend',backend);this.emitState(s);return s;
      } catch(e) {
        if(backend)try{await backend.close();}catch{s.cleanup.add(backend);}
        s.phase='blocked';s.blockedReason='RECOVERY_REQUIRED';this.emitState(s);throw e;
      }
    })();
    this.restorePending.set(threadId,task);
    try{return await task;}finally{this.restorePending.delete(threadId);}
  }
  /** All native requests and switch operations share this synchronous gate. */
  gate(threadId,method) {
    if(this.disposing)fail('BUSY');
    const s=this.sessions.get(threadId);if(!s)return null;
    if(!s.backend || s.backend.rpc.closed || s.phase==='blocked')fail('RECOVERY_REQUIRED');
    if(s.phase!=='idle' && !(s.phase==='running' && ['turn/interrupt','turn/steer'].includes(method)))fail('BUSY');
    return s.backend;
  }
  async switchAccount(threadId,profileId,{confirmContextTransfer=false}={}) {
    const s=this.get(threadId);if(this.disposing || s.phase!=='idle')fail('BUSY');
    if(profileId===s.profile.id)return {changed:false,state:this.snapshot(threadId)};
    if(confirmContextTransfer!==true)fail('CONSENT_REQUIRED');
    if(!PROFILE_ID.test(profileId))fail('INVALID_ARGUMENT');
    this.journal.claim(threadId);
    let finish; s.switchDone=new Promise(resolve=>{finish=resolve;});
    const controller=new AbortController();s.abort=controller;s.phase='switching';s.usage=null;this.emitState(s);
    const source=s.backend,sourceProfile=s.profile;let target=null,committed=false;
    try {
      const profile=this.profiles.pin(profileId);checkAbort(controller.signal);
      if(!equalIdentity(await source.getIdentity(),sourceProfile.identity))fail('IDENTITY_MISMATCH');
      if(!idle(await source.getActivity()))fail('BUSY');
      const checkpoint=await source.checkpoint({signal:controller.signal});
      target=await this.createBackend({profile,logicalSessionId:threadId,home:this.journal.home(threadId),cwd:checkpoint.payload.settings.cwd});
      checkAbort(controller.signal);this.emit('backend',target);
      if(!equalIdentity(await target.getIdentity(),profile.identity))fail('IDENTITY_MISMATCH');
      if(!idle(await target.getActivity()))fail('BUSY');
      await target.restore(structuredClone(checkpoint),{signal:controller.signal});
      checkAbort(controller.signal);
      if(!equalIdentity(await source.getIdentity(),sourceProfile.identity) || !equalIdentity(await target.getIdentity(),profile.identity))fail('IDENTITY_MISMATCH');
      if(!idle(await source.getActivity()) || !idle(await target.getActivity()))fail('BUSY');
      // Revalidate the full source file immediately before publication.
      const final=await source.checkpoint({signal:controller.signal});
      if(final.payload.sha256!==checkpoint.payload.sha256)fail('CHECKPOINT_INVALID');
      checkAbort(controller.signal);
      // Write-ahead publication and the in-memory pointer change are synchronous.
      // A crash here recovers the prepared target, not the stale source log.
      this.journal.commit(target.descriptor());
      s.backend=target;s.profile=profile;s.generation++;committed=true;s.abort=null;
      try{await source.close();s.phase='idle';s.blockedReason=null;}
      catch{s.cleanup.add(source);s.phase='blocked';s.blockedReason='CLEANUP_FAILED';}
      this.emitState(s);
      return {changed:true,committed:true,cleanupComplete:s.phase==='idle',state:this.snapshot(threadId)};
    } catch(error) {
      if(!committed) {
        let clean=true;
        if(target)try{await target.close();}catch{s.cleanup.add(target);clean=false;}
        s.phase=clean?'idle':'blocked';s.blockedReason=clean?null:'CLEANUP_FAILED';
        if(error.code==='IDENTITY_MISMATCH' || source.rpc.closed){s.phase='blocked';s.blockedReason=error.code==='IDENTITY_MISMATCH'?'IDENTITY_MISMATCH':'RECOVERY_REQUIRED';}
      }
      this.emitState(s);throw error;
    } finally{if(s.abort===controller)s.abort=null;finish();s.switchDone=null;}
  }
  cancel(threadId) {const s=this.get(threadId);if(!s.abort)return false;s.abort.abort();s.phase='cancelling';this.emitState(s);return true;}
  async usage(threadId) {
    const s=this.get(threadId);this.gate(threadId,'account/rateLimits/read');s.phase='checking';this.emitState(s);
    try {
      await s.backend.getIdentity();s.usage=normalizeUsage(await s.backend.readUsage());await s.backend.getIdentity();return s.usage;
    } finally {if(s.phase==='checking')s.phase='idle';this.emitState(s);}
  }
  async recover(threadId) {
    const s=this.get(threadId);if(s.phase!=='blocked')fail('INVALID_ARGUMENT');s.phase='recovering';this.emitState(s);
    try {
      for(const b of [...s.cleanup]){await b.close();s.cleanup.delete(b);}
      if(!s.backend)fail('RECOVERY_REQUIRED');
      await s.backend.getIdentity();if(!idle(await s.backend.getActivity()))fail('BUSY');
      s.phase='idle';s.blockedReason=null;return this.snapshot(threadId);
    } catch(e){s.phase='blocked';throw e;}finally{this.emitState(s);}
  }
  async dispose() {
    if(this.disposePromise)return this.disposePromise;
    this.disposing=true;
    for(const s of this.sessions.values())s.abort?.abort();
    this.disposePromise=(async()=>{
      await Promise.allSettled([...this.restorePending.values()]);
      const results=await Promise.allSettled([...this.sessions.values()].map(async s=>{
        // Await late factories/rollback before releasing the exclusive lock.
        if(s.switchDone)await s.switchDone;
        // The application is quitting; only owned children may be terminated.
        for(const b of new Set([s.backend,...s.cleanup]))if(b?.owned)await b.close();
        s.phase='disposed';this.journal.release(s.threadId);
      }));
      if(results.some(r=>r.status==='rejected'))fail('CLEANUP_FAILED');
    })();
    return this.disposePromise;
  }
}
module.exports={SessionController,RouteJournal,normalizeUsage};
