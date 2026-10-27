'use strict';
const { E } = require('./errors');

// Analizador mínimo y estricto: rechaza opciones desconocidas (evita errores silenciosos).
// spec: { str: ['type'], bool: ['force'], alias: { y: 'yes' } }
function parseArgs(argv, spec = {}) {
  const str = new Set([...(spec.str || []), 'home']);
  const bool = new Set([...(spec.bool || []), 'json', 'yes', 'help']);
  const alias = { y: 'yes', h: 'help', ...(spec.alias || {}) };
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--') || (a.startsWith('-') && a.length === 2 && /[a-z]/i.test(a[1]))) {
      let val = null;
      let name;
      if (a.startsWith('--')) {
        const eq = a.indexOf('=');
        if (eq > 0) { val = a.slice(eq + 1); a = a.slice(0, eq); }
        name = a.slice(2);
      } else name = alias[a[1]] || a[1];
      if (bool.has(name)) {
        if (val !== null) throw E.invalid(`La opción --${name} no lleva valor.`);
        flags[name] = true;
      } else if (str.has(name)) {
        if (val === null) {
          val = argv[++i];
          if (val === undefined) throw E.invalid(`Falta el valor de --${name}.`);
        }
        flags[name] = val;
      } else throw E.invalid(`Opción desconocida: ${a}`, 'Use "colabctl help".');
    } else pos.push(a);
  }
  return { pos, flags };
}

function intFlag(v, name, min, max, dflt) {
  if (v == null) return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw E.invalid(`--${name} debe ser un entero entre ${min} y ${max}.`);
  return n;
}

module.exports = { parseArgs, intFlag };
