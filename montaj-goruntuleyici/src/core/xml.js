'use strict';
// Minimal non-validating XML parser producing an ordered element tree:
// { name, attrs, children: [element...], text }
// Namespace prefixes are stripped from element and attribute names.

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeEntities(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.substring(2), 16) : parseInt(e.substring(1), 10));
    return ENT[e] != null ? ENT[e] : m;
  });
}
const strip = (n) => { const i = n.indexOf(':'); return i >= 0 ? n.substring(i + 1) : n; };

function parseXml(text) {
  const root = { name: '#root', attrs: {}, children: [] };
  const stack = [root];
  let i = 0;
  const n = text.length;
  const attrRe = /([^\s=\/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt < 0) break;
    if (lt > i) {
      const t = text.substring(i, lt);
      if (t.trim()) { const top = stack[stack.length - 1]; top.text = (top.text || '') + decodeEntities(t); }
    }
    if (text.startsWith('<!--', lt)) { const e = text.indexOf('-->', lt + 4); i = e < 0 ? n : e + 3; continue; }
    if (text.startsWith('<![CDATA[', lt)) {
      const e = text.indexOf(']]>', lt + 9);
      const top = stack[stack.length - 1];
      top.text = (top.text || '') + text.substring(lt + 9, e < 0 ? n : e);
      i = e < 0 ? n : e + 3; continue;
    }
    if (text[lt + 1] === '?' || text[lt + 1] === '!') { const e = text.indexOf('>', lt); i = e < 0 ? n : e + 1; continue; }
    // find end of tag respecting quotes
    let j = lt + 1, q = null;
    while (j < n) {
      const c = text[j];
      if (q) { if (c === q) q = null; }
      else if (c === '"' || c === "'") q = c;
      else if (c === '>') break;
      j++;
    }
    const inner = text.substring(lt + 1, j);
    i = j + 1;
    if (inner[0] === '/') {
      const name = strip(inner.substring(1).trim());
      // pop to matching element (tolerant)
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].name === name) { stack.length = k; break; }
      }
      continue;
    }
    const selfClose = inner.endsWith('/');
    const body = selfClose ? inner.substring(0, inner.length - 1) : inner;
    const sp = body.search(/\s/);
    const name = strip(sp < 0 ? body : body.substring(0, sp));
    const attrs = {};
    if (sp >= 0) {
      const as = body.substring(sp);
      let m;
      attrRe.lastIndex = 0;
      while ((m = attrRe.exec(as))) attrs[strip(m[1])] = decodeEntities(m[3] != null ? m[3] : m[4]);
    }
    const el = { name, attrs, children: [] };
    stack[stack.length - 1].children.push(el);
    if (!selfClose) stack.push(el);
  }
  return root;
}

// helpers
function kids(el, name) { return el ? el.children.filter((c) => c.name === name) : []; }
function kid(el, name) { return el ? el.children.find((c) => c.name === name) : undefined; }
function findAll(el, name, out = []) {
  if (!el) return out;
  for (const c of el.children) { if (c.name === name) out.push(c); findAll(c, name, out); }
  return out;
}
function find(el, name) {
  if (!el) return undefined;
  for (const c of el.children) { if (c.name === name) return c; const r = find(c, name); if (r) return r; }
  return undefined;
}

module.exports = { parseXml, kids, kid, findAll, find };
