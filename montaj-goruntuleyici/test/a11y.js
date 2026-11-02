// Accessibility smoke test (dev only): axe-core WCAG 2.1 AA scan + keyboard checks.
// Run after `test/e2e.js create` so a project / board exists.
//   AXE=/path/to/axe.min.js xvfb-run -a node test/a11y.js
const { _electron: electron } = require('playwright');
const path = require('path');
const fs = require('fs');
const OUT = process.env.SHOTS || '/home/claude/testdata/shots';
const DATA = process.env.MONTAJ_DATA_DIR || '/home/claude/testdata/e2e-data';
const AXE = fs.readFileSync(process.env.AXE, 'utf8');
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };

async function axe(win, label) {
  await win.evaluate(AXE);
  const r = await win.evaluate(() => axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })
    .then((x) => x.violations.map((v) => ({ id: v.id, impact: v.impact, n: v.nodes.length, t: v.nodes.slice(0, 5).map((n) => n.target.join(' ') + (n.any[0] && n.any[0].data && n.any[0].data.fgColor ? ` ${n.any[0].data.fgColor}/${n.any[0].data.bgColor}=${n.any[0].data.contrastRatio}` : '')) }))));
  console.log(`axe [${label}]: ${r.length} violation type(s)`);
  r.forEach((v) => console.log('   ', v.impact, v.id, 'x' + v.n, JSON.stringify(v.t)));
  return r;
}

(async () => {
  const app = await electron.launch({ executablePath: require('electron'), args: ['--no-sandbox', path.join(__dirname, '..')], env: Object.assign({}, process.env, { MONTAJ_DATA_DIR: DATA }) });
  const win = await app.firstWindow();
  win.on('pageerror', (e) => { console.log('PAGEERROR', e.message); fails++; });
  await win.setViewportSize({ width: 1500, height: 900 }).catch(() => {});
  await win.waitForTimeout(1200);

  // ---------------- home
  const homeV = await axe(win, 'home');
  ok(!homeV.some((v) => v.impact === 'critical' || v.impact === 'serious'), 'home: no serious/critical axe issues');
  ok(await win.evaluate(() => document.getElementById('toasts').getAttribute('aria-live') === 'polite'), 'home: toasts are a live region');
  await win.click('.proj .btn.primary >> nth=0');
  await win.waitForSelector('.modal[role=dialog]');
  ok(await win.evaluate(() => document.querySelector('.modal').getAttribute('aria-modal') === 'true' && document.querySelector('main').inert), 'home: dialog semantics + inert background');
  for (let i = 0; i < 25; i++) await win.keyboard.press('Tab');
  ok(await win.evaluate(() => document.querySelector('.modal').contains(document.activeElement)), 'home: focus trapped in dialog');
  await win.keyboard.press('Escape'); await win.waitForTimeout(200);
  ok(await win.evaluate(() => document.activeElement && document.activeElement.matches('.proj .btn.primary')), 'home: focus returns to opener');

  // ---------------- viewer
  await win.click('#resume .btn.primary');
  await win.waitForTimeout(2500);
  await win.mouse.move(700, 880);
  const vV = await axe(win, 'viewer');
  ok(!vV.some((v) => v.impact === 'critical'), 'viewer: no critical axe issues');

  // settings menu by keyboard
  await win.focus('#bomcontrols .menubtn');
  await win.keyboard.press('Enter'); await win.waitForTimeout(200);
  ok(await win.evaluate(() => document.querySelector('#bomcontrols .menubtn').getAttribute('aria-expanded') === 'true' && getComputedStyle(document.querySelector('#bomcontrols .menu .menu-content')).display === 'block'), 'viewer: settings menu opens with Enter');
  await win.screenshot({ path: OUT + '/a11y-01-menu-keyboard.png' });
  await win.keyboard.press('Escape'); await win.waitForTimeout(200);
  ok(await win.evaluate(() => document.querySelector('#bomcontrols .menubtn').getAttribute('aria-expanded') === 'false' && document.activeElement.classList.contains('menubtn')), 'viewer: Esc closes menu, focus back on button');

  // icon buttons named
  const unnamed = await win.evaluate(() => [...document.querySelectorAll('button')].filter((b) => b.offsetParent && !(b.getAttribute('aria-label') || b.textContent.trim())).map((b) => b.id || b.className));
  ok(unnamed.length === 0, 'viewer: every visible button has a name ' + JSON.stringify(unnamed));
  ok(await win.evaluate(() => { const c = document.querySelector('#bombody input[type=checkbox]'); return !!(c && c.getAttribute('aria-label')); }), 'viewer: row checkboxes labelled');

  // canvas keyboard pan / zoom
  await win.evaluate(() => { footprintIndexToHandler[0](); });
  await win.focus('#frontcanvas');
  const z0 = await win.evaluate(() => allcanvas.front.transform.zoom);
  await win.keyboard.press('+'); await win.keyboard.press('ArrowLeft');
  const z1 = await win.evaluate(() => [allcanvas.front.transform.zoom, document.getElementById('frontcanvas').getAttribute('aria-label')]);
  ok(z1[0] > z0, 'viewer: + zooms the focused board view');
  ok(/Seçili|Selected/.test(z1[1]), 'viewer: board view label names the selection: ' + z1[1].slice(0, 60));
  await win.screenshot({ path: OUT + '/a11y-02-canvas-focus.png' });
  await win.keyboard.press('0');

  // toggle a row checkbox + Ctrl+Z restores it
  await win.evaluate(() => { for (let k = 0; k < 200; k++) { highlightNextRow(); if (highlightedFootprints.some((i) => !pcbdata.bom.skipped.includes(i))) break; } });
  const before = await win.evaluate(() => getStoredCheckboxRefs(settings.checkboxes[0]).size);
  await win.click('#bombody tr.highlighted input[type=checkbox]'); await win.waitForTimeout(300);
  const mid = await win.evaluate(() => getStoredCheckboxRefs(settings.checkboxes[0]).size);
  await win.focus('#asm-place');
  await win.keyboard.press('Control+z'); await win.waitForTimeout(400);
  const after = await win.evaluate(() => getStoredCheckboxRefs(settings.checkboxes[0]).size);
  ok(mid !== before && after === before, `viewer: Ctrl+Z undoes the last check change (${before}→${mid}→${after})`);
  ok(await win.evaluate(() => document.getElementById('asm-now').getAttribute('aria-live') === 'polite'), 'viewer: Now bar is a live region');

  // operator dialog: trap + return
  await win.click('#asm-operator-btn'); await win.waitForTimeout(200);
  for (let i = 0; i < 12; i++) await win.keyboard.press('Tab');
  ok(await win.evaluate(() => document.querySelector('.asm-modal').contains(document.activeElement)), 'viewer: focus trapped in dialog');
  await win.keyboard.press('Escape'); await win.waitForTimeout(200);
  ok(await win.evaluate(() => document.activeElement.id === 'asm-operator-btn'), 'viewer: focus returns to technician button');

  // bulk confirm is an in-app dialog
  await win.evaluate(() => checkboxSetUnsetAllHandler(settings.checkboxes[0])());
  await win.waitForTimeout(200);
  ok(await win.evaluate(() => !!document.querySelector('.asm-modal[role=dialog]')), 'viewer: bulk action asks in an in-app dialog');
  await win.screenshot({ path: OUT + '/a11y-03-confirm.png' });
  await win.keyboard.press('Escape');

  // single-key toggle
  await win.evaluate(() => { const c = document.getElementById('asm-singlekey'); c.checked = false; c.onchange(); });
  const s0 = await win.evaluate(() => getStoredCheckboxRefs(settings.checkboxes[0]).size);
  await win.focus('#asm-next'); await win.keyboard.press('n'); await win.waitForTimeout(200);
  ok(s0 === await win.evaluate(() => getStoredCheckboxRefs(settings.checkboxes[0]).size), 'viewer: N disabled when single-key shortcuts are off');
  await win.evaluate(() => { const c = document.getElementById('asm-singlekey'); c.checked = true; c.onchange(); });

  // reflow at 200 % zoom equivalent
  await win.setViewportSize({ width: 683, height: 700 });
  await win.waitForTimeout(600);
  const sw = await win.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth, document.getElementById('top').scrollWidth]);
  ok(sw[2] <= sw[1] + 1, 'viewer: header reflows at 683 px ' + JSON.stringify(sw));
  await win.screenshot({ path: OUT + '/a11y-04-reflow-683.png' });
  await win.setViewportSize({ width: 1500, height: 900 });
  await win.evaluate(() => { setDarkMode(true); });
  await win.waitForTimeout(400);
  const dV = await axe(win, 'viewer dark');
  ok(!dV.some((v) => v.impact === 'critical'), 'viewer dark: no critical axe issues');
  await win.evaluate(() => { setDarkMode(false); });

  await app.close();
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
