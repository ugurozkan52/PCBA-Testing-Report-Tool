// occt-import-js in a Web Worker: the emscripten build is loaded with importScripts (see step-worker.js)
module.exports = function () {
  /* global occtimportjs */
  return occtimportjs({ locateFile: (f) => new URL('lib/' + f, self.location.href).href });
};
