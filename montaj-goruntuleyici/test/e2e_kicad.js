// KiCad plugin → app end-to-end test (v5.0)
//   python3 test/kicad/test_plugin.py /tmp/kt && JOB=/tmp/kt/.../kicad-job.json xvfb-run -a node test/e2e_kicad.js
const { _electron: electron } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const JOB = process.env.JOB;
const OUT = process.env.SHOTS || '/tmp';
const job = JSON.parse(fs.readFileSync(JOB, 'utf8'));
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const appDir = path.join(__dirname, '..');
const electronBin = require('electron');
(async () => {
  const app = await electron.launch({ executablePath: process.env.APP_EXE || electronBin, args: process.env.APP_EXE ? ['--no-sandbox', '--kicad-job', JOB] : ['--no-sandbox', appDir, '--kicad-job', JOB], env: Object.assign({}, process.env, { MONTAJ_DATA_DIR: '/tmp/should-not-be-used' }) });
  const win = await app.firstWindow();
  win.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fails++; });
  await win.setViewportSize({ width: 1500, height: 900 }).catch(() => {});
  await win.waitForSelector('.modal[role=dialog]', { timeout: 90000 });
  await win.waitForTimeout(400);
  await win.screenshot({ path: OUT + '/k-01-board-modal.png' });
  const info = await win.evaluate(() => asm.info());
  ok(path.resolve(info.dataDir) === path.resolve(job.dataDir), 'data dir is <project>/docs/montaj: ' + info.dataDir);
  ok(info.kicad && info.kicad.title === job.title, 'KiCad info: ' + JSON.stringify(info.kicad && info.kicad.title));
  ok(await win.evaluate(() => !document.getElementById('kicad-bar').hidden), 'KiCad bar visible');
  const projDirs = fs.readdirSync(path.join(job.dataDir, 'projects')).filter((d) => !d.startsWith('_'));
  ok(projDirs.length === 1, 'one project created');
  const pj = JSON.parse(fs.readFileSync(path.join(job.dataDir, 'projects', projDirs[0], 'project.json'), 'utf8'));
  ok(pj.kicad && path.resolve(pj.kicad.pcb) === path.resolve(job.pcb) && pj.source.linked, 'project linked to KiCad board');
  ok(!fs.existsSync(path.join(job.dataDir, 'projects', projDirs[0], 'sources')), 'export files are not copied');
  ok(fs.existsSync(path.join(job.dataDir, 'projects', projDirs[0], 'model3d.bin')), '3D model built');
  ok(pj.fieldNames.includes('MPN') && pj.fieldNames.includes('Manufacturer') && pj.fieldNames.includes('Description'), 'BOM fields: ' + pj.fieldNames.join(','));
  ok(pj.name === job.title && pj.revision === job.revision, 'title / revision from KiCad title block');
  // start a board
  const inputs = await win.$$('.modal input');
  await inputs[0].fill('SN-K-001'); await inputs[1].fill('Ayşe Yılmaz');
  await win.keyboard.press('Enter');
  await win.waitForFunction(() => typeof pcbdata !== 'undefined' && pcbdata, null, { timeout: 30000 });
  await win.waitForTimeout(1500);
  ok(await win.evaluate(() => !document.getElementById('d3-btn').hidden), '3D available in viewer');
  for (let i = 0; i < 3; i++) await win.click('#asm-place');
  await win.waitForTimeout(400);
  const placed1 = await win.evaluate(() => getStoredCheckboxRefs(settings.checkboxes[0]).size);
  ok(placed1 > 0, 'placed parts: ' + placed1);
  await win.screenshot({ path: OUT + '/k-02-viewer.png' });

  // second click in KiCad, nothing changed → same project, progress kept
  const second = (extra) => new Promise((res) => {
    const p = spawn(electronBin, ['--no-sandbox', appDir, '--kicad-job=' + JOB], { env: Object.assign({}, process.env, extra || {}), stdio: 'ignore' });
    p.on('exit', res);
  });
  await second();
  await win.waitForSelector('.modal[role=dialog]', { timeout: 60000 });
  await win.waitForTimeout(300);
  const toasts1 = await win.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | '));
  ok(/unchanged|değişmemiş/.test(toasts1), 'second click, unchanged: ' + toasts1);
  // board edited in KiCad: BOM changes → re-import keeps progress
  const bom = fs.readFileSync(job.bomFile, 'utf8').replace('Üretici A.Ş.', 'Yeni Üretici Ltd.');
  fs.writeFileSync(job.bomFile, bom);
  await second();
  await win.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => /updated|güncellendi/.test(t.textContent)), null, { timeout: 60000 });
  ok(true, 'changed export re-imported');
  const projDirs2 = fs.readdirSync(path.join(job.dataDir, 'projects')).filter((d) => !d.startsWith('_'));
  ok(projDirs2.length === 1, 'still one project');
  await win.waitForTimeout(300);
  const inputs2 = await win.$$('.modal input');
  await inputs2[0].fill('SN-K-001');
  await win.keyboard.press('Enter');
  await win.waitForFunction(() => typeof pcbdata !== 'undefined' && pcbdata, null, { timeout: 30000 });
  await win.waitForTimeout(1200);
  const placed2 = await win.evaluate(() => getStoredCheckboxRefs(settings.checkboxes[0]).size);
  ok(placed2 === placed1, `progress kept after KiCad update (${placed1} → ${placed2})`);
  ok(await win.evaluate(() => JSON.stringify(pcbdata.bom.fields).includes('Yeni Üretici Ltd.')), 'updated BOM values shown');
  // log in docs
  const log = fs.readFileSync(path.join(job.dataDir, 'projects', projDirs[0], 'log.jsonl'), 'utf8');
  ok(/session-open/.test(log) && /"check"/.test(log) && /project-reimport/.test(log), 'assembly log in docs/montaj');
  ok(!fs.existsSync('/tmp/should-not-be-used'), 'default data dir untouched');
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
  await app.close();
})().catch((e) => { console.log('ERR', e.stack); process.exit(1); });
