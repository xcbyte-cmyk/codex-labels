'use strict';
const {EventEmitter}=require('node:events');
const {StringDecoder}=require('node:string_decoder');
const {randomUUID}=require('node:crypto');
const {SwitchError,fail}=require('./common.cjs');
const hasId=m=>Object.hasOwn(m,'id');
class JsonLines {
  constructor(onMessage,onError,maxBytes=64*1024*1024) { this.decoder=new StringDecoder('utf8'); this.buffer=''; this.onMessage=onMessage; this.onError=onError; this.maxBytes=maxBytes; this.failed=false; }
  write(chunk) {
    if(this.failed) return;
    try {
      this.buffer+=typeof chunk==='string'?chunk:this.decoder.write(chunk);
      let i;
      while((i=this.buffer.indexOf('\n'))>=0) {
        const line=this.buffer.slice(0,i); this.buffer=this.buffer.slice(i+1);
        if(Buffer.byteLength(line)>this.maxBytes) fail('PROTOCOL_ERROR');
        if(!line.trim()) continue;
        const m=JSON.parse(line);
        if(!m || typeof m!=='object' || Array.isArray(m) || (hasId(m) && !['string','number'].includes(typeof m.id))) fail('PROTOCOL_ERROR');
        this.onMessage(m);
      }
      if(Buffer.byteLength(this.buffer)>this.maxBytes) fail('PROTOCOL_ERROR');
    } catch { this.failed=true; this.onError(new SwitchError('PROTOCOL_ERROR')); }
  }
  end() { this.buffer+=this.decoder.end(); if(this.buffer.trim()) {this.failed=true;this.onError(new SwitchError('PROTOCOL_ERROR'));} }
}
/** A real, bounded stdio JSON-RPC connection. Never logs payloads or tokens. */
class AppServerRpc extends EventEmitter {
  constructor(child,{timeoutMs=30000,maxBytes}={}) {
    super(); this.child=child; this.input=child.stdin; this.output=child.stdout; this.timeoutMs=timeoutMs;
    this.key=randomUUID(); this.sequence=0; this.pending=new Map(); this.serverRequests=new Map();
    this.threads=new Map(); this.work=new Map(); this.globalCommands=0; this.closed=false; this.tainted=false;
    if(!this.input || !this.output) fail('UNSUPPORTED');
    this.lines=new JsonLines(m=>this.receive(m),()=>this.breakConnection('PROTOCOL_ERROR'),maxBytes);
    this.output.on('data',chunk=>this.lines.write(chunk));
    this.output.on('end',()=>{this.lines.end();this.breakConnection('RPC_CLOSED');});
    this.input.on('error',()=>this.breakConnection('RPC_CLOSED'));
    child.on('error',()=>this.breakConnection('RPC_CLOSED'));
    child.on('exit',()=>this.breakConnection('RPC_CLOSED'));
  }
  state(id) {
    if(!this.work.has(id)) this.work.set(id,{turns:new Set(),items:new Set(),status:null});
    return this.work.get(id);
  }
  observe(method,params={}) {
    const id=params.threadId || params.thread?.id;
    if(params.thread?.id) this.threads.set(id,{...(this.threads.get(id)||{}),thread:params.thread});
    if(!id) return;
    const s=this.state(id);
    if(params.thread?.status) s.status=params.thread.status.type;
    if(method==='thread/status/changed') s.status=params.status?.type;
    if(method==='turn/started') s.turns.add(params.turn?.id || 'unknown');
    if(method==='turn/completed') { s.turns.delete(params.turn?.id); if(s.turns.has('unknown')) s.turns.delete('unknown'); }
    if(method==='item/started') s.items.add(params.item?.id || 'unknown');
    if(method==='item/completed') s.items.delete(params.item?.id);
  }
  receive(m) {
    if(this.closed) return;
    if(typeof m.method==='string') {
      this.observe(m.method,m.params);
      if(hasId(m)) { this.serverRequests.set(m.id,m); this.emit('request',m); }
      else this.emit('notification',m);
      return;
    }
    if(!hasId(m) || (!Object.hasOwn(m,'result') && !Object.hasOwn(m,'error'))) { this.breakConnection('PROTOCOL_ERROR'); return; }
    const p=this.pending.get(m.id);
    if(!p) {this.breakConnection('PROTOCOL_ERROR');return;}
    clearTimeout(p.timer); this.pending.delete(m.id);
    if(m.result?.thread?.id) {
      const id=m.result.thread.id;
      const old=this.threads.get(id)||{};
      this.threads.set(id,{...old,thread:m.result.thread,response:{...old.response,...m.result},
        params:['thread/start','thread/resume'].includes(p.method)?{...old.params,...p.params}:(old.params||{})});
      this.observe('thread/read',m.result);
    }
    if(p.method==='command/exec') {
      // Streaming commands can outlive their RPC response. Unknown completion
      // cannot be treated as idle. Non-streaming completion releases the barrier.
      if(m.error || Number.isInteger(m.result?.exitCode)) this.globalCommands=Math.max(0,this.globalCommands-1);
    }
    p.resolve(m.error?{error:m.error}:{result:m.result});
  }
  write(m) {
    if(this.closed || this.tainted) fail('RPC_CLOSED');
    this.input.write(JSON.stringify(m)+'\n');
  }
  exchange(method,params={}, {internal=false,timeoutMs=this.timeoutMs}={}) {
    if(this.closed || this.tainted) return Promise.reject(new SwitchError('RPC_CLOSED'));
    if(this.pending.size>=512)return Promise.reject(new SwitchError('BUSY'));
    const id=`labels:${this.key}:${++this.sequence}`;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{ this.tainted=true; this.breakConnection('RPC_TIMEOUT'); },timeoutMs);
      this.pending.set(id,{resolve,reject,timer,method,params,internal});
      if(method==='command/exec') this.globalCommands++;
      try {this.write({id,method,params});} catch {this.breakConnection('RPC_CLOSED');}
    });
  }
  async call(method,params={},options={}) {
    const m=await this.exchange(method,params,{...options,internal:true});
    if(m.error) {const e=new SwitchError('RPC_FAILED');e.rpcCode=m.error.code;throw e;}
    return m.result;
  }
  notify(method,params) { this.write(params===undefined?{method}:{method,params}); }
  respond(id,body) { if(!this.serverRequests.has(id)) fail('INVALID_ARGUMENT'); this.write({id,...body});this.serverRequests.delete(id); }
  async initialize() {
    await this.call('initialize',{clientInfo:{name:'codex_labels_session_switcher',version:'1.0.0'},capabilities:{experimentalApi:true}});
    this.notify('initialized');
  }
  counters(threadId) {
    if(this.closed||this.tainted) fail('RPC_CLOSED');
    const s=this.state(threadId);
    const pending=[...this.pending.values()].filter(p=>!p.internal && (!p.params?.threadId || p.params.threadId===threadId));
    const server=[...this.serverRequests.values()].filter(p=>!p.params?.threadId || p.params.threadId===threadId);
    return {runningTurns:s.turns.size+(s.status==='active'?1:0),pendingToolCalls:s.items.size+pending.length,
      pendingApprovals:server.length,runningCommands:this.globalCommands};
  }
  breakConnection(code) {
    if(this.closed) return; this.closed=true;
    for(const p of this.pending.values()) {clearTimeout(p.timer);p.reject(new SwitchError(code));}
    this.pending.clear();this.emit('closed',new SwitchError(code));
  }
  async close() {
    if(this.child.exitCode!==null && this.child.exitCode!==undefined) return;
    const child=this.child;
    await new Promise((resolve,reject)=>{
      let finished=false,killTimer,failTimer;
      const done=()=>{if(finished)return;finished=true;clearTimeout(killTimer);clearTimeout(failTimer);child.off('exit',done);resolve();};
      child.once('exit',done);
      try {this.input.end();} catch {}
      killTimer=setTimeout(()=>{try {child.kill();} catch {}},1500);
      failTimer=setTimeout(()=>{if(finished)return;finished=true;child.off('exit',done);reject(new SwitchError('CLEANUP_FAILED'));},4000);
      if(child.exitCode!=null || child.signalCode!=null) done();
    });
    this.breakConnection('RPC_CLOSED');
  }
}
module.exports={AppServerRpc,JsonLines,hasId};
