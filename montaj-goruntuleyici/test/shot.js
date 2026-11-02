const { chromium } = require('playwright');
(async () => {
  const [file, out, w, h, js] = process.argv.slice(2);
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: +w || 1600, height: +h || 900 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await p.goto('file://' + file);
  await p.waitForTimeout(800);
  if (js) { await p.evaluate(js); await p.waitForTimeout(500); }
  await p.screenshot({ path: out });
  console.log('errors:', errs.slice(0, 10));
  await b.close();
})();
