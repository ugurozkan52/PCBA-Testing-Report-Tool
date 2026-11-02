// Core regression tests (no Electron needed): node test/run_tests.js test/data
const path = require('path');
const assert = require('assert');
const { runImport } = require('../src/core/importer');
const fs = require('fs');
const D = process.argv[2] || path.join(__dirname, 'data');
const ipc = path.join(D, 'ipc', 'testcase3.xml');

// IPC-2581 alone (embedded BOM)
let r = runImport({ ipcFile: ipc, meta: {} });
assert.strictEqual(r.report.bomSource, 'ipc');
assert.strictEqual(r.report.counts.footprints, 42);
assert.strictEqual(r.report.counts.withPads, 42);
assert.strictEqual(r.report.counts.bomRows, 25);

// IPC-2581 + external BOM (R13 left out -> DNP)
r = runImport({ ipcFile: ipc, bom: { path: path.join(D, 'ipc', 'BOM.csv') }, meta: { title: 'T' } });
assert.strictEqual(r.report.bomSource, 'external');
assert.ok(r.report.dnp.includes('R13'));
assert.ok(r.fieldNames.includes('Manufacturer Part Number'));
console.log('OK', JSON.stringify(r.report.counts));

// Turkish characters: windows-1254 encoded IPC-2581, XLSX and windows-1254 CSV BOMs
r = runImport({ ipcFile: path.join(D, 'ipc', 'testcase3_tr1254.xml'), meta: {} });
assert.strictEqual(r.pcbdata.metadata.title, 'Güç Kartı Şasi');
assert.ok(JSON.stringify(r.pcbdata.bom.fields).includes('Kondansatör ğüşıöç İĞÜŞÖÇ'));
for (const f of ['BOM_tr.xlsx', 'BOM_tr_1254.csv']) {
  r = runImport({ ipcFile: ipc, bom: { path: path.join(D, 'ipc', f) }, meta: { title: 'Türkçe ĞÜŞİÖÇ ğüşıöç' } });
  assert.ok(r.fieldNames.includes('Üretici Parça No'), f + ' header');
  const all = JSON.stringify(r.pcbdata.bom.fields);
  assert.ok(all.includes('Direnç 10kΩ') || f.endsWith('.csv') && all.includes('Direnç 10k'), f + ' values');
  assert.ok(all.includes('RC0603-ŞÜÖ') && all.includes('GRM-ÇĞİ'), f + ' turkish');
  // every character of generated texts must exist in the stroke font
  const font = r.pcbdata.font_data;
  for (const d of r.pcbdata.drawings.fabrication.F.concat(r.pcbdata.drawings.fabrication.B)) if (d.text) for (const ch of d.text) assert.ok(font[ch], 'font missing ' + ch);
}
console.log('OK turkish');

// ------------------------------------------------------------ STEP / 3D (v3.0)
(async () => {
  const S = require('../src/core/step3d');
  const occt = await require('occt-import-js')();
  const pcb = runImport({ ipcFile: ipc, meta: {} }).pcbdata;
  const raw = occt.ReadStepFile(fs.readFileSync(path.join(D, 'step', 'testcase3.step')), S.TRI_PARAMS);
  // names: plain, suffixed, unnamed (position)
  let m = S.buildModel(raw, pcb);
  assert.strictEqual(m.meta.counts.bodies, 43);
  assert.strictEqual(m.meta.counts.components, 42);
  assert.strictEqual(m.meta.counts.byName, 28);
  assert.strictEqual(m.meta.counts.byPlace, 14);
  assert.strictEqual(m.meta.counts.unmatched, 0);
  assert.ok(m.meta.board && Math.abs(m.meta.board.zTop - 1.6) < 1e-6);
  for (const p of m.meta.parts) {
    const mm = p.name.match(/^Body_(\d+)$/);
    if (mm) assert.strictEqual(p.ref, pcb.footprints[+mm[1]].ref, 'spatial match ' + p.name);
  }
  // a STEP exported with another origin is aligned back onto the board
  const shifted = JSON.parse(JSON.stringify({ root: raw.root, meshes: raw.meshes.map((x) => ({ name: x.name, color: x.color, brep_faces: x.brep_faces, index: { array: Array.from(x.index.array) }, attributes: { position: { array: Array.from(x.attributes.position.array) } } })) }));
  for (const x of shifted.meshes) { const a = x.attributes.position.array; for (let i = 0; i < a.length; i += 3) { a[i] += 37.5; a[i + 1] -= 12.25; } }
  m = S.buildModel(shifted, pcb);
  assert.ok(Math.abs(m.meta.align.dx + 37.5) < 1e-6 && Math.abs(m.meta.align.dy + 12.25) < 1e-6, 'alignment ' + JSON.stringify(m.meta.align));
  assert.strictEqual(m.meta.counts.byPlace, 14, 'spatial matching after alignment');
  assert.ok(m.normals.some((v) => v !== 0), 'normals computed when missing');
  // packing round trip
  const buf = S.packModel(m);
  const head = S.readHeader(buf);
  assert.strictEqual(head.nIdx, m.indices.length);
  // single-part export gives a clear warning
  const single = { root: { name: '', meshes: [0], children: [] }, meshes: [raw.meshes[0]] };
  assert.ok(S.buildModel(single, pcb).meta.warnings.some((w) => /Single Part/.test(w)));
  // designator name forms
  const nm = S.makeNameMatcher(['C1', 'C12', 'U3']);
  assert.deepStrictEqual(['C12_Board', 'c1', 'C12-1', 'C1 (CAP)', 'U3:1', 'XC1'].map(nm), ['C12', 'C1', 'C12', 'C1', 'U3', null]);
  console.log('OK step3d');
})().catch((e) => { console.error(e); process.exit(1); });

// ------------------------------------------------------- hardware test plan (v6.0)
{
  const TP = require('../src/core/testplan');
  const r = runImport({ ipcFile: ipc, bom: { path: path.join(D, 'ipc', 'BOM.csv') }, meta: {} });
  const plan = TP.buildTestPlan(r.pcbdata, { fieldNames: r.fieldNames });
  const steps = plan.phases[0].steps;
  assert.strictEqual(steps[0].id, 'prep');
  assert.deepStrictEqual(plan.grounds.map((g) => g.net), ['GND2', 'GND', 'GND1', 'VSS']);
  assert.strictEqual(steps.filter((s) => s.kind === 'continuity').length, 4);
  assert.strictEqual(steps.filter((s) => s.kind === 'isolation').length, 6);
  const gnd = steps.find((s) => s.id === 'cont:GND');
  assert.strictEqual(gnd.probes.pos.ref, 'J1', 'connector pin preferred as probe point');
  assert.notStrictEqual(gnd.probes.neg.fp, gnd.probes.pos.fp, 'continuity uses two different parts');
  for (const s of steps) if (s.probes) for (const p of [s.probes.pos, s.probes.neg]) assert.ok(!r.pcbdata.bom.skipped.includes(p.fp), 'no DNP probe point');
  assert.strictEqual(steps.find((s) => s.id === 'iso:GND2|GND1').expect.type, 'manual', 'IC between nets → technician decides');
  assert.strictEqual(steps.find((s) => s.id === 'iso:GND2|GND').expect.type, 'open');
  // values and verdicts
  assert.deepStrictEqual(['10k', '4k7', '0R', '1M5', 'OL', '0,3', '2.2 kΩ'].map((x) => TP.parseOhms(x)), [10000, 4700, 0, 1500000, Infinity, 0.3, 2200]);
  assert.strictEqual(TP.parseOhms('12', 'kΩ'), 12000);
  assert.strictEqual(TP.evaluate(gnd, 2.1, 0.2), 'pass');
  assert.strictEqual(TP.evaluate(gnd, 2.5, 0.2), 'fail');
  assert.strictEqual(TP.evaluate({ expect: { type: 'open', min: 1e6 } }, Infinity), 'pass');
  assert.strictEqual(TP.evaluate({ expect: { type: 'open', min: 1e6 } }, 12), 'fail');
  assert.strictEqual(TP.evaluate({ expect: { type: 'manual' } }, 12), null);
  assert.deepStrictEqual(['CHASSIS', '/CHASIS', 'GND_ISO', 'AGND', '+3V3', '28V_IN', 'SDA'].map(TP.classifyNet), ['chassis', 'chassis', 'ground', 'ground', 'power', 'power', null]);
  // bridging parts set the expectation
  const pad = (net, x) => ({ layers: ['F'], pos: [x, 0], size: [1, 1], type: 'smd', net, pin: '1' });
  const mk = (ref, a, b, x) => ({ ref, pads: [pad(a, x), pad(b, x + 2)] });
  const isoOf = (pcb) => TP.buildTestPlan(pcb, { fieldNames: ['Value'] }).phases[0].steps.find((s) => s.kind === 'isolation');
  // connectors on one net each; an optional part joins GND and CHASSIS
  const base = (bridge, val) => {
    const p = { footprints: [{ ref: 'J1', pads: [pad('GND', 0), pad('GND', 2)] }, { ref: 'J2', pads: [pad('CHASSIS', 10), pad('CHASSIS', 12)] }, { ref: 'J3', pads: [pad('GND', 30)] }], bom: { skipped: [], fields: {} } };
    if (bridge) { p.footprints.push(mk(bridge, 'GND', 'CHASSIS', 20)); p.bom.fields[3] = [val]; }
    return p;
  };
  assert.strictEqual(isoOf(base()).expect.type, 'open');
  const rr = isoOf(base('R100', '1M'));
  assert.ok(rr.expect.type === 'res' && Math.abs(rr.expect.nominal - 1e6) < 1, 'resistor between GND and chassis');
  assert.strictEqual(isoOf(base('FB1', '600R@100MHz')).expect.type, 'short');
  assert.strictEqual(isoOf(base('C9', '10nF')).expect.type, 'open');
  assert.strictEqual(isoOf(base('R5', '0R')).expect.type, 'short');
  assert.strictEqual(steps.length, plan.phases[0].steps.length);
  console.log('OK testplan');
}

// ------------------------------------------------ later test phases (v7.0, synthetic board)
{
  const TP = require('../src/core/testplan');
  let x = 0;
  const pad = (net, pin, th) => ({ layers: th ? ['F', 'B'] : ['F'], pos: [x += 3, 0], size: [1.5, 1.5], type: th ? 'th' : 'smd', net, pin: String(pin) });
  const fp = (ref, nets, th) => ({ ref, pads: nets.map((n, i) => pad(n, i + 1, th)) });
  const fps = [
    fp('J1', ['28V_IN', 'RTN_IN', 'CHASSIS'], true),                     // power input connector
    fp('C1', ['28V_IN', 'RTN_IN']), fp('U1', ['28V_IN', '+12V', 'GND', '+5V0', 'RTN_IN']),
    fp('C2', ['+12V', 'GND']), fp('C3', ['+5V0', 'GND']), fp('U2', ['+5V0', '+3V3', 'GND']), fp('C4', ['+3V3', 'GND']),
    fp('U3', ['+3V3', 'GND', 'I2C_SDA', 'I2C_SCL', 'UART1_TX', 'UART1_RX', 'TEMP_SENS', 'VREF_2V5', 'DI_1']),
    fp('R1', ['I2C_SDA', '+3V3']), fp('R2', ['I2C_SCL', '+3V3']), fp('R3', ['VREF_2V5', 'GND']),
    fp('U4', ['+5V0', 'GND', 'CAN_H', 'CAN_L', 'RS422_TX_P', 'RS422_TX_N']),
    fp('J2', ['CAN_H', 'CAN_L', 'RS422_TX_P', 'RS422_TX_N', 'UART1_TX', 'UART1_RX', 'GND', 'DI_1', 'CHASSIS', 'TEMP_SENS'], true),
    fp('RT1', ['TEMP_SENS', 'GND']), fp('TP1', ['+3V3']), fp('TP2', ['GND']), fp('MH1', ['CHASSIS'], true), fp('C9', ['CHASSIS', 'GND']),
  ];
  const pcb = { footprints: fps, bom: { skipped: [], fields: {} } };
  fps.forEach((f, i) => { pcb.bom.fields[i] = [{ R1: '4k7', R2: '4k7', R3: '10k', C9: '10nF' }[f.ref] || '']; });
  const plan = TP.buildTestPlan(pcb, { fieldNames: ['Value'] });
  const ph = Object.fromEntries(plan.phases.map((p) => [p.id, p]));
  assert.deepStrictEqual(plan.phases.map((p) => p.id), ['gnd', 'pwr', 'volt', 'comm', 'sens', 'io']);
  assert.ok(!ph.gnd.powered && !ph.pwr.powered && ph.volt.powered && ph.comm.powered);
  // rails: input first, then by voltage; nominal from the name
  assert.deepStrictEqual(plan.rails.map((r) => [r.net, r.nominal, r.input]), [['28V_IN', 28, true], ['+12V', 12, false], ['+5V0', 5, false], ['+3V3', 3.3, false]]);
  assert.strictEqual(plan.rails[0].ref, 'RTN_IN', '28V_IN returns through RTN_IN');
  assert.strictEqual(plan.rails[3].ref, 'GND');
  const step = (id) => plan.phases.flatMap((p) => p.steps).find((s) => s.id === id);
  assert.strictEqual(step('pwr:28V_IN|RTN_IN').expect.type, 'min');
  assert.strictEqual(step('pwr:+3V3|CHASSIS').expect.type, 'open');
  // power-up step shows where the supply goes
  const on = step('volt-on');
  assert.ok(on.probes.pos.ref === 'J1' && on.probes.pos.net === '28V_IN' && on.probes.neg.net === 'RTN_IN', 'supply on the input connector');
  const v33 = step('volt:+3V3');
  assert.strictEqual(v33.probes.pos.ref, 'TP1', 'test point preferred');
  assert.ok(Math.abs(v33.expect.min - 3.135) < 1e-9 && Math.abs(v33.expect.max - 3.465) < 1e-9);
  assert.strictEqual(TP.evaluate(v33, 3.29), 'pass');
  assert.strictEqual(TP.evaluate(v33, 3.0), 'fail');
  const v28 = step('volt:28V_IN');
  assert.ok(Math.abs(v28.expect.min - 25.2) < 1e-9, 'input rail ±10 %');
  // communication
  assert.strictEqual(step('comm:I2C_SDA').expect.type, 'range', 'I2C pulled up to +3V3');
  assert.ok(Math.abs(step('comm:I2C_SDA').expect.nominal - 3.3) < 1e-9);
  assert.strictEqual(step('comm:UART1_TX').expect.type, 'manual', 'UART without pull-up: technician records');
  const can = step('commdiff:CAN_H|CAN_L');
  assert.ok(can && can.expect.type === 'range' && TP.evaluate(can, 0.01) === 'pass' && TP.evaluate(can, 2) === 'fail');
  assert.ok(step('comm:CAN_H') && step('comm:CAN_L'), 'CAN common mode per line');
  const rs = step('commdiff:RS422_TX_P|RS422_TX_N');
  assert.ok(rs && rs.expect.type === 'absmin' && rs.expect.min === 1.5 && TP.evaluate(rs, -2.1) === 'pass' && TP.evaluate(rs, 0.3) === 'fail');
  // sensors and I/O
  assert.ok(step('sens:TEMP_SENS') && step('sens:TEMP_SENS').expect.type === 'manual');
  assert.ok(Math.abs(step('sens:VREF_2V5').expect.nominal - 2.5) < 1e-9);
  assert.ok(step('io:DI_1'), 'connector line → I/O phase');
  assert.ok(!plan.phases.flatMap((p) => p.steps).some((s) => s.id === 'io:I2C_SDA'), 'a line is tested in one phase only');
  // settings: nominal override, exclusion, disabled phase
  const p2 = TP.buildTestPlan(pcb, { fieldNames: ['Value'], config: { voltTol: 2, rails: { '+12V': { include: false }, '+5V0': { nominal: 5.2 } }, phases: { io: false } } });
  const s2 = (id) => p2.phases.flatMap((p) => p.steps).find((s) => s.id === id);
  assert.ok(!s2('volt:+12V') && p2.rails.find((r) => r.net === '+12V').include === false);
  assert.ok(Math.abs(s2('volt:+5V0').expect.min - 5.2 * 0.98) < 1e-9);
  assert.ok(!p2.phases.some((p) => p.id === 'io'));
  // values
  assert.deepStrictEqual(['3.29', '3,3', '3V3', '-11.9', '330m'].map((v) => TP.parseVolts(v)), [3.29, 3.3, 3.3, -11.9, 0.33]);
  assert.deepStrictEqual(['28V_IN', '+5V0', '3V3', '3.3V', '-12V', 'VCC', '1V8_IO'].map(TP.railVolts), [28, 5, 3.3, 3.3, -12, null, 1.8]);
  console.log('OK testplan phases');
}
