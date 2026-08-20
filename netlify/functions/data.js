/* Shared clinical data.
   One endpoint for every record type, because they differ only in how they
   are indexed and who may see them. Every call is authenticated and logged. */

const L = require('./_lib');

/* Which record types exist, how each is indexed, and who may write one. */
const KINDS = {
  patient:       { write:['admin','supervisor','scheduler','provider','employee'] },
  appt:          { write:['admin','supervisor','scheduler','provider'] },
  encounter:     { write:['admin','supervisor','provider'] },
  claim:         { write:['admin','supervisor','employee','provider'] },
  org:           { write:['admin'] },
  provider:      { write:['admin','supervisor'] },
  payer:         { write:['admin'] },
  master:        { write:['admin'] },
  task:          { write:['admin','supervisor','scheduler','provider','employee'] },
  credentialing: { write:['admin','supervisor'] },
  history:       { write:['admin','supervisor','scheduler','provider','employee'] },
  payment:       { write:['admin','supervisor','employee','provider'] }
};

/* PHI, and therefore logged in full. The rest is reference data. */
const PHI = new Set(['patient','appt','encounter','claim','task','credentialing','history']);

const low = v => String(v == null ? '' : v).toLowerCase();

/* what to pull out of a record so it can be indexed */
function columns(kind, r){
  const c = {
    org_id: r.org_id != null ? Number(r.org_id) : null,
    patient_ref: r.patient_ref != null ? Number(r.patient_ref) : null,
    provider_id: null, on_date: null,
    status: r.status || null, search: ''
  };

  if(kind === 'patient'){
    c.provider_id = r.provider_ref != null ? Number(r.provider_ref) : null;
    c.search = [r.last_name, r.first_name, r.internal_id, r.member_id, r.phone, r.email]
      .filter(Boolean).map(low).join(' ');
  }else if(kind === 'appt'){
    c.provider_id = r.provider_id != null ? Number(r.provider_id) : null;
    c.on_date = r.date || null;
    c.search = [r.patient_last, r.patient_first, r.member_id].filter(Boolean).map(low).join(' ');
  }else if(kind === 'encounter'){
    c.provider_id = r.clinician_id != null ? Number(r.clinician_id) : null;
    c.on_date = r.dos || null;
  }else if(kind === 'claim'){
    c.provider_id = r.provider_id != null ? Number(r.provider_id) : null;
    c.on_date = r.dos || null;
    c.search = [r.claim_no, r.patient_last, r.patient_first, r.payer, r.member_id]
      .filter(Boolean).map(low).join(' ');
  }else if(kind === 'provider'){
    c.search = [r.full_name, r.npi, r.email].filter(Boolean).map(low).join(' ');
  }else if(kind === 'payer'){
    c.search = [r.name, r.payer_id].filter(Boolean).map(low).join(' ');
  }else if(kind === 'master'){
    c.status = r.set || null;                    /* the code set, for filtering */
    c.search = [r.code, r.description].filter(Boolean).map(low).join(' ');
  }else if(kind === 'org'){
    c.search = low(r.name);
  }else if(kind === 'task'){
    c.search = [r.title, r.assignee].filter(Boolean).map(low).join(' ');
  }else if(kind === 'credentialing'){
    c.provider_id = r.provider_id != null ? Number(r.provider_id) : null;
  }else if(kind === 'history'){
    c.on_date = String(r.at || r.date || '').slice(0,10) || null;
    c.search = [r.what, r.detail, r.by].filter(Boolean).map(low).join(' ');
  }else if(kind === 'payment'){
    c.on_date = String(r.at || r.date || '').slice(0,10) || null;
    c.search = [r.patient_name, r.claim_no, r.payer, r.kind, r.reference].filter(Boolean).map(low).join(' ');
  }
  return c;
}

async function log(sql, event, me, action, kind, id, patientRef, detail){
  if(!PHI.has(kind)) return;
  try{
    const h = event.headers || {};
    await sql`insert into phi_access_log
      (actor, actor_id, action, kind, record_id, patient_ref, ip, user_agent, detail)
      values (${me.username}, ${me.id || null}, ${action}, ${kind},
              ${id || null}, ${patientRef || null},
              ${h['x-nf-client-connection-ip'] || h['client-ip'] || null},
              ${String(h['user-agent'] || '').slice(0,200)},
              ${sql.json(detail || {})})`;
  }catch(e){ /* logging must never block care */ }
}

exports.handler = async (event) => {
  if(event.httpMethod === 'OPTIONS')
    return { statusCode:204, headers:L.SECURITY_HEADERS || {}, body:'' };

  const gate = await L.requireSession(event);
  if(gate.error) return gate.error;
  const me = gate.session;

  const url = new URL(event.rawUrl || ('https://x' + (event.path||'') +
    '?' + (event.rawQuery || '')));
  const kind = (url.searchParams.get('kind') || '').toLowerCase();
  const action = (url.searchParams.get('action') || 'list').toLowerCase();

  if(!KINDS[kind]) return L.J(400, { error:'Unknown record type: ' + kind });

  let sql;
  try{ sql = L.db(); }
  catch(e){ return L.J(503, { error:'no_database', message:String(e.message||e) }); }

  let body = {};
  if(event.body){ try{ body = JSON.parse(event.body); }catch{ return L.J(400,{error:'bad_json'}); } }

  try{
    /* ── read one ── */
    if(action === 'get'){
      const id = Number(url.searchParams.get('id') || body.id);
      const r = await sql`select data from app_records
        where kind=${kind} and id=${id} and deleted_at is null`;
      if(!r.length) return L.J(404, { error:'Not found' });
      await log(sql, event, me, 'read', kind, id, r[0].data.patient_ref);
      return L.J(200, { ok:true, record:r[0].data });
    }

    /* ── read many ── */
    if(action === 'list'){
      const f = body.filter || {};
      let rows;

      /* Server-side task visibility. Never rely on the browser to hide another user's work. */
      if(kind === 'task' && !['admin','supervisor'].includes(me.role)){
        rows = await sql`select data from app_records
          where kind='task' and deleted_at is null
            and (lower(coalesce(data->>'assignee',''))=${low(me.username)}
              or lower(coalesce(data->>'created_by',''))=${low(me.username)}
              or EXISTS (
                   SELECT 1 FROM jsonb_array_elements_text(
                     CASE WHEN jsonb_typeof(data->'cc')='array' THEN data->'cc' ELSE '[]'::jsonb END
                   ) cc(value)
                   WHERE lower(cc.value)=${low(me.username)}
                 ))
          order by id desc limit 2000`;
      } else if(f.patient_ref != null){
        rows = await sql`select data from app_records
          where kind=${kind} and patient_ref=${Number(f.patient_ref)}
            and deleted_at is null order by id`;
      }else if(f.date){
        rows = await sql`select data from app_records
          where kind=${kind} and on_date=${f.date} and deleted_at is null order by id`;
      }else if(f.from && f.to){
        rows = await sql`select data from app_records
          where kind=${kind} and on_date between ${f.from} and ${f.to}
            and deleted_at is null order by on_date, id`;
      }else if(f.set){
        rows = await sql`select data from app_records
          where kind=${kind} and status=${f.set} and deleted_at is null order by id`;
      }else if(f.q){
        const q = '%' + low(f.q) + '%';
        rows = await sql`select data from app_records
          where kind=${kind} and search like ${q} and deleted_at is null
          order by id limit 200`;
      }else{
        rows = await sql`select data from app_records
          where kind=${kind} and deleted_at is null order by id limit 2000`;
      }

      await log(sql, event, me, 'list', kind, null, f.patient_ref,
        { filter:f, returned:rows.length });
      return L.J(200, { ok:true, records: rows.map(r => r.data) });
    }

    /* ── write ── */
    if(action === 'save'){
      const allowed = KINDS[kind].write;
      if(allowed.indexOf(me.role) < 0)
        return L.J(403, { error:'Your role may not change ' + kind + ' records' });

      const rec = body.record;
      if(!rec) return L.J(400, { error:'No record supplied' });

      let id = rec.id;
      const isNew = (id == null || id === '');

      /* A caller may send only the fields it changed. Merging over what is
         stored keeps everything else — including the values the search index
         is built from, which would otherwise silently disappear. */
      if(!isNew){
        const prev = await sql`select data from app_records
          where kind=${kind} and id=${Number(id)} and deleted_at is null`;
        if(prev.length) Object.assign(rec, { ...prev[0].data, ...rec });
      }

      if(isNew){
        const n = await sql`select nextval('app_records_id_seq') as id`;
        id = Number(n[0].id);
        rec.id = id;
        rec.created_by = me.username;
        rec.created_at = new Date().toISOString();
      }
      rec.updated_at = new Date().toISOString();

      const c = columns(kind, rec);
      await sql`insert into app_records
        (kind, id, org_id, patient_ref, provider_id, on_date, status, search,
         data, created_by, updated_by)
        values (${kind}, ${id}, ${c.org_id}, ${c.patient_ref}, ${c.provider_id},
                ${c.on_date}, ${c.status}, ${c.search}, ${sql.json(rec)},
                ${me.username}, ${me.username})
        on conflict (kind, id) do update set
          org_id=excluded.org_id, patient_ref=excluded.patient_ref,
          provider_id=excluded.provider_id, on_date=excluded.on_date,
          status=excluded.status, search=excluded.search,
          data=excluded.data, updated_by=excluded.updated_by, updated_at=now()`;

      await log(sql, event, me, isNew ? 'create' : 'write', kind, id, c.patient_ref);
      return L.J(200, { ok:true, id, record:rec });
    }

    /* ── remove ── */
    if(action === 'delete'){
      const allowed = KINDS[kind].write;
      if(allowed.indexOf(me.role) < 0)
        return L.J(403, { error:'Your role may not remove ' + kind + ' records' });

      const id = Number(url.searchParams.get('id') || body.id);
      /* Clinical records are never erased — they are marked and kept, because
         a deleted encounter is still evidence of what happened. */
      await sql`update app_records set deleted_at=now(), updated_by=${me.username}
        where kind=${kind} and id=${id}`;
      await log(sql, event, me, 'delete', kind, id, null);
      return L.J(200, { ok:true });
    }

    return L.J(400, { error:'Unknown action: ' + action });
  }catch(err){
    console.error('data function failed', kind, action, err);
    return L.J(500, { error:'server', message:String(err.message || err) });
  }
};

module.exports.columns = columns;
module.exports.KINDS = KINDS;
