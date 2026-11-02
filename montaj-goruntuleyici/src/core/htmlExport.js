'use strict';
const { t } = require('../i18n/i18n');
// Standalone single-file HTML export of the assembly view (Turkish UI, no app session bar).
const fs = require('fs');
const path = require('path');

const VIEWER = path.join(__dirname, '..', 'renderer', 'viewer');

function defaultConfig(extra) {
  return Object.assign({
    dark_mode: false,
    show_pads: true,
    show_fabrication: false,
    show_silkscreen: true,
    show_zones: false,
    highlight_pin1: 'selected',
    redraw_on_drag: true,
    board_rotation: 0,
    checkboxes: t('Dizildi'),
    bom_view: 'left-right',
    layer_view: 'FB',
    offset_back_rotation: false,
    kicad_text_formatting: false,
    mark_when_checked: t('Dizildi'),
    fields: [],
  }, extra || {});
}

function exportHtml(pcbdata, config, outFile, lang) {
  const read = (f) => fs.readFileSync(path.join(VIEWER, f), 'utf8');
  let html = read('viewer.html');
  // drop the application-only parts
  html = html.replace(/\s*<nav class="asm-nav" id="asm-session">[\s\S]*?<\/nav>/, '');
  html = html.replace(/\s*<div class="job-now" id="asm-nowbar"[\s\S]*?<\/span>\s*<\/div>/, '');
  html = html.replace(/\s*<div class="job-grid">[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/, '');
  html = html.replace(/\s*<label class="menu-label asm-color-row">\s*<span><input id="asm-singlekey"[\s\S]*?<\/label>/, '');
  html = html.replace(/\s*<meta http-equiv="Content-Security-Policy"[^>]*>/, '');
  html = html.replace(/\s*<link rel="stylesheet" href="[^"]+">/g, '');
  html = html.replace(/\s*<script src="[^"]+"><\/script>/g, '');
  html = html.replace('<div id="asm-modal-root"></div>', '').replace(/<div id="asm-toasts"[^>]*><\/div>/, '');
  const i18n = fs.readFileSync(path.join(__dirname, '..', 'i18n', 'i18n.js'), 'utf8') +
    `\nI18N.setLang(${JSON.stringify(lang || 'tr')});\ndocument.addEventListener('DOMContentLoaded', function () { I18N.translateDom(document.body); });\n`;
  const scripts = i18n + ['ibom/split.js', 'ibom/pep.js'].map(read).join('\n') +
    '\nvar config = ' + JSON.stringify(config) + ';\nvar pcbdata = ' + JSON.stringify(pcbdata) + ';\n' +
    ['ibom/util.js', 'ibom/render.js', 'ibom/table-util.js', 'ibom/ibom.js', 'viewer-a11y.js'].map(read).join('\n');
  const fontDir = path.join(VIEWER, '..', 'fonts');
  const fonts = fs.readFileSync(path.join(fontDir, 'fonts.css'), 'utf8')
    .replace(/url\('([^']+\.ttf)'\)/g, (m, f) => `url(data:font/ttf;base64,${fs.readFileSync(path.join(fontDir, f)).toString('base64')})`);
  const css = fonts + '\n' + read('ibom/ibom.css') + '\n' + read('viewer.css');
  const inject = '<style>\n' + css + '\n</style>\n<script>\n' + scripts.replace(/<\/script>/g, '<\\/script>') + '\n</script>\n';
  const i = html.indexOf('</head>');
  html = html.substring(0, i) + inject + html.substring(i);
  fs.writeFileSync(outFile, html, 'utf8');
  return outFile;
}

module.exports = { exportHtml, defaultConfig };
