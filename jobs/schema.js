'use strict';
const { STATES } = require('./states');

const ID_RE = /^t-[0-9a-f]{8}$/;
const isIso = (s) => typeof s === 'string' && !Number.isNaN(Date.parse(s));

// Devuelve lista de problemas (vacía = válido). Se usa al leer: un registro
// con estructura inválida se considera dañado y se recupera desde .bak.
function taskProblems(t) {
  const p = [];
  if (!t || typeof t !== 'object' || Array.isArray(t)) return ['no es un objeto'];
  if (t.schemaVersion !== 1) p.push('schemaVersion');
  if (!ID_RE.test(t.id || '')) p.push('id');
  if (typeof t.name !== 'string' || !t.name.length) p.push('name');
  if (typeof t.type !== 'string') p.push('type');
  if (!STATES.includes(t.state)) p.push('state');
  if (!isIso(t.createdAt)) p.push('createdAt');
  if (!isIso(t.updatedAt)) p.push('updatedAt');
  if (!t.config || typeof t.config !== 'object' || Array.isArray(t.config)) p.push('config');
  if (!Array.isArray(t.attempts)) p.push('attempts');
  if (!Number.isInteger(t.retries) || t.retries < 0) p.push('retries');
  for (const k of ['notebookPath', 'resultsPath']) if (t[k] != null && typeof t[k] !== 'string') p.push(k);
  if (t.lastCheckpoint != null && typeof t.lastCheckpoint !== 'object') p.push('lastCheckpoint');
  if (t.error != null && (typeof t.error !== 'object' || typeof t.error.message !== 'string')) p.push('error');
  return p;
}

module.exports = { ID_RE, taskProblems };
