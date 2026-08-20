/* ═══════════════════════════════════════════════════════════════
   DEMO AUTH FALLBACK — delete this file before going live.

   Lets every page be used while the database is not yet connected.
   Both login pages try /api/auth first; only if that call fails do
   they fall back to this store. Once DATABASE_URL and JWT_SECRET are
   set in Netlify, the real backend answers and this is never reached.

   Passwords here are plain text. That is fine for a design prototype
   and completely unacceptable in production.
   ═══════════════════════════════════════════════════════════════ */
(function(){
  var KEY='rf_accounts', SESSION='rf_session';

  var SEED=[
    {u:'admin',        p:'Revify#2026',  role:'admin',      name:'System Administrator', title:'Platform Admin',            initials:'SA', scope:'all',      mfa:false, status:'active'},
    {u:'l.okoro',      p:'Okoro#2026',   role:'supervisor', name:'Lena Okoro',           title:'Practice Manager',          initials:'LO', scope:'facility', mfa:false, status:'active'},
    {u:'r.vaughn',     p:'Vaughn#2026',  role:'supervisor', name:'Rebecca Vaughn',       title:'Front Office Supervisor',   initials:'RV', scope:'facility', mfa:false, status:'active'},
    {u:'dr.whitfield', p:'Whit#2026',    role:'provider',   name:'Dr. Dana Whitfield',   title:'Family Medicine',           initials:'DW', pid:'DW', scope:'self', mfa:false, status:'active'},
    {u:'dr.reyes',     p:'Reyes#2026',   role:'provider',   name:'Dr. Alan Reyes',       title:'Internal Medicine',         initials:'AR', pid:'AR', scope:'self', mfa:false, status:'active'},
    {u:'dr.okafor',    p:'Okafor#2026',  role:'provider',   name:'Dr. Ngozi Okafor',     title:'Endocrinology',             initials:'NO', pid:'NO', scope:'self', mfa:false, status:'active'},
    {u:'s.lindqvist',  p:'Lind#2026',    role:'provider',   name:'Sara Lindqvist, NP',   title:'Primary Care',              initials:'SL', pid:'SL', scope:'self', mfa:false, status:'active'},
    {u:'m.bello',      p:'Bello#2026',   role:'provider',   name:'Marcus Bello, PA',     title:'Urgent Care',               initials:'MB', pid:'MB', scope:'self', mfa:false, status:'active'},
    {u:'dr.petrova',   p:'Petrova#2026', role:'provider',   name:'Dr. Elena Petrova',    title:'Pediatrics',                initials:'EP', pid:'EP', scope:'self', mfa:false, status:'active'},
    {u:'o.delgado',    p:'Delgado#2026', role:'scheduler',  name:'Owen Delgado',         title:'Scheduling Coordinator',    initials:'OD', scope:'facility', mfa:false, status:'active'},
    {u:'p.raman',      p:'Raman#2026',   role:'scheduler',  name:'Priya Raman',          title:'Patient Access',            initials:'PR', scope:'facility', mfa:false, status:'active'}
  ];

  function load(){
    var a=null;
    try{a=JSON.parse(localStorage.getItem(KEY));}catch(e){}
    if(!a||!a.length){a=SEED.slice();persist(a);}
    return a;
  }
  function persist(a){try{localStorage.setItem(KEY,JSON.stringify(a));}catch(e){}}
  function norm(u){return String(u||'').trim().toLowerCase().replace(/^@/,'');}

  window.RFDemo={
    all:function(){return load();},
    find:function(u){var n=norm(u);return load().filter(function(a){return norm(a.u)===n;})[0]||null;},

    verify:function(u,pw){
      var a=this.find(u);
      if(!a)return {ok:false,error:'unknown',message:'No account found for that username.'};
      if(a.status!=='active')return {ok:false,error:'disabled',message:'This account has been disabled.'};
      if(String(a.p)!==String(pw))return {ok:false,error:'password',message:'That password is not correct.'};
      return {ok:true,account:{
        username:a.u,role:a.role,name:a.name,title:a.title,initials:a.initials,
        pid:a.pid||null,scope:a.scope||'self',mfa_enabled:!!a.mfa,status:a.status,
        id:a.u,last_login:a.lastLogin||null,full_name:a.name,email:a.email||null,created_at:a.createdAt||null
      }};
    },

    upsert:function(acct){
      var list=load(),n=norm(acct.u||acct.username),i=-1;
      list.forEach(function(a,k){if(norm(a.u)===n)i=k;});
      var rec=Object.assign({},acct);
      if(rec.username&&!rec.u)rec.u=rec.username;
      if(i>-1)list[i]=Object.assign({},list[i],rec);
      else list.push(Object.assign({status:'active',mfa:false,scope:'self',createdAt:new Date().toISOString()},rec));
      persist(list);return list;
    },
    remove:function(u){var n=norm(u);persist(load().filter(function(a){return norm(a.u)!==n;}));return load();},

    signIn:function(account){
      var s=Object.assign({},account,{at:Date.now()});
      try{localStorage.setItem(SESSION,JSON.stringify(s));}catch(e){}
      this.upsert({u:account.username,lastLogin:new Date().toISOString()});
      return s;
    },
    session:function(){try{return JSON.parse(localStorage.getItem(SESSION)||'null');}catch(e){return null;}},
    signOut:function(){try{localStorage.removeItem(SESSION);}catch(e){}},
    reset:function(){persist(SEED.slice());return SEED.slice();}
  };
})();
