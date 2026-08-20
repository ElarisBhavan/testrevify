/* Authentication. Every path is audited; every failure is throttled. */
const crypto = require('crypto');
const L = require('./_lib');

const MAX_USER_FAILS = 5,  USER_LOCK_MIN = 15;
const MAX_IP_FAILS   = 20, IP_WINDOW_MIN = 15, IP_BLOCK_MIN = 30;

/* the same wording whether or not the account exists */
const VAGUE = { error:'invalid', message:'That username and password combination is not correct.' };

async function sendResetEmail(to, link, name){
  const key = process.env.RESEND_API_KEY;
  if(!key) return { sent:false, reason:'RESEND_API_KEY not set' };
  try{
    const r = await fetch('https://api.resend.com/emails', {
      method:'POST',
      headers:{ Authorization:`Bearer ${key}`, 'Content-Type':'application/json' },
      body: JSON.stringify({
        from: process.env.MAIL_FROM || 'ReviFlow <noreply@example.com>',
        to:[to],
        subject:'Reset your ReviFlow password',
        html:`<p>Hello ${name||''},</p>
              <p>A password reset was requested for your ReviFlow account. This link is
              valid for 30 minutes and can be used once.</p>
              <p><a href="${link}">Reset your password</a></p>
              <p>If you did not request this, no action is needed, but tell your
              administrator so the attempt can be reviewed.</p>`
      })
    });
    return { sent: r.ok };
  }catch(e){ return { sent:false, reason:String(e.message||e) }; }
}

exports.handler = async (event) => {
  if(!['POST','GET'].includes(event.httpMethod)) return L.J(405,{ error:'method' });

  const sql = L.db();
  const url = new URL(event.rawUrl || `https://x${event.path}`);
  const action = (url.searchParams.get('action')||'').toLowerCase();
  let body = {};
  if(event.body){ try{ body = JSON.parse(event.body); }catch{ return L.J(400,{error:'bad_json'}); } }

  const ip = L.clientIp(event);

  try{
    /* ── who am I ── */
    if(action === 'me'){
      const s = await L.readSession(event);
      if(!s) return L.J(401,{ error:'unauthenticated' },{ 'Set-Cookie': L.clearCookie() });
      return L.J(200,{ account:s });
    }

    /* ── sign out, this device or all of them ── */
    if(action === 'logout'){
      const s = await L.readSession(event);
      if(s){
        if(body.everywhere) await L.revokeAllForAccount(s.id, s.username, 'signout_all');
        else await L.revokeSession(s.session_id, s.username, 'signout');
        await L.audit(event,{ actor_id:s.id, actor:s.username,
          action: body.everywhere ? 'logout_all' : 'logout' });
      }
      return L.J(200,{ ok:true },{ 'Set-Cookie': L.clearCookie() });
    }

    /* ── step 1 ── */
    if(action === 'login'){
      const { username, password } = body;
      if(!username || !password) return L.J(400,{ error:'missing' });

      const ipGate = await L.rateLimit(`login-ip:${ip}`, MAX_IP_FAILS, IP_WINDOW_MIN, IP_BLOCK_MIN);
      if(ipGate.blocked){
        await L.audit(event,{ actor:username, action:'login_blocked', outcome:'blocked',
          detail:{ reason:'ip throttle' } });
        return L.J(429,{ error:'throttled',
          message:'Too many attempts from this address. Try again shortly.' });
      }

      const [acct] = await sql`SELECT * FROM accounts WHERE LOWER(username)=LOWER(${username}) LIMIT 1`;

      if(!acct){
        /* spend comparable time so timing cannot enumerate usernames */
        L.verifyPassword(password, 'scrypt$16384$00$00');
        await L.audit(event,{ actor:username, action:'login_failed', outcome:'failure',
          detail:{ reason:'unknown user' } });
        return L.J(401, VAGUE);
      }
      if(acct.status !== 'active'){
        await L.audit(event,{ actor_id:acct.id, actor:acct.username, action:'login_failed',
          outcome:'failure', detail:{ reason:acct.status } });
        return L.J(403,{ error:'disabled',
          message:'This account is not active. Contact your administrator.' });
      }
      if(acct.locked_until && new Date(acct.locked_until) > new Date()){
        return L.J(423,{ error:'locked',
          message:`Too many attempts. Try again after ${new Date(acct.locked_until).toLocaleTimeString()}.` });
      }

      if(!L.verifyPassword(password, acct.password_hash)){
        const fails = (acct.failed_attempts||0) + 1;
        const lock = fails >= MAX_USER_FAILS ? new Date(Date.now()+USER_LOCK_MIN*60000) : null;
        await sql`UPDATE accounts SET failed_attempts=${fails}, locked_until=${lock} WHERE id=${acct.id}`;
        await L.audit(event,{ actor_id:acct.id, actor:acct.username, action:'login_failed',
          outcome:'failure', detail:{ attempt:fails, locked:!!lock } });
        return L.J(401, lock
          ? { error:'locked', message:`Too many attempts. Locked for ${USER_LOCK_MIN} minutes.` }
          : VAGUE);
      }

      await sql`UPDATE accounts SET failed_attempts=0, locked_until=NULL WHERE id=${acct.id}`;
      await L.clearRateLimit(`login-ip:${ip}`);

      /* move an old hash to the current cost while we have the plaintext */
      if(L.needsRehash(acct.password_hash)){
        try{ await sql`UPDATE accounts SET password_hash=${L.hashPassword(password)} WHERE id=${acct.id}`; }catch{}
      }

      if(acct.must_change){
        return L.J(200,{ mustChange:true, challenge:L.signStep({ pw:true, id:acct.id }, 10),
                         name:acct.full_name, username:acct.username });
      }
      if(acct.mfa_enabled && acct.mfa_secret){
        return L.J(200,{ mfaRequired:true, challenge:L.signStep({ mfa:true, id:acct.id }, 5),
                         name:acct.full_name });
      }
      /* MFA is mandatory for anyone who can reach PHI */
      if(!acct.mfa_enabled && process.env.REQUIRE_MFA !== 'false'){
        const secret = L.randomSecret();
        await sql`UPDATE accounts SET mfa_secret=${secret} WHERE id=${acct.id}`;
        return L.J(200,{ mfaEnrol:true, challenge:L.signStep({ enrol:true, id:acct.id }, 10),
                         secret, otpauth:L.otpauth(acct.username, secret), name:acct.full_name });
      }
      return finish(acct, event);
    }

    /* ── step 2: the six digits ── */
    if(action === 'mfa'){
      const c = L.verifyStep(body.challenge);
      if(!c || !(c.mfa || c.enrol))
        return L.J(401,{ error:'expired', message:'That sign-in attempt expired. Start again.' });

      const gate = await L.rateLimit(`mfa:${c.id}`, 6, 10, 15);
      if(gate.blocked) return L.J(429,{ error:'throttled', message:'Too many codes. Wait a few minutes.' });

      const [acct] = await sql`SELECT * FROM accounts WHERE id=${c.id} LIMIT 1`;
      if(!acct) return L.J(401, VAGUE);

      if(!L.verifyTotp(acct.mfa_secret, body.code)){
        await L.audit(event,{ actor_id:acct.id, actor:acct.username, action:'mfa_failed', outcome:'failure' });
        return L.J(401,{ error:'code', message:'That code is not valid. Codes refresh every 30 seconds.' });
      }
      await L.clearRateLimit(`mfa:${c.id}`);
      if(c.enrol) await sql`UPDATE accounts SET mfa_enabled=TRUE WHERE id=${acct.id}`;
      return finish(acct, event);
    }

    /* ── forced password change at first sign-in ── */
    if(action === 'first-password'){
      const c = L.verifyStep(body.challenge);
      if(!c || !c.pw) return L.J(401,{ error:'expired' });
      const problem = L.passwordProblem(body.password);
      if(problem) return L.J(400,{ error:'weak', message:problem });

      const [acct] = await sql`SELECT * FROM accounts WHERE id=${c.id} LIMIT 1`;
      if(!acct) return L.J(401, VAGUE);
      await setPassword(acct, body.password, event, 'first_password');

      const secret = acct.mfa_secret || L.randomSecret();
      await sql`UPDATE accounts SET mfa_secret=${secret} WHERE id=${acct.id}`;
      return L.J(200,{ ok:true, mfaEnrol:true,
        challenge:L.signStep({ enrol:true, id:acct.id }, 10),
        secret, otpauth:L.otpauth(acct.username, secret) });
    }

    /* ── change your own password ── */
    if(action === 'change-password'){
      const g = await L.requireSession(event);
      if(g.error) return g.error;
      const [acct] = await sql`SELECT * FROM accounts WHERE id=${g.session.id} LIMIT 1`;
      if(!acct || !L.verifyPassword(body.current, acct.password_hash))
        return L.J(401,{ error:'current', message:'That current password is not correct.' });
      const problem = L.passwordProblem(body.next);
      if(problem) return L.J(400,{ error:'weak', message:problem });

      const recent = await sql`SELECT hash FROM password_history
        WHERE account_id=${acct.id} ORDER BY created_at DESC LIMIT 5`;
      if(recent.some(r => L.verifyPassword(body.next, r.hash)))
        return L.J(400,{ error:'reused', message:'That matches one of your last five passwords.' });

      await setPassword(acct, body.next, event, 'change_password');
      /* a password change ends every other session */
      await L.revokeAllForAccount(acct.id, acct.username, 'password_changed');
      const { raw, expires } = await L.createSession(acct, event);
      return L.J(200,{ ok:true },{ 'Set-Cookie': L.cookie(raw) });
    }

    /* ── forgotten password ── */
    if(action === 'forgot'){
      const gate = await L.rateLimit(`forgot-ip:${ip}`, 5, 15, 30);
      if(gate.blocked) return L.J(429,{ error:'throttled' });

      const generic = { ok:true,
        message:'If that account exists, a reset link has been sent to the email on file.' };
      const [acct] = await sql`SELECT * FROM accounts
        WHERE LOWER(username)=LOWER(${body.username}) OR LOWER(email)=LOWER(${body.username}) LIMIT 1`;
      if(!acct || !acct.email){
        await L.audit(event,{ actor:body.username, action:'reset_requested', outcome:'no_account' });
        return L.J(200, generic);
      }

      const raw = crypto.randomBytes(32).toString('base64url');
      await sql`INSERT INTO reset_tokens (token_hash, account_id, expires_at, ip)
                VALUES (${L.sha256(raw)}, ${acct.id}, ${new Date(Date.now()+30*60000)}, ${ip})`;
      const origin = process.env.SITE_URL || url.origin;
      const mail = await sendResetEmail(acct.email,
        `${origin}/Admin/reset-password.html?token=${raw}`, acct.full_name);
      await L.audit(event,{ actor_id:acct.id, actor:acct.username, action:'reset_requested',
        detail:{ emailed: mail.sent } });
      return L.J(200, generic);
    }

    /* ── complete the reset ── */
    if(action === 'reset'){
      const problem = L.passwordProblem(body.password);
      if(problem) return L.J(400,{ error:'weak', message:problem });

      const [row] = await sql`SELECT * FROM reset_tokens WHERE token_hash=${L.sha256(body.token)} LIMIT 1`;
      if(!row || row.used_at || new Date(row.expires_at) < new Date())
        return L.J(400,{ error:'invalid', message:'That reset link has expired or has already been used.' });

      const [acct] = await sql`SELECT * FROM accounts WHERE id=${row.account_id} LIMIT 1`;
      if(!acct) return L.J(400,{ error:'invalid' });

      await setPassword(acct, body.password, event, 'reset_password');
      await sql`UPDATE reset_tokens SET used_at=NOW() WHERE token_hash=${L.sha256(body.token)}`;
      await L.revokeAllForAccount(acct.id, 'system', 'password_reset');
      return L.J(200,{ ok:true, message:'Password updated. You can sign in now.' });
    }

    /* ── this account's devices ── */
    if(action === 'sessions'){
      const g = await L.requireSession(event);
      if(g.error) return g.error;
      const rows = await sql`SELECT id, device_label, ip, created_at, last_seen, expires_at
        FROM sessions WHERE account_id=${g.session.id} AND revoked_at IS NULL
        AND expires_at > NOW() ORDER BY last_seen DESC`;
      return L.J(200,{ sessions: rows.map(r => ({ ...r, current: r.id === g.session.session_id })) });
    }
    if(action === 'revoke'){
      const g = await L.requireSession(event);
      if(g.error) return g.error;
      await L.revokeSession(body.id, g.session.username, 'revoked_by_user');
      await L.audit(event,{ actor_id:g.session.id, actor:g.session.username,
        action:'session_revoked', entity:'session', entity_id:body.id });
      return L.J(200,{ ok:true });
    }

    return L.J(400,{ error:'unknown_action' });

  }catch(err){
    console.error('auth error', err);
    return L.J(500,{ error:'server' });   // never leak internals to the client
  }
};

async function setPassword(acct, pw, event, action){
  const sql = L.db();
  const hash = L.hashPassword(pw);
  await sql`INSERT INTO password_history (account_id, hash) VALUES (${acct.id}, ${acct.password_hash})`;
  await sql`UPDATE accounts SET password_hash=${hash}, password_set_at=NOW(),
            must_change=FALSE, failed_attempts=0, locked_until=NULL, updated_at=NOW()
            WHERE id=${acct.id}`;
  await sql`DELETE FROM password_history WHERE account_id=${acct.id} AND id NOT IN (
              SELECT id FROM password_history WHERE account_id=${acct.id}
              ORDER BY created_at DESC LIMIT 5)`;
  await L.audit(event,{ actor_id:acct.id, actor:acct.username, action });
}

async function finish(acct, event){
  const sql = L.db();
  await sql`UPDATE accounts SET last_login=NOW(), last_login_ip=${L.clientIp(event)} WHERE id=${acct.id}`;
  const { raw } = await L.createSession(acct, event);
  await L.audit(event,{ actor_id:acct.id, actor:acct.username, action:'login' });
  return L.J(200,{
    ok:true,
    account:{ id:acct.id, username:acct.username, role:acct.role, name:acct.full_name,
              title:acct.title, initials:acct.initials, pid:acct.provider_id,
              provider_ref:acct.provider_ref, org_id:acct.org_id, scope:acct.scope }
  },{ 'Set-Cookie': L.cookie(raw) });
}
