'use strict';
// Minimal synchronous file system for the browser build.
// The Electron app keeps its data as plain JSON files (src/main/store.js); in the
// browser the same code runs on this in-memory tree, which is loaded from IndexedDB
// once per page and written back on every change (write-through, per file).
// Paths under /app and /tmp, and temporary files (*.tmp*), stay in memory only.
const { Buffer } = require('buffer');

const DB_NAME = 'montaj-goruntuleyici';
const STORE = 'files';
const files = new Map(); // path -> Uint8Array
let db = null;
let pending = 0;
let waiters = [];

function norm(p) {
  p = String(p).replace(/\\/g, '/');
  const out = [];
  for (const s of p.split('/')) {
    if (!s || s === '.') continue;
    if (s === '..') out.pop(); else out.push(s);
  }
  return '/' + out.join('/');
}
const volatile = (p) => /^\/(app|tmp)(\/|$)/.test(p) || /\.tmp(-\w+)?$|\.part$/.test(p);

function openDb() {
  return new Promise((resolve, reject) => {
    const rq = indexedDB.open(DB_NAME, 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore(STORE);
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  });
}
function settle() { if (!pending) { const w = waiters; waiters = []; w.forEach((f) => f()); } }
function persist(p, data) {
  if (!db || volatile(p)) return;
  pending++;
  const tx = db.transaction(STORE, 'readwrite');
  if (data === null) tx.objectStore(STORE).delete(p); else tx.objectStore(STORE).put(data, p);
  const done = () => { pending--; settle(); };
  tx.oncomplete = done;
  tx.onerror = tx.onabort = (e) => { console.error('vfs persist', p, tx.error); done(); };
}

async function load() {
  try {
    db = await openDb();
  } catch (e) {
    console.warn('IndexedDB unavailable, data is kept for this page only', e);
    return { persistent: false };
  }
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const rq = tx.objectStore(STORE).openCursor();
    rq.onsuccess = () => {
      const c = rq.result;
      if (!c) return;
      files.set(c.key, c.value instanceof Uint8Array ? c.value : new Uint8Array(c.value));
      c.continue();
    };
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  let persistent = false;
  try { if (navigator.storage && navigator.storage.persist) persistent = await navigator.storage.persist(); } catch (e) { /* not granted */ }
  return { persistent: true, durable: persistent };
}
// resolves when every write has been committed (call before navigating away)
function flush() { return pending ? new Promise((r) => waiters.push(r)) : Promise.resolve(); }

function enoent(p) { const e = new Error(`ENOENT: no such file or directory, '${p}'`); e.code = 'ENOENT'; return e; }
function toBytes(data, enc) {
  if (data instanceof Uint8Array) return new Uint8Array(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  return new Uint8Array(Buffer.from(String(data), enc || 'utf8'));
}
function isDir(p) {
  if (p === '/') return true;
  const pre = p + '/';
  for (const k of files.keys()) if (k.startsWith(pre)) return true;
  return dirs.has(p);
}
const dirs = new Set();

const fs = {
  existsSync(p) { p = norm(p); return files.has(p) || isDir(p); },
  readFileSync(p, opt) {
    p = norm(p);
    const d = files.get(p);
    if (!d) throw enoent(p);
    const enc = typeof opt === 'string' ? opt : opt && opt.encoding;
    const b = Buffer.from(d.buffer, d.byteOffset, d.byteLength);
    return enc ? b.toString(enc) : b;
  },
  writeFileSync(p, data, opt) {
    p = norm(p);
    const enc = typeof opt === 'string' ? opt : opt && opt.encoding;
    const b = toBytes(data, enc);
    files.set(p, b);
    persist(p, b);
  },
  appendFileSync(p, data, opt) {
    p = norm(p);
    const enc = typeof opt === 'string' ? opt : opt && opt.encoding;
    const add = toBytes(data, enc), old = files.get(p) || new Uint8Array(0);
    const b = new Uint8Array(old.length + add.length);
    b.set(old, 0); b.set(add, old.length);
    files.set(p, b);
    persist(p, b);
  },
  copyFileSync(a, b) { fs.writeFileSync(b, fs.readFileSync(a)); },
  renameSync(a, b) {
    a = norm(a); b = norm(b);
    if (files.has(a)) {
      const d = files.get(a);
      files.delete(a); persist(a, null);
      files.set(b, d); persist(b, d);
      return;
    }
    if (!isDir(a)) throw enoent(a);
    for (const k of Array.from(files.keys())) {
      if (!k.startsWith(a + '/')) continue;
      const d = files.get(k), nk = b + k.slice(a.length);
      files.delete(k); persist(k, null);
      files.set(nk, d); persist(nk, d);
    }
    dirs.delete(a); dirs.add(b);
  },
  unlinkSync(p) { p = norm(p); if (!files.has(p)) throw enoent(p); files.delete(p); persist(p, null); },
  rmSync(p) { p = norm(p); for (const k of Array.from(files.keys())) if (k === p || k.startsWith(p + '/')) { files.delete(k); persist(k, null); } dirs.delete(p); },
  mkdirSync(p) { dirs.add(norm(p)); },
  readdirSync(p) {
    p = norm(p);
    const pre = p === '/' ? '/' : p + '/';
    const out = new Set();
    for (const k of files.keys()) if (k.startsWith(pre)) out.add(k.slice(pre.length).split('/')[0]);
    for (const d of dirs) if (d.startsWith(pre)) out.add(d.slice(pre.length).split('/')[0]);
    if (!out.size && !isDir(p)) throw enoent(p);
    return Array.from(out).sort();
  },
  statSync(p) {
    p = norm(p);
    const d = files.get(p);
    if (!d && !isDir(p)) throw enoent(p);
    return { size: d ? d.length : 0, isFile: () => !!d, isDirectory: () => !d, mtimeMs: 0 };
  },
};

// backup: every persistent file as one JSON document (base64 values)
function exportAll() {
  const out = {};
  for (const [k, v] of files) if (!volatile(k)) out[k] = Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64');
  return out;
}
function importAll(obj, prefix) {
  let n = 0;
  for (const k of Object.keys(obj)) {
    const p = norm(k);
    if (prefix && !p.startsWith(prefix)) continue;
    fs.writeFileSync(p, Buffer.from(obj[k], 'base64'));
    n++;
  }
  return n;
}
function usage() { let n = 0; for (const [k, v] of files) if (!volatile(k)) n += v.length; return n; }

module.exports = { fs, load, flush, norm, exportAll, importAll, usage, files };
