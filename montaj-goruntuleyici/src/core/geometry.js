'use strict';
// Shared geometry helpers. All internal geometry is in millimetres.

const TAU = Math.PI * 2;

function rot(p, deg) {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a);
  return [p[0] * c - p[1] * s, p[0] * s + p[1] * c];
}

function signedArea(poly) {
  let a = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

// Make polygon winding counter-clockwise (in its own coordinate system).
// With non-zero fill, consistent winding makes overlapping primitives union.
function ccw(poly) {
  return signedArea(poly) < 0 ? poly.slice().reverse() : poly;
}

function circlePoly(cx, cy, r, n) {
  n = n || Math.max(12, Math.min(64, Math.ceil(r * 40)));
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return out;
}

// Points along an arc from (x1,y1) to (x2,y2) around (cx,cy); cw = clockwise
// in a y-up coordinate system. Excludes the start point, includes the end.
function arcPoints(x1, y1, x2, y2, cx, cy, cw, fullIfSame = true) {
  const r = Math.hypot(x1 - cx, y1 - cy);
  let a1 = Math.atan2(y1 - cy, x1 - cx);
  let a2 = Math.atan2(y2 - cy, x2 - cx);
  let sweep;
  if (cw) {
    sweep = a1 - a2;
    while (sweep < 0) sweep += TAU;
    if (sweep < 1e-9 && fullIfSame) sweep = TAU;
    sweep = -sweep;
  } else {
    sweep = a2 - a1;
    while (sweep < 0) sweep += TAU;
    if (sweep < 1e-9 && fullIfSame) sweep = TAU;
  }
  const segs = Math.max(2, Math.ceil(Math.abs(sweep) / (Math.PI / 24) * Math.max(1, Math.min(4, r))));
  const pts = [];
  for (let i = 1; i <= segs; i++) {
    const a = a1 + (sweep * i) / segs;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  pts[pts.length - 1] = [x2, y2];
  return pts;
}

// Rectangle centred at origin
function rectPoly(w, h) {
  const x = w / 2, y = h / 2;
  return [[-x, -y], [x, -y], [x, y], [-x, y]];
}

function obroundPoly(w, h) {
  const out = [];
  if (w >= h) {
    const r = h / 2, dx = w / 2 - r;
    for (let i = 0; i <= 12; i++) { const a = -Math.PI / 2 + (i / 12) * Math.PI; out.push([dx + r * Math.cos(a), r * Math.sin(a)]); }
    for (let i = 0; i <= 12; i++) { const a = Math.PI / 2 + (i / 12) * Math.PI; out.push([-dx + r * Math.cos(a), r * Math.sin(a)]); }
  } else {
    const r = w / 2, dy = h / 2 - r;
    for (let i = 0; i <= 12; i++) { const a = (i / 12) * Math.PI; out.push([r * Math.cos(a), dy + r * Math.sin(a)]); }
    for (let i = 0; i <= 12; i++) { const a = Math.PI + (i / 12) * Math.PI; out.push([r * Math.cos(a), -dy + r * Math.sin(a)]); }
  }
  return out;
}

function roundRectPoly(w, h, r, corners) {
  // corners: [ur, ul, ll, lr] booleans (default all rounded)
  corners = corners || [true, true, true, true];
  r = Math.min(r, w / 2, h / 2);
  const x = w / 2, y = h / 2, out = [];
  const cs = [[x - r, y - r, 0], [-x + r, y - r, 90], [-x + r, -y + r, 180], [x - r, -y + r, 270]];
  const sharp = [[x, y], [-x, y], [-x, -y], [x, -y]];
  cs.forEach((c, i) => {
    if (!corners[i] || r <= 0) { out.push(sharp[i]); return; }
    for (let k = 0; k <= 6; k++) {
      const a = ((c[2] + (k / 6) * 90) * Math.PI) / 180;
      out.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]);
    }
  });
  return out;
}

function chamferRectPoly(w, h, c, corners) {
  corners = corners || [true, true, true, true];
  const x = w / 2, y = h / 2, out = [];
  const pts = [
    [[x, y - c], [x - c, y]],
    [[-x + c, y], [-x, y - c]],
    [[-x, -y + c], [-x + c, -y]],
    [[x - c, -y], [x, -y + c]],
  ];
  const sharp = [[x, y], [-x, y], [-x, -y], [x, -y]];
  for (let i = 0; i < 4; i++) {
    if (corners[i] && c > 0) out.push(...pts[i]); else out.push(sharp[i]);
  }
  return out;
}

function regularPoly(dia, n, rotDeg) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = ((rotDeg || 0) * Math.PI) / 180 + (i / n) * TAU;
    out.push([(dia / 2) * Math.cos(a), (dia / 2) * Math.sin(a)]);
  }
  return out;
}

// Thick line (capsule) polygon from p to q with given width; round ends.
function capsulePoly(p, q, w) {
  const dx = q[0] - p[0], dy = q[1] - p[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return circlePoly(p[0], p[1], w / 2);
  const ang = Math.atan2(dy, dx);
  const r = w / 2, out = [];
  for (let i = 0; i <= 8; i++) { const a = ang - Math.PI / 2 + (i / 8) * Math.PI; out.push([q[0] + r * Math.cos(a), q[1] + r * Math.sin(a)]); }
  for (let i = 0; i <= 8; i++) { const a = ang + Math.PI / 2 + (i / 8) * Math.PI; out.push([p[0] + r * Math.cos(a), p[1] + r * Math.sin(a)]); }
  return out;
}

function bboxOfPoints(pts, bb) {
  bb = bb || { minx: Infinity, miny: Infinity, maxx: -Infinity, maxy: -Infinity };
  for (const p of pts) {
    if (p[0] < bb.minx) bb.minx = p[0];
    if (p[1] < bb.miny) bb.miny = p[1];
    if (p[0] > bb.maxx) bb.maxx = p[0];
    if (p[1] > bb.maxy) bb.maxy = p[1];
  }
  return bb;
}

function emptyBBox() { return { minx: Infinity, miny: Infinity, maxx: -Infinity, maxy: -Infinity }; }
function bboxValid(bb) { return bb && isFinite(bb.minx) && isFinite(bb.maxx); }

function median(arr) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function round(v, d = 4) {
  const f = Math.pow(10, d);
  return Math.round(v * f) / f;
}

// Natural sort key compare for designators like R2 < R10
function naturalCompare(a, b) {
  const ax = String(a).match(/(\d+|\D+)/g) || [];
  const bx = String(b).match(/(\d+|\D+)/g) || [];
  for (let i = 0; i < Math.min(ax.length, bx.length); i++) {
    const x = ax[i], y = bx[i];
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) { const d = parseInt(x, 10) - parseInt(y, 10); if (d) return d; }
    else { const d = x.localeCompare(y, 'tr', { sensitivity: 'base' }); if (d) return d; }
  }
  return ax.length - bx.length;
}

module.exports = {
  TAU, rot, signedArea, ccw, circlePoly, arcPoints, rectPoly, obroundPoly, roundRectPoly,
  chamferRectPoly, regularPoly, capsulePoly, bboxOfPoints, emptyBBox, bboxValid, median, round,
  naturalCompare,
};
