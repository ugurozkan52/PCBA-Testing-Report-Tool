'use strict';
// Browser build entry: window.asm (the API the Electron preload exposes) on top of
// IndexedDB storage. Loaded before the page scripts of home.html and viewer.html.
window.asm = require('./backend');
