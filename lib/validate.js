'use strict';
const { E } = require('./errors');
const { ID_RE } = require('../jobs/schema');

// Acepta el ID completo (t-1a2b3c4d) o un prefijo único (1a2b, t-1a2b).
function parseIdInput(input) {
  if (typeof input !== 'string') throw E.invalid('Falta el ID de la tarea.', 'Use "colabctl list" para ver los IDs.');
  const s = input.trim().toLowerCase();
  if (ID_RE.test(s)) return { exact: s };
  const m = /^(?:t-)?([0-9a-f]{3,8})$/.exec(s);
  if (!m) throw E.invalid(`ID inválido: "${input.slice(0, 40)}"`, 'Formato: t-1a2b3c4d (o un prefijo de al menos 3 caracteres hexadecimales).');
  return { prefix: 't-' + m[1] };
}

function validateName(name) {
  if (typeof name !== 'string') throw E.invalid('Falta el nombre de la tarea.');
  const n = name.trim();
  if (n.length < 1 || n.length > 80) throw E.invalid('El nombre debe tener entre 1 y 80 caracteres.');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(n)) throw E.invalid('El nombre no puede contener caracteres de control.');
  return n;
}

function parseJsonObject(text, what = 'JSON') {
  let v;
  try { v = JSON.parse(text); } catch (e) { throw E.invalid(`${what} no es JSON válido: ${e.message}`); }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw E.invalid(`${what} debe ser un objeto JSON.`);
  return v;
}

module.exports = { parseIdInput, validateName, parseJsonObject };
