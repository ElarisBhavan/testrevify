/* ═══════════════════════════════════════════════════════════════
   ReviFlow — session manager
   One session per browser, shared by every tab.
   Signing out anywhere signs out everywhere, immediately.
   ═══════════════════════════════════════════════════════════════ */
(function(){
  var KEY      = 'rf_session';      // the session itself, in localStorage so tabs share it
  var TICK     = 'rf_session_tick'; // last activity, written by whichever tab is in use
  var CHAN     = 'rf_auth';         // BroadcastChannel name
  var ABSOLUTE = 12 * 3600 * 1000;  // hard ceiling, regardless of activity
  var DEFAULT_IDLE = 30;            // minutes, overridden by the user's settings

  var bc = null;
  try{ bc = ('BroadcastChannel' in window) ? new BroadcastChannel(CHAN) : null; }catch(e){}

  function read(){
    try{ return JSON.parse(localStorage.getItem(KEY) || 'null'); }catch(e){ return null; }
  }
  function write(s){
    try{ localStorage.setItem(KEY, JSON.stringify(s)); }catch(e){}
  }
  function wipe(){
    try{ localStorage.removeItem(KEY); localStorage.removeItem(TICK); }catch(e){}
    /* clear anything a page may have cached for this tab */
    try{ sessionStorage.removeItem(KEY); }catch(e){}
  }
  function lastTick(){
    var t = 0;
    try{ t = +localStorage.getItem(TICK) || 0; }catch(e){}
    return t;
  }
  function touch(){
    try{ localStorage.setItem(TICK, String(Date.now())); }catch(e){}
  }

  function idleMinutes(){
    var s = read();
    if(!s) return DEFAULT_IDLE;
    try{
      var p = JSON.parse(localStorage.getItem('rf_prefs:' + s.username) || '{}');
      if(p.idleMinutes === 0) return 0;              // the user chose never
      if(p.idleMinutes) return p.idleMinutes;
    }catch(e){}
    return DEFAULT_IDLE;
  }

  /* why, if at all, this session is no longer valid */
  function expiredReason(){
    var s = read();
    if(!s) return null;
    if(s.at && Date.now() - s.at > ABSOLUTE) return 'expired';
    var idle = idleMinutes();
    if(idle > 0){
      var t = lastTick() || s.at || 0;
      if(t && Date.now() - t > idle * 60000) return 'idle';
    }
    return null;
  }

  function homeFor(){
    var s = read();
    var p = location.pathname;
    var up = /\/Admin\/|\/Provider\/|\/Patient\/|\/Employee\//i.test(p) ? '' : '';
    if(s && s.role === 'admin')
      return (/\/Admin\//i.test(p) ? '' : 'Admin/') + 'admin-dashboard.html';
    if(/\/Admin\//i.test(p)) return '../Provider/provider-dashboard.html';
    if(/\/Patient\/|\/Employee\//i.test(p)) return '../Provider/provider-dashboard.html';
    if(/\/Provider\//i.test(p)) return 'provider-dashboard.html';
    return 'Provider/provider-dashboard.html';
  }

  function loginUrl(reason){
    var p = location.pathname;
    var base = /\/Admin\//i.test(p) ? ''
             : /\/Patient\/|\/Employee\//i.test(p) ? '../Provider/'
             : /\/Provider\//i.test(p) ? ''
             : 'Provider/';
    var admin = /\/Admin\//i.test(p);
    return base + (admin ? 'admin-login.html' : 'provider-login.html') +
           (reason ? '?' + reason + '=1' : '');
  }

  function isPublic(){
    return /provider-login|admin-login|reset-password|reviflow|^\/?index|resources|insights/i
      .test(location.pathname.split('/').pop() || 'index.html');
  }

  var API = {
    /* ── read ── */
    get: function(){
      if(expiredReason()) return null;
      return read();
    },
    isSignedIn: function(){ return !!API.get(); },

    /* ── write ── */
    start: function(account){
      var s = Object.assign({}, account, { at: Date.now() });
      write(s); touch();
      broadcast({ type:'login', username: s.username });
      return s;
    },
    update: function(patch){
      var s = read(); if(!s) return null;
      Object.assign(s, patch);
      write(s);
      broadcast({ type:'update' });
      return s;
    },
    touch: touch,

    /* ── end ── */
    end: function(reason){
      var s = read();
      try{
        if(s && window.RFStore && RFStore.logSignOut) RFStore.logSignOut(s.username, reason);
      }catch(e){}
      wipe();
      broadcast({ type:'logout', reason: reason || 'manual', username: s && s.username });
      return true;
    },
    /* sign out and send this tab to the login screen */
    signOut: function(reason){
      API.end(reason);
      location.href = loginUrl(reason === 'manual' ? '' : reason);
    },

    /* ── guarding a page ── */
    require: function(roles){
      if(isPublic()) return read();
      var why = expiredReason();
      if(why){ API.end(why); location.replace(loginUrl(why)); return null; }
      var s = read();
      if(!s){ location.replace(loginUrl()); return null; }
      if(roles && roles.length && roles.indexOf(s.role) < 0){
        /* the session is fine — this page simply is not theirs.
           Signing them out would be wrong and confusing. */
        API.denied();
        return null;
      }
      return s;
    },

    /* Show a blocking notice rather than ending the session. */
    denied: function(opts){
      opts = opts || {};
      if(document.getElementById('rf-denied')) return;

      var wrap = document.createElement('div');
      wrap.id = 'rf-denied';
      wrap.className = 'rf-denied';
      wrap.setAttribute('role','alertdialog');
      wrap.setAttribute('aria-modal','true');

      var section = opts.section ? ('the ' + opts.section + ' section') : 'this section';
      var back = opts.back || document.referrer;
      var home = homeFor();

      wrap.innerHTML =
        '<div class="rf-denied-scrim"></div>' +
        '<div class="rf-denied-card">' +
          '<span class="rf-denied-ic">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' +
            '<rect x="4" y="10.5" width="16" height="10" rx="2.6"/>' +
            '<path d="M8 10.5V7.5a4 4 0 018 0v3"/><path d="M12 15v2"/></svg>' +
          '</span>' +
          '<h2>You do not have access to this</h2>' +
          '<p>Your account has no access to ' + section +
            '. Contact your practice manager if you need it.</p>' +
          '<div class="rf-denied-acts">' +
            (back ? '<button type="button" class="rf-denied-btn" data-rf="back">Go back</button>' : '') +
            '<a class="rf-denied-btn pri" href="' + home + '">Back to my workspace</a>' +
          '</div>' +
        '</div>';

      document.body.appendChild(wrap);
      document.body.style.overflow = 'hidden';
      requestAnimationFrame(function(){ wrap.classList.add('on'); });

      var btn = wrap.querySelector('[data-rf="back"]');
      if(btn) btn.addEventListener('click', function(){
        if(history.length > 1) history.back(); else location.href = home;
      });
      /* deliberately not dismissable — the page behind it is not theirs to use */
    },

    onChange: function(fn){ listeners.push(fn); },
    loginUrl: loginUrl
  };

  var listeners = [];
  function broadcast(msg){
    try{ if(bc) bc.postMessage(msg); }catch(e){}
    /* storage events cover browsers without BroadcastChannel, and other windows */
    try{ localStorage.setItem('rf_auth_ping', JSON.stringify(Object.assign({ t: Date.now() }, msg))); }catch(e){}
  }

  function handleRemote(msg){
    if(!msg) return;
    listeners.forEach(function(fn){ try{ fn(msg); }catch(e){} });
    if(msg.type === 'logout'){
      if(isPublic()) return;
      /* another tab signed out — follow it, without looping the broadcast */
      wipe();
      location.replace(loginUrl(msg.reason && msg.reason !== 'manual' ? msg.reason : ''));
    }
  }

  if(bc) bc.onmessage = function(e){ handleRemote(e.data); };
  window.addEventListener('storage', function(e){
    if(e.key === 'rf_auth_ping' && e.newValue){
      try{ handleRemote(JSON.parse(e.newValue)); }catch(err){}
      return;
    }
    /* the session row itself disappearing means a sign-out elsewhere */
    if(e.key === KEY && !e.newValue && !isPublic()){
      location.replace(loginUrl());
    }
  });

  /* activity keeps the session alive; a watchdog ends it when it should */
  ['mousedown','keydown','touchstart','scroll','click'].forEach(function(ev){
    document.addEventListener(ev, function(){ if(read()) touch(); }, { passive:true });
  });

  setInterval(function(){
    if(isPublic()) return;
    var why = expiredReason();
    if(why){ API.end(why); location.replace(loginUrl(why)); }
  }, 15000);

  window.RFSession = API;

  /* ── identity in the page header, plus any log-out control ── */
  var ROLE = { admin:'Administrator', supervisor:'Supervisor / Practice Manager',
               provider:'Provider', scheduler:'Scheduler', employee:'Employee' };

  function initials(name, s){
    if(s && s.initials) return s.initials;
    return String(name || '').split(/\s+/).filter(Boolean)
      .map(function(w){ return w[0]; }).join('').slice(0,2).toUpperCase();
  }

  function paint(){
    var s = API.get();
    if(!s) return;
    var name = [s.first, s.last].filter(Boolean).join(' ') || s.name || s.username;
    var role = ROLE[s.role] || s.role;

    document.querySelectorAll('[data-me-name]').forEach(function(el){ el.textContent = name; });
    document.querySelectorAll('[data-me-role]').forEach(function(el){
      el.textContent = role + (s.title ? ' · ' + s.title : ''); });
    document.querySelectorAll('[data-me-initials]').forEach(function(el){
      el.textContent = initials(name, s); });

    var slot = document.getElementById('rfWho');
    if(slot && !slot.dataset.done){
      slot.dataset.done = '1';
      slot.innerHTML = '<span class="rf-av">' + initials(name, s) + '</span>' +
        '<span class="rf-id"><b>' + name + '</b><small>' + role + '</small></span>';
    }
  }

  /* every log-out control on every page goes through the manager */
  document.addEventListener('click', function(e){
    var t = e.target.closest('#logout, .logout, .hbtn.out, [data-logout]');
    if(!t) return;
    e.preventDefault();
    API.signOut('manual');
  });

  document.addEventListener('DOMContentLoaded', function(){
    if(!isPublic()) API.require();
    paint();
    if(read()) touch();
  });
  paint();
})();
