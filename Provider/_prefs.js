/* ReviFlow shared preferences — per signed-in user, applied on every page */
(function(){
  function who(){
    try{ var s=JSON.parse(sessionStorage.getItem('rf_session')||'null'); return s&&s.username||'anon'; }
    catch(e){ return 'anon'; }
  }
  function key(){ return 'rf_prefs:'+who(); }
  function read(){ try{ return JSON.parse(localStorage.getItem(key())||'{}'); }catch(e){ return {}; } }

  function hex(c){return [parseInt(c.substr(1,2),16),parseInt(c.substr(3,2),16),parseInt(c.substr(5,2),16)];}
  function shade(c,p){var r=hex(c);return 'rgb('+r.map(function(v){return Math.max(0,Math.min(255,Math.round(v+p)));}).join(',')+')';}
  function tint(c,a){var r=hex(c);return 'rgb('+r.map(function(v){return Math.round(v+(255-v)*a);}).join(',')+')';}

  window.RFPrefs={
    get:read,
    save:function(p){
      var m=read();for(var k in p)m[k]=p[k];
      localStorage.setItem(key(),JSON.stringify(m));
      this.apply();return m;
    },
    apply:function(){
      var p=read(),r=document.documentElement;
      if(p.accent){
        ['--green','--accent'].forEach(function(v){r.style.setProperty(v,p.accent);});
        ['--green-d','--accent-deep'].forEach(function(v){r.style.setProperty(v,shade(p.accent,-34));});
        ['--green-s','--accent-soft'].forEach(function(v){r.style.setProperty(v,tint(p.accent,.88));});
      }else{
        ['--green','--accent','--green-d','--accent-deep','--green-s','--accent-soft']
          .forEach(function(v){r.style.removeProperty(v);});
      }
      r.style.fontSize = p.largeText ? '18px' : '';
      if(document.body) document.body.classList.toggle('rf-large', !!p.largeText);
      if(p.reduceMotion) r.setAttribute('data-rf-reduce','1'); else r.removeAttribute('data-rf-reduce');
      if(p.density) r.setAttribute('data-rf-density',p.density);
    },

    /* ── auto sign-out after inactivity ── */
    idle:function(minutes){
      clearTimeout(this._t);
      if(this._off){this._off();this._off=null;}
      if(!minutes) return;
      var ms=minutes*60000, self=this;
      function bump(){
        clearTimeout(self._t);
        self._t=setTimeout(function(){
          try{
            sessionStorage.removeItem('rf_session');
            sessionStorage.setItem('rf_timeout','1');
          }catch(e){}
          var base=location.pathname.indexOf('/Admin/')>-1 ? '../Provider/' : '';
          location.href=base+'provider-login.html?timeout=1';
        },ms);
      }
      var evs=['mousemove','mousedown','keydown','touchstart','scroll','click'];
      evs.forEach(function(e){document.addEventListener(e,bump,{passive:true});});
      this._off=function(){evs.forEach(function(e){document.removeEventListener(e,bump);});};
      bump();
    }
  };

  RFPrefs.apply();
  document.addEventListener('DOMContentLoaded',function(){
    RFPrefs.apply();
    var p=RFPrefs.get();
    if(p.idleMinutes) RFPrefs.idle(p.idleMinutes);
  });
  window.addEventListener('storage',function(e){ if(e.key===key()) RFPrefs.apply(); });
})();
