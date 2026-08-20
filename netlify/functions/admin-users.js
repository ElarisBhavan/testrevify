/* Account management — admin only. Creates the logins the front end signs in with. */
const crypto = require('crypto');
const L = require('./_lib');

const ROLES = ['admin','supervisor','provider','scheduler','employee'];

function tempPassword(){
  const A='ABCDEFGHJKMNPQRSTUVWXYZ', a='abcdefghijkmnpqrstuvwxyz', n='23456789', s='!#$%&*+?';
  const pick = set => set[crypto.randomInt(set.length)];
  let out = [pick(A),pick(A),pick(a),pick(a),pick(a),pick(n),pick(n),pick(n),pick(s),pick(s)];
  for(let i=out.length-1;i>0;i--){ const j=crypto.randomInt(i+1); [out[i],out[j]]=[out[j],out[i]]; }
  return out.join('');
}
const initialsOf = n => String(n||'').replace(/^Dr\.?\s+/i,'')
  .split(/\s+/).filter(Boolean).slice(0,2).map(w=>w[0]).join('').toUpperCase();

exports.handler = async (event) => {
  const gate = await L.requireSession(event, ['admin']);
  if(gate.error) return gate.error;
  const me = gate.session;

  const sql = L.db();
  const url = new URL(event.rawUrl || `https://x${event.path}`);
  const action = (url.searchParams.get('action') || 'list').toLowerCase();
  let b = {};
  if(event.body){ try{ b = JSON.parse(event.body); }catch{} }

  try{
    /* ── list ── */
    if(action === 'list'){
      const rows = await sql`
        SELECT id,username,email,phone,role,full_name,title,initials,provider_id,scope,
               status,mfa_enabled,must_change,last_login,created_by,created_at
        FROM accounts ORDER BY role, full_name`;
      return L.J(200, { accounts: rows });
    }

    /* ── create ── */
    if(action === 'create'){
      const { username, full_name, role } = b;
      if(!username || !full_name || !role)
        return L.J(400, { error:'Username, full name and role are required' });
      if(!ROLES.includes(role)) return L.J(400, { error:'Unknown role' });
      if(!/^[a-z0-9._-]{3,40}$/i.test(username))
        return L.J(400, { error:'Username may use letters, numbers, dot, dash and underscore only' });

      const [dupe] = await sql`SELECT id FROM accounts WHERE LOWER(username)=LOWER(${username}) LIMIT 1`;
      if(dupe) return L.J(409, { error:'That username is already taken' });

      const pw = b.password || tempPassword();
      const secret = b.mfa_enabled ? L.randomSecret() : null;

      const [row] = await sql`
        INSERT INTO accounts (username,email,phone,password_hash,role,full_name,title,initials,
                              provider_id,scope,mfa_enabled,mfa_secret,must_change,created_by)
        VALUES (${username.toLowerCase()},${b.email||null},${b.phone||null},${L.hashPassword(pw)},
                ${role},${full_name},${b.title||null},${b.initials||initialsOf(full_name)},
                ${b.provider_id||null},${b.scope||(role==='admin'?'all':role==='provider'?'self':'facility')},
                ${!!b.mfa_enabled},${secret},${b.must_change !== false},${me.username})
        RETURNING id,username,role,full_name`;

      await L.audit(me.username,'create_account',username,{ role });
      return L.J(201, {
        account: row,
        tempPassword: b.password ? null : pw,   // shown once, never stored in the clear
        mfa: secret ? { secret, otpauth: L.otpauth(username, secret) } : null
      });
    }

    /* ── update ── */
    if(action === 'update'){
      const { id } = b;
      if(!id) return L.J(400, { error:'id is required' });
      const [row] = await sql`
        UPDATE accounts SET
          email       = COALESCE(${b.email ?? null}, email),
          phone       = COALESCE(${b.phone ?? null}, phone),
          role        = COALESCE(${b.role ?? null}, role),
          full_name   = COALESCE(${b.full_name ?? null}, full_name),
          title       = COALESCE(${b.title ?? null}, title),
          initials    = COALESCE(${b.initials ?? null}, initials),
          provider_id = COALESCE(${b.provider_id ?? null}, provider_id),
          scope       = COALESCE(${b.scope ?? null}, scope),
          status      = COALESCE(${b.status ?? null}, status),
          updated_at  = NOW()
        WHERE id=${id} RETURNING id,username,role,status`;
      await L.audit(me.username,'update_account',row?.username,b);
      return L.J(200, { account: row });
    }

    /* ── reset a password on the user's behalf ── */
    if(action === 'reset-password'){
      const { id } = b;
      if(!id) return L.J(400, { error:'id is required' });
      const pw = b.password || tempPassword();
      const [row] = await sql`
        UPDATE accounts SET password_hash=${L.hashPassword(pw)}, must_change=TRUE,
               failed_attempts=0, locked_until=NULL, updated_at=NOW()
        WHERE id=${id} RETURNING username`;
      await L.audit(me.username,'reset_password',row?.username,{});
      return L.J(200, { ok:true, tempPassword: pw, username: row?.username });
    }

    /* ── turn MFA on / off ── */
    if(action === 'mfa'){
      const { id, enable } = b;
      if(!id) return L.J(400, { error:'id is required' });
      if(enable){
        const secret = L.randomSecret();
        const [row] = await sql`UPDATE accounts SET mfa_secret=${secret}, mfa_enabled=FALSE
                                WHERE id=${id} RETURNING username`;
        await L.audit(me.username,'mfa_reset',row?.username,{});
        return L.J(200, { ok:true, secret, otpauth: L.otpauth(row.username, secret),
                          note:'The user completes enrolment at their next sign-in.' });
      }
      const [row] = await sql`UPDATE accounts SET mfa_enabled=FALSE, mfa_secret=NULL
                              WHERE id=${id} RETURNING username`;
      await L.audit(me.username,'mfa_disable',row?.username,{});
      return L.J(200, { ok:true });
    }

    /* ── unlock after failed attempts ── */
    if(action === 'unlock'){
      const [row] = await sql`UPDATE accounts SET failed_attempts=0, locked_until=NULL
                              WHERE id=${b.id} RETURNING username`;
      await L.audit(me.username,'unlock',row?.username,{});
      return L.J(200, { ok:true });
    }

    /* ── delete ── */
    if(action === 'delete'){
      const { id } = b;
      const [target] = await sql`SELECT username,role FROM accounts WHERE id=${id}`;
      if(!target) return L.J(404, { error:'Not found' });
      if(target.username === me.username) return L.J(400, { error:'You cannot delete your own account' });
      if(target.role === 'admin'){
        const [{count}] = await sql`SELECT COUNT(*)::int FROM accounts WHERE role='admin' AND status='active'`;
        if(count <= 1) return L.J(400, { error:'This is the last active administrator' });
      }
      await sql`DELETE FROM accounts WHERE id=${id}`;
      await L.audit(me.username,'delete_account',target.username,{});
      return L.J(200, { ok:true });
    }

    /* ── login hours, for the Track Hours tile ── */
    if(action === 'hours'){
      const days = Math.min(90, parseInt(url.searchParams.get('days')||'30',10));
      const rows = await sql`
        SELECT a.id, a.username, a.full_name, a.role, a.last_login,
               COUNT(*) FILTER (WHERE e.event='login')  AS logins,
               COUNT(*) FILTER (WHERE e.event='failed') AS failures,
               MIN(e.at) AS first_seen, MAX(e.at) AS last_seen
        FROM accounts a
        LEFT JOIN login_events e ON e.account_id=a.id AND e.at > NOW() - (${days} || ' days')::interval
        GROUP BY a.id ORDER BY a.full_name`;
      return L.J(200, { days, rows });
    }

    /* ── recent audit ── */
    if(action === 'audit'){
      const rows = await sql`SELECT * FROM account_audit ORDER BY at DESC LIMIT 100`;
      return L.J(200, { rows });
    }

    return L.J(400, { error:'Unknown action' });

  }catch(err){
    return L.J(500, { error:'server', message:String(err.message||err) });
  }
};
