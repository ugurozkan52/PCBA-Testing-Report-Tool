'use strict';
// Browser build: the Electron main-process handlers (src/main/main.js) re-implemented
// on top of the same Store / import code, running on the in-memory file system (vfs.js).
const path = require('path');
const vfs = require('./vfs');
const fs = vfs.fs;
const { Store } = require('../src/main/store');
const { runImport } = require('../src/core/importer');
const tab = require('../src/core/tabular');
const { exportHtml, defaultConfig } = require('../src/core/htmlExport');
const I18N = require('../src/i18n/i18n');
const { t } = I18N;

const VERSION = typeof APP_VERSION !== 'undefined' ? APP_VERSION : 'web';
const DATA = '/data';
const SESSION_KEY = 'montaj.session';
// site root (…/<repo>/), derived from this script's URL: <root>/web/asm-web.js
const ROOT = (document.currentScript && document.currentScript.src || location.href).replace(/web\/[^/]*$/, '');
const HOME = ROOT + 'src/renderer/home/home.html';
const VIEWER = ROOT + 'src/renderer/viewer/viewer.html';

const EVENT_LABELS = {
  'check': 'İşaretlendi', 'uncheck': 'İşaret kaldırıldı', 'session-open': 'Oturum açıldı', 'session-close': 'Oturum kapandı',
  'operator-change': 'Teknisyen değişti', 'board-create': 'Kart oluşturuldu', 'board-complete': 'Kart tamamlandı',
  'project-create': 'Proje oluşturuldu', 'project-reimport': 'Veri yeniden içe aktarıldı', 'test': 'Test',
};

let store = null;
let storage = { persistent: false };
const ready = vfs.load().then((s) => {
  storage = s;
  store = new Store(DATA);
  const st = store.getState();
  I18N.setLang(st.lang || ((navigator.language || '').toLowerCase().startsWith('tr') ? 'tr' : 'en'));
  if (!st.lang) store.setState({ lang: I18N.getLang() });
});

// ---------------------------------------------------------------- session
function getSession() { try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); } catch (e) { return null; } }
function setSession(s) { try { if (s) sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)); else sessionStorage.removeItem(SESSION_KEY); } catch (e) { /* private mode */ } }
function endSession(reason) {
  const s = getSession();
  if (!s) return;
  try { store.appendLog(s.projectId, { type: 'session-close', serial: s.serial, operator: s.operator, note: reason }); } catch (e) { /* ignore */ }
  setSession(null);
}
async function go(url) { await vfs.flush(); location.href = url; }

// ---------------------------------------------------------------- helpers (as in main.js)
const DROPPED_COLUMNS = new Set(['Toplandı', 'Picked']);
function dropPicked(raw) {
  return String(raw || '').split(',').map((x) => x.trim()).filter((x) => x && !DROPPED_COLUMNS.has(x)).join(',') || t('Dizildi');
}
function checkboxNames(projectId) {
  const s = store.getSettings(projectId);
  const p = store.getProject(projectId);
  const raw = dropPicked(s.bomCheckboxes != null ? s.bomCheckboxes : (p && p.options && p.options.checkboxes) || t('Dizildi'));
  return raw.split(',').map((x) => x.trim()).filter(Boolean);
}
function recomputeProgress(projectId, board) {
  const p = store.getProject(projectId);
  const total = (p && p.placeable) || 0;
  const names = checkboxNames(projectId);
  const progress = { total };
  for (const n of names) {
    const v = board.kv['checkbox_' + n];
    progress[n] = v ? v.split(',').filter(Boolean).length : 0;
  }
  board.progress = progress;
  const complete = total > 0 && names.length > 0 && names.every((n) => progress[n] >= total);
  const newlyComplete = complete && !board.complete;
  board.complete = complete;
  return newlyComplete;
}
function viewerConfig(project) {
  const o = project.options || {};
  return defaultConfig({
    fields: project.fieldNames || [],
    checkboxes: dropPicked(o.checkboxes || t('Dizildi')),
    mark_when_checked: (o.markWhenChecked && !DROPPED_COLUMNS.has(o.markWhenChecked)) ? o.markWhenChecked : dropPicked(o.checkboxes || t('Dizildi')).split(',').pop(),
    show_fabrication: true,
    layer_view: o.layerView || 'FB',
  });
}
function placeableCount(pcbdata) { return pcbdata.footprints.length - pcbdata.bom.skipped.length; }
function download(name, data, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: type || 'application/octet-stream' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
  return name;
}
// download names in ASCII: some browsers drop a non-ASCII `download` name and save as "download"
const TR = { ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u', Ç: 'C', Ğ: 'G', İ: 'I', Ö: 'O', Ş: 'S', Ü: 'U' };
const fileSafe = (s) => String(s).replace(/[çğıöşüÇĞİÖŞÜ]/g, (c) => TR[c]).normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^\x20-\x7e]/g, '_').replace(/[<>:"/\\|?*\s]/g, '_');

// ---------------------------------------------------------------- file picker
let uploadSeq = 0;
function pickFiles(opts) {
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    if (opts && opts.multi) inp.multiple = true;
    const exts = [];
    ((opts && opts.filters) || []).forEach((f) => (f.extensions || []).forEach((e) => { if (e !== '*') exts.push('.' + e.toLowerCase()); }));
    const all = ((opts && opts.filters) || []).some((f) => (f.extensions || []).includes('*'));
    if (exts.length && !all) inp.accept = Array.from(new Set(exts)).join(',');
    inp.style.display = 'none';
    let settled = false;
    const finish = async () => {
      if (settled) return;
      settled = true;
      const out = [];
      for (const f of Array.from(inp.files || [])) {
        const p = `/uploads/${Date.now().toString(36)}-${uploadSeq++}/${f.name}`;
        fs.writeFileSync(p, new Uint8Array(await f.arrayBuffer()));
        out.push(p);
      }
      inp.remove();
      resolve(out);
    };
    inp.addEventListener('change', finish);
    inp.addEventListener('cancel', () => { if (!settled) { settled = true; inp.remove(); resolve([]); } });
    document.body.appendChild(inp);
    inp.click();
  });
}

// ---------------------------------------------------------------- STEP (Web Worker)
const step3dCache = new Map();
function pcbMini(pcb) {
  return { edges_bbox: pcb.edges_bbox, footprints: pcb.footprints.map((f) => ({ ref: f.ref, layer: f.layer, center: f.center, bbox: f.bbox })) };
}
function hashStr(s, h) { h = h || 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h; }
function hashBytes(b) { let h = 2166136261; const step = Math.max(1, Math.floor(b.length / 200000)); for (let i = 0; i < b.length; i += step) { h ^= b[i]; h = Math.imul(h, 16777619) >>> 0; } return h; }
function runStepWorker(bytes, pcb) {
  return new Promise((resolve, reject) => {
    let w;
    try { w = new Worker(ROOT + 'web/step-worker.js'); } catch (err) { reject(err); return; }
    w.onmessage = (e) => { w.terminate(); if (e.data && e.data.ok) resolve(e.data); else reject(new Error((e.data && e.data.error) || 'STEP')); };
    w.onerror = (e) => { w.terminate(); reject(new Error(t('STEP işlemi beklenmedik şekilde sonlandı (kod {code}). Dosya çok büyük olabilir.', { code: e.message || '?' }))); };
    w.postMessage({ step: bytes, pcb, lang: I18N.getLang() });
  });
}
async function analyzeStep(stepFile, pcb) {
  const bytes = new Uint8Array(fs.readFileSync(stepFile));
  const mini = pcbMini(pcb);
  const key = bytes.length + '-' + hashBytes(bytes) + '-' + hashStr(JSON.stringify(mini));
  const hit = step3dCache.get(key);
  if (hit) return hit;
  const r = await runStepWorker(bytes.slice(), mini);
  const v = { file: '/tmp/3d/' + key + '.bin', summary: r.summary };
  fs.writeFileSync(v.file, new Uint8Array(r.model));
  step3dCache.set(key, v);
  return v;
}
async function attachStep(id, stepAbs, pcb, report) {
  const target = store.model3dFile(id);
  if (!stepAbs) { try { fs.unlinkSync(target); } catch (e) { /* none */ } return null; }
  try {
    const r = await analyzeStep(stepAbs, pcb);
    fs.copyFileSync(r.file, target);
    report.step = r.summary;
    return r.summary;
  } catch (err) {
    try { fs.unlinkSync(target); } catch (e) { /* none */ }
    report.step = { error: String(err.message || err) };
    report.warnings = (report.warnings || []).concat([t('3D model oluşturulamadı: {err}', { err: err.message || err })]);
    return null;
  }
}

// ---------------------------------------------------------------- projects
async function createProject(spec, options) {
  const meta = spec.meta || {};
  const id = store.newProjectId(meta.title || 'proje');
  fs.mkdirSync(store.projectDir(id), { recursive: true });
  const stored = store.copySources(id, spec);
  const r = runImport(store.absoluteSpec(id, stored));
  await attachStep(id, store.absoluteSpec(id, stored).stepFile, r.pcbdata, r.report);
  const now = new Date().toISOString();
  const project = {
    id, name: meta.title || id, revision: meta.revision || '', company: meta.company || '',
    created: now, updated: now, source: stored, options: options || {}, report: r.report,
    fieldNames: r.fieldNames, placeable: placeableCount(r.pcbdata), appVersion: VERSION,
  };
  store.saveProject(id, project, r.pcbdata);
  store.appendLog(id, { type: 'project-create', note: `${project.name} Rev ${project.revision}`, operator: (store.getState().operators || [])[0] || '' });
  await vfs.flush();
  return { id, report: r.report };
}
async function reimportProject(id, spec, options) {
  const old = store.getProject(id);
  if (!old) throw new Error(t('Proje bulunamadı'));
  const base = store.projectDir(id);
  const external = [spec.ipcFile, spec.bom && spec.bom.path, spec.stepFile].filter(Boolean).some((p) => !vfs.norm(p).startsWith(base + '/'));
  let stored;
  if (external) {
    // keep the files that already live in the project, archive the old sources
    const src = path.join(base, 'sources');
    const tmp = path.join(base, 'sources_' + Date.now());
    if (fs.existsSync(src)) fs.renameSync(src, tmp);
    const remap = (p) => (p && vfs.norm(p).startsWith(src + '/') ? path.join(tmp, vfs.norm(p).slice(src.length + 1)) : p);
    const s2 = JSON.parse(JSON.stringify(spec));
    if (s2.ipcFile) s2.ipcFile = remap(s2.ipcFile);
    if (s2.bom && s2.bom.path) s2.bom.path = remap(s2.bom.path);
    if (s2.stepFile) s2.stepFile = remap(s2.stepFile);
    stored = store.copySources(id, s2);
  } else {
    const rel = (p) => (p ? path.relative(base, vfs.norm(p)) : p);
    stored = JSON.parse(JSON.stringify(spec));
    if (stored.ipcFile) stored.ipcFile = rel(stored.ipcFile);
    if (stored.bom && stored.bom.path) stored.bom.path = rel(stored.bom.path);
    if (stored.stepFile) stored.stepFile = rel(stored.stepFile);
  }
  const r = runImport(store.absoluteSpec(id, stored));
  await attachStep(id, store.absoluteSpec(id, stored).stepFile, r.pcbdata, r.report);
  const meta = spec.meta || {};
  const project = Object.assign({}, old, {
    name: meta.title || old.name, revision: meta.revision || '', company: meta.company || '',
    updated: new Date().toISOString(), source: stored, options: options || old.options, report: r.report,
    fieldNames: r.fieldNames, placeable: placeableCount(r.pcbdata),
  });
  store.saveProject(id, project, r.pcbdata);
  const valid = new Set(r.pcbdata.footprints.map((f) => f.ref));
  for (const b of store.listBoards(id)) {
    store.updateBoard(id, b.serial, (bd) => {
      for (const k of Object.keys(bd.kv)) {
        if (k.startsWith('checkbox_')) bd.kv[k] = bd.kv[k].split(',').filter((x) => valid.has(x)).join(',');
      }
      recomputeProgress(id, bd);
    });
  }
  store.appendLog(id, { type: 'project-reimport', note: `Rev ${project.revision}` });
  await vfs.flush();
  return { id, report: r.report };
}

// standalone HTML export: the app files are fetched once into /app
const EXPORT_FILES = ['src/renderer/viewer/viewer.html', 'src/renderer/viewer/viewer.css', 'src/renderer/viewer/viewer-a11y.js',
  'src/renderer/viewer/ibom/split.js', 'src/renderer/viewer/ibom/pep.js', 'src/renderer/viewer/ibom/util.js', 'src/renderer/viewer/ibom/render.js',
  'src/renderer/viewer/ibom/table-util.js', 'src/renderer/viewer/ibom/ibom.js', 'src/renderer/viewer/ibom/ibom.css', 'src/i18n/i18n.js',
  'src/renderer/fonts/fonts.css', 'src/renderer/fonts/DejaVuSans.ttf', 'src/renderer/fonts/DejaVuSans-Bold.ttf',
  'src/renderer/fonts/DejaVuSansCondensed.ttf', 'src/renderer/fonts/DejaVuSansCondensed-Bold.ttf'];
async function fetchAppFiles() {
  await Promise.all(EXPORT_FILES.map(async (f) => {
    if (fs.existsSync('/app/' + f)) return;
    const r = await fetch(ROOT + f);
    if (!r.ok) throw new Error(f + ': HTTP ' + r.status);
    fs.writeFileSync('/app/' + f, new Uint8Array(await r.arrayBuffer()));
  }));
}

// ---------------------------------------------------------------- report → PDF
let pdfLib = null;
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error(src));
    document.head.appendChild(s);
  });
}
async function reportPdf(rep) {
  if (!pdfLib) {
    pdfLib = (async () => {
      await loadScript(ROOT + 'web/lib/pdfmake.min.js');
      const fonts = {};
      await Promise.all(['DejaVuSans.ttf', 'DejaVuSans-Bold.ttf'].map(async (f) => {
        const b = new Uint8Array(await (await fetch(ROOT + 'src/renderer/fonts/' + f)).arrayBuffer());
        let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
        fonts[f] = btoa(s);
      }));
      window.pdfMake.vfs = fonts;
      window.pdfMake.fonts = { DejaVu: { normal: 'DejaVuSans.ttf', bold: 'DejaVuSans-Bold.ttf', italics: 'DejaVuSans.ttf', bolditalics: 'DejaVuSans-Bold.ttf' } };
      return window.pdfMake;
    })();
  }
  const pdfMake = await pdfLib;
  const doc = require('./report-pdf').docDefinition(rep, VERSION);
  return new Promise((resolve) => pdfMake.createPdf(doc).getBlob(resolve));
}

// ---------------------------------------------------------------- API (window.asm)
const call = (fn) => (...a) => ready.then(() => fn(...a));
const api = {
  ready,
  info: call(() => ({ version: VERSION, dataDir: t('Bu tarayıcı (IndexedDB)'), platform: 'web', storage, usage: vfs.usage(), kicad: null })),
  state: call(() => Object.assign({ lang: I18N.getLang() }, store.getState())),
  setLang: call(async (l) => { I18N.setLang(l); store.setState({ lang: I18N.getLang() }); await vfs.flush(); location.reload(); return I18N.getLang(); }),
  setDark: call((v) => { store.setState({ dark: !!v }); return !!v; }),
  openDataDir: call(() => null),
  chooseDataDir: call(() => null),
  open: (opts) => pickFiles(opts),                                     // must stay synchronous for the user gesture
  readTable: call(({ file, sheet }) => {
    const r = tab.readTableFile(file, sheet);
    return { rows: r.rows.slice(0, 600), totalRows: r.rows.length, sheets: r.sheets, sheet: r.sheet, bomMapping: tab.suggestBomMapping(r.rows) };
  }),
  preview: call(async (spec) => {
    const r = runImport(JSON.parse(JSON.stringify(spec)));
    if (spec.stepFile) {
      try { r.report.step = (await analyzeStep(spec.stepFile, r.pcbdata)).summary; } catch (err) {
        r.report.step = { error: String(err.message || err) };
        r.report.warnings = (r.report.warnings || []).concat([t('3D model oluşturulamadı: {err}', { err: err.message || err })]);
      }
    }
    return { report: r.report, fieldNames: r.fieldNames, pcbdata: r.pcbdata };
  }),
  createProject: call(({ spec, options }) => createProject(spec, options)),
  reimportProject: call(({ id, spec, options }) => reimportProject(id, spec, options)),
  listProjects: call(() => store.listProjects()),
  getProject: call((id) => {
    const p = store.getProject(id);
    if (!p) return null;
    return Object.assign({}, p, { sourceAbs: store.absoluteSpec(id, p.source), boards: store.listBoards(id), checkboxNames: checkboxNames(id) });
  }),
  deleteProject: call(async (id) => {
    // the browser has no recycle bin folder to browse: remove the project for good
    fs.rmSync(store.projectDir(id));
    await vfs.flush();
    return true;
  }),
  exportHtml: call(async (id) => {
    const p = store.getProject(id);
    await fetchAppFiles();
    const out = '/tmp/export.html';
    exportHtml(store.getPcbData(id), viewerConfig(p), out, I18N.getLang());
    return download(fileSafe(`${p.name}_${p.revision || ''}_montaj.html`), fs.readFileSync(out), 'text/html');
  }),
  listBoards: call((id) => store.listBoards(id)),
  startSession: call(async ({ projectId, serial, operator }) => {
    serial = String(serial || '').trim();
    operator = String(operator || '').trim();
    if (!serial) throw new Error(t('Seri numarası boş olamaz'));
    if (!operator) throw new Error(t('Teknisyen adı boş olamaz'));
    if (getSession()) endSession(t('başka karta geçildi'));
    const { created } = store.ensureBoard(projectId, serial, operator);
    if (created) store.appendLog(projectId, { type: 'board-create', serial, operator });
    store.updateBoard(projectId, serial, (b) => { b.lastOperator = operator; });
    store.appendLog(projectId, { type: 'session-open', serial, operator });
    store.rememberOperator(operator);
    store.setState({ last: { projectId, serial, operator } });
    setSession({ projectId, serial, operator });
    await go(VIEWER);
    return true;
  }),
  goHome: call(async () => { endSession(t('projelere dönüldü')); await go(HOME); return true; }),
  showAbout: call(async () => { endSession(t('projelere dönüldü')); await go(HOME + '?view=about'); return true; }),
  setOperator: call((name) => {
    name = String(name || '').trim();
    const session = getSession();
    if (!session || !name) return null;
    const old = session.operator;
    session.operator = name;
    setSession(session);
    store.rememberOperator(name);
    store.setState({ last: Object.assign({}, session) });
    store.updateBoard(session.projectId, session.serial, (b) => { b.lastOperator = name; });
    store.appendLog(session.projectId, { type: 'operator-change', serial: session.serial, operator: name, note: `${old} → ${name}` });
    return session;
  }),
  // viewer (called after `ready`, see viewer-boot.js)
  viewerInit: () => {
    const session = getSession();
    if (!store || !session || !store.getProject(session.projectId)) return JSON.stringify({ error: t('Oturum yok'), lang: I18N.getLang(), home: HOME });
    const p = store.getProject(session.projectId);
    const pcb = store.getPcbData(session.projectId);
    const board = store.getBoard(session.projectId, session.serial) || { kv: {} };
    const s = store.getSettings(session.projectId);
    return JSON.stringify({
      lang: I18N.getLang(), dark: !!store.getState().dark, pcbdata: pcb, config: viewerConfig(p),
      settings: Object.assign({}, s, s.bomCheckboxes != null ? { bomCheckboxes: dropPicked(s.bomCheckboxes) } : {}), boardKv: board.kv || {},
      session: Object.assign({}, session, { projectName: p.name, revision: p.revision }),
      operators: store.getState().operators || [],
      boards: store.listBoards(session.projectId).map((b) => b.serial),
      has3d: fs.existsSync(store.model3dFile(session.projectId)),
    });
  },
  kvSet: (scope, key, value) => {
    const session = getSession();
    if (!store || !session) return;
    if (scope === 'board') {
      store.updateBoard(session.projectId, session.serial, (b) => {
        if (value === null || value === undefined) delete b.kv[key]; else b.kv[key] = String(value);
        const done = recomputeProgress(session.projectId, b);
        if (done) store.appendLog(session.projectId, { type: 'board-complete', serial: session.serial, operator: session.operator });
      });
    } else {
      store.setSetting(session.projectId, key, value);
      if (key === 'bomCheckboxes') store.updateBoard(session.projectId, session.serial, (b) => recomputeProgress(session.projectId, b));
    }
  },
  logAdd: call((evt) => {
    const session = getSession();
    if (!session) return null;
    return store.appendLog(session.projectId, Object.assign({}, evt, { serial: session.serial, operator: session.operator }));
  }),
  logList: call(({ projectId, serial, limit }) => {
    const session = getSession();
    return store.readLog(projectId || (session && session.projectId), { serial }).slice(-(limit || 1000)).reverse();
  }),
  logExportCsv: call(({ projectId, serial }) => {
    const session = getSession();
    const pid = projectId || (session && session.projectId);
    const p = store.getProject(pid);
    const rows = store.readLog(pid, { serial });
    const q = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const head = ['Zaman', 'Proje', 'Rev', 'Seri No', 'Teknisyen', 'Olay', 'Sütun', 'Durum', 'Referanslar', 'Değer', 'Not', 'Bilgisayar'].map((h) => t(h));
    const lines = [head.map(q).join(';')];
    for (const ev of rows) {
      lines.push([new Date(ev.ts).toLocaleString(I18N.locale()), p.name, p.revision, ev.serial, ev.operator, t(EVENT_LABELS[ev.type] || ev.type), ev.checkbox, ev.state ? t(ev.state === 'checked' ? 'İşaretlendi' : 'İşaret kaldırıldı') : '', (ev.refs || []).join(' '), ev.value, ev.note, ev.host].map(q).join(';'));
    }
    return download(fileSafe(`${p.name}_${serial || (I18N.getLang() === 'en' ? 'all_boards' : 'tum_kartlar')}_log.csv`), '﻿' + lines.join('\r\n'), 'text/csv;charset=utf-8');
  }),
  model3d: call(() => {
    const session = getSession();
    if (!session) return null;
    const f = store.model3dFile(session.projectId);
    return fs.existsSync(f) ? new Uint8Array(fs.readFileSync(f)) : null;
  }),
  // the report is kept with the board data (HTML); the PDF is produced on request
  testSaveReport: call((rep) => {
    const session = getSession();
    if (!session || !rep || !rep.html) return null;
    const f = path.join(store.projectDir(session.projectId), 'test-reports', String(session.serial).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') + '.json');
    fs.writeFileSync(f, JSON.stringify(rep));
    return f;
  }),
  testExportReport: call(async (rep) => {
    const session = getSession();
    if (!session || !rep || !rep.html) return null;
    const p = store.getProject(session.projectId);
    const blob = await reportPdf(rep);
    return download(fileSafe(`${(p && p.name) || 'kart'}_${session.serial}_test.pdf`), blob);
  }),
  onKicad: () => {},
  // browser-only: backup / restore of everything in this browser's storage
  backupExport: call(async () => {
    await vfs.flush();
    const d = new Date(), z = (n) => String(n).padStart(2, '0');
    const doc = { app: 'montaj-goruntuleyici', version: VERSION, created: d.toISOString(), files: vfs.exportAll() };
    return download(`montaj-yedek-${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}.json`, JSON.stringify(doc), 'application/json');
  }),
  backupImport: () => pickFiles({ filters: [{ name: 'JSON', extensions: ['json'] }] }).then(async (f) => {
    await ready;
    if (!f[0]) return null;
    let doc;
    try { doc = JSON.parse(fs.readFileSync(f[0], 'utf8')); } catch (e) { throw new Error(t('Yedek dosyası okunamadı')); }
    if (!doc || doc.app !== 'montaj-goruntuleyici' || !doc.files) throw new Error(t('Bu dosya bir Montaj Görüntüleyici yedeği değil'));
    // projects are added / replaced, the app state (technicians, language) is merged
    const st = store.getState();
    const n = vfs.importAll(doc.files, DATA + '/projects/');
    const bst = doc.files[DATA + '/app-state.json'];
    if (bst) {
      try {
        const o = JSON.parse(require('buffer').Buffer.from(bst, 'base64').toString('utf8'));
        store.setState({ operators: Array.from(new Set((st.operators || []).concat(o.operators || []))).slice(0, 30) });
      } catch (e) { /* ignore */ }
    }
    await vfs.flush();
    return n;
  }),
  usage: () => vfs.usage(),
};

module.exports = api;
