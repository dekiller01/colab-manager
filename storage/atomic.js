'use strict';
// Escrituras seguras ante cierres inesperados de Termux:
//   1) se escribe a un archivo temporal + fsync
//   2) si el archivo anterior era válido, se conserva como .bak
//   3) rename atómico sobre el destino
// Lecturas: si el archivo principal está dañado, se usa .bak y el dañado se
// aparta como *.corrupt-<fecha> (nunca se borra silenciosamente).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { E } = require('../lib/errors');

function fsyncDir(dir) {
  try {
    const fd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch { /* algunos sistemas de archivos (Android/FUSE) no lo permiten */ }
}

function writeFileAtomic(file, data, mode = 0o600) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'w', mode);
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  fsyncDir(dir);
}

const parses = (file) => {
  try { JSON.parse(fs.readFileSync(file, 'utf8')); return true; } catch { return false; }
};

function writeJson(file, obj) {
  const text = JSON.stringify(obj, null, 2) + '\n';
  if (fs.existsSync(file) && parses(file)) {
    try { fs.copyFileSync(file, file + '.bak'); } catch { /* mejor esfuerzo */ }
  }
  writeFileAtomic(file, text);
}

function quarantine(file, now = new Date()) {
  const dest = `${file}.corrupt-${now.toISOString().replace(/[:.]/g, '-')}`;
  try { fs.renameSync(file, dest); return dest; } catch { return null; }
}

// Devuelve null si no existe ni principal ni .bak.
// { data, source: 'primary'|'backup', recoveredFrom?: rutaCuarentena }
function readJson(file, { validate = () => true, now = new Date() } = {}) {
  const tryRead = (f) => {
    let raw;
    try { raw = fs.readFileSync(f, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return { missing: true }; return { bad: true }; }
    try {
      const d = JSON.parse(raw);
      return validate(d) ? { data: d } : { bad: true };
    } catch { return { bad: true }; }
  };
  const main = tryRead(file);
  if (main.data !== undefined) return { data: main.data, source: 'primary' };
  const bak = tryRead(file + '.bak');
  if (main.missing && bak.missing) return null;
  if (bak.data !== undefined) {
    let q = null;
    if (!main.missing) q = quarantine(file, now);
    writeFileAtomic(file, JSON.stringify(bak.data, null, 2) + '\n');
    return { data: bak.data, source: 'backup', recoveredFrom: q };
  }
  const q = main.missing ? null : quarantine(file, now);
  throw E.corrupt(`Archivo dañado y sin copia válida: ${path.basename(file)}${q ? ` (apartado como ${path.basename(q)})` : ''}`,
    'Restaure desde una copia de seguridad: colabctl restore ARCHIVO');
}

function appendLine(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, JSON.stringify(obj) + '\n', { mode: 0o600 });
}

// Lectura tolerante de JSONL: salta líneas dañadas (p. ej. última línea truncada).
function readJsonl(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return { records: [], bad: 0 }; }
  const records = [];
  let bad = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch { bad++; }
  }
  return { records, bad };
}

module.exports = { writeFileAtomic, writeJson, readJson, appendLine, readJsonl, quarantine };
