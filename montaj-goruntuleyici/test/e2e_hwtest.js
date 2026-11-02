// Hardware test mode (v6.0) end-to-end:  MONTAJ_DATA_DIR=<dir with a 3D project> xvfb-run -a node test/e2e_hwtest.js
const { _electron: electron } = require('playwright');
const fs = require('fs');
const path = require('path');
const OUT = process.env.SHOTS || '/tmp';
const DATA = process.env.MONTAJ_DATA_DIR;
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
(async () => {
  const app = await electron.launch({ executablePath: require('electron'), args: ['--no-sandbox', path.join(__dirname, '..')], env: Object.assign({}, process.env, { MONTAJ_DATA_DIR: DATA }) });
  const win = await app.firstWindow();
  win.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fails++; });
  await win.setViewportSize({ width: 1500, height: 900 }).catch(() => {});
  await win.waitForTimeout(1000);
  await win.click('#resume .btn.primary'); await win.waitForTimeout(2500);
  await win.evaluate(() => { if (V3D.isOn()) V3D.setOn(false, true); });
  await win.click('#fb-btn').catch(() => {});
  // KiCad local labels come as "/NET": rename GND that way (the plan normalises names)
  await win.evaluate(() => {
    const ren = (o) => { if (o && o.net === 'GND') o.net = '/GND'; };
    pcbdata.footprints.forEach((f) => f.pads.forEach(ren));
    ['F', 'B'].forEach((L) => { pcbdata.tracks[L].forEach(ren); pcbdata.zones[L].forEach(ren); });
  });
  await win.click('#asm-mode-test'); await win.waitForTimeout(500);
  await win.evaluate(() => TEST.reset()); await win.waitForTimeout(300);
  ok(await win.evaluate(() => !document.getElementById('asm-test').hidden && getComputedStyle(document.getElementById('bomtable')).display === 'none'), 'test panel replaces the BOM list');
  const plan = await win.evaluate(() => TEST.state.steps.map((s) => s.id));
  ok(plan[0] === 'prep' && plan.some((x) => x.startsWith('cont:')) && plan.some((x) => x.startsWith('iso:')), 'procedure: ' + plan.length + ' steps (' + plan.slice(0, 4).join(', ') + ' …)');
  // step 1: probe resistance
  await win.fill('#tp-val', '0.2'); await win.keyboard.press('Enter'); await win.waitForTimeout(400);
  ok(await win.evaluate(() => TEST.state.res.offset === 0.2 && TEST.state.idx === 1), 'probe resistance stored, moved to step 2');
  // probes are drawn on the 2D board
  const px = await win.evaluate(() => {
    const p = TEST.state.probes.pos, cd = p.side === 'F' || p.th ? allcanvas.front : allcanvas.back;
    const ctx = cd.highlight.getContext('2d');
    // sample a ring point (radius ≈ max(pad)*0.75 or 9 px)
    const pad = pcbdata.footprints[p.fp].pads[p.pad];
    // target ring: 7 px (screen) around the contact point; the icon sits on a leader line further out
    const m = ctx.getTransform(); const c = m.transformPoint(new DOMPoint(p.pos[0], p.pos[1])); const r = 7 * devicePixelRatio;
    let red = 0;
    for (let a = 0; a < 6.28; a += 0.2) {
      const d = ctx.getImageData(Math.round(c.x + r * Math.cos(a)), Math.round(c.y + r * Math.sin(a)), 1, 1).data;
      if (d[0] > 180 && d[1] < 80 && d[2] < 90 && d[3] > 200) red++;
    }
    return red;
  });
  ok(px > 5, '2D red probe ring drawn around the + pad (' + px + ' samples)');
  // the whole probed net is highlighted (continuity → amber): sample the net's other pads
  const netPx = await win.evaluate(() => {
    const p = TEST.state.probes;
    let hits = 0, n = 0;
    for (const [L, cd] of [['F', allcanvas.front], ['B', allcanvas.back]]) {
      const ctx = cd.highlight.getContext('2d'); const m = ctx.getTransform();
      pcbdata.footprints.forEach((f, fi) => f.pads.forEach((q, pi) => {
        if (q.net !== p.pos.net || !q.layers.includes(L) || (fi === p.pos.fp && pi === p.pos.pad) || (fi === p.neg.fp && pi === p.neg.pad)) return;
        const s = m.transformPoint(new DOMPoint(q.pos[0], q.pos[1]));
        const d = ctx.getImageData(Math.round(s.x), Math.round(s.y), 1, 1).data;
        n++; if (d[0] > 200 && d[1] > 150 && d[2] < 90) hits++;
      }));
    }
    return { net: p.pos.net, hits, n };
  });
  ok(netPx.n > 0 && netPx.hits >= netPx.n * 0.6, '2D: pads of the probed net painted amber ' + JSON.stringify(netPx));
  const alts = await win.$$eval('.tp-alt.pos', (b) => b.map((x) => x.textContent));
  ok(alts.length >= 2, '+ probe alternatives: ' + alts.join(' '));
  await win.screenshot({ path: OUT + '/t-01-2d.png' });
  // pick an alternative point for + and keep it
  const before = await win.evaluate(() => TEST.state.probes.pos.ref + '.' + TEST.state.probes.pos.pin);
  await win.click('.tp-alt.pos:not(.on)'); await win.waitForTimeout(300);
  const after = await win.evaluate(() => TEST.state.probes.pos.ref + '.' + TEST.state.probes.pos.pin);
  ok(before !== after && await win.evaluate(() => !!TEST.state.res.override[TEST.state.steps[1].id]), `alternative point chosen: ${before} → ${after}`);
  // GND continuity: net named "/GND" is painted amber; icons survive zooming
  const gi = await win.evaluate(() => TEST.state.steps.findIndex((s) => s.id === 'cont:GND'));
  await win.evaluate((i) => document.querySelectorAll('.tp-item')[i].click(), gi); await win.waitForTimeout(300);
  const amb = await win.evaluate(() => {
    const p = TEST.state.probes;
    const fpads = [];
    pcbdata.footprints.forEach((f, fi) => f.pads.forEach((q, pi) => { if (q.net === '/GND' && q.layers.includes('F') && !(fi === p.pos.fp && pi === p.pos.pad) && !(fi === p.neg.fp && pi === p.neg.pad)) fpads.push(q); }));
    const ctx = allcanvas.front.highlight.getContext('2d'); const m = ctx.getTransform();
    let hits = 0;
    fpads.forEach((q) => { const s = m.transformPoint(new DOMPoint(q.pos[0], q.pos[1])); const d = ctx.getImageData(Math.round(s.x), Math.round(s.y), 1, 1).data; if (d[0] > 200 && d[1] > 150 && d[2] < 90) hits++; });
    return hits + '/' + fpads.length;
  });
  ok(parseInt(amb, 10) >= 3, '"/GND" net painted amber at its pads (' + amb + ')');
  const zoomed = await win.evaluate(() => {
    const L = allcanvas.front; L.transform.zoom *= 2.5; redrawCanvas(L);
    const p = TEST.state.probes.pos, ctx = L.highlight.getContext('2d');
    const s = ctx.getTransform().transformPoint(new DOMPoint(p.pos[0], p.pos[1]));
    const d = ctx.getImageData(Math.round(s.x - 7 * devicePixelRatio), Math.round(s.y), 1, 1).data;
    L.transform.zoom /= 2.5; redrawCanvas(L);
    return [d[0], d[1], d[2], d[3]];
  });
  ok(zoomed[0] > 200 && zoomed[1] < 60 && zoomed[3] > 200, 'probe target ring still drawn after zooming ' + JSON.stringify(zoomed));
  await win.evaluate(() => document.querySelectorAll('.tp-item')[1].click()); await win.waitForTimeout(300);
  // continuity: 0.5 Ω − 0.2 probe → pass
  const st2 = await win.evaluate(() => TEST.state.steps[1].kind);
  await win.fill('#tp-val', '0.5'); await win.waitForTimeout(100);
  ok(/GEÇTİ|PASS/.test(await win.textContent('#tp-verdict')), 'live verdict: ' + await win.textContent('#tp-verdict'));
  await win.keyboard.press('Enter'); await win.waitForTimeout(300);
  ok(await win.evaluate(() => TEST.state.res.steps[TEST.state.steps[1].id].status === 'pass'), st2 + ' step passed');
  // go to the first isolation step without bridges: 12 Ω → fail, then OL → pass
  const iso = await win.evaluate(() => TEST.state.steps.findIndex((s) => s.kind === 'isolation' && s.expect.type === 'open'));
  await win.evaluate((i) => document.querySelectorAll('.tp-item')[i].click(), iso);
  await win.waitForTimeout(300);
  await win.fill('#tp-val', '12'); await win.keyboard.press('Enter'); await win.waitForTimeout(300);
  ok(await win.evaluate((i) => TEST.state.res.steps[TEST.state.steps[i].id].status === 'fail', iso), 'isolation 12 Ω → FAIL (short detected)');
  await win.evaluate((i) => document.querySelectorAll('.tp-item')[i].click(), iso);
  await win.waitForTimeout(200);
  await win.click('.tp-ol'); await win.keyboard.press('Enter'); await win.waitForTimeout(300);
  ok(await win.evaluate((i) => TEST.state.res.steps[TEST.state.steps[i].id].status === 'pass', iso), 'isolation OL → PASS');
  await win.evaluate((i) => document.querySelectorAll('.tp-item')[i].click(), iso); await win.waitForTimeout(400);
  ok(await win.evaluate(() => !document.getElementById('asm-netlegend').hidden && document.querySelectorAll('#asm-netlegend .nl-row').length === 2), 'net legend shows both measured nets');
  await win.screenshot({ path: OUT + '/t-03-iso2d.png' });
  // manual step (connected through ICs)
  const man = await win.evaluate(() => TEST.state.steps.findIndex((s) => s.expect.type === 'manual'));
  if (man >= 0) {
    await win.evaluate((i) => document.querySelectorAll('.tp-item')[i].click(), man);
    await win.fill('#tp-val', '4.7k'); await win.keyboard.press('Enter'); await win.waitForTimeout(200);
    ok(await win.evaluate((i) => !TEST.state.res.steps[TEST.state.steps[i].id], man), 'manual step waits for the technician');
    await win.click('#tp-pass'); await win.waitForTimeout(300);
    ok(await win.evaluate((i) => TEST.state.res.steps[TEST.state.steps[i].id].status === 'pass' && TEST.state.res.steps[TEST.state.steps[i].id].ohms === 4700, man), 'manual pass recorded with 4.7 kΩ');
  }
  // v7.0: later phases — set VCC to 5 V input rail in Test settings, then measure it
  ok(await win.evaluate(() => TEST.state.plan.phases.map((p) => p.id).join(',')).then((x) => /gnd,pwr,volt/.test(x)), 'phases: ' + await win.evaluate(() => TEST.state.plan.phases.map((p) => p.id + '(' + p.steps.length + ')').join(' ')));
  ok(await win.evaluate(() => document.querySelectorAll('.tp-phase .tp-pw:not(.off)').length >= 1 && document.querySelectorAll('.tp-phase .tp-pw.off').length >= 2), 'phase headers show powered / unpowered');
  await win.click('text=Test ayarları…').catch(() => win.click('text=Test settings…'));
  await win.waitForSelector('.ts-rails'); await win.waitForTimeout(200);
  await win.fill('.ts-nom[data-net="VCC"]', '5');
  await win.check('.ts-inp[data-net="VCC"]');
  await win.screenshot({ path: OUT + '/t-04-settings.png' });
  await win.click('#asm-modal-root .asm-modal-footer .primary'); await win.waitForTimeout(500);
  const vi = await win.evaluate(() => TEST.state.steps.findIndex((s) => s.id === 'volt:VCC'));
  ok(vi > 0 && await win.evaluate((i) => TEST.state.steps[i].expect.type === 'range' && Math.abs(TEST.state.steps[i].expect.min - 4.5) < 1e-9, vi), 'VCC 5 V input rail, ±10 % after settings');
  await win.evaluate((i) => document.querySelectorAll('.tp-item')[i].click(), vi); await win.waitForTimeout(300);
  ok(await win.evaluate(() => !!document.querySelector('.tp-banner')), 'power banner on a powered step: ' + await win.evaluate(() => (document.querySelector('.tp-banner') || {}).className));
  ok(await win.evaluate(() => [...document.querySelectorAll('#tp-unit option')].map((o) => o.value).join(',') === 'V,mV' && !document.querySelector('.tp-ol')), 'voltage step: V / mV, no OL button');
  await win.fill('#tp-val', '4.98'); await win.waitForTimeout(100);
  ok(/GEÇTİ|PASS/.test(await win.textContent('#tp-verdict')), 'live verdict 4.98 V: ' + await win.textContent('#tp-verdict'));
  await win.screenshot({ path: OUT + '/t-05-volt.png' });
  await win.keyboard.press('Enter'); await win.waitForTimeout(300);
  ok(await win.evaluate(() => TEST.state.res.steps['volt:VCC'].status === 'pass'), 'VCC voltage recorded as pass');
  // supply step shows the supply connection points
  const onIdx = await win.evaluate(() => TEST.state.steps.findIndex((s) => s.id === 'volt-on'));
  await win.evaluate((i) => document.querySelectorAll('.tp-item')[i].click(), onIdx); await win.waitForTimeout(300);
  ok(await win.evaluate(() => TEST.state.probes && TEST.state.probes.pos.net === 'VCC'), 'power-up step shows where the supply connects');
  await win.screenshot({ path: OUT + '/t-06-poweron.png' });
  await win.evaluate(() => { writeStorage('testConfig', '{}'); });
  // 3D probes
  await win.evaluate((i) => document.querySelectorAll('.tp-item')[i].click(), iso);
  await win.click('#d3-btn'); await win.waitForFunction(() => V3D.state.ready); await win.waitForTimeout(1200);
  ok(await win.evaluate(() => V3D.state.probes && V3D.state.probes.children.length === 6), '3D: two probes + pad rings + target rings');
  const co = await win.evaluate(() => Array.from(document.querySelectorAll('#asm3d-callouts .asm3d-callout')).map((d) => { const r = d.getBoundingClientRect(); return { t: d.textContent, x: r.x, y: r.y, w: r.width }; }));
  const ln = await win.evaluate(() => Array.from(document.querySelectorAll('#asm3d-callouts line.core')).map((l) => Math.hypot(l.x2.baseVal.value - l.x1.baseVal.value, l.y2.baseVal.value - l.y1.baseVal.value)));
  ok(co.length === 2 && /^\+/.test(co[0].t) && /^COM/.test(co[1].t) && ln.length === 2 && ln.every((d) => d > 40), '3D: callouts with leader lines, away from the tip ' + JSON.stringify(ln.map(Math.round)));
  ok(await win.evaluate(() => V3D.state.netOverlay && V3D.state.netOverlay.length >= 2), '3D: probed nets painted on the board (' + await win.evaluate(() => (V3D.state.netOverlay || []).length) + ' sides)');
  await win.screenshot({ path: OUT + '/t-02-3d.png' });
  // persistence
  await win.reload(); await win.waitForTimeout(3000);
  ok(await win.evaluate(() => TEST.isOn() && Object.keys(TEST.state.res.steps).length >= 4 && TEST.state.res.offset === 0.2), 'results and test mode restored after restart');
  // report + log
  const proj = fs.readdirSync(path.join(DATA, 'projects')).filter((d) => !d.startsWith('_'))[0];
  const rep = path.join(DATA, 'projects', proj, 'test-reports');
  const pdfs = fs.existsSync(rep) ? fs.readdirSync(rep) : [];
  let txt = '';
  if (pdfs.length === 1) { fs.copyFileSync(path.join(rep, pdfs[0]), OUT + '/t-report.pdf'); txt = require('child_process').execFileSync('pdftotext', ['-layout', path.join(rep, pdfs[0]), '-']).toString(); }
  ok(pdfs.length === 1 && /\.pdf$/.test(pdfs[0]) && fs.readFileSync(path.join(rep, pdfs[0])).slice(0, 5).toString() === '%PDF-', 'PDF report written: ' + pdfs.join(','));
  ok(/Geçti|Passed/.test(txt) && /Gerilim kanalları|Voltage rails/.test(txt) && /Test eden|Tested by/.test(txt) && /Ölçüm adımları|Measurement steps/.test(txt), 'PDF report has summary, steps and signature lines');
  ok(/"type":"test"/.test(fs.readFileSync(path.join(DATA, 'projects', proj, 'log.jsonl'), 'utf8')), 'test steps in the assembly log');
  // back to assembly
  await win.click('#asm-mode-assembly'); await win.waitForTimeout(300);
  ok(await win.evaluate(() => !TEST.isOn() && getComputedStyle(document.getElementById('bomtable')).display !== 'none' && !V3D.state.probes), 'assembly mode restored, probes removed');
  await win.click('#asm-mode-test'); await win.waitForTimeout(300);
  if (process.env.AXE) {
    await win.evaluate(fs.readFileSync(process.env.AXE, 'utf8'));
    for (const dark of [false, true]) {
      await win.evaluate((d) => setDarkMode(d), dark); await win.waitForTimeout(400);
      const v = await win.evaluate(() => axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } }).then((x) => x.violations.map((v) => v.impact + ' ' + v.id + ' ' + v.nodes.slice(0, 3).map((n) => n.target.join(' ') + (n.any[0] && n.any[0].data && n.any[0].data.contrastRatio ? ' ' + n.any[0].data.fgColor + '/' + n.any[0].data.bgColor + '=' + n.any[0].data.contrastRatio : '')).join(' | '))));
      v.forEach((x) => console.log('   axe', x));
      ok(!v.some((x) => /^(critical|serious)/.test(x)), 'axe: test panel (' + (dark ? 'dark' : 'light') + ')');
    }
    await win.evaluate(() => setDarkMode(false));
  }
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
  await app.close();
})().catch((e) => { console.log('ERR', e.stack); process.exit(1); });
