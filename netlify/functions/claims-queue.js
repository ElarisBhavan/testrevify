/* Server-side queue of claims waiting for the nightly run.
   The browser posts a claim here the moment it is marked ready; the scheduled
   function drains the queue after hours. Without this the cron has nothing to
   read, because claims otherwise live only in the browser's database. */

const CORS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': process.env.SITE_URL || '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS'
};

const Q = require('./_queue-store.js');

const key = c => 'claim_' + String(c.id || c.claim_no || Date.now());

exports.handler = async (event) => {
  if(event.httpMethod === 'OPTIONS') return { statusCode:204, headers:CORS, body:'' };

  /* /api/claims-queue?diag=1 explains the state of the whole thing */
  if(event.httpMethod === 'GET' && (event.queryStringParameters||{}).diag){
    return { statusCode:200, headers:CORS, body: JSON.stringify(await Q.diagnose()) };
  }

  let s;
  try{ s = await Q.open(); }
  catch(err){
    return { statusCode:503, headers:CORS, body: JSON.stringify({
      error: err.reason || 'no_storage',
      message: String(err.message),
      tried: err.tried || undefined,
      diagnose: '/api/claims-queue?diag=1'
    }) };
  }

  try{
    /* the run history, for the History panel */
    if(event.httpMethod === 'GET' && (event.queryStringParameters||{}).history){
      const log = (await s.get('_runs').catch(()=>null)) || { runs:[] };
      return { statusCode:200, headers:CORS, body: JSON.stringify({
        ok:true, runs: log.runs || [] }) };
    }

    if(event.httpMethod === 'GET'){
      const keys = await s.list();
      const out = [];
      for(const k of keys){
        if(String(k).charAt(0) === '_') continue;
        const v = await s.get(k);
        if(v && v.claim) out.push({ key:k, queued_at:v.queued_at, status:v.status,
                         claim_no:v.claim.claim_no, payer:v.claim.payer,
                         total:v.claim.total,
                         attempts:v.attempts||0, last_error:v.last_error });
      }
      out.sort((a,b) => String(a.queued_at).localeCompare(String(b.queued_at)));
      return { statusCode:200, headers:CORS, body: JSON.stringify({
        ok:true, count:out.length, pending:out.filter(x=>x.status==='pending').length,
        items:out }) };
    }

    if(event.httpMethod === 'POST'){
      const body = JSON.parse(event.body || '{}');

      /* A claim submitted by hand from the claims screen is recorded here too,
         so the history covers everything that went out, however it was sent. */
      if(body.logManual){
        const m = body.logManual;
        const log = (await s.get('_runs').catch(()=>null)) || { runs:[] };
        const day = new Date().toISOString().slice(0,10).replace(/-/g,'');
        const n = log.runs.filter(r => String(r.batch||'').indexOf('MN-'+day) === 0).length;
        log.runs.unshift({
          batch: 'MN-' + day + '-' + String(n+1).padStart(2,'0'),
          ran_at: new Date().toISOString(),
          trigger: 'manual',
          by: m.by || '',
          sent: m.outcome === 'sent' ? 1 : 0,
          rejected: m.outcome === 'rejected' ? 1 : 0,
          failed: m.outcome === 'failed' ? 1 : 0,
          skipped: 0,
          detail: [{ claim: m.claim_no, outcome: m.outcome,
                     reference: m.reference || '', errors: m.errors || [] }]
        });
        log.runs = log.runs.slice(0, 200);
        await s.set('_runs', log);
        return { statusCode:200, headers:CORS, body: JSON.stringify({ ok:true }) };
      }

      const claim = body.claim;
      if(!claim) return { statusCode:400, headers:CORS, body: JSON.stringify({ error:'no_claim' }) };

      /* Re-queuing the same claim replaces its entry rather than adding a
         second, so a claim edited twice is still submitted once. */
      const k = key(claim);
      const existing = await s.get(k).catch(()=>null);
      if(existing && existing.status === 'sent'){
        return { statusCode:200, headers:CORS, body: JSON.stringify({
          ok:true, alreadySent:true, key:k }) };
      }

      await s.set(k, {
        claim, status:'pending', attempts: (existing && existing.attempts) || 0,
        queued_at: (existing && existing.queued_at) || new Date().toISOString(),
        updated_at: new Date().toISOString()
      });
      return { statusCode:200, headers:CORS, body: JSON.stringify({ ok:true, key:k }) };
    }

    if(event.httpMethod === 'DELETE'){
      const k = (event.queryStringParameters||{}).key;
      if(k){ await s.del(k); return { statusCode:200, headers:CORS, body: JSON.stringify({ ok:true }) }; }
      /* clear everything already sent */
      const keys = await s.list();
      let n = 0;
      for(const k2 of keys){
        if(String(k2).charAt(0) === '_') continue;
        const v = await s.get(k2).catch(()=>null);
        if(v && v.status === 'sent'){ await s.del(k2); n++; }
      }
      return { statusCode:200, headers:CORS, body: JSON.stringify({ ok:true, cleared:n }) };
    }

    return { statusCode:405, headers:CORS, body: JSON.stringify({ error:'method' }) };
  }catch(err){
    return { statusCode:500, headers:CORS, body: JSON.stringify({
      error:'queue', message:String(err.message || err) }) };
  }
};
