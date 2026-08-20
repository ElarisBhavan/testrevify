/* ═══════════════════════════════════════════════════════════════
   Shared date picker.

   Upgrades every <input type="date"> on the page into a calendar the
   whole field opens, with month and year dropdowns so a date of birth
   takes two clicks rather than forty scrolls.

   RFDate.enhance(scope)   — upgrade inputs inside a container
   RFDate.iso(date)        — a Date as YYYY-MM-DD, local
   RFDate.parse(str)       — YYYY-MM-DD as a local Date at noon
   RFDate.fmt(str)         — a friendly label
   ═══════════════════════════════════════════════════════════════ */
(function(){
  if(window.RFDate) return;

  var MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];
  var DOW = ['M','T','W','T','F','S','S'];

  function iso(d){
    if(!d) return '';
    return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+
           '-'+String(d.getDate()).padStart(2,'0');
  }
  function parse(s){
    if(!s) return null;
    var p = String(s).split('-');
    if(p.length < 3) return null;
    var d = new Date(+p[0], (+p[1]||1)-1, +p[2]||1, 12, 0, 0);
    return isNaN(d) ? null : d;
  }
  function fmt(s){
    var d = parse(s);
    if(!d) return '';
    return d.toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'});
  }
  function sameDay(a,b){
    return a && b && a.getFullYear()===b.getFullYear() &&
           a.getMonth()===b.getMonth() && a.getDate()===b.getDate();
  }

  var pop = null, active = null, view = null, opts = {};

  function build(){
    if(pop) return pop;
    pop = document.createElement('div');
    pop.className = 'rfdp';
    pop.setAttribute('role','dialog');
    pop.setAttribute('aria-label','Choose a date');
    document.body.appendChild(pop);

    pop.addEventListener('mousedown', function(e){ e.preventDefault(); });
    pop.addEventListener('click', onClick);
    pop.addEventListener('change', onChange);

    document.addEventListener('mousedown', function(e){
      if(!pop.classList.contains('on')) return;
      if(pop.contains(e.target)) return;
      if(active && active.wrap.contains(e.target)) return;
      close();
    });
    document.addEventListener('keydown', function(e){
      if(!pop.classList.contains('on')) return;
      if(e.key === 'Escape'){ close(); return; }
      if(!active) return;
      var step = e.key==='ArrowLeft' ? -1 : e.key==='ArrowRight' ? 1
               : e.key==='ArrowUp' ? -7 : e.key==='ArrowDown' ? 7 : 0;
      if(step){
        e.preventDefault();
        var base = parse(active.input.value) || view || new Date();
        var next = new Date(base.getFullYear(), base.getMonth(), base.getDate()+step, 12);
        if(inBounds(next)){ view = next; paint(); commit(next, false); }
      }
      if(e.key === 'Enter'){
        e.preventDefault();
        var d = parse(active.input.value);
        if(d) commit(d, true);
      }
    });
    window.addEventListener('scroll', function(){ if(pop.classList.contains('on')) place(); }, true);
    window.addEventListener('resize', function(){ if(pop.classList.contains('on')) place(); });
    return pop;
  }

  function bounds(){
    var min = parse(opts.min) || new Date(1900,0,1,12);
    var max = parse(opts.max) || new Date(2100,11,31,12);
    return { min:min, max:max };
  }
  function inBounds(d){
    var b = bounds();
    return d >= new Date(b.min.getFullYear(),b.min.getMonth(),b.min.getDate())
        && d <= new Date(b.max.getFullYear(),b.max.getMonth(),b.max.getDate(),23,59);
  }

  function paint(){
    var b = bounds();
    var y = view.getFullYear(), m = view.getMonth();
    var sel = parse(active.input.value);
    var today = new Date();

    /* first cell is the Monday on or before the first of the month */
    var first = new Date(y, m, 1, 12);
    var lead = (first.getDay() + 6) % 7;
    var start = new Date(y, m, 1 - lead, 12);

    var years = '';
    for(var yy = b.max.getFullYear(); yy >= b.min.getFullYear(); yy--){
      years += '<option value="'+yy+'"'+(yy===y?' selected':'')+'>'+yy+'</option>';
    }
    var months = MONTHS.map(function(n,i){
      return '<option value="'+i+'"'+(i===m?' selected':'')+'>'+n+'</option>'; }).join('');

    var cells = '';
    for(var i=0;i<42;i++){
      var d = new Date(start.getFullYear(), start.getMonth(), start.getDate()+i, 12);
      var cls = [];
      if(d.getMonth() !== m) cls.push('out');
      if(sameDay(d, today)) cls.push('today');
      if(sel && sameDay(d, sel)) cls.push('on');
      var off = !inBounds(d);
      cells += '<button type="button" class="rfdp-day '+cls.join(' ')+'" '+
        'data-d="'+iso(d)+'"'+(off?' disabled':'')+
        ' aria-label="'+d.toLocaleDateString()+'">'+d.getDate()+'</button>';
    }

    pop.innerHTML =
      '<div class="rfdp-head">'+
        '<button type="button" class="rfdp-nav" data-mv="-1" aria-label="Previous month">'+
          '<svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg></button>'+
        '<span class="rfdp-sel">'+
          '<select class="mo" aria-label="Month">'+months+'</select>'+
          '<select class="yr" aria-label="Year">'+years+'</select>'+
        '</span>'+
        '<button type="button" class="rfdp-nav" data-mv="1" aria-label="Next month">'+
          '<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg></button>'+
      '</div>'+
      '<div class="rfdp-dow">'+DOW.map(function(d){return '<span>'+d+'</span>';}).join('')+'</div>'+
      '<div class="rfdp-grid">'+cells+'</div>'+
      '<div class="rfdp-foot">'+
        '<button type="button" data-set="today">Today</button>'+
        (opts.required ? '' : '<button type="button" data-set="clear">Clear</button>')+
      '</div>';
  }

  function place(){
    if(!active) return;
    var r = active.input.getBoundingClientRect();
    var h = pop.offsetHeight || 340, w = pop.offsetWidth || 302;
    var below = window.innerHeight - r.bottom - 12;
    var top = (below < h && r.top > below) ? Math.max(8, r.top - h - 8) : r.bottom + 8;
    var left = Math.min(Math.max(10, r.left), window.innerWidth - w - 10);
    pop.style.top = top+'px';
    pop.style.left = left+'px';
  }

  function open(field){
    build();
    if(active && active.wrap) active.wrap.classList.remove('on');
    active = field;
    opts = { min: field.input.getAttribute('min'), max: field.input.getAttribute('max'),
             required: field.input.hasAttribute('required') };
    view = parse(field.input.value) || parse(field.input.getAttribute('data-default')) || new Date();
    field.wrap.classList.add('on');
    paint();
    pop.classList.add('on');
    place();
  }

  function close(){
    if(!pop) return;
    pop.classList.remove('on');
    if(active && active.wrap) active.wrap.classList.remove('on');
    active = null;
  }

  function commit(d, shut){
    if(!active) return;
    var was = active.input.value;
    active.input.value = iso(d);
    if(active.input.value !== was){
      /* both events fire, so existing listeners keep working unchanged */
      active.input.dispatchEvent(new Event('input',{bubbles:true}));
      active.input.dispatchEvent(new Event('change',{bubbles:true}));
    }
    if(shut) close(); else paint();
  }

  function onClick(e){
    var mv = e.target.closest('[data-mv]');
    if(mv){
      view = new Date(view.getFullYear(), view.getMonth() + (+mv.dataset.mv), 1, 12);
      paint(); return;
    }
    var day = e.target.closest('[data-d]');
    if(day && !day.disabled){ commit(parse(day.dataset.d), true); return; }

    var set = e.target.closest('[data-set]');
    if(set){
      if(set.dataset.set === 'today'){
        var t = new Date();
        if(inBounds(t)) commit(t, true);
      }else{
        active.input.value = '';
        active.input.dispatchEvent(new Event('input',{bubbles:true}));
        active.input.dispatchEvent(new Event('change',{bubbles:true}));
        close();
      }
    }
  }

  function onChange(e){
    if(!e.target.matches('.mo, .yr')) return;
    var mo = pop.querySelector('.mo'), yr = pop.querySelector('.yr');
    view = new Date(+yr.value, +mo.value, 1, 12);
    paint();
  }

  /* ── upgrade the inputs ── */
  function enhance(scope){
    var root = scope || document;
    var list = root.querySelectorAll ? root.querySelectorAll('input[type="date"]') : [];
    [].slice.call(list).forEach(function(input){
      if(input._rfdp) return;
      input._rfdp = true;

      var wrap = document.createElement('span');
      wrap.className = 'rfdp-field';
      input.parentNode.insertBefore(wrap, input);
      wrap.appendChild(input);

      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'rfdp-open';
      btn.tabIndex = -1;
      btn.setAttribute('aria-label','Open the calendar');
      btn.innerHTML = '<svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="16" rx="2.6"/>'+
        '<path d="M3.5 10h17M8 3v4M16 3v4"/></svg>';
      wrap.appendChild(btn);

      var field = { input:input, wrap:wrap };

      /* the whole field opens the calendar, not just a small icon */
      btn.addEventListener('click', function(e){
        e.preventDefault(); e.stopPropagation();
        if(active === field && pop && pop.classList.contains('on')) close();
        else open(field);
      });
      input.addEventListener('focus', function(){ open(field); });
      input.addEventListener('click', function(){ open(field); });
      input.addEventListener('keydown', function(e){
        if(e.key === 'Tab') close();
      });
    });
  }

  window.RFDate = { enhance:enhance, iso:iso, parse:parse, fmt:fmt, close:close };

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', function(){ enhance(); });
  }else{ enhance(); }

  /* forms are painted after data loads, so pick up new inputs as they appear */
  if(window.MutationObserver){
    var mo = new MutationObserver(function(muts){
      var found = false;
      muts.forEach(function(m){
        [].slice.call(m.addedNodes).forEach(function(n){
          if(n.nodeType !== 1) return;
          if(n.matches && n.matches('input[type="date"]')) found = true;
          else if(n.querySelector && n.querySelector('input[type="date"]')) found = true;
        });
      });
      if(found) enhance();
    });
    var startObserving = function(){
      if(document.body) mo.observe(document.body,{childList:true,subtree:true});
    };
    if(document.body) startObserving();
    else document.addEventListener('DOMContentLoaded', startObserving);
  }
})();
