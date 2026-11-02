'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, utilityProcess } = require('electron');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const fs = require('fs');
const url = require('url');
const { Store, readJson, writeJson } = require('./store');
const { runImport } = require('../core/importer');
const tab = require('../core/tabular');
const { exportHtml, defaultConfig } = require('../core/htmlExport');
const I18N = require('../i18n/i18n');
const { t } = I18N;

const appTitle = () => t('Montaj Görüntüleyici');
const EVENT_LABELS = {
  'check': 'İşaretlendi', 'uncheck': 'İşaret kaldırıldı', 'session-open': 'Oturum açıldı', 'session-close': 'Oturum kapandı',
  'operator-change': 'Teknisyen değişti', 'board-create': 'Kart oluşturuldu', 'board-complete': 'Kart tamamlandı',
  'project-create': 'Proje oluşturuldu', 'project-reimport': 'Veri yeniden içe aktarıldı', 'test': 'Test',
};
let win = null;
let store = null;
let session = null; // { projectId, serial, operator }

// ------------------------------------------------------------------ data dir
function configFile() { return path.join(app.getPath('userData'), 'config.json'); }
function defaultDataDir() {
  if (process.env.PORTABLE_EXECUTABLE_DIR) return path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'MontajData');
  if (process.env.MONTAJ_DATA_DIR) return process.env.MONTAJ_DATA_DIR;
  return path.join(app.getPath('userData'), 'MontajData');
}
function dataDir() {
  const c = readJson(configFile(), {});
  return c.dataDir || defaultDataDir();
}

// ------------------------------------------------------------------- window
function createWindow() {
  win = new BrowserWindow({
    width: 1500,
    height: 920,
    minWidth: 1000,
    minHeight: 640,
    title: appTitle(),
    backgroundColor: '#f4f5f7',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.removeMenu && process.platform !== 'darwin' && win.setMenuBarVisibility(false);
  win.webContents.session.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !/^(file|devtools|data|blob|chrome-extension):/.test(d.url) }));
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.on('page-title-updated', (e) => e.preventDefault());
  win.on('close', () => { if (session) endSession(t('uygulama kapandı')); });
  loadHome();
}

function loadHome(view) {
  win.setTitle(appTitle());
  win.loadFile(path.join(__dirname, '..', 'renderer', 'home', 'home.html'), view ? { query: { view } } : undefined);
}
function loadViewer() {
  const p = store.getProject(session.projectId);
  win.setTitle(`${appTitle()} — ${p ? p.name : ''} — SN ${session.serial}`);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'viewer', 'viewer.html'));
}

function endSession(reason) {
  if (!session) return;
  try { store.appendLog(session.projectId, { type: 'session-close', serial: session.serial, operator: session.operator, note: reason }); } catch (e) { /* ignore */ }
  session = null;
}

function buildMenu() {
  const tpl = [
    { label: t('Dosya'), submenu: [
      { label: t('Projeler'), accelerator: 'CmdOrCtrl+H', click: () => { endSession(t('projelere dönüldü')); loadHome(); } },
      { label: t('Veri klasörünü aç'), click: () => shell.openPath(store.dir) },
      { label: t('Hakkında'), click: () => { endSession(t('projelere dönüldü')); loadHome('about'); } },
      { type: 'separator' },
      { role: 'quit', label: t('Çıkış') },
    ] },
    { label: t('Dil') + ' / Language', submenu: [
      { label: 'Türkçe', type: 'radio', checked: I18N.getLang() === 'tr', click: () => setLang('tr') },
      { label: 'English', type: 'radio', checked: I18N.getLang() === 'en', click: () => setLang('en') },
    ] },
    { label: t('Görünüm'), submenu: [
      { role: 'reload', label: t('Yenile') },
      { role: 'toggleDevTools', label: t('Geliştirici araçları') },
      { type: 'separator' },
      { role: 'resetZoom', label: t('Yakınlaştırmayı sıfırla') },
      { role: 'zoomIn', label: t('Yakınlaştır') },
      { role: 'zoomOut', label: t('Uzaklaştır') },
      { role: 'togglefullscreen', label: t('Tam ekran') },
    ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
}

// ------------------------------------------------------------------ helpers
// ------------------------------------------------------------ test report → PDF
// The renderer sends the report body; it is printed from a hidden window (A4 landscape)
// so the result looks the same everywhere and needs no external PDF library.
const REPORT_CSS = `
@page { size: A4 landscape; margin: 11mm 10mm 13mm; }
* { box-sizing: border-box; }
body { font-family: 'DejaVu Sans', sans-serif; font-size: 8.4pt; color: #111; margin: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #1f3a5f; padding-bottom: 5px; margin-bottom: 7px; }
h1 { font-size: 15pt; margin: 0; color: #1f3a5f; }
.sub { font-size: 10pt; color: #333; margin-top: 2px; }
h2 { font-size: 10pt; margin: 10px 0 4px; color: #1f3a5f; }
.verdict { font-size: 13pt; font-weight: 700; padding: 5px 16px; border-radius: 4px; color: #fff; }
.verdict.pass { background: #157a3a; } .verdict.fail { background: #b3141f; } .verdict.open { background: #8a5a00; }
table { border-collapse: collapse; width: 100%; }
th, td { border: 0.6pt solid #9aa5b3; padding: 2.5px 4px; text-align: left; vertical-align: top; }
thead th, .meta th { background: #e7edf4; font-weight: 700; }
thead { display: table-header-group; } tr { page-break-inside: avoid; }
.meta th { width: 9%; white-space: nowrap; } .meta td { width: 16%; }
b.pass { color: #157a3a; } b.fail { color: #b3141f; }
.steps td.num { white-space: nowrap; font-variant-numeric: tabular-nums; }
.steps tr.ph td { background: #1f3a5f; color: #fff; font-weight: 700; }
.steps tr.rpass td.st { color: #157a3a; font-weight: 700; }
.steps tr.rfail td { background: #fde6e8; } .steps tr.rfail td.st { color: #b3141f; font-weight: 700; }
.steps tr.rskip td.st { color: #6b5200; } .steps tr.ropen td.st { color: #666; }
.sum tr.rfail td { background: #fde6e8; }
.sign { display: flex; gap: 24px; margin-top: 22px; page-break-inside: avoid; }
.sign div { flex: 1; font-weight: 700; }
.sign span { display: block; border-bottom: 0.8pt solid #333; height: 26px; }
`;
let reportQueue = Promise.resolve();
function renderReportPdf(rep, outFile) {
  const job = reportQueue.then(async () => {
    const fontsCss = url.pathToFileURL(path.join(__dirname, '..', 'renderer', 'fonts', 'fonts.css')).href;
    const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const html = `<!doctype html><html lang="${I18N.getLang()}"><head><meta charset="utf-8"><title>${esc(rep.title)}</title>` +
      `<link rel="stylesheet" href="${fontsCss}"><style>${REPORT_CSS}</style></head><body>${rep.html}</body></html>`;
    const tmp = path.join(app.getPath('temp'), `montaj-report-${process.pid}-${Date.now()}.html`);
    fs.writeFileSync(tmp, html, 'utf8');
    const w = new BrowserWindow({ show: false, width: 1123, height: 794, webPreferences: { sandbox: true, javascript: true } });
    try {
      await w.loadFile(tmp);
      try { await w.webContents.executeJavaScript('document.fonts.ready.then(() => 1)', true); } catch (e) { /* fonts load with the page */ }
      const foot = `<div style="font-family:sans-serif;font-size:7px;color:#555;width:100%;padding:0 10mm;display:flex;justify-content:space-between">` +
        `<span>${esc(rep.footer)} · v${esc(app.getVersion())}</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`;
      const pdf = await w.webContents.printToPDF({ landscape: true, pageSize: 'A4', printBackground: true, displayHeaderFooter: true,
        headerTemplate: '<span></span>', footerTemplate: foot, margins: { marginType: 'custom', top: 0.43, bottom: 0.5, left: 0.39, right: 0.39 } });
      fs.mkdirSync(path.dirname(outFile), { recursive: true });
      fs.writeFileSync(outFile + '.tmp', pdf);
      fs.renameSync(outFile + '.tmp', outFile);
      return outFile;
    } finally {
      if (!w.isDestroyed()) w.destroy();
      try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
    }
  });
  reportQueue = job.catch(() => {});
  return job;
}

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

function importSpecFromUi(spec) {
  // spec from UI already has absolute paths
  const s = JSON.parse(JSON.stringify(spec));
  s.meta = s.meta || {};
  return s;
}


// ------------------------------------------------------------- STEP / 3D
// Triangulation runs in a utility process; results are cached by file content
// + board geometry so the preview's work is reused when the project is saved.
const step3dCache = new Map();
function pcbMini(pcb) {
  return { edges_bbox: pcb.edges_bbox, footprints: pcb.footprints.map((f) => ({ ref: f.ref, layer: f.layer, center: f.center, bbox: f.bbox })) };
}
function runStepProcess(stepFile, pcb, outFile) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = utilityProcess.fork(path.join(__dirname, 'step-proc.js'), [], { serviceName: 'STEP' }); } catch (err) { reject(err); return; }
    let done = false;
    child.on('message', (m) => { done = true; if (m && m.ok) resolve(m.summary); else reject(new Error((m && m.error) || 'STEP')); });
    child.on('exit', (code) => { if (!done) reject(new Error(t('STEP işlemi beklenmedik şekilde sonlandı (kod {code}). Dosya çok büyük olabilir.', { code }))); });
    child.postMessage({ stepFile, pcb, outFile, lang: I18N.getLang() });
  });
}
async function analyzeStep(stepFile, pcb) {
  const h = crypto.createHash('sha1');
  h.update(fs.readFileSync(stepFile));
  h.update(JSON.stringify(pcbMini(pcb)));
  const key = h.digest('hex');
  const hit = step3dCache.get(key);
  if (hit && fs.existsSync(hit.file)) return hit;
  const dir = path.join(os.tmpdir(), 'montaj-3d');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, key + '.bin');
  const summary = await runStepProcess(stepFile, pcbMini(pcb), file);
  const v = { file, summary };
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

async function createProject(spec, options, opts = {}) {
  const meta = spec.meta || {};
  const id = store.newProjectId(meta.title || 'proje');
  fs.mkdirSync(store.projectDir(id), { recursive: true });
  const stored = opts.link ? store.linkSources(id, spec) : store.copySources(id, spec);
  const r = runImport(store.absoluteSpec(id, stored));
  fs.mkdirSync(store.projectDir(id), { recursive: true });
  await attachStep(id, store.absoluteSpec(id, stored).stepFile, r.pcbdata, r.report);
  const now = new Date().toISOString();
  const project = {
    id, name: meta.title || id, revision: meta.revision || '', company: meta.company || '',
    created: now, updated: now, source: stored, options: options || {}, report: r.report,
    fieldNames: r.fieldNames, placeable: placeableCount(r.pcbdata), appVersion: app.getVersion(),
  };
  if (opts.kicad) project.kicad = opts.kicad;
  store.saveProject(id, project, r.pcbdata);
  store.appendLog(id, { type: 'project-create', note: `${project.name} Rev ${project.revision}`, operator: (store.getState().operators || [])[0] || '' });
  return { id, report: r.report };
}

async function reimportProject(id, spec, options, opts = {}) {
  const old = store.getProject(id);
  if (!old) throw new Error(t('Proje bulunamadı'));
  const base = store.projectDir(id);
  // If new files were chosen outside the project folder, archive old sources first
  const external = [spec.ipcFile, spec.bom && spec.bom.path, spec.stepFile]
    .filter(Boolean).some((p) => !path.resolve(p).startsWith(path.resolve(base)));
  let stored;
  if (opts.link) {
    stored = store.linkSources(id, spec);
  } else if (external) {
    const src = path.join(base, 'sources');
    // copy files that live in the current sources before archiving
    const tmp = path.join(base, 'sources_' + Date.now());
    if (fs.existsSync(src)) fs.renameSync(src, tmp);
    const remap = (p) => (p && path.resolve(p).startsWith(path.resolve(src)) ? path.join(tmp, path.relative(src, p)) : p);
    const s2 = JSON.parse(JSON.stringify(spec));
    if (s2.ipcFile) s2.ipcFile = remap(s2.ipcFile);
    if (s2.bom && s2.bom.path) s2.bom.path = remap(s2.bom.path);
    if (s2.stepFile) s2.stepFile = remap(s2.stepFile);
    stored = store.copySources(id, s2);
  } else {
    const rel = (p) => (p ? path.relative(base, p) : p);
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
  if (opts.kicad) project.kicad = opts.kicad;
  store.saveProject(id, project, r.pcbdata);
  // Board progress is keyed by designator, so it survives re-import. Recompute counts.
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
  return { id, report: r.report };
}

// ------------------------------------------------------------ KiCad plugin
// The KiCad plugin exports IPC-2581 / BOM / STEP into <project>/docs/montaj/kicad-export
// and starts the app with --kicad-job <file>. Data and the assembly log then live in
// <project>/docs/montaj, next to the design.
let kicad = null; // { job, file, projectId }
function jobArg(argv) {
  const a = (argv || []).filter((x) => typeof x === 'string');
  const eq = a.find((x) => x.startsWith('--kicad-job='));
  if (eq) return eq.substring('--kicad-job='.length);
  const i = a.indexOf('--kicad-job');
  if (i < 0) return null;
  // Chromium may move switches in front of positional arguments: take the value
  // right after the switch, else the first existing job file on the command line
  if (a[i + 1] && !a[i + 1].startsWith('--')) return a[i + 1];
  return a.find((x) => /\.json$/i.test(x) && fs.existsSync(x)) || null;
}
function readJobFile(file) {
  const job = readJson(file, null);
  if (!job || job.kind !== 'montaj-kicad-job') throw new Error(t('Geçersiz KiCad iş dosyası: {file}', { file }));
  return job;
}
function sendUi(ch, data) { if (win && !win.isDestroyed()) win.webContents.send(ch, data); }
function loadHomeAndWait(view) {
  return new Promise((resolve) => { win.webContents.once('did-finish-load', () => resolve()); loadHome(view); });
}
function hashInputs(job) {
  const h = crypto.createHash('sha1');
  for (const f of [job.ipcFile, job.bomFile, job.stepFile]) {
    h.update(String(f ? path.basename(f) : '-'));
    if (f && fs.existsSync(f)) h.update(fs.readFileSync(f));
  }
  h.update(JSON.stringify([job.title, job.revision, job.company]));
  return h.digest('hex');
}
function kicadSpec(job) {
  let bom = null;
  if (job.bomFile && fs.existsSync(job.bomFile)) {
    const tb = tab.readTableFile(job.bomFile);
    bom = { path: job.bomFile, sheet: null, mapping: tab.suggestBomMapping(tb.rows) };
    if (!(bom.mapping.cols && bom.mapping.cols.designator >= 0)) bom = null;
  }
  return {
    ipcFile: job.ipcFile, stepFile: job.stepFile && fs.existsSync(job.stepFile) ? job.stepFile : null, bom,
    meta: { title: job.title || job.projectName, revision: job.revision || '', company: job.company || '' },
  };
}
async function runKicadJob(file) {
  const job = readJobFile(file);
  if (!job.ipcFile || !fs.existsSync(job.ipcFile)) throw new Error(t('IPC-2581 dosyası bulunamadı: {file}', { file: job.ipcFile }));
  if (session) endSession(t('KiCad verisi güncellendi'));
  fs.mkdirSync(job.dataDir, { recursive: true });
  if (!store || path.resolve(store.dir) !== path.resolve(job.dataDir)) store = new Store(job.dataDir);
  const st = store.getState();
  I18N.setLang(st.lang || job.lang || I18N.getLang());
  if (!st.lang) store.setState({ lang: I18N.getLang() });
  buildMenu();
  kicad = { job, file, projectId: null };
  await loadHomeAndWait('kicad');
  sendUi('kicad:status', { title: job.title || job.projectName, step: !!job.stepFile });
  const meta = { pcb: job.pcb, projectDir: job.projectDir, hash: hashInputs(job), exported: job.created, plugin: job.plugin, fields: job.fields };
  const spec = kicadSpec(job);
  const existing = store.listProjects().map((p) => store.getProject(p.id))
    .find((p) => p && p.kicad && path.resolve(p.kicad.pcb) === path.resolve(job.pcb));
  let id, report, changed = true;
  if (existing) {
    id = existing.id;
    if (existing.kicad.hash === meta.hash && fs.existsSync(path.join(store.projectDir(id), 'pcbdata.json'))) {
      changed = false;
      report = existing.report;
      store.saveProject(id, Object.assign({}, existing, { kicad: Object.assign({}, existing.kicad, { exported: job.created }) }), store.getPcbData(id));
    } else {
      report = (await reimportProject(id, spec, existing.options, { link: true, kicad: meta })).report;
    }
  } else {
    const dz = t('Dizildi');
    const r = await createProject(spec, { checkboxes: dz, markWhenChecked: dz }, { link: true, kicad: meta });
    id = r.id; report = r.report;
  }
  kicad.projectId = id;
  win.setTitle(`${appTitle()} — KiCad: ${job.title || job.projectName}`);
  sendUi('kicad:done', { id, changed, created: !existing, report, warnings: (job.warnings || []).concat(job.notes || []) });
  return id;
}
function startKicadJob(file) {
  runKicadJob(file).catch(async (err) => {
    console.error(err);
    if (session) endSession(t('KiCad verisi güncellendi'));
    try { await loadHomeAndWait('kicad'); } catch (e) { /* window gone */ }
    sendUi('kicad:error', { message: String(err && err.message || err) });
  });
}

function placeableCount(pcbdata) {
  return pcbdata.footprints.length - pcbdata.bom.skipped.length;
}

function setLang(l) {
  I18N.setLang(l);
  store.setState({ lang: I18N.getLang() });
  buildMenu();
  if (win) { win.setTitle(appTitle()); win.webContents.reload(); }
}

// --------------------------------------------------------------------- IPC
function registerIpc() {
  ipcMain.handle('app:info', () => ({ version: app.getVersion(), dataDir: store.dir, platform: process.platform, kicad: kicad ? { title: kicad.job.title || kicad.job.projectName, projectDir: kicad.job.projectDir, pcb: kicad.job.pcb, projectId: kicad.projectId } : null }));
  ipcMain.handle('app:state', () => Object.assign({ lang: I18N.getLang() }, store.getState()));
  ipcMain.handle('app:setLang', (e, l) => { setLang(l); return I18N.getLang(); });
  ipcMain.handle('app:setDark', (e, v) => { store.setState({ dark: !!v }); return !!v; });
  ipcMain.handle('app:openDataDir', () => shell.openPath(store.dir));
  ipcMain.handle('app:chooseDataDir', async () => {
    const r = await dialog.showOpenDialog(win, { title: t('Veri klasörü seç'), properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    const c = readJson(configFile(), {});
    c.dataDir = r.filePaths[0];
    writeJson(configFile(), c);
    store = new Store(c.dataDir);
    return store.dir;
  });

  ipcMain.handle('dlg:open', async (e, opts) => {
    const props = [];
    if (opts.dir) props.push('openDirectory'); else props.push('openFile');
    if (opts.multi) props.push('multiSelections');
    const r = await dialog.showOpenDialog(win, { title: opts.title, properties: props, filters: opts.filters, defaultPath: opts.defaultPath });
    return r.canceled ? [] : r.filePaths;
  });

  ipcMain.handle('import:readTable', (e, { file, sheet }) => {
    const t = tab.readTableFile(file, sheet);
    return {
      rows: t.rows.slice(0, 600),
      totalRows: t.rows.length,
      sheets: t.sheets,
      sheet: t.sheet,
      bomMapping: tab.suggestBomMapping(t.rows),
    };
  });

  ipcMain.handle('import:preview', async (e, spec) => {
    const r = runImport(importSpecFromUi(spec));
    if (spec.stepFile) {
      try { r.report.step = (await analyzeStep(spec.stepFile, r.pcbdata)).summary; } catch (err) {
        r.report.step = { error: String(err.message || err) };
        r.report.warnings = (r.report.warnings || []).concat([t('3D model oluşturulamadı: {err}', { err: err.message || err })]);
      }
    }
    return { report: r.report, fieldNames: r.fieldNames, pcbdata: r.pcbdata };
  });

  ipcMain.handle('project:create', (e, { spec, options }) => createProject(spec, options));

  ipcMain.handle('project:reimport', (e, { id, spec, options }) => reimportProject(id, spec, options));
  // hardware test report: kept next to the project data (KiCad: <project>/docs/montaj)
  const reportFile = () => path.join(store.projectDir(session.projectId), 'test-reports', String(session.serial).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') + '.pdf');
  ipcMain.handle('test:saveReport', (e, rep) => {
    if (!session || !rep || !rep.html) return null;
    const f = reportFile();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    return renderReportPdf(rep, f).catch((err) => { console.error('test report', err); return null; });
  });
  ipcMain.handle('test:exportReport', async (e, rep) => {
    if (!session || !rep || !rep.html) return null;
    const p = store.getProject(session.projectId);
    const r = await dialog.showSaveDialog(win, {
      title: t('Test raporunu kaydet'), filters: [{ name: 'PDF', extensions: ['pdf'] }],
      defaultPath: path.join(path.dirname(reportFile()), `${(p && p.name) || 'kart'}_${session.serial}_test.pdf`.replace(/[<>:"/\\|?*\s]/g, '_')),
    });
    if (r.canceled || !r.filePath) return null;
    return renderReportPdf(rep, r.filePath);
  });
  ipcMain.handle('model3d:get', () => {
    if (!session) return null;
    const f = store.model3dFile(session.projectId);
    return fs.existsSync(f) ? fs.readFileSync(f) : null;
  });
  ipcMain.handle('project:list', () => store.listProjects());
  ipcMain.handle('project:get', (e, id) => {
    const p = store.getProject(id);
    if (!p) return null;
    return Object.assign({}, p, { sourceAbs: store.absoluteSpec(id, p.source), boards: store.listBoards(id), checkboxNames: checkboxNames(id) });
  });
  ipcMain.handle('project:delete', (e, id) => { store.deleteProject(id); return true; });
  ipcMain.handle('project:exportHtml', async (e, id) => {
    const p = store.getProject(id);
    const pcb = store.getPcbData(id);
    const r = await dialog.showSaveDialog(win, { title: t('Bağımsız HTML olarak kaydet'), defaultPath: `${p.name}_${p.revision || ''}_montaj.html`.replace(/\s+/g, '_'), filters: [{ name: 'HTML', extensions: ['html'] }] });
    if (r.canceled || !r.filePath) return null;
    exportHtml(pcb, viewerConfig(p), r.filePath, I18N.getLang());
    return r.filePath;
  });

  ipcMain.handle('board:list', (e, id) => store.listBoards(id));

  ipcMain.handle('session:start', (e, { projectId, serial, operator }) => {
    serial = String(serial || '').trim();
    operator = String(operator || '').trim();
    if (!serial) throw new Error(t('Seri numarası boş olamaz'));
    if (!operator) throw new Error(t('Teknisyen adı boş olamaz'));
    if (session) endSession(t('başka karta geçildi'));
    const { created } = store.ensureBoard(projectId, serial, operator);
    if (created) store.appendLog(projectId, { type: 'board-create', serial, operator });
    store.updateBoard(projectId, serial, (b) => { b.lastOperator = operator; });
    store.appendLog(projectId, { type: 'session-open', serial, operator });
    store.rememberOperator(operator);
    store.setState({ last: { projectId, serial, operator } });
    session = { projectId, serial, operator };
    loadViewer();
    return true;
  });

  ipcMain.handle('app:about', () => { endSession(t('projelere dönüldü')); loadHome('about'); return true; });
  ipcMain.handle('session:home', () => { endSession(t('projelere dönüldü')); loadHome(); return true; });

  ipcMain.handle('session:setOperator', (e, name) => {
    name = String(name || '').trim();
    if (!session || !name) return null;
    const old = session.operator;
    session.operator = name;
    store.rememberOperator(name);
    store.setState({ last: Object.assign({}, session) });
    store.updateBoard(session.projectId, session.serial, (b) => { b.lastOperator = name; });
    store.appendLog(session.projectId, { type: 'operator-change', serial: session.serial, operator: name, note: `${old} → ${name}` });
    return session;
  });

  // synchronous init for the viewer page (must be available before iBOM scripts run)
  ipcMain.on('viewer:init', (e) => {
    if (!session) { e.returnValue = JSON.stringify({ error: t('Oturum yok'), lang: I18N.getLang() }); return; }
    const p = store.getProject(session.projectId);
    const pcb = store.getPcbData(session.projectId);
    const board = store.getBoard(session.projectId, session.serial) || { kv: {} };
    e.returnValue = JSON.stringify({
      lang: I18N.getLang(), dark: !!store.getState().dark, pcbdata: pcb, config: viewerConfig(p),
      settings: Object.assign({}, store.getSettings(session.projectId), store.getSettings(session.projectId).bomCheckboxes != null ? { bomCheckboxes: dropPicked(store.getSettings(session.projectId).bomCheckboxes) } : {}), boardKv: board.kv || {},
      session: Object.assign({}, session, { projectName: p.name, revision: p.revision }),
      operators: store.getState().operators || [],
      boards: store.listBoards(session.projectId).map((b) => b.serial),
      has3d: fs.existsSync(store.model3dFile(session.projectId)),
    });
  });

  ipcMain.on('kv:set', (e, { scope, key, value }) => {
    if (!session) return;
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
  });

  ipcMain.handle('log:add', (e, evt) => {
    if (!session) return null;
    return store.appendLog(session.projectId, Object.assign({}, evt, { serial: session.serial, operator: session.operator }));
  });
  ipcMain.handle('log:list', (e, { projectId, serial, limit }) => {
    const all = store.readLog(projectId || (session && session.projectId), { serial });
    return all.slice(-(limit || 1000)).reverse();
  });
  ipcMain.handle('log:exportCsv', async (e, { projectId, serial }) => {
    const pid = projectId || (session && session.projectId);
    const p = store.getProject(pid);
    const rows = store.readLog(pid, { serial });
    const r = await dialog.showSaveDialog(win, { title: t('Montaj kaydını CSV olarak kaydet'), defaultPath: `${p.name}_${serial || (I18N.getLang() === 'en' ? 'all_boards' : 'tum_kartlar')}_log.csv`.replace(/\s+/g, '_'), filters: [{ name: 'CSV', extensions: ['csv'] }] });
    if (r.canceled || !r.filePath) return null;
    const q = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const head = ['Zaman', 'Proje', 'Rev', 'Seri No', 'Teknisyen', 'Olay', 'Sütun', 'Durum', 'Referanslar', 'Değer', 'Not', 'Bilgisayar'].map((h) => t(h));
    const lines = [head.map(q).join(';')];
    for (const ev of rows) {
      lines.push([new Date(ev.ts).toLocaleString(I18N.locale()), p.name, p.revision, ev.serial, ev.operator, t(EVENT_LABELS[ev.type] || ev.type), ev.checkbox, ev.state ? t(ev.state === 'checked' ? 'İşaretlendi' : 'İşaret kaldırıldı') : '', (ev.refs || []).join(' '), ev.value, ev.note, ev.host].map(q).join(';'));
    }
    fs.writeFileSync(r.filePath, '﻿' + lines.join('\r\n'), 'utf8');
    return r.filePath;
  });
}

// ------------------------------------------------- offline / portable mode
// Portable build: everything (projects, logs, settings, browser cache) is kept
// next to the .exe in MontajData, nothing is written to the user profile.
if (process.env.PORTABLE_EXECUTABLE_DIR) {
  app.setPath('userData', path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'MontajData', '.app'));
}
// No network use at all: no background services, updates or telemetry.
for (const sw of ['disable-background-networking', 'disable-component-update', 'disable-domain-reliability',
  'disable-sync', 'no-pings', 'disable-features=AutofillServerCommunication,MediaRouter,OptimizationHints,SpareRendererForSitePerProcess']) {
  const [k, v] = sw.split('=');
  app.commandLine.appendSwitch(k, v);
}

// ---------------------------------------------------------------- lifecycle
// the job file also travels as additionalData: Chromium may reorder a second instance's argv
if (!app.requestSingleInstanceLock({ kicadJob: jobArg(process.argv) ? path.resolve(jobArg(process.argv)) : null })) {
  app.quit();
} else {
  app.on('second-instance', (e, argv, cwd, extra) => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
    let f = (extra && extra.kicadJob) || jobArg(argv);
    if (f && !path.isAbsolute(f)) f = path.resolve(cwd || '.', f);
    if (f && win) startKicadJob(f);
  });
  app.whenReady().then(() => {
    const jf = jobArg(process.argv);
    let jobDir = null;
    try { if (jf) jobDir = readJobFile(jf).dataDir; } catch (e) { /* reported below */ }
    if (jobDir) fs.mkdirSync(jobDir, { recursive: true });
    store = new Store(jobDir || dataDir());
    I18N.setLang(store.getState().lang || (app.getLocale().startsWith('tr') ? 'tr' : 'en'));
    buildMenu();
    registerIpc();
    createWindow();
    if (jf) startKicadJob(jf);
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
  app.on('window-all-closed', () => { app.quit(); });
}
