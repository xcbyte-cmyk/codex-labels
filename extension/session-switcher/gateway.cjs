'use strict';
const {Writable,PassThrough}=require('node:stream');
const {AppServerRpc,JsonLines,hasId}=require('./rpc.cjs');
const {fail,safeError,SwitchError}=require('./common.cjs');
const {idle}=require('./backend.cjs');
const ROUTED=new Set(['thread/read','thread/resume','thread/turns/list','thread/items/list','thread/name/set',
  'thread/goal/set','thread/goal/get','thread/goal/clear','thread/metadata/update','thread/unsubscribe',
  'thread/backgroundTerminals/list','thread/backgroundTerminals/clean','thread/backgroundTerminals/terminate',
  'turn/start','turn/interrupt','turn/steer']);
/** Desktop's original ChildProcess keeps its PID, stderr, exit/kill semantics.
 * Only its two public stdio streams are replaced, before bootstrap receives it. */
class DesktopGateway {
  constructor({child,controller,home,rpcOptions}) {
    Object.assign(this,{controller,home});this.primary=new AppServerRpc(child,rpcOptions);
    this.endpoints=new Set();this.serverRequests=new Map();this.requestSequence=0;this.turns=new Map();
    this.output=new PassThrough({highWaterMark:1024*1024});
    this.output.on('drain',()=>{for(const e of this.endpoints)e.output.resume();});
    this.frames=new JsonLines(m=>{this.accept(m).catch(()=>{});},()=>this.primary.breakConnection('PROTOCOL_ERROR'));
    this.input=new Writable({write:(chunk,_encoding,done)=>{this.frames.write(chunk);done();},final:done=>{
      this.frames.end();this.primary.input.end();done();
    }});
    this.bind(this.primary);
    this.onBackend=b=>this.bind(b.rpc);controller.on('backend',this.onBackend);
    this.onChanged=()=>{};
    this.primary.on('closed',()=>{
      this.output.end();controller.off('backend',this.onBackend);
      controller.dispose().catch(()=>{});
    });
    child.stdin=this.input;child.stdout=this.output;
    if(Array.isArray(child.stdio)){child.stdio[0]=this.input;child.stdio[1]=this.output;}
  }
  publish(m) {
    if(this.output.destroyed || this.output.writableEnded)return;
    if(!this.output.write(JSON.stringify(m)+'\n'))for(const e of this.endpoints)e.output.pause();
  }
  belongs(rpc,threadId) {
    const s=threadId?this.controller.sessions.get(threadId):null;
    return s?s.backend?.rpc===rpc:rpc===this.primary;
  }
  bind(rpc) {
    if(this.endpoints.has(rpc))return;this.endpoints.add(rpc);
    rpc.on('request',m=>{
      // Owned token refreshes have already been consumed by DesktopBackend.
      if(!rpc.serverRequests.has(m.id))return;
      if(m.method==='account/chatgptAuthTokens/refresh' && rpc!==this.primary)return;
      const threadId=m.params?.threadId;
      const s=this.controller.sessions.get(threadId);
      if(!this.belongs(rpc,threadId) || (s && !['idle','running'].includes(s.phase))) {
        rpc.respond(m.id,{error:{code:-32000,message:'Session is not accepting tool requests.'}});return;
      }
      const id=`labels-server:${rpc.key}:${++this.requestSequence}`;
      this.serverRequests.set(id,{rpc,id:m.id,threadId});
      this.publish({...m,id});
    });
    rpc.on('notification',m=>{
      const threadId=m.params?.threadId || m.params?.thread?.id;
      if(!this.belongs(rpc,threadId))return;
      // Account/global notifications from a target must not relabel every
      // other Desktop conversation. Usage is exposed by the dedicated UI.
      if(rpc!==this.primary && !threadId)return;
      const s=this.controller.sessions.get(threadId);
      if(s && ['switching','cancelling','restoring','blocked'].includes(s.phase))return;
      if(m.method==='turn/completed' && s) {
        const turn=this.turns.get(threadId);
        if(turn) {turn.completed.add(m.params?.turn?.id);if(turn.id && turn.completed.has(turn.id))this.settle(s,turn).catch(()=>{});}
      }
      this.publish(m);
    });
    rpc.on('closed',()=>{
      this.endpoints.delete(rpc);
      for(const [id,r] of this.serverRequests)if(r.rpc===rpc)this.serverRequests.delete(id);
      for(const s of this.controller.sessions.values())if(s.backend?.rpc===rpc && s.phase!=='disposed') {
        s.phase='blocked';s.blockedReason='RECOVERY_REQUIRED';this.controller.emitState(s);
      }
    });
  }
  async settle(s,turn) {
    if(turn.settling)return;turn.settling=true;
    // Keep the route closed until response IDs, tools and background commands
    // have all settled. A mere turn/completed event is insufficient.
    s.phase='settling';this.controller.emitState(s);
    try {
      await s.backend.getIdentity();if(!idle(await s.backend.getActivity()))fail('BUSY');
      s.phase='idle';s.blockedReason=null;
    } catch {s.phase='blocked';s.blockedReason='RECOVERY_REQUIRED';}
    finally{this.turns.delete(s.threadId);this.controller.emitState(s);}
  }
  async ensure(threadId) {
    if(this.controller.journal.routes.has(threadId))await this.controller.restoreSaved(threadId);
    if(this.controller.sessions.has(threadId))return this.controller.get(threadId);
    const record=this.primary.threads.get(threadId);if(!record)fail('NOT_FOUND');
    return this.controller.attachSource(threadId,this.primary,this.home,record);
  }
  listThreads() {
    const ids=new Set([...this.primary.threads.keys(),...this.controller.journal.routes.keys()]);
    return [...ids].slice(0,500).map(id=>({id,title:this.primary.threads.get(id)?.thread?.name || this.primary.threads.get(id)?.thread?.preview?.slice(0,100) || id,
      state:this.controller.sessions.has(id)?this.controller.snapshot(id):null}));
  }
  async accept(m) {
    if(!m.method) {
      const r=this.serverRequests.get(m.id);
      if(!r)return;
      this.serverRequests.delete(m.id);
      try{r.rpc.respond(r.id,Object.hasOwn(m,'error')?{error:m.error}:{result:m.result});}catch{}
      return;
    }
    if(!hasId(m)) {
      // Only handshake notifications are currently part of this contract.
      if(m.method==='initialized')this.primary.notify(m.method,m.params);
      return;
    }
    const threadId=m.params?.threadId;
    let s,replySent=false;
    const reply=body=>{if(!replySent){replySent=true;this.publish({id:m.id,...body});}};
    try {
      if(typeof threadId==='string' && this.controller.journal.routes.has(threadId))await this.controller.restoreSaved(threadId);
      s=threadId?this.controller.sessions.get(threadId):null;
      const backend=threadId?this.controller.gate(threadId,m.method):null;
      if(backend?.owned && !ROUTED.has(m.method))fail('UNSUPPORTED');
      // In-flight global commands can affect a source checkpoint. Serialize
      // them against a switch instead of allowing a race through the gate.
      if(!threadId && (m.method==='command/exec' || /^account\/(login|logout)/.test(m.method)) &&
        [...this.controller.sessions.values()].some(x=>['switching','cancelling'].includes(x.phase)))fail('BUSY');
      let params=m.params || {};
      if(m.method==='initialize')params={...params,capabilities:{...params.capabilities,experimentalApi:true}};
      if(backend?.owned && m.method==='thread/resume') {
        if(params.history!=null)fail('UNSUPPORTED');
        params={...params,path:backend.record.thread.path};
      }
      if(s && m.method==='turn/start') {
        s.phase='running';this.controller.emitState(s);
        const turn={id:null,completed:new Set(),settling:false};this.turns.set(threadId,turn);
        await backend.getIdentity();if(!idle(await backend.getActivity()))fail('BUSY');
        const result=await backend.request(m.method,params);reply(result);
        if(result.error) {this.turns.delete(threadId);s.phase='idle';this.controller.emitState(s);return;}
        turn.id=result.result?.turn?.id;if(!turn.id)fail('PROTOCOL_ERROR');
        if(turn.completed.has(turn.id))await this.settle(s,turn);
        return;
      }
      const result=await (backend?.request(m.method,params) || this.primary.exchange(m.method,params));
      // Keep native thread listings pointed at the active rollout after a switch.
      if(['thread/list','thread/loaded/list'].includes(m.method) && Array.isArray(result.result?.data)) {
        result.result.data=result.result.data.map(item=>{
          if(typeof item!=='object')return item;
          const active=this.controller.sessions.get(item.id)?.backend;
          return active?.owned?{...item,...active.record.thread}:item;
        });
      }
      reply(result);
    } catch(e) {
      if(s && m.method==='turn/start' && s.phase==='running') {
        this.turns.delete(s.threadId);
        s.phase='blocked';s.blockedReason='RECOVERY_REQUIRED';this.controller.emitState(s);
      }
      const error=safeError(e);reply({error:{code:-32000,message:`${error.code}: ${error.message}`}});
    }
  }
}
module.exports={DesktopGateway,ROUTED};
