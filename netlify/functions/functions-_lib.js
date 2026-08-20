/* Shared server helpers. Node crypto only — no third-party crypto. */
const crypto = require('crypto');
const postgres = require('postgres');

let _sql;
function db(){
  if(!_sql){
    const url = process.env.DATABASE_URL;
    if(!url) throw new Error('DATABASE_URL is not set');
    _sql = postgres(url, { ssl:'require', max:1, idle_timeout:20, connect_timeout:10 });
  }
  return _sql;
}

/* ── passwords: scrypt, memory-hard, per-account salt ── */
const SCRYPT = { N:16384, r:8, p:1, keylen:64, maxmem:64*1024*1024 };

function hashPassword(pw){
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, SCRYPT.keylen, SCRYPT).toString('hex');
  return `scrypt$${SCRYPT.N}$${salt}$${hash}`;
}
function verifyPassword(pw, stored){
  try{
    const s = String(stored||'');
    if(s.startsWith('scrypt$')){
      const [, N, salt, hash] = s.split('$');
      const test = crypto.scryptSync(String(pw), salt, SCRYPT.keylen, { ...SCRYPT, N:parseInt(N,10) });
      const known = Buffer.from(hash,'hex');
      return test.length === known.length && crypto.timingSafeEqual(test, known);
    }
    const [salt, hash] = s.split(':');            // legacy
    if(!salt || !hash) return false;
    const test = crypto.scryptSync(String(pw), salt, 64);
    const known = Buffer.from(hash,'hex');
    return test.length === known.length && crypto.timingSafeEqual(test, known);
  }catch{ return false; }
}
const needsRehash = h => !String(h||'').startsWith(`scrypt$${SCRYPT.N}$`);

/* password rules — NIST 800-63B: length over composition theatre */
function passwordProblem(pw){
  const s = String(pw||'');
  if(s.length < 12) return 'Use at least 12 characters.';
  if(s.length > 128) return 'Use fewer than 128 characters.';
  if(/^(.)\1+$/.test(s)) return 'That is a single repeated character.';
  const weak = ['password','12345678','qwerty','letmein','welcome','admin123',
                'reviflow','changeme','iloveyou','abc12345'];
  if(weak.some(w => s.toLowerCase().includes(w))) return 'That contains a commonly used password.';
  return null;
}

/* ── sessions: opaque token, hashed at rest, revocable ── */
const sha256 = v => crypto.createHash('sha256').update(String(v)).digest('hex');
const SESSION_HOURS = 12;
const IDLE_MINUTES  = 30;

async function createSession(account, event){
  const sql = db();
  const raw = crypto.randomBytes(32).toString('base64url');
  const h = { ...(event.headers||{}) };
  const expires = new Date(Date.now() + SESSION_HOURS*3600*1000);
  await sql`INSERT INTO sessions (account_id, token_hash, device_label, ip, user_agent, expires_at)
            VALUES (${account.id}, ${sha256(raw)}, ${deviceLabel(h['user-agent'])},
                    ${clientIp(event)}, ${h['user-agent']||null}, ${expires})`;
  return { raw, expires };
}
async function readSession(event){
  const raw = readCookie(event);
  if(!raw) return null;
  const sql = db();
  const [row] = await sql`
    SELECT s.*, a.username, a.role, a.full_name, a.title, a.initials,
           a.provider_id, a.provider_ref, a.org_id, a.scope, a.status, a.must_change
    FROM sessions s JOIN accounts a ON a.id = s.account_id
    WHERE s.token_hash = ${sha256(raw)} LIMIT 1`;
  if(!row) return null;
  if(row.revoked_at) return null;
  if(new Date(row.expires_at) < new Date()) return null;
  if(row.status !== 'active') return null;
  if(Date.now() - new Date(row.last_seen).getTime() > IDLE_MINUTES*60000){
    await sql`UPDATE sessions SET revoked_at=NOW(), revoke_reason='idle' WHERE id=${row.id}`;
    return null;
  }
  await sql`UPDATE sessions SET last_seen=NOW() WHERE id=${row.id}`;
  return {
    session_id: row.id, id: row.account_id, username: row.username, role: row.role,
    name: row.full_name, title: row.title, initials: row.initials,
    pid: row.provider_id, provider_ref: row.provider_ref,
    org_id: row.org_id, scope: row.scope, mustChange: row.must_change
  };
}
async function revokeSession(id, by, reason){
  await db()`UPDATE sessions SET revoked_at=NOW(), revoked_by=${by||null},
             revoke_reason=${reason||'signout'} WHERE id=${id} AND revoked_at IS NULL`;
}
async function revokeAllForAccount(accountId, by, reason){
  await db()`UPDATE sessions SET revoked_at=NOW(), revoked_by=${by||null},
             revoke_reason=${reason||'signout_all'}
             WHERE account_id=${accountId} AND revoked_at IS NULL`;
}

function cookie(raw, hours){
  return `rf_sid=${raw}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${(hours||SESSION_HOURS)*3600}`;
}
const clearCookie = () => 'rf_sid=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0';
function readCookie(event, name='rf_sid'){
  const raw = (event.headers && (event.headers.cookie || event.headers.Cookie)) || '';
  const m = raw.match(new RegExp('(?:^|;\\s*)'+name+'=([^;]+)'));
  return m ? m[1] : null;
}

/* short-lived signed token, used only between the password and MFA steps */
function signStep(payload, minutes){
  const secret = process.env.JWT_SECRET;
  if(!secret) throw new Error('JWT_SECRET is not set');
  const body = Buffer.from(JSON.stringify({ ...payload,
    exp: Math.floor(Date.now()/1000) + (minutes||5)*60 })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function verifyStep(token){
  try{
    const secret = process.env.JWT_SECRET;
    const [body, sig] = String(token).split('.');
    if(!body || !sig) return null;
    const want = crypto.createHmac('sha256', secret).update(body).digest('base64url');
    if(sig.length !== want.length) return null;
    if(!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
    const p = JSON.parse(Buffer.from(body,'base64url').toString());
    if(p.exp && p.exp < Math.floor(Date.now()/1000)) return null;
    return p;
  }catch{ return null; }
}

/* ── TOTP ── */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function randomSecret(len=20){
  return [...crypto.randomBytes(len)].map(b => B32[b % 32]).join('');
}
function b32decode(s){
  let bits = ''; const out = [];
  for(const c of String(s).toUpperCase().replace(/=+$/,'')){
    const i = B32.indexOf(c);
    if(i >= 0) bits += i.toString(2).padStart(5,'0');
  }
  for(let i=0; i+8<=bits.length; i+=8) out.push(parseInt(bits.slice(i,i+8),2));
  return Buffer.from(out);
}
function totp(secret, step){
  const c = Buffer.alloc(8);
  c.writeUInt32BE(Math.floor(step/0x100000000),0);
  c.writeUInt32BE(step>>>0,4);
  const hmac = crypto.createHmac('sha1', b32decode(secret)).update(c).digest();
  const off = hmac[hmac.length-1] & 0x0f;
  return String(((hmac[off]&0x7f)<<24 | hmac[off+1]<<16 | hmac[off+2]<<8 | hmac[off+3]) % 1000000)
    .padStart(6,'0');
}
function verifyTotp(secret, code){
  const clean = String(code||'').replace(/\D/g,'');
  if(!secret || clean.length !== 6) return false;
  const now = Math.floor(Date.now()/1000/30);
  for(let w=-1; w<=1; w++){
    const want = totp(secret, now+w);
    if(crypto.timingSafeEqual(Buffer.from(want), Buffer.from(clean))) return true;
  }
  return false;
}
const otpauth = (user, secret, issuer='ReviFlow RCM') =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(user)}`
  + `?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

/* ── request context ── */
function clientIp(event){
  const h = event.headers || {};
  const raw = h['x-nf-client-connection-ip'] || h['client-ip'] ||
              (h['x-forwarded-for']||'').split(',')[0].trim();
  return raw || null;
}
function deviceLabel(ua){
  ua = String(ua||'');
  let d = 'Unknown device', b = 'Browser';
  if(/iPhone/.test(ua)) d='iPhone'; else if(/iPad/.test(ua)) d='iPad';
  else if(/Android/.test(ua)) d = /Mobile/.test(ua)?'Android phone':'Android tablet';
  else if(/Macintosh/.test(ua)) d='Mac'; else if(/Windows/.test(ua)) d='Windows PC';
  else if(/Linux/.test(ua)) d='Linux PC';
  if(/Edg\//.test(ua)) b='Edge'; else if(/OPR\//.test(ua)) b='Opera';
  else if(/Chrome\//.test(ua)) b='Chrome'; else if(/Firefox\//.test(ua)) b='Firefox';
  else if(/Safari\//.test(ua)) b='Safari';
  return `${d} · ${b}`;
}

/* ── audit: append only, never blocks the request ── */
async function audit(event, { actor_id, actor, action, entity, entity_id,
                              phi = false, outcome = 'success', detail }){
  try{
    const h = event.headers || {};
    await db()`INSERT INTO audit_log
      (actor_id, actor, action, entity, entity_id, phi_accessed, outcome, ip, user_agent, detail)
      VALUES (${actor_id||null}, ${actor||null}, ${action}, ${entity||null}, ${entity_id?String(entity_id):null},
              ${!!phi}, ${outcome}, ${clientIp(event)}, ${h['user-agent']||null},
              ${db().json(detail||{})})`;
  }catch(e){ console.error('audit write failed', e.message); }
}

/* ── throttling: per identifier and per address ── */
async function rateLimit(bucket, max, windowMinutes, blockMinutes){
  const sql = db();
  const [row] = await sql`SELECT * FROM rate_limits WHERE bucket=${bucket} LIMIT 1`;
  const now = Date.now();
  if(row && row.blocked_until && new Date(row.blocked_until) > new Date())
    return { blocked:true, until: row.blocked_until };
  const fresh = !row || (now - new Date(row.window_at).getTime()) > windowMinutes*60000;
  const hits = fresh ? 1 : row.hits + 1;
  const blocked = hits > max;
  await sql`
    INSERT INTO rate_limits (bucket, hits, window_at, blocked_until)
    VALUES (${bucket}, ${hits}, ${fresh ? new Date() : row.window_at},
            ${blocked ? new Date(now + blockMinutes*60000) : null})
    ON CONFLICT (bucket) DO UPDATE
      SET hits = EXCLUDED.hits, window_at = EXCLUDED.window_at, blocked_until = EXCLUDED.blocked_until`;
  return { blocked, until: blocked ? new Date(now + blockMinutes*60000) : null };
}
async function clearRateLimit(bucket){
  try{ await db()`DELETE FROM rate_limits WHERE bucket=${bucket}`; }catch(e){}
}

/* ── responses ── */
const SECURITY_HEADERS = {
  'Content-Type':'application/json',
  'Cache-Control':'no-store, no-cache, must-revalidate, private',
  'Pragma':'no-cache',
  'X-Content-Type-Options':'nosniff',
  'X-Frame-Options':'DENY',
  'Referrer-Policy':'no-referrer',
  'Strict-Transport-Security':'max-age=63072000; includeSubDomains; preload'
};
const J = (code, body, extra={}) => ({
  statusCode: code, headers: { ...SECURITY_HEADERS, ...extra }, body: JSON.stringify(body)
});

/* every protected endpoint starts here */
async function requireSession(event, roles){
  const s = await readSession(event);
  if(!s) return { error: J(401, { error:'unauthenticated' }, { 'Set-Cookie': clearCookie() }) };
  if(roles && roles.length && !roles.includes(s.role)){
    await audit(event, { actor_id:s.id, actor:s.username, action:'access_denied',
                         outcome:'denied', detail:{ path:event.path, role:s.role } });
    return { error: J(403, { error:'forbidden' }) };
  }
  return { session: s };
}

module.exports = {
  db, hashPassword, verifyPassword, needsRehash, passwordProblem,
  createSession, readSession, revokeSession, revokeAllForAccount, requireSession,
  cookie, clearCookie, readCookie, signStep, verifyStep,
  randomSecret, totp, verifyTotp, otpauth,
  clientIp, deviceLabel, audit, rateLimit, clearRateLimit,
  J, SECURITY_HEADERS, sha256, SESSION_HOURS
};
