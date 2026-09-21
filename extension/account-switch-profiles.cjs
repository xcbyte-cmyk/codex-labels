'use strict';
// Read existing managed profiles only. Never copy/write auth.json or expose tokens over IPC.
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const ID = /^[0-9a-f]{32}$/;
function failure(code) { const error = new Error(code); error.code = code; return error; }
function regular(file, directory = false) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw failure('UNSAFE_PROFILE');
  if (!directory && stat.size > 65536) throw failure('INVALID_PROFILE');
}
function json(file) { regular(file); return JSON.parse(fs.readFileSync(file, 'utf8')); }
function jwt(token) {
  if (typeof token !== 'string' || token.length > 32768 || token.split('.').length !== 3) throw failure('SIGN_IN_REQUIRED');
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); }
  catch { throw failure('SIGN_IN_REQUIRED'); }
}
function createProfiles(root, {now = Date.now} = {}) {
  root = path.resolve(root);
  function read(id) {
    if (typeof id !== 'string' || !ID.test(id)) throw failure('INVALID_PROFILE');
    const accounts = path.join(root, 'accounts'), directory = path.join(accounts, id);
    for (const dir of [root, accounts, directory]) regular(dir, true);
    if (fs.existsSync(path.join(accounts, `.delete-${id}.json`))) throw failure('PROFILE_REMOVING');
    const meta = json(path.join(directory, 'account.json'));
    if (meta.version !== 1 || meta.id !== id || typeof meta.name !== 'string' ||
        !meta.name.trim() || meta.name.length > 40 || /[\x00-\x1f\x7f]/.test(meta.name)) throw failure('INVALID_PROFILE');
    const home = path.join(directory, 'codex-home'); regular(home, true);
    return {id, name: meta.name, home};
  }
  function credential(id) {
    try {
      const profile = read(id), auth = json(path.join(profile.home, 'auth.json'));
      if (auth.auth_mode && auth.auth_mode !== 'chatgpt') throw failure('SIGN_IN_REQUIRED');
      const tokens = auth.tokens;
      if (!tokens || typeof tokens.account_id !== 'string' || !tokens.account_id || tokens.account_id.length > 256) throw failure('SIGN_IN_REQUIRED');
      const access = jwt(tokens.access_token), identity = jwt(tokens.id_token);
      const claims = access['https://api.openai.com/auth'];
      const idClaims = identity['https://api.openai.com/auth'];
      if (!claims || !idClaims || claims.chatgpt_account_id !== tokens.account_id ||
          idClaims.chatgpt_account_id !== tokens.account_id || typeof access.sub !== 'string' ||
          access.sub !== identity.sub || !Number.isFinite(access.exp) || access.exp * 1000 <= now() + 60000) throw failure('SIGN_IN_REQUIRED');
      // Parsing JWTs is NOT signature verification; the candidate server must authenticate.
      return {profileId: id, accessToken: tokens.access_token, chatgptAccountId: tokens.account_id,
        chatgptPlanType: typeof claims.chatgpt_plan_type === 'string' ? claims.chatgpt_plan_type : null,
        identity: createHash('sha256').update(`${tokens.account_id}\0${access.sub}`).digest('hex'),
        email: typeof identity.email === 'string' && identity.email.length < 256 ? identity.email : null};
    } catch (error) { if (error.code && ['INVALID_PROFILE','UNSAFE_PROFILE','PROFILE_REMOVING'].includes(error.code)) throw error; throw failure('SIGN_IN_REQUIRED'); }
  }
  function list() {
    const accounts = path.join(root, 'accounts');
    for (const dir of [root, accounts]) regular(dir, true);
    return fs.readdirSync(accounts).filter(id => ID.test(id)).slice(0, 100).flatMap(id => {
      try {
        const {name} = read(id);
        try { const c = credential(id); return [{id, name, signedIn: true, email: c.email}]; }
        catch { return [{id, name, signedIn: false, email: null}]; }
      } catch { return []; }
    });
  }
  return {read, credential, list};
}
module.exports = {createProfiles, failure};
