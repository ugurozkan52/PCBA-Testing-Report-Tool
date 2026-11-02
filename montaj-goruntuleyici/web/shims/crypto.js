const { Buffer } = require('buffer');
module.exports = {
  randomBytes(n) { const b = new Uint8Array(n); crypto.getRandomValues(b); return Buffer.from(b); },
};
