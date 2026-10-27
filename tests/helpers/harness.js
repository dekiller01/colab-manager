'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { Manager } = require('../../jobs/manager');
const { DEFAULTS, merge } = require('../../config');

const HAS_PY = spawnSync('python3', ['-V']).status === 0;
const HAS_TAR = spawnSync('tar', ['--version']).status === 0;
const PY_SKIP = HAS_PY ? false : 'python3 no disponible';

function tmpDir(prefix = 'cm-test-') { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

// Reloj controlable.
function makeClock(startIso = new Date().toISOString()) {
  // Por defecto arranca en la hora real: el runtime de Python (simulado) escribe latidos con la hora real.
  const c = { t: Date.parse(startIso), advance(ms) { c.t += ms; }, fn: () => new Date(c.t) };
  return c;
}

// Crea un Manager en un directorio temporal. overrides se mezcla sobre la configuración por defecto.
function makeManager({ overrides = {}, exec, clock, home } = {}) {
  home = home || tmpDir();
  const config = merge(DEFAULTS, overrides);
  const m = new Manager({ home, config, exec, clock: clock ? clock.fn : undefined });
  m.store.init();
  return m;
}

// Ejecuta el notebook de una tarea con Python local, simulando Colab. base = carpeta que hace de Drive.
function simulateColab(notebookPath, base) {
  const r = spawnSync('python3', ['-I', path.join(__dirname, 'run_notebook.py'), notebookPath], {
    env: { ...process.env, COLABMGR_BASE: base }, encoding: 'utf8', timeout: 60000,
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, signal: r.signal };
}

module.exports = { HAS_PY, HAS_TAR, PY_SKIP, tmpDir, makeClock, makeManager, simulateColab };
