'use strict';
// Browser build: turns the test report body produced by viewer-test.js (reportHtml)
// into a pdfmake document (A4 landscape, DejaVu Sans embedded). Same look as the
// Electron build, which prints the HTML with Chromium's printToPDF.
const C = { navy: '#1f3a5f', head: '#e7edf4', line: '#9aa5b3', pass: '#157a3a', fail: '#b3141f', open: '#8a5a00', failBg: '#fde6e8', skip: '#6b5200', muted: '#666666' };
const txt = (n) => (n ? n.textContent.replace(/\s+/g, ' ').trim() : '');

function inline(node) {
  // keeps <b class="pass|fail"> colouring inside a cell
  const parts = [];
  node.childNodes.forEach((c) => {
    if (c.nodeType === 3) { if (c.textContent) parts.push({ text: c.textContent }); return; }
    if (c.nodeType !== 1) return;
    const p = { text: c.textContent };
    if (c.tagName === 'B' || c.tagName === 'STRONG') p.bold = true;
    if (c.classList.contains('pass')) p.color = C.pass;
    if (c.classList.contains('fail')) p.color = C.fail;
    parts.push(p);
  });
  return parts.length ? parts : [{ text: '' }];
}

function table(el, kind) {
  const body = [];
  const head = el.tHead ? 1 : 0;
  let cols = 0;
  el.querySelectorAll('tr').forEach((tr) => {
    let n = 0;
    tr.querySelectorAll('th,td').forEach((c) => { n += +(c.getAttribute('colspan') || 1); });
    cols = Math.max(cols, n);
  });
  el.querySelectorAll('tr').forEach((tr) => {
    const row = [];
    const inHead = tr.parentNode.tagName === 'THEAD';
    const cls = tr.className || '';
    tr.querySelectorAll('th,td').forEach((c) => {
      const span = +(c.getAttribute('colspan') || 1);
      const cell = { text: inline(c), colSpan: span > 1 ? span : undefined };
      if (c.tagName === 'TH') { cell.bold = true; cell.fillColor = C.head; }
      if (/\bph\b/.test(cls)) { cell.fillColor = C.navy; cell.color = '#ffffff'; cell.bold = true; }
      if (/\brfail\b/.test(cls)) cell.fillColor = C.failBg;
      if (c.classList.contains('st')) {
        if (/rpass/.test(cls)) { cell.color = C.pass; cell.bold = true; }
        else if (/rfail/.test(cls)) { cell.color = C.fail; cell.bold = true; }
        else if (/rskip/.test(cls)) cell.color = C.skip;
        else cell.color = C.muted;
      }
      if (c.classList.contains('num')) cell.noWrap = true;
      row.push(cell);
      for (let i = 1; i < span; i++) row.push({});
    });
    while (row.length < cols) row.push({ text: '' });
    if (!inHead || body.length < head) body.push(row); else body.push(row);
  });
  let widths = Array(cols).fill('auto');
  if (kind === 'steps' && cols === 10) widths = [16, '*', 58, 58, 120, 'auto', 42, 70, 62, 'auto'];
  if (kind === 'meta' && cols === 8) widths = ['auto', '*', 'auto', '*', 'auto', '*', 'auto', '*'];
  if (kind === 'sum') widths = ['*'].concat(Array(Math.max(0, cols - 1)).fill('auto'));
  return {
    table: { headerRows: head, widths, body, dontBreakRows: true },
    layout: { hLineWidth: () => 0.6, vLineWidth: () => 0.6, hLineColor: () => C.line, vLineColor: () => C.line,
      paddingLeft: () => 3, paddingRight: () => 3, paddingTop: () => 2, paddingBottom: () => 2 },
    margin: [0, 0, 0, 4],
  };
}

function docDefinition(rep, version) {
  const dom = new DOMParser().parseFromString('<!doctype html><html><body>' + rep.html + '</body></html>', 'text/html');
  const content = [];
  dom.body.childNodes.forEach((n) => {
    if (n.nodeType !== 1) return;
    if (n.tagName === 'HEADER') {
      const v = n.querySelector('.verdict');
      const vc = v && v.classList.contains('pass') ? C.pass : v && v.classList.contains('fail') ? C.fail : C.open;
      content.push({
        columns: [
          { stack: [{ text: txt(n.querySelector('h1')), fontSize: 15, bold: true, color: C.navy }, { text: txt(n.querySelector('.sub')), fontSize: 10, margin: [0, 2, 0, 0] }] },
          { width: 'auto', table: { body: [[{ text: txt(v), bold: true, fontSize: 13, color: '#ffffff', fillColor: vc, margin: [10, 3, 10, 3] }]] }, layout: 'noBorders' },
        ],
      });
      content.push({ canvas: [{ type: 'line', x1: 0, y1: 4, x2: 770, y2: 4, lineWidth: 1.5, lineColor: C.navy }], margin: [0, 0, 0, 7] });
    } else if (n.tagName === 'H2') {
      content.push({ text: txt(n), fontSize: 10, bold: true, color: C.navy, margin: [0, 8, 0, 4] });
    } else if (n.tagName === 'TABLE') {
      content.push(table(n, n.classList.contains('steps') ? 'steps' : n.classList.contains('meta') ? 'meta' : 'sum'));
    } else if (n.classList.contains('sign')) {
      content.push({
        columns: Array.from(n.children).map((d) => ({ stack: [{ text: txt(d), bold: true }, { canvas: [{ type: 'line', x1: 0, y1: 24, x2: 230, y2: 24, lineWidth: 0.8 }] }] })),
        columnGap: 24, margin: [0, 18, 0, 0], unbreakable: true,
      });
    } else {
      content.push({ text: txt(n) });
    }
  });
  return {
    pageSize: 'A4', pageOrientation: 'landscape', pageMargins: [28, 30, 28, 34],
    info: { title: rep.title, creator: 'Montaj Görüntüleyici ' + version },
    defaultStyle: { font: 'DejaVu', fontSize: 7.6, lineHeight: 1.1 },
    content,
    footer: (page, pages) => ({
      columns: [{ text: (rep.footer || '') + ' · v' + version, fontSize: 6.5, color: '#555555' }, { text: page + ' / ' + pages, alignment: 'right', fontSize: 6.5, color: '#555555' }],
      margin: [28, 10, 28, 0],
    }),
  };
}

module.exports = { docDefinition };
