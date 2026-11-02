'use strict';
const { t } = require('../i18n/i18n');
// Final assembly of iBOM-compatible pcbdata from the IPC-2581 board model + BOM.

const G = require('./geometry');

const SORT_ORDER = ['C', 'R', 'L', 'D', 'U', 'Y', 'X', 'F', 'SW', 'A', '~', 'HS', 'CNN', 'J', 'P', 'NT', 'MH'];
const PIN1 = new Set(['1', 'A', 'A1', 'P1', 'PAD1']);

function refPrefix(ref) { const m = String(ref).match(/^[^0-9]*/); return m ? m[0] : ''; }

function rowSortKey(row) {
  const p = refPrefix(row[0][0]);
  let o = SORT_ORDER.indexOf(p);
  if (o < 0) o = SORT_ORDER.indexOf('~');
  return [o, -row.length, row[0][0]];
}
function rowCompare(a, b) {
  const ka = rowSortKey(a), kb = rowSortKey(b);
  if (ka[0] !== kb[0]) return ka[0] - kb[0];
  if (ka[1] !== kb[1]) return ka[1] - kb[1];
  return G.naturalCompare(ka[2], kb[2]);
}

function padCentroid(pads) {
  if (!pads.length) return null;
  const bb = G.emptyBBox();
  for (const p of pads) G.bboxOfPoints([p.pos], bb);
  return [(bb.minx + bb.maxx) / 2, (bb.miny + bb.maxy) / 2];
}

// Polygon outline of a pad in world coordinates (approximation used for bbox)
function padWorldPoints(p) {
  let local;
  if (p.shape === 'custom' && p.polygons) local = [].concat(...p.polygons);
  else {
    const w = (p.size ? p.size[0] : 0) / 2, h = (p.size ? p.size[1] : 0) / 2;
    local = [[-w, -h], [w, -h], [w, h], [-w, h]];
  }
  const off = p.offset || [0, 0];
  // render: translate(pos); rotate(-angle) ; translate(offset)
  return local.map((q) => {
    const v = G.rot([q[0] + off[0], q[1] + off[1]], -(p.angle || 0));
    return [p.pos[0] + v[0], p.pos[1] + v[1]];
  });
}

function rotateVector(v, angle) {
  const a = (angle * Math.PI) / 180;
  return [v[0] * Math.cos(a) - v[1] * Math.sin(a), v[0] * Math.sin(a) + v[1] * Math.cos(a)];
}

function makeBBox(center, angle, worldPts, margin) {
  if (!worldPts.length) {
    return { pos: center, angle: 0, relpos: [-0.5, -0.5], size: [1, 1] };
  }
  const bb = G.emptyBBox();
  for (const w of worldPts) G.bboxOfPoints([rotateVector([w[0] - center[0], w[1] - center[1]], angle)], bb);
  return {
    pos: [G.round(center[0]), G.round(center[1])],
    angle: G.round(angle, 3),
    relpos: [G.round(bb.minx - margin), G.round(bb.miny - margin)],
    size: [G.round(bb.maxx - bb.minx + 2 * margin), G.round(bb.maxy - bb.miny + 2 * margin)],
  };
}



function isVia(t) { return t.start && t.end && t.start[0] === t.end[0] && t.start[1] === t.end[1]; }


/**
 * opts: { title, revision, company, date, bom: {lines, mapping} }
 */
function buildPcbData(model, opts) {
  const report = { warnings: model.warnings.slice(), info: [], missingInLayout: [], noPads: [], dnp: [] };
  const bomLines = (opts.bom && opts.bom.lines) || null;

  // 3. reference set
  const refs = new Set([...Object.keys(model.comps).filter((r) => model.comps[r].pads.length || model.comps[r].center)]);
  if (bomLines) for (const l of bomLines) for (const r of l.refs) refs.add(r);
  const refList = [...refs].sort(G.naturalCompare);

  // edges bbox
  let ebb = G.emptyBBox();
  for (const e of model.edges) {
    if (e.svgpath) {
      const nums = e.svgpath.match(/-?[\d.]+(?:e-?\d+)?/g) || [];
      for (let i = 0; i + 1 < nums.length; i += 2) G.bboxOfPoints([[+nums[i], +nums[i + 1]]], ebb);
    } else if (e.type === 'segment') G.bboxOfPoints([e.start, e.end], ebb);
    else if (e.type === 'arc' || e.type === 'circle') G.bboxOfPoints([[e.start[0] - e.radius, e.start[1] - e.radius], [e.start[0] + e.radius, e.start[1] + e.radius]], ebb);
    else if (e.type === 'polygon') e.polygons.forEach((p) => G.bboxOfPoints(p, ebb));
  }
  const contentBB = G.emptyBBox();
  for (const ref of refList) {
    const c = model.comps[ref];
    if (c) c.pads.forEach((p) => G.bboxOfPoints([p.pos], contentBB));
  }
  for (const s of ['F', 'B']) for (const t of model.tracks[s]) if (t.start) G.bboxOfPoints([t.start, t.end], contentBB);
  if (!G.bboxValid(ebb)) {
    ebb = G.bboxValid(contentBB) ? { minx: contentBB.minx - 3, miny: contentBB.miny - 3, maxx: contentBB.maxx + 3, maxy: contentBB.maxy + 3 } : { minx: 0, miny: 0, maxx: 100, maxy: 100 };
    const r = ebb;
    model.edges.push(
      { type: 'segment', start: [r.minx, r.miny], end: [r.maxx, r.miny], width: 0.1 },
      { type: 'segment', start: [r.maxx, r.miny], end: [r.maxx, r.maxy], width: 0.1 },
      { type: 'segment', start: [r.maxx, r.maxy], end: [r.minx, r.maxy], width: 0.1 },
      { type: 'segment', start: [r.minx, r.maxy], end: [r.minx, r.miny], width: 0.1 });
    report.warnings.push(t('IPC-2581 dosyasında kart profili (Profile) bulunamadı; bileşenlerin çevresine dikdörtgen çizildi.'));
  }

  // 4. footprints
  const footprints = [];
  const idOf = new Map();
  for (const ref of refList) {
    const c = model.comps[ref] || { pads: [], drawings: [] };
    const pads = c.pads.map((p) => {
      const q = Object.assign({}, p);
      const pin = q._pin;
      delete q._pin; delete q._fn;
      if (pin != null && PIN1.has(String(pin).toUpperCase())) q.pin1 = 1;
      q._pinName = pin;
      return q;
    });
    if (!pads.some((p) => p.pin1) && pads.length) {
      const named = pads.filter((p) => p._pinName != null && p._pinName !== '');
      if (named.length) named.sort((a, b) => G.naturalCompare(a._pinName, b._pinName))[0].pin1 = 1;
    }
    // keep the pin name (test procedure: "U5 pin 7")
    pads.forEach((p) => { if (p._pinName != null && p._pinName !== '') p.pin = String(p._pinName); delete p._pinName; });

    let center = c.center || padCentroid(pads);
    let side = c.side || null;
    if (!side) {
      const smd = pads.find((p) => p.type === 'smd');
      side = smd ? smd.layers[0] : 'F';
    }
    const rot = c.rot || 0;
    const missing = !center;
    if (missing) {
      center = [ebb.minx, ebb.miny];
      report.missingInLayout.push(ref);
    }
    if (!pads.length && !missing) report.noPads.push(ref);
    let bbox;
    if (c.outline && c.outline.length >= 3) bbox = makeBBox(center, rot, c.outline, 0);
    else bbox = missing ? { pos: center, angle: 0, relpos: [0, 0], size: [0, 0] } : makeBBox(center, rot, [].concat(...pads.map(padWorldPoints)), 0.15);
    const fp = { ref, center: [G.round(center[0]), G.round(center[1])], bbox, pads, drawings: c.drawings || [], layer: side };
    if (c.height) fp.height = c.height;
    idOf.set(ref, footprints.length);
    footprints.push(fp);

  }

  // 5. BOM
  let fieldNames;
  const fieldsById = {};
  const rows = [];
  const skipped = [];
  if (bomLines) {
    fieldNames = opts.bom.mapping.fields.filter((f) => f.show).map((f) => f.name);
    const inBom = new Set();
    for (const line of bomLines) {
      const row = [];
      for (const r of line.refs) {
        if (!idOf.has(r)) continue;
        const id = idOf.get(r);
        row.push([r, id]);
        inBom.add(r);
        fieldsById[id] = fieldNames.map((n) => line.fields[n] || '');
      }
      if (row.length) rows.push(row);
    }
    for (const fp of footprints) {
      if (!inBom.has(fp.ref)) {
        const id = idOf.get(fp.ref);
        skipped.push(id);
        report.dnp.push(fp.ref);
        const c = model.comps[fp.ref] || {};
        fieldsById[id] = fieldNames.map((n) => (/footprint|package|kılıf/i.test(n) ? c.footprint || '' : /^part$/i.test(n) ? c.part || '' : ''));
      }
    }
  } else {
    fieldNames = ['Value', 'Footprint'];
    const groups = new Map();
    for (const fp of footprints) {
      const c = model.comps[fp.ref] || {};
      const v = c.value || c.part || '';
      const f = c.footprint || '';
      const id = idOf.get(fp.ref);
      fieldsById[id] = [v, f];
      const k = v + '\u0000' + f + '\u0000' + refPrefix(fp.ref);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push([fp.ref, id]);
    }
    for (const g of groups.values()) rows.push(g);
  }
  rows.forEach((r) => r.sort((a, b) => G.naturalCompare(a[0], b[0])));
  rows.sort(rowCompare);
  const bom = { both: rows, skipped, fields: fieldsById };
  for (const L of ['F', 'B']) {
    bom[L] = rows.map((r) => r.filter((x) => footprints[x[1]].layer === L)).filter((r) => r.length).sort(rowCompare);
  }

  const nets = [...model.nets].sort(G.naturalCompare);
  const pcbdata = {
    edges_bbox: { minx: G.round(ebb.minx), miny: G.round(ebb.miny), maxx: G.round(ebb.maxx), maxy: G.round(ebb.maxy) },
    edges: model.edges,
    drawings: { silkscreen: { F: model.silk.F, B: model.silk.B }, fabrication: { F: [], B: [] } },
    footprints,
        tracks: model.tracks,  // outer layer traces + vias + drill holes (selectable: click = net highlight)
    zones: model.zones,    // copper pours (hidden by default, can be enabled in settings)
    metadata: {
      title: opts.title || 'PCB',
      revision: opts.revision || '',
      company: opts.company || '',
      date: opts.date || new Date().toISOString().substring(0, 10),
    },
    bom,
    font_data: {},
    ibom_version: 'v2.11.0',
  };
  if (nets.length) pcbdata.nets = nets;
  // closed board outline(s) for painting the solder-mask area (even-odd: cutouts stay open)
  const fill = model.edges.filter((e) => e.svgpath && /Z|z/.test(e.svgpath) || (e.svgpath && e.svgpath.split('M').length === 2)).map((e) => e.svgpath).join(' ');
  if (fill) pcbdata.board_fill = fill;

  report.counts = {
    footprints: footprints.length,
    withPads: footprints.filter((f) => f.pads.length).length,
    bomRows: rows.length,
    bomParts: rows.reduce((a, r) => a + r.length, 0),
    dnp: skipped.length,
    top: footprints.filter((f) => f.layer === 'F').length,
    bottom: footprints.filter((f) => f.layer === 'B').length,
    nets: nets.length,
    vias: model.tracks.F.filter(isVia).filter((t) => t.width > (t.drillsize || 0) || !t.drillsize).length,
    holes: model.holes.length,
    innerLayers: (model.inner || []).map((l) => l.name),
  };
  return { pcbdata, report, fieldNames };
}

module.exports = { buildPcbData, padWorldPoints, rotateVector };
