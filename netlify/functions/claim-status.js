/* Real-time claim status (276/277) through Stedi.
   Dependency-free, like the claims function, so there is nothing to bundle. */

const STATUS_URL = process.env.STEDI_STATUS_URL ||
  'https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/claimstatus/v2';

const CORS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': process.env.SITE_URL || '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS'
};

const d8 = v => String(v || '').replace(/\D/g, '').slice(0, 8);
const digits = v => String(v || '').replace(/\D/g, '');

/* Stedi rejects the X12 delimiters outright, so strip them from every value. */
const safe = v => String(v == null ? '' : v).replace(/[~*:^]/g, ' ').trim();

function apiKey(){
  let k = process.env.STEDI_API_KEY || '';
  return k.trim().replace(/^["']|["']$/g,'').trim().replace(/^Bearer\s+/i,'');
}

const clean = o => {
  if(Array.isArray(o)){
    const a = o.map(clean).filter(x => x !== undefined);
    return a.length ? a : undefined;
  }
  if(o && typeof o === 'object'){
    const out = {};
    for(const k of Object.keys(o)){
      const v = clean(o[k]);
      if(v !== undefined && v !== null && v !== '') out[k] = v;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return (o === '' || o === null) ? undefined : o;
};

/* Stedi's guidance is to send the minimum and add only what is needed —
   over-specifying narrows the payer's search and returns nothing. */
function toRequest(c){
  const providers = [];

  if(c.org_npi){
    providers.push(clean({
      providerType: 'BillingProvider',
      npi: digits(c.org_npi),
      organizationName: safe(c.org_name),
      taxId: digits(c.tax_id) || undefined
    }));
  }
  /* a rendering provider only when they differ from the biller */
  if(c.provider_npi && digits(c.provider_npi) !== digits(c.org_npi)){
    providers.push(clean({
      providerType: 'ServiceProvider',
      npi: digits(c.provider_npi),
      firstName: safe(c.prov_first),
      lastName: safe(c.prov_last)
    }));
  }

  /* a gender of U should be left out rather than sent */
  const sex = String(c.sub_sex || '').toUpperCase();

  return clean({
    tradingPartnerServiceId: safe(c.payer_id),
    providers,
    subscriber: clean({
      memberId: safe(c.member_id),
      firstName: safe(c.sub_first),
      lastName: safe(c.sub_last),
      dateOfBirth: d8(c.sub_dob),
      gender: (sex === 'M' || sex === 'F') ? sex : undefined,
      groupNumber: safe(c.group_id) || undefined
    }),
    /* only sent when the patient is not the subscriber */
    dependent: String(c.relationship || '18') === '18' ? undefined : clean({
      firstName: safe(c.patient_first),
      lastName: safe(c.patient_last),
      dateOfBirth: d8(c.patient_dob)
    }),
    encounter: clean({
      beginningDateOfService: d8(c.dos_from || c.dos),
      endDateOfService: d8(c.dos_to || c.dos),
      /* the payer matches far better when it can see the amount and control number */
      trackingNumber: safe(c.control) || undefined,
      chargeAmount: c.total ? String(Number(c.total).toFixed(2)) : undefined
    })
  });
}

exports.handler = async (event) => {
  if(event.httpMethod === 'OPTIONS') return { statusCode:204, headers:CORS, body:'' };

  if(event.httpMethod === 'GET'){
    return { statusCode:200, headers:CORS, body: JSON.stringify({
      ok:true, route:'/api/claim-status', configured: !!apiKey()
    }) };
  }

  if(event.httpMethod !== 'POST')
    return { statusCode:405, headers:CORS, body: JSON.stringify({ error:'method' }) };

  let body = {};
  try{ body = JSON.parse(event.body || '{}'); }
  catch{ return { statusCode:400, headers:CORS, body: JSON.stringify({ error:'bad_json' }) }; }

  const claim = body.claim;
  if(!claim) return { statusCode:400, headers:CORS, body: JSON.stringify({ error:'no_claim' }) };

  const payload = toRequest(claim);

  if(body.dryRun) return { statusCode:200, headers:CORS,
    body: JSON.stringify({ dryRun:true, payload }) };

  const key = apiKey();
  if(!key) return { statusCode:503, headers:CORS, body: JSON.stringify({
    error:'not_configured',
    message:'STEDI_API_KEY is not set on this deployment.'
  }) };

  const started = Date.now();
  try{
    const res = await fetch(STATUS_URL, {
      method:'POST',
      headers:{ 'Authorization': key, 'Content-Type':'application/json' },
      body: JSON.stringify(payload)
    });

    const text = await res.text();
    let data = {};
    try{ data = JSON.parse(text); }
    catch{ data = { raw: text.slice(0, 400) }; }

    return { statusCode: res.status, headers: CORS, body: JSON.stringify({
      ...data,
      _meta:{ status: res.status, ms: Date.now() - started, sent: payload }
    }) };
  }catch(err){
    return { statusCode:502, headers:CORS, body: JSON.stringify({
      error:'upstream', message:String(err.message || err) }) };
  }
};

module.exports.toRequest = toRequest;
