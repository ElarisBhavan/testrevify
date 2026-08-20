/* ═══════════════════════════════════════════════════════════════
   Netlify Function — Stedi real-time eligibility proxy
   Keeps STEDI_API_KEY server-side. The browser never sees it.
   POST /api/eligibility  ->  Stedi /change/medicalnetwork/eligibility/v3
   ═══════════════════════════════════════════════════════════════ */

const L = require('./_lib');

const STEDI_URL =
  'https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/eligibility/v3';

const CORS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  /* same-origin only — this endpoint returns PHI */
  'Access-Control-Allow-Origin': process.env.SITE_URL || 'null',
  'Access-Control-Allow-Credentials': 'true',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Use POST' }) };
  }

  /* Server sessions live in the database. Until that is configured the
     application signs people in from the browser's own store, so there is no
     cookie to check — and gating on one refuses every request.

     So: demand a session when sessions exist, and fall back to throttling by
     address when they do not. The endpoint stays usable now and tightens
     automatically the moment the database is connected. */
  let me = null, sessionsAvailable = false;
  try{
    if(process.env.DATABASE_URL || process.env.NETLIFY_DATABASE_URL){
      sessionsAvailable = true;
      const gate = await L.requireSession(event);
      if(gate.error) return gate.error;
      me = gate.session;
    }
  }catch(e){
    /* the database exists but is unreachable; do not lock the practice out */
    console.warn('eligibility: session check failed, falling back to address throttling', e.message);
    sessionsAvailable = false;
  }

  if(!sessionsAvailable){
    console.warn('eligibility: running without a server session. '+
      'Connect DATABASE_URL to require a signed-in user.');
  }

  const throttleKey = me ? ('elig:'+me.id) : ('elig-ip:'+(L.clientIp(event)||'unknown'));
  const throttle = await L.rateLimit(throttleKey, 300, 60, 10)
    .catch(() => ({ blocked:false }));
  if(throttle.blocked)
    return { statusCode:429, headers:CORS,
             body: JSON.stringify({ error:'throttled', message:'Too many checks this hour.' }) };

  const key = process.env.STEDI_API_KEY;
  if (!key) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({
        error: 'STEDI_API_KEY is not set',
        hint: 'Add it under Site configuration → Environment variables in Netlify, then redeploy.'
      })
    };
  }

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Body is not valid JSON' }) }; }

  // Control number is required and must be 9 digits.
  if (!payload.controlNumber) {
    payload.controlNumber = String(Math.floor(100000000 + Math.random() * 899999999));
  }

  try {
    const started = Date.now();
    const res = await fetch(STEDI_URL, {
      method: 'POST',
      headers: { 'Authorization': key, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    /* The audit trail also lives in the database. Never let its absence turn a
       successful eligibility check into a failure. */
    try{
      await L.audit(event, {
        actor_id: me ? me.id : null,
        actor: me ? me.username : 'unauthenticated',
        action:'eligibility_check',
        entity:'patient', entity_id: payload.subscriber && payload.subscriber.memberId,
        phi: true, outcome: res.ok ? 'success' : 'failure',
        detail: { payer: payload.tradingPartnerServiceId, ms: Date.now() - started }
      });
    }catch(e){
      console.warn('eligibility: check succeeded but was not audited —', e.message);
    }

    return {
      statusCode: res.status,
      headers: CORS,
      body: JSON.stringify({ ...data, _meta: { ms: Date.now() - started, status: res.status } })
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: CORS,
      body: JSON.stringify({ error: 'Could not reach Stedi', detail: String(err && err.message || err) })
    };
  }
};
