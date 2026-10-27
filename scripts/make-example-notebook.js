#!/usr/bin/env node
'use strict';
// Genera examples/ejemplo-colab.ipynb: un notebook REAL producido por el mismo generador que usa
// "colabctl notebook". Sirve para inspeccionarlo o subirlo a Colab sin crear ninguna tarea.
const path = require('path');
const { buildNotebook, writeNotebook } = require('../notebooks/builder');
const { DEFAULTS } = require('../config');

const task = {
  id: 't-00000000', name: 'Ejemplo de demostración', type: 'demo-counter',
  config: { steps: 12, sleepSec: 1, checkpointEvery: 4, requirements: [], allowInstall: false },
};
const nb = buildNotebook(task, {
  attempt: 1, resumeMode: 'auto', generatedAt: '2026-01-01T00:00:00.000Z', limits: DEFAULTS.limits,
  concurrentGuardSec: DEFAULTS.limits.concurrentGuardSec, storage: DEFAULTS.colab,
});
const out = path.join(__dirname, '..', 'examples', 'ejemplo-colab.ipynb');
writeNotebook(out, nb);
console.log(`Notebook de ejemplo escrito en ${out}`);
