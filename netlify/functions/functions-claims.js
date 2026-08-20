/* Professional claim submission (837P) through Stedi.
   The payload below follows Stedi's published request shape exactly:
   amounts are strings, the rendering provider sits on the service line,
   and the service facility is inside claimInformation. */
const L = require('./_lib');

const STEDI_URL = process.env.STEDI_CLAIMS_URL ||
  'https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/professionalclaims/v3/submission';

const CORS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': process.env.SITE_URL || 'null',
  'Access-Control-Allow-Credentials': 'true',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

/* ── formatting helpers ── */
const d8 = v => String(v || '').replace(/\D/g, '').slice(0, 8);
const digits = v => String(v || '').replace(/\D/g, '');
const amt = v => Number(v || 0).toFixed(2);            /* Stedi wants a string */
const up = v => String(v || '').trim().toUpperCase();
const dxCode = v => up(v).replace(/\./g, '');          /* no decimal point */
const zip = v => {
  const d = digits(v);
  return d.length === 9 || d.length === 5 ? d : d.slice(0, 9);
};

/* drop empty values — Stedi rejects blanks rather than ignoring them */
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

/* Stedi's rules: 17 characters or fewer, basic character set, and hard to
   guess. Predictable numbers create duplicates across patients. */
function pcn(v) {
  const base = String(v || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 9);
  const rand = Math.random().toString(36).replace(/[^a-z0-9]/g, '').slice(0, 8).toUpperCase();
  return (base + rand).slice(0, 17) || rand;
}

function address(line1, line2, city, state, postal) {
  return clean({
    address1: line1, address2: line2,
    city, state: up(state), postalCode: zip(postal)
  });
}

function toStedi(c) {
  /* diagnoses: the first is principal (ABK), the rest are ABF */
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
      compositeDiagnosisCodePointers: {
        diagnosisCodePointers: [String(l.dxptr || '1')]
      }
    },
    /* the rendering provider belongs on the line, not the claim */
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
    usageIndicator: process.env.STEDI_USAGE || 'T',   /* T while testing, P when live */
    controlNumber: String(Math.floor(100000000 + Math.random() * 899999999)),

    tradingPartnerServiceId: c.payer_id,
    tradingPartnerName: c.payer,

    submitter: {
      organizationName: c.submitter_name || c.org_name,
      submitterIdentification: process.env.STEDI_SUBMITTER_ID || c.submitter_id || undefined,
      contactInformation: {
        name: c.submitter_name || c.org_name,
        phoneNumber: digits(c.org_phone)
      }
    },

    receiver: { organizationName: c.payer },

    billing: {
      providerType: 'BillingProvider',
      npi: c.org_npi,
      employerId: digits(c.tax_id),
      organizationName: c.org_name,
      taxonomyCode: c.taxonomy || undefined,
      address: address(c.org_addr, c.org_addr2, c.org_city, c.org_state, c.org_zip),
      contactInformation: {
        name: c.org_name,
        phoneNumber: digits(c.org_phone)
      }
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
      relationshipToSubscriberCode: isSelf ? undefined : undefined,
      address: address(c.sub_addr, '', c.sub_city, c.sub_state, c.sub_zip)
    },

    /* only sent when the patient is somebody other than the subscriber */
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
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'method' }) };

  const gate = await L.requireSession(event);
  if (gate.error) return gate.error;
  const me = gate.session;

  const key = process.env.STEDI_API_KEY;
  if (!key) return { statusCode: 503, headers: CORS, body: JSON.stringify({
    error: 'not_configured',
    message: 'STEDI_API_KEY is not set on this deployment, so nothing was sent.'
  }) };

  let body = {};
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'bad_json' }) }; }

  const claim = body.claim;
  if (!claim) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'no_claim' }) };

  const throttle = await L.rateLimit('claims:' + me.id, 200, 60, 10);
  if (throttle.blocked) return { statusCode: 429, headers: CORS, body: JSON.stringify({
    error: 'throttled', message: 'Too many submissions this hour.' }) };

  const payload = toStedi(claim);
  const started = Date.now();

  /* let the caller inspect the payload without sending it */
  if (body.dryRun) return { statusCode: 200, headers: CORS,
    body: JSON.stringify({ dryRun: true, payload }) };

  try {
    /* An idempotency key means a retry after a network wobble cannot
       double-bill the payer. Safe to reuse for 24 hours. */
    const idem = claim.idempotency_key || claim.claim_no ||
      (claim.control + '-' + (claim.dos || '')).replace(/[^A-Za-z0-9._-]/g, '');

    const res = await fetch(STEDI_URL, {
      method: 'POST',
      headers: {
        'Authorization': key,
        'Content-Type': 'application/json',
        'Idempotency-Key': String(idem).slice(0, 64)
      },
      body: JSON.stringify(payload)
    });

    let data = {};
    try { data = await res.json(); } catch { data = { raw: await res.text() }; }

    await L.audit(event, {
      actor_id: me.id, actor: me.username, action: 'claim_submitted',
      entity: 'claim', entity_id: claim.claim_no, phi: true,
      outcome: res.ok ? 'success' : 'failure',
      detail: { payer: claim.payer_id, total: claim.total,
                ms: Date.now() - started, status: res.status }
    });

    return { statusCode: res.status, headers: CORS,
      body: JSON.stringify({ ...data,
        _meta: { ms: Date.now() - started, status: res.status,
                 usage: payload.usageIndicator, idempotencyKey: idem,
                 sent: payload } }) };
  } catch (err) {
    return { statusCode: 502, headers: CORS, body: JSON.stringify({
      error: 'upstream', message: String(err.message || err) }) };
  }
};

module.exports.toStedi = toStedi;
