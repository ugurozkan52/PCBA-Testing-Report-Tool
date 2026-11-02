// Browser build: the viewer scripts expect their data synchronously (Electron: sendSync),
// so they are added after the browser storage is ready, executing in their original order.
(function () {
  'use strict';
  var meta = document.querySelector('meta[name="asm-scripts"]');
  var list = ((meta && meta.content) || '').split(',').filter(Boolean);
  window.asm.ready.then(function () {
    var init = JSON.parse(window.asm.viewerInit());
    if (init.error && init.home) { location.replace(init.home); return; }
    // inserted before the load event: the browser fires it after they ran.
    // Inserted after it: call the page's onload ourselves once the last one ran.
    var late = document.readyState === 'complete';
    list.forEach(function (src, i) {
      var s = document.createElement('script');
      s.src = src;
      s.async = false;
      if (i === list.length - 1 && late) s.onload = function () { if (typeof window.onload === 'function') window.onload(new Event('load')); };
      document.head.appendChild(s);
    });
  }).catch(function (e) { console.error(e); });
})();
