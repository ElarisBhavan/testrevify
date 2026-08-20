/* ═══════════════════════════════════════════════════════════════
   Runtime safety net.
   A thrown error used to stop a page silently, which looks like
   missing data. Now it is reported, and the rest keeps working.
   ═══════════════════════════════════════════════════════════════ */
(function(){
  var shown = false;
  var EXPECT = '2026.08.15-a';

  /* Show which build is loaded. A mismatch means an old file or a cached page,
     which is by far the most common cause of a fault that "will not go away". */
  window.addEventListener('load', function(){
    setTimeout(function(){
      var got = window.RF_BUILD || 'unknown';
      var badge = document.createElement('div');
      badge.id = 'rf-build';
      badge.textContent = 'build ' + got;
      if(got !== EXPECT){
        badge.classList.add('stale');
        badge.textContent = 'stale files · ' + got;
        badge.title = 'This page expects build ' + EXPECT + ' but loaded ' + got +
          '. Replace every file from the package, then hard reload with Ctrl+Shift+R.';
        console.warn('ReviFlow: expected build ' + EXPECT + ' but _store.js is ' + got +
          '. Some files were not replaced, or the browser served a cached copy.');
      }
      document.body.appendChild(badge);
    }, 400);
  });

  function banner(msg, detail){
    if(shown) return;
    shown = true;
    var d = document.createElement('div');
    d.id = 'rf-error';
    d.innerHTML =
      '<span class="rf-err-ic">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round">' +
        '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17h.01"/></svg></span>' +
      '<span class="rf-err-b"><b>' + msg + '</b>' +
        '<small>' + explain(detail) + '</small>' +
        (detail ? '<code>' + String(detail).slice(0,180) + '</code>' : '') +
      '</span>' +
      '<button class="rf-err-x" aria-label="Dismiss">&times;</button>';
    (document.body || document.documentElement).appendChild(d);
    d.querySelector('.rf-err-x').addEventListener('click', function(){
      d.remove(); shown = false;
    });
    setTimeout(function(){ if(d.parentNode){ d.remove(); shown = false; } }, 12000);
  }

  /* A missing function almost always means one file is older than the rest. */
  function explain(msg){
    if(/is not defined|is not a function/i.test(String(msg||''))){
      return 'This usually means one file is older than the others. Replace every ' +
             'file from the package, then reload with Ctrl+Shift+R.';
    }
    return 'Your saved data is safe. Reload the page; if it repeats, ' +
           'open the browser console for the detail.';
  }

  window.addEventListener('error', function(e){
    if(e && e.message && /ResizeObserver|Script error/i.test(e.message)) return;
    console.error('ReviFlow error:', e.error || e.message);
    banner('Something on this page did not load', e.message);
  });
  window.addEventListener('unhandledrejection', function(e){
    var r = e && e.reason;
    console.error('ReviFlow promise rejection:', r);
    banner('Something on this page did not finish loading',
           r && (r.message || r));
  });

  var css = document.createElement('style');
  css.textContent =
    '#rf-error{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:2147483500;' +
      'display:flex;align-items:flex-start;gap:11px;max-width:min(520px,calc(100vw - 28px));' +
      'padding:13px 15px;border-radius:13px;background:#FBEAE4;border:1px solid rgba(206,95,62,.34);' +
      'box-shadow:0 22px 46px -20px rgba(13,26,22,.5);font-family:Manrope,system-ui,sans-serif}' +
    '#rf-error .rf-err-ic{flex:none;width:20px;height:20px}' +
    '#rf-error svg{width:20px;height:20px;stroke:#CE5F3E}' +
    '#rf-error .rf-err-b{min-width:0;flex:1}' +
    '#rf-error b{display:block;font-size:12.8px;font-weight:700;color:#9B3F24}' +
    '#rf-error small{display:block;font-size:11.2px;line-height:1.5;color:#9B3F24;opacity:.85;margin-top:3px}' +
    '#rf-error code{display:block;margin-top:6px;font-family:ui-monospace,monospace;font-size:10px;' +
      'color:#7A2E18;word-break:break-word}' +
    '#rf-error .rf-err-x{flex:none;border:none;background:none;font-size:19px;line-height:1;' +
      'color:#9B3F24;cursor:pointer;opacity:.6;padding:0 2px}' +
    '#rf-error .rf-err-x:hover{opacity:1}' +
    '#rf-build{position:fixed;right:10px;bottom:10px;z-index:2147483400;padding:4px 9px;' +
      'border-radius:7px;background:rgba(13,26,22,.72);color:#EAF6F0;' +
      'font:600 9.5px ui-monospace,monospace;letter-spacing:.05em;pointer-events:none;opacity:.5}' +
    '#rf-build.stale{background:#9B3F24;opacity:1;pointer-events:auto;cursor:help}';
  (document.head || document.documentElement).appendChild(css);
})();
