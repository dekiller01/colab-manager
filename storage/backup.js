'use strict';
// Copia de seguridad y restauración con tar (disponible en Termux: pkg install tar).
// La restauración valida el contenido ANTES de tocar los datos actuales, y conserva
// lo existente como *.pre-restore-<fecha> (nunca borra).
const fs = require('fs');
const path = require('path');
const { E } = require('../lib/errors');
const { randomHex } = require('../lib/util');
const { taskProblems } = require('../jobs/schema');

const TOP = ['config.json', 'jobs', 'notebooks', 'sync'];
const stamp = (d) => d.toISOString().replace(/[:.]/g, '-');

async function tar(exec, args) {
  const r = await exec('tar', args, { timeoutMs: 300000 });
  if (r.error) throw E.unsupported(r.error.code === 'ENOENT' ? 'tar no está instalado.' : `tar falló: ${r.error.message}`, 'Instale con: pkg install tar');
  if (r.code !== 0) throw E.invalid(`tar terminó con error: ${(r.stderr || '').slice(-300)}`);
  return r.stdout;
}

async function backup(home, exec, { out, now = new Date() } = {}) {
  const entries = TOP.filter((e) => fs.existsSync(path.join(home, e)));
  if (!entries.length) throw E.state('No hay datos que respaldar.');
  const file = out ? path.resolve(out) : path.join(home, 'backups', `colab-manager-${stamp(now)}.tar.gz`);
  if (fs.existsSync(file)) throw E.invalid(`Ya existe ${file}. No se sobrescribe.`);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  await tar(exec, ['-czf', file, '--exclude=.lock', '--exclude=*.tmp', '-C', home, ...entries]);
  return { file, bytes: fs.statSync(file).size, entries };
}

async function restore(home, exec, archive, { now = new Date() } = {}) {
  const file = path.resolve(archive);
  if (!fs.existsSync(file)) throw E.notFound(`No existe ${file}`);
  const names = (await tar(exec, ['-tzf', file])).split('\n').filter(Boolean);
  const verbose = (await tar(exec, ['-tzvf', file])).split('\n').filter(Boolean);
  if (!names.length) throw E.invalid('El archivo está vacío.');
  for (const n of names) {
    const clean = n.replace(/^\.\//, '');
    if (path.isAbsolute(clean) || clean.split('/').includes('..') || !TOP.includes(clean.split('/')[0])) throw E.invalid(`Entrada no permitida en la copia: ${n}`, 'Solo se restauran config.json, jobs, notebooks y sync.');
  }
  if (verbose.some((l) => !/^[-d]/.test(l))) throw E.invalid('La copia contiene enlaces o archivos especiales; se rechaza por seguridad.');

  const tmp = path.join(home, `.restore-${randomHex(4)}`);
  fs.mkdirSync(tmp, { mode: 0o700 });
  try {
    await tar(exec, ['-xzf', file, '-C', tmp, '--no-same-owner']);
    const jobsDir = path.join(tmp, 'jobs');
    let tasks = 0;
    if (fs.existsSync(jobsDir)) {
      for (const f of fs.readdirSync(jobsDir)) {
        if (!/^t-[0-9a-f]{8}\.json$/.test(f)) continue;
        let d;
        try { d = JSON.parse(fs.readFileSync(path.join(jobsDir, f), 'utf8')); } catch { throw E.corrupt(`La copia contiene un registro dañado: ${f}`); }
        const p = taskProblems(d);
        if (p.length) throw E.corrupt(`La copia contiene un registro inválido (${f}: ${p.join(', ')}).`);
        tasks++;
      }
    }
    const restored = [];
    for (const e of TOP) {
      const src = path.join(tmp, e);
      if (!fs.existsSync(src)) continue;
      const dst = path.join(home, e);
      if (fs.existsSync(dst)) fs.renameSync(dst, `${dst}.pre-restore-${stamp(now)}`);
      fs.renameSync(src, dst);
      restored.push(e);
    }
    return { restored, tasks };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { backup, restore };
