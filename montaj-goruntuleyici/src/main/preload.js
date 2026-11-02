'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('asm', {
  // generic invoke wrapper for whitelisted channels
  info: () => ipcRenderer.invoke('app:info'),
  state: () => ipcRenderer.invoke('app:state'),
  setLang: (l) => ipcRenderer.invoke('app:setLang', l),
  setDark: (v) => ipcRenderer.invoke('app:setDark', v),
  openDataDir: () => ipcRenderer.invoke('app:openDataDir'),
  chooseDataDir: () => ipcRenderer.invoke('app:chooseDataDir'),
  open: (opts) => ipcRenderer.invoke('dlg:open', opts),
  readTable: (args) => ipcRenderer.invoke('import:readTable', args),
  preview: (spec) => ipcRenderer.invoke('import:preview', spec),
  createProject: (args) => ipcRenderer.invoke('project:create', args),
  reimportProject: (args) => ipcRenderer.invoke('project:reimport', args),
  listProjects: () => ipcRenderer.invoke('project:list'),
  getProject: (id) => ipcRenderer.invoke('project:get', id),
  deleteProject: (id) => ipcRenderer.invoke('project:delete', id),
  exportHtml: (id) => ipcRenderer.invoke('project:exportHtml', id),
  listBoards: (id) => ipcRenderer.invoke('board:list', id),
  startSession: (args) => ipcRenderer.invoke('session:start', args),
  goHome: () => ipcRenderer.invoke('session:home'),
  showAbout: () => ipcRenderer.invoke('app:about'),
  setOperator: (name) => ipcRenderer.invoke('session:setOperator', name),
  // viewer
  viewerInit: () => ipcRenderer.sendSync('viewer:init'),
  kvSet: (scope, key, value) => ipcRenderer.send('kv:set', { scope, key, value }),
  logAdd: (evt) => ipcRenderer.invoke('log:add', evt),
  logList: (args) => ipcRenderer.invoke('log:list', args),
  logExportCsv: (args) => ipcRenderer.invoke('log:exportCsv', args),
  model3d: () => ipcRenderer.invoke('model3d:get'),
  testSaveReport: (a) => ipcRenderer.invoke('test:saveReport', a),
  testExportReport: (a) => ipcRenderer.invoke('test:exportReport', a),
  // KiCad plugin jobs: kind = 'status' | 'done' | 'error'
  onKicad: (cb) => {
    ipcRenderer.on('kicad:status', (e, d) => cb('status', d));
    ipcRenderer.on('kicad:done', (e, d) => cb('done', d));
    ipcRenderer.on('kicad:error', (e, d) => cb('error', d));
  },
});
