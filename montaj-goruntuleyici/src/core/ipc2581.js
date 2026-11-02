'use strict';
const { t } = require('../i18n/i18n');
// IPC-2581 (Rev. A/B/C) reader -> board model (same structure as gerberBoard)
// plus BOM lines. Coordinates converted to mm, Y down.

const G = require('./geometry');
const { parseXml, kids, kid, findAll, find } = require('./xml');
const { newModel, ensureComp, finalizePads } = require('./model');

const UNIT = { INCH: 25.4, MILLIMETER: 1, MM: 1, MICRON: 0.001, MILS: 0.0254, MIL: 0.0254 };
const num = (v, d = 0) => { const x = parseFloat(v); return isFinite(x) ? x : d; };
const fy = (p) => [G.round(p[0]), G.round(-p[1])];

// ---------------------------------------------------------------------------
function polyPoints(el, s) {
  // Polygon / Polyline: PolyBegin, PolyStepSegment, PolyStepCurve
  const pts = [];
  let cur = null;
  for (const c of el.children) {
    if (c.name === 'PolyBegin') { cur = [num(c.attrs.x) * s, num(c.attrs.y) * s]; pts.push(cur); }
    else if (c.name === 'PolyStepSegment') { cur = [num(c.attrs.x) * s, num(c.attrs.y) * s]; pts.push(cur); }
    else if (c.name === 'PolyStepCurve' && cur) {
      const x = num(c.attrs.x) * s, y = num(c.attrs.y) * s;
      const cx = num(c.attrs.centerX) * s, cy = num(c.attrs.centerY) * s;
      const cw = c.attrs.clockwise === 'true';
      pts.push(...G.arcPoints(cur[0], cur[1], x, y, cx, cy, cw, true));
      cur = [x, y];
    }
  }
  return pts;
}

function isClosed(pts) {
  if (pts.length < 3) return false;
  const a = pts[0], b = pts[pts.length - 1];
  return Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
}

class Ctx {
  constructor(root) {
    this.root = root;
    const content = find(root, 'Content');
    this.lineDesc = {};
    this.std = {};
    this.user = {};
    this.colors = {};
    for (const d of kids(content, 'DictionaryLineDesc')) {
      const s = UNIT[(d.attrs.units || 'MILLIMETER').toUpperCase()] || 1;
      for (const e of kids(d, 'EntryLineDesc')) {
        const ld = kid(e, 'LineDesc');
        if (ld) this.lineDesc[e.attrs.id] = num(ld.attrs.lineWidth) * s;
      }
    }
    for (const d of kids(content, 'DictionaryStandard')) {
      const s = UNIT[(d.attrs.units || 'MILLIMETER').toUpperCase()] || 1;
      for (const e of kids(d, 'EntryStandard')) {
        const prim = e.children.find((c) => c.name !== 'Xform');
        if (prim) this.std[e.attrs.id] = { el: prim, s };
      }
    }
    for (const d of kids(content, 'DictionaryUser')) {
      const s = UNIT[(d.attrs.units || 'MILLIMETER').toUpperCase()] || 1;
      for (const e of kids(d, 'EntryUser')) {
        const us = kid(e, 'UserSpecial') || e.children[0];
        if (us) this.user[e.attrs.id] = { el: us, s };
      }
    }
  }

  lineWidth(el, s) {
    const ld = kid(el, 'LineDesc');
    if (ld) return num(ld.attrs.lineWidth) * s;
    const ref = kid(el, 'LineDescRef');
    if (ref && this.lineDesc[ref.attrs.id] != null) return this.lineDesc[ref.attrs.id];
    return 0.1;
  }

  isFilled(el) {
    const fd = kid(el, 'FillDesc');
    if (fd) return fd.attrs.fillProperty !== 'HOLLOW';
    const ref = kid(el, 'FillDescRef');
    if (ref) return !/HOLLOW|NONE/i.test(ref.attrs.id) || true;
    return !kid(el, 'LineDesc') && !kid(el, 'LineDescRef');
  }

  // Standard primitive -> { kind, ...} in mm, centered at origin (Y up)
  primitive(el, s) {
    const a = el.attrs;
    const W = num(a.width) * s, H = num(a.height) * s;
    switch (el.name) {
      case 'Circle': { const d = num(a.diameter) * s; return { kind: 'circle', w: d, h: d, polys: [G.circlePoly(0, 0, d / 2)] }; }
      case 'RectCenter': return { kind: 'rect', w: W, h: H, polys: [G.rectPoly(W, H)] };
      case 'Oval': return { kind: 'oval', w: W, h: H, polys: [G.obroundPoly(W, H)] };
      case 'RectRound': {
        const r = num(a.radius) * s;
        const corners = [a.upperRight, a.upperLeft, a.lowerLeft, a.lowerRight].map((v) => v !== 'false');
        const all = corners.every(Boolean);
        return { kind: all ? 'roundrect' : 'custom', w: W, h: H, r, polys: [G.roundRectPoly(W, H, r, corners)] };
      }
      case 'RectCham': {
        const c = num(a.chamfer) * s;
        const corners = [a.upperRight, a.upperLeft, a.lowerLeft, a.lowerRight].map((v) => v !== 'false');
        return { kind: 'custom', w: W, h: H, polys: [G.chamferRectPoly(W, H, c, corners)] };
      }
      case 'RectCorner': {
        const x1 = num(a.lowerLeftX) * s, y1 = num(a.lowerLeftY) * s, x2 = num(a.upperRightX) * s, y2 = num(a.upperRightY) * s;
        return { kind: 'custom', w: x2 - x1, h: y2 - y1, polys: [[[x1, y1], [x2, y1], [x2, y2], [x1, y2]]] };
      }
      case 'Diamond': return { kind: 'custom', w: W, h: H, polys: [[[W / 2, 0], [0, H / 2], [-W / 2, 0], [0, -H / 2]]] };
      case 'Ellipse': {
        const p = []; for (let i = 0; i < 32; i++) { const t = (i / 32) * G.TAU; p.push([(W / 2) * Math.cos(t), (H / 2) * Math.sin(t)]); }
        return { kind: 'custom', w: W, h: H, polys: [p] };
      }
      case 'Octagon': {
        const c = num(a.chamfer) * s || Math.min(W, H) * 0.29;
        return { kind: 'custom', w: W, h: H, polys: [G.chamferRectPoly(W, H, c)] };
      }
      case 'Hexagon': { const l = num(a.length) * s; return { kind: 'custom', w: l, h: l, polys: [G.regularPoly(l, 6, 0)] }; }
      case 'Triangle': { const b = num(a.base) * s, h = num(a.height) * s; return { kind: 'custom', w: b, h, polys: [[[-b / 2, -h / 2], [b / 2, -h / 2], [0, h / 2]]] }; }
      case 'Donut':
      case 'Thermal':
      case 'Moire': {
        const d = num(a.outerDiameter || a.diameter) * s || W;
        return { kind: 'circle', w: d, h: d, polys: [G.circlePoly(0, 0, d / 2)] };
      }
      case 'Butterfly': { const d = num(a.diameter) * s || num(a.side) * s; return { kind: 'circle', w: d, h: d, polys: [G.circlePoly(0, 0, d / 2)] }; }
      case 'Contour': {
        const polys = [];
        const pg = kid(el, 'Polygon');
        if (pg) polys.push(G.ccw(polyPoints(pg, s)));
        for (const cut of kids(el, 'Cutout')) polys.push(G.ccw(polyPoints(cut, s)).reverse());
        const bb = G.emptyBBox(); polys.forEach((p) => G.bboxOfPoints(p, bb));
        return { kind: 'custom', w: bb.maxx - bb.minx, h: bb.maxy - bb.miny, polys };
      }
      default: return null;
    }
  }

  // UserSpecial -> list of items (local units mm, Y up)
  userItems(el, s) {
    const out = [];
    for (const c of el.children) this.shapeItems(c, s, out);
    return out;
  }

  // One shape element -> items appended to out (local coords)
  shapeItems(c, s, out) {
    switch (c.name) {
      case 'Line': {
        const a = c.attrs;
        out.push({ t: 'stroke', pts: [[num(a.startX) * s, num(a.startY) * s], [num(a.endX) * s, num(a.endY) * s]], w: this.lineWidth(c, s) });
        break;
      }
      case 'Arc': {
        const a = c.attrs;
        const p1 = [num(a.startX) * s, num(a.startY) * s];
        const pts = [p1, ...G.arcPoints(p1[0], p1[1], num(a.endX) * s, num(a.endY) * s, num(a.centerX) * s, num(a.centerY) * s, a.clockwise === 'true', true)];
        out.push({ t: 'stroke', pts, w: this.lineWidth(c, s) });
        break;
      }
      case 'Polyline': {
        out.push({ t: 'stroke', pts: polyPoints(c, s), w: this.lineWidth(c, s) });
        break;
      }
      case 'Polygon': {
        const pts = polyPoints(c, s);
        if (this.isFilled(c) && !kid(c, 'LineDesc') && !kid(c, 'LineDescRef')) out.push({ t: 'fill', polys: [G.ccw(pts)] });
        else out.push({ t: 'stroke', pts, w: this.lineWidth(c, s) });
        break;
      }
      case 'Contour': {
        const p = this.primitive(c, s);
        if (p) out.push({ t: 'fill', polys: p.polys });
        break;
      }
      case 'UserSpecial': out.push(...this.userItems(c, s)); break;
      case 'UserPrimitiveRef': {
        const u = this.user[c.attrs.id];
        if (u) out.push(...this.userItems(u.el, u.s));
        break;
      }
      case 'StandardPrimitiveRef': {
        const st = this.std[c.attrs.id];
        const p = st && this.primitive(st.el, st.s);
        if (p) out.push({ t: 'fill', polys: p.polys, prim: p });
        break;
      }
      default: {
        const p = this.primitive(c, s);
        if (p) out.push({ t: 'fill', polys: p.polys, prim: p });
      }
    }
  }
}

function xformOf(el, s) {
  const x = kid(el, 'Xform');
  const loc = kid(el, 'Location');
  return {
    dx: (loc ? num(loc.attrs.x) : 0) * s + (x ? num(x.attrs.xOffset) * s : 0),
    dy: (loc ? num(loc.attrs.y) : 0) * s + (x ? num(x.attrs.yOffset) * s : 0),
    rot: x ? num(x.attrs.rotation) : 0,
    mirror: x ? x.attrs.mirror === 'true' : false,
    scale: x ? num(x.attrs.scale, 1) : 1,
  };
}

function applyXf(p, xf) {
  let q = [p[0] * xf.scale, p[1] * xf.scale];
  if (xf.mirror) q = [-q[0], q[1]];
  if (xf.rot) q = G.rot(q, xf.rot);
  return [q[0] + xf.dx, q[1] + xf.dy];
}

function itemsToWorld(items, xf) {
  return items.map((it) => {
    if (it.t === 'stroke') return { t: 'stroke', w: it.w * xf.scale, pts: it.pts.map((p) => applyXf(p, xf)) };
    const polys = it.polys.map((p) => p.map((q) => applyXf(q, xf)));
    return { t: 'fill', polys: xf.mirror ? polys.map((p) => p.slice().reverse()) : polys, prim: it.prim };
  });
}

function strokeToSvg(pts) {
  let d = '';
  pts.forEach((p, i) => { const q = fy(p); d += (i ? 'L' : 'M') + q[0] + ' ' + q[1]; });
  return d;
}

function itemToDrawing(it) {
  if (it.t === 'stroke') {
    if (it.pts.length < 2) return null;
    if (it.pts.length === 2) return { type: 'segment', start: fy(it.pts[0]), end: fy(it.pts[1]), width: G.round(it.w) };
    return { type: 'segment', svgpath: strokeToSvg(it.pts), width: G.round(it.w), start: fy(it.pts[0]), end: fy(it.pts[it.pts.length - 1]) };
  }
  return { type: 'polygon', pos: [0, 0], angle: 0, polygons: it.polys.map((p) => p.map(fy)) };
}

function padFromPrim(prim, xf, side) {
  // prim local polygons, xf = pad transform (Location in world)
  const pad = { layers: [side], pos: fy([xf.dx, xf.dy]), angle: G.round(xf.rot || 0, 3), type: 'smd' };
  if (!xf.mirror && xf.scale === 1 && ['circle', 'rect', 'oval', 'roundrect'].includes(prim.kind)) {
    pad.shape = prim.kind;
    pad.size = [G.round(prim.w), G.round(prim.h)];
    if (prim.kind === 'roundrect') pad.radius = G.round(prim.r);
  } else {
    const loc = { dx: 0, dy: 0, rot: xf.rot, mirror: xf.mirror, scale: xf.scale };
    pad.shape = 'custom';
    pad.angle = 0;
    pad.polygons = prim.polys.map((p) => G.ccw(p.map((q) => { const w = applyXf(q, loc); return [G.round(w[0]), G.round(-w[1])]; })));
    const bb = G.emptyBBox(); pad.polygons.forEach((p) => G.bboxOfPoints(p, bb));
    pad.size = [G.round(bb.maxx - bb.minx), G.round(bb.maxy - bb.miny)];
  }
  return pad;
}

// ---------------------------------------------------------------------------
// Only these layers are used: Top / inner / Bottom copper (pads, vias, nets),
// Top / Bottom silkscreen (drawing) and drill layers (holes). Everything else
// (assembly, document/fab texts, mask, paste, dielectric...) is ignored.
function classifyLayer(L) {
  const f = (L.attrs.layerFunction || '').toUpperCase();
  const sideA = (L.attrs.side || '').toUpperCase();
  const side = sideA === 'TOP' ? 'F' : sideA === 'BOTTOM' ? 'B' : null;
  const name = L.attrs.name || '';
  if (['CONDUCTOR', 'SIGNAL', 'PLANE', 'MIXED', 'CONDFILM', 'CONDFOIL'].includes(f)) {
    if (side) return { role: 'copper', side };
    if (sideA === 'INTERNAL') return { role: 'copper', side: 'I', name };
    return { role: 'ignore' };
  }
  if (f === 'SILKSCREEN' || f === 'LEGEND') return side ? { role: 'silk', side } : { role: 'ignore' };
  if (f === 'DRILL') return { role: 'drill' };
  // Some CAD tools (e.g. Allegro) export silkscreen as DOCUMENT with a silk-like name
  if ((f === 'DOCUMENT' || f === 'GRAPHIC') && side && /silk|legend|overlay|^ss[_-]/i.test(name)) return { role: 'silk', side };
  return { role: 'ignore' };
}

function parseIpc2581(text, opts = {}) {
  const root = parseXml(text);
  const ctx = new Ctx(root);
  const model = newModel();
  const ecad = find(root, 'Ecad');
  const header = find(ecad, 'CadHeader');
  const S = UNIT[((header && header.attrs.units) || 'MILLIMETER').toUpperCase()] || 1;
  const cadData = find(ecad, 'CadData');
  const layers = {};
  for (const L of kids(cadData, 'Layer')) {
    const c = classifyLayer(L);
    layers[L.attrs.name] = c;
    if (c.role === 'copper' && c.side === 'I') {
      c.layerName = L.attrs.name;
      model.inner.push({ name: c.name, tracks: [], zones: [] });
    }
  }
  const innerOf = (name) => model.inner.find((x) => x.name === name);
  const steps = kids(cadData, 'Step');
  const step = steps[0];
  if (!step) throw new Error(t('IPC-2581 dosyasında Step bulunamadı'));
  if (steps.length > 1) model.warnings.push(t('Dosyada {n} Step var; ilki ({name}) kullanıldı.', { n: steps.length, name: step.attrs.name }));

  // Profile -> edges
  const profile = kid(step, 'Profile');
  if (profile) {
    for (const pg of findAll(profile, 'Polygon').concat(findAll(profile, 'Cutout'))) {
      const pts = polyPoints(pg, S);
      if (pts.length > 1) model.edges.push({ type: 'segment', svgpath: strokeToSvg(isClosed(pts) ? pts : pts.concat([pts[0]])), width: 0.1, start: fy(pts[0]), end: fy(pts[0]) });
    }
  }

  // Packages
  const packages = {};
  for (const P of kids(step, 'Package')) {
    const outline = kid(P, 'Outline');
    let outlinePts = null;
    if (outline) { const pg = kid(outline, 'Polygon'); if (pg) outlinePts = polyPoints(pg, S); }
    const pins = kids(P, 'Pin').map((pin) => ({ number: pin.attrs.number, xf: xformOf(pin, S), el: pin }));
    packages[P.attrs.name] = { outline: outlinePts, pins, pinOne: P.attrs.pinOne, el: P };
  }

  // Components
  const compInfo = {};
  for (const C of kids(step, 'Component')) {
    const ref = C.attrs.refDes;
    if (!ref) continue;
    const xf = xformOf(C, S);
    const layer = layers[C.attrs.layerRef];
    const side = (C.attrs.layerRef && /BOT/i.test(C.attrs.layerRef)) || (layer && layer.side === 'B') ? 'B' : 'F';
    const c = ensureComp(model, ref);
    c.center = fy([xf.dx, xf.dy]);
    c.rot = xf.rot;
    c.side = side;
    c.footprint = C.attrs.packageRef || '';
    c.part = C.attrs.part || '';
    const pk = packages[C.attrs.packageRef];
    if (pk && pk.outline && pk.outline.length >= 3) c.outline = pk.outline.map((p) => fy(applyXf(p, xf)));
    // body height (mm) for the 3D placeholder of parts without a STEP model
    const hgt = parseFloat(C.attrs.height || (pk && pk.el.attrs.height) || '');
    if (isFinite(hgt) && hgt > 0) c.height = G.round(hgt * S, 3);
    compInfo[ref] = { xf, pk, side };
  }

  // Layer features
  for (const LF of kids(step, 'LayerFeature')) {
    const lay = layers[LF.attrs.layerRef] || { role: 'ignore' };
    for (const set of kids(LF, 'Set')) {
      const net = set.attrs.net && !/^(No Net|N\/C|NONE)$/i.test(set.attrs.net) ? set.attrs.net : undefined;
      if (net && lay.role === 'copper') model.nets.add(net);
      if (lay.role === 'ignore') continue;
      if (lay.role === 'drill') {
        for (const h of kids(set, 'Hole')) {
          model.holes.push({ pos: fy([num(h.attrs.x) * S, num(h.attrs.y) * S]), d: num(h.attrs.diameter) * S, plated: h.attrs.platingStatus !== 'NONPLATED', via: h.attrs.platingStatus === 'VIA' });
        }
        continue;
      }
      const inner = lay.side === 'I' ? innerOf(lay.layerName) : null;

      // Pads
      for (const pad of kids(set, 'Pad')) {
        if (lay.role !== 'copper') continue;
        const xf = xformOf(pad, S);
        const items = [];
        for (const c of pad.children) if (['StandardPrimitiveRef', 'UserPrimitiveRef'].includes(c.name) || ctx.primitive(c, S)) ctx.shapeItems(c, S, items);
        const pinRef = kid(pad, 'PinRef');
        const isVia = /VIA/i.test(set.attrs.padUsage || '') || /VIA/i.test(set.attrs.geometry || '');
        let ipad;
        const fill = items.find((i) => i.prim) || items.find((i) => i.t === 'fill');
        if (fill && fill.prim) ipad = padFromPrim(fill.prim, xf, lay.side);
        else if (fill) {
          const polys = fill.polys;
          const bb = G.emptyBBox(); polys.forEach((p) => G.bboxOfPoints(p, bb));
          ipad = padFromPrim({ kind: 'custom', w: bb.maxx - bb.minx, h: bb.maxy - bb.miny, polys }, xf, lay.side);
        } else continue;
        if (net) ipad.net = net;
        if (inner) {
          // inner layers: pads/vias are drawn as copper shapes of that layer
          const pts = require('./builder').padWorldPoints(ipad);
          inner.zones.push(net ? { polygons: [pts], net } : { polygons: [pts] });
          continue;
        }
        if (isVia && !pinRef) {
          model.tracks[lay.side].push({ start: ipad.pos, end: ipad.pos, width: Math.max(...ipad.size), net });
          continue;
        }
        if (pinRef && pinRef.attrs.componentRef) {
          ipad._pin = pinRef.attrs.pin;
          ensureComp(model, pinRef.attrs.componentRef).pads.push(ipad);
        } else model.freePads[lay.side].push(ipad);
      }

      // Features
      for (const ft of kids(set, 'Features')) {
        const xf = xformOf(ft, S);
        const local = [];
        for (const c of ft.children) if (c.name !== 'Location' && c.name !== 'Xform') ctx.shapeItems(c, S, local);
        const items = itemsToWorld(local, xf);
        for (const it of items) {
          if (lay.role === 'copper') {
            if (it.t === 'stroke') {
              for (let i = 0; i + 1 < it.pts.length; i++) {
                const t = { start: fy(it.pts[i]), end: fy(it.pts[i + 1]), width: G.round(it.w) };
                if (net) t.net = net;
                (inner ? inner.tracks : model.tracks[lay.side]).push(t);
              }
            } else {
              const z = { polygons: it.polys.map((p) => p.map(fy)) };
              if (net) z.net = net;
              (inner ? inner.zones : model.zones[lay.side]).push(z);
            }
          } else if (lay.role === 'silk') {
            const d = itemToDrawing(it);
            // large filled silkscreen areas (component bodies, solid circles) hide the pads:
            // draw them as outlines instead
            if (d && d.type === 'polygon') {
              const area = d.polygons.reduce((a, p) => a + Math.abs(G.signedArea(p)), 0);
              if (area > 1) { d.filled = 0; d.width = 0.15; }
            }
            if (d) model.silk[lay.side].push(d);
          }
        }
      }
    }
  }

  // Components without pads from layer features: build from package pins
  for (const ref in compInfo) {
    const c = model.comps[ref];
    if (c.pads.length) continue;
    const { xf, pk, side } = compInfo[ref];
    if (!pk) continue;
    for (const pin of pk.pins) {
      const items = [];
      for (const ch of pin.el.children) if (['StandardPrimitiveRef', 'UserPrimitiveRef'].includes(ch.name)) ctx.shapeItems(ch, S, items);
      const fill = items.find((i) => i.prim);
      if (!fill) continue;
      const wpos = applyXf([pin.xf.dx, pin.xf.dy], xf);
      const pxf = { dx: wpos[0], dy: wpos[1], rot: xf.rot + pin.xf.rot, mirror: xf.mirror !== pin.xf.mirror, scale: 1 };
      const ipad = padFromPrim(fill.prim, pxf, side);
      ipad._pin = pin.number;
      c.pads.push(ipad);
    }
  }

  // Merge TH pads, drill info
  finalizePads(model);

  // BOM
  const bomEl = find(root, 'Bom');
  const bom = { lines: [], mapping: { fields: [] }, warnings: [] };
  if (bomEl) {
    const fieldOrder = ['Part'];
    const lines = [];
    for (const it of kids(bomEl, 'BomItem')) {
      const refs = kids(it, 'RefDes').filter((r) => r.attrs.populate !== 'false').map((r) => r.attrs.name).filter(Boolean);
      const dnp = kids(it, 'RefDes').filter((r) => r.attrs.populate === 'false').map((r) => r.attrs.name);
      if (dnp.length) bom.warnings.push(t('DNP (populate=false): {list}', { list: dnp.join(', ') }));
      if (!refs.length) continue;
      const fields = { Part: it.attrs.OEMDesignNumberRef || '' };
      if (it.attrs.description) { fields.Description = it.attrs.description; if (!fieldOrder.includes('Description')) fieldOrder.push('Description'); }
      for (const ch of findAll(it, 'Textual')) {
        const n = ch.attrs.textualCharacteristicName || ch.attrs.definitionSource;
        if (!n) continue;
        fields[n] = ch.attrs.textualCharacteristicValue || '';
        if (!fieldOrder.includes(n)) fieldOrder.push(n);
      }
      for (const ch of findAll(it, 'Measured')) {
        const n = ch.attrs.measuredCharacteristicName;
        if (!n) continue;
        fields[n] = (ch.attrs.measuredCharacteristicValue || '') + (ch.attrs.engineeringUnitOfMeasure ? ' ' + ch.attrs.engineeringUnitOfMeasure : '');
        if (!fieldOrder.includes(n)) fieldOrder.push(n);
      }
      lines.push({ refs: refs.sort(G.naturalCompare), fields });
    }
    // AVL (manufacturer part numbers)
    const avl = find(root, 'Avl');
    if (avl) {
      const mpn = {};
      // enterprise id -> name (LogisticHeader)
      const ent = {};
      for (const e of findAll(root, 'Enterprise')) if (e.attrs.id) ent[e.attrs.id] = e.attrs.name || e.attrs.id;
      const mfr = {};
      for (const ai of kids(avl, 'AvlItem')) {
        const m = find(ai, 'AvlMpn');
        if (m && m.attrs.name) mpn[ai.attrs.OEMDesignNumber] = m.attrs.name;
        const v = find(ai, 'AvlVendor');
        if (v && v.attrs.enterpriseRef) mfr[ai.attrs.OEMDesignNumber] = ent[v.attrs.enterpriseRef] || v.attrs.enterpriseRef;
      }
      if (Object.keys(mfr).length) {
        fieldOrder.push('Manufacturer');
        for (const l of lines) l.fields.Manufacturer = mfr[l.fields.Part] || '';
      }
      if (Object.keys(mpn).length) {
        fieldOrder.push('Manufacturer Part Number');
        for (const l of lines) l.fields['Manufacturer Part Number'] = mpn[l.fields.Part] || '';
      }
    }
    const pref = /^(part|value|comment|description|manufacturer|manufacturer part number|mpn|footprint|device_type|part_number)$/i;
    let shown = 0;
    bom.mapping.fields = fieldOrder.map((n) => { const show = (pref.test(n) || fieldOrder.length <= 5) && shown < 8; if (show) shown++; return { name: n, show }; });
    bom.lines = lines;
  }
  const bomHeader = find(root, 'BomHeader');
  const meta = { title: (bomHeader && bomHeader.attrs.assembly) || step.attrs.name || '', revision: (bomHeader && bomHeader.attrs.revision) || '' };
  model.warnings.push(...bom.warnings.slice(0, 5));
  return { model, bom, meta };
}

module.exports = { parseIpc2581 };
