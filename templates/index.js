'use strict';
// Registro de plantillas de tareas. Cada plantilla = definición JS (validación,
// valores por defecto) + código Python que se ejecutará dentro de Colab.
const fs = require('fs');
const path = require('path');
const { E } = require('../lib/errors');

const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
const isInt = (v, a, b) => Number.isInteger(v) && v >= a && v <= b;
const isNum = (v, a, b) => typeof v === 'number' && Number.isFinite(v) && v >= a && v <= b;
const PKG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,60}(==[A-Za-z0-9.+!-]{1,30})?$/;

// Opciones comunes a todas las plantillas (validadas aquí una sola vez).
function commonErrors(c) {
  const e = [];
  if (c.checkpointEvery != null && !isInt(c.checkpointEvery, 1, 1e6)) e.push('checkpointEvery debe ser entero 1-1000000');
  if (c.allowInstall != null && typeof c.allowInstall !== 'boolean') e.push('allowInstall debe ser true/false');
  if (c.requirements != null) {
    if (!Array.isArray(c.requirements) || c.requirements.length > 30) e.push('requirements debe ser una lista (máx. 30)');
    else for (const r of c.requirements) if (typeof r !== 'string' || !PKG_RE.test(r)) e.push(`requirements: nombre de paquete inválido "${String(r).slice(0, 40)}"`);
  }
  return e;
}

const TEMPLATES = {
  'demo-counter': {
    description: 'Demostración: cuenta pasos con puntos de recuperación (prueba el flujo completo sin descargar nada).',
    defaults: { steps: 20, sleepSec: 1, checkpointEvery: 5, requirements: [], allowInstall: false },
    validate(c) {
      const e = commonErrors(c);
      if (!isInt(c.steps, 1, 100000)) e.push('steps debe ser entero 1-100000');
      if (!isNum(c.sleepSec, 0, 60)) e.push('sleepSec debe ser número 0-60');
      if (c.failAtStep != null && !isInt(c.failAtStep, 1, 100000)) e.push('failAtStep debe ser entero (solo para pruebas)');
      return e;
    },
    source: () => read('demo-counter.py'),
  },
  'text-batch': {
    description: 'Procesa una lista de textos (uppercase | wordcount | sha256) con reanudación exacta.',
    defaults: { items: [], operation: 'wordcount', checkpointEvery: 10, requirements: [], allowInstall: false },
    validate(c) {
      const e = commonErrors(c);
      if (!Array.isArray(c.items) || c.items.length < 1 || c.items.length > 10000) e.push('items debe ser una lista de 1 a 10000 textos');
      else if (c.items.some((x) => typeof x !== 'string' || x.length > 10000)) e.push('cada item debe ser texto de hasta 10000 caracteres');
      if (!['uppercase', 'wordcount', 'sha256'].includes(c.operation)) e.push('operation debe ser uppercase, wordcount o sha256');
      return e;
    },
    source: () => read('text-batch.py'),
  },
  script: {
    description: 'Su propio código Python: un archivo local que define run(ctx). Se incrusta en el notebook.',
    defaults: { scriptPath: '', checkpointEvery: 1, requirements: [], allowInstall: false },
    validate(c) {
      const e = commonErrors(c);
      if (typeof c.scriptPath !== 'string' || !c.scriptPath || c.scriptPath.includes('\0')) e.push('scriptPath es obligatorio (ruta a un .py)');
      else if (!path.isAbsolute(c.scriptPath)) e.push('scriptPath debe ser una ruta absoluta');
      else if (!c.scriptPath.endsWith('.py')) e.push('scriptPath debe terminar en .py');
      return e;
    },
    // Lee el script del usuario; límite de tamaño configurable.
    source(cfg, limits) {
      let st;
      try { st = fs.statSync(cfg.scriptPath); } catch { throw E.invalid(`No se encuentra el script: ${cfg.scriptPath}`); }
      if (!st.isFile()) throw E.invalid('scriptPath no es un archivo.');
      if (st.size > limits.maxScriptBytes) throw E.limit(`El script supera el límite (${limits.maxScriptBytes} bytes).`);
      const code = fs.readFileSync(cfg.scriptPath, 'utf8');
      if (!/def\s+run\s*\(\s*ctx\s*\)/.test(code)) throw E.invalid('El script debe definir "def run(ctx):".');
      return code;
    },
  },
};

function getTemplate(type) {
  const t = TEMPLATES[type];
  if (!t) throw E.invalid(`Tipo de tarea desconocido: "${String(type).slice(0, 40)}"`, `Tipos disponibles: ${Object.keys(TEMPLATES).join(', ')}`);
  return t;
}

const runtimeSource = () => read('runtime.py');

module.exports = { TEMPLATES, getTemplate, runtimeSource };
