// Montaj Görüntüleyici — v2.0 accessibility layer (WCAG 2.1 AA).
// Shared by the desktop viewer and the exported stand-alone HTML, so it must
// not depend on the application bridge (window.asm).
/* global drawHighlights:writable, allcanvas, redrawCanvas, resetTransform, highlightedFootprints, pcbdata, I18N */
'use strict';

var A11Y = (function () {
  var T = function (s, v) { return (typeof I18N !== 'undefined') ? I18N.t(s, v) : s; };

  // ---------------------------------------------------------------- menus
  // iBOM opened its menus on :hover only (keyboard users could not reach the
  // settings). Each menu button now toggles its panel and reports its state.
  var MENU_NAMES = { menubtn: 'Ayarlar', statsbtn: 'Kart istatistikleri', iobtn: 'Dışa aktar', visbtn: 'Sütunlar' };
  var openMenu = null;

  function closeMenu(focusBtn) {
    if (!openMenu) return;
    var m = openMenu;
    openMenu = null;
    m.classList.remove('open');
    var b = m.querySelector(':scope > button');
    if (b) { b.setAttribute('aria-expanded', 'false'); if (focusBtn) b.focus(); }
  }

  function initMenu(menu, idx) {
    var btn = menu.querySelector(':scope > button');
    var panel = menu.querySelector(':scope > .menu-content');
    if (!btn || !panel || btn.dataset.a11y) return;
    btn.dataset.a11y = '1';
    var cls = Object.keys(MENU_NAMES).find(function (c) { return btn.classList.contains(c); });
    var name = T(MENU_NAMES[cls] || 'Menü');
    if (!panel.id) panel.id = 'a11y-menu-' + idx;
    btn.setAttribute('aria-label', name);
    btn.setAttribute('title', name);
    btn.setAttribute('aria-haspopup', 'true');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-controls', panel.id);
    panel.setAttribute('role', 'group');
    panel.setAttribute('aria-label', name);
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var willOpen = !menu.classList.contains('open');
      closeMenu(false);
      if (willOpen) {
        menu.classList.add('open');
        btn.setAttribute('aria-expanded', 'true');
        openMenu = menu;
        var first = panel.querySelector('input, select, button, [tabindex]:not([tabindex="-1"])');
        if (first) first.focus();
      }
    });
    menu.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && menu.classList.contains('open')) { e.stopPropagation(); e.preventDefault(); closeMenu(true); }
    });
    // Leaving the menu with Tab closes it.
    menu.addEventListener('focusout', function (e) {
      if (menu.classList.contains('open') && e.relatedTarget && !menu.contains(e.relatedTarget)) closeMenu(false);
    });
  }

  function initMenus() {
    document.querySelectorAll('#bomcontrols .menu, .menu').forEach(initMenu);
    document.addEventListener('click', function (e) { if (openMenu && !openMenu.contains(e.target)) closeMenu(false); });
  }

  // ------------------------------------------------- icon-only button names
  function labelIconButtons(root) {
    (root || document).querySelectorAll('button').forEach(function (b) {
      if (b.getAttribute('aria-label')) return;
      var txt = (b.textContent || '').trim();
      var title = b.getAttribute('title');
      if (!txt && title) b.setAttribute('aria-label', title);
    });
    var cp = document.getElementById('copy');
    if (cp && !cp.getAttribute('aria-label')) cp.setAttribute('aria-label', T('BOM tablosunu panoya kopyala'));
  }

  // Toggle groups (layout / mode buttons) expose the selected one.
  function syncPressed() {
    document.querySelectorAll('#bomcontrols .button-container button').forEach(function (b) {
      b.setAttribute('aria-pressed', b.classList.contains('depressed') ? 'true' : 'false');
    });
  }

  // --------------------------------------------------------- board canvases
  // Keyboard: arrows pan, + / − zoom about the centre, 0 fits the board.
  function canvasName(side) { return T(side === 'F' ? 'Üst yüz kart görünümü' : 'Alt yüz kart görünümü'); }
  function selectionText() {
    if (typeof highlightedFootprints === 'undefined' || !highlightedFootprints.length) return T('Seçim yok');
    var refs = highlightedFootprints.map(function (i) { return pcbdata.footprints[i].ref; });
    var more = refs.length > 12 ? ' … (+' + (refs.length - 12) + ')' : '';
    return T('Seçili: {refs}', { refs: refs.slice(0, 12).join(', ') + more });
  }
  function updateCanvasLabels() {
    [['frontcanvas', 'F'], ['backcanvas', 'B']].forEach(function (p) {
      var d = document.getElementById(p[0]);
      if (!d) return;
      d.setAttribute('aria-label', canvasName(p[1]) + '. ' + selectionText() + '. ' + T('Ok tuşları kaydırır, + / − yakınlaştırır, 0 sığdırır.'));
    });
  }
  function initCanvases() {
    [['frontcanvas', 'front', 'F'], ['backcanvas', 'back', 'B']].forEach(function (p) {
      var d = document.getElementById(p[0]);
      if (!d) return;
      d.setAttribute('tabindex', '0');
      d.setAttribute('role', 'group');
      d.setAttribute('aria-roledescription', T('kart görünümü'));
      d.classList.add('a11y-canvas');
      d.addEventListener('keydown', function (e) {
        if (e.altKey || e.ctrlKey || e.metaKey) return;
        var ld = allcanvas && allcanvas[p[1]];
        if (!ld) return;
        var t = ld.transform, step = 60 * devicePixelRatio / t.zoom, handled = true;
        var zoomBy = function (m) {
          t.zoom *= m;
          var zd = (1 - m) / t.zoom;
          t.panx += devicePixelRatio * (d.clientWidth / 2) * zd;
          t.pany += devicePixelRatio * (d.clientHeight / 2) * zd;
        };
        switch (e.key) {
          case 'ArrowLeft': t.panx += step; break;
          case 'ArrowRight': t.panx -= step; break;
          case 'ArrowUp': t.pany += step; break;
          case 'ArrowDown': t.pany -= step; break;
          case '+': case '=': zoomBy(1.25); break;
          case '-': case '_': zoomBy(0.8); break;
          case '0': resetTransform(ld); handled = 'reset'; break;
          default: handled = false;
        }
        if (handled) {
          e.preventDefault();
          e.stopPropagation();
          if (handled !== 'reset') redrawCanvas(ld);
        }
      });
    });
    updateCanvasLabels();
  }

  // -------------------------------------------------------------- landmarks
  function initLandmarks() {
    var top = document.getElementById('top');
    if (top) top.setAttribute('role', 'banner');
    var bot = document.getElementById('bot');
    if (bot) { bot.setAttribute('role', 'main'); bot.setAttribute('aria-label', T('Dizgi listesi ve kart görünümü')); }
    var bt = document.getElementById('bomtable');
    if (bt) bt.setAttribute('aria-label', T('Dizgi listesi'));
    ['reflookup', 'filter'].forEach(function (id) {
      var i = document.getElementById(id);
      if (i && !i.getAttribute('aria-label')) i.setAttribute('aria-label', i.getAttribute('placeholder') || id);
    });
    var tt = document.getElementById('toptoggle');
    if (tt) {
      tt.setAttribute('role', 'button');
      tt.setAttribute('tabindex', '0');
      tt.setAttribute('aria-label', T('Üst paneli gizle / göster'));
      tt.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tt.click(); } });
    }
  }

  function init() {
    initLandmarks();
    initMenus();
    labelIconButtons();
    syncPressed();
    initCanvases();
    if (typeof drawHighlights === 'function') {
      var orig = drawHighlights;
      drawHighlights = function () { orig.apply(this, arguments); updateCanvasLabels(); };
    }
    // keep pressed state in sync after iBOM changes the layout / mode
    var bc = document.getElementById('bomcontrols');
    if (bc && window.MutationObserver) {
      new MutationObserver(syncPressed).observe(bc, { attributes: true, subtree: true, attributeFilter: ['class'] });
    }
  }

  return { init: init, closeMenu: closeMenu, updateCanvasLabels: updateCanvasLabels, labelIconButtons: labelIconButtons };
})();

(function () {
  var prev = window.onload;
  window.onload = function (e) {
    if (prev) prev.call(window, e);
    try { A11Y.init(); } catch (err) { console.error(err); }
  };
})();
