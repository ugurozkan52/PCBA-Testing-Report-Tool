'use strict';
// Persistent storage: projects, boards (serial numbers), settings and an
// append-only assembly log. Everything is plain JSON on disk so it survives
// crashes and can be backed up / inspected.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

function atomicWrite(file, data) {
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}
function readJson(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    // try the backup written before the last change
    try { return JSON.parse(fs.readFileSync(file + '.bak', 'utf8')); } catch (e2) { return def; }
  }
}
function writeJson(file, obj) {
  const s = JSON.stringify(obj, null, 1);
  if (fs.existsSync(file)) { try { fs.copyFileSync(file, file + '.bak'); } catch (e) { /* ignore */ } }
  atomicWrite(file, s);
}
function safeName(s) {
  return String(s).trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, '_').substring(0, 80) || 'kart';
}

class Store {
  constructor(dataDir) {
    this.setDataDir(dataDir);
  }

  setDataDir(dir) {
    this.dir = dir;
    fs.mkdirSync(path.join(dir, 'projects'), { recursive: true });
    this.stateFile = path.join(dir, 'app-state.json');
  }

  // ------------------------------- app state -------------------------------
  getState() { return readJson(this.stateFile, { last: null, operators: [] }); }
  setState(patch) {
    const st = Object.assign(this.getState(), patch);
    writeJson(this.stateFile, st);
    return st;
  }
  rememberOperator(name) {
    const st = this.getState();
    const ops = [name].concat((st.operators || []).filter((o) => o !== name)).slice(0, 30);
    this.setState({ operators: ops });
  }

  // -------------------------------- projects -------------------------------
  projectDir(id) { return path.join(this.dir, 'projects', id); }

  listProjects() {
    const root = path.join(this.dir, 'projects');
    const out = [];
    for (const id of fs.readdirSync(root)) {
      if (id.startsWith('_')) continue;
      const p = readJson(path.join(root, id, 'project.json'), null);
      if (!p) continue;
      const boards = this.listBoards(id);
      const last = boards.reduce((a, b) => (b.updated > a ? b.updated : a), p.updated || p.created);
      out.push({ id, name: p.name, revision: p.revision, company: p.company, created: p.created, updated: last, source: p.source && p.source.source, counts: p.report && p.report.counts, boardCount: boards.length, boards: boards.slice(0, 50), has3d: fs.existsSync(path.join(root, id, 'model3d.bin')) });
    }
    out.sort((a, b) => (a.updated < b.updated ? 1 : -1));
    return out;
  }

  getProject(id) { return readJson(path.join(this.projectDir(id), 'project.json'), null); }
  model3dFile(id) { return path.join(this.projectDir(id), 'model3d.bin'); }
  getPcbData(id) { return readJson(path.join(this.projectDir(id), 'pcbdata.json'), null); }

  newProjectId(name) {
    const base = safeName(name).toLowerCase().substring(0, 40);
    return base + '-' + crypto.randomBytes(3).toString('hex');
  }

  // Copy source files into project folder; returns spec with relative paths
  copySources(id, spec) {
    const dir = path.join(this.projectDir(id), 'sources');
    fs.mkdirSync(dir, { recursive: true });
    const copy = (src, sub) => {
      if (!src) return src;
      const d = sub ? path.join(dir, sub) : dir;
      fs.mkdirSync(d, { recursive: true });
      const dst = path.join(d, path.basename(src));
      if (path.resolve(src) !== path.resolve(dst)) fs.copyFileSync(src, dst);
      return path.relative(this.projectDir(id), dst);
    };
    const out = JSON.parse(JSON.stringify(spec));
    if (out.ipcFile) out.ipcFile = copy(out.ipcFile);
    if (out.bom && out.bom.path) out.bom.path = copy(out.bom.path, 'bom');
    if (out.stepFile) out.stepFile = copy(out.stepFile, 'step');
    return out;
  }

  // Reference source files in place (KiCad exports): paths relative to the project folder
  linkSources(id, spec) {
    const base = this.projectDir(id);
    const rel = (p) => (p ? path.relative(base, path.resolve(p)) : p);
    const out = JSON.parse(JSON.stringify(spec));
    if (out.ipcFile) out.ipcFile = rel(out.ipcFile);
    if (out.bom && out.bom.path) out.bom.path = rel(out.bom.path);
    if (out.stepFile) out.stepFile = rel(out.stepFile);
    out.linked = true;
    return out;
  }

  // Spec with absolute paths for a stored project
  absoluteSpec(id, spec) {
    const base = this.projectDir(id);
    const abs = (p) => (p && !path.isAbsolute(p) ? path.join(base, p) : p);
    const out = JSON.parse(JSON.stringify(spec));
    if (out.ipcFile) out.ipcFile = abs(out.ipcFile);
    if (out.bom && out.bom.path) out.bom.path = abs(out.bom.path);
    if (out.stepFile) out.stepFile = abs(out.stepFile);
    return out;
  }

  saveProject(id, project, pcbdata) {
    const dir = this.projectDir(id);
    fs.mkdirSync(path.join(dir, 'boards'), { recursive: true });
    writeJson(path.join(dir, 'pcbdata.json'), pcbdata);
    writeJson(path.join(dir, 'project.json'), project);
  }

  deleteProject(id) {
    // never hard-delete: move to _silinen so data can be recovered
    const src = this.projectDir(id);
    const trash = path.join(this.dir, 'projects', '_silinen');
    fs.mkdirSync(trash, { recursive: true });
    fs.renameSync(src, path.join(trash, id + '-' + Date.now()));
  }

  // ------------------------------ settings (kv) ----------------------------
  getSettings(id) { return readJson(path.join(this.projectDir(id), 'settings.json'), {}); }
  setSetting(id, key, value) {
    const f = path.join(this.projectDir(id), 'settings.json');
    const s = readJson(f, {});
    if (value === null || value === undefined) delete s[key]; else s[key] = String(value);
    writeJson(f, s);
  }

  // --------------------------------- boards --------------------------------
  boardFile(id, serial) { return path.join(this.projectDir(id), 'boards', safeName(serial) + '.json'); }
  listBoards(id) {
    const dir = path.join(this.projectDir(id), 'boards');
    if (!fs.existsSync(dir)) return [];
    const out = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const b = readJson(path.join(dir, f), null);
      if (b) out.push({ serial: b.serial, created: b.created, updated: b.updated, operator: b.lastOperator, progress: b.progress || {}, complete: !!b.complete });
    }
    out.sort((a, b) => (a.updated < b.updated ? 1 : -1));
    return out;
  }
  getBoard(id, serial) { return readJson(this.boardFile(id, serial), null); }
  ensureBoard(id, serial, operator) {
    let b = this.getBoard(id, serial);
    if (!b) {
      const now = new Date().toISOString();
      b = { serial, created: now, updated: now, createdBy: operator, lastOperator: operator, kv: {}, progress: {} };
      writeJson(this.boardFile(id, serial), b);
      return { board: b, created: true };
    }
    return { board: b, created: false };
  }
  updateBoard(id, serial, fn) {
    const f = this.boardFile(id, serial);
    const b = readJson(f, null);
    if (!b) return null;
    fn(b);
    b.updated = new Date().toISOString();
    writeJson(f, b);
    return b;
  }

  // ----------------------------------- log ---------------------------------
  logFile(id) { return path.join(this.projectDir(id), 'log.jsonl'); }
  appendLog(id, evt) {
    const e = Object.assign({ ts: new Date().toISOString(), host: os.hostname() }, evt);
    fs.appendFileSync(this.logFile(id), JSON.stringify(e) + '\n', 'utf8');
    return e;
  }
  readLog(id, filter = {}) {
    let txt = '';
    try { txt = fs.readFileSync(this.logFile(id), 'utf8'); } catch (e) { return []; }
    const out = [];
    for (const line of txt.split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (filter.serial && e.serial !== filter.serial) continue;
        out.push(e);
      } catch (e) { /* skip damaged line */ }
    }
    return out;
  }
}

module.exports = { Store, safeName, readJson, writeJson };
