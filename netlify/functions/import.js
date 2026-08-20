/*
 * Revify RCM Excel/CSV import endpoint.
 * The browser parses the workbook and sends normalized JSON rows here.
 * PostgreSQL is the only persistent store.
 */
const L = require('./_lib');
const { columns } = require('./data');
const crypto = require('crypto');

const MAX_ROWS = 10000;
const ALLOWED = new Set([
  'patient','appt','encounter','claim','task','provider','org','payer',
  'master','credentialing','history','payment'
]);

function keyFor(kind, rec, sourceName, rowNo){
  if(rec.source_key) return String(rec.source_key).trim().slice(0,250);
  if(kind==='claim' && rec.claim_no) return 'claim:'+String(rec.claim_no).trim().slice(0,240);
  if(kind==='patient' && rec.internal_id) return 'patient:'+String(rec.internal_id).trim().slice(0,240);
  if(kind==='patient' && rec.patient_id) return 'patient:'+String(rec.patient_id).trim().slice(0,240);
  if(kind==='patient' && rec.member_id)
    return 'patient:'+String(rec.member_id).trim()+':'+String(rec.dob||'')+':'+String(rec.last_name||'').trim().toLowerCase();
  if(kind==='provider' && rec.npi) return 'provider:npi:'+String(rec.npi).trim();
  if(kind==='org' && rec.npi) return 'org:npi:'+String(rec.npi).trim();
  if(kind==='payer' && rec.payer_id) return 'payer:'+String(rec.payer_id).trim();
  if(rec.external_id) return kind+':external:'+String(rec.external_id).trim().slice(0,220);
  return crypto.createHash('sha256')
    .update(`${sourceName||'import'}|${kind}|${rowNo}|${JSON.stringify(rec)}`)
    .digest('hex');
}

exports.handler = async (event) => {
  if(event.httpMethod !== 'POST') return L.J(405,{error:'method'});
  const gate = await L.requireSession(event, ['admin','supervisor']);
  if(gate.error) return gate.error;

  let body={};
  try{ body=event.body ? JSON.parse(event.body) : {}; }catch{
    return L.J(400,{error:'bad_json'});
  }

  const kind=String(body.kind||'').toLowerCase();
  const rows=Array.isArray(body.rows) ? body.rows : [];
  const sourceName=String(body.sourceName||'excel-import').slice(0,200);

  if(!ALLOWED.has(kind)) return L.J(400,{error:'unsupported_kind'});
  if(!rows.length) return L.J(400,{error:'no_rows'});
  if(rows.length>MAX_ROWS) return L.J(413,{error:'too_many_rows',max:MAX_ROWS});

  try{
    const sql=L.db();
    let inserted=0, updated=0, failed=0;
    const errors=[];

    await sql.begin(async tx=>{
      for(let i=0;i<rows.length;i++){
        const rec={...(rows[i]||{})};
        try{
          if(!Object.keys(rec).length) throw new Error('Empty row');
          const sourceKey=keyFor(kind,rec,sourceName,i+2);
          rec.source_key=sourceKey;
          rec.updated_at=new Date().toISOString();
          if(!rec.created_at) rec.created_at=new Date().toISOString();
          if(!rec.created_by) rec.created_by=gate.session.username;
          const c=columns(kind,rec);

          const existing=await tx`
            select id, data from app_records
            where kind=${kind} and source_key=${sourceKey}
              and deleted_at is null limit 1`;

          if(existing.length){
            const merged={...existing[0].data,...rec,id:Number(existing[0].id),
              updated_at:new Date().toISOString(),updated_by:gate.session.username};
            const cc=columns(kind,merged);
            await tx`update app_records set
              org_id=${cc.org_id}, patient_ref=${cc.patient_ref},
              provider_id=${cc.provider_id}, on_date=${cc.on_date},
              status=${cc.status}, search=${cc.search},
              source_key=${sourceKey}, data=${tx.json(merged)},
              updated_by=${gate.session.username}, updated_at=now()
              where kind=${kind} and id=${Number(existing[0].id)}`;
            updated++;
          }else{
            const n=await tx`select nextval('app_records_id_seq') as id`;
            const id=Number(n[0].id);
            rec.id=id;
            await tx`insert into app_records
              (kind,id,org_id,patient_ref,provider_id,on_date,status,search,
               source_key,data,created_by,updated_by)
              values (${kind},${id},${c.org_id},${c.patient_ref},${c.provider_id},
                ${c.on_date},${c.status},${c.search},${sourceKey},${tx.json(rec)},
                ${gate.session.username},${gate.session.username})`;
            inserted++;
          }
        }catch(e){
          failed++;
          if(errors.length<100) errors.push({row:i+2,error:String(e.message||e)});
        }
      }
    });

    await L.audit(event,{actor_id:gate.session.id,actor:gate.session.username,
      action:'data_import',entity:kind,detail:{source:sourceName,inserted,updated,failed}});
    return L.J(200,{ok:true,kind,sourceName,total:rows.length,inserted,updated,failed,errors});
  }catch(e){
    console.error('import failed',e);
    return L.J(500,{error:'server',message:String(e.message||e)});
  }
};
