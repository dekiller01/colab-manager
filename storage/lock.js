'use strict';
// Bloqueo de archivo entre procesos (evita que dos "colabctl" modifiquen el
// mismo registro a la vez y, con ello, ejecuciones duplicadas).
const fs = require('fs');
const path = require('path');
const { E } = require('../lib/errors');
const { sleepSync } = require('../lib/util');

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function acquire(lockFile, { staleMs = 30000, waitMs = 5000 } = {}) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true, mode: 0o700 });
  const start = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(lockFile, 'wx', 0o600);
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      fs.closeSync(fd);
      return () => { try { fs.unlinkSync(lockFile); } catch { /* ya liberado */ } };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let info = null;
      try { info = JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch { /* ilegible → tratar como viejo */ }
      const old = !info || Date.now() - info.at > staleMs || !alive(info.pid);
      if (old) { try { fs.unlinkSync(lockFile); } catch { /* otro proceso lo quitó */ } continue; }
      if (Date.now() - start > waitMs) throw E.busy('Otro proceso de colabctl está modificando los datos.', 'Reintente en unos segundos.');
      sleepSync(40);
    }
  }
}

function withLock(lockFile, fn, opts) {
  const release = acquire(lockFile, opts);
  try { return fn(); } finally { release(); }
}

module.exports = { acquire, withLock };
