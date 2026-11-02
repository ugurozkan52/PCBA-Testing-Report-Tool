'use strict';
// STEP (AP203/AP214/AP242) → compact triangle model aligned to the board data.
//
// The STEP file is triangulated by occt-import-js (OpenCascade, WASM). Every
// body is then assigned to a designator:
//   1. by name  – Altium names each component after its designator, optionally
//                 with a suffix ("C12", "C12_Board", "C12-1" …);
//   2. by place – bodies without a usable name are matched to the footprint
//                 whose outline contains the body centre on the same side.
// The model is translated so that STEP (x, y) corresponds to board (x, -y),
// i.e. world = (x + dx, y - dy) with board y = -world y.

const { t } = require('../i18n/i18n');

const TRI_PARAMS = { linearUnit: 'millimeter', linearDeflectionType: 'absolute_value', linearDeflection: 0.08, angularDeflection: 0.5 };

function median(a) {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ------------------------------------------------------------ name matching
function makeNameMatcher(refs) {
  const byUpper = new Map(refs.map((r) => [String(r).toUpperCase(), r]));
  return function match(name) {
    if (!name) return null;
    const n = String(name).trim().toUpperCase();
    if (!n) return null;
    if (byUpper.has(n)) return byUpper.get(n);
    // longest prefix that ends at a separator: "C12_BOARD", "C12-1", "C12 (CAP)", "C12:1"
    for (let k = n.length - 1; k > 0; k--) {
      if (/[A-Z0-9]/.test(n[k])) continue;
      const p = n.substring(0, k);
      if (byUpper.has(p)) return byUpper.get(p);
    }
    // Altium "Designator=C12" style properties inside the name
    const m = n.match(/(?:^|[^A-Z0-9])(?:DESIGNATOR|REFDES)\s*[=:]\s*([A-Z0-9_]+)/);
    if (m && byUpper.has(m[1])) return byUpper.get(m[1]);
    return null;
  };
}

function bboxOf(pos) {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2];
    if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (z < b[2]) b[2] = z;
    if (x > b[3]) b[3] = x; if (y > b[4]) b[4] = y; if (z > b[5]) b[5] = z;
  }
  return b;
}

// area-weighted vertex normals for bodies delivered without normals
function computeNormals(p, ix, out, o) {
  for (let k = 0; k < ix.length; k += 3) {
    const a = ix[k] * 3, b = ix[k + 1] * 3, c = ix[k + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const q of [a, b, c]) { out[o + q] += nx; out[o + q + 1] += ny; out[o + q + 2] += nz; }
  }
  for (let q = 0; q < p.length; q += 3) {
    const l = Math.hypot(out[o + q], out[o + q + 1], out[o + q + 2]) || 1;
    out[o + q] /= l; out[o + q + 1] /= l; out[o + q + 2] /= l;
  }
}

// footprint outline (board coordinates) → point-in-rotated-rect test
function fpContains(fp, x, y, margin) {
  const b = fp.bbox;
  if (!b || !b.size || !b.size[0]) return false;
  const a = (b.angle || 0) * Math.PI / 180;
  // inverse of: translate(pos) rotate(-angle) translate(relpos)
  const dx = x - b.pos[0], dy = y - b.pos[1];
  const u = dx * Math.cos(a) - dy * Math.sin(a);
  const v = dx * Math.sin(a) + dy * Math.cos(a);
  return u >= b.relpos[0] - margin && u <= b.relpos[0] + b.size[0] + margin && v >= b.relpos[1] - margin && v <= b.relpos[1] + b.size[1] + margin;
}

/**
 * result: occt-import-js ReadStepFile result
 * pcb:    { footprints: [{ref, layer, center, bbox}], edges_bbox }
 * returns { meta, positions: Float32Array, normals: Float32Array, indices: Uint32Array }
 */
function buildModel(result, pcb) {
  const warnings = [];
  const meshes = result.meshes || [];
  const fps = pcb.footprints || [];
  const fpByRef = new Map(fps.map((f) => [f.ref, f]));
  const matchName = makeNameMatcher(fps.map((f) => f.ref));

  // names along the hierarchy for every mesh (deepest first)
  const chains = new Array(meshes.length);
  (function walk(node, anc) {
    const here = node.name ? [node.name].concat(anc) : anc;
    for (const mi of node.meshes || []) chains[mi] = [meshes[mi].name].concat(here);
    for (const c of node.children || []) walk(c, here);
  })(result.root || { meshes: [], children: [] }, []);

  const items = meshes.map((m, i) => {
    const pos = m.attributes.position.array;
    const bb = bboxOf(pos);
    let ref = null;
    for (const n of chains[i] || [m.name]) { ref = matchName(n); if (ref) break; }
    const isBoardName = (chains[i] || [m.name]).slice(0, 2).some((n) => /(^|[^a-z])(pcb|board|kart)([^a-z]|$)/i.test(n || ''));
    return { i, m, bb, ref, how: ref ? 'name' : null, boardName: isBoardName && !ref };
  });

  // ------------------------------------------------------- board body
  const area = (b) => (b[3] - b[0]) * (b[4] - b[1]);
  const thin = items.filter((it) => !it.ref && (it.bb[5] - it.bb[2]) < 6 && isFinite(it.bb[0]));
  let board = thin.filter((it) => it.boardName).sort((a, b) => area(b.bb) - area(a.bb))[0];
  if (!board) board = thin.sort((a, b) => area(b.bb) - area(a.bb))[0];
  const eb = pcb.edges_bbox;
  if (board && eb && area(board.bb) < 0.3 * (eb.maxx - eb.minx) * (eb.maxy - eb.miny)) board = null;
  if (board) board.kind = 'board';

  // ------------------------------------------------------- alignment
  // board(x, y) = (wx, -wy) after world = step + (dx, -dy)
  const named = items.filter((it) => it.ref && fpByRef.get(it.ref));
  let dx = 0, dy = 0, how = 'none';
  if (named.length >= 2) {
    const ox = [], oy = [];
    for (const it of named) {
      const f = fpByRef.get(it.ref);
      ox.push(f.center[0] - (it.bb[0] + it.bb[3]) / 2);
      oy.push(f.center[1] + (it.bb[1] + it.bb[4]) / 2);
    }
    dx = median(ox); dy = median(oy); how = 'components';
  } else if (board && eb) {
    dx = (eb.minx + eb.maxx) / 2 - (board.bb[0] + board.bb[3]) / 2;
    dy = (eb.miny + eb.maxy) / 2 + (board.bb[1] + board.bb[4]) / 2;
    how = 'board';
  }
  if (Math.abs(dx) < 1e-6) dx = 0;
  if (Math.abs(dy) < 1e-6) dy = 0;

  const zTop = board ? board.bb[5] : 1.6, zBot = board ? board.bb[2] : 0;
  const zMid = (zTop + zBot) / 2;

  // ------------------------------------------------------- spatial matching
  let byPlace = 0;
  for (const it of items) {
    if (it.ref || it === board || !isFinite(it.bb[0])) continue;
    const cx = (it.bb[0] + it.bb[3]) / 2 + dx, cy = -((it.bb[1] + it.bb[4]) / 2) + dy;
    const side = (it.bb[2] + it.bb[5]) / 2 >= zMid ? 'F' : 'B';
    let best = null, bestArea = Infinity;
    for (const f of fps) {
      if (f.layer !== side || !fpContains(f, cx, cy, 0.3)) continue;
      const a = f.bbox.size[0] * f.bbox.size[1];
      if (a < bestArea) { best = f; bestArea = a; }
    }
    if (best) { it.ref = best.ref; it.how = 'place'; byPlace++; }
  }

  // ------------------------------------------------------- pack buffers
  let nv = 0, ni = 0;
  for (const it of items) { nv += it.m.attributes.position.array.length; ni += it.m.index.array.length; }
  const positions = new Float32Array(nv), normals = new Float32Array(nv), indices = new Uint32Array(ni);
  const parts = [];
  let vo = 0, io = 0;
  for (const it of items) {
    const p = it.m.attributes.position.array, n = it.m.attributes.normal && it.m.attributes.normal.array, ix = it.m.index.array;
    for (let k = 0; k < p.length; k += 3) {
      positions[vo + k] = p[k] + dx; positions[vo + k + 1] = p[k + 1] - dy; positions[vo + k + 2] = p[k + 2];
    }
    if (n && n.length === p.length) normals.set(n, vo);
    else computeNormals(p, ix, normals, vo);
    const base = vo / 3;
    for (let k = 0; k < ix.length; k++) indices[io + k] = ix[k] + base;
    // colour ranges (per b-rep face) in index units, merged when adjacent
    const groups = [];
    const def = it.m.color || null;
    for (const f of it.m.brep_faces || []) {
      const c = f.color || def;
      const start = io + f.first * 3, count = (f.last - f.first + 1) * 3;
      const g = groups[groups.length - 1];
      if (g && g.start + g.count === start && String(g.color) === String(c)) g.count += count;
      else groups.push({ start, count, color: c });
    }
    if (!groups.length) groups.push({ start: io, count: ix.length, color: def });
    parts.push({
      name: it.m.name || '', ref: it.ref || null, how: it.how || null, kind: it.kind || (it.ref ? 'comp' : 'other'),
      vStart: vo / 3, vCount: p.length / 3, iStart: io, iCount: ix.length, groups,
    });
    vo += p.length; io += ix.length;
  }

  // ------------------------------------------------------- report
  const refsWithBody = new Set(parts.filter((p) => p.ref).map((p) => p.ref));
  const noBody = fps.filter((f) => !refsWithBody.has(f.ref) && f.bbox && f.bbox.size && f.bbox.size[0]).map((f) => f.ref);
  const unmatched = parts.filter((p) => !p.ref && p.kind !== 'board').length;
  if (!meshes.length) warnings.push(t('STEP dosyasında 3D gövde bulunamadı.'));
  if (meshes.length === 1) warnings.push(t('STEP dosyası tek parça olarak kaydedilmiş; bileşenler ayrı seçilemez. Altium’da "Export As Single Part" seçeneğini kapatın.'));
  if (!board && meshes.length) warnings.push(t('STEP içinde kart gövdesi tanınamadı; hizalama yalnızca bileşenlere göre yapıldı.'));
  if (how === 'none' && meshes.length) warnings.push(t('STEP modeli kart verisine hizalanamadı (eşleşen bileşen yok).'));
  if (unmatched) warnings.push(t('{n} 3D gövde hiçbir bileşenle eşleşmedi (vida, soğutucu, mekanik parça olabilir).', { n: unmatched }));
  if (noBody.length) warnings.push(t('{n} bileşenin STEP modeli yok; 3D görünümde kutu olarak gösterilir: {refs}', { n: noBody.length, refs: noBody.slice(0, 20).join(', ') + (noBody.length > 20 ? ' …' : '') }));

  const meta = {
    version: 1,
    align: { dx, dy, how },
    board: board ? { zTop, zBot, bbox: board.bb.map((v, k) => (k % 3 === 0 ? v + dx : k % 3 === 1 ? v - dy : v)) } : null,
    parts,
    counts: {
      bodies: meshes.length, byName: named.length, byPlace, unmatched,
      components: refsWithBody.size, noBody: noBody.length, triangles: indices.length / 3,
    },
    warnings,
  };
  return { meta, positions, normals, indices };
}

// Binary container: [u32 headerLen][header json utf8][pad to 4][positions][normals][indices]
function packModel(model) {
  const head = Buffer.from(JSON.stringify(Object.assign({}, model.meta, {
    nPos: model.positions.length, nNorm: model.normals.length, nIdx: model.indices.length,
  })), 'utf8');
  const hl = head.length, pad = (4 - ((4 + hl) % 4)) % 4;
  const out = Buffer.alloc(4 + hl + pad + model.positions.byteLength + model.normals.byteLength + model.indices.byteLength);
  out.writeUInt32LE(hl, 0);
  head.copy(out, 4);
  let o = 4 + hl + pad;
  Buffer.from(model.positions.buffer, model.positions.byteOffset, model.positions.byteLength).copy(out, o); o += model.positions.byteLength;
  Buffer.from(model.normals.buffer, model.normals.byteOffset, model.normals.byteLength).copy(out, o); o += model.normals.byteLength;
  Buffer.from(model.indices.buffer, model.indices.byteOffset, model.indices.byteLength).copy(out, o);
  return out;
}

function readHeader(buf) {
  const hl = buf.readUInt32LE(0);
  return JSON.parse(buf.toString('utf8', 4, 4 + hl));
}

let occtPromise = null;
function loadOcct() {
  if (!occtPromise) occtPromise = require('occt-import-js')();
  return occtPromise;
}

async function convertStep(fileBuffer, pcb) {
  const occt = await loadOcct();
  const res = occt.ReadStepFile(new Uint8Array(fileBuffer), TRI_PARAMS);
  if (!res || !res.success) throw new Error(t('STEP dosyası okunamadı (geçerli bir AP203/AP214/AP242 dosyası değil).'));
  return buildModel(res, pcb);
}

module.exports = { buildModel, packModel, readHeader, convertStep, makeNameMatcher, TRI_PARAMS };
