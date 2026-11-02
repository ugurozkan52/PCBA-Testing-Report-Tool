'use strict';
// Intermediate board model shared by the IPC-2581 reader and the pcbdata builder.
// Coordinates: mm, Y down (iBOM convention).

const G = require('./geometry');

function newModel() {
  return {
    edges: [],
    silk: { F: [], B: [] },
    fab: { F: [], B: [] },
    tracks: { F: [], B: [] },
    inner: [], // [{ name, tracks, zones }] in stackup order
    zones: { F: [], B: [] },
    comps: {},
    freePads: { F: [], B: [] },
    holes: [],
    nets: new Set(),
    warnings: [],
    info: { componentAttrs: true, source: 'ipc2581' },
  };
}

function ensureComp(model, ref) {
  if (!model.comps[ref]) model.comps[ref] = { ref, pads: [], drawings: [] };
  return model.comps[ref];
}

// Merge TH pads that appear on both outer layers and attach drill info
function finalizePads(model) {
  const holeIndex = new Map();
  const key = (x, y) => Math.round(x * 20) + ',' + Math.round(y * 20);
  for (const h of model.holes) {
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const k = (Math.round(h.pos[0] * 20) + dx) + ',' + (Math.round(h.pos[1] * 20) + dy);
      if (!holeIndex.has(k)) holeIndex.set(k, h);
    }
  }
  const findHole = (p) => holeIndex.get(key(p[0], p[1]));

  function mergeList(pads) {
    const out = [];
    const byKey = new Map();
    for (const p of pads) {
      const k = (p._pin || '') + '@' + key(p.pos[0], p.pos[1]);
      const ex = byKey.get(k);
      if (ex && !ex.layers.includes(p.layers[0])) {
        ex.layers.push(p.layers[0]);
        // keep the larger shape for display
        if (p.size && ex.size && p.size[0] * p.size[1] > ex.size[0] * ex.size[1]) {
          const layers = ex.layers;
          Object.assign(ex, p, { layers });
        }
        continue;
      }
      byKey.set(k, p);
      out.push(p);
    }
    for (const p of out) {
      const h = findHole(p.pos);
      if (h) {
        p.type = 'th';
        if (h.slot) {
          const len = Math.hypot(h.slot[1][0] - h.slot[0][0], h.slot[1][1] - h.slot[0][1]) + h.d;
          const ang = (Math.atan2(h.slot[1][1] - h.slot[0][1], h.slot[1][0] - h.slot[0][0]) * 180) / Math.PI;
          p.drillshape = 'oblong';
          // drill size is in pad-local frame; pad angle rotates it
          const rel = -ang - (p.angle || 0);
          const horiz = Math.abs(Math.cos((rel * Math.PI) / 180)) > 0.7;
          p.drillsize = horiz ? [G.round(len), G.round(h.d)] : [G.round(h.d), G.round(len)];
        } else {
          p.drillshape = 'circle';
          p.drillsize = [G.round(h.d), G.round(h.d)];
        }
        if (p.layers.length === 1) p.layers = ['F', 'B'];
        h._used = true;
      }
    }
    return out;
  }
  for (const ref in model.comps) model.comps[ref].pads = mergeList(model.comps[ref].pads);
  model.freePads.F = mergeList(model.freePads.F.concat(model.freePads.B));
  model.freePads.B = [];
  // vias get drill size for untented display
  for (const side of ['F', 'B']) {
    for (const t of model.tracks[side]) {
      if (t.start && t.end && t.start[0] === t.end[0] && t.start[1] === t.end[1]) {
        const h = findHole(t.start);
        if (h) { t.drillsize = G.round(h.d); h._used = true; }
      }
    }
  }
  // Holes without pad or via (mounting holes, NPTH, vias without outer pads):
  // drawn as hole markers (zero length "via" whose ring equals the drill).
  const seen = new Set();
  for (const h of model.holes) {
    if (h._used) continue;
    const k = key(h.pos[0], h.pos[1]);
    if (seen.has(k)) continue;
    seen.add(k);
    const ring = h.via ? h.d * 1.8 : h.d;
    for (const side of ['F', 'B']) model.tracks[side].push({ start: h.pos, end: h.pos, width: G.round(ring), drillsize: G.round(h.d) });
  }
}

module.exports = { newModel, ensureComp, finalizePads };
