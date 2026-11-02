// Loaded before the InteractiveHtmlBom scripts: provides the globals they expect.
/* global asm */
var __asmInit = JSON.parse(window.asm.viewerInit());
I18N.setLang(__asmInit.lang || 'tr');
document.documentElement.lang = I18N.getLang();
if (__asmInit.error) {
  document.addEventListener('DOMContentLoaded', function () {
    document.body.innerHTML = '<p style="padding:2rem;font-family:sans-serif">' + __asmInit.error + '</p>';
  });
}
var pcbdata = __asmInit.pcbdata;
var config = __asmInit.config;
