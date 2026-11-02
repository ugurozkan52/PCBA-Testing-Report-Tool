'use strict';
const { t } = require('../i18n/i18n');
// Reading of BOM tables: CSV / TXT / XLS / XLSX.
const fs = require('fs');
const path = require('path');
const G = require('./geometry');

function decodeBuffer(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.slice(3).toString('utf8');
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.slice(2));
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.slice(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch (e) {
    try { return new TextDecoder('windows-1254').decode(buf); } catch (e2) { return buf.toString('latin1'); }
  }
}

// Split a single line honoring quotes. delim: ',', ';', '\t' or 'ws' (whitespace)
function splitLine(line, delim) {
  const out = [];
  let i = 0;
  const n = line.length;
  if (delim === 'ws') {
    while (i < n) {
      while (i < n && /\s/.test(line[i])) i++;
      if (i >= n) break;
      if (line[i] === '"') {
        let j = i + 1, s = '';
        while (j < n) {
          if (line[j] === '"' && line[j + 1] === '"') { s += '"'; j += 2; continue; }
          if (line[j] === '"') break;
          s += line[j++];
        }
        out.push(s); i = j + 1;
      } else {
        let j = i;
        while (j < n && !/\s/.test(line[j])) j++;
        out.push(line.substring(i, j)); i = j;
      }
    }
    return out;
  }
  let cur = '', q = false;
  for (; i < n; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === delim) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

// Join physical lines where a quoted field spans newlines
function logicalLines(text) {
  const raw = text.split(/\r?\n/);
  const out = [];
  let buf = null;
  for (const l of raw) {
    if (buf !== null) buf += '\n' + l; else buf = l;
    const quotes = (buf.match(/"/g) || []).length;
    if (quotes % 2 === 0) { out.push(buf); buf = null; }
  }
  if (buf !== null) out.push(buf);
  return out;
}

function detectDelimiter(lines) {
  const sample = lines.filter((l) => l.trim()).slice(0, 60);
  const score = {};
  for (const d of [',', ';', '\t']) {
    const counts = sample.map((l) => splitLine(l, d).length);
    const many = counts.filter((c) => c >= 3);
    score[d] = many.length ? many.length * 10 + Math.min(...many) : 0;
  }
  let best = ',';
  for (const d of [';', '\t']) if (score[d] > score[best]) best = d;
  if (score[best] === 0) return 'ws';
  // whitespace separated text tables with quoted fields
  const wsCounts = sample.map((l) => splitLine(l, 'ws').length).filter((c) => c >= 4).length;
  if (wsCounts > sample.length * 0.6 && score[best] < sample.length * 5) return 'ws';
  return best;
}

function parseDelimitedText(text) {
  const lines = logicalLines(text);
  const delim = detectDelimiter(lines);
  return { rows: lines.map((l) => (l.trim() ? splitLine(l, delim) : [])), delim };
}

let XLSX = null;
function readTableFile(file, sheetName) {
  const ext = path.extname(file).toLowerCase();
  const buf = fs.readFileSync(file);
  if (ext === '.xlsx' || ext === '.xls' || ext === '.xlsm' || ext === '.ods') {
    if (!XLSX) XLSX = require('xlsx');
    const wb = XLSX.read(buf, { type: 'buffer', cellDates: false });
    const name = sheetName && wb.SheetNames.includes(sheetName) ? sheetName : wb.SheetNames[0];
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: '', blankrows: true })
      .map((r) => r.map((c) => (c == null ? '' : String(c).trim())));
    return { rows, sheets: wb.SheetNames, sheet: name, delim: null };
  }
  const r = parseDelimitedText(decodeBuffer(buf));
  return { rows: r.rows, sheets: null, sheet: null, delim: r.delim };
}

// ------------------------------- column detection ----------------------------
const RX = {
  designator: /^(designators?|ref\s*des(ignators?)?|refdes|references?|reference\s*designators?|part\s*reference|ref\.?|referans|komponent)$/i,
  value: /^(comment|value|val|değer|deger)$/i,
  footprint: /^(footprint|package|pattern|case|kılıf|kilif|pcb\s*footprint)$/i,
  qty: /^(quantity|qty|adet|miktar|q'?ty)$/i,
  desc: /^(description|açıklama|aciklama)$/i,
};

function findHeaderRow(rows) {
  const lim = Math.min(rows.length, 60);
  for (let i = 0; i < lim; i++) {
    const r = rows[i] || [];
    const hasDes = r.some((c) => RX.designator.test(String(c).trim()));
    if (!hasDes) continue;
    return i;
  }
  return -1;
}

function findCol(header, rx) {
  const list = Array.isArray(rx) ? rx : [rx];
  for (const r of list) {
    const i = header.findIndex((h) => r.test(String(h).trim()));
    if (i >= 0) return i;
  }
  return -1;
}

// ------------------------------------ BOM ------------------------------------
function expandDesignators(s) {
  const out = [];
  const tokens = String(s).split(/[,;\s]+/).map((t) => t.trim()).filter(Boolean);
  for (const t of tokens) {
    const m = t.match(/^([A-Za-z_]+)(\d+)-([A-Za-z_]*)(\d+)$/);
    if (m && (!m[3] || m[3] === m[1])) {
      const a = parseInt(m[2], 10), b = parseInt(m[4], 10);
      if (b >= a && b - a < 2000) {
        for (let k = a; k <= b; k++) out.push(m[1] + k);
        continue;
      }
    }
    out.push(t);
  }
  return out;
}

function suggestBomMapping(rows) {
  const hr = findHeaderRow(rows);
  if (hr < 0) return { headerRow: -1, header: [], cols: {}, fields: [] };
  const header = rows[hr].map((c) => String(c).trim());
  const cols = {
    designator: findCol(header, RX.designator),
    qty: findCol(header, RX.qty),
    value: findCol(header, RX.value),
    footprint: findCol(header, RX.footprint),
  };
  // Field columns: everything except designator/qty/empty headers.
  const fields = [];
  header.forEach((h, i) => {
    if (!h || i === cols.designator || i === cols.qty) return;
    if (/^(#|no\.?|line\s*#?|item|sıra|sira)$/i.test(h)) return;
    fields.push({ col: i, name: h, show: true });
  });
  // Prefer a compact default set when many columns exist
  // Always shown: Description, Manufacturer, Manufacturer Part Number (any common spelling)
  const must = /^(description|açıklama|aciklama|manufacturer|mfr\.?|üretici|uretici|manufacturer\s*part\s*(number|no)|mfr\.?\s*part\s*(number|no|#)|mpn|üretici\s*parça\s*(no|numarası))$/i;
  if (fields.length > 6) {
    const pref = /^(comment|value|footprint|supplier part number|part number|lib ?ref|stok kodu|değer)/i;
    let shown = 0;
    for (const f of fields) { f.show = must.test(f.name) || (pref.test(f.name) && shown < 5); if (f.show && !must.test(f.name)) shown++; }
    if (!fields.some((f) => f.show)) fields.slice(0, 5).forEach((f) => (f.show = true));
  }
  // dizgi listesinde bu sütunlar önce gelsin: Comment/Value, Description, Manufacturer, MPN, diğerleri
  const rank = (n) => (/^(comment|value|değer|deger)$/i.test(n) ? 0 : /^(description|açıklama|aciklama)$/i.test(n) ? 1 : /^(manufacturer|mfr\.?|üretici|uretici)$/i.test(n) ? 2 : must.test(n) ? 3 : 4);
  fields.sort((a, b) => rank(a.name) - rank(b.name) || a.col - b.col);
  return { headerRow: hr, header, cols, fields };
}

function parseBom(rows, mapping) {
  const m = mapping || suggestBomMapping(rows);
  const warnings = [];
  if (m.headerRow < 0 || m.cols.designator < 0) {
    return { lines: [], mapping: m, warnings: [t('BOM başlık satırı / Designator sütunu bulunamadı.')] };
  }
  const lines = [];
  const seen = new Map();
  for (let i = m.headerRow + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r.length) continue;
    const refs = expandDesignators(r[m.cols.designator] || '');
    if (!refs.length) continue;
    const fields = {};
    for (const f of m.fields) fields[f.name] = String(r[f.col] == null ? '' : r[f.col]).trim();
    const uniq = [];
    for (const ref of refs) {
      if (seen.has(ref)) { warnings.push(t("BOM'da tekrar eden designator: {ref} (satır {row})", { ref, row: i + 1 })); continue; }
      seen.set(ref, lines.length);
      uniq.push(ref);
    }
    if (m.cols.qty >= 0) {
      const q = parseFloat(String(r[m.cols.qty]).replace(',', '.'));
      if (isFinite(q) && q !== refs.length) warnings.push(t('BOM satır {row}: Adet ({q}) ile designator sayısı ({n}) farklı.', { row: i + 1, q, n: refs.length }));
    }
    if (uniq.length) lines.push({ refs: uniq.sort(G.naturalCompare), fields, row: i + 1 });
  }
  return { lines, mapping: m, warnings };
}

module.exports = { decodeBuffer, parseDelimitedText, readTableFile, suggestBomMapping, parseBom, expandDesignators };
