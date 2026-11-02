'use strict';
const { t } = require('../i18n/i18n');
// Import pipeline: IPC-2581 (geometry, positions, nets, optional BOM) + external BOM.
const fs = require('fs');
const { parseIpc2581 } = require('./ipc2581');
const { buildPcbData } = require('./builder');
const tab = require('./tabular');

// Honour the encoding declared in the XML header (UTF-8, ISO-8859-9, windows-1254, UTF-16...)
function decodeXml(buf) {
  const head = buf.slice(0, 200).toString('latin1');
  const m = head.match(/encoding\s*=\s*["']([^"']+)["']/i);
  const enc = m ? m[1].trim().toLowerCase() : null;
  if (enc && !/^utf-?8$/.test(enc) && buf[0] !== 0xff && buf[0] !== 0xfe && buf[0] !== 0xef) {
    try { return new TextDecoder(enc).decode(buf); } catch (e) { /* unknown label: fall back */ }
  }
  return tab.decodeBuffer(buf);
}

/**
 * spec = {
 *   ipcFile: path                         IPC-2581 file (required)
 *   bom: { path, sheet, mapping } | null  external BOM; if missing the BOM inside IPC-2581 is used
 *   meta: { title, revision, company }
 * }
 */
function runImport(spec) {
  if (!spec.ipcFile) throw new Error(t('IPC-2581 dosyası seçilmedi'));
  const r = parseIpc2581(decodeXml(fs.readFileSync(spec.ipcFile)));
  const model = r.model;
  const meta = Object.assign({}, spec.meta || {});
  if (!meta.title && r.meta.title) meta.title = r.meta.title;
  if (!meta.revision && r.meta.revision) meta.revision = r.meta.revision;

  let bom = null;
  let bomSource = 'none';
  if (spec.bom && spec.bom.path) {
    const t = tab.readTableFile(spec.bom.path, spec.bom.sheet);
    bom = tab.parseBom(t.rows, spec.bom.mapping || null);
    model.warnings.push(...bom.warnings.slice(0, 10));
    bomSource = 'external';
  } else if (r.bom && r.bom.lines.length) {
    bom = r.bom;
    bomSource = 'ipc';
  }
  const out = buildPcbData(model, {
    title: meta.title, revision: meta.revision, company: meta.company, date: meta.date,
    bom,
  });
  out.report.bomSource = bomSource;
  if (bomSource === 'none') out.report.warnings.push(t('BOM yok (ne harici BOM verildi ne de IPC-2581 içinde BOM bölümü var); satırlar kılıf/parça adına göre gruplandı.'));
  return out;
}

module.exports = { runImport };
