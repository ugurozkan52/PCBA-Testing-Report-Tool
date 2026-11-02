/* global asm */
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const t = (s, v) => I18N.t(s, v);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false || k === 'raw') continue;
    if (k === 'text') e.textContent = typeof v === 'string' && !attrs.raw ? t(v) : v;
    else if (k === 'title' || k === 'placeholder' || k === 'aria-label') e.setAttribute(k, attrs.raw && k === 'aria-label' ? v : t(v));
    else if (k === 'html') e.innerHTML = v;
    else if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.substring(2), v);
    else if (k === 'value') e.value = v;
    else if (v === true) e.setAttribute(k, '');
    else e.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) e.appendChild(typeof c === 'string' ? document.createTextNode(t(c)) : typeof c === 'number' ? document.createTextNode(String(c)) : c);
  return e;
}
// Toasts are announced (live region) and stay while hovered / focused.
function toast(msg, kind) {
  const n = el('div', { class: 'toast ' + (kind || ''), text: msg, role: kind === 'err' ? 'alert' : null });
  $('#toasts').appendChild(n);
  let left = kind === 'err' ? 8000 : 4000, started = Date.now(), timer = null;
  const go = () => { started = Date.now(); timer = setTimeout(() => n.remove(), left); };
  const pause = () => { clearTimeout(timer); left = Math.max(1500, left - (Date.now() - started)); };
  n.addEventListener('mouseenter', pause); n.addEventListener('mouseleave', go);
  go();
}
function markInvalid(input, on) {
  if (!input) return;
  if (on) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
}
function fmtDate(ts) { if (!ts) return '—'; const d = new Date(ts); return d.toLocaleDateString(I18N.locale()) + ' ' + d.toLocaleTimeString(I18N.locale(), { hour: '2-digit', minute: '2-digit' }); }
function basename(p) { return String(p || '').split(/[\\/]/).pop(); }
async function guard(fn) {
  try { return await fn(); } catch (e) { console.error(e); toast(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'err'); return undefined; }
}

let INFO = null;
let PROJECTS = [];

// =============================================================== HOME VIEW
// Progress is drawn as a row of SMD pads: each pad is a slice of the board,
// gold (ENIG) when that slice is done. 
function padRow(count, total, segments) {
  const n = segments || 24;
  const filled = total ? Math.round((count / total) * n) : 0;
  const row = el('span', { class: 'pads' + (total && count >= total ? ' full' : ''), role: 'img', 'aria-label': `${count}/${total}` });
  for (let i = 0; i < n; i++) row.appendChild(el('i', { class: i < filled ? 'on' : '' }));
  return row;
}
function pctText(c, total) {
  const pct = total ? Math.round((c * 100) / total) : 0;
  return I18N.getLang() === 'en' ? pct + '%' : '%' + pct;
}
function progressBars(progress, names, compact) {
  const total = (progress && progress.total) || 0;
  return names.map((n) => {
    const c = (progress && progress[n]) || 0;
    return el('div', { class: 'prog' + (compact ? ' compact' : '') },
      el('span', { class: 'prog-name', text: n, raw: 1 }),
      padRow(c, total, compact ? 16 : 24),
      el('span', { class: 'prog-num', text: `${c}/${total}` }));
  });
}

async function renderHome() {
  INFO = INFO || (await asm.info());
  $('#btn-datadir').title = t('Veriler: {dir}', { dir: INFO.dataDir });
  PROJECTS = await asm.listProjects();
  const state = await asm.state();
  const q = ($('#proj-filter').value || '').toLocaleLowerCase(I18N.locale());
  const list = $('#projects');
  list.innerHTML = '';
  $('#empty').hidden = PROJECTS.length > 0;
  $('#list-head').hidden = PROJECTS.length === 0;

  // traveller: the board that was open last time
  const rs = $('#resume');
  rs.hidden = true;
  rs.innerHTML = '';
  if (state.last) {
    const p = PROJECTS.find((x) => x.id === state.last.projectId);
    if (p) {
      const b = (p.boards || []).find((x) => x.serial === state.last.serial);
      const names = b && b.progress ? Object.keys(b.progress).filter((k) => k !== 'total') : [];
      rs.append(
        el('div', { class: 'trav-main' },
          el('p', { class: 'trav-kicker', text: 'Kaldığınız yerden devam' }),
          el('p', { class: 'trav-sn', text: state.last.serial, raw: 1 }),
          el('dl', { class: 'trav-meta' },
            el('dt', { text: 'Proje' }), el('dd', {}, el('span', { text: p.name, raw: 1 }), ' ', el('span', { class: 'rev', text: 'Rev ' + (p.revision || '-'), raw: 1 })),
            el('dt', { text: 'Teknisyen' }), el('dd', { text: state.last.operator, raw: 1 }),
            el('dt', { text: 'Son işlem' }), el('dd', { text: fmtDate(b && b.updated), raw: 1 }))),
        el('div', { class: 'trav-side' },
          b ? el('div', { class: 'trav-progress' }, progressBars(b.progress, names, false)) : null,
          el('button', { class: 'btn primary big-btn', text: 'Devam et', onclick: () => guard(() => asm.startSession(state.last)) })));
      rs.hidden = false;
    }
  }

  for (const p of PROJECTS) {
    if (q && !(`${p.name} ${p.revision} ${p.company}`.toLocaleLowerCase(I18N.locale()).includes(q))) continue;
    const c = p.counts || {};
    const boards = (p.boards || []).slice(0, 3);
    const row = el('article', { class: 'proj' },
      el('div', { class: 'proj-id' },
        el('h3', { class: 'proj-name' }, el('span', { text: p.name, raw: 1 }), el('span', { class: 'rev', text: 'Rev ' + (p.revision || '-'), raw: 1 }), p.has3d ? el('span', { class: 'badge3d', title: '3D model (STEP) var', 'aria-label': '3D model (STEP) var', text: '3D', raw: 1 }) : null),
        p.company ? el('p', { class: 'proj-co', text: p.company, raw: 1 }) : null,
        el('p', { class: 'proj-when', text: t('Son işlem: {time}', { time: fmtDate(p.updated) }) })),
      el('dl', { class: 'proj-stats' },
        el('div', {}, el('dd', { text: String(c.footprints || 0) }), el('dt', { text: 'bileşen' })),
        el('div', {}, el('dd', { text: String(c.bomRows || 0) }), el('dt', { text: 'BOM satırı' })),
        el('div', {}, el('dd', { text: (c.top || 0) + ' / ' + (c.bottom || 0) }), el('dt', { text: 'üst / alt' })),
        el('div', {}, el('dd', { text: String(p.boardCount) }), el('dt', { text: 'kart' }))),
      el('div', { class: 'proj-boards' }, boards.length ? boards.map((b) => {
        const names = Object.keys(b.progress || {}).filter((k) => k !== 'total');
        const last = names[names.length - 1];
        const total = (b.progress && b.progress.total) || 0;
        const v = last ? b.progress[last] : 0;
        return el('div', { class: 'board-line', title: `${b.operator || ''}  ${fmtDate(b.updated)}` },
          el('span', { class: 'board-sn', text: b.serial, raw: 1 }),
          padRow(v, total, 16),
          el('span', { class: 'board-pct', text: b.complete ? 'tamam' : pctText(v, total) }));
      }) : el('p', { class: 'proj-noboards', text: 'Henüz kart yok' })),
      el('div', { class: 'proj-actions' },
        el('button', { class: 'btn primary', text: 'Montaja başla / devam', onclick: () => openBoardModal(p.id) }),
        el('div', { class: 'proj-more' },
          el('button', { class: 'btn ghost small', text: 'Verileri güncelle', title: 'Yeni revizyon / düzeltilmiş dosyalarla yeniden içe aktar (kart ilerlemesi korunur)', onclick: () => openWizard(p.id) }),
          el('button', { class: 'btn ghost small', text: 'HTML dışa aktar', title: 'Tek dosyalık, tarayıcıda açılan montaj sayfası', onclick: () => guard(async () => { const f = await asm.exportHtml(p.id); if (f) toast(t('Kaydedildi: {file}', { file: f }), 'ok'); }) }),
          el('details', { class: 'more' }, el('summary', { title: 'Diğer işlemler', 'aria-label': 'Diğer işlemler' }, '⋯'),
            el('button', { class: 'btn ghost small danger', text: 'Sil', onclick: () => confirmDelete(p) })))));
    list.appendChild(row);
  }
}

function confirmDelete(p) {
  modal(t('"{name}" silinsin mi?', { name: p.name }), el('p', { html: INFO && INFO.platform === 'web'
    ? t('Proje ve <b>{n}</b> kartın kaydı bu tarayıcıdan kalıcı olarak silinir. Gerekirse önce <b>Veriler → Yedek indir</b> ile yedek alın.', { n: p.boardCount })
    : t('Proje ve <b>{n}</b> kartın kaydı veri klasöründeki <code>projects/_silinen</code> altına taşınır; gerekirse oradan geri alınabilir.', { n: p.boardCount }) }), [
    { label: 'Vazgeç' },
    { label: 'Sil', danger: true, onclick: async () => { await guard(() => asm.deleteProject(p.id)); renderHome(); } },
  ]);
}

// ----------------------------------------------------------------- modal
let modalOpener = null;
function setBackgroundInert(on) {
  for (const n of document.body.children) if (n.id !== 'modal-root' && n.id !== 'toasts') { n.inert = on; if (on) n.setAttribute('aria-hidden', 'true'); else n.removeAttribute('aria-hidden'); }
}
function closeModal() {
  const root = $('#modal-root');
  if (!root.firstChild) return;
  root.innerHTML = '';
  setBackgroundInert(false);
  const o = modalOpener; modalOpener = null;
  if (o && document.contains(o)) setTimeout(() => o.focus(), 0);
}
function modal(title, body, buttons) {
  const root = $('#modal-root');
  if (!root.firstChild) modalOpener = document.activeElement;
  root.innerHTML = '';
  const hid = 'modal-title-' + Date.now();
  const foot = el('div', { class: 'modal-foot' }, (buttons || []).map((b) => el('button', {
    class: 'btn ' + (b.primary ? 'primary' : '') + (b.danger ? ' danger' : ''), text: b.label,
    onclick: async () => { if (b.onclick) { const r = await b.onclick(); if (r === false) return; } closeModal(); },
  })));
  root.append(el('div', { class: 'mbackdrop', onclick: closeModal }),
    el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': hid },
      el('div', { class: 'modal-head' }, el('h3', { text: title, id: hid, raw: 1 }), el('button', { class: 'x', text: '×', title: 'Kapat (Esc)', 'aria-label': t('Kapat'), onclick: closeModal })),
      el('div', { class: 'modal-body' }, body), foot));
  setBackgroundInert(true);
  const box = root.querySelector('.modal');
  box.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const f = [...box.querySelectorAll('button, [href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])')].filter((x) => !x.disabled && x.offsetParent !== null);
    if (!f.length) return;
    const a = f[0], z = f[f.length - 1];
    if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); }
    else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
  });
  const first = root.querySelector('input') || root.querySelector('.modal-foot .primary') || root.querySelector('.modal-foot button');
  if (first) setTimeout(() => first.focus(), 30);
}
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const d = document.querySelector('details.more[open]');
  if (d && !$('#modal-root').firstChild) { d.open = false; d.querySelector('summary').focus(); return; }
  closeModal();
});

function nextSerial(boards) {
  if (!boards.length) return '';
  const last = boards[0].serial;
  const m = String(last).match(/^(.*?)(\d+)$/);
  if (!m) return '';
  const n = String(parseInt(m[2], 10) + 1).padStart(m[2].length, '0');
  const cand = m[1] + n;
  return boards.some((b) => b.serial === cand) ? '' : cand;
}

async function openBoardModal(projectId) {
  const p = await asm.getProject(projectId);
  const state = await asm.state();
  const ops = state.operators || [];
  const names = p.checkboxNames || [];
  const sn = el('input', { class: 'input big', 'aria-label': 'Seri No', 'aria-required': 'true', placeholder: 'Seri no girin veya barkod okutun', value: nextSerial(p.boards) });
  const op = el('input', { class: 'input big', 'aria-label': 'Teknisyen', 'aria-required': 'true', placeholder: 'Ad Soyad / sicil no', list: 'ops', value: ops[0] || '' });
  const start = () => guard(async () => {
    markInvalid(sn, !sn.value.trim()); markInvalid(op, !op.value.trim());
    if (!sn.value.trim()) { sn.focus(); toast('Seri numarası girin', 'err'); return false; }
    if (!op.value.trim()) { op.focus(); toast('Teknisyen adı girin', 'err'); return false; }
    await asm.startSession({ projectId, serial: sn.value.trim(), operator: op.value.trim() });
    return true;
  });
  [sn, op].forEach((i) => i.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); start(); } }));
  const tbl = el('table', { class: 'tbl boards-tbl' },
    el('thead', {}, el('tr', {}, el('th', { text: 'Seri No' }), el('th', { text: 'İlerleme' }), el('th', { text: 'Son teknisyen' }), el('th', { text: 'Son işlem' }))),
    el('tbody', {}, p.boards.map((b) => el('tr', { onclick: () => { sn.value = b.serial; sn.focus(); }, ondblclick: () => { sn.value = b.serial; start(); } },
      el('td', { class: 'mono', text: b.serial }),
      el('td', {}, b.complete ? el('span', { class: 'done-badge', text: '✓ Tamamlandı' }) : el('div', { class: 'bars' }, progressBars(b.progress, names, true))),
      el('td', { text: b.operator || '' }), el('td', { text: fmtDate(b.updated) })))));
  modal(`${p.name} — Rev ${p.revision || '-'}`, [
    el('div', { class: 'grid3', style: 'grid-template-columns: 1fr 1fr' },
      el('label', {}, 'Kart seri numarası', sn),
      el('label', {}, 'Teknisyen', op, el('datalist', { id: 'ops' }, ops.map((o) => el('option', { value: o }))))),
    p.boards.length ? el('div', {}, el('div', { class: 'muted', style: 'margin-bottom:6px', text: 'Mevcut kartlar (seçmek için tıklayın, açmak için çift tıklayın):' }), tbl)
      : el('div', { class: 'muted', text: 'Bu projede henüz kart yok. İlk seri numarasını girerek başlayın.' }),
  ], [{ label: 'Vazgeç' }, { label: 'Başlat', primary: true, onclick: start }]);
}

// ============================================================= WIZARD VIEW
let W = null;

function newWizardState() {
  return { projectId: null, ipcFile: null, stepFile: null, bom: null, preview: null };
}

function show(view) {
  $('#view-home').hidden = view !== 'home';
  $('#view-wizard').hidden = view !== 'wizard';
  $('#view-about').hidden = view !== 'about';
  if (view === 'about') {
    $$('#view-about [data-lang]').forEach((a) => (a.hidden = a.dataset.lang !== I18N.getLang()));
    $('#about-ver').textContent = 'v' + ((INFO && INFO.version) || '');
  }
  window.scrollTo(0, 0);
}

async function openWizard(projectId) {
  W = newWizardState();
  $('#m-title').value = ''; $('#m-rev').value = ''; $('#m-company').value = '';
  $('#c-boxes').value = t('Dizildi');
  $('#wiz-title').textContent = t(projectId ? 'Proje verilerini güncelle' : 'Yeni proje');
  $('#btn-save').textContent = t(projectId ? 'Güncelle' : 'Projeyi kaydet');
  if (projectId) {
    const p = await asm.getProject(projectId);
    W.projectId = projectId;
    const s = p.sourceAbs;
    $('#m-title').value = p.name; $('#m-rev').value = p.revision || ''; $('#m-company').value = p.company || '';
    W.ipcFile = s.ipcFile || null;
    W.stepFile = s.stepFile || null;
    $('#c-boxes').value = (p.options && p.options.checkboxes) || t('Dizildi');
    if (s.bom && s.bom.path) await loadTable('bom', s.bom.path, s.bom.sheet, s.bom.mapping);
    updateMarkOptions((p.options && p.options.markWhenChecked) || null);
  } else updateMarkOptions(null);
  $('#i-path').textContent = W.ipcFile || '—';
  $('#s-path').textContent = W.stepFile || '—';
  renderMapping('bom');
  $('#report').hidden = true; $('#previews').hidden = true; $('#prev-status').textContent = '';
  $('#btn-save').disabled = true;
  show('wizard');
}

function updateMarkOptions(sel) {
  const names = $('#c-boxes').value.split(',').map((s) => s.trim()).filter(Boolean);
  const cur = sel != null ? sel : $('#c-mark').value || names[names.length - 1];
  $('#c-mark').innerHTML = '';
  $('#c-mark').append(el('option', { value: '', text: '— (boyama yok)' }), ...names.map((n) => el('option', { value: n, text: n })));
  $('#c-mark').value = names.includes(cur) ? cur : (names[names.length - 1] || '');
}

function invalidatePreview() { if (W) { W.preview = null; $('#btn-save').disabled = true; } }

// ------------------------------------------------------------- mapping UI
async function loadTable(kind, file, sheet, mapping) {
  const t = await guard(() => asm.readTable({ file, sheet }));
  if (!t) return;
  const m = JSON.parse(JSON.stringify(mapping || t.bomMapping));
  W[kind] = { path: file, sheet: t.sheet, table: t, mapping: m };
  if (kind === 'bom' && m.headerRow < 0) m.fields = [];
  renderMapping(kind);
  invalidatePreview();
}

function headerOptions(header, cur, allowNone = true) {
  const opts = [];
  if (allowNone) opts.push(el('option', { value: -1, text: '—' }));
  header.forEach((h, i) => opts.push(el('option', { value: i, text: `${i + 1}: ${h || t('(boş)')}`, selected: i === cur })));
  return opts;
}

function renderMapping(kind) {
  const box = $('#b-map');
  const pathEl = $('#b-path');
  const sheetSel = $('#b-sheet');
  const st = W && W[kind];
  box.innerHTML = '';
  if (!st) { box.hidden = true; pathEl.textContent = t('— (IPC-2581 içindeki BOM kullanılacak)'); sheetSel.hidden = true; return; }
  pathEl.textContent = st.path; pathEl.title = st.path;
  sheetSel.hidden = !st.table.sheets || st.table.sheets.length < 2;
  if (!sheetSel.hidden) {
    sheetSel.innerHTML = '';
    sheetSel.append(...st.table.sheets.map((s) => el('option', { value: s, text: s, selected: s === st.sheet })));
    sheetSel.onchange = () => loadTable(kind, st.path, sheetSel.value);
  }
  box.hidden = false;
  const m = st.mapping;
  const rows = st.table.rows;
  const hrInput = el('input', { class: 'input', type: 'number', min: 1, value: m.headerRow >= 0 ? m.headerRow + 1 : 1, onchange: (e) => {
    const hr = Math.max(0, parseInt(e.target.value, 10) - 1);
    m.headerRow = hr; m.header = (rows[hr] || []).map((c) => String(c).trim());
    if (kind === 'bom') m.fields = m.header.map((h, i) => ({ col: i, name: h, show: true })).filter((f) => f.name && f.col !== m.cols.designator && f.col !== m.cols.qty);
    renderMapping(kind); invalidatePreview();
  } });
  const colSel = (key, label, req) => el('label', {}, t(label) + (req ? ' *' : ''), el('select', { class: 'input', onchange: (e) => {
    m.cols[key] = parseInt(e.target.value, 10);
    if (kind === 'bom') {
      const keep = new Map((m.fields || []).map((f) => [f.col, f.show]));
      m.fields = m.header.map((h, i) => ({ col: i, name: h, show: keep.has(i) ? keep.get(i) : true })).filter((f) => f.name && f.col !== m.cols.designator && f.col !== m.cols.qty);
      renderMapping(kind);
    }
    invalidatePreview();
  } }, headerOptions(m.header || [], m.cols[key] != null ? m.cols[key] : -1)));
  if (m.headerRow < 0) {
    box.append(el('div', { class: 'msg warn', text: 'Başlık satırı otomatik bulunamadı. Başlık satırının numarasını girin.' }));
    m.headerRow = 0; m.header = (rows[0] || []).map(String); m.cols = m.cols || {};
    if (kind === 'bom') m.fields = [];
  }
  {
    box.append(el('div', { class: 'mapgrid' },
      el('label', {}, 'Başlık satırı', hrInput),
      colSel('designator', 'Designator sütunu', true), colSel('qty', 'Adet sütunu (kontrol için)')));
    box.append(el('div', { class: 'muted', text: 'BOM tablosunda gösterilecek sütunlar:' }),
      el('div', { class: 'fields' }, (m.fields || []).map((f) => el('label', {},
        el('input', { type: 'checkbox', checked: f.show, onchange: (e) => { f.show = e.target.checked; invalidatePreview(); } }), f.name))));
    const shown = (m.fields || []).filter((f) => f.show);
    const data = rows.slice(m.headerRow + 1).filter((r) => r && r.length && r.some((c) => c !== '')).slice(0, 6);
    box.append(el('div', { class: 'prevtbl-wrap' }, el('table', { class: 'tbl' },
      el('thead', {}, el('tr', {}, el('th', { text: 'Designator' }), shown.map((f) => el('th', { text: f.name })))),
      el('tbody', {}, data.map((r) => el('tr', {}, el('td', { class: 'mono', text: m.cols.designator >= 0 ? r[m.cols.designator] : '' }), shown.map((f) => el('td', { text: r[f.col] }))))))));
  }
}

// ------------------------------------------------------------- spec/preview
function buildSpec() {
  return {
    ipcFile: W.ipcFile,
    stepFile: W.stepFile || null,
    meta: { title: $('#m-title').value.trim(), revision: $('#m-rev').value.trim(), company: $('#m-company').value.trim() },
    bom: W.bom ? { path: W.bom.path, sheet: W.bom.sheet, mapping: W.bom.mapping } : null,
  };
}

function validate(spec) {
  if (!spec.ipcFile) return 'IPC-2581 dosyasını seçin.';
  if (!spec.meta.title) return 'Proje adını girin.';
  if (spec.bom && !(spec.bom.mapping.cols.designator >= 0)) return 'BOM için Designator sütununu seçin.';
  return null;
}

async function runPreview() {
  const spec = buildSpec();
  const err = validate(spec);
  markInvalid($('#m-title'), !spec.meta.title);
  if (err) {
    toast(err, 'err');
    if (!spec.meta.title) $('#m-title').focus();
    return;
  }
  $('#prev-status').textContent = t(spec.stepFile ? 'İşleniyor… 3D model hazırlanıyor, büyük STEP dosyalarında bu bir dakika sürebilir.' : 'İşleniyor…');
  $('#btn-preview').disabled = true;
  let r = null;
  try { r = await asm.preview(spec); } catch (e) {
    const msg = String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    $('#btn-preview').disabled = false;
    $('#prev-status').textContent = '';
    $('#previews').hidden = true;
    const box = $('#report'); box.hidden = false; box.innerHTML = '';
    box.append(el('div', { class: 'msgs' }, el('div', { class: 'msg err', role: 'alert', text: t('İçe aktarma başarısız: {msg}', { msg }), raw: 1 })));
    box.focus();
    return;
  }
  $('#btn-preview').disabled = false;
  W.preview = { spec, result: r };
  $('#prev-status').textContent = '';
  renderReport(r.report);
  $('#previews').hidden = false;
  drawPreview($('#cv-F'), r.pcbdata, 'F');
  drawPreview($('#cv-B'), r.pcbdata, 'B');
  $('#btn-save').disabled = false;
}

function renderReport(rep) {
  const box = $('#report');
  box.hidden = false;
  box.innerHTML = '';
  const c = rep.counts || {};
  const kpi = (v, l) => el('div', { class: 'kpi' }, el('div', { class: 'v', text: v }), el('div', { class: 'l', text: l }));
  const msgs = [];
  msgs.push(el('div', { class: 'msg', text: t('Çizilen: Top/Bottom Silkscreen, pad, yol, {vias} via, {holes} delik. Bakır katmanlar: {layers}.', { vias: c.vias || 0, holes: c.holes || 0, layers: ['Top'].concat(c.innerLayers || [], ['Bottom']).join(', ') }) }));
  msgs.push(el('div', { class: 'msg', text: rep.bomSource === 'external' ? 'BOM: seçilen dosyadan.' : rep.bomSource === 'ipc' ? 'BOM: IPC-2581 dosyasının içinden.' : 'BOM: yok.' }));
  for (const i of rep.info || []) msgs.push(el('div', { class: 'msg', text: i }));
  for (const w of rep.warnings || []) msgs.push(el('div', { class: 'msg warn', text: w }));
  if (rep.missingInLayout && rep.missingInLayout.length) msgs.push(el('div', { class: 'msg warn', text: t("BOM'da olup IPC-2581 dosyasında bulunmayan {n} referans: {list}", { n: rep.missingInLayout.length, list: rep.missingInLayout.slice(0, 30).join(', ') + (rep.missingInLayout.length > 30 ? '…' : '') }) }));
  if (rep.noPads && rep.noPads.length) msgs.push(el('div', { class: 'msg warn', text: t("Pad'i bulunamayan {n} bileşen (yalnızca çerçeve gösterilir): {list}", { n: rep.noPads.length, list: rep.noPads.slice(0, 30).join(', ') + (rep.noPads.length > 30 ? '…' : '') }) }));
  if (rep.dnp && rep.dnp.length) msgs.push(el('div', { class: 'msg', text: t("BOM'da olmayan (DNP sayılan) {n} bileşen: {list}", { n: rep.dnp.length, list: rep.dnp.slice(0, 30).join(', ') + (rep.dnp.length > 30 ? '…' : '') }) }));
  const st = rep.step;
  if (st && st.counts) {
    const sc = st.counts;
    msgs.push(el('div', { class: 'msg', text: t('3D model: {bodies} gövde, {comp} bileşen eşlendi ({byName} isimle, {byPlace} konumla), {tri} üçgen.', { bodies: sc.bodies, comp: sc.components, byName: sc.byName, byPlace: sc.byPlace, tri: sc.triangles.toLocaleString(I18N.locale()) }) }));
    for (const w of st.warnings || []) msgs.push(el('div', { class: 'msg warn', text: w, raw: 1 }));
  }
  if (!msgs.length) msgs.push(el('div', { class: 'msg', text: 'Sorun bulunmadı.' }));
  box.append(
    el('div', { class: 'kpis' },
      kpi(c.footprints, 'bileşen'), kpi(`${c.withPads}`, "pad'i eşleşen"), kpi(c.bomRows, 'BOM satırı'), kpi(c.dnp, 'DNP'),
      kpi(c.top, 'üst yüz'), kpi(c.bottom, 'alt yüz'), kpi(c.nets, 'net'), kpi(c.vias, 'via'),
      st && st.counts ? kpi(st.counts.components, '3D eşlenen') : null),
    el('div', { class: 'msgs' }, msgs));
}

// Small canvas preview: edges, copper, pads and component boxes
function drawPreview(cv, pcb, layer) {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  cv.width = w * dpr; cv.height = h * dpr;
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const bb = pcb.edges_bbox;
  const bw = bb.maxx - bb.minx, bh = bb.maxy - bb.miny;
  const s = Math.min((w - 20) / bw, (h - 20) / bh);
  ctx.save();
  ctx.translate(w / 2, h / 2);
  if (layer === 'B') ctx.scale(-1, 1);
  ctx.scale(s, s);
  ctx.translate(-(bb.minx + bb.maxx) / 2, -(bb.miny + bb.maxy) / 2);
  const C = { edge: '#e7eee8', cu: 'rgba(120,190,140,0.30)', pad: '#c9a132', box: 'rgba(244,247,244,0.45)', board: '#1d4a36' };
  if (pcb.board_fill) { ctx.fillStyle = C.board; ctx.fill(new Path2D(pcb.board_fill), 'evenodd'); }
  // copper
  ctx.strokeStyle = C.cu; ctx.fillStyle = C.cu; ctx.lineCap = 'round';
  for (const t of pcb.tracks[layer] || []) {
    ctx.lineWidth = t.width; ctx.beginPath();
    if (t.radius) ctx.arc(t.center[0], t.center[1], t.radius, t.startangle * Math.PI / 180, t.endangle * Math.PI / 180);
    else { ctx.moveTo(t.start[0], t.start[1]); ctx.lineTo(t.end[0] + 1e-4, t.end[1]); }
    ctx.stroke();
  }
  for (const z of pcb.zones[layer] || []) {
    ctx.beginPath();
    for (const p of z.polygons || []) { ctx.moveTo(p[0][0], p[0][1]); for (const q of p) ctx.lineTo(q[0], q[1]); ctx.closePath(); }
    ctx.fill();
  }
  // edges
  ctx.strokeStyle = C.edge; ctx.lineWidth = Math.max(0.15, 1.2 / s);
  for (const e of pcb.edges) {
    ctx.beginPath();
    if (e.svgpath) ctx.stroke(new Path2D(e.svgpath));
    else if (e.type === 'segment') { ctx.moveTo(...e.start); ctx.lineTo(...e.end); ctx.stroke(); }
    else if (e.type === 'arc') { ctx.arc(e.start[0], e.start[1], e.radius, e.startangle * Math.PI / 180, e.endangle * Math.PI / 180); ctx.stroke(); }
    else if (e.type === 'circle') { ctx.arc(e.start[0], e.start[1], e.radius, 0, 2 * Math.PI); ctx.stroke(); }
  }
  // pads + boxes
  for (const fp of pcb.footprints) {
    for (const p of fp.pads) {
      if (!p.layers.includes(layer)) continue;
      ctx.save(); ctx.translate(p.pos[0], p.pos[1]); ctx.rotate(-(p.angle || 0) * Math.PI / 180);
      ctx.fillStyle = C.pad;
      if (p.shape === 'custom' && p.polygons) { ctx.beginPath(); for (const pg of p.polygons) { ctx.moveTo(pg[0][0], pg[0][1]); for (const q of pg) ctx.lineTo(q[0], q[1]); ctx.closePath(); } ctx.fill(); }
      else if (p.shape === 'circle') { ctx.beginPath(); ctx.arc(0, 0, p.size[0] / 2, 0, 2 * Math.PI); ctx.fill(); }
      else ctx.fillRect(-p.size[0] / 2, -p.size[1] / 2, p.size[0], p.size[1]);
      ctx.restore();
    }
    if (fp.layer !== layer) continue;
    const b = fp.bbox;
    ctx.save(); ctx.translate(b.pos[0], b.pos[1]); ctx.rotate(-b.angle * Math.PI / 180);
    ctx.strokeStyle = C.box; ctx.lineWidth = Math.max(0.05, 0.8 / s);
    ctx.strokeRect(b.relpos[0], b.relpos[1], b.size[0], b.size[1]);
    ctx.restore();
  }
  ctx.restore();
}

async function saveProject() {
  if (!W.preview) { await runPreview(); if (!W.preview) return; }
  const spec = W.preview.spec;
  const options = { checkboxes: $('#c-boxes').value.split(',').map((s) => s.trim()).filter(Boolean).join(','), markWhenChecked: $('#c-mark').value };
  $('#btn-save').disabled = true;
  const r = await guard(() => (W.projectId ? asm.reimportProject({ id: W.projectId, spec, options }) : asm.createProject({ spec, options })));
  $('#btn-save').disabled = false;
  if (!r) return;
  toast(t(W.projectId ? 'Proje güncellendi.' : 'Proje oluşturuldu.'), 'ok');
  show('home');
  await renderHome();
  openBoardModal(r.id);
}

// browser build (GitHub Pages): data lives in this browser's storage
async function webDataModal() {
  INFO = await asm.info();
  const mb = (n) => (n / 1048576).toFixed(n < 1048576 ? 2 : 1) + ' MB';
  modal('Veriler', [
    el('p', {}, 'Projeler, kart ilerlemeleri ve montaj kayıtları yalnızca bu tarayıcıda (IndexedDB) saklanır; hiçbir sunucuya gönderilmez.'),
    el('p', { class: 'path', style: 'white-space:normal', raw: 1, text: t('Kullanılan alan: {n}', { n: mb(INFO.usage || 0) }) + (INFO.storage && INFO.storage.durable ? ' · ' + t('kalıcı depolama') : '') }),
    el('p', { class: 'muted', text: 'Tarayıcı verilerini temizlemek projeleri siler. Düzenli olarak yedek alın; yedek dosyası başka bir bilgisayarda ya da tarayıcıda geri yüklenebilir.' }),
  ], [
    { label: 'Yedek indir', onclick: async () => { const f = await asm.backupExport(); if (f) toast(t('Kaydedildi: {file}', { file: f }), 'ok'); } },
    { label: 'Yedeği geri yükle…', onclick: async () => {
      try { const n = await asm.backupImport(); if (n != null) { toast(t('Yedek geri yüklendi ({n} dosya)', { n }), 'ok'); renderHome(); } } catch (e) { toast(e.message || String(e), 'warn'); }
    } },
    { label: 'Kapat', primary: true },
  ]);
}

// ------------------------------------------------------------------ wiring
function wire() {
  $('#btn-new').onclick = () => openWizard(null);
  $('#btn-theme').setAttribute('aria-pressed', document.documentElement.classList.contains('dark') ? 'true' : 'false');
  $('#btn-theme').onclick = async () => { const d = !document.documentElement.classList.contains('dark'); document.documentElement.classList.toggle('dark', d); $('#btn-theme').setAttribute('aria-pressed', d ? 'true' : 'false'); await asm.setDark(d); if (W && W.preview) { drawPreview($('#cv-F'), W.preview.result.pcbdata, 'F'); drawPreview($('#cv-B'), W.preview.result.pcbdata, 'B'); } };
  $('#btn-about').onclick = async () => { INFO = INFO || (await asm.info()); show('about'); };
  $('#about-back').onclick = () => { show('home'); renderHome(); };
  $('#btn-new-2').onclick = () => openWizard(null);
  $('#wiz-back').onclick = () => { show('home'); renderHome(); };
  $('#proj-filter').oninput = () => renderHome();
  $('#btn-datadir').onclick = () => {
    if (INFO && INFO.platform === 'web') { webDataModal(); return; }
    modal('Veri klasörü', [
      el('p', {}, 'Projeler, kart ilerlemeleri ve montaj kayıtları bu klasörde düz JSON dosyaları olarak tutulur:'),
      el('p', { class: 'path', style: 'white-space:normal', text: INFO.dataDir }),
      el('p', { class: 'muted', text: 'Klasörü değiştirirseniz uygulama yeni klasördeki projeleri gösterir (mevcut veriler taşınmaz). Ağ klasörü kullanılabilir; aynı projede iki istasyonun aynı anda aynı karta işlem yapmaması gerekir.' }),
    ], [
      { label: 'Klasörü aç', onclick: () => { asm.openDataDir(); } },
      { label: 'Değiştir…', onclick: async () => { const d = await asm.chooseDataDir(); if (d) { INFO = await asm.info(); toast(t('Veri klasörü: {dir}', { dir: d }), 'ok'); renderHome(); } } },
      { label: 'Kapat', primary: true },
    ]);
  };
  $('#i-file').onclick = async () => {
    const f = await asm.open({ title: 'IPC-2581 dosyası', filters: [{ name: 'IPC-2581', extensions: ['xml', 'cvg', 'ipc', 'XML'] }, { name: 'Tümü', extensions: ['*'] }] });
    if (f[0]) { W.ipcFile = f[0]; $('#i-path').textContent = f[0]; if (!$('#m-title').value) $('#m-title').value = basename(f[0]).replace(/\.[^.]+$/, ''); invalidatePreview(); }
  };
  const tableFilters = [{ name: 'BOM', extensions: ['csv', 'txt', 'xls', 'xlsx', 'tsv'] }, { name: 'Tümü', extensions: ['*'] }];
  $('#b-file').onclick = async () => { const f = await asm.open({ title: 'BOM dosyası', filters: tableFilters }); if (f[0]) loadTable('bom', f[0]); };
  $('#b-clear').onclick = () => { W.bom = null; renderMapping('bom'); invalidatePreview(); };
  $('#s-file').onclick = async () => {
    const f = await asm.open({ title: 'STEP dosyası', filters: [{ name: 'STEP', extensions: ['step', 'stp', 'STEP', 'STP'] }, { name: 'Tümü', extensions: ['*'] }] });
    if (f[0]) { W.stepFile = f[0]; $('#s-path').textContent = f[0]; invalidatePreview(); }
  };
  $('#s-clear').onclick = () => { W.stepFile = null; $('#s-path').textContent = '—'; invalidatePreview(); };
  ['#m-title', '#m-rev', '#m-company'].forEach((s) => $(s).addEventListener('change', invalidatePreview));
  $('#c-boxes').addEventListener('input', () => updateMarkOptions(null));
  $('#btn-preview').onclick = runPreview;
  $('#btn-save').onclick = saveProject;
  window.addEventListener('resize', () => {
    if (W && W.preview && !$('#previews').hidden) { drawPreview($('#cv-F'), W.preview.result.pcbdata, 'F'); drawPreview($('#cv-B'), W.preview.result.pcbdata, 'B'); }
  });
}

(async () => {
  const st = await asm.state();
  I18N.setLang(st.lang || 'tr');
  document.documentElement.classList.toggle('dark', !!st.dark);
  document.documentElement.lang = I18N.getLang();
  I18N.translateDom(document.body);
  document.title = t('Montaj Görüntüleyici');
  $('#lang').value = I18N.getLang();
  $('#lang').onchange = () => asm.setLang($('#lang').value);
  wire();
  if (/view=kicad/.test(location.search)) busy(t('KiCad verisi bekleniyor…'));
  asm.onKicad(onKicad);
  renderHome();
  INFO = INFO || (await asm.info());
  if (INFO.platform === 'web') $('#btn-datadir').textContent = t('Veriler');
  renderKicadBar();
  if (/view=about/.test(location.search)) show('about');
})();

// ============================================================ KiCad plugin
function busy(text) {
  $('#busy').hidden = !text;
  if (text) $('#busy-text').textContent = text;
  document.querySelectorAll('body > header, body > main, #kicad-bar').forEach((n) => { n.inert = !!text; });
}
function renderKicadBar() {
  const bar = $('#kicad-bar');
  const k = INFO && INFO.kicad;
  bar.hidden = !k;
  if (!k) return;
  bar.innerHTML = '';
  bar.append(
    el('span', { class: 'kc-tag', text: 'KiCad', raw: 1 }),
    el('span', { class: 'kc-title', text: k.title, raw: 1 }),
    el('span', { class: 'kc-path', title: INFO.dataDir, raw: 1, text: t('Kayıtlar: {dir}', { dir: INFO.dataDir }) }),
    el('button', { class: 'btn small ghost', text: 'Klasörü aç', onclick: () => asm.openDataDir() }),
    k.projectId ? el('button', { class: 'btn small primary', text: 'Karta başla', onclick: () => openBoardModal(k.projectId) }) : null);
}
async function onKicad(kind, d) {
  if (kind === 'status') {
    show('home');
    busy(t('KiCad verisi içe aktarılıyor: {title}', { title: d.title }) + (d.step ? ' — ' + t('3D model hazırlanıyor, büyük kartlarda bir dakika sürebilir.') : ''));
    return;
  }
  busy(null);
  if (kind === 'error') {
    modal('KiCad içe aktarma hatası', [el('p', { text: d.message, raw: 1 })], [{ label: 'Kapat', primary: true }]);
    return;
  }
  INFO = await asm.info();
  renderKicadBar();
  await renderHome();
  toast(d.created ? 'KiCad projesi oluşturuldu.' : d.changed ? 'KiCad verisi güncellendi; kart ilerlemeleri korundu.' : 'KiCad verisi değişmemiş.', 'ok');
  const warns = (d.warnings || []).concat((d.report && d.report.step && d.report.step.warnings) || []);
  if (d.created || d.changed) warns.slice(0, 3).forEach((w) => toast(w, 'warn'));
  openBoardModal(d.id);
}
