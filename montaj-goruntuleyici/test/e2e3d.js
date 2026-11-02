// 3D / STEP end-to-end test (v3.0):  AXE=/path/axe.min.js xvfb-run -a node test/e2e3d.js
const { _electron: electron } = require('playwright');
const fs = require('fs');
const OUT = process.env.SHOTS || '/tmp/claude-0/s';
const DATA = process.env.MONTAJ_DATA_DIR || '/tmp/claude-0/s/data3d';
fs.rmSync(DATA, { recursive: true, force: true });
const IPCF = require('path').join(__dirname, 'data/ipc/testcase3.xml'), STEPF = require('path').join(__dirname, 'data/step/testcase3_partial.step');
let fails = 0;
const V3D_markers = (n) => n > 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
(async () => {
  const app = await electron.launch({ executablePath: process.env.APP_EXE || require('electron'), args: process.env.APP_EXE ? ['--no-sandbox'] : ['--no-sandbox', require('path').join(__dirname, '..')], env: Object.assign({}, process.env, { MONTAJ_DATA_DIR: DATA }) });
  const win = await app.firstWindow();
  win.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fails++; });
  win.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text()); });
  await win.setViewportSize({ width: 1500, height: 900 }).catch(() => {});
  await win.waitForTimeout(1000);
  // wizard via UI fields
  await win.click('#btn-new');
  await win.fill('#m-title', 'Güç Kartı 3D'); await win.fill('#m-rev', 'C');
  await win.evaluate(([a, b]) => { W.ipcFile = a; W.stepFile = b; document.getElementById('s-path').textContent = b; }, [IPCF, STEPF]);
  const t0 = Date.now();
  await win.click('#btn-preview');
  await win.waitForFunction(() => !document.getElementById('btn-save').disabled, null, { timeout: 120000 });
  console.log('preview ms', Date.now() - t0);
  const rep = await win.textContent('#report');
  ok(/3D model: 35/.test(rep) && /shown as boxes/.test(rep), 'wizard report shows 3D match: ' + (rep.match(/3D model:[^.]*\./) || [''])[0]);
  await win.screenshot({ path: OUT + '/3d-01-wizard.png', fullPage: true });
  const t1 = Date.now();
  await win.click('#btn-save');
  await win.waitForSelector('.modal[role=dialog]', { timeout: 60000 });
  console.log('save ms (cached)', Date.now() - t1);
  await win.fill('.modal input >> nth=0', 'SN-3D-001').catch(() => {});
  const inputs = await win.$$('.modal input');
  if (inputs[1]) await inputs[1].fill('Bülent Canlı');
  await win.keyboard.press('Enter');
  await win.waitForTimeout(2500);
  ok(await win.evaluate(() => !document.getElementById('d3-btn').hidden), '3D button visible');
  await win.click('#d3-btn');
  await win.waitForFunction(() => V3D.state.ready, null, { timeout: 30000 });
  await win.waitForTimeout(800);
  ok(await win.evaluate(() => pcbdata.footprints.every((f, i) => pcbdata.bom.skipped.includes(i) || V3D.state.byRef.has(f.ref))), 'every BOM part is in 3D: ' + await win.evaluate(() => V3D.state.parts.length + ' meshes, ' + V3D.state.placeholders.length + ' boxes'));
  await win.screenshot({ path: OUT + '/3d-02-iso.png' });
  if (process.env.AXE) {
    await win.evaluate(fs.readFileSync(process.env.AXE, 'utf8'));
    const v = await win.evaluate(() => axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } }).then((x) => x.violations.map((v) => v.impact + ' ' + v.id + ' ' + v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | '))));
    v.forEach((x) => console.log('   axe', x));
    ok(!v.some((x) => /^(critical|serious)/.test(x)), 'axe: 3D view has no serious issues');
  }
  // select a row → yellow
  await win.evaluate(() => { highlightNextRow(); highlightNextRow(); });
  await win.waitForTimeout(400);
  const sel = await win.evaluate(() => Array.from(V3D.state.hlSet));
  ok(sel.length > 0, '3D selection follows BOM row: ' + sel.join(','));
  const ops = [];
  for (let i = 0; i < 6; i++) { ops.push(await win.evaluate(() => V3D.mat.ring.opacity)); await win.waitForTimeout(170); }
  ok(V3D_markers(await win.evaluate(() => V3D.state.markers.children.length)) && Math.max(...ops) - Math.min(...ops) > 0.4, 'marker blinks: ' + ops.map((o) => o.toFixed(2)).join(' '));
  await win.evaluate(() => { topmostdiv.dataset.blink = 'off'; }); await win.waitForTimeout(300);
  const st = []; for (let i = 0; i < 3; i++) { st.push(await win.evaluate(() => V3D.mat.ring.opacity)); await win.waitForTimeout(200); }
  ok(st.every((o) => o > 0.99), 'marker steady when blinking is off');
  ok(await win.evaluate(() => V3D.mat.ripple.opacity === 0 && V3D.state.markers.children[0].children.length === 3), 'ripple stops when blinking is off; frame + ripple + outline');
  await win.evaluate(() => { topmostdiv.dataset.blink = 'short'; });
  await win.click('#asm3d-focus'); await win.waitForTimeout(700);
  await win.screenshot({ path: OUT + '/3d-03-focus.png' });
  // place + placed tint
  await win.click('#asm-place'); await win.waitForTimeout(400);
  await win.click('#asm3d-iso'); await win.waitForTimeout(700);
  await win.screenshot({ path: OUT + '/3d-04-placed.png' });
  // click on a part in 3D → selects row: project center of a part
  const pick = await win.evaluate(() => {
    const S = V3D.state; const ref = Array.from(S.byRef.keys()).find((r) => !S.hlSet.has(r) && r.startsWith('U'));
    const m = S.byRef.get(ref)[0]; const c = m.geometry.boundingBox.getCenter(new THREE.Vector3()); c.z = m.geometry.boundingBox.max.z;
    c.project(S.camera); const r = document.getElementById('asm3d-canvas').getBoundingClientRect();
    return { ref, x: r.left + (c.x + 1) / 2 * r.width, y: r.top + (1 - c.y) / 2 * r.height };
  });
  await win.mouse.click(pick.x, pick.y); await win.waitForTimeout(400);
  const after = await win.evaluate(() => Array.from(V3D.state.hlSet));
  ok(after.includes(pick.ref), '3D click selects ' + pick.ref + ' → ' + after.join(','));
  // keyboard
  await win.focus('#asm3d');
  const p0 = await win.evaluate(() => V3D.state.camera.position.toArray());
  await win.keyboard.press('ArrowLeft'); await win.keyboard.press('+'); await win.waitForTimeout(300);
  const p1 = await win.evaluate(() => V3D.state.camera.position.toArray());
  ok(p0.join() !== p1.join(), 'keyboard rotates / zooms 3D');
  await win.keyboard.press('u'); await win.waitForTimeout(700);
  await win.screenshot({ path: OUT + '/3d-05-top.png' });
  // mode placed only
  await win.selectOption('#asm3d-mode', 'placed'); await win.waitForTimeout(300);
  await win.keyboard.press('0'); await win.waitForTimeout(700);
  ok(await win.evaluate(() => V3D.state.parts.filter((m) => m.visible).length < 20), 'placed-only mode hides unplaced parts');
  await win.screenshot({ path: OUT + '/3d-06-placedonly.png' });
  await win.selectOption('#asm3d-mode', 'all');
  // max + dark + mask colour
  await win.click('#asm3d .asm-max'); await win.waitForTimeout(400);
  await win.evaluate(() => { setDarkMode(true); asmApplyBoardColor('blue', true); }); await win.waitForTimeout(600);
  await win.screenshot({ path: OUT + '/3d-07-max-dark-blue.png' });
  await win.keyboard.press('Escape'); await win.waitForTimeout(300);
  await win.evaluate(() => { setDarkMode(false); asmApplyBoardColor('green', true); });
  // back to 2D
  await win.click('#fb-btn'); await win.waitForTimeout(400);
  ok(await win.evaluate(() => !V3D.isOn() && document.getElementById('asm3d').hidden && getComputedStyle(document.getElementById('frontcanvas')).display !== 'none'), 'back to 2D');
  // persistence: 3D on after reload
  await win.click('#d3-btn'); await win.waitForTimeout(300);
  await win.reload(); await win.waitForTimeout(3000);
  ok(await win.evaluate(() => V3D.isOn() && V3D.state.ready), '3D view restored after restart');
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
  await app.close();
})().catch((e) => { console.log('ERR', e.message); process.exit(1); });
