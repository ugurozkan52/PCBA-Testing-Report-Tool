// End-to-end test: drives the real Electron app with Playwright.
const { _electron: electron } = require('playwright');
const path = require('path');
const fs = require('fs');
const OUT = process.env.SHOTS || '/home/claude/testdata/shots';
fs.mkdirSync(OUT, { recursive: true });
const DATA = process.env.MONTAJ_DATA_DIR || '/home/claude/testdata/e2e-data';
const T = path.join(__dirname, 'data', 'ipc');

async function launch() {
  const app = await electron.launch({ executablePath: require('electron'), args: ['--no-sandbox', path.join(__dirname, '..')], env: Object.assign({}, process.env, { MONTAJ_DATA_DIR: DATA }) });
  const win = await app.firstWindow();
  win.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  win.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text()); });
  await win.setViewportSize({ width: 1500, height: 900 }).catch(() => {});
  await win.waitForLoadState('domcontentloaded');
  return { app, win };
}

(async () => {
  const step = process.argv[2] || 'all';
  let { app, win } = await launch();
  await win.waitForTimeout(800);
  if (step === 'all' || step === 'create') {
    await win.screenshot({ path: OUT + '/01-home-empty.png' });
    if (process.env.LANG_EN) { await win.evaluate(() => window.asm.setLang('en')); await win.waitForTimeout(1200); await win.screenshot({ path: OUT + '/01b-home-en.png' }); }
    // open wizard and fill via UI
    await win.click('#btn-new');
    await win.fill('#m-title', 'Güç Kartı – ÇĞİÖŞÜ çğıöşü');
    await win.fill('#m-rev', 'B');
    await win.fill('#m-company', 'Test A.Ş.');
    // emulate the file dialogs by calling the same internal functions
    await win.evaluate(async (T) => { W.ipcFile = T + '/testcase3.xml'; document.getElementById('i-path').textContent = W.ipcFile; await loadTable('bom', T + '/BOM_tr.xlsx'); }, T);
    await win.waitForTimeout(500);
    await win.screenshot({ path: OUT + '/02-wizard-files.png', fullPage: true });
    await win.click('#btn-preview');
    await win.waitForSelector('#previews:not([hidden])', { timeout: 20000 });
    await win.waitForTimeout(400);
    await win.evaluate(() => document.querySelector('#sec-preview').scrollIntoView());
    await win.screenshot({ path: OUT + '/03-wizard-preview.png' });
    await win.click('#btn-save');
    await win.waitForSelector('.modal', { timeout: 20000 });
    await win.fill('.modal input.big >> nth=0', 'SN-ÇĞ-0001');
    await win.fill('.modal input.big >> nth=1', 'Şükrü Işık');
    await win.screenshot({ path: OUT + '/04-board-modal.png' });
    await win.click('.modal-foot .btn.primary');
    await win.waitForTimeout(2500);
    await win.screenshot({ path: OUT + '/05-viewer.png' });
    // check: tick "Toplandı" on row 1 and "Dizildi" on rows 1-3, navigate with keyboard
        await win.evaluate(() => { for (const i of [1, 2, 3]) { const r = document.getElementById('bomrow' + i); r.childNodes[1].childNodes[0].click(); } });
    await win.evaluate(() => { footprintIndexToHandler[pcbdata.footprints.findIndex(f => f.ref === 'U1')](); });
    await win.waitForTimeout(500);
    await win.hover('#bomhead th >> nth=0'); await win.waitForTimeout(400); await win.screenshot({ path: OUT + '/06b-columns.png' });
    await win.waitForTimeout(600);
    const hit = await win.evaluate(() => { const tr = pcbdata.tracks.F.find(x => x.net && x.start && (x.start[0] !== x.end[0] || x.start[1] !== x.end[1])); const m = [(tr.start[0] + tr.end[0]) / 2, (tr.start[1] + tr.end[1]) / 2]; const n = netHitScan('F', m[0], m[1]); netClicked(n); return [tr.net, n]; }); console.log('track hit:', JSON.stringify(hit)); await win.waitForTimeout(400);
    await win.screenshot({ path: OUT + '/06-viewer-checked.png' });
    await win.fill('#filter', 'direnç');
    await win.waitForTimeout(300);
    console.log('filter rows:', await win.evaluate(() => document.getElementById('bombody').childElementCount));
    await win.fill('#filter', 'IĞNE');
    await win.waitForTimeout(300);
    console.log('filter IĞNE rows:', await win.evaluate(() => document.getElementById('bombody').childElementCount));
    await win.fill('#filter', '');
    await win.click('#asm-log-btn');
    await win.waitForTimeout(600);
    await win.screenshot({ path: OUT + '/07-log.png' });
    await app.close();
    // restart -> resume
    ({ app, win } = await launch());
    await win.waitForTimeout(1000);
    await win.screenshot({ path: OUT + '/08-home-resume.png' });
    await win.click('#btn-about'); await win.waitForTimeout(400); await win.screenshot({ path: OUT + '/10-about.png' }); await win.click('#about-back'); await win.waitForTimeout(400);
    await win.click('#resume .btn.primary');
    await win.waitForTimeout(2500);
    const st = await win.evaluate(() => ({ placed: getStoredCheckboxRefs(settings.checkboxes[0]).size, cols: settings.checkboxes.join('|'), hl: currentHighlightedRowId, sn: document.getElementById('asm-serial').textContent }));
    console.log('after restart:', JSON.stringify(st));
    await win.screenshot({ path: OUT + '/09-viewer-resumed.png' });
    await win.click('#frontcanvas .asm-max'); await win.waitForTimeout(600); await win.screenshot({ path: OUT + '/11-max-front.png' });
    await win.keyboard.press('Escape'); await win.waitForTimeout(400);
    await win.evaluate(() => { setDarkMode(true); }); await win.waitForTimeout(500); await win.screenshot({ path: OUT + '/13-viewer-dark.png' });
    await win.evaluate(() => asm.goHome()); await win.waitForTimeout(1200); await win.screenshot({ path: OUT + '/14-home-dark.png' });
    await win.evaluate(() => asm.startSession({ projectId: 0 }).catch(() => {})); await win.click('#resume .btn.primary'); await win.waitForTimeout(2000);
    await win.hover('.menubtn'); await win.waitForTimeout(300); await win.click('.asm-swatch[data-key="blue"]'); await win.waitForTimeout(500); await win.screenshot({ path: OUT + '/12-blue.png' });
  }
  await app.close();
})().catch((e) => { console.error(e); process.exit(1); });
