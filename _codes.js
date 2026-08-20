/* Shared code sets for typeahead — CPT with default fees, ICD-10 descriptions */
window.RFCodes = {
  cpt: [
    {code:'99202',desc:'Office visit, new patient, straightforward',fee:75},
    {code:'99203',desc:'Office visit, new patient, low complexity',fee:110},
    {code:'99204',desc:'Office visit, new patient, moderate complexity',fee:170},
    {code:'99205',desc:'Office visit, new patient, high complexity',fee:220},
    {code:'99211',desc:'Office visit, established patient, minimal',fee:35},
    {code:'99212',desc:'Office visit, established patient, straightforward',fee:65},
    {code:'99213',desc:'Office visit, established patient, low complexity',fee:120},
    {code:'99214',desc:'Office visit, established patient, moderate complexity',fee:180},
    {code:'99215',desc:'Office visit, established patient, high complexity',fee:245},
    {code:'99381',desc:'Preventive visit, new patient, infant',fee:150},
    {code:'99391',desc:'Preventive visit, established, infant',fee:130},
    {code:'99395',desc:'Preventive visit, established, 18–39 years',fee:165},
    {code:'99396',desc:'Preventive visit, established, 40–64 years',fee:175},
    {code:'99401',desc:'Preventive counselling, 15 minutes',fee:60},
    {code:'99441',desc:'Telephone evaluation, 5–10 minutes',fee:55},
    {code:'99442',desc:'Telephone evaluation, 11–20 minutes',fee:85},
    {code:'99443',desc:'Telephone evaluation, 21–30 minutes',fee:115},
    {code:'90791',desc:'Psychiatric diagnostic evaluation',fee:210},
    {code:'90832',desc:'Psychotherapy, 30 minutes',fee:95},
    {code:'90834',desc:'Psychotherapy, 45 minutes',fee:135},
    {code:'90837',desc:'Psychotherapy, 60 minutes',fee:180},
    {code:'90846',desc:'Family psychotherapy without patient',fee:150},
    {code:'90847',desc:'Family psychotherapy with patient',fee:165},
    {code:'90853',desc:'Group psychotherapy',fee:70},
    {code:'96127',desc:'Brief emotional or behavioural assessment',fee:25},
    {code:'96160',desc:'Health risk assessment instrument',fee:20},
    {code:'93000',desc:'Electrocardiogram, complete',fee:65},
    {code:'80053',desc:'Comprehensive metabolic panel',fee:48},
    {code:'80061',desc:'Lipid panel',fee:42},
    {code:'83036',desc:'Haemoglobin A1c',fee:38},
    {code:'85025',desc:'Complete blood count with differential',fee:35},
    {code:'81002',desc:'Urinalysis, non-automated, without microscopy',fee:18},
    {code:'36415',desc:'Collection of venous blood by venipuncture',fee:15},
    {code:'90471',desc:'Immunisation administration, first vaccine',fee:30},
    {code:'90686',desc:'Influenza vaccine, quadrivalent',fee:45},
    {code:'20610',desc:'Arthrocentesis, major joint',fee:145},
    {code:'11042',desc:'Debridement, subcutaneous tissue',fee:190},
    {code:'12001',desc:'Simple repair of superficial wound, 2.5 cm or less',fee:135},
    {code:'17110',desc:'Destruction of benign lesions, up to 14',fee:120},
    {code:'69210',desc:'Removal of impacted cerumen, one ear',fee:70}
  ],
  icd: [
    {code:'E11.9',desc:'Type 2 diabetes mellitus without complications'},
    {code:'E11.65',desc:'Type 2 diabetes mellitus with hyperglycaemia'},
    {code:'E78.5',desc:'Hyperlipidaemia, unspecified'},
    {code:'E66.9',desc:'Obesity, unspecified'},
    {code:'E03.9',desc:'Hypothyroidism, unspecified'},
    {code:'I10',desc:'Essential (primary) hypertension'},
    {code:'I25.10',desc:'Atherosclerotic heart disease of native coronary artery'},
    {code:'I48.91',desc:'Unspecified atrial fibrillation'},
    {code:'J06.9',desc:'Acute upper respiratory infection, unspecified'},
    {code:'J20.9',desc:'Acute bronchitis, unspecified'},
    {code:'J45.909',desc:'Unspecified asthma, uncomplicated'},
    {code:'J44.9',desc:'Chronic obstructive pulmonary disease, unspecified'},
    {code:'K21.9',desc:'Gastro-oesophageal reflux disease without oesophagitis'},
    {code:'K59.00',desc:'Constipation, unspecified'},
    {code:'M54.5',desc:'Low back pain'},
    {code:'M54.2',desc:'Cervicalgia'},
    {code:'M25.561',desc:'Pain in right knee'},
    {code:'M25.562',desc:'Pain in left knee'},
    {code:'M79.604',desc:'Pain in right leg'},
    {code:'N39.0',desc:'Urinary tract infection, site not specified'},
    {code:'R51.9',desc:'Headache, unspecified'},
    {code:'R05.9',desc:'Cough, unspecified'},
    {code:'R10.9',desc:'Unspecified abdominal pain'},
    {code:'R53.83',desc:'Other fatigue'},
    {code:'R73.09',desc:'Other abnormal glucose'},
    {code:'F32.9',desc:'Major depressive disorder, single episode, unspecified'},
    {code:'F33.1',desc:'Major depressive disorder, recurrent, moderate'},
    {code:'F41.1',desc:'Generalised anxiety disorder'},
    {code:'F41.9',desc:'Anxiety disorder, unspecified'},
    {code:'F43.10',desc:'Post-traumatic stress disorder, unspecified'},
    {code:'F43.21',desc:'Adjustment disorder with depressed mood'},
    {code:'F90.9',desc:'Attention-deficit hyperactivity disorder, unspecified type'},
    {code:'F84.0',desc:'Autistic disorder'},
    {code:'G47.00',desc:'Insomnia, unspecified'},
    {code:'G43.909',desc:'Migraine, unspecified, not intractable'},
    {code:'Z00.00',desc:'General adult medical examination without abnormal findings'},
    {code:'Z00.129',desc:'Routine child health examination without abnormal findings'},
    {code:'Z23',desc:'Encounter for immunisation'},
    {code:'Z79.4',desc:'Long term (current) use of insulin'},
    {code:'Z71.3',desc:'Dietary counselling and surveillance'}
  ],
  pos: [
    {code:'11',desc:'Office'},{code:'02',desc:'Telehealth — other than patient home'},
    {code:'10',desc:'Telehealth — patient home'},{code:'12',desc:'Home'},
    {code:'19',desc:'Off campus outpatient hospital'},{code:'22',desc:'On campus outpatient hospital'},
    {code:'21',desc:'Inpatient hospital'},{code:'23',desc:'Emergency room'},
    {code:'81',desc:'Independent laboratory'},{code:'99',desc:'Other place of service'}
  ],
  findCpt: function(q){
    q=String(q||'').toLowerCase().trim(); if(!q)return this.cpt.slice(0,12);
    return this.cpt.filter(function(c){
      return c.code.toLowerCase().indexOf(q)===0 || c.desc.toLowerCase().indexOf(q)>-1;
    }).slice(0,25);
  },
  findIcd: function(q){
    q=String(q||'').toLowerCase().trim(); if(!q)return this.icd.slice(0,12);
    return this.icd.filter(function(c){
      return c.code.toLowerCase().indexOf(q)===0 || c.desc.toLowerCase().indexOf(q)>-1;
    }).slice(0,25);
  },
  cptFee: function(code){
    var c=this.cpt.filter(function(x){return x.code===code;})[0];
    return c?c.fee:0;
  },
  cptDesc: function(code){
    var c=this.cpt.filter(function(x){return x.code===code;})[0];
    return c?c.desc:'';
  },
  icdDesc: function(code){
    var c=this.icd.filter(function(x){return x.code===code;})[0];
    return c?c.desc:'';
  }
};


/* ═══════════════════════════════════════════════════════════════
   Master data bridge
   Codes entered by an administrator take precedence. The built-in
   lists above are the fallback when a code set has not been loaded.
   Call RFCodes.sync() once per page after RFStore is ready.
   ═══════════════════════════════════════════════════════════════ */
(function(){
  var C = window.RFCodes;
  C._admin = { cpt:null, hcpcs:null, icd:null, pos:null, modifier:null, servicetype:null, payers:null };
  C.ready = false;

  C.sync = async function(){
    if(typeof RFStore === 'undefined') return false;
    try{
      await RFStore.ready();
      var cpt   = await RFStore.master('cpt');
      var hcpcs = await RFStore.master('hcpcs');
      var icd   = await RFStore.master('icd10');
      var pos   = await RFStore.master('pos');
      var mod   = await RFStore.master('modifier');
      var stc   = await RFStore.master('servicetype');
      var fee   = await RFStore.master('fee');
      var pay   = await RFStore.payers();

      var feeMap = {};
      fee.forEach(function(f){ if(f.fee != null) feeMap[String(f.code)] = Number(f.fee); });

      function shape(list){
        return list.filter(function(x){ return x.status !== 'inactive'; })
          .map(function(x){
            return { code:String(x.code), desc:x.description||x.desc||'',
                     fee: feeMap[String(x.code)] != null ? feeMap[String(x.code)]
                          : (x.fee != null ? Number(x.fee) : 0) };
          });
      }

      C._admin.cpt         = cpt.length   ? shape(cpt)   : null;
      C._admin.hcpcs       = hcpcs.length ? shape(hcpcs) : null;
      C._admin.icd         = icd.length   ? shape(icd)   : null;
      C._admin.pos         = pos.length   ? shape(pos)   : null;
      C._admin.modifier    = mod.length   ? shape(mod)   : null;
      C._admin.servicetype = stc.length   ? shape(stc)   : null;
      C._admin.payers      = pay;
      C.ready = true;
      return true;
    }catch(e){ console.warn('code sync skipped', e); return false; }
  };

  /* CPT and HCPCS share one search, since both are procedure codes */
  function procedures(){
    if(C._admin.cpt || C._admin.hcpcs)
      return (C._admin.cpt||[]).concat(C._admin.hcpcs||[]);
    return C.cpt;
  }
  function diagnoses(){ return C._admin.icd || C.icd; }

  C.findCpt = function(q){
    var list = procedures();
    q = String(q||'').toLowerCase().trim();
    if(!q) return list.slice(0,40);
    return list.filter(function(c){
      return c.code.toLowerCase().indexOf(q) === 0 || c.desc.toLowerCase().indexOf(q) > -1;
    }).slice(0,60);
  };
  C.findIcd = function(q){
    var list = diagnoses();
    q = String(q||'').toLowerCase().trim();
    if(!q) return list.slice(0,40);
    return list.filter(function(c){
      return c.code.toLowerCase().indexOf(q) === 0 || c.desc.toLowerCase().indexOf(q) > -1;
    }).slice(0,60);
  };
  C.cptFee = function(code){
    var c = procedures().filter(function(x){ return x.code === String(code); })[0];
    return c ? (c.fee||0) : 0;
  };
  C.cptDesc = function(code){
    var c = procedures().filter(function(x){ return x.code === String(code); })[0];
    return c ? c.desc : '';
  };
  C.icdDesc = function(code){
    var c = diagnoses().filter(function(x){ return x.code === String(code); })[0];
    return c ? c.desc : '';
  };

  /* place of service and service type, admin-first */
  C.posList = function(){ return C._admin.pos || C.pos; };
  C.posDesc = function(code){
    var p = C.posList().filter(function(x){ return String(x.code) === String(code); })[0];
    return p ? p.desc : '';
  };
  C.modifiers = function(){ return C._admin.modifier || []; };

  /* service types are what the eligibility form offers */
  C.SERVICE_FALLBACK = [
    {code:'30',desc:'Health benefit plan coverage'},
    {code:'98',desc:'Professional visit, office'},
    {code:'MH',desc:'Mental health'},
    {code:'47',desc:'Hospital'},
    {code:'86',desc:'Emergency services'},
    {code:'88',desc:'Pharmacy'},
    {code:'UC',desc:'Urgent care'},
    {code:'35',desc:'Dental care'},
    {code:'AL',desc:'Vision'}
  ];
  C.serviceTypes = function(){ return C._admin.servicetype || C.SERVICE_FALLBACK; };
  C.serviceDesc = function(code){
    var s = C.serviceTypes().filter(function(x){ return String(x.code) === String(code); })[0];
    return s ? s.desc : '';
  };

  /* payers, for every picker that needs one */
  C.payers = function(){ return C._admin.payers || []; };
  C.findPayers = function(q){
    var list = C.payers();
    q = String(q||'').toLowerCase().trim();
    if(!q) return list.slice(0,40);
    return list.filter(function(p){
      return String(p.name||'').toLowerCase().indexOf(q) > -1 ||
             String(p.payer_id||'').toLowerCase().indexOf(q) === 0;
    }).slice(0,60);
  };
  /* "60054 — Aetna" for the eligibility dropdown */
  C.payerLabel = function(p){
    return (p.payer_id ? p.payer_id + ' — ' : '') + (p.name||'');
  };

  /* fill any <select data-rf-codes="pos|servicetype|payer"> on the page */
  C.fillSelects = function(scope){
    (scope||document).querySelectorAll('[data-rf-codes]').forEach(function(sel){
      var kind = sel.dataset.rfCodes, keep = sel.value;
      var list = kind === 'pos' ? C.posList()
               : kind === 'servicetype' ? C.serviceTypes()
               : kind === 'payer' ? C.payers().map(function(p){
                   return { code:p.payer_id||p.name, desc:p.name, _p:p }; })
               : [];
      if(!list.length) return;
      var ph = sel.dataset.rfPlaceholder || 'Select';
      sel.innerHTML = '<option value="">'+ph+'</option>' + list.map(function(x){
        var label = kind === 'payer' ? C.payerLabel(x._p) : (x.code + ' — ' + x.desc);
        return '<option value="'+String(x.code).replace(/"/g,'&quot;')+'">'+
               String(label).replace(/</g,'&lt;')+'</option>';
      }).join('');
      if(keep) sel.value = keep;
    });
  };
})();
