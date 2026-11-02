// Montaj Görüntüleyici — v3.0 3D board view (three.js r147, STEP model).
// The model (model3d.bin) is produced from the STEP file at import time and
// is aligned to the board data: world (x, y, z) = board (x, -y), z up.
/* global THREE, asm, __asmInit, pcbdata, settings, highlightedFootprints, markedFootprints, footprintIndexToHandler,
   currentHighlightedRowId, smoothScrollToRow, readStorage, writeStorage, I18N, topmostdiv, asmToast, asmToggleMax,
   changeCanvasLayout, resizeAll, ASM_BOARD_COLORS, getPolygonsPath, deg2rad, drawPad */
'use strict';

var V3D = (function () {
  var T = function (s, v) { return I18N.t(s, v); };
  var S = {
    on: false, ready: false, loading: false, failed: false,
    renderer: null, scene: null, camera: null, controls: null, root: null,
    parts: [], byRef: new Map(), board: [], bbox: null, center: null, radius: 50,
    hlSet: new Set(), hlStart: 0, mode: 'all', anim: null, dirty: true, raf: 0,
  };
  var MAT = { cache: new Map(), hl: null, placedTint: new Map(), dim: new Map(), boardMat: null, hlMap: new Map(), hlList: [] };

  // --------------------------------------------------------------- DOM
  function el(id) { return document.getElementById(id); }
  function container() { return el('asm3d'); }

  function setOn(on, persist) {
    S.on = !!on;
    var cd = el('canvasdiv');
    cd.classList.toggle('asm-3d-on', S.on);
    container().hidden = !S.on;
    ['fl-btn', 'fb-btn', 'bl-btn'].forEach(function (id) { if (S.on) el(id).classList.remove('depressed'); });
    el('d3-btn').classList.toggle('depressed', S.on);
    el('d3-btn').setAttribute('aria-pressed', S.on ? 'true' : 'false');
    if (persist) writeStorage('view3d', S.on ? 'true' : 'false');
    var bot = el('bot');
    if (!S.on && bot.classList.contains('asm-max-asm3d')) asmToggleMax('asm3d');
    if (S.on) { ensureLoaded(); setTimeout(resize, 0); }
    else if (typeof changeCanvasLayout === 'function') changeCanvasLayout(settings.canvaslayout || 'FB');
  }

  function status(msg, kind) {
    var s = el('asm3d-status');
    s.textContent = msg || '';
    s.hidden = !msg;
    s.className = 'asm3d-status' + (kind ? ' ' + kind : '');
  }

  // ------------------------------------------------------------ loading
  function ensureLoaded() {
    if (S.ready || S.loading || S.failed) return;
    S.loading = true;
    status(T('3D model yükleniyor…'));
    asm.model3d().then(function (u8) {
      if (!u8) throw new Error(T('Bu projede 3D model yok.'));
      build(u8);
      S.ready = true; S.loading = false;
      status('');
      fit(true, 'iso');
      sync();
      if (S.probeData) setProbes(S.probeData, S.probeNets);
    }).catch(function (err) {
      S.loading = false; S.failed = true;
      status(T('3D görünüm açılamadı: {err}', { err: err && err.message || err }), 'err');
    });
  }

  function parse(u8) {
    var ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
    var dv = new DataView(ab);
    var hl = dv.getUint32(0, true);
    var head = JSON.parse(new TextDecoder('utf-8').decode(new Uint8Array(ab, 4, hl)));
    var o = 4 + hl; o += (4 - (o % 4)) % 4;
    var pos = new Float32Array(ab, o, head.nPos); o += head.nPos * 4;
    var nor = new Float32Array(ab, o, head.nNorm); o += head.nNorm * 4;
    var idx = new Uint32Array(ab, o, head.nIdx);
    return { head: head, pos: pos, nor: nor, idx: idx };
  }

  function colorKey(c) { return c ? c.map(function (v) { return Math.round(v * 255); }).join(',') : 'none'; }
  // STEP colours are sRGB; light greys are treated as metal (pins, leads, shields)
  function lin(hex) { return new THREE.Color(hex).convertSRGBToLinear(); }
  function baseMaterial(c) {
    var k = colorKey(c);
    if (!MAT.cache.has(k)) {
      var rgb = c || [0.62, 0.64, 0.66];
      var col = new THREE.Color(rgb[0], rgb[1], rgb[2]).convertSRGBToLinear();
      var hsl = {}; new THREE.Color(rgb[0], rgb[1], rgb[2]).getHSL(hsl);
      var metal = hsl.s < 0.15 && hsl.l > 0.55;
      var dark = hsl.l < 0.18;
      MAT.cache.set(k, new THREE.MeshStandardMaterial({
        color: col, metalness: metal ? 0.9 : 0.0, roughness: metal ? 0.32 : dark ? 0.55 : 0.45,
        envMapIntensity: metal ? 0.8 : 0.3,
      }));
    }
    return MAT.cache.get(k);
  }
  function variant(map, base, make) {
    if (!map.has(base)) map.set(base, make(base));
    return map.get(base);
  }
  function placedOf(base) {
    return variant(MAT.placedTint, base, function (b) {
      var m = b.clone(); m.emissive = lin('#2f9fd8'); m.emissiveIntensity = 0.35; return m;
    });
  }
  // selected: own colours + pulsing yellow glow (the part stays recognisable)
  function hlOf(base) {
    return variant(MAT.hlMap, base, function (b) {
      var m = b.clone(); m.emissive = MAT.hlColor.clone(); m.emissiveIntensity = 0.6; MAT.hlList.push(m); return m;
    });
  }
  function dimOf(base) {
    return variant(MAT.dim, base, function (b) {
      // keep the render readable: darker, not transparent
      var m = b.clone(); m.color = b.color.clone().multiplyScalar(0.42); m.envMapIntensity = (b.envMapIntensity || 1) * 0.45; return m;
    });
  }

  function build(u8) {
    var d = parse(u8);
    var cv = el('asm3d-canvas');
    S.renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: true, alpha: true, preserveDrawingBuffer: true });
    S.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    S.renderer.setClearColor(0x000000, 0);
    S.renderer.outputEncoding = THREE.sRGBEncoding;
    S.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    S.renderer.toneMappingExposure = 1.0;
    S.renderer.shadowMap.enabled = true;
    S.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    S.scene = new THREE.Scene();
    // image based lighting (generated locally, no files) gives metals and glossy mask a real look
    if (THREE.RoomEnvironment) {
      var pm = new THREE.PMREMGenerator(S.renderer);
      S.scene.environment = pm.fromScene(new THREE.RoomEnvironment(), 0.04).texture;
      pm.dispose();
    }
    S.camera = new THREE.PerspectiveCamera(32, 1, 0.1, 5000);
    S.camera.up.set(0, 0, 1);
    S.scene.add(new THREE.HemisphereLight(0xffffff, 0x3a4656, 0.35));
    var d1 = new THREE.DirectionalLight(0xfff6e8, 1.25); d1.position.set(-0.8, -1.2, 3); S.scene.add(d1);
    d1.castShadow = true;
    d1.shadow.mapSize.set(2048, 2048);
    d1.shadow.bias = -0.0004;
    d1.shadow.normalBias = 0.02;
    d1.shadow.radius = 3;
    S.scene.add(d1.target);
    S.key = d1;
    var d2 = new THREE.DirectionalLight(0xffffff, 0.35); d2.position.set(1.5, 1, -2.5); S.scene.add(d2);
    S.root = new THREE.Group();
    S.scene.add(S.root);

    var posAttr = new THREE.BufferAttribute(d.pos, 3);
    var norAttr = new THREE.BufferAttribute(d.nor, 3);
    MAT.hl = new THREE.MeshStandardMaterial({ color: lin('#ffd400'), emissive: lin('#ffd400'), emissiveIntensity: 0.6, metalness: 0, roughness: 0.4, toneMapped: false });
    MAT.hlColor = lin('#ffc400');
    var mk = { color: lin('#ffd400'), transparent: true, opacity: 1, toneMapped: false, side: THREE.DoubleSide, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 };
    MAT.ring = new THREE.MeshBasicMaterial(mk);
    MAT.ripple = new THREE.MeshBasicMaterial(Object.assign({}, mk));
    MAT.edge = new THREE.LineBasicMaterial({ color: lin('#ffd400'), transparent: true, opacity: 1, toneMapped: false });
    MAT.boardMat = new THREE.MeshStandardMaterial({ color: lin('#1d4a36'), metalness: 0.0, roughness: 0.5 });

    var refIndex = new Map();
    pcbdata.footprints.forEach(function (f, i) { refIndex.set(f.ref, i); });
    var all = new THREE.Box3();
    d.head.parts.forEach(function (p) {
      if (!p.iCount) return;
      var g = new THREE.BufferGeometry();
      g.setAttribute('position', posAttr);
      g.setAttribute('normal', norAttr);
      g.setIndex(new THREE.BufferAttribute(d.idx.subarray(p.iStart, p.iStart + p.iCount), 1));
      // bounds from this part's own vertex range (the attribute is shared)
      var bb = new THREE.Box3(), v = new THREE.Vector3();
      for (var k = p.vStart; k < p.vStart + p.vCount; k++) { v.fromArray(d.pos, k * 3); bb.expandByPoint(v); }
      g.boundingBox = bb;
      g.boundingSphere = bb.getBoundingSphere(new THREE.Sphere());
      var mats = [];
      p.groups.forEach(function (gr) {
        var m = p.kind === 'board' ? MAT.boardMat : baseMaterial(gr.color);
        var mi = mats.indexOf(m);
        if (mi < 0) { mats.push(m); mi = mats.length - 1; }
        g.addGroup(gr.start - p.iStart, gr.count, mi);
      });
      var mesh = new THREE.Mesh(g, mats.length === 1 ? mats[0] : mats);
      mesh.userData = { ref: p.ref, kind: p.kind, base: mesh.material, fp: p.ref != null ? refIndex.get(p.ref) : undefined };
      S.root.add(mesh);
      S.parts.push(mesh);
      if (p.kind === 'board') S.board.push(mesh);
      if (p.ref) { if (!S.byRef.has(p.ref)) S.byRef.set(p.ref, []); S.byRef.get(p.ref).push(mesh); }
      all.union(bb);
    });
    S.zTop = d.head.board ? d.head.board.zTop : 1.6;
    S.zBot = d.head.board ? d.head.board.zBot : 0;
    // copper / mask / silk bodies some exporters put in the STEP would fight with the board skin
    S.parts.forEach(function (m) {
      var b = m.geometry.boundingBox;
      if (m.userData.kind === 'board' || m.userData.ref) return;
      var thin = b.max.z - b.min.z < 0.12;
      if (thin && (Math.abs(b.min.z - S.zTop) < 0.2 || Math.abs(b.max.z - S.zBot) < 0.2)) { m.visible = false; m.userData.skinHidden = true; }
    });
    addPlaceholders(refIndex, all);
    buildSkins();
    S.markers = new THREE.Group();
    S.scene.add(S.markers);
    S.parts.forEach(function (m) { m.castShadow = m.userData.kind !== 'board'; m.receiveShadow = true; });
    S.bbox = all;
    S.center = all.getCenter(new THREE.Vector3());
    S.radius = Math.max(all.getSize(new THREE.Vector3()).length() / 2, 5);
    // key light shadow covers the whole board
    var kd = new THREE.Vector3(-0.35, -0.55, 1).normalize();
    S.key.position.copy(S.center).add(kd.multiplyScalar(S.radius * 3));
    S.key.target.position.copy(S.center);
    var sc = S.key.shadow.camera;
    sc.left = -S.radius * 1.1; sc.right = S.radius * 1.1; sc.top = S.radius * 1.1; sc.bottom = -S.radius * 1.1;
    sc.near = S.radius * 0.5; sc.far = S.radius * 6;
    sc.updateProjectionMatrix();
    S.camera.near = S.radius / 200; S.camera.far = S.radius * 40; S.camera.updateProjectionMatrix();

    S.controls = new THREE.OrbitControls(S.camera, cv);
    S.controls.enableDamping = true;
    S.controls.dampingFactor = 0.12;
    S.controls.screenSpacePanning = true;
    S.controls.minDistance = S.radius * 0.05;
    S.controls.maxDistance = S.radius * 8;
    S.controls.addEventListener('change', requestRender);
    S.controls.addEventListener('start', function () { S.anim = null; });
    applyTheme();
    applyBoardColor();
    initPicking(cv);
    if (window.ResizeObserver) new ResizeObserver(resize).observe(container());
    resize();
  }

  // ------------------------------------------------- placeholder bodies
  // Every BOM part must be visible in 3D: parts without a STEP body get a box
  // from their outline and the IPC-2581 height (or an estimate).
  function addPlaceholders(refIndex, all) {
    var skipped = new Set(pcbdata.bom.skipped || []);
    MAT.ph = new THREE.MeshStandardMaterial({ color: lin('#b9c4d2'), roughness: 0.6, metalness: 0, envMapIntensity: 0.6 });
    var edgeMat = new THREE.LineBasicMaterial({ color: 0x2b3646, transparent: true, opacity: 0.7 });
    S.placeholders = [];
    pcbdata.footprints.forEach(function (fp, i) {
      if (skipped.has(i) || S.byRef.has(fp.ref)) return;
      var b = fp.bbox;
      if (!b || !b.size || !(b.size[0] > 0) || !(b.size[1] > 0)) return;
      var w = b.size[0], l = b.size[1];
      var h = fp.height > 0 ? fp.height : Math.max(0.45, Math.min(3, Math.min(w, l) * 0.55));
      // outline corners in board coordinates → world (x, -y)
      var a = -(b.angle || 0) * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
      var shape = new THREE.Shape();
      [[0, 0], [w, 0], [w, l], [0, l]].forEach(function (q, k) {
        var u = b.relpos[0] + q[0], v = b.relpos[1] + q[1];
        var x = b.pos[0] + u * ca - v * sa, y = b.pos[1] + u * sa + v * ca;
        if (k === 0) shape.moveTo(x, -y); else shape.lineTo(x, -y);
      });
      var bottom = fp.layer === 'B';
      var g = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
      g.translate(0, 0, bottom ? S.zBot - h : S.zTop);
      g.computeBoundingBox();
      g.computeBoundingSphere();
      var mesh = new THREE.Mesh(g, MAT.ph);
      var edges = new THREE.LineSegments(new THREE.EdgesGeometry(g), edgeMat);
      edges.raycast = function () {};
      mesh.add(edges);
      mesh.userData = { ref: fp.ref, kind: 'comp', placeholder: true, base: MAT.ph, fp: i };
      S.root.add(mesh);
      S.parts.push(mesh);
      S.byRef.set(fp.ref, [mesh]);
      S.placeholders.push(fp.ref);
      all.union(g.boundingBox);
    });
  }

  // ------------------------------------------------------- board skin
  // Top / bottom faces are painted from the IPC-2581 data (like KiCad's 3D
  // viewer): solder mask, copper under mask, ENIG pads, silkscreen, drills.
  function boardColors() {
    var key = readStorage('boardColor') || 'green';
    var c = (typeof ASM_BOARD_COLORS !== 'undefined' && ASM_BOARD_COLORS.find(function (x) { return x.key === key; })) || { key: 'green', board: '#1d4a36', track: '#2f6e50', zone: '#275f45', silk: '#eef2ee' };
    return { key: c.key, mask: c.board, cu: c.track, zone: c.zone, silk: c.silk, pad: '#d5ad5b', side: c.board };
  }
  function paintSide(L, col, pxmm) {
    var bb = pcbdata.edges_bbox, m = 0.5;
    var w = bb.maxx - bb.minx + 2 * m, h = bb.maxy - bb.miny + 2 * m;
    var cv = document.createElement('canvas');
    cv.width = Math.max(2, Math.round(w * pxmm)); cv.height = Math.max(2, Math.round(h * pxmm));
    var ctx = cv.getContext('2d');
    ctx.setTransform(pxmm, 0, 0, pxmm, -(bb.minx - m) * pxmm, -(bb.miny - m) * pxmm);
    var sf = pxmm;
    ctx.save();
    if (pcbdata.board_fill) ctx.clip(new Path2D(pcbdata.board_fill), 'evenodd');
    else { ctx.beginPath(); ctx.rect(bb.minx, bb.miny, bb.maxx - bb.minx, bb.maxy - bb.miny); ctx.clip(); }
    ctx.fillStyle = col.mask; ctx.fillRect(bb.minx - m, bb.miny - m, w, h);
    // copper under the mask
    ctx.fillStyle = col.zone; ctx.strokeStyle = col.zone; ctx.lineJoin = 'round';
    (pcbdata.zones[L] || []).forEach(function (z) {
      try { var p = getPolygonsPath(z); ctx.fill(p, z.fillrule || 'nonzero'); if (z.width > 0) { ctx.lineWidth = z.width; ctx.stroke(p); } } catch (e) { /* skip */ }
    });
    ctx.strokeStyle = col.cu; ctx.fillStyle = col.cu; ctx.lineCap = 'round';
    (pcbdata.tracks[L] || []).forEach(function (t) {
      ctx.lineWidth = t.width; ctx.beginPath();
      if ('radius' in t) { ctx.arc(t.center[0], t.center[1], t.radius, deg2rad(t.startangle), deg2rad(t.endangle)); ctx.stroke(); }
      else if (t.start[0] === t.end[0] && t.start[1] === t.end[1]) { ctx.arc(t.start[0], t.start[1], t.width / 2, 0, 2 * Math.PI); ctx.fill(); }
      else { ctx.moveTo(t.start[0], t.start[1]); ctx.lineTo(t.end[0], t.end[1]); ctx.stroke(); }
    });
    // silkscreen (under the pads: mask openings clear the ink)
    (pcbdata.drawings.silkscreen[L] || []).forEach(function (dr) {
      if (dr.type === 'text') return;
      try { drawDrawing(ctx, sf, dr, col.silk); } catch (e) { /* skip */ }
    });
    // exposed pads (ENIG)
    pcbdata.footprints.forEach(function (fp) {
      fp.pads.forEach(function (pad) { if (pad.layers.indexOf(L) >= 0) { try { drawPad(ctx, pad, col.pad, false); } catch (e) { /* skip */ } } });
    });
    // drills go through
    ctx.globalCompositeOperation = 'destination-out';
    pcbdata.footprints.forEach(function (fp) { fp.pads.forEach(function (pad) { try { drawPadHole(ctx, pad, '#000'); } catch (e) { /* skip */ } }); });
    ['F', 'B'].forEach(function (S2) {
      (pcbdata.tracks[S2] || []).forEach(function (t) {
        if (t.drillsize && t.start[0] === t.end[0] && t.start[1] === t.end[1]) { ctx.beginPath(); ctx.arc(t.start[0], t.start[1], t.drillsize / 2, 0, 2 * Math.PI); ctx.fill(); }
      });
    });
    ctx.restore();
    // roughness (G) / metalness (B) map: glossy mask, matte ink, shiny metallic pads
    var mr = document.createElement('canvas');
    mr.width = cv.width; mr.height = cv.height;
    var mx = mr.getContext('2d');
    mx.setTransform(pxmm, 0, 0, pxmm, -(bb.minx - m) * pxmm, -(bb.miny - m) * pxmm);
    mx.fillStyle = 'rgb(0,82,0)'; mx.fillRect(bb.minx - m, bb.miny - m, w, h);           // mask: rough 0.32
    (pcbdata.drawings.silkscreen[L] || []).forEach(function (dr) {
      if (dr.type === 'text') return;
      try { drawDrawing(mx, sf, dr, 'rgb(0,215,0)'); } catch (e) { /* skip */ }        // ink: rough 0.85
    });
    pcbdata.footprints.forEach(function (fp) {
      fp.pads.forEach(function (pad) { if (pad.layers.indexOf(L) >= 0) { try { drawPad(mx, pad, 'rgb(0,64,255)', false); } catch (e) { /* skip */ } } });
    });                                                                                  // pads: metal, rough 0.25
    return { canvas: cv, mr: mr, x0: bb.minx - m, y0: bb.miny - m, w: w, h: h };
  }
  function skinMesh(pt, z, down) {
    // world = (x, -y); uv from board coordinates (canvas row 0 = v 1)
    var x0 = pt.x0, x1 = pt.x0 + pt.w, y0 = pt.y0, y1 = pt.y0 + pt.h;
    var pos = new Float32Array([x0, -y0, z, x1, -y0, z, x1, -y1, z, x0, -y1, z]);
    var uv = new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]);
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(down ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2]);
    g.computeVertexNormals();
    var tex = new THREE.CanvasTexture(pt.canvas);
    tex.encoding = THREE.sRGBEncoding;
    tex.anisotropy = S.renderer.capabilities.getMaxAnisotropy();
    var mrTex = new THREE.CanvasTexture(pt.mr);
    mrTex.anisotropy = tex.anisotropy;
    var mat = new THREE.MeshPhysicalMaterial({
      map: tex, roughnessMap: mrTex, metalnessMap: mrTex, roughness: 1, metalness: 1,
      clearcoat: 0.3, clearcoatRoughness: 0.25, envMapIntensity: 0.28, alphaTest: 0.5, transparent: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    var mesh = new THREE.Mesh(g, mat);
    mesh.receiveShadow = true;
    mesh.userData.mrTex = mrTex;
    return mesh;
  }
  function buildSkins() {
    if (S.skins) S.skins.forEach(function (m) { S.scene.remove(m); m.geometry.dispose(); m.material.map.dispose(); if (m.userData.mrTex) m.userData.mrTex.dispose(); m.material.dispose(); });
    S.skins = [];
    var bb = pcbdata.edges_bbox;
    var maxTex = Math.min(S.renderer.capabilities.maxTextureSize || 4096, 8192);
    var pxmm = Math.max(4, Math.min(24, maxTex / (Math.max(bb.maxx - bb.minx, bb.maxy - bb.miny) + 1)));
    var col = boardColors();
    var top = skinMesh(paintSide('F', col, pxmm), S.zTop + 0.004, false);
    var bot = skinMesh(paintSide('B', col, pxmm), S.zBot - 0.004, true);
    S.skins.push(top, bot);
    S.scene.add(top); S.scene.add(bot);
  }

  // ------------------------------------------------------------ view state
  function applyTheme() {
    if (!S.scene) return;
    requestRender();
  }
  function applyBoardColor() {
    if (!MAT.boardMat) return;
    var col = boardColors();
    MAT.boardMat.color = lin(col.mask).multiplyScalar(0.85);
    MAT.hl.color = lin(col.key === 'yellow' ? '#18e0ff' : '#ffd400');
    MAT.hl.emissive = MAT.hl.color.clone();
    MAT.hlBase = MAT.hl.color.clone();
    [MAT.ring, MAT.ripple, MAT.edge].forEach(function (m) { m.color = MAT.hl.color.clone(); });
    MAT.hlColor = lin(col.key === 'yellow' ? '#18c8ff' : '#ffc400');
    MAT.hlList.forEach(function (m) { m.emissive = MAT.hlColor.clone(); });
    if (S.skins) buildSkins();
    requestRender();
  }

  // Selection marker that never covers the part: a yellow frame on the board around
  // the footprint, a "radar" ripple spreading from it and a thin outline box.
  function fpFrame(fp, partBox) {
    var b = fp.bbox;
    if (!b || !b.size || !(b.size[0] > 0)) return null;
    var a = -(b.angle || 0) * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
    var c = [[0, 0], [b.size[0], 0], [b.size[0], b.size[1]], [0, b.size[1]]].map(function (q) {
      var u = b.relpos[0] + q[0], v = b.relpos[1] + q[1];
      return new THREE.Vector2(b.pos[0] + u * ca - v * sa, -(b.pos[1] + u * sa + v * ca));
    });
    var cx = (c[0].x + c[2].x) / 2, cy = (c[0].y + c[2].y) / 2;
    var ex = c[1].clone().sub(c[0]), ey = c[3].clone().sub(c[0]);
    var w = ex.length(), l = ey.length();
    var bottom = fp.layer === 'B';
    var hgt = partBox && !partBox.isEmpty() ? (bottom ? S.zBot - partBox.min.z : partBox.max.z - S.zTop) : (fp.height || 1);
    return { cx: cx, cy: cy, w: w, l: l, rot: Math.atan2(ex.y, ex.x), bottom: bottom, h: Math.max(0.3, hgt) };
  }
  function rectFrame(w, l, t) {
    var sh = new THREE.Shape();
    sh.moveTo(-w / 2, -l / 2); sh.lineTo(w / 2, -l / 2); sh.lineTo(w / 2, l / 2); sh.lineTo(-w / 2, l / 2); sh.lineTo(-w / 2, -l / 2);
    var iw = w / 2 - t, il = l / 2 - t, hole = new THREE.Path();
    hole.moveTo(-iw, -il); hole.lineTo(-iw, il); hole.lineTo(iw, il); hole.lineTo(iw, -il); hole.lineTo(-iw, -il);
    sh.holes.push(hole);
    return new THREE.ShapeGeometry(sh);
  }
  function updateMarkers() {
    if (!S.markers) return;
    while (S.markers.children.length) {
      var c = S.markers.children.pop();
      c.traverse(function (o) { if (o.geometry) o.geometry.dispose(); });
    }
    S.hlSet.forEach(function (r) {
      var fp = pcbdata.footprints.find(function (f) { return f.ref === r; });
      if (!fp) return;
      var pb = new THREE.Box3();
      (S.byRef.get(r) || []).forEach(function (m) { if (m.visible) pb.union(m.geometry.boundingBox); });
      var f = fpFrame(fp, pb);
      if (!f) return;
      var m = Math.max(0.35, Math.min(1.2, Math.min(f.w, f.l) * 0.25)); // gap between part and frame
      var t = Math.max(0.3, Math.min(0.9, Math.min(f.w, f.l) * 0.18));  // frame width
      var W = f.w + 2 * (m + t), L = f.l + 2 * (m + t);
      var g = new THREE.Group();
      g.position.set(f.cx, f.cy, f.bottom ? S.zBot - 0.03 : S.zTop + 0.03);
      g.rotation.z = f.rot;
      if (f.bottom) g.rotation.x = Math.PI;
      var ring = new THREE.Mesh(rectFrame(W, L, t), MAT.ring);
      ring.renderOrder = 4;
      var ripple = new THREE.Mesh(rectFrame(W, L, t * 0.7), MAT.ripple);
      ripple.renderOrder = 4;
      ripple.userData.ripple = true;
      var box = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(f.w + 2 * m, f.l + 2 * m, f.h + 0.2)), MAT.edge);
      box.position.z = (f.h + 0.2) / 2;
      box.renderOrder = 4;
      g.add(ring, ripple, box);
      S.markers.add(g);
    });
  }

  // ------------------------------------------------ multimeter probes (test mode)
  function labelSprite(text, bg) {
    var c = document.createElement('canvas'), x = c.getContext('2d');
    var font = '700 52px "DejaVu Sans", sans-serif';
    x.font = font;
    var w = Math.ceil(x.measureText(text).width) + 56;
    c.width = w; c.height = 96;
    x.font = font;
    x.fillStyle = bg; x.strokeStyle = '#ffffff'; x.lineWidth = 8;
    if (x.roundRect) { x.beginPath(); x.roundRect(6, 6, w - 12, 84, 22); x.fill(); x.stroke(); } else { x.fillRect(6, 6, w - 12, 84); }
    x.fillStyle = '#ffffff'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(text, w / 2, 52);
    var tex = new THREE.CanvasTexture(c); tex.encoding = THREE.sRGBEncoding;
    var sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, toneMapped: false }));
    sp.renderOrder = 10;
    sp.userData.aspect = w / 96;
    return sp;
  }
  function targetSprite(kind) {
    var c = document.createElement('canvas'), x = c.getContext('2d');
    c.width = c.height = 64;
    x.lineWidth = 9; x.strokeStyle = '#ffffff'; x.beginPath(); x.arc(32, 32, 22, 0, 2 * Math.PI); x.stroke();
    x.lineWidth = 5; x.strokeStyle = kind === 'pos' ? '#e5172f' : '#111111'; x.beginPath(); x.arc(32, 32, 22, 0, 2 * Math.PI); x.stroke();
    var tex = new THREE.CanvasTexture(c); tex.encoding = THREE.sRGBEncoding;
    var sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, toneMapped: false, sizeAttenuation: false }));
    sp.scale.set(0.03, 0.03, 1);
    sp.renderOrder = 11;
    return sp;
  }
  // callouts: HTML label + thin SVG leader line, re-projected every frame
  function setCallouts(list) {
    var c = container();
    var ov = el('asm3d-callouts');
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'asm3d-callouts'; ov.className = 'asm3d-callouts'; ov.setAttribute('aria-hidden', 'true');
      ov.innerHTML = '<svg class="asm3d-leaders"></svg>';
      c.insertBefore(ov, el('asm3d-tools'));
    }
    var svg = ov.querySelector('svg');
    Array.prototype.slice.call(ov.querySelectorAll('.asm3d-callout')).forEach(function (n) { n.remove(); });
    svg.innerHTML = '';
    S.callouts = (list || []).map(function (o) {
      var d = document.createElement('div');
      d.className = 'asm3d-callout asm3d-callout-' + o.kind;
      d.innerHTML = '<span class="asm3d-cico">' + (o.kind === 'pos' ? '+' : 'COM') + '</span><span class="asm3d-ctxt"></span>';
      d.querySelector('.asm3d-ctxt').textContent = o.text;
      ov.appendChild(d);
      var NS = 'http://www.w3.org/2000/svg';
      var halo = document.createElementNS(NS, 'line'), line = document.createElementNS(NS, 'line');
      halo.setAttribute('class', 'halo'); line.setAttribute('class', 'core');
      svg.appendChild(halo); svg.appendChild(line);
      return { p: o.p, kind: o.kind, el: d, lines: [halo, line] };
    });
    ov.hidden = !S.callouts.length;
  }
  function updateCallouts() {
    if (!S.callouts || !S.callouts.length) return;
    var c = container(), W = c.clientWidth, H = c.clientHeight;
    var sp = S.callouts.map(function (o) {
      var v = o.p.clone().project(S.camera);
      return { x: (v.x + 1) / 2 * W, y: (1 - v.y) / 2 * H, vis: v.z < 1 };
    });
    var mid = { x: 0, y: 0 };
    sp.forEach(function (q) { mid.x += q.x / sp.length; mid.y += q.y / sp.length; });
    S.callouts.forEach(function (o, i) {
      var q = sp[i];
      var dx = q.x - mid.x, dy = q.y - mid.y;
      if (Math.hypot(dx, dy) < 4) { dx = o.kind === 'pos' ? -1 : 1; dy = 0; }
      // sideways (away from the other probe) and slightly down: the probe handles lean upwards on screen
      var hx = dx >= 0 ? 1 : -1;
      dx = hx; dy = 0.35; var L = Math.hypot(dx, dy); dx /= L; dy /= L;
      var len = 92, ex = q.x + dx * len, ey = q.y + dy * len;
      if (ex < 120 || ex > W - 120) { dx = -dx; ex = q.x + dx * len; }
      ex = Math.max(16, Math.min(W - 16, ex)); ey = Math.max(16, Math.min(H - 16, ey));
      var left = ex < q.x;
      o.el.style.display = q.vis ? '' : 'none';
      o.el.classList.toggle('left', left);
      o.el.style.left = ex + 'px'; o.el.style.top = ey + 'px';
      // line from the edge of the target ring to the label anchor
      var lx = ex - q.x, ly = ey - q.y, ll = Math.hypot(lx, ly) || 1;
      o.lines.forEach(function (ln) {
        ln.setAttribute('x1', q.x + lx / ll * 9); ln.setAttribute('y1', q.y + ly / ll * 9);
        ln.setAttribute('x2', ex); ln.setAttribute('y2', ey);
        ln.style.display = q.vis ? '' : 'none';
      });
    });
  }
  function probeModel(color, k) {
    // built along +Y with the tip at the origin
    var g = new THREE.Group();
    var metal = new THREE.MeshStandardMaterial({ color: lin('#d8dde3'), metalness: 0.95, roughness: 0.22, envMapIntensity: 1 });
    var body = new THREE.MeshStandardMaterial({ color: lin(color), metalness: 0.05, roughness: 0.45, envMapIntensity: 0.5 });
    var tip = new THREE.ConeGeometry(0.32 * k, 1.8 * k, 20); tip.rotateZ(Math.PI); tip.translate(0, 0.9 * k, 0);
    var shaft = new THREE.CylinderGeometry(0.22 * k, 0.22 * k, 8 * k, 16); shaft.translate(0, 1.8 * k + 4 * k, 0);
    var guard = new THREE.CylinderGeometry(1.1 * k, 0.75 * k, 1.0 * k, 24); guard.translate(0, 9.8 * k + 0.5 * k, 0);
    var grip = new THREE.CylinderGeometry(0.8 * k, 0.95 * k, 15 * k, 24); grip.translate(0, 10.8 * k + 7.5 * k, 0);
    [[tip, metal], [shaft, metal], [guard, body], [grip, body]].forEach(function (q) {
      var m = new THREE.Mesh(q[0], q[1]); m.castShadow = true; m.raycast = function () {}; g.add(m);
    });
    return g;
  }
  // nets touched by the probes, painted over the board skin (both sides)
  function netOverlay(nets) {
    if (S.netOverlay) { S.netOverlay.forEach(function (m) { S.scene.remove(m); m.geometry.dispose(); m.material.map.dispose(); m.material.dispose(); }); S.netOverlay = null; }
    if (!nets || !nets.length || !S.skins || !S.skins.length) return;
    var bb = pcbdata.edges_bbox, mg = 0.5;
    var w = bb.maxx - bb.minx + 2 * mg, h = bb.maxy - bb.miny + 2 * mg;
    var maxTex = Math.min(S.renderer.capabilities.maxTextureSize || 4096, 8192);
    var pxmm = Math.max(4, Math.min(24, maxTex / (Math.max(bb.maxx - bb.minx, bb.maxy - bb.miny) + 1)));
    S.netOverlay = [];
    ['F', 'B'].forEach(function (L) {
      var cv = document.createElement('canvas');
      cv.width = Math.max(2, Math.round(w * pxmm)); cv.height = Math.max(2, Math.round(h * pxmm));
      var ctx = cv.getContext('2d');
      ctx.setTransform(pxmm, 0, 0, pxmm, -(bb.minx - mg) * pxmm, -(bb.miny - mg) * pxmm);
      var any = false;
      var NN = function (x) { return typeof TESTPLAN !== 'undefined' ? TESTPLAN.normNet(x) : x; };
      nets.forEach(function (n) {
        ctx.save(); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.globalAlpha = 0.5; ctx.fillStyle = n.color; ctx.strokeStyle = n.color;
        (pcbdata.zones[L] || []).forEach(function (z) { if (NN(z.net) === n.net) { any = true; try { var zp = getPolygonsPath(z); ctx.fill(zp, z.fillrule || 'nonzero'); ctx.globalAlpha = 1; ctx.lineWidth = 0.25; ctx.stroke(zp); ctx.globalAlpha = 0.5; } catch (e) { /* skip */ } } });
        ctx.globalAlpha = 1; ctx.strokeStyle = n.color;
        (pcbdata.tracks[L] || []).forEach(function (t) {
          if (NN(t.net) !== n.net) return;
          any = true;
          ctx.lineWidth = Math.max(t.width, 0.4); ctx.beginPath();
          if ('radius' in t) { ctx.arc(t.center[0], t.center[1], t.radius, deg2rad(t.startangle), deg2rad(t.endangle)); ctx.stroke(); }
          else if (t.start[0] === t.end[0] && t.start[1] === t.end[1]) { ctx.arc(t.start[0], t.start[1], t.width / 2, 0, 2 * Math.PI); ctx.fill(); }
          else { ctx.moveTo(t.start[0], t.start[1]); ctx.lineTo(t.end[0], t.end[1]); ctx.stroke(); }
        });
        pcbdata.footprints.forEach(function (fp) {
          fp.pads.forEach(function (pad) {
            if (NN(pad.net) !== n.net || pad.layers.indexOf(L) < 0) return;
            any = true;
            try { drawPad(ctx, pad, n.color, false); } catch (e) { /* skip */ }
            ctx.lineWidth = 0.35;
            ctx.beginPath(); ctx.arc(pad.pos[0], pad.pos[1], Math.max(pad.size[0], pad.size[1]) / 2 + 0.6, 0, 2 * Math.PI); ctx.stroke();
          });
        });
        ctx.restore();
      });
      if (!any) return;
      var pt = { canvas: cv, x0: bb.minx - mg, y0: bb.miny - mg, w: w, h: h };
      var z = L === 'F' ? S.zTop + 0.012 : S.zBot - 0.012;
      var x0 = pt.x0, x1 = pt.x0 + w, y0 = pt.y0, y1 = pt.y0 + h;
      var g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([x0, -y0, z, x1, -y0, z, x1, -y1, z, x0, -y1, z]), 3));
      g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]), 2));
      g.setIndex(L === 'B' ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2]);
      var tex = new THREE.CanvasTexture(cv); tex.encoding = THREE.sRGBEncoding; tex.anisotropy = S.renderer.capabilities.getMaxAnisotropy();
      var m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }));
      m.renderOrder = 3;
      S.scene.add(m);
      S.netOverlay.push(m);
      // faint x-ray copy: points hidden under part bodies still show through
      var xr = new THREE.Mesh(g.clone(), new THREE.MeshBasicMaterial({ map: tex.clone(), transparent: true, opacity: 0.5, toneMapped: false, depthWrite: false, depthTest: false }));
      xr.material.map.needsUpdate = true;
      xr.renderOrder = 6;
      S.scene.add(xr);
      S.netOverlay.push(xr);
    });
  }
  function setProbes(p, nets) {
    S.probeData = p || null;
    S.probeNets = nets || null;
    if (!S.ready) return;
    netOverlay(p ? nets : null);
    if (S.probes) { S.scene.remove(S.probes); S.probes.traverse(function (o) { if (o.geometry) o.geometry.dispose(); }); S.probes = null; }
    if (!p) { setCallouts(null); requestRender(); return; }
    var k = Math.max(0.55, Math.min(1.8, S.radius / 45));
    var grp = new THREE.Group();
    var pts = [], callouts = [];
    [['pos', '#d4182b', '+'], ['neg', '#1a1a1a', 'COM']].forEach(function (d) { var q = p[d[0]]; if (q) pts.push({ q: q, color: d[1], text: d[2] }); });
    var mid = new THREE.Vector2();
    pts.forEach(function (o) { mid.x += o.q.pos[0] / pts.length; mid.y += -o.q.pos[1] / pts.length; });
    pts.forEach(function (o, i) {
      var bottom = o.q.side === 'B' && !o.q.th;
      var x = o.q.pos[0], y = -o.q.pos[1], z = bottom ? S.zBot - 0.02 : S.zTop + 0.02;
      var holder = new THREE.Group();
      holder.position.set(x, y, z);
      var model = probeModel(o.color, k);
      model.rotation.x = bottom ? -Math.PI / 2 : Math.PI / 2;      // +Y → ±Z
      holder.add(model);
      // lean the handles away from each other so both stay visible
      var dir = new THREE.Vector2(x - mid.x, y - mid.y);
      if (dir.lengthSq() < 1e-6) dir.set(i ? 1 : -1, 0.4);
      dir.normalize();
      var axis = new THREE.Vector3(-dir.y, dir.x, 0).normalize();
      holder.quaternion.setFromAxisAngle(axis, (bottom ? -1 : 1) * 0.42);
      // pad ring
      var rg = new THREE.RingGeometry(0.9 * k, 1.35 * k, 40);
      var ring = new THREE.Mesh(rg, new THREE.MeshBasicMaterial({ color: lin(o.color === '#1a1a1a' ? '#ffffff' : o.color), side: THREE.DoubleSide, toneMapped: false, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 }));
      ring.position.set(x, y, z + (bottom ? -0.01 : 0.01));
      ring.renderOrder = 5;
      // small hollow target ring that stays in front (constant screen size) – the tip itself stays visible
      var tgt = targetSprite(o.text === '+' ? 'pos' : 'neg');
      tgt.position.set(x, y, z + (bottom ? -0.05 : 0.05));
      grp.add(holder, ring, tgt);
      callouts.push({ p: new THREE.Vector3(x, y, z), kind: o.text === '+' ? 'pos' : 'neg', text: o.q.ref + '.' + o.q.pin });
    });
    setCallouts(callouts);
    S.probes = grp;
    S.scene.add(grp);
    // frame both contact points with some context
    var b = new THREE.Box3();
    pts.forEach(function (o) { var zz = o.q.side === 'B' && !o.q.th ? S.zBot : S.zTop; b.expandByPoint(new THREE.Vector3(o.q.pos[0], -o.q.pos[1], zz)); });
    b.expandByScalar(14);
    var anyBottom = pts.some(function (o) { return o.q.side === 'B' && !o.q.th; });
    var allBottom = pts.every(function (o) { return o.q.side === 'B' && !o.q.th; });
    fit(false, allBottom ? 'bottom' : anyBottom ? null : 'iso', b);
    requestRender();
  }

  // apply selection / placed / display mode to all meshes
  function sync() {
    if (!S.ready) return;
    var hl = new Set((highlightedFootprints || []).map(function (i) { return pcbdata.footprints[i].ref; }));
    var changed = hl.size !== S.hlSet.size || Array.from(hl).some(function (r) { return !S.hlSet.has(r); });
    S.hlSet = hl;
    if (changed && hl.size) S.hlStart = performance.now();
    var placed = new Set();
    (markedFootprints || new Set()).forEach(function (i) { placed.add(pcbdata.footprints[i].ref); });
    var anySel = hl.size > 0;
    S.parts.forEach(function (m) {
      var u = m.userData;
      if (u.kind === 'board') return;
      var isH = u.ref && hl.has(u.ref), isP = u.ref && placed.has(u.ref);
      m.visible = !u.skinHidden && (S.mode === 'all' || isH || isP || !u.ref);
      if (S.mode === 'placed' && !u.ref) m.visible = false;
      var base = u.base, mats = Array.isArray(base) ? base : [base];
      var pick;
      if (isH) pick = hlOf;
      else if (anySel) pick = function (b) { return dimOf(isP ? placedOf(b) : b); };
      else if (isP) pick = placedOf;
      else pick = function (b) { return b; };
      var out = mats.map(pick);
      m.material = Array.isArray(base) ? out : out[0];
      m.renderOrder = isH ? 2 : anySel ? 1 : 0;
    });
    updateMarkers();
    updateLabel();
    requestRender();
  }

  function updateLabel() {
    var c = container();
    var refs = Array.from(S.hlSet);
    var sel = refs.length ? T('Seçili: {refs}', { refs: refs.slice(0, 12).join(', ') + (refs.length > 12 ? ' …' : '') }) : T('Seçim yok');
    var ph = new Set(S.placeholders || []);
    var miss = refs.filter(function (r) { return !S.byRef.has(r) || ph.has(r); });
    c.setAttribute('aria-label', T('3D kart görünümü') + '. ' + sel + '. ' + T('Ok tuşları döndürür, + / − yakınlaştırır, 0 sığdırır, Ü üst, A alt, İ izometrik, O seçime odaklanır.'));
    var note = el('asm3d-note');
    note.textContent = miss.length ? T('STEP modeli yok, kutu olarak gösteriliyor: {refs}', { refs: miss.slice(0, 8).join(', ') + (miss.length > 8 ? ' …' : '') }) : '';
    note.hidden = !miss.length;
  }

  // --------------------------------------------------------------- camera
  function selectionBox() {
    var b = new THREE.Box3();
    S.hlSet.forEach(function (r) { (S.byRef.get(r) || []).forEach(function (m) { b.union(m.geometry.boundingBox); }); });
    return b.isEmpty() ? null : b;
  }
  function fit(instant, view, box) {
    if (!S.ready) return;
    var b = box || S.bbox;
    var c = b.getCenter(new THREE.Vector3());
    var r = Math.max(b.getSize(new THREE.Vector3()).length() / 2, box ? 14 : 5);
    var dist = r / Math.sin((S.camera.fov * Math.PI / 180) / 2) * (box ? 1.5 : 1.05);
    var dir;
    if (view === 'top') dir = new THREE.Vector3(0, -0.0001, 1);
    else if (view === 'bottom') dir = new THREE.Vector3(0, -0.0001, -1);
    else if (view === 'iso') dir = new THREE.Vector3(0.55, -1, 1.1);
    else dir = S.camera.position.clone().sub(S.controls.target);
    dir.normalize();
    var to = { pos: c.clone().add(dir.multiplyScalar(dist)), target: c };
    if (instant) { S.camera.position.copy(to.pos); S.controls.target.copy(to.target); S.controls.update(); requestRender(); return; }
    S.anim = { t0: performance.now(), from: { pos: S.camera.position.clone(), target: S.controls.target.clone() }, to: to };
    requestRender();
  }
  function focusSelection() {
    var b = selectionBox();
    if (b) fit(false, null, b); else fit(false, null);
  }

  // ------------------------------------------------------------ render loop
  function requestRender() {
    S.dirty = true;
    if (!S.raf) S.raf = requestAnimationFrame(frame);
  }
  function blinkMode() { return topmostdiv.dataset.blink || 'short'; }
  function frame(now) {
    S.raf = 0;
    if (!S.ready || !S.on) return;
    var keep = false;
    if (S.anim) {
      var k = Math.min(1, (now - S.anim.t0) / 450), e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      S.camera.position.lerpVectors(S.anim.from.pos, S.anim.to.pos, e);
      S.controls.target.lerpVectors(S.anim.from.target, S.anim.to.target, e);
      if (k >= 1) S.anim = null; else keep = true;
    }
    if (S.controls.update()) keep = true;
    // selection blink (same modes as the 2D view; honours reduced motion)
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var mode = blinkMode(), w = 1;
    var tt = (now - S.hlStart) / 1000;
    if (S.hlSet.size && !reduce && mode !== 'off') {
      // part: same cadence as the 2D view (short = 4 pulses, on = continuous)
      var period = mode === 'short' ? 0.9 : 1.1;
      if (mode === 'on' || tt < period * 4) { w = 0.5 + 0.5 * Math.cos(2 * Math.PI * tt / period); keep = true; }
    }
    MAT.hlList.forEach(function (m) { m.emissiveIntensity = 0.12 + 0.5 * w; });
    // marker: frame + outline blink ~1 Hz (< 3 flashes/s), ripple spreads every 1.4 s.
    // "Kapalı" in the settings or reduced motion keeps everything steady.
    if (S.markers && S.markers.children.length) {
      var still = reduce || mode === 'off';
      var mw = still ? 1 : 0.5 + 0.5 * Math.cos(2 * Math.PI * tt / 1.0);
      var ph = still ? 0 : (tt % 1.4) / 1.4;
      MAT.ring.opacity = 0.55 + 0.45 * mw;
      MAT.edge.opacity = 0.35 + 0.65 * mw;
      MAT.ripple.opacity = still ? 0 : 0.85 * (1 - ph);
      S.markers.children.forEach(function (g) {
        g.children.forEach(function (o) { if (o.userData.ripple) { var k = 1 + 0.9 * ph; o.scale.set(k, k, 1); } });
      });
      if (!still) keep = true;
    }
    S.renderer.render(S.scene, S.camera);
    updateCallouts();
    S.dirty = false;
    if (keep) requestRender();
  }
  function resize() {
    if (!S.renderer) return;
    var c = container();
    var w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return;
    S.renderer.setSize(w, h, false);
    S.camera.aspect = w / h;
    S.camera.updateProjectionMatrix();
    requestRender();
  }

  // -------------------------------------------------------------- picking
  function initPicking(cv) {
    var ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), down = null;
    var tip = el('asm3d-tip');
    function hit(ev) {
      var r = cv.getBoundingClientRect();
      ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, S.camera);
      var list = S.parts.filter(function (m) { return m.visible && m.userData.kind !== 'board'; });
      var h = ray.intersectObjects(list, false);
      for (var i = 0; i < h.length; i++) if (h[i].object.userData.ref) return h[i].object.userData;
      return null;
    }
    cv.addEventListener('pointerdown', function (e) { down = [e.clientX, e.clientY]; });
    cv.addEventListener('pointerup', function (e) {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4 || e.button !== 0) { down = null; return; }
      down = null;
      var u = hit(e);
      if (u && u.fp !== undefined && footprintIndexToHandler[u.fp]) {
        footprintIndexToHandler[u.fp]();
        if (currentHighlightedRowId) smoothScrollToRow(currentHighlightedRowId);
      }
    });
    var last = 0;
    cv.addEventListener('pointermove', function (e) {
      if (e.buttons) { tip.hidden = true; return; }
      var now = performance.now();
      if (now - last < 60) return;
      last = now;
      var u = hit(e);
      cv.style.cursor = u ? 'pointer' : '';
      if (!u) { tip.hidden = true; return; }
      var f = pcbdata.bom.fields[u.fp] || [];
      var val = f.filter(function (x) { return x; })[0] || '';
      tip.textContent = u.ref + (val ? ' · ' + val : '');
      var r = container().getBoundingClientRect();
      tip.style.left = (e.clientX - r.left + 14) + 'px';
      tip.style.top = (e.clientY - r.top + 14) + 'px';
      tip.hidden = false;
    });
    cv.addEventListener('pointerleave', function () { tip.hidden = true; });
  }

  // ------------------------------------------------------------- keyboard
  function onKey(e) {
    if (!S.ready || e.altKey || e.ctrlKey || e.metaKey) return;
    var k = e.key, handled = true;
    var off = S.camera.position.clone().sub(S.controls.target);
    var rot = function (dTheta, dPhi) {
      // rotate around the z axis (azimuth) and tilt
      var q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), dTheta);
      off.applyQuaternion(q);
      var right = new THREE.Vector3().crossVectors(off, S.camera.up).normalize();
      var q2 = new THREE.Quaternion().setFromAxisAngle(right, dPhi);
      var n = off.clone().applyQuaternion(q2);
      if (Math.abs(n.clone().normalize().z) < 0.999) off = n;
      S.camera.position.copy(S.controls.target).add(off);
    };
    switch (k) {
      case 'ArrowLeft': rot(-0.15, 0); break;
      case 'ArrowRight': rot(0.15, 0); break;
      case 'ArrowUp': rot(0, 0.12); break;
      case 'ArrowDown': rot(0, -0.12); break;
      case '+': case '=': S.camera.position.copy(S.controls.target).add(off.multiplyScalar(0.8)); break;
      case '-': case '_': S.camera.position.copy(S.controls.target).add(off.multiplyScalar(1.25)); break;
      case '0': fit(false, 'iso'); break;
      case 'u': case 'U': case 'ü': case 'Ü': case 't': case 'T': fit(false, 'top'); break;
      case 'a': case 'A': case 'b': case 'B': fit(false, 'bottom'); break;
      case 'i': case 'I': case 'İ': fit(false, 'iso'); break;
      case 'o': case 'O': case 'f': case 'F': focusSelection(); break;
      default: handled = false;
    }
    if (handled) { e.preventDefault(); e.stopPropagation(); S.controls.update(); requestRender(); }
  }

  // ----------------------------------------------------------------- init
  function init() {
    if (!__asmInit || !__asmInit.has3d || typeof THREE === 'undefined') return;
    var btn = el('d3-btn');
    btn.hidden = false;
    el('bl-btn').classList.remove('right-most-button');
    el('bl-btn').classList.add('middle-button');
    btn.onclick = function () { setOn(true, true); };
    ['fl-btn', 'fb-btn', 'bl-btn'].forEach(function (id) {
      var b = el(id), orig = b.onclick;
      b.onclick = function (e) { if (S.on) setOn(false, true); return orig && orig.call(b, e); };
    });
    var c = container();
    c.addEventListener('keydown', onKey);
    el('asm3d-top').onclick = function () { fit(false, 'top'); };
    el('asm3d-bottom').onclick = function () { fit(false, 'bottom'); };
    el('asm3d-iso').onclick = function () { fit(false, 'iso'); };
    el('asm3d-focus').onclick = focusSelection;
    var modeSel = el('asm3d-mode');
    S.mode = readStorage('view3dMode') || 'all';
    modeSel.value = S.mode;
    modeSel.onchange = function () { S.mode = modeSel.value; writeStorage('view3dMode', S.mode); sync(); };
    ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'wheel', 'keydown'].forEach(function (ev) {
      el('asm3d-tools').addEventListener(ev, function (e) { e.stopPropagation(); });
    });
    if (readStorage('view3d') === 'true') setOn(true, false);
  }

  return {
    init: init, sync: sync, setOn: setOn, applyBoardColor: applyBoardColor, applyTheme: applyTheme, resize: resize,
    isOn: function () { return S.on; }, state: S, mat: MAT, setProbes: setProbes,
  };
})();
