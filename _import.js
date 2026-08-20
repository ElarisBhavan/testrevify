/* ═══════════════════════════════════════════════════════════════
   Shared spreadsheet import
   Column names are matched loosely, so header order and casing
   do not matter. Used by patients, payers and master data.
   ═══════════════════════════════════════════════════════════════ */
(function(){

  /* ── column maps: target field → the header names people actually use ── */
  var MAPS = {
    patient: {
      internal_id:['internal id','patient id','chart id','mrn','id'],
      first_name:['first name','firstname','first','patient first name','given name'],
      middle_name:['middle name','middle','middle initial','mi'],
      last_name:['last name','lastname','last','patient last name','surname','family name'],
      dob:['dob','date of birth','birth date','birthdate'],
      sex:['sex','gender'],
      phone:['phone','contact','contact number','mobile','home phone','cell'],
      email:['email','e-mail','email address'],
      address:['address','street','patient address','mailing address'],
      relationship:['relationship','relationship to subscriber','rel'],
      language:['language','preferred language'],
      race:['race'], ethnicity:['ethnicity'],
      referred_by:['referred by','referral source','referrer'],
      preferred_location:['preferred location','location','clinic','facility'],
      /* subscriber */
      sub_first:['subscriber first name','subscriber first','guarantor first name'],
      sub_last:['subscriber last name','subscriber last','guarantor last name'],
      sub_dob:['subscriber dob','subscriber date of birth','guarantor dob'],
      sub_phone:['subscriber phone','guarantor phone'],
      sub_email:['subscriber email','guarantor email'],
      sub_address:['subscriber address','guarantor address'],
      sub_employment:['employment status','subscriber employment'],
      /* primary insurance */
      ins1_name:['insurance name','primary insurance','payer','payer name','primary payer'],
      ins1_payer_id:['payer id','primary payer id','insurance id'],
      ins1_member:['member id','policy number','primary member id','subscriber id'],
      ins1_group:['group number','group #','primary group number','group no'],
      ins1_gname:['group name','primary group name'],
      ins1_plan:['plan number','plan no','plan #'],
      ins1_eff:['effective date','primary effective date','coverage start'],
      ins1_term:['term date','primary term date','coverage end'],
      ins1_copay:['copay','primary copay','co-pay'],
      ins1_coins:['coinsurance','primary coinsurance','co-insurance'],
      ins1_auth:['authorization number','auth number','authorisation number'],
      ins1_referral:['referral number','referral #'],
      /* secondary insurance */
      ins2_name:['secondary insurance','secondary payer','secondary payer name'],
      ins2_payer_id:['secondary payer id'],
      ins2_member:['secondary member id','secondary policy number'],
      ins2_group:['secondary group number'],
      /* card */
      card_brand:['card brand','card type'],
      card_last4:['card last 4','card last four','card ending'],
      card_exp:['card expiry','card expiration','card exp'],
      /* parent or emergency contact */
      c1_name:['contact name','parent name','guardian name','emergency contact'],
      c1_rel:['contact relationship','parent relationship','guardian relationship'],
      c1_phone:['contact phone','parent phone','guardian phone','emergency phone'],
      c1_email:['contact email','parent email','guardian email'],
      c2_name:['second contact name','other contact name'],
      c2_phone:['second contact phone','other contact phone']
    },
    payer: {
      name:['payer name','name','insurance name','payer'],
      payer_id:['payer id','payerid','id','edi payer id'],
      mailing_address:['mailing address','address','claims address','payer address'],
      phone:['phone','contact','contact number','provider services'],
      fax:['fax','fax number','fax #'],
      appeal_address:['appeal address','appeals address','appeal'],
      website:['website','web','url','portal','website link'],
      plan_type:['plan type','type','line of business'],
      notes:['notes','note','remarks']
    },
    master: {
      code:['code','cpt','cpt code','hcpcs','hcpcs code','icd','icd-10','icd10',
            'icd-10 code','pos','pos code','modifier','service type','service type code'],
      description:['description','desc','long description','name','short description'],
      fee:['fee','amount','charge','allowed','rate','fee schedule'],
      category:['category','group','section','type'],
      status:['status','active']
    }
  };

  function norm(h){ return String(h||'').trim().toLowerCase().replace(/\s+/g,' ').replace(/[_.]/g,' '); }

  function buildIndex(headers, map){
    var idx = {};
    Object.keys(map).forEach(function(field){
      var wanted = map[field];
      for(var i=0;i<headers.length;i++){
        if(wanted.indexOf(norm(headers[i])) > -1){ idx[field] = i; return; }
      }
      /* nothing exact — accept a header that contains the primary name */
      for(var j=0;j<headers.length;j++){
        var h = norm(headers[j]);
        if(h && h.indexOf(wanted[0]) > -1){ idx[field] = j; return; }
      }
    });
    return idx;
  }

  /* Excel serial dates and the usual written forms all become YYYY-MM-DD */
  function toDate(v){
    if(v == null || v === '') return '';
    if(typeof v === 'number'){
      var d = new Date(Math.round((v - 25569) * 86400000));
      return d.getUTCFullYear()+'-'+String(d.getUTCMonth()+1).padStart(2,'0')+
             '-'+String(d.getUTCDate()).padStart(2,'0');
    }
    var s = String(v).trim();
    var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if(m) return m[1]+'-'+m[2].padStart(2,'0')+'-'+m[3].padStart(2,'0');
    m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if(m) return m[3]+'-'+m[1].padStart(2,'0')+'-'+m[2].padStart(2,'0');
    var d2 = new Date(s);
    if(!isNaN(d2)) return d2.getFullYear()+'-'+String(d2.getMonth()+1).padStart(2,'0')+
                          '-'+String(d2.getDate()).padStart(2,'0');
    return '';
  }
  function num(v){
    if(v == null || v === '') return 0;
    return Math.round((parseFloat(String(v).replace(/[^0-9.\-]/g,'')) || 0) * 100) / 100;
  }
  var str = v => String(v == null ? '' : v).trim();

  /* ── read a File into a grid ── */
  async function readGrid(file){
    var name = file.name.toLowerCase();
    if(/\.csv$/.test(name) || /\.txt$/.test(name)){
      var text = await file.text();
      return text.split(/\r?\n/).map(function(line){
        var out=[], cur='', q=false;
        for(var i=0;i<line.length;i++){
          var c=line[i];
          if(c === '"'){ if(q && line[i+1] === '"'){ cur+='"'; i++; } else q=!q; }
          else if(c === ',' && !q){ out.push(cur); cur=''; }
          else cur+=c;
        }
        out.push(cur);
        return out;
      }).filter(function(r){ return r.length>1 || String(r[0]||'').trim(); });
    }
    if(typeof XLSX === 'undefined')
      throw new Error('Excel support did not load. Save the file as CSV and try again.');
    var buf = await file.arrayBuffer();
    var wb = XLSX.read(buf, { type:'array', cellDates:false });
    var sh = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json(sh, { header:1, raw:true, defval:'' });
  }

  /* ── parse into records ── */
  async function parse(file, kind){
    var grid = await readGrid(file);
    if(!grid.length) return { error:'That file is empty.' };
    var headers = grid[0].map(norm);
    var map = MAPS[kind];
    var idx = buildIndex(grid[0], map);

    var required = kind === 'patient' ? ['last_name']
                 : kind === 'payer'   ? ['name']
                 : ['code'];
    var missing = required.filter(function(f){ return idx[f] == null; });
    if(missing.length){
      return { error:'Could not find a column for: ' + missing.join(', ') +
               '. Download the template to see the expected headers.' };
    }

    var get = (row, f) => idx[f] == null ? '' : row[idx[f]];
    var out = [];

    grid.slice(1).forEach(function(row, i){
      if(!row || !row.some(function(c){ return String(c||'').trim(); })) return;
      var rec = { _row: i + 2 };

      if(kind === 'patient'){
        ['internal_id','first_name','middle_name','last_name','sex','phone','email',
         'address','relationship','language','race','ethnicity','referred_by',
         'preferred_location','sub_first','sub_last','sub_phone','sub_email',
         'sub_address','sub_employment'].forEach(function(f){ rec[f] = str(get(row,f)); });
        rec.dob = toDate(get(row,'dob'));
        rec.sub_dob = toDate(get(row,'sub_dob'));
        rec.relationship = rec.relationship || 'Self';

        var ins = [];
        if(str(get(row,'ins1_name'))) ins.push({
          rank:'1', name:str(get(row,'ins1_name')), payer_id:str(get(row,'ins1_payer_id')),
          member_id:str(get(row,'ins1_member')), group_no:str(get(row,'ins1_group')),
          group_name:str(get(row,'ins1_gname')), plan_no:str(get(row,'ins1_plan')),
          effective:toDate(get(row,'ins1_eff')), term:toDate(get(row,'ins1_term')),
          copay:num(get(row,'ins1_copay')), coinsurance:num(get(row,'ins1_coins')),
          auth_no:str(get(row,'ins1_auth')), referral_no:str(get(row,'ins1_referral')),
          coverage:'', phone:'', address:''
        });
        if(str(get(row,'ins2_name'))) ins.push({
          rank:'2', name:str(get(row,'ins2_name')), payer_id:str(get(row,'ins2_payer_id')),
          member_id:str(get(row,'ins2_member')), group_no:str(get(row,'ins2_group')),
          copay:0, coinsurance:0
        });
        rec.insurances = ins;
        rec.member_id = ins.length ? ins[0].member_id : '';
        rec.payer = ins.length ? ins[0].name : '';

        var l4 = str(get(row,'card_last4')).replace(/\D/g,'').slice(-4);
        rec.card = l4 ? { last4:l4, brand:str(get(row,'card_brand'))||'Card',
                          exp:str(get(row,'card_exp')) } : null;

        var contacts = [];
        if(str(get(row,'c1_name'))) contacts.push({
          n:str(get(row,'c1_name')), r:str(get(row,'c1_rel'))||'Parent or guardian',
          p:str(get(row,'c1_phone')), e:str(get(row,'c1_email')) });
        if(str(get(row,'c2_name'))) contacts.push({
          n:str(get(row,'c2_name')), r:'Other', p:str(get(row,'c2_phone')), e:'' });
        rec.contacts = contacts;
        rec.status = 'active';
      }

      if(kind === 'payer'){
        ['name','payer_id','mailing_address','phone','fax','appeal_address',
         'website','plan_type','notes'].forEach(function(f){ rec[f] = str(get(row,f)); });
        rec.status = 'active';
      }

      if(kind === 'master'){
        rec.code = str(get(row,'code')).toUpperCase();
        rec.description = str(get(row,'description'));
        rec.category = str(get(row,'category'));
        var f = get(row,'fee');
        if(f !== '' && f != null) rec.fee = num(f);
        var st = str(get(row,'status')).toLowerCase();
        rec.status = (st === 'inactive' || st === 'false' || st === 'no') ? 'inactive' : 'active';
      }

      out.push(rec);
    });

    if(!out.length) return { error:'No data rows found beneath the header.' };
    return { rows: out, matched: Object.keys(idx).length };
  }

  /* ── templates ── */
  var TEMPLATES = {
    patient: {
      file: 'reviflow-patient-import-template.csv',
      headers: [
        'Internal ID','First Name','Middle Name','Last Name','DOB','Sex','Phone','Email',
        'Address','Relationship','Preferred Language','Race','Ethnicity','Referred By',
        'Preferred Location',
        'Subscriber First Name','Subscriber Last Name','Subscriber DOB','Subscriber Phone',
        'Subscriber Email','Subscriber Address','Employment Status',
        'Insurance Name','Payer ID','Member ID','Group Number','Group Name','Plan Number',
        'Effective Date','Term Date','Copay','Coinsurance','Authorization Number','Referral Number',
        'Secondary Insurance','Secondary Payer ID','Secondary Member ID','Secondary Group Number',
        'Card Brand','Card Last 4','Card Expiry',
        'Contact Name','Contact Relationship','Contact Phone','Contact Email',
        'Second Contact Name','Second Contact Phone'
      ],
      sample: [
        ['','Bhavan','','Kalyan','1988-04-12','Male','(512) 555-0184','b.kalyan@example.com',
         '211 W 5th St, Justin, TX 76247','Self','English','','','Dr. Dana Whitfield','Grateful Heart Counseling',
         '','','','','','','Employed full time',
         'Blue Cross Blue Shield of Texas','84980','BNF821267311','444903','BNSF Railway','PPO Plus',
         '2026-01-01','','30','20','','',
         '','','','',
         'Visa','4242','09/28',
         '','','','',
         '',''],
        ['','Maya','R','Alvarez','2019-08-03','Female','(512) 555-0199','',
         '14712 Lost Wagon St, Justin, TX 76247','Child','Spanish','','','','Grateful Heart Counseling',
         'Courtney','Alvarez','1985-02-11','(512) 555-0177','c.alvarez@example.com',
         '14712 Lost Wagon St, Justin, TX 76247','Employed full time',
         'Aetna','60054','W1234567801','88231','Acme Corp','',
         '2026-01-01','','25','20','','',
         '','','','',
         '','','',
         'Courtney Alvarez','Mother','(512) 555-0177','c.alvarez@example.com',
         'Luis Alvarez','(512) 555-0166']
      ]
    },
    payer: {
      file: 'reviflow-payer-import-template.csv',
      headers: ['Payer Name','Payer ID','Mailing Address','Phone','Fax',
                'Appeal Address','Website','Plan Type','Notes'],
      sample: [
        ['Blue Cross Blue Shield of Texas','84980','PO Box 660044, Dallas, TX 75266',
         '(800) 451-0287','(972) 766-2000','PO Box 660044, Dallas, TX 75266',
         'https://www.bcbstx.com','PPO','Submit corrected claims within 180 days'],
        ['Aetna','60054','PO Box 981106, El Paso, TX 79998','(888) 632-3862',
         '(859) 455-8650','PO Box 14020, Lexington, KY 40512','https://www.aetna.com','PPO','']
      ]
    },
    master: {
      file: 'reviflow-code-import-template.csv',
      headers: ['Code','Description','Fee','Category','Status'],
      sample: [
        ['99213','Office visit, established patient, low complexity','120','Evaluation and management','active'],
        ['90837','Psychotherapy, 60 minutes','180','Behavioral health','active']
      ]
    }
  };

  function download(name, text){
    var blob = new Blob([text], { type:'text/csv;charset=utf-8;' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function(){ URL.revokeObjectURL(a.href); }, 900);
  }
  function csvRow(cells){
    return cells.map(function(c){
      return '"' + String(c == null ? '' : c).replace(/"/g,'""') + '"';
    }).join(',');
  }
  function template(kind, opts){
    var t = TEMPLATES[kind];
    if(!t) return;
    var headers = (opts && opts.headers) || t.headers;
    var sample  = (opts && opts.sample)  || t.sample;
    var lines = [csvRow(headers)].concat(sample.map(csvRow));
    download((opts && opts.file) || t.file, lines.join('\n'));
  }

  window.RFImport = {
    parse: parse,
    template: template,
    download: download,
    csvRow: csvRow,
    templates: TEMPLATES,
    toDate: toDate,
    num: num
  };
})();
