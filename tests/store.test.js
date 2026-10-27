'use strict';
// Fase 1 — pruebas LOCALES: persistencia, validación, estados, recuperación de archivos dañados.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Manager } = require('../jobs/manager');
const { assertTransition, canTransition, STATES, TRANSITIONS } = require('../jobs/states');
const { parseIdInput, validateName } = require('../lib/validate');
const { writeJson, readJson, readJsonl, appendLine } = require('../storage/atomic');
const { acquire } = require('../storage/lock');
const { scanStore } = require('../recovery/recovery');
const { makeManager, tmpDir } = require('./helpers/harness');

test('creación y listado de tareas', () => {
  const m = makeManager();
  const a = m.add('Primera', { config: { steps: 3, sleepSec: 0 } });
  const b = m.add('Segunda', { type: 'text-batch', config: { items: ['a b', 'c'], operation: 'wordcount' } });
  const list = m.list();
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((t) => t.id).sort(), [a.id, b.id].sort());
  assert.equal(a.state, 'pending');
  assert.match(a.id, /^t-[0-9a-f]{8}$/);
  assert.equal(m.list({ state: 'pending' }).length, 2);
  assert.equal(m.list({ state: 'running' }).length, 0);
  assert.throws(() => m.list({ state: 'inventado' }), /Estado inválido/);
});

test('campos mínimos de la tarea', () => {
  const t = makeManager().add('x', {});
  for (const k of ['id', 'name', 'type', 'state', 'createdAt', 'updatedAt', 'config', 'notebookPath', 'resultsPath', 'lastCheckpoint', 'error', 'attempts']) assert.ok(k in t, `falta ${k}`);
});

test('persistencia después de reiniciar el programa (nueva instancia, mismo directorio)', () => {
  const home = tmpDir();
  const m1 = makeManager({ home });
  const t = m1.add('Persistente', { config: { steps: 2, sleepSec: 0 } });
  m1.prepareNotebook(t.id);
  const m2 = Manager.open(home); // "reinicio"
  const again = m2.get(t.id);
  assert.equal(again.name, 'Persistente');
  assert.equal(again.state, 'prepared');
  assert.ok(fs.existsSync(again.notebookPath));
});

test('validación de identificadores y prefijos', () => {
  assert.deepEqual(parseIdInput('t-0a1b2c3d'), { exact: 't-0a1b2c3d' });
  assert.deepEqual(parseIdInput('0a1b'), { prefix: 't-0a1b' });
  for (const bad of ['', '..', '../etc/passwd', 't-xyz', 'a', 't-0a1b2c3d4e', 't-0a1b2c3d; rm -rf /', '$(id)', 'T-ZZZZZZZZ', null, 42]) {
    assert.throws(() => parseIdInput(bad), (e) => e.code === 'EINVAL', `debía rechazar ${JSON.stringify(bad)}`);
  }
  const m = makeManager();
  const t = m.add('p', {});
  assert.equal(m.get(t.id.slice(0, 5)).id, t.id); // prefijo único
  assert.throws(() => m.get('t-ffffffff'), (e) => e.code === 'ENOTFOUND');
});

test('prefijo ambiguo se rechaza', () => {
  const m = makeManager();
  const a = m.add('a', { config: { steps: 1 } });
  const raw = JSON.parse(fs.readFileSync(m.store.taskFile(a.id), 'utf8'));
  for (const id of ['t-abc00001', 't-abc00002']) {
    fs.writeFileSync(m.store.taskFile(id), JSON.stringify({ ...raw, id }));
  }
  assert.throws(() => m.get('abc'), (e) => e.code === 'EINVAL' && /ambiguo/.test(e.message));
  assert.equal(m.get('abc00001').id, 't-abc00001');
});

test('validación de nombre y de tipo/configuración', () => {
  const m = makeManager();
  assert.throws(() => m.add('', {}), /entre 1 y 80/);
  assert.throws(() => m.add('x'.repeat(81), {}), /entre 1 y 80/);
  assert.throws(() => m.add('mal\u0007nombre', {}), /control/);
  assert.throws(() => m.add('ok', { type: 'no-existe' }), /Tipo de tarea desconocido/);
  assert.throws(() => m.add('ok', { config: { steps: -1 } }), /steps/);
  assert.throws(() => m.add('ok', { type: 'text-batch', config: { items: [], operation: 'wordcount' } }), /items/);
  assert.throws(() => m.add('ok', { config: { requirements: ['--index-url=http://evil'] } }), /requirements/);
  assert.throws(() => m.add('ok', { config: { requirements: ['pkg; rm -rf /'] } }), /requirements/);
  assert.throws(() => m.add('ok', { config: { blob: 'x'.repeat(70000) } }), (e) => e.code === 'ELIMIT');
});

test('transiciones válidas e inválidas entre estados', () => {
  assert.deepEqual(STATES, ['pending', 'prepared', 'running', 'completed', 'failed', 'cancelled']);
  const valid = [['pending', 'prepared'], ['prepared', 'running'], ['running', 'completed'], ['running', 'failed'], ['running', 'cancelled'], ['failed', 'prepared'], ['cancelled', 'prepared'], ['pending', 'cancelled']];
  for (const [a, b] of valid) assert.ok(canTransition(a, b), `${a}→${b} debería ser válida`);
  const invalid = [['pending', 'running'], ['pending', 'completed'], ['completed', 'running'], ['completed', 'pending'], ['failed', 'running'], ['failed', 'completed'], ['cancelled', 'running'], ['prepared', 'completed']];
  for (const [a, b] of invalid) assert.throws(() => assertTransition(a, b), (e) => e.code === 'ESTATE', `${a}→${b} debería rechazarse`);
  for (const s of STATES) for (const to of TRANSITIONS[s]) assert.ok(STATES.includes(to));
  const m = makeManager();
  const t = m.add('t', {});
  assert.throws(() => m.mark(t.id, 'completed'), (e) => e.code === 'ESTATE'); // pending→completed
  assert.throws(() => m.mark(t.id, 'inventado'), (e) => e.code === 'EINVAL');
});

test('escritura atómica: sin temporales y con copia .bak', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'a.json');
  writeJson(f, { v: 1 });
  writeJson(f, { v: 2 });
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { v: 2 });
  assert.deepEqual(JSON.parse(fs.readFileSync(f + '.bak', 'utf8')), { v: 1 });
  assert.equal(fs.readdirSync(dir).filter((x) => x.endsWith('.tmp')).length, 0);
  assert.equal(fs.statSync(f).mode & 0o077, 0, 'permisos restringidos al usuario');
});

test('recuperación de registro dañado desde .bak (y el dañado se conserva apartado)', () => {
  const m = makeManager();
  const t = m.add('frágil', {});
  m.prepareNotebook(t.id); // genera un .bak
  fs.writeFileSync(m.store.taskFile(t.id), '{"id": "t-trunca'); // simula corte de energía a mitad de escritura
  const scan = scanStore(m.store);
  assert.equal(scan.recovered.length, 1);
  assert.equal(scan.unrecoverable.length, 0);
  const back = m.get(t.id);
  assert.equal(back.name, 'frágil');
  const corrupt = fs.readdirSync(m.store.dirs.jobs).filter((f) => f.includes('.corrupt-'));
  assert.equal(corrupt.length, 1, 'el archivo dañado se aparta, no se borra');
});

test('registro dañado sin copia válida: error claro y el resto de tareas sigue funcionando', () => {
  const m = makeManager();
  const bad = m.add('malo', { config: { steps: 1 } });
  const ok = m.add('bueno', { config: { steps: 2 } });
  fs.writeFileSync(m.store.taskFile(bad.id), 'basura');
  const scan = scanStore(m.store);
  assert.equal(scan.unrecoverable.length, 1);
  assert.equal(scan.unrecoverable[0].id, bad.id);
  assert.deepEqual(m.list().map((t) => t.id), [ok.id]);
  assert.throws(() => m.get(bad.id), (e) => e.code === 'ECORRUPT' || e.code === 'ENOTFOUND');
});

test('registro con estructura inválida (JSON válido pero esquema roto) se trata como dañado', () => {
  const m = makeManager();
  const t = m.add('x', {});
  m.prepareNotebook(t.id);
  const raw = JSON.parse(fs.readFileSync(m.store.taskFile(t.id), 'utf8'));
  raw.state = 'volando';
  fs.writeFileSync(m.store.taskFile(t.id), JSON.stringify(raw));
  assert.equal(m.get(t.id).state, 'pending'); // se restauró desde .bak (versión anterior válida)
});

test('registros de eventos JSONL: línea truncada se omite y se cuenta', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'e.jsonl');
  appendLine(f, { a: 1 });
  appendLine(f, { a: 2 });
  fs.appendFileSync(f, '{"a": 3, "trunc');
  const r = readJsonl(f);
  assert.equal(r.records.length, 2);
  assert.equal(r.bad, 1);
});

test('errores quedan registrados en el historial de la tarea', () => {
  const m = makeManager();
  const t = m.add('e', {});
  m.prepareNotebook(t.id);
  m.mark(t.id, 'running');
  const f = m.mark(t.id, 'failed', { note: 'se cayó la red' });
  assert.equal(f.error.code, 'manual');
  assert.match(f.error.message, /se cayó la red/);
  const ev = m.logs(t.id).entries.map((e) => e.type);
  assert.ok(ev.includes('created') && ev.includes('marked'));
});

test('bloqueo entre procesos: segundo acceso espera/falla; bloqueo viejo se recupera', () => {
  const dir = tmpDir();
  const lock = path.join(dir, '.lock');
  const release = acquire(lock);
  assert.throws(() => acquire(lock, { waitMs: 150 }), (e) => e.code === 'EBUSY');
  release();
  fs.writeFileSync(lock, JSON.stringify({ pid: 999999, at: Date.now() })); // dueño muerto
  const r2 = acquire(lock, { waitMs: 500 });
  r2();
});

test('eliminar mueve a trash (recuperable) y exige --force si está running', () => {
  const m = makeManager();
  const t = m.add('borrar', {});
  m.prepareNotebook(t.id);
  m.mark(t.id, 'running');
  assert.throws(() => m.delete(t.id), (e) => e.code === 'ESTATE');
  const r = m.delete(t.id, { force: true });
  assert.ok(fs.existsSync(path.join(r.trashedTo, `${t.id}.json`)));
  assert.equal(m.list().length, 0);
});
