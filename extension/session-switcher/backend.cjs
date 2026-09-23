'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {AppServerRpc}=require('./rpc.cjs');
const {tokenIdentity}=require('./profiles.cjs');
const {fail,equalIdentity,regularFile,digest,checkAbort}=require('./common.cjs');
const MAX_LOG=64*1024*1024;
const SANDBOX={readOnly:'read-only',workspaceWrite:'workspace-write',dangerFullAccess:'danger-full-access'};
function settingsFrom(record) {
  const r=record.response;
  if(!r || !r.cwd || !r.model || r.approvalPolicy==null || !r.sandbox?.type || !SANDBOX[r.sandbox.type] || record.params?.permissions) fail('POLICY_UNSUPPORTED');
  // Do not silently drop writable-root or network restrictions. The complete
  // resulting policy must compare equal after resume, before commit.
  return {params:{cwd:r.cwd,model:r.model,approvalPolicy:r.approvalPolicy,sandbox:SANDBOX[r.sandbox.type]},
    expected:{approvalPolicy:r.approvalPolicy,sandbox:r.sandbox},cwd:r.cwd};
}
function validateRollout(text,id) {
  if(typeof text!=='string' || !text.endsWith('\n') || Buffer.byteLength(text)>MAX_LOG) fail('CHECKPOINT_INVALID');
  let lines;
  try{lines=text.trimEnd().split('\n').map(line=>JSON.parse(line));}catch{fail('CHECKPOINT_INVALID');}
  if(lines.length<2 || lines[0].type!=='session_meta' || lines[0].payload?.id!==id) fail('CHECKPOINT_INVALID');
  // Refuse partial tools: never manufacture tool results or replay a call.
  const outstanding=new Set();
  for(const l of lines) {
    if(l.type!=='response_item') continue;
    const p=l.payload||{};
    if(['function_call','custom_tool_call'].includes(p.type)) outstanding.add(p.call_id);
    if(['function_call_output','custom_tool_call_output'].includes(p.type)) outstanding.delete(p.call_id);
  }
  if(outstanding.size) fail('CHECKPOINT_INVALID');
  return lines;
}
function stableRead(file,home,id) {
  const checked=regularFile(file,home,MAX_LOG);
  const a=fs.readFileSync(checked.file);
  const end=fs.statSync(checked.file);
  const b=fs.readFileSync(checked.file);
  if(checked.stat.size!==end.size || checked.stat.mtimeMs!==end.mtimeMs || !a.equals(b)) fail('CHECKPOINT_INVALID');
  const text=a.toString('utf8');if(!Buffer.from(text).equals(a)) fail('CHECKPOINT_INVALID');
  validateRollout(text,id);return text;
}
function idle(c) {return Object.values(c).every(n=>Number.isSafeInteger(n)&&n===0);}
/** Concrete implementation of PR #23's backend contract. */
class DesktopBackend {
  constructor({rpc,profile,profiles,logicalSessionId,home,owned=false,record=null}) {
    Object.assign(this,{rpc,profile,profiles,logicalSessionId,home,owned,record});
    this.restored=!!record;this.detached=false;this.pinnedToken=null;
    this.capabilities=Object.freeze({protocolVersion:1,isolatedCredentials:true,identityPinned:true,passiveRestore:true,fullActivity:true});
  }
  static async create({spawn,executable,home,profile,profiles,logicalSessionId,cwd,env={},rpcOptions}) {
    fs.mkdirSync(home,{recursive:true,mode:0o700});
    // No refresh token, auth.json, Electron login directory, or global API key
    // is copied into a session home. Only a pinned access token is sent via stdin.
    const childEnv=Object.fromEntries(Object.entries(env).filter(([k])=>! /^(CODEX_|OPENAI_|CHATGPT_|AZURE_OPENAI_|ANTHROPIC_|NODE_OPTIONS$|ELECTRON_RUN_AS_NODE$)/i.test(k)));
    Object.assign(childEnv,{CODEX_HOME:home,CODEX_SQLITE_HOME:home});
    const child=spawn(executable,['-c','cli_auth_credentials_store="file"','app-server','--stdio'],{
      cwd,env:childEnv,stdio:['pipe','pipe','pipe'],windowsHide:true,shell:false});
    child.stderr?.resume(); // Do not leak raw target errors or credentials.
    const rpc=new AppServerRpc(child,rpcOptions);
    const b=new DesktopBackend({rpc,profile,profiles,logicalSessionId,home,owned:true});
    // Refreshes are handled in the trusted main process, not the renderer.
    rpc.on('request',m=>{
      if(m.method!=='account/chatgptAuthTokens/refresh') return;
      try {
        if(m.params?.previousAccountId && m.params.previousAccountId!==profile.identity.accountId) fail('IDENTITY_MISMATCH');
        const t=profiles.token(profile.id,profile.identity);
        if(t.accessToken===b.pinnedToken) fail('AUTH_REQUIRED');
        b.pinnedToken=t.accessToken;
        rpc.respond(m.id,{result:{accessToken:t.accessToken,chatgptAccountId:t.identity.accountId,...(t.planType?{chatgptPlanType:t.planType}:{})}});
      } catch {rpc.respond(m.id,{error:{code:-32001,message:'Pinned account requires login.'}});}
    });
    try {
      await rpc.initialize();
      const t=profiles.token(profile.id,profile.identity);b.pinnedToken=t.accessToken;
      const login=await rpc.call('account/login/start',{type:'chatgptAuthTokens',accessToken:t.accessToken,
        chatgptAccountId:t.identity.accountId,...(t.planType?{chatgptPlanType:t.planType}:{})});
      if(login?.type!=='chatgptAuthTokens') fail('UNSUPPORTED');
      await b.getIdentity();
      await b.readUsage(); // Online authentication acceptance check, no model turn.
      return b;
    } catch(e) {try{await rpc.close();}catch{fail('CLEANUP_FAILED');}throw e;}
  }
  async getIdentity() {
    if(this.detached || this.rpc.closed) fail('RPC_CLOSED');
    const account=await this.rpc.call('account/read',{refreshToken:false});
    if(account?.account?.type!=='chatgpt') fail('AUTH_REQUIRED');
    let observed;
    if(this.owned) {
      // Accept a refreshed access token only for the same pinned identity.
      // Refresh credentials are owned by the registered profile, not this home.
      const fresh=this.profiles.token(this.profile.id,this.profile.identity);
      if(fresh.accessToken!==this.pinnedToken) {
        if(!idle(this.rpc.counters(this.logicalSessionId))) fail('BUSY');
        const login=await this.rpc.call('account/login/start',{type:'chatgptAuthTokens',accessToken:fresh.accessToken,
          chatgptAccountId:fresh.identity.accountId,...(fresh.planType?{chatgptPlanType:fresh.planType}:{})});
        if(login?.type!=='chatgptAuthTokens') fail('UNSUPPORTED');
        this.pinnedToken=fresh.accessToken;
      }
      observed=tokenIdentity(this.pinnedToken).identity;
    } else {
      // A local auth file alone cannot prove what the live Desktop server uses.
      // This legacy introspection must return the live token. Unsupported app
      // versions fail closed rather than assuming an email is an account ID.
      const live=await this.rpc.call('getAuthStatus',{includeToken:true,refreshToken:false});
      observed=tokenIdentity(live?.authToken).identity;
    }
    if(!equalIdentity(observed,this.profile.identity)) fail('IDENTITY_MISMATCH');
    return observed;
  }
  async getActivity() {
    const c=this.rpc.counters(this.logicalSessionId);
    if(!this.restored) return c;
    const r=await this.rpc.call('thread/read',{threadId:this.logicalSessionId,includeTurns:true});
    if(!r?.thread || r.thread.id!==this.logicalSessionId || !['idle','notLoaded'].includes(r.thread.status?.type)) {
      c.runningTurns++;return c;
    }
    if((r.thread.turns||[]).some(t=>t.status==='inProgress')) c.runningTurns++;
    // Background terminals can survive turn/completed. Never assume zero when
    // the runtime cannot list them. Unsupported protocol blocks switching.
    const terminals=await this.rpc.call('thread/backgroundTerminals/list',{threadId:this.logicalSessionId});
    if(!Array.isArray(terminals?.terminals)) fail('UNSUPPORTED');
    c.runningCommands+=terminals.terminals.length;
    if(this.record) this.record={...this.record,thread:r.thread};
    return c;
  }
  async checkpoint({signal}={}) {
    checkAbort(signal);if(!idle(await this.getActivity())) fail('BUSY');
    const record=this.record || this.rpc.threads.get(this.logicalSessionId);
    if(!record?.thread?.path || record.thread.ephemeral) fail('CHECKPOINT_INVALID');
    const settings=settingsFrom(record);
    const log=stableRead(record.thread.path,this.home,this.logicalSessionId);
    checkAbort(signal);if(!idle(await this.getActivity())) fail('BUSY');
    // Re-read after the second status barrier to detect delayed persistence.
    if(digest(stableRead(record.thread.path,this.home,this.logicalSessionId))!==digest(log)) fail('CHECKPOINT_INVALID');
    return {version:1,logicalSessionId:this.logicalSessionId,payload:{log,sha256:digest(log),settings}};
  }
  async restore(checkpoint,{signal}={}) {
    checkAbort(signal);
    if(!this.owned || this.restored || checkpoint?.version!==1 || checkpoint.logicalSessionId!==this.logicalSessionId) fail('CHECKPOINT_INVALID');
    const {log,sha256,settings}=checkpoint.payload||{};
    if(digest(log||'')!==sha256) fail('CHECKPOINT_INVALID');
    validateRollout(log,this.logicalSessionId);
    const directory=path.join(this.home,'sessions');fs.mkdirSync(directory,{recursive:true,mode:0o700});
    const file=path.join(directory,`rollout-${digest(this.logicalSessionId).slice(0,32)}.jsonl`);
    fs.writeFileSync(file,log,{flag:'wx',mode:0o600});
    const result=await this.rpc.call('thread/resume',{...settings.params,threadId:this.logicalSessionId,path:file});
    this.acceptRestore(result,file,settings);
    checkAbort(signal);
    return {restored:true,logicalSessionId:this.logicalSessionId};
  }
  acceptRestore(result,file,settings) {
    if(result?.thread?.id!==this.logicalSessionId || !result.thread.path || fs.realpathSync(result.thread.path)!==fs.realpathSync(file)) fail('CHECKPOINT_INVALID');
    if(JSON.stringify(result.approvalPolicy)!==JSON.stringify(settings.expected.approvalPolicy) ||
      JSON.stringify(result.sandbox)!==JSON.stringify(settings.expected.sandbox)) fail('POLICY_UNSUPPORTED');
    this.record={thread:result.thread,response:result,params:settings.params};this.settings=settings;this.restored=true;
  }
  async resumeSaved(saved) {
    const {file}=regularFile(saved.rollout,this.home,MAX_LOG);
    validateRollout(fs.readFileSync(file,'utf8'),this.logicalSessionId);
    const result=await this.rpc.call('thread/resume',{...saved.settings.params,threadId:this.logicalSessionId,path:file});
    this.acceptRestore(result,file,saved.settings);
  }
  descriptor() {
    if(!this.owned || !this.record?.thread?.path) fail('INVALID_ARGUMENT');
    return {threadId:this.logicalSessionId,profileId:this.profile.id,identity:this.profile.identity,home:this.home,
      rollout:this.record.thread.path,settings:this.settings};
  }
  async request(method,params,options) {return this.rpc.exchange(method,params,options);}
  async runTurn(input,{signal,onEvent}={}) {
    checkAbort(signal);if(!idle(await this.getActivity())) fail('BUSY');
    const id=this.logicalSessionId;
    return new Promise((resolve,reject)=>{
      let done=false,turnId=null,early=[];
      const finish=(error,value)=>{if(done)return;done=true;this.rpc.off('notification',notify);this.rpc.off('closed',closed);signal?.removeEventListener('abort',abort);error?reject(error):resolve(value);};
      const consume=m=>{
        if(m.params?.threadId!==id)return;
        onEvent?.(m);
        if(m.method==='turn/completed' && m.params.turn?.id===turnId) finish(null,m.params.turn);
      };
      const notify=m=>{if(turnId)consume(m);else early.push(m);};
      const closed=e=>finish(e);
      const abort=()=>{if(turnId)this.rpc.call('turn/interrupt',{threadId:id,turnId}).catch(closed);};
      this.rpc.on('notification',notify);this.rpc.once('closed',closed);signal?.addEventListener('abort',abort,{once:true});
      this.rpc.exchange('turn/start',{...input,threadId:id}).then(m=>{
        if(m.error) {finish(new (require('./common.cjs').SwitchError)('RPC_FAILED'));return;}
        turnId=m.result?.turn?.id;if(!turnId){finish(new (require('./common.cjs').SwitchError)('PROTOCOL_ERROR'));return;}
        onEvent?.({kind:'response',result:m.result});
        for(const event of early)consume(event);early=[];
        if(signal?.aborted)abort();
      },closed);
    });
  }
  async readUsage() {return this.rpc.call('account/rateLimits/read',{});}
  async close() {
    if(this.detached)return;
    if(this.owned) await this.rpc.close();
    else {
      // Detach only this thread; killing a shared source process would destroy
      // other conversations. Its original rollout is never the target file.
      const r=await this.rpc.call('thread/unsubscribe',{threadId:this.logicalSessionId});
      if(!['unsubscribed','notSubscribed','notLoaded'].includes(r?.status)) fail('CLEANUP_FAILED');
    }
    this.detached=true;this.pinnedToken=null;
  }
}
module.exports={DesktopBackend,settingsFrom,validateRollout,stableRead,idle};
