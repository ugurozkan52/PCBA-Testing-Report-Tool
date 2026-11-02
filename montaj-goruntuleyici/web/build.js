'use strict';
// Builds the browser version (GitHub Pages) into dist-web/:
//   node web/build.js [outDir]
// The renderer pages are used as they are; window.asm (the Electron preload API) is
// provided by web/asm-web.js, which runs the import / storage code in the browser.
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'dist-web'));
const pkg = require(path.join(ROOT, 'package.json'));

function copyDir(src, dst, filter) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (filter && !filter(s)) continue;
    if (e.isDirectory()) copyDir(s, d, filter); else fs.copyFileSync(s, d);
  }
}
const copy = (s, d) => { fs.mkdirSync(path.dirname(d), { recursive: true }); fs.copyFileSync(s, d); };
const shim = (n) => path.join(__dirname, 'shims', n);

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  // 1. pages and their scripts, same relative layout as in the app
  copyDir(path.join(ROOT, 'src', 'renderer'), path.join(OUT, 'src', 'renderer'));
  copyDir(path.join(ROOT, 'src', 'i18n'), path.join(OUT, 'src', 'i18n'));
  copy(path.join(ROOT, 'src', 'core', 'testplan.js'), path.join(OUT, 'src', 'core', 'testplan.js'));

  const API = '<script src="../../../web/asm-web.js"></script>';
  // home: API first, then the page scripts as usual
  const homeFile = path.join(OUT, 'src', 'renderer', 'home', 'home.html');
  let home = fs.readFileSync(homeFile, 'utf8');
  home = home.replace('<script src="../../i18n/i18n.js"></script>', API + '\n  <script src="../../i18n/i18n.js"></script>');
  if (!home.includes('asm-web.js')) throw new Error('home.html: i18n script tag not found');
  fs.writeFileSync(homeFile, home);
  // viewer: its scripts need the data synchronously → loaded by viewer-boot.js once storage is ready
  const viewerFile = path.join(OUT, 'src', 'renderer', 'viewer', 'viewer.html');
  let viewer = fs.readFileSync(viewerFile, 'utf8');
  const scripts = [];
  viewer = viewer.replace(/\n?\s*<script src="([^"]+)"><\/script>/g, (m, src) => { scripts.push(src); return ''; });
  if (scripts.length < 10) throw new Error('viewer.html: scripts not found');
  viewer = viewer.replace('</head>', `  <meta name="asm-scripts" content="${scripts.join(',')}">\n  ${API}\n  <script src="../../../web/viewer-boot.js"></script>\n</head>`);
  fs.writeFileSync(viewerFile, viewer);

  // 2. bundles
  const common = {
    bundle: true, platform: 'browser', format: 'iife', target: ['chrome100', 'firefox100', 'safari15'], minify: true, sourcemap: false,
    alias: { fs: shim('fs.js'), os: shim('os.js'), crypto: shim('crypto.js'), path: 'path-browserify' },
    inject: [path.join(__dirname, 'shims', 'buffer-global.js'), path.join(__dirname, 'shims', 'process-global.js')],
    define: { APP_VERSION: JSON.stringify(pkg.version), __dirname: '"/app/src/core"', 'process.env.NODE_ENV': '"production"', global: 'globalThis' },
    logLevel: 'warning', logOverride: { 'duplicate-object-key': 'silent' }, legalComments: 'eof',
  };
  await esbuild.build(Object.assign({}, common, { entryPoints: [path.join(__dirname, 'entry.js')], outfile: path.join(OUT, 'web', 'asm-web.js') }));
  await esbuild.build(Object.assign({}, common, {
    entryPoints: [path.join(__dirname, 'step-worker.js')], outfile: path.join(OUT, 'web', 'step-worker.js'),
    alias: Object.assign({}, common.alias, { 'occt-import-js': shim('occt.js') }),
  }));
  copy(path.join(__dirname, 'viewer-boot.js'), path.join(OUT, 'web', 'viewer-boot.js'));

  // 3. libraries loaded at run time
  const occt = path.join(ROOT, 'node_modules', 'occt-import-js', 'dist');
  for (const f of ['occt-import-js.js', 'occt-import-js.wasm', 'license.occt-import-js.txt', 'license.occt.txt']) copy(path.join(occt, f), path.join(OUT, 'web', 'lib', f));
  copy(path.join(ROOT, 'node_modules', 'pdfmake', 'build', 'pdfmake.min.js'), path.join(OUT, 'web', 'lib', 'pdfmake.min.js'));
  copy(path.join(ROOT, 'node_modules', 'pdfmake', 'LICENSE'), path.join(OUT, 'web', 'lib', 'LICENSE.pdfmake.txt'));

  // 4. site root
  copy(path.join(ROOT, 'build', 'icon.png'), path.join(OUT, 'icon.png'));
  fs.writeFileSync(path.join(OUT, '.nojekyll'), '');
  fs.writeFileSync(path.join(OUT, 'index.html'), `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Montaj Görüntüleyici</title><link rel="icon" href="icon.png">
<meta http-equiv="refresh" content="0; url=src/renderer/home/home.html">
<script>location.replace('src/renderer/home/home.html' + location.search + location.hash);</script>
</head><body><p><a href="src/renderer/home/home.html">Montaj Görüntüleyici</a></p></body></html>
`);
  let size = 0;
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else size += fs.statSync(p).size; } })(OUT);
  console.log(`web build v${pkg.version}: ${OUT} (${(size / 1048576).toFixed(1)} MB)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
