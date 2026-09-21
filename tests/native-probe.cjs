'use strict';
/** Optional REAL Codex executable probe. No login, model request or tool run.
 * This is NOT automatically run by the offline test suite. */
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process');
const {AppServerRpc}=require('../extension/session-switcher/rpc.cjs');
const {safeError}=require('../extension/session-switcher/common.cjs');
const executable=process.argv[2];
if(!executable || !fs.existsSync(executable)){console.error('Usage: node tests/native-probe.cjs C:\\...\\resources\\codex.exe');process.exit(2);}
(async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'labels-native-probe-'));const clients=[];
 let stage='initialize';
 const open=async name=>{
  const home=path.join(root,name);fs.mkdirSync(home);
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^(CODEX_|OPENAI_|CHATGPT_)/i.test(k)));
  env.CODEX_HOME=home;env.CODEX_SQLITE_HOME=home;
  const child=spawn(path.resolve(executable),['app-server','--stdio'],{cwd:root,env,windowsHide:true,stdio:['pipe','pipe','pipe']});child.stderr.resume();
  const rpc=new AppServerRpc(child);clients.push(rpc);await rpc.initialize();return {rpc,home};
 };
 try {
  const a=await open('source');
  stage='thread/start';
  const start=await a.rpc.call('thread/start',{cwd:root,approvalPolicy:'on-request',sandbox:'read-only',baseInstructions:'Synthetic protocol probe only. Never start a model request.'});
  // Exact method name: underscore, not thread/injectItems.
  stage='thread/inject_items';
  await a.rpc.call('thread/inject_items',{threadId:start.thread.id,items:[{type:'message',role:'user',content:[{type:'input_text',text:'Synthetic local probe. No model request.'}]}]});
  stage='thread/backgroundTerminals/list';
  const terminals=await a.rpc.call('thread/backgroundTerminals/list',{threadId:start.thread.id});
  if(!Array.isArray(terminals?.terminals) && !Array.isArray(terminals?.data))throw Error('Unrecognised terminals response');
  stage='getAuthStatus';
  await a.rpc.call('getAuthStatus',{includeToken:false,refreshToken:false});
  stage='target initialize';
  const b=await open('target');
  const relative=path.relative(a.home,start.thread.path);
  if(relative.startsWith('..')||path.isAbsolute(relative))throw Error('Source rollout outside isolated home');
  const dest=path.join(b.home,relative);
  fs.mkdirSync(path.dirname(dest),{recursive:true});
  fs.copyFileSync(start.thread.path,dest);
  stage='thread/resume';
  const response=await b.rpc.exchange('thread/resume',{threadId:start.thread.id,cwd:root,approvalPolicy:'on-request',sandbox:'read-only'});
  if(response.error)throw Object.assign(Error('resume rejected'),{code:'RPC_FAILED',rpcCode:response.error.code,rpcMessage:response.error.message});
  const restored=response.result;
  const passed=restored.thread.id===start.thread.id && path.resolve(restored.thread.path)===path.resolve(dest);
  console.log(JSON.stringify({passed,sameThreadId:restored.thread.id===start.thread.id,independentRollout:path.resolve(restored.thread.path)===path.resolve(dest),authIdentityVerified:false,modelRequests:0}));
  if(!passed)process.exitCode=1;
 }catch(error){console.error(JSON.stringify({passed:false,stage,error:safeError(error),rpcCode:error.rpcCode||null,rpcMessage:typeof error.rpcMessage==='string'?error.rpcMessage.slice(0,160):undefined}));process.exitCode=1;}
 finally{for(const rpc of clients)await rpc.close().catch(()=>{});try{fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:200});}catch(error){console.error(JSON.stringify({cleanupWarning:error.code}));}}
})();
