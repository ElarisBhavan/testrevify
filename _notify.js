/* ═══════════════════════════════════════════════════════════════
   ReviFlow — in-app notifications
   Cross-tab via the storage event, same-tab via a short poll.
   Include on every signed-in page.
   ═══════════════════════════════════════════════════════════════ */
(function(){
  var QUEUE='rf_notify', SEEN='rf_notify_seen', MAX_AGE=120000;

  function me(){
    try{ var s=JSON.parse(sessionStorage.getItem('rf_session')||'null'); return s&&s.username||null; }
    catch(e){ return null; }
  }
  function readQ(){ try{ return JSON.parse(localStorage.getItem(QUEUE)||'[]'); }catch(e){ return []; } }
  function writeQ(l){ try{ localStorage.setItem(QUEUE,JSON.stringify(l)); }catch(e){} }
  function seen(){ try{ return JSON.parse(sessionStorage.getItem(SEEN)||'[]'); }catch(e){ return []; } }
  function markSeen(id){
    var s=seen(); s.push(id);
    try{ sessionStorage.setItem(SEEN,JSON.stringify(s.slice(-80))); }catch(e){}
  }

  /* ── styles, injected once ── */
  function styles(){
    if(document.getElementById('rf-notify-css'))return;
    var css=document.createElement('style');
    css.id='rf-notify-css';
    css.textContent=
      '#rfNotify{position:fixed;top:16px;right:16px;z-index:9999;display:flex;flex-direction:column;gap:10px;'+
        'pointer-events:none;max-width:min(360px,calc(100vw - 32px))}'+
      '.rfn{pointer-events:auto;display:flex;gap:12px;padding:14px 15px;border-radius:15px;'+
        'background:rgba(255,255,255,.86);backdrop-filter:blur(20px) saturate(170%);'+
        '-webkit-backdrop-filter:blur(20px) saturate(170%);'+
        'border:1px solid rgba(255,255,255,.9);box-shadow:0 22px 48px -22px rgba(13,26,22,.55);'+
        'transform:translateX(120%);opacity:0;transition:transform .5s cubic-bezier(.22,1,.36,1),opacity .4s}'+
      '.rfn.in{transform:none;opacity:1}'+
      '.rfn.out{transform:translateX(120%);opacity:0}'+
      '.rfn .ic{width:34px;height:34px;flex:none;border-radius:11px;display:grid;place-items:center;'+
        'background:#EBEDFF}'+
      '.rfn .ic svg{width:17px;height:17px;fill:none;stroke:#3B6FF5;stroke-width:2;'+
        'stroke-linecap:round;stroke-linejoin:round}'+
      '.rfn.meet .ic{background:#F1EBFE}.rfn.meet .ic svg{stroke:#8B5CF6}'+
      '.rfn .bd{min-width:0;flex:1}'+
      '.rfn b{display:block;font-family:Sora,system-ui,sans-serif;font-size:13px;font-weight:600;'+
        'letter-spacing:-.02em;color:#0D1A16;line-height:1.3}'+
      '.rfn p{font-size:11.8px;line-height:1.5;color:#5D6B67;margin-top:3px;word-break:break-word}'+
      '.rfn small{display:block;font-family:JetBrains Mono,ui-monospace,monospace;font-size:9.4px;'+
        'color:#93A19D;margin-top:5px}'+
      '.rfn .x{width:24px;height:24px;flex:none;border-radius:7px;display:grid;place-items:center;'+
        'border:none;background:none;cursor:pointer;color:#93A19D;transition:background .25s}'+
      '.rfn .x:hover{background:rgba(13,26,22,.07);color:#0D1A16}'+
      '.rfn .x svg{width:13px;height:13px;stroke:currentColor;fill:none;stroke-width:2.4;stroke-linecap:round}'+
      '.rfn .bar{position:absolute;left:0;right:0;bottom:0;height:2px;background:#3B6FF5;'+
        'border-radius:0 0 15px 15px;transform-origin:left;animation:rfnBar linear forwards}'+
      '.rfn.meet .bar{background:#8B5CF6}'+
      '@keyframes rfnBar{from{transform:scaleX(1)}to{transform:scaleX(0)}}'+
      '@media (prefers-reduced-motion:reduce){.rfn{transition:none}.rfn .bar{animation:none}}';
    document.head.appendChild(css);
  }
  function host(){
    var h=document.getElementById('rfNotify');
    if(!h){ h=document.createElement('div'); h.id='rfNotify'; document.body.appendChild(h); }
    return h;
  }

  /* ── a short two-tone chime, no audio file needed ── */
  function chime(){
    try{
      var Ctx=window.AudioContext||window.webkitAudioContext;
      if(!Ctx)return;
      var ctx=chime._ctx||(chime._ctx=new Ctx());
      if(ctx.state==='suspended')ctx.resume();
      [[880,0],[1174.7,.11]].forEach(function(n){
        var o=ctx.createOscillator(), g=ctx.createGain();
        o.type='sine'; o.frequency.value=n[0];
        var t=ctx.currentTime+n[1];
        g.gain.setValueAtTime(0,t);
        g.gain.linearRampToValueAtTime(.16,t+.02);
        g.gain.exponentialRampToValueAtTime(.0001,t+.34);
        o.connect(g); g.connect(ctx.destination);
        o.start(t); o.stop(t+.36);
      });
    }catch(e){}
  }

  function show(n){
    styles();
    var el=document.createElement('div');
    el.className='rfn '+(n.kind||'');
    el.style.position='relative';
    var dur=(n.ttl||8000);
    var icon = n.kind==='meet'
      ? '<circle cx="9" cy="9" r="3.4"/><path d="M2 20c0-3.4 3-5.6 7-5.6s7 2.2 7 5.6"/><circle cx="18" cy="8" r="2.6"/><path d="M17 20c0-2.6 1.2-4.4 3.6-4.4"/>'
      : '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/>';
    el.innerHTML=
      '<span class="ic"><svg viewBox="0 0 24 24">'+icon+'</svg></span>'+
      '<span class="bd"><b></b><p></p><small></small></span>'+
      '<button class="x" aria-label="Dismiss"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>'+
      '<span class="bar" style="animation-duration:'+dur+'ms"></span>';
    el.querySelector('b').textContent=n.title||'Notification';
    el.querySelector('p').textContent=n.body||'';
    el.querySelector('small').textContent=n.meta||'';
    if(!n.body)el.querySelector('p').style.display='none';
    if(!n.meta)el.querySelector('small').style.display='none';

    host().appendChild(el);
    requestAnimationFrame(function(){ el.classList.add('in'); });
    chime();

    var t=setTimeout(close,dur);
    function close(){
      clearTimeout(t);
      el.classList.remove('in'); el.classList.add('out');
      setTimeout(function(){ el.remove(); },520);
    }
    el.querySelector('.x').addEventListener('click',close);
    el.addEventListener('mouseenter',function(){ clearTimeout(t);
      var b=el.querySelector('.bar'); if(b)b.style.animationPlayState='paused'; });
    el.addEventListener('mouseleave',function(){ t=setTimeout(close,2500);
      var b=el.querySelector('.bar'); if(b)b.style.animationPlayState='running'; });
  }

  function drain(){
    var u=me(); if(!u)return;
    var now=Date.now(), s=seen();
    var q=readQ().filter(function(n){ return now-n.at < MAX_AGE; });
    q.forEach(function(n){
      if(s.indexOf(n.id)>-1)return;
      if(!n.to || n.to.indexOf(u)<0)return;
      if(n.from===u)return;                 /* don't notify the sender */
      markSeen(n.id);
      show(n);
    });
    writeQ(q);
  }

  window.RFNotify={
    /* send to one or many usernames */
    send:function(usernames,payload){
      var q=readQ();
      q.push(Object.assign({
        id:'n_'+Math.random().toString(36).slice(2,10)+Date.now().toString(36),
        to:[].concat(usernames||[]),
        from:me(),
        at:Date.now(),
        ttl:8000
      },payload||{}));
      writeQ(q.slice(-60));
      return true;
    },
    /* show one locally without queueing */
    local:show,
    check:drain
  };

  window.addEventListener('storage',function(e){ if(e.key===QUEUE) drain(); });
  document.addEventListener('DOMContentLoaded',function(){ setTimeout(drain,400); });
  setInterval(drain,3000);
})();
