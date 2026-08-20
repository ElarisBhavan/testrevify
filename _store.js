/* ═══════════════════════════════════════════════════════════════
   ReviFlow — account store
   ONE interface, TWO drivers:
     'local' — IndexedDB in the browser. Works with no server.
     'api'   — the Netlify Functions + Postgres backend.
   Flip DRIVER to 'api' after deploying. No other file changes.
   Passwords are PBKDF2-hashed in both drivers — never stored readable.
   ═══════════════════════════════════════════════════════════════ */
(function(){
  /* 'api'   — accounts live in Postgres, shared by everyone (needs deployment)
     'local' — accounts live in this browser only, for offline development */
  /* ─────────────────────────────────────────────────────────────
     WHERE THE DATA LIVES — change this one word when you are ready.

       'local'  every browser keeps its own copy. Nothing is shared.
                Right for building and testing.

       'api'    one shared database on the server. Everyone who opens
                the link sees the same patients, claims and logins.
                Requires the database, the schema and a signed BAA,
                because this is the point at which PHI leaves the
                browser and reaches a server.

     Nothing else needs editing. Every page reads this. */
  const DRIVER = (typeof window !== 'undefined' && window.RF_DRIVER) || 'api';
  /* ───────────────────────────────────────────────────────────── */
  /* Bumped on every release. Printed to the console and shown in the page
     footer, so which build is actually loaded is never in doubt. */
  const BUILD = '2026.08.20-postgres-a';
  window.RF_BUILD = BUILD;

  const DB = 'reviflow', STORE = 'accounts', META = 'meta', VER = 10;
  const ORGS = 'orgs', PROVIDERS = 'providers', PATIENTS = 'patients', APPTS = 'appts', TASKS = 'tasks', CLAIMS = 'claims', ENC = 'encounters', HIST = 'history', CRED = 'credentialing', PAYERS = 'payers', MASTER = 'master', PAYMENTS = 'payments';

  /* ── IndexedDB plumbing ── */
  /* Names every store the app relies on, so a database left incomplete by an
     earlier version can be detected and repaired rather than failing silently. */
  function requiredStores(){
    return [STORE, META, ORGS, PROVIDERS, PATIENTS, ENC, PAYERS, MASTER,
            CRED, HIST, CLAIMS, TASKS, APPTS, PAYMENTS];
  }

  let _dbCache = null;

  function openAt(version){
    return new Promise((res, rej) => {
      const r = version ? indexedDB.open(DB, version) : indexedDB.open(DB);
      r.onupgradeneeded = () => {
        const d = r.result;
        /* Every store is created idempotently, so a browser on any earlier
           version upgrades cleanly to the current one. */
        if(!d.objectStoreNames.contains(STORE)){
          const s = d.createObjectStore(STORE, { keyPath:'id', autoIncrement:true });
          s.createIndex('username','username',{ unique:true });
        }
        if(!d.objectStoreNames.contains(META))
          d.createObjectStore(META, { keyPath:'k' });

        [ORGS, PROVIDERS, PATIENTS, ENC, PAYERS, CRED, HIST, CLAIMS, TASKS, PAYMENTS].forEach(name => {
          if(!d.objectStoreNames.contains(name))
            d.createObjectStore(name, { keyPath:'id', autoIncrement:true });
        });

        if(!d.objectStoreNames.contains(MASTER)){
          const ms = d.createObjectStore(MASTER, { keyPath:'id', autoIncrement:true });
          ms.createIndex('set','set',{ unique:false });
        }
        if(!d.objectStoreNames.contains(APPTS)){
          const ap = d.createObjectStore(APPTS, { keyPath:'id', autoIncrement:true });
          ap.createIndex('date','date',{ unique:false });
        }
      };
      r.onsuccess = () => {
        const d = r.result;
        d.onversionchange = () => { d.close(); _dbCache = null; };
        res(d);
      };
      r.onerror = () => rej(r.error || new Error('Could not open the local database'));
      r.onblocked = () => rej(new Error(
        'Another ReviFlow tab is open with an older version. Close the other tabs and reload.'));
    });
  }

  async function idb(){
    if(_dbCache) return _dbCache;

    let d = await openAt(VER);

    /* A database can sit at the current version yet be missing stores if an
       earlier build's upgrade handler was faulty. Reads against a missing
       store throw, which looks exactly like lost data. Bump the version once
       to force the handler to run and create whatever is absent. */
    const missing = requiredStores().filter(n => !d.objectStoreNames.contains(n));
    if(missing.length){
      console.warn('ReviFlow: repairing the local database, missing stores →', missing.join(', '));
      const next = d.version + 1;
      d.close();
      d = await openAt(next);
      const still = requiredStores().filter(n => !d.objectStoreNames.contains(n));
      if(still.length)
        throw new Error('The local database could not be repaired. Missing: ' + still.join(', '));
      console.info('ReviFlow: database repaired. Your records were not touched.');
    }

    _dbCache = d;
    return d;
  }
  async function tx(store, mode, fn){
    const d = await idb();
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode), s = t.objectStore(store);
      let out;
      try{ out = fn(s); }catch(e){ rej(e); return; }
      t.oncomplete = () => res(out && out.result !== undefined ? out.result : out);
      t.onerror = () => rej(t.error);
    });
  }
  const all   = () => tx(STORE,'readonly',  s => s.getAll());
  const put   = v  => tx(STORE,'readwrite', s => s.put(v));
  const del   = id => tx(STORE,'readwrite', s => s.delete(id));
  const rows  = st => tx(st,'readonly',  s => s.getAll());
  const save_ = (st,v) => tx(st,'readwrite', s => s.put(v));
  const kill  = (st,id) => tx(st,'readwrite', s => s.delete(id));
  const meta  = async k => (await tx(META,'readonly', s => s.get(k)) || {}).v;
  const setMeta = (k,v) => tx(META,'readwrite', s => s.put({k, v}));

  /* ── password hashing: PBKDF2-SHA256, 150k rounds ── */
  const enc = new TextEncoder();
  const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2,'0')).join('');
  /* PBKDF2-HMAC-SHA256 at the OWASP-recommended work factor.
     Format: pbkdf2$<iterations>$<salt>$<hash>. The older salt:hash form
     still verifies, so accounts created before this change keep working
     and are quietly upgraded on the next successful sign-in. */
  const KDF_ROUNDS = 310000;

  async function derive(pw, salt, rounds){
    const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name:'PBKDF2', salt, iterations:rounds, hash:'SHA-256' }, key, 256);
    return hex(bits);
  }
  const unhex = h => Uint8Array.from(String(h).match(/../g).map(x => parseInt(x,16)));

  async function hashPassword(pw){
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const h = await derive(pw, salt, KDF_ROUNDS);
    return `pbkdf2$${KDF_ROUNDS}$${hex(salt)}$${h}`;
  }

  function timingSafeEqual(a, b){
    if(a.length !== b.length) return false;
    let diff = 0;
    for(let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }

  async function checkPassword(pw, stored){
    if(!stored) return false;
    try{
      if(stored.startsWith('pbkdf2$')){
        const [, rounds, salt, want] = stored.split('$');
        const got = await derive(pw, unhex(salt), parseInt(rounds,10));
        return timingSafeEqual(got, want);
      }
      /* legacy: salt:hash at 150k rounds */
      if(stored.includes(':')){
        const [salt, want] = stored.split(':');
        const got = await derive(pw, unhex(salt), 150000);
        return timingSafeEqual(got, want);
      }
    }catch(e){}
    return false;
  }
  const isLegacyHash = h => !!h && !String(h).startsWith('pbkdf2$');

  /* ── TOTP, Google Authenticator compatible ── */
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  function randomSecret(len=20){
    const b = crypto.getRandomValues(new Uint8Array(len));
    return [...b].map(x => B32[x % 32]).join('');
  }
  function b32decode(s){
    let bits = '';
    for(const c of String(s).toUpperCase().replace(/=+$/,'')){
      const i = B32.indexOf(c);
      if(i >= 0) bits += i.toString(2).padStart(5,'0');
    }
    const out = [];
    for(let i=0; i+8<=bits.length; i+=8) out.push(parseInt(bits.slice(i,i+8),2));
    return new Uint8Array(out);
  }
  async function totp(secret, step){
    const key = await crypto.subtle.importKey('raw', b32decode(secret),
      { name:'HMAC', hash:'SHA-1' }, false, ['sign']);
    const ctr = new ArrayBuffer(8), dv = new DataView(ctr);
    dv.setUint32(0, Math.floor(step / 0x100000000));
    dv.setUint32(4, step >>> 0);
    const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, ctr));
    const off = sig[sig.length-1] & 0x0f;
    const code = ((sig[off]&0x7f)<<24 | sig[off+1]<<16 | sig[off+2]<<8 | sig[off+3]) % 1000000;
    return String(code).padStart(6,'0');
  }
  async function verifyTotp(secret, code){
    const clean = String(code||'').replace(/\D/g,'');
    if(!secret || clean.length !== 6) return false;
    const now = Math.floor(Date.now()/1000/30);
    for(let w=-1; w<=1; w++) if(await totp(secret, now+w) === clean) return true;
    return false;
  }
  const otpauth = (user, secret, issuer='ReviFlow RCM') =>
    `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(user)}`
    + `?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

  /* ── seed: one temporary administrator, forced to change on first use ── */
  const TEMP_ADMIN = { username:'admin', password:'ReviFlow-Temp-2026' };
  async function seed(){
    if(await meta('seeded')) return;
    await put({
      username: TEMP_ADMIN.username,
      password_hash: await hashPassword(TEMP_ADMIN.password),
      role:'admin', full_name:'System Administrator',
      first_name:'System', last_name:'Administrator', title:'Platform Admin',
      initials:'SA', scope:'all', status:'active',
      must_change:true, mfa_enabled:false, mfa_secret:null,
      email:null, phone:null, provider_id:null,
      failed_attempts:0, locked_until:null, last_login:null,
      created_by:'seed', created_at:new Date().toISOString()
    });
    await setMeta('seeded', true);
    await setMeta('events', []);
    await setMeta('audit', []);
  }

  async function logEvent(username, event){
    const list = (await meta('events')) || [];
    list.unshift({ username, event, at:new Date().toISOString() });
    await setMeta('events', list.slice(0,500));
  }
  async function audit(actor, action, target, detail){
    const list = (await meta('audit')) || [];
    list.unshift({ actor, action, target, detail:detail||{}, at:new Date().toISOString() });
    await setMeta('audit', list.slice(0,300));
  }

  /* ── generated temporary password ── */
  function tempPassword(){
    const A='ABCDEFGHJKMNPQRSTUVWXYZ', a='abcdefghijkmnpqrstuvwxyz', n='23456789', s='!#$%&*+?';
    const r = k => k[crypto.getRandomValues(new Uint32Array(1))[0] % k.length];
    const out = [r(A),r(A),r(a),r(a),r(a),r(n),r(n),r(n),r(s),r(s)];
    for(let i=out.length-1;i>0;i--){
      const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i+1);
      [out[i],out[j]] = [out[j],out[i]];
    }
    return out.join('');
  }
  function suggestUsername(full){
    const n = splitName(full);
    const isDr = /^dr\.?\s/i.test(String(full||''));
    const base = (isDr ? 'dr.' : (n.first ? n.first[0].toLowerCase() + '.' : '')) + (n.last || '');
    return base.toLowerCase().replace(/[^a-z0-9._-]/g,'');
  }

  const round2 = n => Math.round((+n||0)*100)/100;

  const initialsOf = n => String(n||'').replace(/^Dr\.?\s+/i,'')
    .split(/\s+/).filter(Boolean).slice(0,2).map(w=>w[0]).join('').toUpperCase();

  /* "Dr. Bhavan Kalyan" -> {prefix:'Dr.', first:'Bhavan', last:'Kalyan'}
     Everything between the first and last word is treated as a middle name,
     and a trailing credential such as ", NP" is kept out of the surname. */
  function splitName(full){
    let raw = String(full||'').trim().replace(/\s+/g,' ');
    let suffix = '';
    const comma = raw.indexOf(',');
    if(comma > -1){ suffix = raw.slice(comma+1).trim(); raw = raw.slice(0,comma).trim(); }
    let prefix = '';
    const m = raw.match(/^(Dr\.?|Mr\.?|Mrs\.?|Ms\.?|Prof\.?)\s+/i);
    if(m){ prefix = m[1]; raw = raw.slice(m[0].length); }
    const parts = raw.split(' ').filter(Boolean);
    return {
      prefix, suffix,
      first: parts[0] || '',
      middle: parts.length > 2 ? parts.slice(1,-1).join(' ') : '',
      last: parts.length > 1 ? parts[parts.length-1] : ''
    };
  }

  /* "Dr. Bhavan Kalyan, MD" -> {prefix:'Dr.', first:'Bhavan', last:'Kalyan', suffix:'MD'} */
  function splitName(full){
    let raw = String(full||'').trim();
    let prefix='', suffix='';
    const pm = raw.match(/^(Dr\.?|Mr\.?|Mrs\.?|Ms\.?|Prof\.?)\s+/i);
    if(pm){ prefix = pm[1]; raw = raw.slice(pm[0].length).trim(); }
    const sm = raw.match(/,\s*(.+)$/);
    if(sm){ suffix = sm[1].trim(); raw = raw.slice(0, sm.index).trim(); }
    const parts = raw.split(/\s+/).filter(Boolean);
    return {
      prefix,
      first: parts[0] || '',
      last:  parts.length > 1 ? parts.slice(1).join(' ') : '',
      suffix
    };
  }

  /* ── session: owned by RFSession so every tab agrees ── */
  const SKEY = 'rf_session';
  const sessionPayload = a => {
    const n = splitName(a.full_name);
    return {
      id:a.id, username:a.username, role:a.role,
      name: a.display_name || a.full_name,
      first: a.first_name || n.first, last: a.last_name || n.last,
      title:a.title, initials:a.initials, pid:a.provider_id, scope:a.scope,
      org_id:a.org_id||null, provider_ref:a.provider_ref||null, at:Date.now()
    };
  };
  const setSession = a => {
    const p = sessionPayload(a);
    if(window.RFSession) window.RFSession.start(p);
    else { try{ localStorage.setItem(SKEY, JSON.stringify(p)); }catch(e){} }
    return p;
  };
  const getSession = () => {
    if(window.RFSession) return window.RFSession.get();
    try{ return JSON.parse(localStorage.getItem(SKEY) || 'null'); }catch(e){ return null; }
  };
  const clearSession = () => {
    try{
      const me = (window.RFSession ? RFSession.get() : null);
      if(me) logEvent(me.username, 'logout');
    }catch(e){}
    if(DRIVER === 'api'){
      /* let the server drop the cookie too; the local end is immediate */
      try{ fetch('/api/auth?action=logout', { method:'POST', credentials:'same-origin' }); }catch(e){}
    }
    if(window.RFSession) return window.RFSession.end('manual');
    try{ localStorage.removeItem(SKEY); }catch(e){}
  };

  /* ── remote driver: the same interface, served by Netlify Functions ── */
  async function apiCall(path, action, payload, method){
    const r = await fetch(`${path}?action=${action}`, {
      method: method||'POST', credentials:'same-origin',
      headers:{ 'Content-Type':'application/json' },
      body: payload ? JSON.stringify(payload) : undefined
    });
    let j = {}; try{ j = await r.json(); }catch{}
    return { ok:r.ok, status:r.status, body:j };
  }


  /* ═══ shared data ═══
     When DRIVER is 'api' these replace the browser database, so every user
     of the link sees the same records. The shapes returned are identical, so
     nothing above this layer changes. */
  async function dapi(kind, action, payload, id){
    const q = '/api/data?kind=' + kind + '&action=' + action + (id != null ? '&id=' + id : '');
    const r = await fetch(q, {
      method:'POST', credentials:'same-origin',
      headers:{ 'Content-Type':'application/json' },
      body: payload ? JSON.stringify(payload) : undefined
    });
    let j = {}; try{ j = await r.json(); }catch{}
    if(!r.ok) throw new Error(j.message || j.error || ('The server returned ' + r.status));
    return j;
  }
  const dList = (kind, filter) => dapi(kind,'list',{ filter: filter||{} }).then(j => j.records || []);
  const dSave = (kind, rec)    => dapi(kind,'save',{ record: rec });
  const dDel  = (kind, id)     => dapi(kind,'delete', null, id);

  /* ═══ public API ═══ */
  console.info('%cReviFlow build '+BUILD+' · accounts: '+
    (DRIVER==='api' ? 'shared (server)' : 'this browser only'),
    'color:#0A5C46;font-weight:700');

  window.RFStore = {
    BUILD,
    driver: DRIVER,
    tempAdmin: TEMP_ADMIN,
    randomSecret, otpauth, verifyTotp, tempPassword, initialsOf, splitName, suggestUsername,
    getSession, clearSession,

    async ready(){
      if(DRIVER==='local'){ await seed(); return; }
      /* remote: the cookie is the source of truth, so check it once per load */
      try{
        const r = await fetch('/api/auth?action=me', { credentials:'same-origin' });
        if(r.ok){
          const j = await r.json();
          if(j.account && window.RFSession && !window.RFSession.get())
            window.RFSession.start({ ...j.account, at:Date.now() });
        }else if(window.RFSession && window.RFSession.get()){
          window.RFSession.end('expired');
        }
      }catch(e){}
    },

    async list(){
      if(DRIVER==='api'){
        const r = await fetch('/api/admin/users?action=list',{credentials:'same-origin'});
        return (await r.json()).accounts || [];
      }
      const rows = await all();
      return rows.map(({password_hash, mfa_secret, ...rest}) => {
        if(!rest.first_name || !rest.last_name){
          const n = splitName(rest.full_name);
          rest.first_name = rest.first_name || n.first;
          rest.last_name  = rest.last_name  || n.last;
        }
        return rest;
      });
    },

    async find(username){
      const u = String(username||'').trim().toLowerCase();
      return (await all()).find(a => a.username.toLowerCase() === u) || null;
    },

    /* step 1 of sign-in */
    async login(username, password){
      if(DRIVER==='api'){
        const r = await apiCall('/api/auth','login',{username,password});
        /* the server sets an httpOnly cookie; mirror the identity locally
           so every tab can render the header without another round trip */
        if(r.body && r.body.ok && r.body.account && window.RFSession)
          window.RFSession.start({ ...r.body.account, at:Date.now() });
        return r.body;
      }
      await seed();
      const a = await this.find(username);
      if(!a){ await logEvent(username,'failed'); return { error:'unknown', message:'No account found for that username.' }; }
      if(a.status !== 'active') return { error:'disabled', message:'This account has been disabled. Contact your administrator.' };
      if(a.locked_until && new Date(a.locked_until) > new Date())
        return { error:'locked', message:'Too many attempts. Try again in a few minutes.' };

      if(!await checkPassword(password, a.password_hash)){
        a.failed_attempts = (a.failed_attempts||0) + 1;
        if(a.failed_attempts >= 5) a.locked_until = new Date(Date.now()+15*60000).toISOString();
        await put(a); await logEvent(a.username,'failed');
        return { error:'password', message: a.locked_until ? 'Too many attempts. Locked for 15 minutes.' : 'That password is not correct.' };
      }
      a.failed_attempts = 0; a.locked_until = null;
      /* quietly move an old hash up to the current work factor */
      if(isLegacyHash(a.password_hash)){
        try{ a.password_hash = await hashPassword(password); }catch(e){}
      }
      await put(a);

      if(a.must_change) return { mustChange:true, id:a.id, name:a.full_name, username:a.username };
      if(a.mfa_enabled && a.mfa_secret) return { mfaRequired:true, id:a.id, name:a.full_name };
      return this._finish(a);
    },

    /* forced password change, then MFA enrolment */
    async changePassword(id, newPassword){
      const a = (await all()).find(x => x.id === id);
      if(!a) return { error:'unknown' };
      if(String(newPassword).length < 10) return { error:'weak', message:'Use at least 10 characters.' };
      a.password_hash = await hashPassword(newPassword);
      a.must_change = false;
      a.mfa_secret = a.mfa_secret || randomSecret();
      await put(a);
      await audit(a.username,'change_password',a.username,{});
      return { ok:true, id:a.id, secret:a.mfa_secret, otpauth: otpauth(a.username, a.mfa_secret) };
    },

    async verifyMfa(id, code, enrol){
      if(DRIVER==='api'){
        const r = await apiCall('/api/auth','mfa',{challenge:id,code});
        if(r.body && r.body.ok && r.body.account && window.RFSession)
          window.RFSession.start({ ...r.body.account, at:Date.now() });
        return r.body;
      }
      const a = (await all()).find(x => x.id === id);
      if(!a) return { error:'unknown' };
      if(!await verifyTotp(a.mfa_secret, code))
        return { error:'code', message:'That code is not valid. Codes refresh every 30 seconds.' };
      if(enrol){ a.mfa_enabled = true; await put(a); }
      return this._finish(a);
    },

    async skipMfa(id){
      const a = (await all()).find(x => x.id === id);
      if(!a) return { error:'unknown' };
      return this._finish(a);
    },

    async _finish(a){
      a.last_login = new Date().toISOString();
      await put(a); await logEvent(a.username,'login');
      setSession(a);
      try{ await this.touchDevice(); }catch(e){}
      const n = splitName(a.full_name);
      return { ok:true, account:{ id:a.id, username:a.username, role:a.role, name:a.full_name,
               first:a.first_name||n.first, last:a.last_name||n.last,
               title:a.title, initials:a.initials, pid:a.provider_id, scope:a.scope } };
    },

    async create(data){
      if(DRIVER==='api') return (await apiCall('/api/admin/users','create',data)).body;
      await seed();
      const username = String(data.username||'').trim().toLowerCase();
      if(!username || !data.full_name || !data.role) return { error:'Username, full name and role are required' };
      if(!/^[a-z0-9._-]{3,40}$/.test(username)) return { error:'Username may use letters, numbers, dot, dash and underscore only' };
      if(await this.find(username)) return { error:'That username is already taken' };

      const pw = data.password || tempPassword();
      const secret = data.mfa_enabled ? randomSecret() : null;
      const me = getSession();
      const nm = splitName(data.full_name);
      const row = {
        username, password_hash: await hashPassword(pw),
        role: data.role, full_name: data.full_name,
        first_name: data.first_name || nm.first,
        last_name:  data.last_name  || nm.last,
        name_prefix: nm.prefix || null,
        name_suffix: nm.suffix || null,
        title: data.title||null,
        initials: data.initials || initialsOf(data.full_name),
        email: data.email||null, phone: data.phone||null,
        provider_id: data.provider_id||null,
        org_id: data.org_id || null,
        provider_ref: data.provider_ref || null,
        scope: data.scope || (data.role==='admin'?'all':data.role==='provider'?'self':'facility'),
        status:'active', must_change: data.must_change !== false,
        mfa_enabled:false, mfa_secret:secret,
        failed_attempts:0, locked_until:null, last_login:null,
        created_by: me ? me.username : 'system', created_at:new Date().toISOString()
      };
      const id = await put(row);
      await audit(me?me.username:'system','create_account',username,{ role:data.role });
      return { ok:true, account:{ id, username, role:data.role, full_name:data.full_name },
               tempPassword: data.password ? null : pw,
               mfa: secret ? { secret, otpauth: otpauth(username, secret) } : null };
    },

    splitName,

    /* a provider editing their own profile files a remark; the name of record is unchanged */

    /* admin accepts the requested name */
    async approveNameChange(id){
      const a = (await all()).find(x => x.id === id);
      if(!a || !a.pending_name) return { error:'Nothing pending' };
      const { first, last } = a.pending_name;
      a.first_name = first; a.last_name = last;
      a.full_name = [a.name_prefix, first, last].filter(Boolean).join(' ') +
                    (a.name_suffix ? ', ' + a.name_suffix : '');
      a.initials = initialsOf(first + ' ' + last);
      (a.remarks||[]).forEach(r => { if(r.type==='name_change' && r.status==='pending') r.status='approved'; });
      a.pending_name = null;
      await put(a);
      const me = getSession();
      await audit(me?me.username:'system','name_change_approved',a.username,{});
      return { ok:true, full_name:a.full_name };
    },

    async remarks(){
      const rows = await all();
      const out = [];
      rows.forEach(a => (a.remarks||[]).forEach(r => out.push({ ...r, account:a.username,
        account_name:a.full_name, id:a.id })));
      return out.sort((x,y) => new Date(y.at) - new Date(x.at));
    },

    async update(id, patch){
      if(DRIVER==='api') return (await apiCall('/api/admin/users','update',{id,...patch})).body;
      const a = (await all()).find(x => x.id === id);
      if(!a) return { error:'Not found' };
      Object.keys(patch).forEach(k => { if(patch[k] !== undefined && patch[k] !== null) a[k] = patch[k]; });
      await put(a);
      const me = getSession();
      await audit(me?me.username:'system','update_account',a.username,patch);
      return { ok:true };
    },

    async resetPassword(id, password){
      if(DRIVER==='api') return (await apiCall('/api/admin/users','reset-password',{id,password})).body;
      const a = (await all()).find(x => x.id === id);
      if(!a) return { error:'Not found' };
      const pw = password || tempPassword();
      a.password_hash = await hashPassword(pw);
      a.must_change = true; a.failed_attempts = 0; a.locked_until = null;
      await put(a);
      const me = getSession();
      await audit(me?me.username:'system','reset_password',a.username,{});
      return { ok:true, tempPassword:pw, username:a.username };
    },

    async remove(id){
      if(DRIVER==='api') return (await apiCall('/api/admin/users','delete',{id})).body;
      const rows = await all();
      const a = rows.find(x => x.id === id);
      if(!a) return { error:'Not found' };
      const me = getSession();
      if(me && a.username === me.username) return { error:'You cannot delete your own account' };
      if(a.role === 'admin' && rows.filter(x => x.role==='admin' && x.status==='active').length <= 1)
        return { error:'This is the last active administrator' };
      await del(id);
      await audit(me?me.username:'system','delete_account',a.username,{});
      return { ok:true };
    },

    /* a user editing their own name — recorded as a remark, name field untouched */
    async requestNameChange(id, first, last){
      const rows = await all();
      const a = rows.find(x => x.id === id);
      if(!a) return { error:'Not found' };
      const before = ((a.first_name||'')+' '+(a.last_name||'')).trim();
      const after  = ((first||'')+' '+(last||'')).trim();
      if(before === after) return { ok:true, unchanged:true };
      a.name_remarks = a.name_remarks || [];
      a.name_remarks.unshift({ from:before, to:after, at:new Date().toISOString(), by:a.username });
      a.first_name = first;
      a.last_name = last;
      a.display_name = ((a.name_prefix?a.name_prefix+' ':'')+after+(a.name_suffix?', '+a.name_suffix:'')).trim();
      await put(a);
      await audit(a.username,'name_change',a.username,{ from:before, to:after });
      const sess = getSession();
      if(sess && sess.id === id){ sess.name = a.display_name || after; sessionStorage.setItem(SKEY, JSON.stringify(sess)); }
      return { ok:true, from:before, to:after };
    },

    async get(id){
      const a = (await all()).find(x => x.id === id);
      if(!a) return null;
      const { password_hash, mfa_secret, ...rest } = a;
      return rest;
    },

    /* ═══ ORGANIZATIONS ═══ */
    async orgs(){
      if(DRIVER==='api') return dList('org');
 return (await rows(ORGS)).sort((a,b)=>a.name.localeCompare(b.name)); },
    async org(id){ return (await rows(ORGS)).find(o => o.id === id) || null; },
    async saveOrg(o){
      if(DRIVER==='api'){ try{ const j=await dSave('org',arguments[0]); return { ok:true, id:j.id, ...(j.record||{}) }; }catch(e){ return { error:String(e.message||e) }; } }

      try{
      const me = getSession();
      if(!o.name) return { error:'Organization name is required' };
      if(o.id === undefined || o.id === null || o.id === '') delete o.id;
      if(!o.id){
        o.created_at = new Date().toISOString();
        o.created_by = me ? me.username : 'system';
      }
      o.updated_at = new Date().toISOString();
      const id = await save_(ORGS, o);
      await audit(me?me.username:'system', o.id?'update_org':'create_org', o.name, {});
      return { ok:true, id: o.id || id };
      }catch(err){ return { error:'Save failed: '+(err && err.message || err) }; }
    },
    async removeOrg(id){
      const linked = (await rows(PROVIDERS)).filter(p => p.org_id === id);
      if(linked.length) return { error:`${linked.length} provider(s) are still attached to this organization.` };
      await kill(ORGS, id);
      const me = getSession();
      await audit(me?me.username:'system','delete_org',String(id),{});
      return { ok:true };
    },

    /* ═══ PROVIDERS ═══ */
    async providers(orgId){
      if(DRIVER==='api'){
        const all = await dList('provider');
        return orgId ? all.filter(x => String(x.org_id)===String(orgId)) : all;
      }
      const list = (await rows(PROVIDERS)).sort((a,b)=>
        (a.last_name||'').localeCompare(b.last_name||''));
      return orgId ? list.filter(p => p.org_id === orgId) : list;
    },
    async provider(id){ return (await rows(PROVIDERS)).find(p => p.id === id) || null; },
    async saveProvider(p){
      if(DRIVER==='api'){ try{ const j=await dSave('provider',arguments[0]); return { ok:true, id:j.id, ...(j.record||{}) }; }catch(e){ return { error:String(e.message||e) }; } }

      try{
      const me = getSession();
      if(!p.full_name) return { error:'Provider name is required' };
      if(p.id === undefined || p.id === null || p.id === '') delete p.id;
      if(!p.org_id)    return { error:'Select the organization this provider belongs to' };
      const n = splitName(p.full_name);
      p.first_name = p.first_name || n.first;
      p.last_name  = p.last_name  || n.last;
      p.name_prefix = n.prefix || null;
      p.initials = p.initials || initialsOf(p.full_name);
      if(!p.id){
        p.created_at = new Date().toISOString();
        p.created_by = me ? me.username : 'system';
        p.remarks = [];
        p.code = p.code || (n.first[0]||'X').toUpperCase() + (n.last[0]||'X').toUpperCase();
      }
      p.updated_at = new Date().toISOString();
      const id = await save_(PROVIDERS, p);
      await audit(me?me.username:'system', p.id?'update_provider':'create_provider', p.full_name, {});
      return { ok:true, id: p.id || id };
      }catch(err){ return { error:'Save failed: '+(err && err.message || err) }; }
    },
    async removeProvider(id){
      await kill(PROVIDERS, id);
      const me = getSession();
      await audit(me?me.username:'system','delete_provider',String(id),{});
      return { ok:true };
    },
    /* a provider editing their own record — recorded as a remark */
    async providerRemark(id, changes, by){
      const p = (await rows(PROVIDERS)).find(x => x.id === id);
      if(!p) return { error:'Not found' };
      p.remarks = p.remarks || [];
      p.remarks.unshift({ changes, by: by || 'provider', at: new Date().toISOString() });
      Object.keys(changes).forEach(k => { p[k] = changes[k].to; });
      p.updated_at = new Date().toISOString();
      await save_(PROVIDERS, p);
      return { ok:true };
    },
    /* which providers still have no login */
    async providersWithoutLogin(){
      const accts = await all();
      const ids = new Set(accts.map(a => a.provider_ref).filter(Boolean));
      return (await rows(PROVIDERS)).filter(p => !ids.has(p.id));
    },

    /* ═══ PATIENTS (shared by scheduling and the patient dashboard) ═══ */
    async patients(){
      if(DRIVER==='api') return dList('patient');
 return rows(PATIENTS); },
    async savePatient(pt){
      if(!pt.id){ pt.created_at = new Date().toISOString(); }
      const id = await save_(PATIENTS, pt);
      return { ok:true, id: pt.id || id };
    },

    /* ═══ ELIGIBILITY HISTORY — 24 hours, scoped to the signed-in user ═══ */
    async eligHistory(){
      const me = getSession();
      const key = 'elig:' + (me ? me.username : 'anon');
      const raw = (await meta(key)) || [];
      const cut = Date.now() - 86400000;
      const live = raw.filter(r => r.t > cut);
      if(live.length !== raw.length) await setMeta(key, live);
      return live;
    },
    async pushElig(entry){
      const me = getSession();
      const key = 'elig:' + (me ? me.username : 'anon');
      const raw = (await meta(key)) || [];
      const cut = Date.now() - 86400000;
      let list = raw.filter(r => r.t > cut && !(r.n === entry.n && r.d === entry.d));
      const id = 'e_' + Math.random().toString(36).slice(2,10) + Date.now().toString(36);
      list.unshift({ ...entry, id, t: Date.now() });
      await setMeta(key, list.slice(0,30));
      return { list, id };
    },
    /* the full 271 for one saved check */
    async eligResult(id){
      const list = await this.eligHistory();
      return list.find(r => r.id === id) || null;
    },
    async lastElig(){
      const list = await this.eligHistory();
      return list[0] || null;
    },

    /* ═══ APPOINTMENTS ═══ */
    async appts(date, providerIds){
      if(DRIVER==='api'){
        const filter = {};
        if(date) filter.date = date;
        const list = await dList('appt', filter);
        if(providerIds && providerIds.length){
          const set = new Set(providerIds.map(String));
          return list.filter(a => set.has(String(a.provider_id))).sort((a,b)=>a.start-b.start);
        }
        return list.sort((a,b)=>a.start-b.start);
      }
      let list = await rows(APPTS);
      if(date) list = list.filter(a => a.date === date);
      if(providerIds && providerIds.length){
        const set = new Set(providerIds.map(String));
        list = list.filter(a => set.has(String(a.provider_id)));
      }
      return list.sort((a,b) => a.start - b.start);
    },
    async appt(id){
      if(DRIVER==='api') return dapi('appt','get',null,id).then(j=>j.record).catch(()=>null);
      return (await rows(APPTS)).find(a => a.id === id) || null;
    },
    async saveAppt(a){
      if(DRIVER==='api'){
        try{
          if(!a.provider_id) return { error:'Choose a provider' };
          if(!a.date) return { error:'Choose a date' };
          if(a.start == null) return { error:'Choose a start time' };
          a.dur = +a.dur || 20;
          const existing = await dList('appt',{date:a.date});
          const clash = existing.find(x => String(x.provider_id)===String(a.provider_id) &&
            String(x.id)!==String(a.id||'') && a.start < (+x.start + +x.dur) &&
            +x.start < (+a.start + +a.dur));
          if(clash) return { error:`That overlaps ${clash.patient_last||'an existing appointment'}.` };
          const j=await dSave('appt',a);
          return {ok:true,id:j.id,...(j.record||{})};
        }catch(e){ return {error:String(e.message||e)}; }
      }
      try{
        if(a.id === undefined || a.id === null || a.id === '') delete a.id;
        if(!a.provider_id) return { error:'Choose a provider' };
        if(!a.date)        return { error:'Choose a date' };
        if(a.start == null) return { error:'Choose a start time' };
        a.dur = +a.dur || 20;

        /* refuse to double-book the same provider unless it is the same record */
        const clash = (await rows(APPTS)).find(x =>
          String(x.provider_id) === String(a.provider_id) &&
          x.date === a.date && x.id !== a.id &&
          a.start < (x.start + x.dur) && x.start < (a.start + a.dur));
        if(clash) return {
          error:`That overlaps ${clash.patient_last||'an existing appointment'} at ` +
                `${String(Math.floor(clash.start/60)).padStart(2,'0')}:${String(clash.start%60).padStart(2,'0')}.`
        };

        const me = getSession();
        if(!a.id){
          a.created_at = new Date().toISOString();
          a.created_by = me ? me.username : 'system';
          a.status = a.status || 'Scheduled';
        }
        a.updated_at = new Date().toISOString();
        const id = await save_(APPTS, a);
        return { ok:true, id: a.id || id };
      }catch(err){ return { error:'Save failed: '+(err && err.message || err) }; }
    },
    async removeAppt(id){
      if(DRIVER==='api'){
        try{ await dDel('appt',id); return {ok:true}; }catch(e){ return {error:String(e.message||e)}; }
      }
      try{
        const list = await rows(APPTS);
        const target = list.find(a => a.id === id);
        /* an attendee copy points at the organiser's row via linked_to */
        const rootId = (target && target.linked_to) || id;
        const doomed = list.filter(a => a.id === rootId || a.linked_to === rootId);

        /* An encounter exists only because an appointment did. Remove the
           empty ones with it; keep any that have been worked on, since a
           locked or coded encounter is clinical and billing evidence. */
        const encs = await rows(ENC);
        let encRemoved = 0, encKept = 0;
        for(const a of doomed){
          const linked = encs.filter(e => String(e.appt_id) === String(a.id));
          for(const e of linked){
            const worked = (e.lines || []).length > 0 || e.status === 'locked';
            if(worked){
              /* keep it, but cut the link and say why */
              e.appt_id = null;
              e.orphaned_at = new Date().toISOString();
              e.orphan_reason = 'The appointment was deleted after this encounter was started';
              await save_(ENC, e);
              encKept++;
            }else{
              await kill(ENC, e.id);
              encRemoved++;
            }
          }
        }

        for(const a of doomed) await kill(APPTS, a.id);
        return { ok:true, removed: doomed.length,
                 encountersRemoved: encRemoved, encountersKept: encKept };
      }catch(err){ return { error:String(err && err.message || err) }; }
    },

    /* keep attendee copies in step when the organiser edits a meeting */
    async syncMeeting(rootId, patch){
      if(DRIVER==='api'){
        try{
          const list=await dList('appt');
          const copies=list.filter(a=>a.linked_to===rootId);
          for(const c of copies) await dSave('appt',{...c,...patch,id:c.id,provider_id:c.provider_id,linked_to:rootId});
          return {ok:true,synced:copies.length};
        }catch(e){return {error:String(e.message||e)}}
      }
      try{
        const list = await rows(APPTS);
        const copies = list.filter(a => a.linked_to === rootId);
        for(const c of copies){
          Object.assign(c, patch, { id:c.id, provider_id:c.provider_id, linked_to:rootId });
          await save_(APPTS, c);
        }
        return { ok:true, synced: copies.length };
      }catch(err){ return { error:String(err && err.message || err) }; }
    },

    /* attendee copies that are no longer invited */
    async pruneMeeting(rootId, keepProviderIds){
      try{
        const keep = new Set((keepProviderIds||[]).map(String));
        const list = await rows(APPTS);
        const gone = list.filter(a => a.linked_to === rootId && !keep.has(String(a.provider_id)));
        for(const a of gone) await kill(APPTS, a.id);
        return { ok:true, removed: gone.length };
      }catch(err){ return { error:String(err && err.message || err) }; }
    },

    /* ═══ PER-USER PREFERENCES ═══ */
    async prefs(){
      const me = getSession();
      return (await meta('prefs:' + (me ? me.username : 'anon'))) || {};
    },
    async setPrefs(patch){
      const me = getSession();
      const key = 'prefs:' + (me ? me.username : 'anon');
      const cur = (await meta(key)) || {};
      const next = { ...cur, ...patch };
      await setMeta(key, next);
      return next;
    },

    /* ═══ DEVICES / ACTIVE SESSIONS ═══ */
    _deviceId(){
      let id = localStorage.getItem('rf_device');
      if(!id){
        id = 'dev_' + Math.random().toString(36).slice(2,10);
        localStorage.setItem('rf_device', id);
      }
      return id;
    },
    _describe(){
      const ua = navigator.userAgent;
      let os = 'Unknown device', br = 'Browser';
      if(/iPhone/.test(ua)) os = 'iPhone';
      else if(/iPad/.test(ua)) os = 'iPad';
      else if(/Android/.test(ua)) os = /Mobile/.test(ua) ? 'Android phone' : 'Android tablet';
      else if(/Macintosh/.test(ua)) os = 'Mac';
      else if(/Windows/.test(ua)) os = 'Windows PC';
      else if(/Linux/.test(ua)) os = 'Linux';
      if(/Edg\//.test(ua)) br = 'Edge';
      else if(/OPR\//.test(ua)) br = 'Opera';
      else if(/Chrome\//.test(ua)) br = 'Chrome';
      else if(/Firefox\//.test(ua)) br = 'Firefox';
      else if(/Safari\//.test(ua)) br = 'Safari';
      return { os, br, label: os + ' · ' + br };
    },
    async revokeDevice(id){
      const me = getSession();
      if(!me) return { error:'Not signed in' };
      const key = 'devices:' + me.username;
      const list = ((await meta(key)) || []).filter(d => d.id !== id);
      await setMeta(key, list);
      return { ok:true };
    },

    /* the signed-in user changing their own password */
    async selfPassword(current, next){
      const me = getSession();
      if(!me) return { error:'Not signed in' };
      const a = (await all()).find(x => x.id === me.id);
      if(!a) return { error:'Account not found' };
      if(!await checkPassword(current, a.password_hash))
        return { error:'current', message:'That current password is not correct.' };
      if(String(next).length < 10)
        return { error:'weak', message:'Use at least 10 characters.' };
      a.password_hash = await hashPassword(next);
      a.must_change = false;
      a.password_changed = new Date().toISOString();
      await put(a);
      await audit(a.username,'change_password',a.username,{ self:true });
      return { ok:true };
    },

    /* ═══ PER-USER SETTINGS ═══ */
    async settings(){
      const me = getSession();
      if(!me) return {};
      return (await meta('cfg:'+me.username)) || {};
    },
    async settingsFor(username){ return (await meta('cfg:'+username)) || {}; },
    async saveSettings(patch){
      const me = getSession();
      if(!me) return { error:'Not signed in' };
      const cur = (await meta('cfg:'+me.username)) || {};
      const next = { ...cur, ...patch, updated_at:new Date().toISOString() };
      await setMeta('cfg:'+me.username, next);
      return { ok:true, settings:next };
    },

    /* ═══ DEVICE SESSIONS ═══ */
    deviceLabel(){
      const ua = navigator.userAgent, p = navigator.platform || '';
      let device = 'Unknown device', browser = 'Browser';
      if(/iPhone/.test(ua)) device = 'iPhone';
      else if(/iPad/.test(ua)) device = 'iPad';
      else if(/Android/.test(ua)) device = /Mobile/.test(ua) ? 'Android phone' : 'Android tablet';
      else if(/Macintosh/.test(ua)) device = 'Mac';
      else if(/Windows/.test(ua)) device = 'Windows PC';
      else if(/Linux/.test(ua)) device = 'Linux PC';
      if(/Edg\//.test(ua)) browser = 'Edge';
      else if(/OPR\//.test(ua)) browser = 'Opera';
      else if(/Chrome\//.test(ua)) browser = 'Chrome';
      else if(/Firefox\//.test(ua)) browser = 'Firefox';
      else if(/Safari\//.test(ua)) browser = 'Safari';
      return { device, browser, label: device + ' · ' + browser, platform: p };
    },
    deviceId(){
      let id = localStorage.getItem('rf_device');
      if(!id){
        id = 'dev_' + Math.random().toString(36).slice(2,10) + Date.now().toString(36).slice(-4);
        localStorage.setItem('rf_device', id);
      }
      return id;
    },
    async touchDevice(){
      const me = getSession();
      if(!me) return;
      const key = 'dev:' + me.username;
      const list = (await meta(key)) || [];
      const id = this.deviceId(), info = this.deviceLabel();
      const now = new Date().toISOString();
      const found = list.find(d => d.id === id);
      if(found){ found.last_seen = now; found.label = info.label; }
      else list.unshift({ id, label:info.label, device:info.device, browser:info.browser,
                          first_seen:now, last_seen:now });
      /* drop anything untouched for a week */
      const cut = Date.now() - 7*86400000;
      await setMeta(key, list.filter(d => new Date(d.last_seen).getTime() > cut).slice(0,12));
    },
    async devices(){
      const me = getSession();
      if(!me) return [];
      const list = (await meta('dev:'+me.username)) || [];
      const id = this.deviceId();
      return list.map(d => ({ ...d, current: d.id === id }))
                 .sort((a,b) => (b.current?1:0)-(a.current?1:0) ||
                                new Date(b.last_seen)-new Date(a.last_seen));
    },
    async signOutDevice(id){
      const me = getSession();
      if(!me) return { error:'Not signed in' };
      const key = 'dev:'+me.username;
      const list = ((await meta(key)) || []).filter(d => d.id !== id);
      await setMeta(key, list);
      return { ok:true };
    },

    /* change your own password, checking the old one first */
    async changeOwnPassword(current, next){
      const me = getSession();
      if(!me) return { error:'Not signed in' };
      const a = (await all()).find(x => x.id === me.id);
      if(!a) return { error:'Account not found' };
      if(!await checkPassword(current, a.password_hash))
        return { error:'current', message:'That current password is not correct.' };
      if(String(next).length < 10)
        return { error:'weak', message:'Use at least 10 characters.' };
      a.password_hash = await hashPassword(next);
      a.must_change = false;
      await put(a);
      await audit(a.username,'change_password',a.username,{ self:true });
      return { ok:true };
    },

    /* ═══ BATCH ELIGIBILITY ═══ */
    async batches(){
      const me = getSession();
      const list = (await meta('batch:'+(me?me.username:'anon'))) || [];
      return list.sort((a,b) => new Date(b.created_at) - new Date(a.created_at));
    },
    async batch(id){ return (await this.batches()).find(b => b.id === id) || null; },
    async saveBatch(b){
      const me = getSession();
      const key = 'batch:'+(me?me.username:'anon');
      const list = (await meta(key)) || [];
      const i = list.findIndex(x => x.id === b.id);
      if(i > -1) list[i] = b; else list.unshift(b);
      await setMeta(key, list.slice(0,60));
      return { ok:true };
    },
    async removeBatch(id){
      const me = getSession();
      const key = 'batch:'+(me?me.username:'anon');
      const list = ((await meta(key)) || []).filter(b => b.id !== id);
      await setMeta(key, list);
      return { ok:true };
    },

    /* ═══ TASKS ═══ */

    /* who this account may assign work to */
    async assignable(){
      const me = getSession();
      if(!me) return [];
      const accts = await this.list();
      const orgId = me.org_id || null;
      return accts.filter(a => {
        if(a.username === me.username) return false;
        if(a.status !== 'active') return false;
        if(a.role === 'admin') return true;              /* admins are always reachable */
        if(!orgId) return false;
        return String(a.org_id) === String(orgId);       /* everyone else must share the facility */
      }).map(a => ({
        username:a.username, name:a.full_name, role:a.role,
        title:a.title || '', initials:a.initials || '', org_id:a.org_id || null
      })).sort((x,y) => x.role.localeCompare(y.role) || x.name.localeCompare(y.name));
    },


    /* everything this account is allowed to see, and in what capacity */
    async myTasks(){
      const me = getSession();
      if(!me) return [];
      const all = await rows(TASKS);
      return all.filter(t =>
          t.to === me.username ||
          t.from === me.username ||
          (t.cc || []).includes(me.username)
        ).map(t => ({
          ...t,
          _mine:   t.to === me.username,
          _sent:   t.from === me.username,
          _cc:     (t.cc || []).includes(me.username) && t.to !== me.username,
          _canEdit: t.to === me.username || t.from === me.username
        }))
        .sort((a,b) => new Date(b.created_at) - new Date(a.created_at));
    },


    async updateTask(id, patch, note){
      try{
        const me = getSession();
        const list = await rows(TASKS);
        const t = list.find(x => x.id === id);
        if(!t) return { error:'Task not found' };
        /* a CC recipient may look but not touch */
        if(t.to !== me.username && t.from !== me.username)
          return { error:'You are copied on this task and cannot change it' };

        const before = { status:t.status, priority:t.priority, to:t.to };
        Object.assign(t, patch);
        t.updated_at = new Date().toISOString();
        t.history = t.history || [];
        const bits = [];
        if(patch.status   && patch.status   !== before.status)   bits.push('status → ' + patch.status);
        if(patch.priority && patch.priority !== before.priority) bits.push('priority → ' + patch.priority);
        if(patch.to       && patch.to       !== before.to)       bits.push('reassigned to ' + (patch.to_name || patch.to));
        if(note) bits.push(note);
        if(bits.length) t.history.unshift({
          at:t.updated_at, by:me.username, by_name:me.name, what:bits.join(' · ')
        });
        await save_(TASKS, t);
        return { ok:true, task:t };
      }catch(err){ return { error:String(err && err.message || err) }; }
    },


    /* ═══ TASKS ═══
       Visible to the assignee, the person who raised it, and anyone in CC.
       Nobody else — so a task sent to an admin never surfaces for an employee. */
    async tasks(){
      if(DRIVER==='api'){
        const me = getSession();
        if(!me) return [];
        const list = await dList('task');
        return list.map(t => ({...t,
          _role: t.assignee===me.username ? 'assignee' : (t.created_by===me.username ? 'owner' : 'cc'),
          _readonly: t.assignee!==me.username && t.created_by!==me.username
        })).sort((a,b)=>new Date(b.created_at||0)-new Date(a.created_at||0));
      }
      const me = getSession();
      if(!me) return [];
      const u = me.username;
      return (await rows(TASKS))
        .filter(t => t.assignee === u || t.created_by === u || (t.cc||[]).indexOf(u) > -1)
        .map(t => ({
          ...t,
          _role: t.assignee === u ? 'assignee' : (t.created_by === u ? 'owner' : 'cc'),
          _readonly: t.assignee !== u && t.created_by !== u
        }))
        .sort((a,b) => new Date(b.created_at) - new Date(a.created_at));
    },
    async task(id){
      const me = getSession();
      const t = (await rows(TASKS)).find(x => x.id === id);
      if(!t || !me) return null;
      const u = me.username;
      if(t.assignee !== u && t.created_by !== u && (t.cc||[]).indexOf(u) < 0) return null;
      return { ...t, _readonly: t.assignee !== u && t.created_by !== u };
    },

    /* who this account may assign work to */
    async assignableTo(){
      const me = getSession();
      if(!me) return [];
      const accts = await all();
      const provs = await rows(PROVIDERS);
      const myOrg = me.org_id ||
        (provs.find(p => p.id === me.provider_ref) || {}).org_id || null;

      return accts
        .filter(a => a.status === 'active' && a.username !== me.username)
        /* admins are platform-wide; everyone else must share the facility */
        .filter(a => a.role === 'admin' || !myOrg || !a.org_id || a.org_id === myOrg)
        .map(a => ({
          username: a.username, name: a.full_name, role: a.role,
          title: a.title || '', org_id: a.org_id || null,
          initials: a.initials || initialsOf(a.full_name)
        }))
        .sort((a,b) => a.role.localeCompare(b.role) || a.name.localeCompare(b.name));
    },

    async saveTask(t){
      if(DRIVER==='api'){
        try{
          const me=getSession();
          if(!me) return {error:'Not signed in'};
          if(!t.title) return {error:'Give the task a name'};
          if(!t.assignee) return {error:'Choose who the task is for'};
          if(!t.id){
            t.created_at=new Date().toISOString(); t.created_by=me.username;
            t.from_name=me.name||me.username; t.status=t.status||'open';
            t.history=[{at:t.created_at,by:me.username,what:'created',
              detail:'Assigned to '+(t.assignee_name||t.assignee)}];
            t.ref=t.ref||('TSK-'+Math.floor(4000+Math.random()*5999));
          }
          t.updated_at=new Date().toISOString();
          const j=await dSave('task',t); return {ok:true,id:j.id,ref:(j.record||{}).ref};
        }catch(e){return {error:String(e.message||e)}}
      }
      try{
        const me = getSession();
        if(!me) return { error:'Not signed in' };
        if(t.id === undefined || t.id === null || t.id === '') delete t.id;
        if(!t.title)    return { error:'Give the task a name' };
        if(!t.assignee) return { error:'Choose who the task is for' };

        if(!t.id){
          t.created_at = new Date().toISOString();
          t.created_by = me.username;
          t.from_name  = me.name || me.username;
          t.status     = t.status || 'open';
          t.history    = [{ at:t.created_at, by:me.username, what:'created',
                            detail:'Assigned to '+(t.assignee_name||t.assignee) }];
          t.ref        = 'TSK-' + Math.floor(4000 + Math.random()*5999);
        }else{
          const prev = (await rows(TASKS)).find(x => x.id === t.id);
          if(prev){
            /* CC may never write */
            if(prev.assignee !== me.username && prev.created_by !== me.username)
              return { error:'You have view-only access to this task' };
            t.history = prev.history || [];
            const changes = [];
            if(prev.status   !== t.status)   changes.push('status → '+t.status);
            if(prev.priority !== t.priority) changes.push('priority → '+t.priority);
            if(prev.assignee !== t.assignee) changes.push('reassigned to '+(t.assignee_name||t.assignee));
            if(changes.length)
              t.history = [{ at:new Date().toISOString(), by:me.username,
                             what:'updated', detail:changes.join(' · ') }].concat(t.history);
          }
        }
        t.updated_at = new Date().toISOString();
        const id = await save_(TASKS, t);
        return { ok:true, id: t.id || id, ref:t.ref };
      }catch(err){ return { error:'Save failed: '+(err && err.message || err) }; }
    },

    async addTaskNote(id, text){
      if(DRIVER==='api'){
        try{
          const me=getSession(), j=await dapi('task','get',null,id);
          const t=j.record;
          if(!t||!me) return {error:'Not found'};
          if(t.assignee!==me.username && t.created_by!==me.username) return {error:'You have view-only access to this task'};
          t.history=[{at:new Date().toISOString(),by:me.username,what:'note',detail:text}].concat(t.history||[]);
          t.updated_at=new Date().toISOString(); await dSave('task',t); return {ok:true};
        }catch(e){return {error:String(e.message||e)}}
      }
      const me = getSession();
      const t = (await rows(TASKS)).find(x => x.id === id);
      if(!t || !me) return { error:'Not found' };
      if(t.assignee !== me.username && t.created_by !== me.username)
        return { error:'You have view-only access to this task' };
      t.history = [{ at:new Date().toISOString(), by:me.username,
                     what:'note', detail:text }].concat(t.history || []);
      t.updated_at = new Date().toISOString();
      await save_(TASKS, t);
      return { ok:true };
    },

    async removeTask(id){
      if(DRIVER==='api'){
        try{ await dDel('task',id); return {ok:true}; }catch(e){return {error:String(e.message||e)}}
      }
      const me = getSession();
      const t = (await rows(TASKS)).find(x => x.id === id);
      if(!t) return { error:'Not found' };
      if(t.created_by !== me.username) return { error:'Only the person who raised it can delete a task' };
      await kill(TASKS, id);
      return { ok:true };
    },

    /* ═══ CLAIMS ═══ */
    /* ═══ CLAIMS ═══ */
    async claims(filter){
      let list = await rows(CLAIMS);
      if(filter && filter.patient_ref) list = list.filter(c => c.patient_ref === filter.patient_ref);
      if(filter && filter.appt_id)     list = list.filter(c => c.appt_id === filter.appt_id);
      if(filter && filter.org_id)      list = list.filter(c => c.org_id === filter.org_id);
      if(filter && filter.provider_id)
        list = list.filter(c => String(c.provider_id) === String(filter.provider_id));
      return list.sort((a,b) => new Date(b.created_at) - new Date(a.created_at));
    },
    async claim(id){ return (await rows(CLAIMS)).find(c => c.id === id) || null; },
    async claimForAppt(apptId){
      return (await rows(CLAIMS)).find(c => String(c.appt_id) === String(apptId)) || null;
    },
    async saveClaim(c){
      if(DRIVER==='api'){ try{ const j=await dSave('claim',arguments[0]); return { ok:true, id:j.id, ...(j.record||{}) }; }catch(e){ return { error:String(e.message||e) }; } }

      try{
        const me = getSession();
        if(c.id === undefined || c.id === null || c.id === '') delete c.id;
        if(!c.patient_ref && !c.patient_last) return { error:'The claim needs a patient' };
        if(!c.lines || !c.lines.length)       return { error:'Add at least one service line' };

        if(!c.id){
          c.created_at = new Date().toISOString();
          c.created_by = me ? me.username : 'system';
          c.created_name = me ? (me.name || me.username) : 'System';
          c.claim_no = 'CLM' + Math.floor(900000 + Math.random()*99999);
          c.status = c.status || 'submitted';
          c.history = [{ at:c.created_at, by:c.created_by, what:'created',
                         detail:'Claim built and submitted' }];
        }
        c.total = (c.lines || []).reduce((sum,l) => sum + (Number(l.charge)||0) * (Number(l.units)||1), 0);
        c.updated_at = new Date().toISOString();
        const id = await save_(CLAIMS, c);
        return { ok:true, id: c.id || id, claim_no: c.claim_no };
      }catch(err){ return { error:'Save failed: '+(err && err.message || err) }; }
    },
    async setClaimStatus(id, status, note){
      const c = (await rows(CLAIMS)).find(x => x.id === id);
      if(!c) return { error:'Not found' };
      const me = getSession();
      c.status = status;
      c.history = [{ at:new Date().toISOString(), by:me?me.username:'system',
                     what:'status', detail:status + (note?' — '+note:'') }].concat(c.history||[]);
      c.updated_at = new Date().toISOString();
      await save_(CLAIMS, c);
      return { ok:true };
    },
    async removeClaim(id){
      if(DRIVER==='api'){ try{ await dDel('claim',id); return { ok:true }; }catch(e){ return { error:String(e.message||e) }; } }
 await kill(CLAIMS, id); return { ok:true }; },

    /* every appointment for one patient, newest first */
    async apptsForPatient(ref, last, first, memberId){
      const list = await rows(APPTS);
      const L = String(last||'').trim().toLowerCase();
      const F = String(first||'').trim().toLowerCase();
      const M = String(memberId||'').trim().toUpperCase();
      return list.filter(a => {
        if((a.block_type||'patient') !== 'patient') return false;
        /* a direct reference always wins */
        if(ref && String(a.patient_ref) === String(ref)) return true;
        /* otherwise fall back to the name or member id booked on the slot */
        if(M && String(a.member_id||'').toUpperCase() === M) return true;
        if(L && String(a.patient_last||'').toLowerCase() === L){
          const af = String(a.patient_first||'').toLowerCase();
          if(!F || !af || af === F) return true;
        }
        return false;
      }).sort((a,b) => (b.date+String(b.start).padStart(4,'0'))
                       .localeCompare(a.date+String(a.start).padStart(4,'0')));
    },

    /* Has this person been seen? A locked encounter is the reliable signal —
       a chart can exist for someone who never attended. */
    async patientStanding(ref){
      if(!ref) return { exists:false, seen:false, encounters:0, locked:0 };
      const p = await this.patient(ref);
      if(!p) return { exists:false, seen:false, encounters:0, locked:0 };
      const encs = (await rows(ENC)).filter(e => String(e.patient_ref) === String(ref));
      const locked = encs.filter(e => e.status === 'locked');
      return {
        exists: true,
        seen: locked.length > 0,
        encounters: encs.length,
        locked: locked.length,
        lastSeen: locked.map(e => e.dos).sort().pop() || null,
        patient: p
      };
    },

    /* ═══ PAYMENTS ═══
       Two kinds arrive: a remittance from a payer, which posts against the
       encounters it names, and a payment taken from a patient at the desk. */
    async payments(filter){
      if(DRIVER==='api'){
        return dList('payment', filter||{}).then(list =>
          list.sort((a,b)=>String(b.at||'').localeCompare(String(a.at||''))));
      }
      let list = await rows(PAYMENTS);
      const f = filter || {};
      if(f.patient_ref != null)
        list = list.filter(p => String(p.patient_ref) === String(f.patient_ref));
      if(f.kind) list = list.filter(p => p.kind === f.kind);
      if(f.from) list = list.filter(p => String(p.at||'').slice(0,10) >= f.from);
      if(f.to)   list = list.filter(p => String(p.at||'').slice(0,10) <= f.to);
      return list.sort((a,b) => String(b.at||'').localeCompare(String(a.at||'')));
    },

    async savePayment(p){
      if(DRIVER==='api'){
        try{
          const me=getSession();
          if(p.id==='' || p.id===null) delete p.id;
          if(!p.amount && p.amount!==0) return {error:'An amount is required'};
          if(!p.id){p.at=p.at||new Date().toISOString();p.taken_by=me?(me.name||me.username):'system';}
          const j=await dSave('payment',p); return {ok:true,id:j.id,...(j.record||{})};
        }catch(e){return {error:String(e.message||e)}}
      }
      try{
        if(p.id === undefined || p.id === null || p.id === '') delete p.id;
        const me = getSession();
        if(!p.id){
          p.at = p.at || new Date().toISOString();
          p.taken_by = me ? (me.name || me.username) : 'system';
        }
        if(!p.amount && p.amount !== 0) return { error:'An amount is required' };
        const id = await save_(PAYMENTS, p);
        return { ok:true, id: p.id || id };
      }catch(err){ return { error:'Save failed: '+(err && err.message || err) }; }
    },

    /* Post a payment against an encounter's billing, so the chart and the
       payments screen never disagree about what is outstanding. */
    async postToEncounter(encId, patch, note){
      if(DRIVER==='api'){
        try{
          const j=await dapi('encounter','get',null,encId); const e=j.record;
          if(!e) return {error:'That encounter no longer exists'};
          e.billing=e.billing||{};
          if(patch.ins_paid!=null) e.billing.ins_paid=round2((+e.billing.ins_paid||0)+ +patch.ins_paid);
          if(patch.pat_paid!=null) e.billing.pat_paid=round2((+e.billing.pat_paid||0)+ +patch.pat_paid);
          if(patch.writeoff!=null) e.billing.writeoff=round2((+e.billing.writeoff||0)+ +patch.writeoff);
          if(patch.pat_resp!=null) e.billing.pat_resp=+patch.pat_resp;
          e.billing.last_posted=new Date().toISOString();
          if(note) e.billing.notes=(e.billing.notes||[]).concat([{at:new Date().toISOString(),note}]);
          const saved=await dSave('encounter',e); return {ok:true,encounter:saved.record||e};
        }catch(e){return {error:String(e.message||e)}}
      }
      const e = (await rows(ENC)).find(x => String(x.id) === String(encId));
      if(!e) return { error:'That encounter no longer exists' };
      e.billing = e.billing || {};
      if(patch.ins_paid   != null) e.billing.ins_paid   = round2((+e.billing.ins_paid||0) + +patch.ins_paid);
      if(patch.pat_paid   != null) e.billing.pat_paid   = round2((+e.billing.pat_paid||0) + +patch.pat_paid);
      if(patch.writeoff   != null) e.billing.writeoff   = round2((+e.billing.writeoff||0) + +patch.writeoff);
      if(patch.pat_resp   != null) e.billing.pat_resp   = +patch.pat_resp;
      e.billing.last_posted = new Date().toISOString();
      if(note){
        e.billing.notes = (e.billing.notes || []);
        e.billing.notes.push({ at:new Date().toISOString(), note });
      }
      await save_(ENC, e);
      return { ok:true, encounter:e };
    },

    /* What a patient still owes, encounter by encounter. The same arithmetic
       the chart uses, so the two can never drift. */
    async patientBalances(ref){
      if(DRIVER==='api'){
        const encs=(await dList('encounter',{patient_ref:ref})).filter(e=>e.status==='locked');
        const pt=await this.patient(ref);
        const ins=((pt&&pt.insurances)||[]).find(x=>x.rank==='1');
        return encs.map(e=>{
          const fee=(e.lines||[]).reduce((x,l)=>x+(+l.fee||0)*(+l.units||1),0);
          const b=e.billing||{}, resp=b.resp||(ins?'ins':'self'), copay=ins?(+ins.copay||0):0;
          const patResp=b.pat_resp!=null?+b.pat_resp:(resp==='self'?fee:copay);
          const wo=+b.writeoff||0, patPaid=+b.pat_paid||0, insPaid=+b.ins_paid||0;
          const insResp=Math.max(0,fee-patResp-wo);
          return {enc_id:e.id,dos:e.dos,fee,patResp,patPaid:patPaid,wo,insPaid,insResp,
            patBal:round2(Math.max(0,patResp-patPaid)),insBal:round2(Math.max(0,insResp-insPaid)),lines:e.lines||[]};
        }).sort((a,b)=>String(b.dos||'').localeCompare(String(a.dos||'')));
      }
      const encs = (await rows(ENC))
        .filter(e => String(e.patient_ref) === String(ref) && e.status === 'locked');
      const pt = (await rows(PATIENTS)).find(x => String(x.id) === String(ref));
      const ins = ((pt && pt.insurances) || []).find(x => x.rank === '1');

      return encs.map(e => {
        const fee = (e.lines||[]).reduce((x,l) => x + (+l.fee||0)*(+l.units||1), 0);
        const b = e.billing || {};
        const resp = b.resp || (ins ? 'ins' : 'self');
        const copay = ins ? (+ins.copay||0) : 0;
        const patResp = b.pat_resp != null ? +b.pat_resp : (resp === 'self' ? fee : copay);
        const wo = +b.writeoff||0, patPaid = +b.pat_paid||0, insPaid = +b.ins_paid||0;
        const insResp = Math.max(0, fee - patResp - wo);
        return {
          enc_id:e.id, dos:e.dos, fee, patResp, patPaid, wo, insPaid, insResp,
          patBal: round2(Math.max(0, patResp - patPaid)),
          insBal: round2(Math.max(0, insResp - insPaid)),
          lines: e.lines || []
        };
      }).sort((a,b) => String(b.dos||'').localeCompare(String(a.dos||'')));
    },

    /* Everyone who owes something, for the payments screen. */
    async outstandingPatients(){
      if(DRIVER==='api'){
        const pts=await dList('patient'), encs=(await dList('encounter')).filter(e=>e.status==='locked');
        const out=[];
        for(const pt of pts){
          const mine=encs.filter(e=>String(e.patient_ref)===String(pt.id));
          if(!mine.length) continue;
          const ins=(pt.insurances||[]).find(x=>x.rank==='1');
          let patBal=0,insBal=0,oldest=null;
          mine.forEach(e=>{
            const fee=(e.lines||[]).reduce((x,l)=>x+(+l.fee||0)*(+l.units||1),0), b=e.billing||{};
            const resp=b.resp||(ins?'ins':'self'), copay=ins?(+ins.copay||0):0;
            const patResp=b.pat_resp!=null?+b.pat_resp:(resp==='self'?fee:copay);
            const wo=+b.writeoff||0;
            const pb=Math.max(0,patResp-(+b.pat_paid||0)), ib=Math.max(0,fee-patResp-wo-(+b.ins_paid||0));
            patBal+=pb; insBal+=ib; if(pb>0&&(!oldest||String(e.dos||'')<oldest)) oldest=e.dos;
          });
          if(patBal>0.004||insBal>0.004) out.push({patient_ref:pt.id,name:[pt.last_name,pt.first_name].filter(Boolean).join(', '),
            internal_id:pt.internal_id,phone:pt.phone,email:pt.email,payer:ins?ins.name:'Self pay',
            patBal:round2(patBal),insBal:round2(insBal),oldest});
        }
        return out.sort((a,b)=>b.patBal-a.patBal);
      }
      const pts = await rows(PATIENTS);
      const encs = (await rows(ENC)).filter(e => e.status === 'locked');
      const byPt = {};
      encs.forEach(e => { (byPt[String(e.patient_ref)] = byPt[String(e.patient_ref)] || []).push(e); });

      const out = [];
      for(const pt of pts){
        const mine = byPt[String(pt.id)];
        if(!mine || !mine.length) continue;
        const ins = (pt.insurances||[]).find(x => x.rank === '1');
        let patBal = 0, insBal = 0, oldest = null;
        mine.forEach(e => {
          const fee = (e.lines||[]).reduce((x,l) => x + (+l.fee||0)*(+l.units||1), 0);
          const b = e.billing || {};
          const resp = b.resp || (ins ? 'ins' : 'self');
          const copay = ins ? (+ins.copay||0) : 0;
          const patResp = b.pat_resp != null ? +b.pat_resp : (resp === 'self' ? fee : copay);
          const wo = +b.writeoff||0;
          const pb = Math.max(0, patResp - (+b.pat_paid||0));
          const ib = Math.max(0, fee - patResp - wo - (+b.ins_paid||0));
          patBal += pb; insBal += ib;
          if(pb > 0 && (!oldest || String(e.dos||'') < oldest)) oldest = e.dos;
        });
        if(patBal > 0.004 || insBal > 0.004){
          out.push({
            patient_ref: pt.id,
            name: [pt.last_name, pt.first_name].filter(Boolean).join(', '),
            internal_id: pt.internal_id, phone: pt.phone, email: pt.email,
            payer: ins ? ins.name : 'Self pay',
            patBal: round2(patBal), insBal: round2(insBal), oldest
          });
        }
      }
      return out.sort((a,b) => b.patBal - a.patBal);
    },

    /* ═══ PATIENT DEMOGRAPHICS ═══ */
    async patient(ref){
      if(DRIVER==='api') return dapi('patient','get',null,ref).then(j=>j.record).catch(()=>null);

      const list = await rows(PATIENTS);
      return list.find(p => String(p.id) === String(ref)) || null;
    },
    async findPatient({ ref, memberId, last, first }){
      const list = await rows(PATIENTS);
      if(ref){ const a = list.find(p => String(p.id) === String(ref)); if(a) return a; }
      if(memberId){
        const M = String(memberId).toUpperCase();
        const b = list.find(p => String(p.member_id||'').toUpperCase() === M ||
                                 String(p.internal_id||'').toUpperCase() === M);
        if(b) return b;
      }
      if(last){
        const L = String(last).toLowerCase(), F = String(first||'').toLowerCase();
        const c = list.find(p => String(p.last_name||'').toLowerCase() === L &&
                                 (!F || String(p.first_name||'').toLowerCase() === F));
        if(c) return c;
      }
      return null;
    },
    async savePatientRec(p){
      if(DRIVER==='api'){
        try{ const j=await dSave('patient',p); return { ok:true, id:j.id, internal_id:(j.record||{}).internal_id }; }
        catch(e){ return { error:String(e.message||e) }; }
      }
      try{
        if(p.id === undefined || p.id === null || p.id === '') delete p.id;
        if(!p.last_name) return { error:'Last name is required' };

        /* an edit must not drop fields the editing screen never loaded */
        if(p.id){
          const prev = (await rows(PATIENTS)).find(x => x.id === p.id);
          if(prev) p = { ...prev, ...p, id: prev.id };
        }
        if(!p.id){
          p.created_at = new Date().toISOString();
          p.internal_id = p.internal_id ||
            (String(p.last_name).slice(0,3) + String(p.first_name||'XX').slice(0,3)).toUpperCase() +
            String(Math.floor(10 + Math.random()*89));
          p.insurances = p.insurances || [];
          p.status = p.status || 'active';
        }
        p.updated_at = new Date().toISOString();
        const id = await save_(PATIENTS, p);
        return { ok:true, id: p.id || id, internal_id:p.internal_id };
      }catch(err){ return { error:'Save failed: '+(err && err.message || err) }; }
    },

    /* ═══ ENCOUNTERS ═══ */
    async encounters(patientRef){
      if(DRIVER==='api') return dList('encounter',{ patient_ref:patientRef });
      const list = await rows(ENC);
      return list.filter(e => String(e.patient_ref) === String(patientRef))
                 .sort((a,b) => (b.dos||'').localeCompare(a.dos||''));
    },
    async encounter(id){ return (await rows(ENC)).find(e => e.id === id) || null; },
    async encounterForAppt(apptId){
      return (await rows(ENC)).find(e => String(e.appt_id) === String(apptId)) || null;
    },
    async saveEncounter(e){
      if(DRIVER==='api'){ try{ const j=await dSave('encounter',arguments[0]); return { ok:true, id:j.id, ...(j.record||{}) }; }catch(e){ return { error:String(e.message||e) }; } }

      try{
        if(e.id === undefined || e.id === null || e.id === '') delete e.id;
        const me = getSession();
        if(!e.id){
          e.created_at = new Date().toISOString();
          e.created_by = me ? me.username : 'system';
          e.status = e.status || 'open';
          e.lines = e.lines || [];
        }
        e.updated_at = new Date().toISOString();
        const id = await save_(ENC, e);
        return { ok:true, id: e.id || id };
      }catch(err){ return { error:'Save failed: '+(err && err.message || err) }; }
    },
    async removeEncounter(id){
      if(DRIVER==='api'){ try{ await dDel('encounter',id); return { ok:true }; }catch(e){ return { error:String(e.message||e) }; } }
 await kill(ENC, id); return { ok:true }; },

    /* ═══ ACTIVITY HISTORY ═══ */
    async history(patientRef){
      if(DRIVER==='api') return dList('history',{patient_ref:patientRef}).then(list =>
        list.sort((a,b)=>new Date(b.at||0)-new Date(a.at||0)));
      const list = await rows(HIST);
      return list.filter(h => !patientRef || String(h.patient_ref) === String(patientRef))
                 .sort((a,b) => new Date(b.at) - new Date(a.at));
    },
    async logHistory(patientRef, what, detail, extra){
      if(DRIVER==='api'){
        try{
          const me=getSession();
          await dSave('history',{patient_ref:patientRef,what,detail:detail||'',
            by:me?(me.name||me.username):'system',username:me?me.username:'system',
            at:new Date().toISOString(),...(extra||{})});
        }catch(e){}
        return;
      }
      try{
        const me = getSession();
        await save_(HIST, {
          patient_ref: patientRef, what, detail: detail || '',
          by: me ? (me.name || me.username) : 'system',
          username: me ? me.username : 'system',
          at: new Date().toISOString(),
          ...(extra || {})
        });
      }catch(e){}
    },

    /* ═══ CREDENTIALING ═══
       One record per provider, holding their identifiers and a payer
       enrolment for each plan they are being credentialed with. */
    async credentialing(providerRef){
      if(DRIVER==='api'){
        const list=await dList('credentialing');
        return providerRef==null ? list : (list.find(c=>String(c.provider_ref)===String(providerRef))||null);
      }
      const list = await rows(CRED);
      if(providerRef == null) return list;
      return list.find(c => String(c.provider_ref) === String(providerRef)) || null;
    },
    async saveCredentialing(rec){
      if(DRIVER==='api'){
        try{
          if(!rec.provider_ref) return {error:'A provider is required'};
          const me=getSession();
          if(!rec.id){rec.created_at=new Date().toISOString();rec.created_by=me?me.username:'system';rec.enrollments=rec.enrollments||[];rec.log=rec.log||[];}
          rec.updated_at=new Date().toISOString();
          const j=await dSave('credentialing',rec); return {ok:true,id:j.id,...(j.record||{})};
        }catch(e){return {error:String(e.message||e)}}
      }
      try{
        if(rec.id === undefined || rec.id === null || rec.id === '') delete rec.id;
        if(!rec.provider_ref) return { error:'A provider is required' };
        const me = getSession();
        if(!rec.id){
          rec.created_at = new Date().toISOString();
          rec.created_by = me ? me.username : 'system';
          rec.enrollments = rec.enrollments || [];
          rec.log = rec.log || [];
        }
        rec.updated_at = new Date().toISOString();
        const id = await save_(CRED, rec);
        return { ok:true, id: rec.id || id };
      }catch(err){ return { error:'Save failed: '+(err && err.message || err) }; }
    },
    async logCredentialing(providerRef, what, detail){
      if(DRIVER==='api'){
        try{
          const rec=await this.credentialing(providerRef);
          if(!rec) return {error:'Not found'};
          const me=getSession();
          rec.log=[{at:new Date().toISOString(),by:me?(me.name||me.username):'system',what,detail:detail||''}].concat(rec.log||[]);
          await dSave('credentialing',rec); return {ok:true};
        }catch(e){return {error:String(e.message||e)}}
      }
      const rec = await this.credentialing(providerRef);
      if(!rec) return { error:'Not found' };
      const me = getSession();
      rec.log = [{ at:new Date().toISOString(), by: me ? (me.name||me.username) : 'system',
                   what, detail: detail || '' }].concat(rec.log || []);
      await save_(CRED, rec);
      return { ok:true };
    },
    /* create an empty record from the provider's own file the first time */
    async ensureCredentialing(provider){
      let rec = await this.credentialing(provider.id);
      if(rec) return rec;
      const r = await this.saveCredentialing({
        provider_ref: provider.id,
        org_id: provider.org_id || null,
        caqh_id: provider.caqh || '',
        npi: provider.npi || '',
        license_no: provider.license || '',
        license_state: provider.state || '',
        dea: provider.dea || '',
        taxonomy: provider.taxonomy || '',
        enrollments: [], log: []
      });
      return await this.credentialing(provider.id);
    },

    /* ═══ PAYERS ═══
       One list, referenced by eligibility, credentialing, claims and charts. */
    async payers(){
      if(DRIVER==='api') return dList('payer');

      return (await rows(PAYERS)).sort((a,b) =>
        String(a.name||'').localeCompare(String(b.name||'')));
    },
    async payer(id){ return (await rows(PAYERS)).find(p => p.id === id) || null; },
    async findPayer(q){
      if(!q) return null;
      const list = await rows(PAYERS);
      const Q = String(q).trim().toLowerCase();
      return list.find(p => String(p.payer_id||'').toLowerCase() === Q) ||
             list.find(p => String(p.name||'').toLowerCase() === Q) ||
             list.find(p => String(p.name||'').toLowerCase().includes(Q)) || null;
    },
    async savePayer(p){
      if(DRIVER==='api'){ try{ const j=await dSave('payer',arguments[0]); return { ok:true, id:j.id, ...(j.record||{}) }; }catch(e){ return { error:String(e.message||e) }; } }

      try{
        if(p.id === undefined || p.id === null || p.id === '') delete p.id;
        if(!p.name) return { error:'Payer name is required' };
        const list = await rows(PAYERS);
        const clash = list.find(x => x.id !== p.id &&
          String(x.payer_id||'').toLowerCase() === String(p.payer_id||'').toLowerCase() &&
          String(p.payer_id||'') !== '');
        if(clash) return { error:`Payer ID ${p.payer_id} is already used by ${clash.name}` };
        const me = getSession();
        if(!p.id){
          p.created_at = new Date().toISOString();
          p.created_by = me ? me.username : 'system';
          p.status = p.status || 'active';
        }
        p.updated_at = new Date().toISOString();
        const id = await save_(PAYERS, p);
        return { ok:true, id: p.id || id };
      }catch(err){ return { error:'Save failed: '+(err && err.message || err) }; }
    },
    async removePayer(id){
      if(DRIVER==='api'){ try{ await dDel('payer',id); return { ok:true }; }catch(e){ return { error:String(e.message||e) }; } }
 await kill(PAYERS, id); return { ok:true }; },
    async importPayers(list){
      let added = 0, updated = 0, failed = [];
      const existing = await rows(PAYERS);
      for(const raw of list){
        if(!raw.name){ failed.push({ row:raw._row, why:'No payer name' }); continue; }
        const match = existing.find(x =>
          (raw.payer_id && String(x.payer_id||'').toLowerCase() === String(raw.payer_id).toLowerCase()) ||
          String(x.name||'').toLowerCase() === String(raw.name).toLowerCase());
        const rec = match ? { ...match, ...raw, id: match.id } : { ...raw };
        delete rec._row;
        const r = await this.savePayer(rec);
        if(r.ok){ match ? updated++ : added++; }
        else failed.push({ row:raw._row, why:r.error });
      }
      return { ok:true, added, updated, failed };
    },

    /* ═══ MASTER DATA ═══
       set: cpt | hcpcs | icd10 | pos | modifier | servicetype | fee */
    async master(set){
      const list = await rows(MASTER);
      const out = set ? list.filter(m => m.set === set) : list;
      return out.sort((a,b) => String(a.code||'').localeCompare(String(b.code||'')));
    },
    async masterItem(id){ return (await rows(MASTER)).find(m => m.id === id) || null; },
    async saveMaster(m){
      try{
        if(m.id === undefined || m.id === null || m.id === '') delete m.id;
        if(!m.set)  return { error:'A code set is required' };
        if(!m.code) return { error:'A code is required' };
        const list = await rows(MASTER);
        const clash = list.find(x => x.id !== m.id && x.set === m.set &&
          String(x.code).toLowerCase() === String(m.code).toLowerCase());
        if(clash) return { error:`${m.code} already exists in this code set` };
        const me = getSession();
        if(!m.id){
          m.created_at = new Date().toISOString();
          m.created_by = me ? me.username : 'system';
          m.status = m.status || 'active';
        }
        m.updated_at = new Date().toISOString();
        const id = await save_(MASTER, m);
        return { ok:true, id: m.id || id };
      }catch(err){ return { error:'Save failed: '+(err && err.message || err) }; }
    },
    async removeMaster(id){ await kill(MASTER, id); return { ok:true }; },
    async importMaster(set, list){
      let added = 0, updated = 0, failed = [];
      const existing = (await rows(MASTER)).filter(m => m.set === set);
      for(const raw of list){
        if(!raw.code){ failed.push({ row:raw._row, why:'No code' }); continue; }
        const match = existing.find(x =>
          String(x.code).toLowerCase() === String(raw.code).toLowerCase());
        const rec = match ? { ...match, ...raw, set, id: match.id } : { ...raw, set };
        delete rec._row;
        const r = await this.saveMaster(rec);
        if(r.ok){ match ? updated++ : added++; }
        else failed.push({ row:raw._row, why:r.error });
      }
      return { ok:true, added, updated, failed };
    },
    /* the fee for a CPT, from the fee schedule if one exists */
    async feeFor(code){
      const list = await rows(MASTER);
      const fee = list.find(m => m.set === 'fee' && String(m.code) === String(code));
      if(fee && fee.fee != null) return Number(fee.fee);
      const cpt = list.find(m => m.set === 'cpt' && String(m.code) === String(code));
      return cpt && cpt.fee != null ? Number(cpt.fee) : 0;
    },

    /* ═══ PATIENT IMPORT ═══ */
    async importPatients(list){
      let added = 0, updated = 0, failed = [];
      const existing = await rows(PATIENTS);
      for(const raw of list){
        if(!raw.last_name){ failed.push({ row:raw._row, why:'No last name' }); continue; }
        const match = existing.find(x =>
          (raw.internal_id && String(x.internal_id||'').toLowerCase() === String(raw.internal_id).toLowerCase()) ||
          (String(x.last_name||'').toLowerCase() === String(raw.last_name).toLowerCase() &&
           String(x.first_name||'').toLowerCase() === String(raw.first_name||'').toLowerCase() &&
           String(x.dob||'') === String(raw.dob||'')));
        const rec = match ? { ...match, ...raw, id: match.id } : { ...raw };
        delete rec._row;
        const r = await this.savePatientRec(rec);
        if(r.ok){ match ? updated++ : added++; }
        else failed.push({ row:raw._row, why:r.error });
      }
      return { ok:true, added, updated, failed };
    },
    async removePatient(id){
      if(DRIVER==='api'){ try{ await dDel('patient',id); return { ok:true }; }catch(e){ return { error:String(e.message||e) }; } }
 await kill(PATIENTS, id); return { ok:true }; },

    /* ═══ TEAM MEMBERS ═══
       A supervisor adds people to their organisation. Providers land in the
       provider table so admin sees them; everyone else becomes a pending
       account request. Either way the admin issues the password. */
    /* every section a practice manager can grant access to */
    SECTIONS: [
      { key:'schedule',      label:'Schedule',        note:'Appointments and provider columns' },
      { key:'patients',      label:'Patient records', note:'Charts, encounters and billing' },
      { key:'eligibility',   label:'Eligibility',     note:'Real-time and batch checks' },
      { key:'claims',        label:'Claims',          note:'Submitted claims and status' },
      { key:'credentialing', label:'Credentialing',   note:'Payer enrolment and attestations' },
      { key:'tasks',         label:'Tasks',           note:'Assigned work and CC visibility' },
      { key:'teams',         label:'Teams',           note:'Adding and editing team members' },
      { key:'reports',       label:'Reports',         note:'Dashboard figures and exports' }
    ],

    defaultAccess(){
      const out = {};
      this.SECTIONS.forEach(s => { out[s.key] = 'none'; });
      return out;
    },
    /* a provider's access follows their role rather than a grant */
    providerAccess(){
      return { schedule:'edit', patients:'edit', eligibility:'edit', claims:'edit',
               credentialing:'view', tasks:'edit', teams:'none', reports:'view' };
    },

    /* What a role can do before a practice manager sets anything.
       Locking a new account out of everything looks like a broken app,
       so each role starts with what its job obviously needs. */
    roleDefaults(role){
      switch(role){
        case 'admin':
        case 'supervisor':
          return { schedule:'edit', patients:'edit', eligibility:'edit', claims:'edit',
                   credentialing:'edit', tasks:'edit', teams:'edit', reports:'edit' };
        case 'provider':
          return this.providerAccess();
        case 'scheduler':
          return { schedule:'edit', patients:'edit', eligibility:'edit', claims:'view',
                   credentialing:'none', tasks:'edit', teams:'none', reports:'view' };
        case 'employee':
          return { schedule:'view', patients:'edit', eligibility:'edit', claims:'edit',
                   credentialing:'none', tasks:'edit', teams:'none', reports:'view' };
        default:
          return this.defaultAccess();
      }
    },

    async setAccess(username, access){
      const me = getSession();
      if(!me || !['supervisor','scheduler','admin'].includes(me.role))
        return { error:'Only a practice manager or administrator can change access' };
      const a = (await all()).find(x => x.username === username);
      if(a){
        a.access = access;
        a.access_set_by = me.username;
        a.access_set_at = new Date().toISOString();
        await put(a);
      }
      const list = (await meta('team_requests')) || [];
      const i = list.findIndex(r => r.issued_username === username ||
                                    r.suggested_username === username);
      if(i > -1){ list[i].access = access; await setMeta('team_requests', list); }
      return { ok:true };
    },
    async getAccess(username){
      const a = (await all()).find(x => x.username === username);
      if(a && a.access) return a.access;
      const list = (await meta('team_requests')) || [];
      const r = list.find(x => x.issued_username === username || x.suggested_username === username);
      if(r && r.access) return r.access;
      return this.roleDefaults(a ? a.role : (getSession() || {}).role);
    },
    async can(section){
      const me = getSession();
      if(!me) return 'none';
      if(me.role === 'admin' || me.role === 'supervisor') return 'edit';
      if(me.role === 'provider') return this.providerAccess()[section] || 'none';

      const acc = await this.getAccess(me.username);
      /* an account with no stored grant falls back to what its role needs */
      if(!acc || !Object.keys(acc).length) return this.roleDefaults(me.role)[section] || 'none';
      return acc[section] || 'none';
    },

    async addTeamMember(data){
      try{
        const me = getSession();
        if(!me) return { error:'Not signed in' };
        if(!['supervisor','scheduler','admin'].includes(me.role))
          return { error:'Only a practice manager or administrator can add team members' };
        if(!data.full_name) return { error:'A name is required' };
        if(!data.role)      return { error:'Choose what they do' };
        if(data.role === 'supervisor')
          return { error:'A practice manager can only be created from the admin console' };

        const orgId = data.org_id || me.org_id;
        if(!orgId) return { error:'No organisation is linked to your account' };

        const n = splitName(data.full_name);
        let providerId = null;

        /* a provider needs a record in the provider table, which is what
           admin's Providers screen reads */
        if(data.role === 'provider'){
          const r = await this.saveProvider({
            org_id: orgId,
            full_name: data.full_name,
            title: data.title || '',
            email: data.email || '',
            phone: data.phone || '',
            specialty: data.specialty || '',
            npi: data.npi || '',
            taxonomy: data.taxonomy || '',
            license: data.license || '',
            state: data.state || '',
            availability: data.availability || 'Mon–Fri, 08:00 – 17:00',
            favourite_cpt: '',
            telehealth: !!data.telehealth,
            address: data.address || '',
            added_by_team: true
          });
          if(r.error) return r;
          providerId = r.id;
        }

        /* the request an administrator will action */
        const list = (await meta('team_requests')) || [];
        const req = {
          id: 'tr_' + Math.random().toString(36).slice(2,10) + Date.now().toString(36),
          org_id: orgId,
          full_name: data.full_name,
          first_name: n.first, last_name: n.last,
          role: data.role, team: data.team || '',
          title: data.title || '', email: data.email || '', phone: data.phone || '',
          specialty: data.specialty || '', npi: data.npi || '',
          provider_ref: providerId,
          suggested_username: data.username || suggestUsername(data.full_name),
          access: data.role === 'provider' ? this.providerAccess()
                  : (data.access || this.defaultAccess()),
          status: 'pending',
          requested_by: me.username,
          requested_name: me.name || me.username,
          requested_at: new Date().toISOString()
        };
        list.unshift(req);
        await setMeta('team_requests', list.slice(0,300));
        return { ok:true, id:req.id, provider_ref:providerId, username:req.suggested_username };
      }catch(err){ return { error:'Save failed: '+(err && err.message || err) }; }
    },

    async teamRequests(orgId){
      const list = (await meta('team_requests')) || [];
      const accts = await all();
      /* a request is fulfilled once an account exists for it */
      const out = list.map(r => {
        const acct = accts.find(a =>
          (r.provider_ref && a.provider_ref === r.provider_ref) ||
          a.username === r.issued_username);
        return { ...r, account: acct ? { username:acct.username, status:acct.status,
                                         must_change:acct.must_change } : null,
                 status: acct ? 'active' : (r.status || 'pending') };
      });
      return orgId ? out.filter(r => String(r.org_id) === String(orgId)) : out;
    },

    async markTeamRequest(id, patch){
      const list = (await meta('team_requests')) || [];
      const i = list.findIndex(r => r.id === id);
      if(i < 0) return { error:'Not found' };
      list[i] = { ...list[i], ...patch };
      await setMeta('team_requests', list);
      return { ok:true };
    },
    async removeTeamRequest(id){
      const list = ((await meta('team_requests')) || []).filter(r => r.id !== id);
      await setMeta('team_requests', list);
      return { ok:true };
    },

    /* ═══ LOGIN AND LOGOUT HISTORY ═══ */
    async loginEvents(opts){
      opts = opts || {};
      const list = (await meta('events')) || [];
      const accts = await all();
      const byName = {};
      accts.forEach(a => { byName[a.username] = a; });

      let out = list.map(e => ({ ...e, account: byName[e.username] || null }));
      if(opts.from) out = out.filter(e => e.at >= opts.from);
      if(opts.to)   out = out.filter(e => e.at <= opts.to + 'T23:59:59.999Z');
      if(opts.username) out = out.filter(e => e.username === opts.username);
      if(opts.orgId) out = out.filter(e => e.account && String(e.account.org_id) === String(opts.orgId));
      return out.sort((a,b) => new Date(b.at) - new Date(a.at));
    },

    /* pair each login with the logout that followed it */
    async sessionsReport(opts){
      const events = await this.loginEvents(opts);
      const byUser = {};
      events.slice().reverse().forEach(e => {
        (byUser[e.username] = byUser[e.username] || []).push(e);
      });

      const out = [];
      Object.keys(byUser).forEach(u => {
        const seq = byUser[u];
        let open = null;
        seq.forEach(e => {
          if(e.event === 'login'){
            if(open) out.push({ ...open, out_at:null, seconds:null, incomplete:true });
            open = { username:u, account:e.account, in_at:e.at };
          }else if(e.event === 'logout' && open){
            out.push({ ...open, out_at:e.at,
                       seconds: Math.max(0, (new Date(e.at) - new Date(open.in_at))/1000) });
            open = null;
          }
        });
        if(open) out.push({ ...open, out_at:null, seconds:null, incomplete:true });
      });
      return out.sort((a,b) => new Date(b.in_at) - new Date(a.in_at));
    },

    /* called by the session manager as it tears a session down */
    logSignOut(username, reason){
      try{ logEvent(username, reason === 'idle' ? 'timeout' : 'logout'); }catch(e){}
    },

    async events(){ return (await meta('events')) || []; },
    async auditLog(){ return (await meta('audit')) || []; },

    /* wipe everything and re-seed the temp admin */
    async reset(){
      const d = await idb();
      await new Promise(r => { const t = d.transaction([STORE,META],'readwrite');
        t.objectStore(STORE).clear(); t.objectStore(META).clear(); t.oncomplete = r; });
      clearSession(); await seed();
      return TEMP_ADMIN;
    }
  };
})();
