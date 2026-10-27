'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { backup, restore } = require('../storage/backup');
const { exec } = require('../lib/exec');
const { makeManager, tmpDir, HAS_TAR } = require('./helpers/harness');
const { redact } = require('../logs/redact');
const { safeJoin } = require('../lib/util');
const { validateConfig, DEFAULTS, merge } = require('../config');

test('copia de seguridad y restauración completas', { skip: !HAS_TAR }, async () => {
  const m = makeManager();
  const t = m.add('respaldo', { config: { steps: 2, sleepSec: 0 } });
  m.prepareNotebook(t.id);
  const b = await backup(m.home, exec);
  assert.ok(fs.existsSync(b.file));
  await assert.rejects(backup(m.home, exec, { out: b.file }), /No se sobrescribe/);
  m.delete(t.id); // se "pierde" la tarea
  assert.equal(m.list().length, 0);
  const r = await restore(m.home, exec, b.file);
  assert.ok(r.restored.includes('jobs'));
  assert.equal(m.list().length, 1);
  assert.equal(m.list()[0].name, 'respaldo');
  assert.ok(fs.readdirSync(m.home).some((f) => f.startsWith('jobs.pre-restore-')), 'lo previo se conserva');
});

test('restore rechaza copias con rutas peligrosas, enlaces o registros dañados', { skip: !HAS_TAR }, async () => {
  const m = makeManager();
  const work = tmpDir();
  // 1) ruta fuera de las permitidas
  fs.mkdirSync(path.join(work, 'x'));
  fs.writeFileSync(path.join(work, 'x', 'evil.txt'), 'x');
  const a1 = path.join(work, 'a1.tar.gz');
  spawnSync('tar', ['-czf', a1, '-C', work, 'x']);
  await assert.rejects(restore(m.home, exec, a1), /no permitida/);
  // 2) traversal con ..
  const a2 = path.join(work, 'a2.tar.gz');
  spawnSync('tar', ['-czf', a2, '-C', path.join(work, 'x'), '--transform', 's,evil.txt,jobs/../../evil.txt,', 'evil.txt']);
  await assert.rejects(restore(m.home, exec, a2));
  // 3) enlace simbólico dentro de jobs/
  fs.mkdirSync(path.join(work, 'jobs'));
  fs.symlinkSync('/etc/passwd', path.join(work, 'jobs', 'link'));
  const a3 = path.join(work, 'a3.tar.gz');
  spawnSync('tar', ['-czf', a3, '-C', work, 'jobs']);
  await assert.rejects(restore(m.home, exec, a3), /enlaces/);
  fs.rmSync(path.join(work, 'jobs'), { recursive: true });
  // 4) registro dañado
  fs.mkdirSync(path.join(work, 'jobs'));
  fs.writeFileSync(path.join(work, 'jobs', 't-aaaaaaaa.json'), '{rota');
  const a4 = path.join(work, 'a4.tar.gz');
  spawnSync('tar', ['-czf', a4, '-C', work, 'jobs']);
  await assert.rejects(restore(m.home, exec, a4), (e) => e.code === 'ECORRUPT');
  assert.equal(m.list().length, 0, 'los datos actuales no se tocaron');
  assert.ok(!fs.readdirSync(m.home).some((f) => f.startsWith('.restore-')), 'sin residuos temporales');
});

test('redacción de secretos conocidos', () => {
  const cases = ['ghp_' + 'a'.repeat(36), 'github_pat_' + 'B'.repeat(40), 'ya29.' + 'c'.repeat(40), 'AIza' + 'D'.repeat(35), 'sk-' + 'e'.repeat(30)];
  for (const s of cases) assert.ok(!redact(`x ${s} y`).includes(s), s.slice(0, 8));
  assert.ok(!redact('password=hunter2hunter2').includes('hunter2'));
  assert.ok(!redact('Authorization: Bearer abcdefghijkl').includes('abcdefghijkl'));
  assert.equal(redact('texto normal sin secretos'), 'texto normal sin secretos');
});

test('safeJoin impide salir del directorio base', () => {
  const base = tmpDir();
  assert.ok(safeJoin(base, 'a', 'b').startsWith(base));
  for (const bad of ['..', '../x', 'a/../../x', '/etc/passwd', 'a\0b']) assert.throws(() => safeJoin(base, bad), (e) => e.code === 'EINVAL', bad);
});

test('config: valores por defecto válidos; secretos y rangos rechazados', () => {
  assert.deepEqual(validateConfig(DEFAULTS), []);
  const bad = merge(DEFAULTS, { dekiller: { apiToken: 'abc123' }, limits: { maxRetries: -1 }, channel: { type: 'folder', path: 'relativa' } });
  const errs = validateConfig(bad).join('\n');
  assert.match(errs, /secreto/);
  assert.match(errs, /maxRetries/);
  assert.match(errs, /ruta absoluta/);
  assert.deepEqual(validateConfig(merge(DEFAULTS, { dekiller: { tokenEnv: 'COLABCTL_API_TOKEN' } })), [], 'tokenEnv (nombre de variable) está permitido');
});

test('.gitignore excluye secretos y datos; config de ejemplo no contiene credenciales', () => {
  const gi = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
  for (const p of ['.env', 'rclone.conf', 'client_secret*.json', 'credentials*.json', 'config.json']) assert.ok(gi.includes(p), p);
  const ex = fs.readFileSync(path.join(__dirname, '..', 'config', 'config.example.json'), 'utf8');
  assert.deepEqual(validateConfig(merge(DEFAULTS, JSON.parse(ex))), []);
  assert.ok(!/ya29\.|AIza|ghp_|password"\s*:\s*"[^"]/.test(ex));
});
