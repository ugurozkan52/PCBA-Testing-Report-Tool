// Montaj Görüntüleyici — hardware test procedure generator (v6.0, "Test & Assembly").
// Builds a step-by-step bring-up procedure from the board data:
//   phase "gnd": instrument preparation, continuity of every ground / chassis net,
//                isolation (short circuit check) between every pair of ground nets.
// Each step names the two pads the multimeter probes touch (red "+", black "COM")
// and the expected reading; bridging components between nets set the expectation.
// Works in the renderer (window.TESTPLAN) and in Node (module.exports).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TESTPLAN = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEF = { shortMax: 2, openMin: 1e6, resTol: 0.1, resAbs: 0.5 };
  // later phases (editable in "Test ayarları", stored per project)
  var CFG = { voltTol: 5, inputTol: 10, railMinOhm: 10, currentLimit: '0.5 A', ioMax: 40, rails: {},
    phases: { pwr: true, volt: true, comm: true, sens: true, io: true } };

  // ------------------------------------------------------------ net classes
  function normNet(n) { return String(n || '').replace(/^\//, '').trim(); }
  var RX_CHASSIS = /(CHAS+IS|CHASIS|ŞASE|SASE|EARTH|SHIELD|SHLD|FRAME|^PE$|^CGND|^FGND|^CHS$|^SGND_CH)/i;
  var RX_GROUND = /(^|[^A-Z0-9])(GND|GROUND|VSS|0V|AGND|DGND|PGND|SGND|GNDA|GNDD|GNDPWR|RTN|RETURN)([^A-Z]|$)|^GND/i;
  var RX_POWER = /^(\+|-)?\d+V\d*|^V(CC|DD|EE|BAT|IN|BUS|SYS|HI|LO|REF|DDIO|CCIO|DDA)|^(\+|-)?\d+V\d*_|3V3|1V8|2V5|1V2|5V0|12V|24V|28V/i;
  function classifyNet(name) {
    var n = normNet(name);
    if (!n) return null;
    if (RX_CHASSIS.test(n)) return 'chassis';
    if (RX_GROUND.test(n)) return 'ground';
    if (/REF/i.test(n)) return null;              // references are measured as sensor lines, not rails
    if (RX_POWER.test(n)) return 'power';
    return null;
  }

  // human-readable reason for a classification (shown in "Test ayarları")
  function whyNet(name, T) {
    T = T || function (s, v) { return String(s).replace(/\{(\w+)\}/g, function (m, k) { return v && v[k] != null ? v[k] : m; }); };
    var n = normNet(name), m;
    if (!n) return '';
    if ((m = n.match(RX_CHASSIS))) return T('Şase: adda "{w}" geçiyor', { w: m[0] });
    if ((m = n.match(RX_GROUND))) return T('Toprak: adda "{w}" geçiyor', { w: m[2] || 'GND' });
    if (/REF/i.test(n)) return T('Referans (REF): sensör adımında ölçülür, ray değil');
    if (RX_POWER.test(n)) {
      var v = railVolts(n);
      var s = v != null ? T('Güç rayı: addaki "{w}" → {v}', { w: (n.match(/\d+[.,]\d+\s*V|\d+V\d*/i) || [''])[0], v: fmtVolts(v) })
        : T('Güç rayı: {w} adı, gerilim adda yok → nominali girin', { w: (n.match(/V(CC|DD|EE|BAT|IN|BUS|SYS|HI|LO|DDIO|CCIO|DDA)/i) || [n])[0] });
      if (isInputName(n)) s += T('; adda IN/BUS/RAW… var → giriş rayı');
      return s;
    }
    return '';
  }

  // ------------------------------------------------------------- probe pads
  var CONN = /^(J|P|X|CN|CON|XS|XP|JP)\d/i;
  function refPrefix(r) { var m = String(r).match(/^[A-Za-z_]+/); return m ? m[0].toUpperCase() : ''; }
  function padsByNet(pcb) {
    var skipped = new Set(pcb.bom && pcb.bom.skipped || []);
    var map = new Map();
    pcb.footprints.forEach(function (fp, fi) {
      if (skipped.has(fi)) return;                     // DNP parts are not on the board
      var n = fp.pads.length;
      var minPitch = Infinity;
      if (n > 3) {
        for (var a = 0; a < Math.min(n, 60); a++) for (var b = a + 1; b < Math.min(n, 60); b++) {
          var d = Math.hypot(fp.pads[a].pos[0] - fp.pads[b].pos[0], fp.pads[a].pos[1] - fp.pads[b].pos[1]);
          if (d > 0 && d < minPitch) minPitch = d;
        }
      }
      fp.pads.forEach(function (p, pi) {
        var net = normNet(p.net);
        if (!net) return;
        var info = {
          fp: fi, pad: pi, ref: fp.ref, pin: p.pin != null ? String(p.pin) : String(pi + 1), net: net,
          pos: p.pos, layers: p.layers || [], type: p.type, size: p.size || [0, 0], pins: n, pitch: minPitch,
        };
        info.score = probeScore(info);
        if (!map.has(net)) map.set(net, []);
        map.get(net).push(info);
      });
    });
    return map;
  }
  function probeScore(p) {
    var pre = refPrefix(p.ref), s = 0;
    if (pre === 'TP' || pre === 'TEST') s += 100;
    else if (CONN.test(p.ref)) s += 60;
    else if (pre === 'MH' || pre === 'H' || pre === 'MTG') s += 50;
    else if (p.pins <= 3 && /^(R|C|L|FB|D|F)$/.test(pre)) s += 25;
    if (p.type === 'th') s += 30;
    var dmin = Math.min(p.size[0], p.size[1]);
    s += Math.min(20, dmin * 12);
    if (dmin < 0.45) s -= 35;
    if (p.pitch < 0.8) s -= 40;                        // fine pitch IC legs: hard to probe
    if (p.layers.indexOf('F') >= 0) s += 10;           // reachable from the top
    return s;
  }
  function bestPad(list, exclude, far) {
    var best = null, bs = -Infinity;
    list.forEach(function (p) {
      if (exclude && exclude.fp === p.fp) return;
      var s = p.score;
      if (far) s += Math.min(40, Math.hypot(p.pos[0] - far.pos[0], p.pos[1] - far.pos[1]) * 0.8);
      if (s > bs) { bs = s; best = p; }
    });
    return best;
  }
  function nearPad(list, ref, exclude) {
    var best = null, bs = -Infinity;
    (list || []).forEach(function (p) {
      if (exclude && exclude.fp === p.fp && exclude.pad === p.pad) return;
      var s = p.score - (ref ? Math.hypot(p.pos[0] - ref.pos[0], p.pos[1] - ref.pos[1]) * 1.2 : 0);
      if (s > bs) { bs = s; best = p; }
    });
    return best;
  }
  function probe(p) {
    if (!p) return null;
    return { fp: p.fp, pad: p.pad, ref: p.ref, pin: p.pin, net: p.net, pos: p.pos.slice(), side: p.layers.indexOf('F') >= 0 ? 'F' : 'B', th: p.type === 'th' };
  }

  // ------------------------------------------------------------ values
  var MULT = { p: 1e-12, n: 1e-9, u: 1e-6, 'µ': 1e-6, m: 1e-3, r: 1, R: 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9 };
  // "10k", "4k7", "0R", "1M5", "100", "0.47R", "10 kΩ", "OL"
  function parseOhms(text, unit) {
    var s = String(text == null ? '' : text).trim().replace(',', '.').replace(/\s+/g, '').replace(/Ω|ohm(s)?/ig, '');
    if (!s) return null;
    if (/^(OL|O\.L\.?|AÇIK|ACIK|OPEN|∞|INF)$/i.test(s)) return Infinity;
    var m = s.match(/^(\d*\.?\d+)([pnuµmrRkKMG]?)(\d*)$/);
    if (!m) return null;
    var v = parseFloat(m[1]);
    if (m[2]) { v *= MULT[m[2]]; if (m[3]) v += parseFloat('0.' + m[3]) * MULT[m[2]]; }
    else if (unit) v *= ({ 'Ω': 1, 'kΩ': 1e3, 'MΩ': 1e6 })[unit] || 1;
    return v;
  }
  function fmtOhms(v) {
    if (v == null || isNaN(v)) return '—';
    if (v === Infinity) return 'OL';
    if (v >= 1e6) return +(v / 1e6).toPrecision(3) + ' MΩ';
    if (v >= 1e3) return +(v / 1e3).toPrecision(3) + ' kΩ';
    return +v.toPrecision(3) + ' Ω';
  }

  // "3.29", "3,3", "3V3", "-11.9", "330m", "330 mV"
  function parseVolts(text, unit) {
    var s = String(text == null ? '' : text).trim().replace(',', '.').replace(/\s+/g, '');
    if (!s) return null;
    var m = s.match(/^([+-]?)(\d+)V(\d+)$/i);
    if (m) return (m[1] === '-' ? -1 : 1) * parseFloat(m[2] + '.' + m[3]);
    m = s.match(/^([+-]?\d*\.?\d+)(m|k)?V?$/i);
    if (!m) return null;
    var v = parseFloat(m[1]);
    if (m[2]) v *= m[2].toLowerCase() === 'm' ? 1e-3 : 1e3;
    else if (unit === 'mV') v *= 1e-3;
    return v;
  }
  function fmtVolts(v) {
    if (v == null || isNaN(v)) return '—';
    if (Math.abs(v) < 1 && v !== 0) return +(v * 1e3).toPrecision(3) + ' mV';
    return (+v.toFixed(Math.abs(v) >= 10 ? 2 : 3)) + ' V';
  }
  function fmtValue(v, unit) { return unit === 'V' ? fmtVolts(v) : unit === 'mA' ? (v == null ? '—' : +v.toPrecision(3) + ' mA') : fmtOhms(v); }
  function parseValue(text, unit) {
    if (unit === 'V' || unit === 'mV') return parseVolts(text, unit);
    if (unit === 'mA' || unit === 'A') { var a = parseFloat(String(text || '').replace(',', '.')); return isNaN(a) ? null : (unit === 'A' ? a * 1e3 : a); }
    return parseOhms(text, unit);
  }

  // rail voltage from the net name: 28V_IN → 28, +5V0 → 5, 3V3 → 3.3, 3.3V → 3.3, -12V / N12V → -12
  function railVolts(name) {
    var n = normNet(name).toUpperCase();
    var neg = /^-|^N(?=\d)|^M(?=\d)|NEG|MINUS/.test(n);
    var m = n.match(/(\d+)\.(\d+)\s*V/) || n.match(/(\d+)V(\d+)?/);
    if (!m) return null;
    var v = parseFloat(m[1] + (m[2] ? '.' + m[2] : ''));
    if (!(v > 0) || v > 1000) return null;
    return neg ? -v : v;
  }
  function isInputName(n) { return /(^|[^A-Z])(IN|INPUT|RAW|BUS|BAT|BATT|SUPPLY|EXT|VIN|PWR_IN)([^A-Z]|$)/i.test(normNet(n)); }

  // ------------------------------------------- what connects two nets (DC)
  function bridges(pcb, a, b, valueOf) {
    var out = [];
    var skipped = new Set(pcb.bom && pcb.bom.skipped || []);
    pcb.footprints.forEach(function (fp, fi) {
      if (skipped.has(fi)) return;
      var na = false, nb = false;
      fp.pads.forEach(function (p) { var n = normNet(p.net); if (n === a) na = true; if (n === b) nb = true; });
      if (!na || !nb) return;
      var pre = refPrefix(fp.ref), val = valueOf(fi) || '', kind;
      var ohm = parseOhms(val.replace(/[^\d.,pnuµmrRkKMG]/g, '') || '');
      if (pre === 'R' || pre === 'RN') kind = ohm != null && ohm <= 1 ? 'short' : ohm != null ? 'res' : 'unknown';
      else if (/^(L|FB|F|JP|NT|SJ|W|E|BEAD)$/.test(pre) || /net[_ ]?tie/i.test(val)) kind = 'short';
      else if (pre === 'C') kind = 'cap';
      else kind = 'active';
      out.push({ ref: fp.ref, value: val, kind: kind, ohms: kind === 'res' ? ohm : kind === 'short' ? 0 : null });
    });
    return out;
  }
  function expectation(br, cfg) {
    if (br.some(function (x) { return x.kind === 'short'; })) return { type: 'short', max: cfg.shortMax };
    var rs = br.filter(function (x) { return x.kind === 'res'; });
    if (br.some(function (x) { return x.kind === 'active' || x.kind === 'unknown'; })) return { type: 'manual', nominal: rs.length ? 1 / rs.reduce(function (s, x) { return s + 1 / x.ohms; }, 0) : null };
    if (rs.length) {
      var r = 1 / rs.reduce(function (s, x) { return s + 1 / x.ohms; }, 0);
      return { type: 'res', nominal: r, min: r * (1 - cfg.resTol) - cfg.resAbs, max: r * (1 + cfg.resTol) + cfg.resAbs };
    }
    return { type: 'open', min: cfg.openMin };
  }
  function expectText(e, T) {
    if (e.type === 'min') return T('> {v} (kısa devre yok; kondansatörler şarj oldukça değer yükselir)', { v: fmtOhms(e.min) });
    if (e.type === 'range') return T('≈ {v} ({a} … {b})', { v: fmtVolts(e.nominal), a: fmtVolts(e.min), b: fmtVolts(e.max) });
    if (e.type === 'absmin') return T('|V| ≥ {v}', { v: fmtVolts(e.min) });
    if (e.type === 'record') return T('Değeri kaydedin (isteğe bağlı)');
    if (e.type === 'manual' && e.unit === 'V') return e.hint ? T(e.hint) : T('Gerilimi kaydedin ve beklenen değerle karşılaştırın');
    if (e.type === 'short') return T('< {v} (süreklilik / bip)', { v: fmtOhms(e.max) });
    if (e.type === 'open') return T('> {v} veya OL (açık devre)', { v: fmtOhms(e.min) });
    if (e.type === 'res') return T('≈ {v} ({a} … {b})', { v: fmtOhms(e.nominal), a: fmtOhms(Math.max(0, e.min)), b: fmtOhms(e.max) });
    return T('Değeri kaydedin ve referans kartla karşılaştırın');
  }
  function evaluate(step, value, offset) {
    if (!step || !step.expect || value == null || isNaN(value)) return null;
    var e = step.expect;
    if (step.unit === 'V') {
      if (e.type === 'range') return value >= e.min && value <= e.max ? 'pass' : 'fail';
      if (e.type === 'absmin') return Math.abs(value) >= e.min ? 'pass' : 'fail';
      return null;
    }
    if (e.type === 'record') return 'pass';
    var v = value === Infinity ? Infinity : Math.max(0, value - (offset || 0));
    if (e.type === 'min') return v >= e.min ? 'pass' : 'fail';
    if (e.type === 'short') return v <= e.max ? 'pass' : 'fail';
    if (e.type === 'open') return v >= e.min ? 'pass' : 'fail';
    if (e.type === 'res') return v >= e.min && v <= e.max ? 'pass' : 'fail';
    return null; // manual: technician decides
  }

  // ---------------------------------------------------------------- plan
  function label(p, T) { return p ? T('{ref} pin {pin}', { ref: p.ref, pin: p.pin }) : '—'; }

  function buildTestPlan(pcb, opts) {
    opts = opts || {};
    var T = opts.t || function (s, v) { return String(s).replace(/\{(\w+)\}/g, function (m, k) { return v && v[k] != null ? v[k] : m; }); };
    var cfg = Object.assign({}, DEF, opts.limits || {});
    var fields = opts.fieldNames || [];
    var vi = fields.findIndex(function (f) { return /^(value|comment|değer|deger|val)$/i.test(f); });
    var valueOf = function (fi) { var f = pcb.bom && pcb.bom.fields && pcb.bom.fields[fi]; return f ? String(f[vi >= 0 ? vi : 0] || '') : ''; };
    var nets = padsByNet(pcb);
    var grounds = [];
    nets.forEach(function (list, net) {
      var c = classifyNet(net);
      if (c === 'ground' || c === 'chassis') grounds.push({ net: net, cls: c, pads: list, fps: new Set(list.map(function (p) { return p.fp; })).size });
    });
    // chassis first, then the biggest ground (main GND), then the rest
    grounds.sort(function (a, b) { return (a.cls === b.cls ? 0 : a.cls === 'chassis' ? -1 : 1) || b.pads.length - a.pads.length || (a.net < b.net ? -1 : 1); });

    var steps = [];
    steps.push({
      id: 'prep', kind: 'prep', title: T('Hazırlık: ölçü aleti ve kart'),
      text: [
        T('Kartın enerjisi kesik olmalı; güç ve haberleşme kabloları sökülmeli.'),
        T('Büyük kondansatörlerin deşarj olduğundan emin olun.'),
        T('Multimetreyi direnç (Ω) / süreklilik kademesine alın.'),
        T('Probları birbirine değdirin ve okunan prob direncini girin; sonraki ölçümlerden düşülür.'),
      ],
      expect: { type: 'short', max: 1 }, optionalValue: true,
    });
    grounds.forEach(function (g) {
      if (g.fps < 2) return;
      var a = bestPad(g.pads), b = bestPad(g.pads, a, a);
      if (!a || !b) return;
      steps.push({
        id: 'cont:' + g.net, kind: 'continuity', netA: g.net, netB: g.net, cls: g.cls,
        title: T('{net} sürekliliği', { net: g.net }),
        text: [T('{a} ile {b} arasındaki direnci ölçün. İki nokta da {net} netinde; devrenin tamamlandığı (süreklilik) doğrulanır.', { a: label(a, T), b: label(b, T), net: g.net })],
        probes: { pos: probe(a), neg: probe(b) },
        expect: { type: 'short', max: cfg.shortMax },
      });
    });
    for (var i = 0; i < grounds.length; i++) {
      for (var j = i + 1; j < grounds.length; j++) {
        var A = grounds[i], B = grounds[j];
        var pa = bestPad(A.pads), pb = bestPad(B.pads, null, pa);
        if (!pa || !pb) continue;
        var br = bridges(pcb, A.net, B.net, valueOf);
        var ex = expectation(br, cfg);
        var text = [T('{a} ({na}) ile {b} ({nb}) arasındaki direnci ölçün.', { a: label(pa, T), na: A.net, b: label(pb, T), nb: B.net })];
        if (!br.length) text.push(T('Bu iki net arasında tasarımda bağlantı yok: kısa devre olmamalı.'));
        br.slice(0, 4).forEach(function (x) {
          text.push(x.kind === 'short' ? T('{ref} ({v}) iki neti birleştirir: kısa devre beklenir.', { ref: x.ref, v: x.value || '—' })
            : x.kind === 'res' ? T('{ref} = {v} iki net arasında bağlı.', { ref: x.ref, v: fmtOhms(x.ohms) })
              : x.kind === 'cap' ? T('{ref} ({v}) kondansatör: değer şarj oldukça yükselir, kararlı değeri okuyun.', { ref: x.ref, v: x.value || '—' })
                : T('{ref} ({v}) üzerinden bağlı: okunan değer bu bileşene bağlıdır.', { ref: x.ref, v: x.value || '—' }));
        });
        if (br.length > 4) text.push(T('… ve {n} bileşen daha: {refs}', { n: br.length - 4, refs: br.slice(4).map(function (x) { return x.ref; }).join(', ') }));
        steps.push({
          id: 'iso:' + A.net + '|' + B.net, kind: 'isolation', netA: A.net, netB: B.net, cls: A.cls === 'chassis' || B.cls === 'chassis' ? 'chassis' : 'ground',
          title: T('{a} – {b} kısa devre kontrolü', { a: A.net, b: B.net }),
          text: text, probes: { pos: probe(pa), neg: probe(pb) }, expect: ex, bridges: br,
        });
      }
    }
    steps.forEach(function (s) { s.unit = 'Ω'; });
    var phases = [{ id: 'gnd', title: T('GND / şase kısa devre ve süreklilik'), steps: steps, powered: false }];
    var C = mergeCfg(opts.config);
    var more = laterPhases(pcb, nets, grounds, valueOf, cfg, C, T);
    more.forEach(function (ph) { if (ph.steps.length && C.phases[ph.id] !== false) phases.push(ph); });
    var no = 0;
    phases.forEach(function (ph) { ph.steps.forEach(function (s) { s.no = ++no; s.expectText = expectText(s.expect, T); }); });
    return {
      version: 2, phases: phases, grounds: grounds.map(function (g) { return { net: g.net, cls: g.cls, pads: g.pads.length }; }),
      rails: more.rails, config: C, next: [],
    };
  }

  function mergeCfg(c) {
    var o = JSON.parse(JSON.stringify(CFG));
    c = c || {};
    ['voltTol', 'inputTol', 'railMinOhm', 'ioMax'].forEach(function (k) { if (c[k] != null && !isNaN(+c[k])) o[k] = +c[k]; });
    if (c.currentLimit) o.currentLimit = String(c.currentLimit);
    if (c.rails) Object.keys(c.rails).forEach(function (k) { o.rails[k] = c.rails[k]; });
    if (c.phases) Object.keys(c.phases).forEach(function (k) { o.phases[k] = c.phases[k] !== false; });
    return o;
  }

  var RX_I2C = /(^|[^A-Z])(I2C|IIC|SDA|SCL|SMB|SMBCLK|SMBDAT)/i;
  var RX_UART = /(UART|USART|TXD|RXD|(^|[_\-])(TX|RX)(\d|[_\-]|$)|^(TX|RX)\d?$)/i;
  var RX_SPI = /(SPI|SCK|SCLK|MOSI|MISO|SDI|SDO|(^|[_\-])N?CS\d*([_\-]|$)|NSS|SS_N)/i;
  var RX_CAN = /CAN[_\-]?(H|L|HI|LO|HIGH|LOW)([_\-]|\d|$)/i;
  var RX_DIFF_IF = /(RS|EIA)?[_\-]?(422|485)|LVDS|ARINC|1553|USB[_\-]?D/i;
  var RX_SENSOR = /(SENS|SNS|TEMP|NTC|PTC|PT100|PT1000|THERM|AIN|ADC|ANALOG|VREF|REF_?\d|EXC|IMU|ACCEL|GYRO|MAG|PRESS|HUMID|ISENSE|IMON|VMON|CSA|SHUNT)/i;
  var RX_NC = /^(NC|N\/C|UNCONNECTED|NO_CONNECT|UNUSED)/i;
  // tool-generated names (Cadence UN…, N$…, numeric): not used to guess a line's function
  var RX_AUTO = /^(UN\d|N\$|N\d{4,}|NET\d+$|NET[_\-]?\d{4,})/i;
  function diffKey(n) {
    var m = normNet(n).match(/^(.*?)[_\-]?(P|N|\+|-|POS|NEG|A|B|H|L|HI|LO)$/i);
    if (!m || !m[1]) return null;
    var s = m[2].toUpperCase();
    var pol = /^(P|\+|POS|A|H|HI)$/.test(s) ? 'p' : 'n';
    return { base: m[1].toUpperCase(), pol: pol };
  }

  function laterPhases(pcb, nets, grounds, valueOf, cfg, C, T) {
    var signalGnds = grounds.filter(function (g) { return g.cls !== 'chassis'; });
    var chassis = grounds.filter(function (g) { return g.cls === 'chassis'; });
    var mainGnd = signalGnds.slice().sort(function (a, b) { return b.pads.length - a.pads.length; })[0] || null;
    var fpNets = pcb.footprints.map(function (fp) { return new Set(fp.pads.map(function (p) { return normNet(p.net); })); });
    var skipped = new Set(pcb.bom && pcb.bom.skipped || []);
    var shared = function (a, b) { var n = 0; fpNets.forEach(function (s, i) { if (!skipped.has(i) && s.has(a) && s.has(b)) n++; }); return n; };
    var refGround = function (net) {
      var best = mainGnd, bn = 0;
      signalGnds.forEach(function (g) { var n = shared(net, g.net); if (n > bn) { bn = n; best = g; } });
      return best;
    };
    var label = function (p) { return p ? T('{ref} pin {pin}', { ref: p.ref, pin: p.pin }) : '—'; };

    // ---- power rails
    var rails = [], excluded = [];
    nets.forEach(function (list, net) {
      if (classifyNet(net) !== 'power') return;
      var o = C.rails[net] || {};
      var fps = new Set(list.map(function (p) { return p.fp; })).size;
      if (fps < 2) return;
      var nominal = o.nominal != null && o.nominal !== '' && !isNaN(+o.nominal) ? +o.nominal : railVolts(net);
      var r = { net: net, pads: list, nominal: nominal, input: o.input != null ? !!o.input : isInputName(net), ref: refGround(net) };
      if (o.include === false) excluded.push(r); else rails.push(r);
    });
    if (rails.length && !rails.some(function (r) { return r.input; })) {
      var top = rails.filter(function (r) { return r.nominal != null; }).sort(function (a, b) { return Math.abs(b.nominal) - Math.abs(a.nominal); })[0];
      if (top && !(C.rails[top.net] && C.rails[top.net].input === false)) top.input = true;
    }
    rails.sort(function (a, b) { return (b.input - a.input) || (Math.abs(b.nominal || 0) - Math.abs(a.nominal || 0)) || (a.net < b.net ? -1 : 1); });

    // ---- phase 2: rails vs ground / chassis, unpowered (Ω)
    var pwr = [];
    rails.forEach(function (r) {
      if (!r.ref) return;
      var pa = bestPad(r.pads), pb = nearPad(r.ref.pads, pa);
      if (!pa || !pb) return;
      var br = bridges(pcb, r.net, r.ref.net, valueOf);
      var ex = br.some(function (x) { return x.kind === 'short'; }) ? { type: 'short', max: cfg.shortMax } : { type: 'min', min: C.railMinOhm };
      pwr.push({
        id: 'pwr:' + r.net + '|' + r.ref.net, kind: 'isolation', netA: r.net, netB: r.ref.net, unit: 'Ω',
        title: T('{a} – {b} kısa devre kontrolü', { a: r.net, b: r.ref.net }),
        text: [T('{a} ({na}) ile {b} ({nb}) arasındaki direnci ölçün.', { a: label(pa), na: r.net, b: label(pb), nb: r.ref.net }),
          T('Kart enerjisiz. Ray ile dönüşü arasında kısa devre olmamalı; çıkış kondansatörleri şarj oldukça değer yükselir, kararlı değeri okuyun.')],
        probes: { pos: probe(pa), neg: probe(pb) }, expect: ex, bridges: br,
      });
      chassis.forEach(function (c) {
        var pc = nearPad(c.pads, pa);
        if (!pc) return;
        var brc = bridges(pcb, r.net, c.net, valueOf);
        pwr.push({
          id: 'pwr:' + r.net + '|' + c.net, kind: 'isolation', netA: r.net, netB: c.net, unit: 'Ω',
          title: T('{a} – {b} kısa devre kontrolü', { a: r.net, b: c.net }),
          text: [T('{a} ({na}) ile {b} ({nb}) arasındaki direnci ölçün.', { a: label(pa), na: r.net, b: label(pc), nb: c.net }),
            brc.length ? T('{ref} ({v}) üzerinden bağlı: okunan değer bu bileşene bağlıdır.', { ref: brc[0].ref, v: brc[0].value || '—' }) : T('Bu iki net arasında tasarımda bağlantı yok: kısa devre olmamalı.')],
          probes: { pos: probe(pa), neg: probe(pc) }, expect: expectation(brc, cfg), bridges: brc,
        });
      });
    });

    // ---- phase 3: rail voltages, powered (V)
    var volt = [];
    var inp = rails.filter(function (r) { return r.input; })[0];
    if (rails.length) {
      var conn = function (list) { return (list || []).filter(function (p) { return CONN.test(p.ref); }); };
      var sp = inp ? (bestPad(conn(inp.pads)) || bestPad(inp.pads)) : null;
      var sn = inp && inp.ref ? (nearPad(conn(inp.ref.pads), sp) || nearPad(inp.ref.pads, sp)) : null;
      var txt = [];
      if (inp) txt.push(T('Laboratuvar güç kaynağını {v} değerine ayarlayın, akım sınırını {i} yapın.', { v: inp.nominal != null ? fmtVolts(inp.nominal) : inp.net, i: C.currentLimit }));
      if (sp && sn) txt.push(T('Kaynağın (+) ucunu {a} ({na}), (−) ucunu {b} ({nb}) noktasına bağlayın.', { a: label(sp), na: inp.net, b: label(sn), nb: inp.ref.net }));
      txt.push(T('Kaynağı açın; akım sınırına takılıyorsa hemen kapatın ve önceki aşamaları kontrol edin.'));
      txt.push(T('Çekilen akımı girin (mA, isteğe bağlı) ve devam edin.'));
      volt.push({ id: 'volt-on', kind: 'power-on', unit: 'mA', title: T('Enerji verme: besleme ve akım sınırı'), text: txt,
        probes: sp && sn ? { pos: probe(sp), neg: probe(sn) } : null, expect: { type: 'record' }, optionalValue: true, supply: true });
      rails.forEach(function (r) {
        if (!r.ref) return;
        var pa = bestPad(r.pads), pb = nearPad(r.ref.pads, pa);
        if (!pa || !pb) return;
        var tol = (r.input ? C.inputTol : C.voltTol) / 100;
        var ex = r.nominal == null ? { type: 'manual', unit: 'V', hint: 'Ray gerilimi addan çıkarılamadı: Test ayarlarından nominal değeri girin' }
          : { type: 'range', nominal: r.nominal, min: Math.min(r.nominal * (1 - tol), r.nominal * (1 + tol)), max: Math.max(r.nominal * (1 - tol), r.nominal * (1 + tol)), tol: tol };
        volt.push({
          id: 'volt:' + r.net, kind: 'voltage', netA: r.net, netB: r.ref.net, unit: 'V', nominal: r.nominal,
          title: T('{net} gerilimi', { net: r.net }),
          text: [T('Multimetreyi DC V kademesine alın.'),
            T('Kırmızı probu {a} ({na}), siyah probu {b} ({nb}) noktasına değdirin.', { a: label(pa), na: r.net, b: label(pb), nb: r.ref.net }),
            r.nominal != null ? T('Tolerans ±%{t}{inp}.', { t: Math.round(tol * 100), inp: r.input ? ' ' + T('(giriş rayı)') : '' }) : ''].filter(Boolean),
          probes: { pos: probe(pa), neg: probe(pb) }, expect: ex,
        });
      });
    }

    // signal helpers
    var railByNet = {};
    rails.forEach(function (r) { railByNet[r.net] = r; });
    var pullRail = function (net) {
      var out = null;
      pcb.footprints.forEach(function (fp, fi) {
        if (out || skipped.has(fi) || !/^R/i.test(fp.ref) || fp.pads.length !== 2) return;
        var a = normNet(fp.pads[0].net), b = normNet(fp.pads[1].net);
        var other = a === net ? b : b === net ? a : null;
        if (other && railByNet[other] && railByNet[other].nominal != null) out = railByNet[other];
      });
      return out;
    };
    var used = new Set();
    rails.forEach(function (r) { used.add(r.net); });
    grounds.forEach(function (g) { used.add(g.net); });
    var sigNets = [];
    nets.forEach(function (list, net) {
      if (used.has(net) || RX_NC.test(net)) return;
      var auto = RX_AUTO.test(net);
      var fps = new Set(list.map(function (p) { return p.fp; })).size;
      if (fps < 2 && !list.some(function (p) { return CONN.test(p.ref); })) return;
      sigNets.push({ net: net, pads: list, auto: auto, conn: list.some(function (p) { return CONN.test(p.ref); }) });
    });
    sigNets.sort(function (a, b) { return a.net < b.net ? -1 : a.net > b.net ? 1 : 0; });
    var gndFor = function (net) { var g = refGround(net); return g || mainGnd; };
    var single = function (s, idp, title, ex, extra) {
      var g = gndFor(s.net);
      var pa = bestPad(s.pads), pb = g ? nearPad(g.pads, pa) : null;
      if (!pa || !pb) return null;
      return { id: idp + s.net, kind: 'signal', netA: s.net, netB: g.net, unit: 'V', title: title,
        text: [T('Kırmızı probu {a} ({na}), siyah probu {b} ({nb}) noktasına değdirin.', { a: label(pa), na: s.net, b: label(pb), nb: g.net })].concat(extra || []),
        probes: { pos: probe(pa), neg: probe(pb) }, expect: ex };
    };
    var idleHigh = function (s, kindTxt) {
      var r = pullRail(s.net);
      if (r) return { ex: { type: 'range', nominal: r.nominal, min: r.nominal * 0.85, max: r.nominal * 1.05 }, note: T('{kind} hattı boşta lojik 1: {r} rayına pull-up ile bağlı.', { kind: kindTxt, r: r.net }) };
      return { ex: { type: 'manual', unit: 'V', hint: 'Boşta seviyeyi kaydedin (genelde lojik 1 ≈ IO gerilimi)' }, note: T('{kind} hattı: pull-up bulunamadı; seviyeyi kaydedin.', { kind: kindTxt }) };
    };

    // ---- phase 4: communication
    var comm = [], taken = new Set();
    var pairs = {};
    sigNets.forEach(function (s) {
      if (s.auto || !(RX_DIFF_IF.test(s.net) || RX_CAN.test(s.net))) return;
      var k = diffKey(s.net);
      if (!k) return;
      (pairs[k.base] = pairs[k.base] || {})[k.pol] = s;
    });
    Object.keys(pairs).sort().forEach(function (base) {
      var pr = pairs[base];
      if (!pr.p || !pr.n) return;
      taken.add(pr.p.net); taken.add(pr.n.net);
      var isCan = RX_CAN.test(pr.p.net) || RX_CAN.test(pr.n.net);
      var pa = bestPad(pr.p.pads), pb = nearPad(pr.n.pads, pa);
      if (!pa || !pb) return;
      var tx = /TX|DO|OUT|DRV|Y|Z/i.test(base);
      var ex = isCan ? { type: 'range', nominal: 0, min: -0.5, max: 0.05 }
        : { type: 'absmin', min: tx ? 1.5 : 0.2 };
      comm.push({ id: 'commdiff:' + pr.p.net + '|' + pr.n.net, kind: 'diff', netA: pr.p.net, netB: pr.n.net, unit: 'V',
        title: T('{a} / {b} diferansiyel gerilim', { a: pr.p.net, b: pr.n.net }),
        text: [T('Kırmızı probu {a} ({na}), siyah probu {b} ({nb}) noktasına değdirin; iki hat arasındaki farkı ölçün.', { a: label(pa), na: pr.p.net, b: label(pb), nb: pr.n.net }),
          isCan ? T('CAN boşta (resesif): fark ≈ 0 V.') : tx ? T('Sürücü etkin ve boşta: |fark| ≥ 1,5 V beklenir.') : T('Alıcı hattı: fail-safe polarlama varsa |fark| ≥ 200 mV; yoksa değer 0 V olabilir, karar sizde.')],
        probes: { pos: probe(pa), neg: probe(pb) }, expect: ex });
      if (isCan) [pr.p, pr.n].forEach(function (s) {
        var st = single(s, 'comm:', T('{net} ortak mod gerilimi', { net: s.net }), { type: 'range', nominal: 2.5, min: 2.0, max: 3.0 }, [T('CAN resesif seviye ≈ 2,5 V.')]);
        if (st) comm.push(st);
      });
    });
    sigNets.forEach(function (s) {
      if (taken.has(s.net) || s.auto) return;
      var kind = RX_I2C.test(s.net) ? 'I²C' : RX_CAN.test(s.net) ? 'CAN' : RX_UART.test(s.net) ? 'UART' : RX_SPI.test(s.net) ? 'SPI' : RX_DIFF_IF.test(s.net) ? 'RS-422/485' : null;
      if (!kind) return;
      taken.add(s.net);
      var ih = idleHigh(s, kind);
      var st = single(s, 'comm:', T('{net} boşta seviye ({kind})', { net: s.net, kind: kind }), ih.ex, [ih.note]);
      if (st) comm.push(st);
    });

    // ---- phase 5: sensors
    var sens = [];
    sigNets.forEach(function (s) {
      if (taken.has(s.net) || s.auto || !RX_SENSOR.test(s.net)) return;
      taken.add(s.net);
      var v = /REF/i.test(s.net) ? railVolts(s.net) : null;
      var ex = v != null ? { type: 'range', nominal: v, min: v * 0.98, max: v * 1.02 } : { type: 'manual', unit: 'V', hint: 'Sensör çıkışını kaydedin ve beklenen aralıkla karşılaştırın' };
      var st = single(s, 'sens:', T('{net} sensör hattı', { net: s.net }), ex,
        [v != null ? T('Referans gerilimi ±%2.') : T('Ortam koşulunda (oda sıcaklığı, hareketsiz) beklenen değerle karşılaştırın.')]);
      if (st) sens.push(st);
    });

    // ---- phase 6: other I/O lines that leave the board through a connector
    var io = [];
    sigNets.forEach(function (s) {
      if (taken.has(s.net) || !s.conn || io.length >= C.ioMax) return;
      var r = pullRail(s.net);
      var ex = r ? { type: 'range', nominal: r.nominal, min: r.nominal * 0.85, max: r.nominal * 1.05 } : { type: 'manual', unit: 'V', hint: 'Hat durumunu kaydedin (ör. 0 V / 3,3 V)' };
      var st = single(s, 'io:', T('{net} I/O hattı', { net: s.net }), ex,
        [r ? T('{r} rayına pull-up: boşta lojik 1.', { r: r.net }) : T('Konnektöre çıkan hat: beklenen seviyeyi şemaya göre doğrulayın.')]);
      if (st) io.push(st);
    });

    var out = [
      { id: 'pwr', title: T('Güç hatları – GND / şase kısa devre'), steps: pwr, powered: false },
      { id: 'volt', title: T('Gerilim kanalları'), steps: volt, powered: true },
      { id: 'comm', title: T('Haberleşme hatları'), steps: comm, powered: true },
      { id: 'sens', title: T('Sensör hatları'), steps: sens, powered: true },
      { id: 'io', title: T('I/O hatları'), steps: io, powered: true },
    ];
    out.rails = rails.concat(excluded).map(function (r) { return { net: r.net, nominal: r.nominal, input: r.input, ref: r.ref && r.ref.net, auto: railVolts(r.net), include: excluded.indexOf(r) < 0 }; });
    return out;
  }

  // other good probe points on a net (alternatives offered to the technician)
  var netCache = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
  function candidates(pcb, net, limit) {
    var map = netCache && netCache.get(pcb);
    if (!map) { map = padsByNet(pcb); if (netCache) netCache.set(pcb, map); }
    var list = (map.get(normNet(net)) || []).slice().sort(function (a, b) { return b.score - a.score; });
    var seen = new Set(), out = [];
    for (var i = 0; i < list.length && out.length < (limit || 8); i++) {
      var k = list[i].ref + '.' + list[i].pin;
      if (seen.has(k)) continue;
      seen.add(k);
      var pr = probe(list[i]); pr.score = list[i].score; pr.pads = list.length;
      out.push(pr);
    }
    return out;
  }
  function netSize(pcb, net) { var map = netCache && netCache.get(pcb) || padsByNet(pcb); return (map.get(normNet(net)) || []).length; }

  return { normNet: normNet, railVolts: railVolts, parseVolts: parseVolts, parseValue: parseValue, fmtValue: fmtValue, fmtVolts: fmtVolts, CFG: CFG, buildTestPlan: buildTestPlan, candidates: candidates, netSize: netSize, evaluate: evaluate, parseOhms: parseOhms, fmtOhms: fmtOhms, classifyNet: classifyNet, whyNet: whyNet, bridges: bridges, DEF: DEF };
});
