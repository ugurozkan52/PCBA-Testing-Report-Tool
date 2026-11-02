'use strict';
// Child process (Electron utilityProcess) that triangulates a STEP file and
// writes the packed 3D model, so the window stays responsive on large files.
const fs = require('fs');
const I18N = require('../i18n/i18n');
const S = require('../core/step3d');

process.parentPort.once('message', async (e) => {
  const { stepFile, pcb, outFile, lang } = e.data;
  try {
    I18N.setLang(lang || 'tr');
    const m = await S.convertStep(fs.readFileSync(stepFile), pcb);
    const tmp = outFile + '.part';
    fs.writeFileSync(tmp, S.packModel(m));
    fs.renameSync(tmp, outFile);
    const { counts, warnings, align } = m.meta;
    process.parentPort.postMessage({ ok: true, summary: { counts, warnings, align } });
  } catch (err) {
    process.parentPort.postMessage({ ok: false, error: String(err && err.message || err) });
  }
  setTimeout(() => process.exit(0), 50);
});
