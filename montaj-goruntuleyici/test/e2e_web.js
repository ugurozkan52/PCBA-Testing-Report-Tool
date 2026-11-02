// Browser build (GitHub Pages) end-to-end:  node web/build.js && node test/e2e_web.js
// Serves dist-web under /montaj/ (like https://<user>.github.io/<repo>/) and drives Chromium.
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', 'dist-web');
const DATA = path.join(__dirname, 'data');
const OUT = process.env.SHOTS || '/tmp';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.png': 'image/png', '.ttf': 'font/ttf', '.json': 'application/json', '.txt': 'text/plain' };
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };

const server = http.createServer((q, r) => {
  let u = decodeURIComponent(q.url.split('?')[0]);
  if (!u.startsWith('/montaj/')) { r.writeHead(404); r.end(); return; }
  u = u.slice('/montaj'.length);
  if (u.endsWith('/')) u += 'index.html';
  const f = path.join(ROOT, u);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); r.end('404'); return; }
  r.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(r);
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const BASE = `http://127.0.0.1:${server.address().port}/montaj/`;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 }, acceptDownloads: true, locale: 'tr-TR' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => { errors.push(e.message); console.log('PAGEERROR', e.message); });
  page.on('console', (m) => { if (m.type() === 'error') { errors.push(m.text()); console.log('CONSOLE', m.text()); } });
  const pick = async (sel, file) => { const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click(sel)]); await fc.setFiles(file); };

  await page.goto(BASE);
  await page.waitForURL(/home\.html/);
  await page.waitForSelector('#btn-new');
  ok(await page.evaluate(() => window.asm && typeof window.asm.ready.then === 'function'), 'window.asm provided by the web build');
  ok(await page.textContent('#btn-datadir') === 'Veriler', 'data button relabelled for the browser');
  await page.screenshot({ path: OUT + '/w-01-home.png' });

  // ------------------------------------------------ new project from uploaded files
  await page.click('#btn-new');
  await pick('#i-file', path.join(DATA, 'ipc', 'testcase3.xml'));
  await page.waitForFunction(() => /testcase3\.xml/.test(document.getElementById('i-path').textContent));
  await page.fill('#m-title', 'Web Kartı Çğış');
  await page.fill('#m-rev', 'A');
  await pick('#b-file', path.join(DATA, 'ipc', 'BOM_tr.xlsx'));
  await page.waitForTimeout(800);
  await pick('#s-file', path.join(DATA, 'step', 'testcase3_partial.step'));
  await page.click('#btn-preview');
  await page.waitForSelector('#previews:not([hidden])', { timeout: 120000 });
  await page.waitForTimeout(600);
  await page.evaluate(() => document.querySelector('#sec-preview').scrollIntoView());
  await page.screenshot({ path: OUT + '/w-02-preview.png' });
  const prev = await page.evaluate(() => W.preview && W.preview.result.report);
  ok(prev && prev.counts.footprints === 42, 'IPC-2581 parsed in the browser (' + (prev && prev.counts.footprints) + ' footprints)');
  ok(prev && prev.step && !prev.step.error && prev.step.counts, '3D: STEP triangulated in a Web Worker ' + JSON.stringify(prev && prev.step && (prev.step.counts || prev.step.error)));
  await page.click('#btn-save');
  await page.waitForSelector('.modal input.big', { timeout: 120000 });
  await page.fill('.modal input.big >> nth=0', 'SN-W-001');
  await page.fill('.modal input.big >> nth=1', 'Ayşe Öztürk');
  await page.click('.modal-foot .btn.primary');
  await page.waitForURL(/viewer\.html/);
  await page.waitForFunction(() => typeof pcbdata !== 'undefined' && document.getElementById('bombody') && document.getElementById('bombody').childElementCount > 0, null, { timeout: 30000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: OUT + '/w-03-viewer.png' });
  ok(await page.evaluate(() => document.getElementById('asm-serial').textContent) === 'SN-W-001', 'viewer opened with the board session');

  // ------------------------------------------------ placing parts persists across reload
  await page.evaluate(() => { for (const i of [1, 2, 3]) document.getElementById('bomrow' + i).childNodes[1].childNodes[0].click(); });
  await page.waitForTimeout(500);
  const placed = await page.evaluate(() => getStoredCheckboxRefs(settings.checkboxes[0]).size);
  await page.reload();
  await page.waitForFunction(() => typeof pcbdata !== 'undefined' && document.getElementById('bombody').childElementCount > 0, null, { timeout: 30000 });
  const placed2 = await page.evaluate(() => getStoredCheckboxRefs(settings.checkboxes[0]).size);
  ok(placed > 0 && placed2 === placed, `placements kept after reload (${placed} → ${placed2})`);

  // ------------------------------------------------ 3D
  await page.click('#d3-btn');
  await page.waitForFunction(() => V3D.state.ready, null, { timeout: 60000 });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: OUT + '/w-04-3d.png' });
  ok(await page.evaluate(() => V3D.state.ready && !V3D.state.failed), '3D view built from the stored model');
  await page.click('#d3-btn'); await page.waitForTimeout(300);

  // ------------------------------------------------ hardware test + PDF report
  await page.click('#asm-mode-test');
  await page.waitForSelector('.tp-card', { timeout: 10000 });
  await page.fill('#tp-val', '0.2'); await page.click('.tp-pass'); await page.waitForTimeout(300);
  await page.fill('#tp-val', '0.5'); await page.click('.tp-pass'); await page.waitForTimeout(300);
  await page.screenshot({ path: OUT + '/w-05-test.png' });
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('text=Raporu kaydet (PDF)…')]);
  const pdf = path.join(OUT, 'w-report.pdf');
  await dl.saveAs(pdf);
  const head = fs.readFileSync(pdf).slice(0, 5).toString();
  ok(head === '%PDF-' && /_test\.pdf$/.test(dl.suggestedFilename()), 'PDF report downloaded: ' + dl.suggestedFilename());
  let txt = '';
  try { txt = require('child_process').execFileSync('pdftotext', ['-layout', pdf, '-']).toString(); } catch (e) { /* tool missing */ }
  ok(/Donanım test raporu/.test(txt) && /Geçti/.test(txt) && /Test eden/.test(txt) && /Ayşe Öztürk/.test(txt), 'PDF text: title, results, signatures, Turkish characters');
  await page.click('#asm-mode-assembly');

  // ------------------------------------------------ log CSV, backup / restore
  await page.evaluate(() => asm.goHome());
  await page.waitForURL(/home\.html/);
  await page.waitForSelector('#projects .proj, #projects > *', { timeout: 10000 });
  await page.screenshot({ path: OUT + '/w-06-home-projects.png' });
  ok(await page.evaluate(() => asm.listProjects().then((l) => l.length === 1 && l[0].has3d && l[0].boardCount === 1)), 'project listed with 3D model and one board');
  const [hx] = await Promise.all([page.waitForEvent('download'), page.evaluate(() => asm.listProjects().then((l) => asm.exportHtml(l[0].id)))]);
  const hxFile = path.join(OUT, 'w-export.html'); await hx.saveAs(hxFile);
  const hxt = fs.readFileSync(hxFile, 'utf8');
  ok(/var pcbdata = /.test(hxt) && !/asm-web\.js|viewer-boot/.test(hxt) && hxt.length > 500000, 'standalone HTML export works in the browser (' + Math.round(hxt.length / 1024) + ' kB)');
  const [lg] = await Promise.all([page.waitForEvent('download'), page.evaluate(() => asm.listProjects().then((l) => asm.logExportCsv({ projectId: l[0].id })))]);
  const lgFile = path.join(OUT, 'w-log.csv'); await lg.saveAs(lgFile);
  ok(/Ayşe Öztürk/.test(fs.readFileSync(lgFile, 'utf8')), 'assembly log CSV export');
  await page.click('#btn-datadir');
  await page.waitForSelector('.modal');
  await page.screenshot({ path: OUT + '/w-07-data.png' });
  const [bk] = await Promise.all([page.waitForEvent('download'), page.click('.modal-foot >> text=Yedek indir')]);
  const bkFile = path.join(OUT, 'w-backup.json');
  await bk.saveAs(bkFile);
  const doc = JSON.parse(fs.readFileSync(bkFile, 'utf8'));
  ok(doc.app === 'montaj-goruntuleyici' && Object.keys(doc.files).some((k) => /model3d\.bin$/.test(k)), 'backup contains the project files (' + Object.keys(doc.files).length + ')');

  // fresh browser profile: restore the backup
  const ctx2 = await browser.newContext({ viewport: { width: 1500, height: 900 }, locale: 'tr-TR', bypassCSP: !!process.env.AXE });
  const p2 = await ctx2.newPage();
  p2.on('pageerror', (e) => { errors.push(e.message); console.log('PAGEERROR2', e.message); });
  await p2.goto(BASE); await p2.waitForSelector('#btn-new');
  ok(await p2.evaluate(() => asm.listProjects().then((l) => l.length === 0)), 'new browser profile starts empty');
  await p2.click('#btn-datadir'); await p2.waitForSelector('.modal');
  const [fc] = await Promise.all([p2.waitForEvent('filechooser'), p2.click('.modal-foot >> text=Yedeği geri yükle…')]);
  await fc.setFiles(bkFile);
  await p2.waitForFunction(() => document.querySelectorAll('#projects > *').length > 0, null, { timeout: 10000 });
  ok(await p2.evaluate(() => asm.listProjects().then((l) => l.length === 1 && l[0].boardCount === 1)), 'backup restored in another browser profile');

  // English UI
  await p2.selectOption('#lang', 'en'); await p2.waitForTimeout(1500);
  ok(await p2.textContent('#btn-datadir') === 'Data', 'language switch reloads the page in English');

  if (process.env.AXE) {
    await p2.click('#btn-datadir'); await p2.waitForSelector('.modal');
    await p2.addScriptTag({ content: fs.readFileSync(process.env.AXE, 'utf8') });
    const v = await p2.evaluate(() => axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } }).then((x) => x.violations.map((v) => v.impact + ' ' + v.id)));
    v.forEach((x) => console.log('   axe', x));
    ok(!v.some((x) => /^(critical|serious)/.test(x)), 'axe: web home + data dialog');
  }
  ok(!errors.length, 'no page errors (' + errors.length + ')');
  await browser.close();
  server.close();
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
