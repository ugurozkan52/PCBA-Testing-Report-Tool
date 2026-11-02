// Glue between InteractiveHtmlBom and the desktop application:
// persistent per-board storage, assembly log, session bar, modals.
/* global pcbdata, config, settings, asm, __asmInit, EventHandler, IBOM_EVENT_TYPES, footprintIndexToHandler,
   currentHighlightedRowId, smoothScrollToRow, checkBomCheckbox, highlightNextRow, getStoredCheckboxRefs, topmostdiv */
'use strict';

var __asm = {
  settingsKv: Object.assign({}, __asmInit.settings || {}, { darkmode: String(!!__asmInit.dark) }),
  boardKv: Object.assign({}, __asmInit.boardKv || {}),
  session: __asmInit.session || {},
  operators: __asmInit.operators || [],
  boards: __asmInit.boards || [],
  modalOpen: false,
};

// ------------------------------------------------------------ storage layer
// Checkbox states are stored per board (serial number) using designators
// (not indices) so they survive a re-import of the design data.
function initStorage() { /* storage handled by application */ }

function readStorage(key) {
  var src = key.indexOf('checkbox_') === 0 ? __asm.boardKv : __asm.settingsKv;
  return Object.prototype.hasOwnProperty.call(src, key) ? src[key] : null;
}

function writeStorage(key, value) {
  if (key.indexOf('checkbox_') === 0) {
    var names = String(value == null ? '' : value).split(',').filter(function (x) { return x !== ''; }).map(function (v) {
      var i = parseInt(v, 10);
      return (String(i) === v && pcbdata.footprints[i]) ? pcbdata.footprints[i].ref : v;
    });
    var s = names.join(',');
    __asm.boardKv[key] = s;
    asm.kvSet('board', key, s);
  } else {
    __asm.settingsKv[key] = value == null ? null : String(value);
    asm.kvSet('project', key, value == null ? null : String(value));
  }
}

// ------------------------------------------------------------- helpers
function asmEl(tag, attrs, children) {
  var e = document.createElement(tag);
  for (var k in (attrs || {})) {
    if (k === 'raw' || attrs[k] === null || attrs[k] === undefined) continue;
    if (k === 'text') e.textContent = typeof attrs[k] === 'string' && !attrs.raw ? I18N.t(attrs[k]) : attrs[k];
    else if (k === 'title' || k === 'placeholder' || k === 'aria-label') e.setAttribute(k, I18N.t(attrs[k]));
    else if (k === 'html') e.innerHTML = attrs[k];
    else if (k.indexOf('on') === 0) e.addEventListener(k.substring(2), attrs[k]);
    else e.setAttribute(k, attrs[k]);
  }
  (children || []).forEach(function (c) { if (c) e.appendChild(typeof c === 'string' ? document.createTextNode(I18N.t(c)) : c); });
  return e;
}

function asmToastRoot() {
  var root = document.getElementById('asm-toasts');
  if (!root) {
    root = asmEl('div', { id: 'asm-toasts', role: 'status', 'aria-live': 'polite', 'aria-relevant': 'additions' });
    document.body.appendChild(root);
  }
  return root;
}
// Toasts stay while hovered or focused (WCAG 2.2.1) and are announced (4.1.3).
function asmTimedRemove(t, ms) {
  var left = ms, started = Date.now(), timer = null, paused = false;
  var go = function () {
    started = Date.now();
    timer = setTimeout(function () { t.classList.add('out'); setTimeout(function () { t.remove(); }, 450); }, left);
  };
  var pause = function () { if (paused) return; paused = true; clearTimeout(timer); left = Math.max(1500, left - (Date.now() - started)); };
  var resume = function () { if (!paused) return; paused = false; go(); };
  t.addEventListener('mouseenter', pause);
  t.addEventListener('mouseleave', resume);
  t.addEventListener('focusin', pause);
  t.addEventListener('focusout', resume);
  go();
}
function asmToast(msg, kind) {
  var root = asmToastRoot();
  var t = asmEl('div', { class: 'asm-toast ' + (kind || ''), text: msg });
  if (kind === 'err') t.setAttribute('role', 'alert');
  root.appendChild(t);
  asmTimedRemove(t, kind === 'err' ? 8000 : 4000);
  while (root.childElementCount > 4) root.firstChild.remove();
}

function asmFmtTime(ts) {
  var d = new Date(ts);
  return d.toLocaleDateString(I18N.locale()) + ' ' + d.toLocaleTimeString(I18N.locale());
}

function asmCheckboxNames() { return settings.checkboxes || []; }
function asmPlaceCheckbox() {
  var names = asmCheckboxNames();
  if (settings.markWhenChecked && names.indexOf(settings.markWhenChecked) >= 0) return settings.markWhenChecked;
  return names[names.length - 1];
}

// ------------------------------------------------------------ session bar
function asmRenderSession() {
  document.getElementById('asm-serial').textContent = __asm.session.serial || '-';
  document.getElementById('asm-operator').textContent = __asm.session.operator || '-';
  document.getElementById('asm-operator-btn').setAttribute('aria-label', I18N.t('Teknisyen: {op} — değiştir', { op: __asm.session.operator || '-' }));
}

function asmRenderProgress() {
  var root = document.getElementById('asm-progress');
  if (!root) return;
  root.innerHTML = '';
  var total = pcbdata.footprints.length - pcbdata.bom.skipped.length;
  var SEG = 28;
  asmCheckboxNames().forEach(function (n) {
    var c = getStoredCheckboxRefs(n).size;
    var filled = total ? Math.round((c / total) * SEG) : 0;
    var pads = asmEl('span', { class: 'asm-pads' + (c >= total && total ? ' full' : ''), role: 'progressbar', 'aria-label': n, 'aria-valuemin': '0', 'aria-valuemax': String(total), 'aria-valuenow': String(c), 'aria-valuetext': c + '/' + total });
    for (var i = 0; i < SEG; i++) pads.appendChild(asmEl('i', { class: i < filled ? 'on' : '' }));
    root.appendChild(asmEl('div', { class: 'asm-bar', title: n + ': ' + c + '/' + total }, [
      asmEl('span', { class: 'asm-bar-label', text: n, raw: 1, 'aria-hidden': 'true' }), pads,
      asmEl('span', { class: 'asm-bar-num', text: c + '/' + total, raw: 1, 'aria-hidden': 'true' }),
    ]));
  });
}

// ------------------------------------------------------------------ modals
var __asmOpener = null;
function asmCloseModal() {
  var root = document.getElementById('asm-modal-root');
  root.innerHTML = '';
  root.className = '';
  __asm.modalOpen = false;
  topmostdiv.inert = false;
  topmostdiv.removeAttribute('aria-hidden');
  var o = __asmOpener; __asmOpener = null;
  if (o && document.contains(o) && o.focus) setTimeout(function () { o.focus(); }, 0);
}
function asmFocusables(box) {
  return Array.prototype.filter.call(box.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'),
    function (x) { return !x.disabled && x.offsetParent !== null; });
}

function asmOpenModal(title, body, buttons, wide) {
  var root = document.getElementById('asm-modal-root');
  if (!__asm.modalOpen) __asmOpener = document.activeElement;
  if (typeof A11Y !== 'undefined') A11Y.closeMenu(false);
  root.innerHTML = '';
  root.className = 'open' + (topmostdiv.classList.contains('dark') ? ' dark' : '');
  var footer = asmEl('div', { class: 'asm-modal-footer' }, (buttons || []).map(function (b) {
    return asmEl('button', { class: 'asm-btn ' + (b.primary ? 'primary' : ''), text: b.label, onclick: b.onclick });
  }));
  var hid = 'asm-modal-title-' + Date.now();
  var box = asmEl('div', { class: 'asm-modal' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': hid }, [
    asmEl('div', { class: 'asm-modal-head' }, [asmEl('h3', { text: title, id: hid }), asmEl('button', { class: 'asm-x', text: '×', title: 'Kapat (Esc)', 'aria-label': I18N.t('Kapat'), onclick: asmCloseModal })]),
    asmEl('div', { class: 'asm-modal-body' }, [body]),
    footer,
  ]);
  root.appendChild(asmEl('div', { class: 'asm-backdrop', onclick: asmCloseModal }));
  root.appendChild(box);
  __asm.modalOpen = true;
  topmostdiv.inert = true;
  topmostdiv.setAttribute('aria-hidden', 'true');
  box.addEventListener('keydown', function (e) {
    if (e.key !== 'Tab') return;
    var f = asmFocusables(box);
    if (!f.length) return;
    var a = f[0], z = f[f.length - 1];
    if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); }
    else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
  });
  var first = box.querySelector('input:not([type=checkbox])') || box.querySelector('.asm-modal-footer .primary') || box.querySelector('button');
  if (first) setTimeout(function () { first.focus(); first.select && first.select(); }, 30);
}
// In-app confirmation (replaces window.confirm: own language, own labels).
function asmConfirm(question, okLabel, onOk) {
  asmOpenModal('Onay', asmEl('p', { class: 'asm-label', text: question, raw: 1 }), [
    { label: 'Vazgeç', onclick: asmCloseModal },
    { label: okLabel, primary: true, onclick: function () { asmCloseModal(); onOk(); } },
  ]);
}

function asmOperatorModal() {
  var dl = asmEl('datalist', { id: 'asm-op-list' }, __asm.operators.map(function (o) { return asmEl('option', { value: o }); }));
  var input = asmEl('input', { type: 'text', class: 'asm-input', id: 'asm-op-input', 'aria-label': 'Teknisyen', 'aria-required': 'true', autocomplete: 'off', list: 'asm-op-list', value: __asm.session.operator || '', placeholder: 'Ad Soyad / sicil no' });
  var save = function () {
    var v = input.value.trim();
    if (!v) { input.classList.add('err'); input.setAttribute('aria-invalid', 'true'); input.focus(); return; }
    if (v === __asm.session.operator) { asmCloseModal(); return; }
    asm.setOperator(v).then(function (s) {
      if (s) { __asm.session.operator = s.operator; if (__asm.operators.indexOf(s.operator) < 0) __asm.operators.unshift(s.operator); asmRenderSession(); asmToast(I18N.t('Teknisyen: {op}', { op: s.operator }), 'ok'); }
      asmCloseModal();
    });
  };
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter') save(); });
  input.addEventListener('input', function () { input.classList.remove('err'); input.removeAttribute('aria-invalid'); });
  var known = __asm.operators.slice(0, 16);
  var chips = asmEl('div', { class: 'asm-sn-grid', role: 'group', 'aria-label': 'Kayıtlı teknisyenler' }, known.map(function (o) {
    var cur = o === __asm.session.operator;
    return asmEl('button', { class: 'asm-sn' + (cur ? ' current' : ''), text: o, raw: 1, 'aria-current': cur ? 'true' : null, onclick: function () { input.value = o; save(); } });
  }));
  asmOpenModal('Teknisyen değiştir', asmEl('div', {}, [
    asmEl('label', { class: 'asm-label', for: 'asm-op-input', text: 'Bundan sonraki işlemler bu teknisyen adına kaydedilir.' }), input, dl,
    known.length > 1 || (known.length === 1 && known[0] !== __asm.session.operator) ? asmEl('div', { class: 'asm-label sub', text: 'Kayıtlı teknisyenler' }) : null,
    known.length > 1 || (known.length === 1 && known[0] !== __asm.session.operator) ? chips : null,
  ]), [
    { label: 'Vazgeç', onclick: asmCloseModal }, { label: 'Kaydet', primary: true, onclick: save },
  ]);
}

function asmBoardModal() {
  var input = asmEl('input', { type: 'text', class: 'asm-input', 'aria-label': 'Seri No', 'aria-required': 'true', placeholder: 'Yeni veya mevcut seri no', list: 'asm-sn-list' });
  var dl = asmEl('datalist', { id: 'asm-sn-list' }, __asm.boards.map(function (o) { return asmEl('option', { value: o }); }));
  var list = asmEl('div', { class: 'asm-sn-grid' }, __asm.boards.map(function (sn) {
    return asmEl('button', { class: 'asm-sn' + (sn === __asm.session.serial ? ' current' : ''), text: sn, raw: 1, 'aria-current': sn === __asm.session.serial ? 'true' : null, onclick: function () { input.value = sn; go(); } });
  }));
  var go = function () {
    var v = input.value.trim();
    if (!v) { input.classList.add('err'); input.setAttribute('aria-invalid', 'true'); input.focus(); return; }
    asm.startSession({ projectId: __asm.session.projectId, serial: v, operator: __asm.session.operator });
  };
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
  asmOpenModal('Kart (seri no) değiştir', asmEl('div', {}, [
    asmEl('label', { class: 'asm-label', text: 'Seri numarası girin veya okutun. Yeni numara girilirse yeni kart kaydı açılır.' }), input, dl,
    __asm.boards.length ? asmEl('div', { class: 'asm-label sub', text: 'Bu projedeki kartlar:' }) : null, list,
  ]), [{ label: 'Vazgeç', onclick: asmCloseModal }, { label: 'Aç', primary: true, onclick: go }]);
}

var __asmLogTypes = {
  'check': 'İşaretlendi', 'uncheck': 'İşaret kaldırıldı', 'session-open': 'Oturum açıldı', 'session-close': 'Oturum kapandı',
  'operator-change': 'Teknisyen değişti', 'board-create': 'Kart oluşturuldu', 'board-complete': 'Kart tamamlandı',
  'project-create': 'Proje oluşturuldu', 'project-reimport': 'Veri yeniden içe aktarıldı', 'test': 'Test',
};

function asmLogModal() {
  var onlyThis = asmEl('input', { type: 'checkbox', checked: 'checked' });
  var tableWrap = asmEl('div', { class: 'asm-log-wrap' });
  var load = function () {
    asm.logList({ projectId: __asm.session.projectId, serial: onlyThis.checked ? __asm.session.serial : null, limit: 2000 }).then(function (rows) {
      var tb = asmEl('tbody', {}, rows.map(function (r) {
        return asmEl('tr', { class: 'ev-' + r.type }, [
          asmEl('td', { text: asmFmtTime(r.ts), raw: 1 }), asmEl('td', { text: r.serial || '', raw: 1 }), asmEl('td', { text: r.operator || '', raw: 1 }),
          asmEl('td', { text: I18N.t(__asmLogTypes[r.type] || r.type), raw: 1 }), asmEl('td', { text: r.checkbox || '', raw: 1 }),
          asmEl('td', { class: 'refs', text: (r.refs || []).join(', '), raw: 1 }), asmEl('td', { text: r.value || r.note || '', raw: 1 }),
        ]);
      }));
      var t = asmEl('table', { class: 'asm-log' }, [asmEl('thead', {}, [asmEl('tr', {}, ['Zaman', 'Seri No', 'Teknisyen', 'Olay', 'Sütun', 'Referanslar', 'Değer / Not'].map(function (h) { return asmEl('th', { text: h }); }))]), tb]);
      tableWrap.innerHTML = '';
      tableWrap.appendChild(rows.length ? t : asmEl('p', { text: 'Kayıt yok.' }));
    });
  };
  onlyThis.addEventListener('change', load);
  asmOpenModal(I18N.t('Montaj kaydı — {name}', { name: __asm.session.projectName || '' }), asmEl('div', {}, [
    asmEl('label', { class: 'asm-label inline' }, [onlyThis, ' ' + I18N.t('Sadece bu kart (SN {sn})', { sn: __asm.session.serial })]), tableWrap,
  ]), [
    { label: 'CSV olarak kaydet', onclick: function () { asm.logExportCsv({ projectId: __asm.session.projectId, serial: onlyThis.checked ? __asm.session.serial : null }).then(function (p) { if (p) asmToast(I18N.t('Kaydedildi: {file}', { file: p }), 'ok'); }); } },
    { label: 'Kapat', primary: true, onclick: asmCloseModal },
  ], true);
  load();
}

// --------------------------------------------------------------- logging
// Snapshot of each column's state, so that log / undo only cover the parts
// that really changed (e.g. "place" on an already placed line is a no-op).
var __asmSnap = {};
function asmSnapshot(name) { __asmSnap[name] = new Set(getStoredCheckboxRefs(name)); }
EventHandler.registerCallback(IBOM_EVENT_TYPES.CHECKBOX_CHANGE_EVENT, function (e) {
  var a = e.args;
  var prev = __asmSnap[a.checkbox];
  asmSnapshot(a.checkbox);
  if (prev) {
    var on = a.state === 'checked';
    a = Object.assign({}, a, { refs: (a.refs || []).filter(function (r) { return on ? !prev.has(r[1]) : prev.has(r[1]); }) });
    if (!a.refs.length) return;
  }
  var refs = (a.refs || []).map(function (r) { return r[0]; });
  var vals = [];
  if (a.refs && a.refs.length) {
    var f = pcbdata.bom.fields[a.refs[0][1]] || [];
    vals = f.filter(function (x) { return x !== '' && x != null; }).slice(0, 3);
  }
  asm.logAdd({ type: a.state === 'checked' ? 'check' : 'uncheck', checkbox: a.checkbox, state: a.state, refs: refs, value: vals.join(' | ') });
  asmRenderProgress();
  if (typeof redrawIfInitDone === 'function') redrawIfInitDone();
  if (typeof V3D !== 'undefined') V3D.sync();
  var short = refs.length > 6 ? refs.slice(0, 6).join(', ') + ' … (+' + (refs.length - 6) + ')' : refs.join(', ');
  if (!__asmBulk) asmUndoToast((a.state === 'checked' ? '✓ ' : '✗ ') + a.checkbox + ': ' + short, a.state === 'checked' ? 'ok' : 'warn', { checkbox: a.checkbox, state: a.state, refs: refs, ids: (a.refs || []).map(function (r) { return r[1]; }) });
  var total = pcbdata.footprints.length - pcbdata.bom.skipped.length;
  if (a.state === 'checked' && asmCheckboxNames().every(function (n) { return getStoredCheckboxRefs(n).size >= total; })) {
    asmToast(I18N.t('Kart tamamlandı: SN {sn}', { sn: __asm.session.serial }), 'done');
  }
});

var __asmHlTimer = null;
EventHandler.registerCallback(IBOM_EVENT_TYPES.HIGHLIGHT_EVENT, function (e) {
  var refs = e.args && e.args.refs;
  if (!refs || !refs.length) return;
  clearTimeout(__asmHlTimer);
  __asmHlTimer = setTimeout(function () {
    __asm.boardKv.lastRef = refs[0][0];
    asm.kvSet('board', 'lastRef', refs[0][0]);
  }, 400);
});

// ------------------------------------------------------------- keyboard
function asmIsTyping() {
  var a = document.activeElement;
  if (!a) return false;
  if (a.isContentEditable || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT') return true;
  return a.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|range|color)$/i.test(a.type);
}
function asmSingleKeyOn() { return readStorage('singleKey') !== 'false'; }
var __asmOrigKey = document.onkeydown;
document.onkeydown = function (e) {
  if (__asm.modalOpen) {
    if (e.key === 'Escape') asmCloseModal();
    return;
  }
  if (e.key === 'Escape' && document.getElementById('bot').classList.contains('asm-maxed')) {
    var m = (document.getElementById('bot').className.match(/asm-max-(\w+)/) || [])[1];
    if (m) asmToggleMax(m);
    return;
  }
  if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'z' || e.key === 'Z') && !asmIsTyping()) {
    if (__asmLastUndo) { var u = __asmLastUndo; __asmLastUndo = null; asmUndo(u); e.preventDefault(); }
    else asmToast(I18N.t('Geri alınacak işlem yok'), 'info');
    return;
  }
  // test mode: the assembly row shortcuts would select parts behind the probes
  if (typeof TEST !== 'undefined' && TEST.isOn() && !asmIsTyping() && /^(ArrowUp|ArrowDown|n|N)$/.test(e.key) && !e.altKey && !e.ctrlKey) return;
  if ((e.key === 'n' || e.key === 'N') && !e.altKey && !e.ctrlKey && !e.metaKey && asmSingleKeyOn() && !asmIsTyping()) {
    if (currentHighlightedRowId !== null) {
      checkBomCheckbox(currentHighlightedRowId, asmPlaceCheckbox());
      highlightNextRow();
      e.preventDefault();
    }
    return;
  }
  return __asmOrigKey.call(document, e);
};


// ------------------------------------------------------------ PCB colour
var ASM_BOARD_COLORS = [
  // board = solder mask over bare laminate, track/zone = mask over copper (lighter tint of the same mask)
  { key: 'green', name: 'Yeşil', board: '#1d4a36', track: '#2f6e50', zone: '#275f45', silk: '#eef2ee', edge: '#e7eee8' },
  { key: 'blue', name: 'Mavi', board: '#1b3d6e', track: '#2c5a9a', zone: '#244d85', silk: '#f2f4f8', edge: '#e6ebf3' },
  { key: 'red', name: 'Kırmızı', board: '#7a2020', track: '#a03434', zone: '#8d2a2a', silk: '#f6f0ee', edge: '#f3e4e1' },
  { key: 'black', name: 'Siyah', board: '#161616', track: '#2c2c2c', zone: '#222222', silk: '#f0f0f0', edge: '#d8d8d8' },
  { key: 'purple', name: 'Mor', board: '#3b2563', track: '#55388a', zone: '#4a2f78', silk: '#f3f0f8', edge: '#e5def2' },
  { key: 'white', name: 'Beyaz', board: '#f1f1ec', track: '#dcdcd2', zone: '#e6e6de', silk: '#1b1b1b', edge: '#4a4a4a' },
  { key: 'yellow', name: 'Sarı', board: '#c9a227', track: '#dcb84a', zone: '#d2ad3a', silk: '#1b1b1b', edge: '#4a3a08' },
];
function asmApplyBoardColor(key, persist) {
  var c = ASM_BOARD_COLORS.find(function (x) { return x.key === key; }) || ASM_BOARD_COLORS[0];
  var st = topmostdiv.style;
  st.setProperty('--board-color', c.board);
  st.setProperty('--track-color', c.track);
  st.setProperty('--zone-color', c.zone);
  st.setProperty('--silkscreen-edge-color', c.silk);
  st.setProperty('--silkscreen-polygon-color', c.silk);
  st.setProperty('--silkscreen-text-color', c.silk);
  st.setProperty('--pcb-edge-color', c.edge);
  document.querySelectorAll('.asm-swatch').forEach(function (b) { var on = b.dataset.key === c.key; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); });
  st.setProperty('--pad-color-highlight', c.key === 'yellow' ? '#18e0ff' : '#ffd400');
  st.setProperty('--track-color-highlight', c.key === 'yellow' ? '#18e0ff' : '#ffd400');
  if (persist) writeStorage('boardColor', c.key);
  if (typeof resizeAll === 'function' && initDone) resizeAll();
  if (typeof V3D !== 'undefined') V3D.applyBoardColor();
}
function asmInitBoardColors() {
  var root = document.getElementById('asm-board-colors');
  ASM_BOARD_COLORS.forEach(function (c) {
    var b = asmEl('button', { class: 'asm-swatch', title: c.name, 'aria-label': I18N.t('Maske rengi: {c}', { c: I18N.t(c.name) }), style: 'background:' + c.board });
    b.dataset.key = c.key;
    b.onclick = function (e) { e.preventDefault(); asmApplyBoardColor(c.key, true); };
    root.appendChild(b);
  });
  asmApplyBoardColor(readStorage('boardColor') || 'green', false);
}

// ---------------------------------------------------- maximise a single pane
function asmToggleMax(pane) {
  var bot = document.getElementById('bot');
  var cls = 'asm-max-' + pane;
  var on = !bot.classList.contains(cls);
  ['bomdiv', 'frontcanvas', 'backcanvas', 'asm3d'].forEach(function (p) { bot.classList.remove('asm-max-' + p); });
  if (on) bot.classList.add(cls);
  bot.classList.toggle('asm-maxed', on);
  document.querySelectorAll('.asm-max').forEach(function (b) { b.setAttribute('aria-pressed', on && b.dataset.pane === pane ? 'true' : 'false'); });
  setTimeout(function () { if (typeof resizeAll === 'function') resizeAll(); if (typeof V3D !== 'undefined') V3D.resize(); }, 0);
}
function asmInitMax() {
  document.querySelectorAll('.asm-max').forEach(function (b) {
    var nm = { bomdiv: 'Dizgi listesi', frontcanvas: 'Üst yüz', backcanvas: 'Alt yüz', asm3d: '3D görünüm' }[b.dataset.pane];
    b.setAttribute('aria-label', I18N.t('{pane} panelini tam ekran yap', { pane: I18N.t(nm) }));
    b.addEventListener('keydown', function (e) { e.stopPropagation(); if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); asmToggleMax(b.dataset.pane); } });
    b.onclick = function (e) { e.stopPropagation(); asmToggleMax(b.dataset.pane); };
    ['pointerdown', 'pointerup', 'pointermove', 'mousedown', 'mouseup', 'wheel'].forEach(function (ev) { b.addEventListener(ev, function (e) { e.stopPropagation(); }); });
  });
}


// ============================================================ v1.9 usability
// --- current line ("Şimdi") and step buttons
function asmCurrentRefs() {
  if (!currentHighlightedRowId) return null;
  var h = highlightHandlers.find(function (x) { return x.id === currentHighlightedRowId; });
  return h && highlightedFootprints.length ? highlightedFootprints : null;
}
function asmRenderNow() {
  var el = document.getElementById('asm-now');
  var ids = asmCurrentRefs();
  if (!ids) { el.textContent = I18N.t('Bir BOM satırı seçin'); el.classList.add('empty'); return; }
  var refs = ids.map(function (i) { return pcbdata.footprints[i].ref; });
  var f = (pcbdata.bom.fields[ids[0]] || []).filter(function (x) { return x !== '' && x != null; });
  el.classList.remove('empty');
  el.innerHTML = '';
  el.appendChild(asmEl('span', { class: 'now-refs', text: refs.join(', '), raw: 1, title: refs.join(', ') }));
  if (f[0]) el.appendChild(asmEl('span', { class: 'now-val', text: f[0], raw: 1 }));
  el.appendChild(asmEl('span', { class: 'now-qty', text: refs.length + ' ' + I18N.t('adet'), raw: 1 }));
}
function asmStep(dir) {
  if (dir < 0) highlightPreviousRow(); else highlightNextRow();
}
function asmPlaceCurrent() {
  if (currentHighlightedRowId === null) { highlightNextRow(); return; }
  checkBomCheckbox(currentHighlightedRowId, asmPlaceCheckbox());
  highlightNextRow();
}

// --- dim the board while a line / net is selected, restartable blink
function asmUpdateFocus() {
  var on = highlightedFootprints.length > 0 || highlightedNet !== null || (typeof TEST !== 'undefined' && !!TEST.probes());
  topmostdiv.classList.toggle('asm-has-hl', on);
  ['F_hl', 'B_hl'].forEach(function (id) {
    var c = document.getElementById(id);
    c.classList.remove('blink');
    void c.offsetWidth; // restart the animation for every new selection
    if (on) c.classList.add('blink');
  });
  asmRenderNow();
  if (typeof V3D !== 'undefined') V3D.sync();
}
function asmApplyBlink(mode, persist) {
  topmostdiv.dataset.blink = mode;
  document.getElementById('asm-blink').value = mode;
  if (persist) writeStorage('blinkMode', mode);
}
var __asmOrigDrawHighlights = drawHighlights;
drawHighlights = function () { __asmOrigDrawHighlights(); asmUpdateFocus(); };

// --- larger targets: the whole checkbox cell toggles the box
document.addEventListener('click', function (e) {
  var td = e.target;
  if (td && td.tagName === 'TD' && td.parentNode && td.parentNode.parentNode && td.parentNode.parentNode.id === 'bombody') {
    var cb = td.querySelector('input[type=checkbox]');
    if (cb) { cb.click(); }
  }
});

// --- bulk (double-click on column header) asks first
var __asmOrigSetAll = checkboxSetUnsetAllHandler;
checkboxSetUnsetAllHandler = function (name) {
  var inner = __asmOrigSetAll(name);
  return function () {
    var n = pcbdata.footprints.length - pcbdata.bom.skipped.length;
    var allSet = getStoredCheckboxRefs(name).size >= n;
    var q = I18N.t(allSet ? '"{col}" sütunundaki tüm işaretler ({n} parça) kaldırılsın mı?' : '"{col}" sütunundaki tüm satırlar ({n} parça) işaretlensin mi?', { col: name, n: n });
    asmConfirm(q, allSet ? 'İşaretleri kaldır' : 'Tümünü işaretle', function () {
      __asmBulk = true; inner(); __asmBulk = false;
      asmToast(I18N.t('Toplu işlem uygulandı: {col}', { col: name }), 'warn');
    });
  };
};
var __asmBulk = false;

// --- undo for the last check / uncheck
function asmUndo(ev) {
  var set = getStoredCheckboxRefs(ev.checkbox);
  ev.ids.forEach(function (id) { if (ev.state === 'checked') set.delete(id); else set.add(id); });
  settings.checkboxStoredRefs[ev.checkbox] = Array.from(set).join(',');
  writeStorage('checkbox_' + ev.checkbox, settings.checkboxStoredRefs[ev.checkbox]);
  var keep = currentHighlightedRowId ? highlightedFootprints.slice() : [];
  setMarkWhenChecked(settings.markWhenChecked); // rebuilds table + marks
  if (keep.length && footprintIndexToHandler[keep[0]]) footprintIndexToHandler[keep[0]]();
  redrawIfInitDone();
  asmRenderProgress();
  if (typeof V3D !== 'undefined') V3D.sync();
  asmSnapshot(ev.checkbox);
  asm.logAdd({ type: ev.state === 'checked' ? 'uncheck' : 'check', checkbox: ev.checkbox, state: ev.state === 'checked' ? 'unchecked' : 'checked', refs: ev.refs, note: I18N.t('geri alındı') });
  asmToast(I18N.t('Geri alındı: {refs}', { refs: ev.refs.slice(0, 6).join(', ') }), 'info');
}
var __asmLastUndo = null;
function asmUndoToast(msg, kind, ev) {
  __asmLastUndo = ev; // Ctrl+Z works after the toast is gone, too
  var root = asmToastRoot();
  var btn = asmEl('button', { class: 'asm-undo', text: 'Geri al', title: 'Geri al (Ctrl+Z)' });
  var t = asmEl('div', { class: 'asm-toast ' + kind }, [asmEl('span', { text: msg, raw: 1 }), btn]);
  btn.onclick = function () { t.remove(); if (__asmLastUndo === ev) __asmLastUndo = null; asmUndo(ev); };
  root.appendChild(t);
  asmTimedRemove(t, 10000);
  while (root.childElementCount > 4) root.firstChild.remove();
}
function asmRenderHint() {
  var h = document.getElementById('asm-hint');
  var txt = I18N.t('↑ ↓ satır · N yerleştir ve sonraki · Ctrl+Z geri al · Esc paneli küçült · Alt+F filtre · Kartta: oklar kaydır, + − yakınlaştır, 0 sığdır');
  if (!asmSingleKeyOn()) txt = txt.replace(/ · N [^·]+/, '');
  h.textContent = txt;
}
// dark mode is an application-wide preference (shared with the home screen)
var __asmOrigSetDark = setDarkMode;
setDarkMode = function (v) { __asmOrigSetDark(v); asm.setDark(!!v); document.documentElement.classList.toggle('dark', !!v); if (typeof V3D !== 'undefined') V3D.applyTheme(); };

// ---------------------------------------------------------------- startup
var __asmOrigOnload = window.onload;
window.onload = function (e) {
  if (!pcbdata) return;
  I18N.translateDom(document.body);
  __asmOrigOnload.call(window, e);
  asmRenderSession();
  asmRenderProgress();
  asmCheckboxNames().forEach(asmSnapshot);
  document.getElementById('asm-home').onclick = function () { asm.goHome(); };
  document.getElementById('asm-operator-btn').onclick = asmOperatorModal;
  document.getElementById('asm-board-btn').onclick = asmBoardModal;
  document.getElementById('asm-log-btn').onclick = asmLogModal;
  document.getElementById('asm-about-btn').onclick = function () { asm.showAbout(); };
  document.getElementById('asm-proj').textContent = pcbdata.metadata.title || '';
  document.getElementById('asm-rev').textContent = pcbdata.metadata.revision ? 'Rev ' + pcbdata.metadata.revision : '';
  asmInitBoardColors();
  asmInitMax();
  document.getElementById('asm-prev').onclick = function () { asmStep(-1); };
  document.getElementById('asm-next').onclick = function () { asmStep(1); };
  document.getElementById('asm-place').onclick = asmPlaceCurrent;
  var bsel = document.getElementById('asm-blink');
  bsel.onchange = function () { asmApplyBlink(bsel.value, true); };
  asmApplyBlink(readStorage('blinkMode') || 'short', false);
  var sk = document.getElementById('asm-singlekey');
  sk.checked = asmSingleKeyOn();
  sk.onchange = function () { writeStorage('singleKey', sk.checked ? 'true' : 'false'); asmRenderHint(); };
  asmRenderHint();
  document.getElementById('fl-btn').textContent = I18N.t('Üst yüz');
  document.getElementById('fb-btn').textContent = I18N.t('İki yüz');
  document.getElementById('bl-btn').textContent = I18N.t('Alt yüz');
  asmUpdateFocus();
  EventHandler.registerCallback(IBOM_EVENT_TYPES.BOM_BODY_CHANGE_EVENT, function () { asmRenderProgress(); if (typeof V3D !== 'undefined') V3D.sync(); });
  if (typeof V3D !== 'undefined') { try { V3D.init(); } catch (err) { console.error(err); } }
  if (typeof TEST !== 'undefined') { try { TEST.init(); } catch (err) { console.error(err); } }
  // restore the row the operator was working on
  var last = __asm.boardKv.lastRef;
  if (last) {
    for (var i = 0; i < pcbdata.footprints.length; i++) {
      if (pcbdata.footprints[i].ref === last && footprintIndexToHandler[i]) {
        footprintIndexToHandler[i]();
        smoothScrollToRow(currentHighlightedRowId);
        asmToast(I18N.t('Kaldığınız yer: {ref}', { ref: last }), 'info');
        break;
      }
    }
  }
};
