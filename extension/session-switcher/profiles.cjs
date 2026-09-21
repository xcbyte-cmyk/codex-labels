'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {fail,assertText,regularFile,equalIdentity}=require('./common.cjs');
const DEFAULT_ID='0'.repeat(32), PROFILE_ID=/^[0-9a-f]{32}$/;
/** Decode only to pin identity, not to claim cryptographic JWT verification.
 * The app-server's authenticated rate-limit read is a separate acceptance check. */
function tokenIdentity(token,{allowExpired=false,now=Date.now()}={}) {
  if(typeof token!=='string' || token.length>100000) fail('AUTH_REQUIRED');
  const parts=token.split('.'); if(parts.length!==3) fail('AUTH_REQUIRED');
  let claims;try{claims=JSON.parse(Buffer.from(parts[1],'base64url').toString('utf8'));}catch{fail('AUTH_REQUIRED');}
  const a=claims['https://api.openai.com/auth'];
  if(!a || !a.chatgpt_account_id || !a.chatgpt_user_id) fail('UNSUPPORTED');
  if(!allowExpired && (!Number.isFinite(claims.exp) || claims.exp*1000<now+30000)) fail('AUTH_REQUIRED');
  return {identity:Object.freeze({accountId:assertText(a.chatgpt_account_id),userId:assertText(a.chatgpt_user_id),workspaceId:null}),
    planType:typeof a.chatgpt_plan_type==='string'?a.chatgpt_plan_type:null,expiresAt:claims.exp,
    // workspaceId is null: the billed ChatGPT workspace is already accountId.
    // Never infer a separate organisation identifier from an email address.
  };
}
class ProfileStore {
  constructor({accountsDirectory,defaultHome,currentProfileId=null}) {
    this.accountsDirectory=path.resolve(accountsDirectory);this.defaultHome=path.resolve(defaultHome);
    this.currentProfileId=currentProfileId || DEFAULT_ID;
  }
  resolve(id) {
    if(!PROFILE_ID.test(id)) fail('INVALID_ARGUMENT');
    if(id===DEFAULT_ID) return {id,name:'기본 프로필',home:this.defaultHome};
    try {
      const directory=path.join(this.accountsDirectory,id);
      const {file}=regularFile(path.join(directory,'account.json'),this.accountsDirectory,16384);
      const m=JSON.parse(fs.readFileSync(file,'utf8'));
      if(m.id!==id) fail('INVALID_ARGUMENT');
      const home=fs.realpathSync(path.join(directory,'codex-home'));
      if(home!==path.join(fs.realpathSync(directory),'codex-home')) fail('INVALID_ARGUMENT');
      return {id,name:assertText(m.name,40),home};
    } catch(e) { if(e.code==='INVALID_ARGUMENT')throw e;fail('NOT_FOUND'); }
  }
  list() {
    let ids=[];try{ids=fs.readdirSync(this.accountsDirectory).filter(id=>PROFILE_ID.test(id)&&id!==DEFAULT_ID);}catch{}
    return [DEFAULT_ID,...ids].flatMap(id=>{try{const p=this.resolve(id);return [{id:p.id,name:p.name,currentWindow:id===this.currentProfileId}];}catch{return [];}});
  }
  token(id,expected) {
    const p=this.resolve(id);
    let auth;
    try {const {file}=regularFile(path.join(p.home,'auth.json'),p.home,1024*1024);auth=JSON.parse(fs.readFileSync(file,'utf8'));}catch{fail('AUTH_REQUIRED');}
    const accessToken=auth.tokens?.access_token;
    const parsed=tokenIdentity(accessToken);
    if(auth.tokens.account_id && auth.tokens.account_id!==parsed.identity.accountId) fail('IDENTITY_MISMATCH');
    if(expected && !equalIdentity(expected,parsed.identity)) fail('IDENTITY_MISMATCH');
    return {...p,...parsed,accessToken};
  }
  pin(id) {const {identity}=this.token(id);const p=this.resolve(id);return {id:p.id,name:p.name,identity};}
}
module.exports={ProfileStore,tokenIdentity,DEFAULT_ID,PROFILE_ID};
