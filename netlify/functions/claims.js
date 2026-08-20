/* Professional claim submission (837P) through Stedi.
   Deliberately dependency-free: no database, no shared library, nothing to
   bundle. A function that cannot build is a function that returns 404. */

/* Netlify keeps the value verbatim, so a stray quote, newline or a copied
   "Bearer " prefix all travel with it and produce an unauthorized reply. */
/* A short, non-reversible fingerprint. Lets the health check and a real
   submission be compared without ever exposing the key. */
function fingerprint(k) {
  if (!k) return 'none';
  let h = 2166136261;
  for (let i = 0; i < k.length; i++) { h ^= k.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36) + '/' + k.length;
}

/* A response carrying a claimReference, errors array or status field is Stedi
   having processed the claim. The HTTP status may still be 4xx — that is how
   validation failures come back — but the credential plainly worked. */
function isClaimResponse(d) {
  if (!d || typeof d !== 'object') return false;
  return !!(d.claimReference || d.errors || d.status || d.x12 || d.meta);
}

/* Flatten Stedi's error shapes into something readable. */
function claimErrors(d) {
  const out = [];
  const walk = (arr) => {
    (arr || []).forEach(e => {
      if (!e) return;
      const bits = [e.field, e.description || e.message || e.reason]
        .filter(Boolean).join(': ');
      out.push({ code: e.code || e.errorCode || undefined,
                 message: bits || e.code || 'Unspecified',
                 location: e.location || e.path || undefined });
      if (e.errors) walk(e.errors);
    });
  };
  walk(d.errors);
  if (d.claimReference && d.claimReference.errors) walk(d.claimReference.errors);
  (d.claimReference && d.claimReference.serviceLines || []).forEach(l => walk(l.errors));
  return out;
}

function apiKey() {
  let k = process.env.STEDI_API_KEY || '';
  k = k.trim().replace(/^["']|["']$/g, '').trim();
  k = k.replace(/^Bearer\s+/i, '');
  return k;
}

const STEDI_URL = process.env.STEDI_CLAIMS_URL ||
  'https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/professionalclaims/v3/submission';

const CORS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': process.env.SITE_URL || '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS'
};

/* ── formatting ── */
const d8 = v => String(v || '').replace(/\D/g, '').slice(0, 8);
const digits = v => String(v || '').replace(/\D/g, '');
const amt = v => Number(v || 0).toFixed(2);          /* Stedi wants strings */
const up = v => String(v || '').trim().toUpperCase();
const dxCode = v => up(v).replace(/\./g, '');
const zip = v => digits(v).slice(0, 9);

/* 17 characters or fewer, alphanumeric, hard to guess */
function pcn(v) {
  const base = String(v || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 9);
  const rand = Math.random().toString(36).replace(/[^a-z0-9]/g, '').slice(0, 8).toUpperCase();
  return (base + rand).slice(0, 17) || rand;
}

const clean = o => {
  if (Array.isArray(o)) {
    const a = o.map(clean).filter(x => x !== undefined);
    return a.length ? a : undefined;
  }
  if (o && typeof o === 'object') {
    const out = {};
    for (const k of Object.keys(o)) {
      const v = clean(o[k]);
      if (v !== undefined && v !== null && v !== '') out[k] = v;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return (o === '' || o === null) ? undefined : o;
};

const address = (l1, l2, city, state, postal) => clean({
  address1: l1, address2: l2, city, state: up(state), postalCode: zip(postal)
});

function toStedi(c) {
  const paper = String(c.send_method || 'electronic') === 'paper';
  const dx = (c.dx || []).filter(Boolean).map((code, i) => ({
    diagnosisTypeCode: i === 0 ? 'ABK' : 'ABF',
    diagnosisCode: dxCode(code)
  }));

  const serviceLines = (c.lines || []).map((l, i) => clean({
    serviceDate: d8(l.from || c.dos),
    serviceDateEnd: (l.to && l.to !== l.from) ? d8(l.to) : undefined,
    providerControlNumber: l.control || String(i + 1),
    professionalService: {
      procedureIdentifier: 'HC',
      procedureCode: up(l.cpt),
      procedureModifiers: [l.mod, l.mod2, l.mod3, l.mod4].filter(Boolean).map(up),
      description: l.desc || undefined,
      lineItemChargeAmount: amt((Number(l.charge) || 0) * (Number(l.units) || 1)),
      measurementUnit: l.unit_type || 'UN',
      serviceUnitCount: String(Number(l.units) || 1),
      placeOfServiceCode: l.pos || undefined,
      /* a procedure may answer to several diagnoses; the 837P allows four */
      compositeDiagnosisCodePointers: {
        diagnosisCodePointers: (Array.isArray(l.dxptrs) && l.dxptrs.length
          ? l.dxptrs : [l.dxptr || 1]).slice(0, 4).map(String)
      }
    },
    renderingProvider: c.provider_npi ? {
      providerType: 'RenderingProvider',
      npi: c.provider_npi,
      firstName: c.prov_first,
      lastName: c.prov_last,
      taxonomyCode: c.prov_taxonomy || undefined
    } : undefined
  }));

  const isSelf = String(c.relationship || '18') === '18';

  return clean({
    /* Stedi pairs the key type with this field. A production key must send P;
       sending T with a production key is refused. Safe testing is done by
       routing a production transaction to Stedi's test payer instead. */
    usageIndicator: process.env.STEDI_USAGE || 'P',
    /* A paper claim is printed and posted, so there is no trading partner to
       route to. Stedi keys off the mailing address instead. */
    tradingPartnerServiceId: paper ? undefined : c.payer_id,
    tradingPartnerName: c.payer,
    claimSubmissionMethod: paper ? 'PAPER' : undefined,

    submitter: {
      organizationName: c.submitter_name || c.org_name,
      submitterIdentification: process.env.STEDI_SUBMITTER_ID || c.submitter_id || undefined,
      contactInformation: {
        name: c.submitter_name || c.org_name,
        phoneNumber: digits(c.org_phone)
      }
    },

    receiver: paper ? {
      organizationName: c.payer,
      address: address(c.payer_address, '', c.payer_city, c.payer_state, c.payer_zip)
    } : { organizationName: c.payer },

    billing: {
      providerType: 'BillingProvider',
      npi: c.org_npi,
      employerId: digits(c.tax_id),
      organizationName: c.org_name,
      taxonomyCode: c.taxonomy || undefined,
      address: address(c.org_addr, c.org_addr2, c.org_city, c.org_state, c.org_zip),
      contactInformation: { name: c.org_name, phoneNumber: digits(c.org_phone) }
    },

    subscriber: {
      memberId: c.member_id,
      paymentResponsibilityLevelCode: c.responsibility || 'P',
      firstName: c.sub_first,
      lastName: c.sub_last,
      gender: c.sub_sex || 'U',
      dateOfBirth: d8(c.sub_dob),
      groupNumber: c.group_id || undefined,
      subscriberGroupName: c.group_name || undefined,
      address: address(c.sub_addr, '', c.sub_city, c.sub_state, c.sub_zip)
    },

    dependent: isSelf ? undefined : {
      firstName: c.patient_first,
      lastName: c.patient_last,
      gender: c.patient_sex || 'U',
      dateOfBirth: d8(c.patient_dob),
      relationshipToSubscriberCode: c.relationship,
      address: address(c.pat_addr, '', c.pat_city, c.pat_state, c.pat_zip)
    },

    claimInformation: {
      patientControlNumber: pcn(c.control),
      claimChargeAmount: amt(c.total),
      placeOfServiceCode: c.pos || '11',
      claimFrequencyCode: c.frequency || '1',
      signatureIndicator: c.signature || 'Y',
      planParticipationCode: c.assignment === 'N' ? 'C' : 'A',
      benefitsAssignmentCertificationIndicator: c.assignment || 'Y',
      releaseInformationCode: c.release || 'Y',
      claimFilingCode: c.filing || 'CI',
      priorAuthorizationNumber: c.prior_auth || undefined,
      referralNumber: c.referral || undefined,
      healthCareCodeInformation: dx,
      serviceFacilityLocation: (c.facility_npi || c.facility_name) ? {
        organizationName: c.facility_name || c.org_name,
        npi: c.facility_npi || c.org_npi,
        address: address(c.facility_addr || c.org_addr, '',
                         c.facility_city || c.org_city,
                         c.facility_state || c.org_state,
                         c.facility_zip || c.org_zip)
      } : undefined,
      claimSupplementalInformation: c.orig_ref
        ? { claimControlNumber: c.orig_ref } : undefined,
      serviceLines
    }
  });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  /* GET is a health check. With ?test=1 it calls Stedi with a deliberately
     empty claim: a 401 means the key is wrong, anything else means the key
     was accepted and only the claim content was rejected. */
  if (event.httpMethod === 'GET') {
    const k = apiKey();
    const raw = process.env.STEDI_API_KEY || '';
    const base = {
      ok: true, route: '/api/claims',
      configured: !!k,
      usage: process.env.STEDI_USAGE || 'P',
      submitterId: process.env.STEDI_SUBMITTER_ID ? 'set' : 'not set (optional)',
      key: k ? {
        fingerprint: fingerprint(k),
        length: k.length,
        starts: k.slice(0, 4),
        ends: k.slice(-4),
        hadWhitespace: raw !== raw.trim(),
        hadQuotes: /^["']|["']$/.test(raw.trim()),
        hadBearer: /^Bearer\s+/i.test(raw.trim())
      } : null
    };

    if (!(event.queryStringParameters || {}).test || !k)
      return { statusCode: 200, headers: CORS, body: JSON.stringify(base) };

    try {
      /* A complete, syntactically valid claim against Stedi's own test payer.
         A one-field probe is rejected on shape before authentication is even
         reached, so it proves far less than it appears to. */
      const probe = toStedi({
        payer: 'Stedi Test Payer', payer_id: 'STEDITEST', filing: 'CI',
        org_name: 'Test Practice', org_npi: '1999999984', tax_id: '123456789',
        taxonomy: '2084P0800X', org_phone: '5553334444',
        org_addr: '123 Some St', org_city: 'A City', org_state: 'NY', org_zip: '123450000',
        prov_first: 'Jane', prov_last: 'Smith', provider_npi: '1999999984',
        relationship: '18', member_id: 'U7777788888', group_id: '3335555',
        sub_first: 'John', sub_last: 'Anon', sub_dob: '2000-01-01', sub_sex: 'M',
        sub_addr: '2222 Random St', sub_city: 'A City', sub_state: 'NY', sub_zip: '123450000',
        control: 'HEALTHCHECK', dos: '2024-01-01', pos: '02',
        _usage: 'P',
        dx: ['F1111'],
        lines: [{ cpt: '90837', mod: '95', charge: 109.20, units: 1,
                  from: '2024-01-01', dxptr: '1' }],
        total: 109.20
      });
      /* STEDITEST is Stedi's own test payer: nothing reaches a real payer,
         so a production usage indicator is safe here. */
      probe.usageIndicator = 'P';
      const probeBody = JSON.stringify(probe);
      const r = await fetch(STEDI_URL, {
        method: 'POST',
        headers: { 'Authorization': k, 'Content-Type': 'application/json' },
        body: probeBody
      });
      const txt = await r.text();
      let d = {};
      try { d = JSON.parse(txt); } catch { d = { raw: txt.slice(0, 300) }; }
      const ctype = r.headers.get('content-type') || '';
      const firewall = /html/i.test(ctype) || /^\s*</.test(txt);
      const looksTest = /^test/i.test(k);
      const processed = isClaimResponse(d);
      /* only a bare refusal counts as rejected; a processed claim never does */
      const rejected = !processed && (r.status === 401 || r.status === 403);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({
        ...base,
        probe: { bytes: probeBody.length, payer: 'STEDITEST',
                 contentType: r.headers.get('content-type') || '' },
        stediStatus: r.status,
        keyAccepted: !rejected,
        firewallSuspected: firewall,
        keyType: looksTest ? 'test' : 'production',
        claimProcessed: processed,
        claimErrors: processed ? claimErrors(d) : undefined,
        verdict: processed
          ? 'The API key WORKS. Stedi processed this claim and returned a claim '
            + 'reference, so authentication and permissions are fine. The 4xx '
            + 'status is how Stedi reports claim validation failures. The errors '
            + 'listed here are against the synthetic health-check claim, which '
            + 'uses invented subscriber details, so they are expected. Submit a '
            + 'real claim from a patient chart to see whether it validates.'
          : firewall
          ? 'The response is HTML, so a firewall blocked this before it reached '
            + 'the API.'
          : rejected
            ? (looksTest
                ? 'This is a TEST mode API key. Test keys work only for mock '
                  + 'eligibility checks; the claims endpoints reject them. '
                  + 'Generate a PRODUCTION key and keep STEDI_USAGE=T.'
                : 'Stedi rejected the key on a complete, well-formed claim. '
                  + 'Confirm the key was generated in this account, and that '
                  + 'the member who created it has claims permissions.')
            : (r.status < 300
                ? 'A complete test claim was accepted. Submission should work.'
                : 'The key was accepted. Stedi objected to the claim content, '
                  + 'which is reported below.'),
        stediSaid: d.message || d.error || d.detail || undefined,
        stediRaw: d.raw || undefined,
        stediBody: (d && !d.raw) ? JSON.stringify(d).slice(0, 400) : undefined,
        stediKeys: (d && !d.raw) ? Object.keys(d) : undefined
      }) };
    } catch (err) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({
        ...base, reachable: false, message: String(err.message || err) }) };
    }
  }

  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'method' }) };

  let body = {};
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'bad_json' }) }; }

  const claim = body.claim;
  if (!claim) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'no_claim' }) };

  const payload = toStedi(claim);
  const TEST_PAYERS = ['STEDITEST', 'STEDI'];
  const toTestPayer = TEST_PAYERS.includes(String(claim.payer_id || '').toUpperCase());

  /* Inspect the payload without sending it. */
  if (body.dryRun) return { statusCode: 200, headers: CORS,
    body: JSON.stringify({ dryRun: true, configured: !!apiKey(),
      live: payload.usageIndicator === 'P' && !toTestPayer,
      toTestPayer, payload }) };

  const key = apiKey();
  if (!key) return { statusCode: 503, headers: CORS, body: JSON.stringify({
    error: 'not_configured',
    message: 'STEDI_API_KEY is not set on this deployment, so nothing was sent.'
  }) };

  let idem = String(claim.claim_no || claim.control || '')
    .replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64);
  if (!idem) idem = 'rf' + Date.now().toString(36);   /* never send it empty */
  const started = Date.now();

  try {
    /* The health check succeeds without an Idempotency-Key while a real
       submission carries one, so send with it, and on a 401 retry once
       without it. Whichever attempt succeeds identifies the cause. */
    async function send(withIdem) {
      const headers = { 'Authorization': key, 'Content-Type': 'application/json' };
      if (withIdem) headers['Idempotency-Key'] = idem;
      const bodyText = JSON.stringify(payload);
      const r = await fetch(STEDI_URL, { method: 'POST', headers, body: bodyText });

      /* Read as text first. A firewall block is HTML, and calling json() on it
         throws, hiding the very evidence that identifies the cause. */
      const text = await r.text();
      let d = {};
      try { d = JSON.parse(text); }
      catch { d = { raw: text.slice(0, 400) }; }

      return {
        status: r.status, data: d, sentIdem: !!withIdem,
        bodyBytes: bodyText.length,
        contentType: r.headers.get('content-type') || '',
        looksLikeFirewall: /^\s*</.test(text) ||
          /request blocked|forbidden|cloudfront|awselb|<html/i.test(text)
      };
    }

    let attempt = await send(true);
    let retried = false;

    /* A processed claim is never an auth failure, whatever the HTTP status. */
    if ((attempt.status === 401 || attempt.status === 403) &&
        !isClaimResponse(attempt.data)) {
      retried = true;
      const bare = await send(false);
      if (bare.status !== 401 && bare.status !== 403) {
        /* the header was the problem, not the credential */
        attempt = bare;
      } else {
        const waf = bare.looksLikeFirewall;   /* HTML only, not any 403 */
        return { statusCode: bare.status, headers: CORS, body: JSON.stringify({
          error: waf ? 'blocked' : 'unauthorized',
          httpStatus: bare.status,
          keyType: /^test/i.test(key) ? 'test' : 'production',
          keyFingerprint: fingerprint(key),
          triedWithoutIdempotencyKey: true,
          firewallSuspected: waf,
          contentType: bare.contentType,
          bodyBytes: bare.bodyBytes,
          message: (!waf && bare.status === 403)
            ? 'Stedi returned 403 as JSON. That is its authorisation layer, not '
              + 'a firewall. The key is invalid or expired, or it lacks '
              + 'permission for the claims endpoints. Production keys inherit '
              + 'the permissions of whoever created them — regenerate the key '
              + 'while signed in as an account owner.'
            : waf
            ? 'This looks like a web application firewall block rather than an '
              + 'authentication failure. Stedi fronts its API with AWS WAF, which '
              + 'blocks requests from IP addresses flagged as malicious. Netlify '
              + 'Functions run on shared cloud IP addresses, so the address this '
              + 'site happens to use may be on that list. Stedi documents the fix '
              + 'as routing requests through a dedicated static IP address, and '
              + 'their support team can confirm whether your requests are being '
              + 'blocked at the firewall.'
            : 'Stedi refused the request with and without an idempotency key, '
              + 'while a smaller request with the same key succeeds. Send Stedi '
              + 'support the response below.',
          stediSaid: bare.data.message || bare.data.error || undefined,
          stediRaw: bare.data.raw || undefined,
          stediBody: (bare.data && !bare.data.raw)
            ? JSON.stringify(bare.data).slice(0, 400) : undefined,
          _meta: { status: bare.status, ms: Date.now() - started }
        }) };
      }
    }

    const { status, data } = attempt;

    /* Stedi validated the claim and rejected its contents. Report the reasons,
       not a misleading authentication message. */
    if (isClaimResponse(data) && (status >= 400 || data.status === 'ERROR')) {
      const errs = claimErrors(data);
      const ref = data.claimReference || {};
      return { statusCode: 422, headers: CORS, body: JSON.stringify({
        error: 'claim_rejected',
        message: errs.length
          ? 'Stedi accepted the request but rejected the claim contents.'
          : 'Stedi rejected the claim without naming a field.',
        claimErrors: errs,
        correlationId: ref.correlationId || undefined,
        claimNumber: ref.rhclaimNumber || undefined,
        patientControlNumber: ref.patientControlNumber || undefined,
        stediStatus: data.status || undefined,
        _meta: { status, ms: Date.now() - started, usage: payload.usageIndicator }
      }) };
    }

    if (status === 401 || status === 403) {
      return { statusCode: status, headers: CORS, body: JSON.stringify({
        error: 'unauthorized',
        message: 'Stedi rejected the API key.',
        stediSaid: data.message || data.error || undefined,
        keyFingerprint: fingerprint(key),
        _meta: { status, ms: Date.now() - started }
      }) };
    }

    return { statusCode: status, headers: CORS,
      body: JSON.stringify({ ...data,
        _meta: { ms: Date.now() - started, status,
                 usage: payload.usageIndicator,
                 idempotencyKey: attempt.sentIdem ? idem : null,
                 idempotencyRetry: retried,
                 live: payload.usageIndicator === 'P' && !toTestPayer,
                 toTestPayer,
                 sent: payload } }) };
  } catch (err) {
    return { statusCode: 502, headers: CORS, body: JSON.stringify({
      error: 'upstream', message: String(err.message || err) }) };
  }
};

module.exports.toStedi = toStedi;
module.exports.pcn = pcn;
