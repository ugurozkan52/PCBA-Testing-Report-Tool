'use strict';
// Browser build: STEP → packed 3D model, off the main thread (Electron: src/main/step-proc.js)
/* global importScripts */
importScripts('lib/occt-import-js.js');
const I18N = require('../src/i18n/i18n');
const S = require('../src/core/step3d');

self.onmessage = async (e) => {
  const { step, pcb, lang } = e.data;
  try {
    I18N.setLang(lang || 'tr');
    const m = await S.convertStep(step, pcb);
    const packed = S.packModel(m);
    const out = new Uint8Array(packed.length); out.set(packed);
    const { counts, warnings, align } = m.meta;
    self.postMessage({ ok: true, model: out.buffer, summary: { counts, warnings, align } }, [out.buffer]);
  } catch (err) {
    self.postMessage({ ok: false, error: String(err && err.message || err) });
  }
};
