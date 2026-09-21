'use strict';
// Deterministic subprocess protocol simulator. NOT a real Codex/model server.
const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');
const home=process.env.CODEX_HOME;fs.mkdirSync(home,{recursive:true});
let token=null,serverId=1;const threads=new Map(),approval=new Map();
try{token=JSON.parse(fs.readFileSync(path.join(home,'auth.json'),'utf8')).tokens.access_token;}catch{}
const send=m=>process.stdout.write(JSON.stringify(m)+'\n');
const notify=(method,params)=>send({method,params});
function claims(){return JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString());}
const sandbox={type:'readOnly'};
function record(t){return {thread:{...t},model:'test-model',modelProvider:'openai',cwd:t.cwd,approvalPolicy:'on-request',sandbox};}
function create(id,cwd){
 const file=path.join(home,'sessions','2026','09','21',`rollout-test-${id}.jsonl`);fs.mkdirSync(path.dirname(file),{recursive:true});
 const log=[{type:'session_meta',payload:{id,cwd}},{type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'Synthetic source history.'}]}}].map(JSON.stringify).join('\n')+'\n';
 fs.writeFileSync(file,log);
 const t={id,path:file,cwd,ephemeral:false,status:{type:'idle'},turns:[],preview:'Synthetic conversation'};threads.set(id,t);return t;
}
function complete(t,turn){
 fs.appendFileSync(t.path,JSON.stringify({type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'Synthetic '+claims()['https://api.openai.com/auth'].chatgpt_account_id}]}})+'\n');
 t.status={type:'idle'};turn.status='completed';
 notify('thread/status/changed',{threadId:t.id,status:t.status});
 notify('turn/completed',{threadId:t.id,turn});
}
async function handle(m){
 if(!m.method){const a=approval.get(m.id);if(a){approval.delete(m.id);complete(a.t,a.turn);}return;}
 if(m.id===undefined)return;
 const p=m.params||{},t=threads.get(p.threadId);let result;
 switch(m.method){
  case 'initialize':result={userAgent:'protocol-test-fixture'};break;
  case 'account/login/start':token=p.accessToken;result={type:'chatgptAuthTokens'};break;
  case 'account/read':result={account:token?{type:'chatgpt',email:'fixture@example.invalid',planType:'test'}:null,requiresOpenaiAuth:true};break;
  case 'getAuthStatus':result={authMethod:'chatgpt',authToken:token,requiresOpenaiAuth:true};break;
  case 'account/rateLimits/read':if(!token)throw Error('not logged in');result={rateLimits:{primary:{usedPercent:25,windowDurationMins:300,resetsAt:2000000000}}};break;
  case 'thread/start': {const a=create(p.testId||'thread-1',p.cwd||process.cwd());result=record(a);break;}
  case 'thread/read':if(!t)throw Error('not loaded');result={thread:{...t}};break;
  case 'thread/resume':{
    const file=p.path || t?.path || path.join(home,'sessions','2026','09','21',`rollout-test-${p.threadId}.jsonl`);
    const log=fs.readFileSync(file,'utf8').trim().split('\n').map(JSON.parse);
    if(log[0].payload.id!==p.threadId)throw Error('wrong id');
    const a={id:p.threadId,path:file,cwd:p.cwd||log[0].payload.cwd,ephemeral:false,status:{type:'idle'},turns:[],preview:'Resumed synthetic conversation'};
    threads.set(a.id,a);result=record(a);break;
  }
  case 'thread/backgroundTerminals/list':result={terminals:process.env.TEST_BACKGROUND==='1'?[{processId:'pending'}]:[]};break;
  case 'thread/unsubscribe':result={status:'unsubscribed'};break;
  case 'thread/list':result={data:[...threads.values()],nextCursor:null};break;
  case 'thread/loaded/list':result={data:[...threads.keys()]};break;
  case 'thread/name/set':t.name=p.name;result={};break;
  case 'turn/start':{
    if(!t)throw Error('not loaded');
    const turn={id:'turn-'+Date.now(),status:'inProgress',items:[]};t.status={type:'active',activeFlags:[]};t.turns.push(turn);
    send({id:m.id,result:{turn}});notify('turn/started',{threadId:t.id,turn});
    notify('thread/status/changed',{threadId:t.id,status:t.status});
    const text=p.input?.[0]?.text;
    if(text==='approval') {
      const id=serverId++;approval.set(id,{t,turn});send({id,method:'item/commandExecution/requestApproval',params:{threadId:t.id,turnId:turn.id,itemId:'tool-1',command:'echo test'}});
    } else if(text!=='hold')setTimeout(()=>complete(t,turn),20);
    return;
  }
  case 'turn/interrupt':for(const turn of t.turns.filter(x=>x.status==='inProgress'))complete(t,turn);result={};break;
  case 'test/echo':result=p;break;
  case 'test/no-response':return;
  case 'test/raw-error':send({id:m.id,error:{code:-32000,message:'SECRET-TOKEN-DO-NOT-DISPLAY'}});return;
  case 'thread/inject_items':result={};break;
  default:send({id:m.id,error:{code:-32601,message:'method not found'}});return;
 }
 send({id:m.id,result});
}
const lines=readline.createInterface({input:process.stdin});
lines.on('line',line=>{let m;try{m=JSON.parse(line);handle(m).catch(()=>send({id:m.id,error:{code:-32000,message:'fixture failure'}}));}catch{process.exitCode=2;}});
lines.on('close',()=>process.exit(0));
