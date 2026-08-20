/* ═══════════════════════════════════════════════════════════════
   Shared 837P claim editor.

   RFClaimForm.open(claim, {
     title, subtitle, context:{provs, orgs, patient}, onSave(claim){}
   })

   The patient chart and the claims list both call this, so a claim is
   edited in one place and the two screens cannot drift apart.
   ═══════════════════════════════════════════════════════════════ */
(function(){

  /* A second <script> tag would otherwise re-run this and replace RFClaimForm
     with a fresh instance whose markup has not been built, so the editor would
     open empty. Bail out if we are already here. */
  if(window.RFClaimForm) return;

  var C = null;          /* the claim being edited */
  var OPTS = {};
  var SEC = 'payer';
  var BUILT = false;

  var esc = function(v){
    return String(v==null?'':v).replace(/[&<>"]/g,function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});
  };
  var money = function(n){ return '$'+(Math.round((+n||0)*100)/100).toFixed(2); };
  var num = function(v){ return Math.round((parseFloat(v)||0)*100)/100; };
  var $ = function(id){ return document.getElementById(id); };
  var LETTERS = 'ABCDEFGHIJKL'.split('');

  function fmtShort(d){
    if(!d) return '';
    var p = String(d).split('-');
    if(p.length<3) return d;
    return new Date(+p[0],(+p[1]||1)-1,+p[2]||1,12)
      .toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'});
  }

  /* ── markup, injected once ── */
  function build(){
    if(BUILT) return;
    BUILT = true;

    var scrim = document.createElement('div');
    scrim.className = 'cf-scrim';
    scrim.id = 'cfScrim';
    document.body.appendChild(scrim);

    var el = document.createElement('div');
    el.className = 'cf';
    el.id = 'cfRoot';
    el.setAttribute('role','dialog');
    el.setAttribute('aria-modal','true');
    el.innerHTML = HTML();
    document.body.appendChild(el);

    scrim.addEventListener('click', close);
    document.addEventListener('keydown', function(e){
      if(e.key==='Escape' && el.classList.contains('on')) close();
    });
    wire();
  }

  function HTML(){
    return ''+
    '<div class="cf-head">'+
      '<span class="cf-ic"><svg viewBox="0 0 24 24"><path d="M7 4h8l4 4v12a1 1 0 01-1 1H7a1 1 0 01-1-1V5a1 1 0 011-1z"/><path d="M9 13l2 2 4-5"/></svg></span>'+
      '<span class="cf-ttl"><h3 id="cfTitle">Create claim</h3><p id="cfSub">—</p></span>'+
      '<span class="cf-ref" id="cfRef" hidden></span>'+
      '<span class="cf-state" id="cfState">DRAFT</span>'+
      '<button class="cf-x" id="cfClose" aria-label="Close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>'+
    '</div>'+

    '<div class="cf-nav" id="cfNav">'+
      '<button data-s="payer" class="on">Payer</button>'+
      '<button data-s="billing">Billing provider</button>'+
      '<button data-s="sub">Subscriber</button>'+
      '<button data-s="pat">Patient</button>'+
      '<button data-s="claim">Claim<span class="n" id="cfDxN">0</span></button>'+
      '<button data-s="lines">Service lines<span class="n" id="cfLnN">0</span></button>'+
      '<button data-s="review">Review</button>'+
    '</div>'+

    '<div class="cf-body" id="cfBody">'+

      /* ── payer ── */
      '<section class="cf-sec on" data-sec="payer">'+
        '<div class="cf-hd"><h4>Payer</h4><p>Who the claim goes to, and how it travels.</p></div>'+
        '<div class="cf-send" id="cfSend">'+
          '<label class="cf-opt on"><input type="radio" name="cfSendM" value="electronic" checked>'+
            '<span class="i"><svg viewBox="0 0 24 24"><path d="M4 7h16v10H4z"/><path d="M4 7l8 6 8-6"/></svg></span>'+
            '<span><b>Electronic</b><small>Routed to the payer through Stedi as an 837P</small></span></label>'+
          '<label class="cf-opt"><input type="radio" name="cfSendM" value="paper">'+
            '<span class="i"><svg viewBox="0 0 24 24"><path d="M6 3h9l4 4v14H6z"/><path d="M15 3v4h4"/><path d="M9 12h7M9 16h5"/></svg></span>'+
            '<span><b>Paper</b><small>Stedi prints a CMS-1500 and posts it</small></span></label>'+
        '</div>'+
        '<div id="cfPaperNote"></div>'+
        '<div class="cf-grid">'+
          '<label class="cf-f s5"><span>Payer name <u>*</u></span>'+
            '<input type="text" id="cf_payer" list="cfPayerList" autocomplete="off"></label>'+
          '<label class="cf-f s3 elec"><span>Payer ID <u>*</u></span>'+
            '<input type="text" id="cf_payerid" placeholder="84980">'+
            '<span class="hint" id="cf_pidhint">Filled from Admin → Payers.</span></label>'+
          '<label class="cf-f s2 elec"><span>Filing code</span>'+
            '<select id="cf_filing">'+
              '<option value="CI">CI — Commercial</option><option value="MC">MC — Medicaid</option>'+
              '<option value="MB">MB — Medicare B</option><option value="BL">BL — BCBS</option>'+
              '<option value="HM">HM — HMO</option><option value="TV">TV — Title V</option>'+
              '<option value="WC">WC — Workers comp</option><option value="ZZ">ZZ — Other</option>'+
            '</select></label>'+
          '<label class="cf-f s2 elec"><span>Responsibility</span>'+
            '<select id="cf_resp"><option value="P">P — Primary</option>'+
              '<option value="S">S — Secondary</option><option value="T">T — Tertiary</option></select></label>'+
          '<label class="cf-f s8"><span>Payer address <u class="mreq" hidden>*</u></span>'+
            '<input type="text" id="cf_payeraddr" placeholder="From Admin → Payers">'+
            '<span class="hint" id="cf_addrhint">Where a paper claim would be posted.</span></label>'+
          '<label class="cf-f s4 elec"><span>Submitter name</span><input type="text" id="cf_submitter"></label>'+
        '</div>'+
        '<datalist id="cfPayerList"></datalist>'+
      '</section>'+

      /* ── billing ── */
      '<section class="cf-sec" data-sec="billing">'+
        '<div class="cf-hd"><h4>Billing provider</h4><p>Who is being paid.</p></div>'+
        '<div class="cf-grid">'+
          '<label class="cf-f s6"><span>Organisation <u>*</u></span><input type="text" id="cf_orgname"></label>'+
          '<label class="cf-f s3"><span>Billing NPI <u>*</u></span><input type="text" id="cf_orgnpi" maxlength="10"></label>'+
          '<label class="cf-f s3"><span>Tax ID <u>*</u></span><input type="text" id="cf_taxid"></label>'+
          '<label class="cf-f s3"><span>Taxonomy</span><input type="text" id="cf_taxonomy" placeholder="207Q00000X"></label>'+
          '<label class="cf-f s3"><span>Phone</span><input type="tel" id="cf_orgphone"></label>'+
          '<label class="cf-f s6"><span>Address <u>*</u></span><input type="text" id="cf_orgaddr"></label>'+
          '<label class="cf-f s5"><span>City <u>*</u></span><input type="text" id="cf_orgcity"></label>'+
          '<label class="cf-f s3"><span>State <u>*</u></span><input type="text" id="cf_orgstate" maxlength="2" style="text-transform:uppercase"></label>'+
          '<label class="cf-f s4"><span>ZIP <u>*</u></span><input type="text" id="cf_orgzip" maxlength="10">'+
            '<span class="hint">Nine digits preferred.</span></label>'+
        '</div>'+

        '<div class="cf-hd sub"><h4>Rendering provider</h4><p>Sent on every service line.</p></div>'+
        '<div class="cf-grid">'+
          '<label class="cf-f s5"><span>Provider</span><select id="cf_provsel"></select></label>'+
          '<label class="cf-f s3"><span>First name</span><input type="text" id="cf_provfirst"></label>'+
          '<label class="cf-f s4"><span>Last name</span><input type="text" id="cf_provlast"></label>'+
          '<label class="cf-f s4"><span>Rendering NPI</span><input type="text" id="cf_provnpi" maxlength="10"></label>'+
          '<label class="cf-f s4"><span>Taxonomy</span><input type="text" id="cf_provtax"></label>'+
        '</div>'+

        '<div class="cf-hd sub"><h4>Service facility</h4><p>Where the service happened, if not the billing address.</p></div>'+
        '<div class="cf-grid">'+
          '<label class="cf-f s6"><span>Facility name</span><input type="text" id="cf_facname"></label>'+
          '<label class="cf-f s3"><span>Facility NPI</span><input type="text" id="cf_facnpi" maxlength="10"></label>'+
          '<label class="cf-f s6"><span>Address</span><input type="text" id="cf_facaddr"></label>'+
          '<label class="cf-f s3"><span>City</span><input type="text" id="cf_faccity"></label>'+
          '<label class="cf-f s2"><span>State</span><input type="text" id="cf_facstate" maxlength="2" style="text-transform:uppercase"></label>'+
          '<label class="cf-f s3"><span>ZIP</span><input type="text" id="cf_faczip" maxlength="10"></label>'+
        '</div>'+
      '</section>'+

      /* ── subscriber ── */
      '<section class="cf-sec" data-sec="sub">'+
        '<div class="cf-hd"><h4>Subscriber</h4><p>The person named on the policy.</p></div>'+
        '<div class="cf-grid">'+
          '<label class="cf-f s4"><span>Relationship to patient</span>'+
            '<select id="cf_rel"><option value="18">18 — Self</option><option value="01">01 — Spouse</option>'+
              '<option value="19">19 — Child</option><option value="G8">G8 — Other</option></select>'+
            '<span class="hint" id="cf_relnote">When the patient is the subscriber, the patient loop is omitted.</span></label>'+
          '<label class="cf-f s4"><span>Member ID <u>*</u></span><input type="text" id="cf_member"></label>'+
          '<label class="cf-f s4"><span>Group number</span><input type="text" id="cf_group"></label>'+
          '<label class="cf-f s4"><span>First name <u>*</u></span><input type="text" id="cf_subfirst"></label>'+
          '<label class="cf-f s4"><span>Last name <u>*</u></span><input type="text" id="cf_sublast"></label>'+
          '<label class="cf-f s2"><span>Date of birth <u>*</u></span><input type="date" id="cf_subdob" min="1900-01-01" max="2100-12-31"></label>'+
          '<label class="cf-f s2"><span>Sex</span><select id="cf_subsex"><option value="">—</option>'+
            '<option value="F">F</option><option value="M">M</option><option value="U">U</option></select></label>'+
          '<label class="cf-f s6"><span>Address</span><input type="text" id="cf_subaddr"></label>'+
          '<label class="cf-f s3"><span>City</span><input type="text" id="cf_subcity"></label>'+
          '<label class="cf-f s2"><span>State</span><input type="text" id="cf_substate" maxlength="2" style="text-transform:uppercase"></label>'+
          '<label class="cf-f s3"><span>ZIP</span><input type="text" id="cf_subzip" maxlength="10"></label>'+
        '</div>'+
      '</section>'+

      /* ── patient ── */
      '<section class="cf-sec" data-sec="pat">'+
        '<div class="cf-hd"><h4>Patient</h4><p>Sent only when the patient is not the subscriber.</p></div>'+
        '<div id="cf_patskip"></div>'+
        '<div class="cf-grid" id="cf_patfields">'+
          '<label class="cf-f s4"><span>First name <u>*</u></span><input type="text" id="cf_patfirst"></label>'+
          '<label class="cf-f s4"><span>Last name <u>*</u></span><input type="text" id="cf_patlast"></label>'+
          '<label class="cf-f s2"><span>Date of birth <u>*</u></span><input type="date" id="cf_patdob" min="1900-01-01" max="2100-12-31"></label>'+
          '<label class="cf-f s2"><span>Sex</span><select id="cf_patsex"><option value="">—</option>'+
            '<option value="F">F</option><option value="M">M</option><option value="U">U</option></select></label>'+
          '<label class="cf-f s6"><span>Address</span><input type="text" id="cf_pataddr"></label>'+
          '<label class="cf-f s3"><span>City</span><input type="text" id="cf_patcity"></label>'+
          '<label class="cf-f s2"><span>State</span><input type="text" id="cf_patstate" maxlength="2" style="text-transform:uppercase"></label>'+
          '<label class="cf-f s3"><span>ZIP</span><input type="text" id="cf_patzip" maxlength="10"></label>'+
        '</div>'+
      '</section>'+

      /* ── claim ── */
      '<section class="cf-sec" data-sec="claim">'+
        '<div class="cf-hd"><h4>Claim information</h4><p>How this claim is filed.</p></div>'+
        '<div class="cf-grid">'+
          '<label class="cf-f s4"><span>Patient control number <u>*</u></span><input type="text" id="cf_ctrl">'+
            '<span class="hint">Your reference, returned on the remittance.</span></label>'+
          '<label class="cf-f s2"><span>Total charge</span><input type="text" id="cf_total" readonly></label>'+
          '<label class="cf-f s3"><span>Place of service <u>*</u></span><select id="cf_pos"></select></label>'+
          '<label class="cf-f s3"><span>Date of service</span><input type="date" id="cf_dos" min="1900-01-01" max="2100-12-31"></label>'+
          '<label class="cf-f s5"><span>Submission type</span>'+
            '<select id="cf_freq"><option value="1">1 — Original claim</option>'+
              '<option value="7">7 — Corrected claim (replaces the original)</option>'+
              '<option value="8">8 — Void or cancel a prior claim</option></select>'+
            '<span class="hint" id="cf_freqhint">An original claim the payer has not seen.</span></label>'+
          '<label class="cf-f s4"><span>Original claim number <u class="oreq" hidden>*</u></span>'+
            '<input type="text" id="cf_origref" placeholder="The payer\'s claim number">'+
            '<span class="hint" id="cf_orighint">Only for a correction or void.</span></label>'+
          '<label class="cf-f s3"><span>Prior authorisation</span><input type="text" id="cf_auth"></label>'+
          '<label class="cf-f s3"><span>Referral number</span><input type="text" id="cf_referral"></label>'+
          '<label class="cf-f s3"><span>Signature on file</span>'+
            '<select id="cf_sig"><option value="Y">Yes</option><option value="N">No</option></select></label>'+
          '<label class="cf-f s3"><span>Accept assignment</span>'+
            '<select id="cf_assign"><option value="Y">Yes</option><option value="N">No</option></select></label>'+
          '<label class="cf-f s3"><span>Release of information</span>'+
            '<select id="cf_release"><option value="Y">Y — Signed statement</option>'+
              '<option value="I">I — Informed consent</option></select></label>'+
        '</div>'+

        '<div class="cf-hd sub"><h4>Diagnoses</h4><p>In pointer order. A is the principal, up to twelve.</p></div>'+
        '<div class="cf-dx" id="cf_dxlist"></div>'+
        '<button type="button" class="cf-add" id="cf_adddx" style="margin-top:10px">'+
          '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>Add diagnosis</button>'+
      '</section>'+

      /* ── lines ── */
      '<section class="cf-sec" data-sec="lines">'+
        '<div class="cf-hd"><h4>Service lines</h4><p>Each procedure billed, with the diagnoses it supports.</p></div>'+
        '<div id="cf_lines"></div>'+
        '<button type="button" class="cf-add" id="cf_addline">'+
          '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>Add service line</button>'+
        '<div class="cf-total"><span>Total charge</span><b id="cf_linetotal">$0.00</b></div>'+
      '</section>'+

      /* ── review ── */
      '<section class="cf-sec" data-sec="review">'+
        '<div class="cf-hd"><h4>Review</h4><p>What will be sent, and anything still missing.</p></div>'+
        '<div id="cf_issues"></div>'+
        '<div class="cf-preview" id="cf_preview"></div>'+
      '</section>'+

    '</div>'+

    '<div class="cf-foot">'+
      '<button class="cf-btn ghost" id="cfCancel">Cancel</button>'+
      '<button class="cf-btn" id="cfPrev"><svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg>Back</button>'+
      '<span class="sp"></span>'+
      '<button class="cf-btn" id="cfPrint"><svg viewBox="0 0 24 24"><path d="M7 9V3h10v6M7 19H5a2 2 0 01-2-2v-4a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2h-2"/><path d="M7 15h10v6H7z"/></svg>Print</button>'+
      '<button class="cf-btn" id="cfNext">Next<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg></button>'+
      '<button class="cf-btn pri" id="cfSave"><svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg>Save claim</button>'+
    '</div>';
  }

  window.RFClaimForm = {
    open: function(claim, opts){
      build();

      /* Accept the claim as the first argument. If it arrives wrapped in an
         options object instead, unwrap it rather than opening an empty form —
         a silent blank editor is far harder to diagnose than a warning. */
      if(claim && !claim.payer && !claim.lines && !claim.control && claim.claim){
        console.warn('RFClaimForm.open: the claim should be the first argument. '+
          'Unwrapping options.claim for now.');
        opts = Object.assign({}, claim, opts||{});
        claim = claim.claim;
      }
      if(!claim || typeof claim !== 'object'){
        console.error('RFClaimForm.open: no claim was supplied.');
        claim = {};
      }

      C = JSON.parse(JSON.stringify(claim || {}));
      OPTS = opts || {};
      C.dx = (C.dx && C.dx.length) ? C.dx : [''];
      C.lines = C.lines || [];
      C.send_method = C.send_method || 'electronic';
      C.frequency = C.frequency || '1';
      normaliseLines();
      fill();
      show(OPTS.section || ((C.rejections && C.rejections.length) ? 'review' : 'payer'));
      $('cfScrim').classList.add('on');
      $('cfRoot').classList.add('on');
      document.body.style.overflow = 'hidden';
    },
    close: close,
    claim: function(){ return C; },
    esc: esc, money: money
  };

  function close(){
    if(!BUILT) return;
    $('cfScrim').classList.remove('on');
    $('cfRoot').classList.remove('on');
    document.body.style.overflow = '';
    if(OPTS.onClose) OPTS.onClose();
  }

  /* ── a line carries up to four diagnosis pointers ── */
  function normaliseLines(){
    C.lines.forEach(function(l){
      if(!l.dxptrs || !l.dxptrs.length){
        /* migrate the single pointer older claims carry */
        l.dxptrs = l.dxptr ? [String(l.dxptr)] : ['1'];
      }
      l.dxptrs = l.dxptrs.map(String).filter(function(p){ return p && +p>0; }).slice(0,4);
      if(!l.dxptrs.length) l.dxptrs = ['1'];
      delete l.dxptr;
    });
  }

  var FIELDS = {
    cf_payer:'payer', cf_payerid:'payer_id', cf_payeraddr:'payer_address',
    cf_filing:'filing', cf_resp:'responsibility', cf_submitter:'submitter_name',
    cf_orgname:'org_name', cf_orgnpi:'org_npi', cf_taxid:'tax_id',
    cf_taxonomy:'taxonomy', cf_orgphone:'org_phone', cf_orgaddr:'org_addr',
    cf_orgcity:'org_city', cf_orgstate:'org_state', cf_orgzip:'org_zip',
    cf_provfirst:'prov_first', cf_provlast:'prov_last', cf_provnpi:'provider_npi',
    cf_provtax:'prov_taxonomy',
    cf_facname:'facility_name', cf_facnpi:'facility_npi', cf_facaddr:'facility_addr',
    cf_faccity:'facility_city', cf_facstate:'facility_state', cf_faczip:'facility_zip',
    cf_rel:'relationship', cf_member:'member_id', cf_group:'group_id',
    cf_subfirst:'sub_first', cf_sublast:'sub_last', cf_subdob:'sub_dob', cf_subsex:'sub_sex',
    cf_subaddr:'sub_addr', cf_subcity:'sub_city', cf_substate:'sub_state', cf_subzip:'sub_zip',
    cf_patfirst:'patient_first', cf_patlast:'patient_last', cf_patdob:'patient_dob',
    cf_patsex:'patient_sex', cf_pataddr:'pat_addr', cf_patcity:'pat_city',
    cf_patstate:'pat_state', cf_patzip:'pat_zip',
    cf_ctrl:'control', cf_pos:'pos', cf_dos:'dos', cf_freq:'frequency',
    cf_origref:'orig_ref', cf_auth:'prior_auth', cf_referral:'referral',
    cf_sig:'signature', cf_assign:'assignment', cf_release:'release'
  };

  function fill(){
    $('cfTitle').textContent = OPTS.title || (C.id ? (C.claim_no||'Claim') : 'Create claim');
    $('cfSub').textContent = OPTS.subtitle || '';

    var rn = C.stedi_claim_no || C.correlationId || '';
    var ref = $('cfRef');
    if(rn){
      ref.hidden = false;
      ref.innerHTML = '<span class="l">'+(C.status==='rejected'?'Rejection reference':'Payer claim number')+
        '</span><span class="v'+(C.status==='rejected'?' bad':'')+'">'+esc(rn)+'</span>';
    }else{ ref.hidden = true; }

    Object.keys(FIELDS).forEach(function(id){
      var el = $(id); if(el) el.value = C[FIELDS[id]] || '';
    });
    $('cf_total').value = money(C.total||0);

    var payers = (window.RFCodes && RFCodes.payers) ? RFCodes.payers() : [];
    $('cfPayerList').innerHTML = payers.map(function(p){
      return '<option value="'+esc(p.name)+'">'+esc(p.payer_id||'')+'</option>'; }).join('');

    var pos = (window.RFCodes && RFCodes.posList) ? RFCodes.posList() : [];
    $('cf_pos').innerHTML = (pos.length?pos:[{code:'11',desc:'Office'}]).map(function(x){
      return '<option value="'+x.code+'">'+x.code+' — '+esc(x.desc)+'</option>'; }).join('');
    $('cf_pos').value = C.pos || '11';

    var provs = (OPTS.context && (OPTS.context.provs || OPTS.context.providers)) ||
                OPTS.providers || [];
    $('cf_provsel').innerHTML = '<option value="">—</option>'+provs.map(function(p){
      return '<option value="'+p.id+'"'+(String(C.provider_id)===String(p.id)?' selected':'')+'>'+
        esc(p.full_name)+'</option>'; }).join('');

    var radio = document.querySelector('#cfSend input[value="'+C.send_method+'"]');
    if(radio) radio.checked = true;

    if(OPTS.saveLabel){
      $('cfSave').innerHTML='<svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg>'+
        esc(OPTS.saveLabel);
    }
    applySend(); applyFreq(); applyRel();
    paintDx(); paintLines();
  }

  function read(){
    if(!C) return;
    Object.keys(FIELDS).forEach(function(id){
      var el = $(id); if(el) C[FIELDS[id]] = el.value;
    });
    var dxInputs = [].slice.call(document.querySelectorAll('#cf_dxlist input'));
    if(dxInputs.length){
      C.dx = dxInputs.map(function(i){ return i.value.trim().toUpperCase(); });
    }else if(($('cf_dxlist').innerHTML||'').indexOf('cf-dxrow') > -1){
      /* rows are on screen but the query found none — keep what we hold */
      console.warn('ReviFlow claim form: diagnosis rows were not readable; keeping the stored list.');
    }else{
      C.dx = [''];
    }

    var lineRows = [].slice.call(document.querySelectorAll('#cf_lines .cf-line'));
    if(!lineRows.length && ($('cf_lines').innerHTML||'').indexOf('cf-line') > -1){
      console.warn('ReviFlow claim form: service lines were not readable; keeping the stored lines.');
      $('cf_total').value = money(C.total||0);
      return;
    }
    C.lines = lineRows.map(function(row){
      var g = function(c){ var el=row.querySelector('.'+c); return el?el.value:''; };
      var ptrs = [].slice.call(row.querySelectorAll('.cf-pchip.on'))
        .map(function(b){ return b.dataset.p; });
      return {
        cpt:g('l_cpt').trim().toUpperCase(), mod:g('l_mod').trim().toUpperCase(),
        mod2:g('l_mod2').trim().toUpperCase(), desc:row.dataset.desc||'',
        charge:num(g('l_charge')), units:parseInt(g('l_units'),10)||1,
        unit_type:g('l_ut')||'UN', dxptrs:ptrs.length?ptrs:['1'],
        from:g('l_from'), to:g('l_to')||g('l_from'),
        pos:g('l_pos')||C.pos, emg:'N'
      };
    }).filter(function(l){ return l.cpt || l.charge; });

    C.total = C.lines.reduce(function(x,l){ return x + l.charge*(l.units||1); },0);
    $('cf_total').value = money(C.total);
    $('cf_linetotal').textContent = money(C.total);
    $('cfLnN').textContent = C.lines.length;
    $('cfDxN').textContent = C.dx.filter(Boolean).length;
  }

  /* ── payer ── */
  function applySend(){
    var paper = C.send_method==='paper';
    document.querySelectorAll('#cfSend .cf-opt').forEach(function(l){
      var r=l.querySelector('input'); l.classList.toggle('on', !!(r&&r.checked));
    });
    document.querySelectorAll('.cf-sec[data-sec="payer"] .elec').forEach(function(el){
      el.style.display = paper?'none':'';
    });
    document.querySelectorAll('.mreq').forEach(function(u){ u.hidden = !paper; });
    $('cf_addrhint').textContent = paper
      ? 'Required. Stedi posts the printed claim here.'
      : 'Where a paper claim would be posted.';
    $('cfPaperNote').innerHTML = paper
      ? '<div class="cf-issue warn" style="margin-bottom:16px">'+
        '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>'+
        '<span>Stedi prints this on a CMS-1500 and posts it. No payer ID or trading '+
        'partner routing is used, so those fields are hidden.</span></div>' : '';
  }

  function applyRel(){
    var self = $('cf_rel').value==='18';
    $('cf_patfields').style.display = self?'none':'';
    $('cf_patskip').innerHTML = self
      ? '<div class="cf-issue ok"><svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg>'+
        '<span>The patient is the subscriber, so this loop is left out of the claim.</span></div>' : '';
    $('cf_relnote').textContent = self
      ? 'The patient is the subscriber, so the patient loop is omitted.'
      : 'The patient is a dependent, so both loops are sent.';
  }

  function applyFreq(){
    var f = $('cf_freq').value, need = (f==='7'||f==='8');
    document.querySelectorAll('.oreq').forEach(function(u){ u.hidden = !need; });
    $('cf_freqhint').textContent =
      f==='7' ? 'Replaces a claim the payer has already processed.'
    : f==='8' ? 'Cancels a claim the payer has already processed.'
    : 'An original claim the payer has not seen.';
    $('cf_orighint').textContent = need
      ? "Required. Use the payer's control number from the remittance."
      : 'Only for a correction or void.';
  }

  /* ── diagnoses ── */
  function paintDx(){
    var list = (C.dx && C.dx.length) ? C.dx : [''];
    $('cf_dxlist').innerHTML = list.map(function(d,i){
      var desc = (window.RFCodes && RFCodes.icdDesc) ? RFCodes.icdDesc(d) : '';
      return '<div class="cf-dxrow">'+
        '<span class="cf-ptr">'+LETTERS[i]+'</span>'+
        '<input maxlength="8" value="'+esc(d)+'" placeholder="F41.1" aria-label="Diagnosis '+LETTERS[i]+'">'+
        '<span class="d">'+esc(desc||'')+'</span>'+
        (list.length>1
          ? '<button type="button" class="cf-rm" data-dxrm="'+i+'" aria-label="Remove">'+
            '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>' : '')+
      '</div>';
    }).join('');
    $('cfDxN').textContent = list.filter(Boolean).length;
  }

  /* ── service lines ── */
  function lineHTML(l,i){
    var dxs = (C.dx||[]).filter(function(d){ return d; });
    var chips = LETTERS.slice(0, Math.max(1,dxs.length)).map(function(L,k){
      var p = String(k+1);
      var on = (l.dxptrs||[]).indexOf(p) > -1;
      var full = !on && (l.dxptrs||[]).length >= 4;
      return '<button type="button" class="cf-pchip'+(on?' on':'')+(full?' off':'')+
        '" data-p="'+p+'" title="'+esc(dxs[k]||('Diagnosis '+L))+'">'+L+'</button>';
    }).join('');

    var pos = (window.RFCodes && RFCodes.posList) ? RFCodes.posList() : [];
    var posOpts = (pos.length?pos:[{code:'11',desc:'Office'}]).map(function(x){
      return '<option value="'+x.code+'"'+((l.pos||C.pos)===x.code?' selected':'')+'>'+
        x.code+'</option>'; }).join('');

    return '<div class="cf-line" data-desc="'+esc(l.desc||'')+'">'+
      '<div class="cf-lh">'+
        '<span class="no">'+(i+1)+'</span>'+
        '<span class="dsc">'+esc(l.desc||'New line')+'</span>'+
        '<span class="amt">'+money((l.charge||0)*(l.units||1))+'</span>'+
        '<button type="button" class="cf-rm" data-lnrm="'+i+'" aria-label="Remove line">'+
          '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>'+
      '</div>'+
      '<div class="cf-grid">'+
        '<label class="cf-f s3"><span>CPT / HCPCS</span>'+
          '<input class="l_cpt" maxlength="7" value="'+esc(l.cpt||'')+'"></label>'+
        '<label class="cf-f s2"><span>Mod 1</span>'+
          '<input class="l_mod" maxlength="2" value="'+esc(l.mod||'')+'"></label>'+
        '<label class="cf-f s2"><span>Mod 2</span>'+
          '<input class="l_mod2" maxlength="2" value="'+esc(l.mod2||'')+'"></label>'+
        '<label class="cf-f s2"><span>Charge</span>'+
          '<input class="l_charge" inputmode="decimal" value="'+(l.charge||0)+'"></label>'+
        '<label class="cf-f s3"><span>Units</span>'+
          '<input class="l_units" type="number" min="1" value="'+(l.units||1)+'"></label>'+
        '<label class="cf-f s3"><span>From</span>'+
          '<input class="l_from" type="date" min="1900-01-01" max="2100-12-31" value="'+esc(l.from||C.dos||'')+'"></label>'+
        '<label class="cf-f s3"><span>To</span>'+
          '<input class="l_to" type="date" min="1900-01-01" max="2100-12-31" value="'+esc(l.to||l.from||C.dos||'')+'"></label>'+
        '<label class="cf-f s3"><span>Place of service</span>'+
          '<select class="l_pos">'+posOpts+'</select></label>'+
        '<label class="cf-f s3"><span>Unit type</span>'+
          '<select class="l_ut">'+
            '<option value="UN"'+(l.unit_type==='UN'?' selected':'')+'>UN — Units</option>'+
            '<option value="MJ"'+(l.unit_type==='MJ'?' selected':'')+'>MJ — Minutes</option>'+
          '</select></label>'+
        '<div class="cf-f s12"><span>Diagnosis pointers'+
            '<u style="color:#8A9A97;font-weight:600;font-size:9.6px">up to four</u></span>'+
          '<div class="cf-ptrs" data-line="'+i+'">'+chips+'</div>'+
          '<span class="cf-ptrnote">'+
            (dxs.length
              ? 'Select every diagnosis this procedure treats, in order of relevance.'
              : 'Add a diagnosis under Claim first.')+
          '</span></div>'+
      '</div></div>';
  }

  function paintLines(){
    $('cf_lines').innerHTML = (C.lines||[]).length
      ? C.lines.map(lineHTML).join('')
      : '<div class="cf-issue warn"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/>'+
        '<path d="M12 11v5M12 8h.01"/></svg><span>No service lines yet. '+
        'A claim needs at least one procedure.</span></div>';
    $('cf_linetotal').textContent = money(C.total||0);
    $('cfLnN').textContent = (C.lines||[]).length;
  }

  /* ── validation ── */
  function validate(){
    read();
    var out = [], paper = C.send_method==='paper';
    var need = [['payer','Payer name','payer']]
      .concat(paper ? [['payer_address','Payer mailing address','payer']]
                    : [['payer_id','Payer ID','payer']])
      .concat([
        ['org_name','Billing provider name','billing'],['org_npi','Billing NPI','billing'],
        ['tax_id','Tax ID','billing'],['org_addr','Billing address','billing'],
        ['org_city','Billing city','billing'],['org_state','Billing state','billing'],
        ['org_zip','Billing ZIP','billing'],
        ['member_id','Member ID','sub'],['sub_first','Subscriber first name','sub'],
        ['sub_last','Subscriber last name','sub'],['sub_dob','Subscriber date of birth','sub'],
        ['control','Patient control number','claim'],['pos','Place of service','claim']
      ]);

    need.forEach(function(f){
      if(!String(C[f[0]]||'').trim())
        out.push({level:'err',msg:f[1]+' is required',sec:f[2]});
    });

    if(C.relationship!=='18'){
      [['patient_first','Patient first name'],['patient_last','Patient last name'],
       ['patient_dob','Patient date of birth']].forEach(function(f){
        if(!String(C[f[0]]||'').trim())
          out.push({level:'err',msg:f[1]+' is required when the patient is not the subscriber',sec:'pat'});
      });
    }

    var dxs = (C.dx||[]).filter(Boolean);
    if(!dxs.length) out.push({level:'err',msg:'At least one diagnosis is required',sec:'claim'});
    if(!(C.lines||[]).length) out.push({level:'err',msg:'At least one service line is required',sec:'lines'});

    (C.lines||[]).forEach(function(l,i){
      if(!l.cpt) out.push({level:'err',msg:'Line '+(i+1)+' has no procedure code',sec:'lines'});
      if(!l.from) out.push({level:'err',msg:'Line '+(i+1)+' has no service date',sec:'lines'});
      if(!l.charge) out.push({level:'warn',msg:'Line '+(i+1)+' has a zero charge',sec:'lines'});
      if(!(l.dxptrs||[]).length)
        out.push({level:'err',msg:'Line '+(i+1)+' points at no diagnosis',sec:'lines'});
      (l.dxptrs||[]).forEach(function(p){
        if(+p > dxs.length)
          out.push({level:'err',
            msg:'Line '+(i+1)+' points at diagnosis '+LETTERS[+p-1]+', which does not exist',
            sec:'lines'});
      });
      if((l.dxptrs||[]).length>4)
        out.push({level:'err',msg:'Line '+(i+1)+' has more than four diagnosis pointers',sec:'lines'});
    });

    if(C.org_npi && !/^\d{10}$/.test(C.org_npi))
      out.push({level:'err',msg:'The billing NPI must be ten digits',sec:'billing'});
    if(C.provider_npi && !/^\d{10}$/.test(C.provider_npi))
      out.push({level:'err',msg:'The rendering NPI must be ten digits',sec:'billing'});
    if(C.org_zip && !/^\d{5}(-?\d{4})?$/.test(C.org_zip))
      out.push({level:'warn',msg:'Most payers want a nine digit billing ZIP',sec:'billing'});
    if(C.frequency==='7' && !String(C.orig_ref||'').trim())
      out.push({level:'err',
        msg:'A corrected claim must carry the original claim number, or the payer will treat it as a duplicate',
        sec:'claim'});
    if(C.frequency==='8' && !String(C.orig_ref||'').trim())
      out.push({level:'err',msg:'A void must name the claim it cancels',sec:'claim'});

    return out;
  }

  function paintReview(){
    var issues = validate();
    var errs = issues.filter(function(x){ return x.level==='err'; });
    var html = '';

    if(C.rejections && C.rejections.length){
      html += '<div class="cf-issue err" style="flex-direction:column;align-items:stretch">'+
        '<b style="display:flex;gap:8px;align-items:center">'+
        '<svg viewBox="0 0 24 24" style="width:15px;height:15px"><path d="M12 4l9 16H3z"/>'+
        '<path d="M12 10v4M12 17h.01"/></svg>The payer rejected this claim</b>'+
        '<ul>'+C.rejections.map(function(e){
          return '<li>'+(e.code?'<code>'+esc(e.code)+'</code> ':'')+esc(e.message||'')+'</li>';
        }).join('')+'</ul>'+
        '<span style="margin-top:7px;font-size:11px;opacity:.85">Correct the fields, then '+
        'choose <b>Corrected claim</b> if the payer has already processed the original.</span></div>';
    }

    html += issues.length
      ? issues.map(function(x){
          return '<div class="cf-issue '+(x.level==='err'?'err':'warn')+'">'+
            '<svg viewBox="0 0 24 24"><path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17h.01"/></svg>'+
            '<span>'+esc(x.msg)+' · <a data-goto="'+x.sec+'">go to it</a></span></div>';
        }).join('')
      : '<div class="cf-issue ok"><svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg>'+
        '<span><b>Ready to submit.</b> Everything the payer needs is present.</span></div>';

    $('cf_issues').innerHTML = html;
    $('cfState').textContent = errs.length ? (errs.length+' TO FIX') : 'READY';
    $('cfState').className = 'cf-state '+(errs.length?'issues':'ready');
    document.querySelectorAll('#cfNav button').forEach(function(b){
      var bad = issues.some(function(x){ return x.level==='err' && x.sec===b.dataset.s; });
      var dot = b.querySelector('.dot');
      if(bad && !dot){ b.insertAdjacentHTML('beforeend','<span class="dot"></span>'); }
      else if(!bad && dot){ dot.remove(); }
    });
    if(OPTS.preview) $('cf_preview').innerHTML = OPTS.preview(C);
  }

  var ORDER = ['payer','billing','sub','pat','claim','lines','review'];
  function show(sec){
    if(C) read();
    SEC = sec;
    document.querySelectorAll('#cfNav button').forEach(function(b){
      b.classList.toggle('on', b.dataset.s===sec); });
    document.querySelectorAll('.cf-sec').forEach(function(s){
      s.classList.toggle('on', s.dataset.sec===sec); });
    $('cfBody').scrollTop = 0;
    if(sec==='review') paintReview();
    var i = ORDER.indexOf(sec);
    $('cfPrev').style.visibility = i<=0 ? 'hidden' : '';
    $('cfNext').style.visibility = i>=ORDER.length-1 ? 'hidden' : '';
  }

  /* ── events, bound once ── */
  function wire(){
    $('cfNav').addEventListener('click', function(e){
      var b = e.target.closest('[data-s]'); if(b) show(b.dataset.s);
    });
    $('cfNext').addEventListener('click', function(){
      var i = ORDER.indexOf(SEC); if(i<ORDER.length-1) show(ORDER[i+1]);
    });
    $('cfPrev').addEventListener('click', function(){
      var i = ORDER.indexOf(SEC); if(i>0) show(ORDER[i-1]);
    });
    $('cfClose').addEventListener('click', close);
    $('cfCancel').addEventListener('click', close);

    $('cfSend').addEventListener('change', function(e){
      if(e.target.name!=='cfSendM') return;
      C.send_method = e.target.value; applySend();
    });
    $('cf_rel').addEventListener('change', function(){ read(); applyRel(); });
    $('cf_freq').addEventListener('change', function(){ read(); applyFreq(); });

    /* payer name fills the id and address from the admin list */
    function fillPayer(){
      if(!window.RFCodes || !RFCodes.payers) return;
      var q = String($('cf_payer').value||'').trim().toLowerCase();
      if(!q) return;
      var hit = RFCodes.payers().filter(function(p){
        return String(p.name||'').toLowerCase()===q ||
               String(p.payer_id||'').toLowerCase()===q; })[0];
      if(!hit) return;
      $('cf_payer').value = hit.name||'';
      if(hit.payer_id) $('cf_payerid').value = hit.payer_id;
      if(hit.mailing_address && !$('cf_payeraddr').value)
        $('cf_payeraddr').value = hit.mailing_address;
      $('cf_pidhint').textContent = 'Matched '+(hit.name||'')+' in Admin → Payers.';
      read();
    }
    $('cf_payer').addEventListener('change', fillPayer);
    $('cf_payer').addEventListener('blur', fillPayer);

    $('cf_provsel').addEventListener('change', function(){
      var provs = (OPTS.context && (OPTS.context.provs || OPTS.context.providers)) ||
                  OPTS.providers || [];
      var p = provs.filter(function(x){ return String(x.id)===this.value; }.bind(this))[0];
      if(!p) return;
      C.provider_id = p.id;
      $('cf_provfirst').value = p.first_name || String(p.full_name||'').split(' ')[0] || '';
      $('cf_provlast').value  = p.last_name  || String(p.full_name||'').split(' ').pop() || '';
      $('cf_provnpi').value   = p.npi || '';
      if(p.taxonomy) $('cf_provtax').value = p.taxonomy;
      read();
    });

    /* diagnoses */
    $('cf_adddx').addEventListener('click', function(){
      read();
      if(C.dx.length>=12){ notify('Twelve is the limit','A claim carries A to L'); return; }
      C.dx.push(''); paintDx(); paintLines();
    });
    $('cf_dxlist').addEventListener('click', function(e){
      var b = e.target.closest('[data-dxrm]'); if(!b) return;
      read();
      var i = +b.dataset.dxrm;
      C.dx.splice(i,1);
      /* pointers shift with the list, so a line never points at the wrong code */
      C.lines.forEach(function(l){
        l.dxptrs = (l.dxptrs||[]).map(function(p){
          var n = +p;
          if(n === i+1) return null;
          return String(n > i+1 ? n-1 : n);
        }).filter(Boolean);
        if(!l.dxptrs.length) l.dxptrs = ['1'];
      });
      paintDx(); paintLines();
    });
    $('cf_dxlist').addEventListener('input', function(e){
      if(e.target.tagName!=='INPUT') return;
      var row = e.target.closest('.cf-dxrow'), d = row.querySelector('.d');
      var code = e.target.value.trim().toUpperCase();
      if(d) d.textContent = (window.RFCodes && RFCodes.icdDesc) ? RFCodes.icdDesc(code) : '';
    });
    $('cf_dxlist').addEventListener('change', function(){ read(); paintLines(); });

    /* lines */
    $('cf_addline').addEventListener('click', function(){
      read();
      C.lines.push({ cpt:'', mod:'', mod2:'', charge:0, units:1, unit_type:'UN',
        dxptrs:['1'], from:C.dos, to:C.dos, pos:C.pos, emg:'N' });
      paintLines();
    });
    $('cf_lines').addEventListener('click', function(e){
      var rm = e.target.closest('[data-lnrm]');
      if(rm){ read(); C.lines.splice(+rm.dataset.lnrm,1); paintLines(); return; }

      var chip = e.target.closest('.cf-pchip');
      if(chip){
        if(chip.classList.contains('off')) return;
        var wrap = chip.closest('.cf-ptrs');
        var on = wrap.querySelectorAll('.cf-pchip.on');
        if(!chip.classList.contains('on') && on.length>=4){
          notify('Four is the limit','A service line carries at most four diagnosis pointers');
          return;
        }
        if(chip.classList.contains('on') && on.length===1){
          notify('At least one is needed','Every line must point at a diagnosis');
          return;
        }
        chip.classList.toggle('on');
        /* grey out the rest once four are chosen */
        var now = wrap.querySelectorAll('.cf-pchip.on').length;
        wrap.querySelectorAll('.cf-pchip').forEach(function(b){
          b.classList.toggle('off', now>=4 && !b.classList.contains('on'));
        });
        read();
      }
    });
    $('cf_lines').addEventListener('input', function(){
      read();
      [].slice.call(document.querySelectorAll('#cf_lines .cf-line')).forEach(function(row,i){
        var l = C.lines[i]; if(!l) return;
        var a = row.querySelector('.amt');
        if(a) a.textContent = money((l.charge||0)*(l.units||1));
        var d = row.querySelector('.dsc');
        if(d && l.cpt){
          var desc = (window.RFCodes && RFCodes.cptDesc) ? RFCodes.cptDesc(l.cpt) : '';
          if(desc){ l.desc = desc; row.dataset.desc = desc; d.textContent = desc; }
        }
      });
    });

    $('cf_issues').addEventListener('click', function(e){
      var a = e.target.closest('[data-goto]'); if(a) show(a.dataset.goto);
    });

    $('cfPrint').addEventListener('click', function(){
      read();
      if(OPTS.preview) $('cf_preview').innerHTML = OPTS.preview(C);
      show('review');
      setTimeout(function(){ window.print(); },180);
    });

    $('cfSave').addEventListener('click', async function(){
      var issues = validate();
      var errs = issues.filter(function(x){ return x.level==='err'; });
      if(errs.length){
        show('review');
        notify(errs.length+' thing'+(errs.length===1?'':'s')+' to fix',
          'The payer would reject this claim as it stands');
        return;
      }
      this.disabled = true;
      try{
        if(OPTS.onSave) await OPTS.onSave(C);
      }finally{ this.disabled = false; }
    });
  }

  function notify(t,s){
    if(OPTS.onNotify){ OPTS.onNotify(t,s); return; }
    if(window.RFNotify && RFNotify.toast){ RFNotify.toast(t,s); return; }
    console.warn('ReviFlow · '+t+(s?' — '+s:''));
  }

})();
