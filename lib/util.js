'use strict';
const crypto = require('crypto');
const path = require('path');
const { E } = require('./errors');

const randomHex = (n) => crypto.randomBytes(n).toString('hex');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function stableStringify(v) {
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Une rutas garantizando que el resultado queda DENTRO de base.
function safeJoin(base, ...parts) {
  for (const p of parts) {
    if (typeof p !== 'string' || p.includes('\0')) throw E.invalid('Ruta inválida.');
  }
  const root = path.resolve(base);
  const full = path.resolve(root, ...parts);
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw E.invalid('La ruta sale del directorio permitido.');
  }
  return full;
}

function fmtAge(ms) {
  if (ms == null || Number.isNaN(ms)) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 120) return `${m}min`;
  const h = Math.round((m / 60) * 10) / 10;
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

const isoOf = (d) => new Date(d).toISOString();

module.exports = { randomHex, sha256, stableStringify, sleepSync, safeJoin, fmtAge, isoOf };
