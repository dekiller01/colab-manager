'use strict';
// Reintentos, prevención de duplicados, cancelación y comportamiento sin Colab. Todo LOCAL.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeManager } = require('./helpers/harness');

const prep = (m, name = 't', cfg = { steps: 3, sleepSec: 0 }) => { const t = m.add(name, { config: cfg }); return m.prepareNotebook(t.id); };

test('run: pasa a running/awaiting_start y NO afirma que Colab haya iniciado', async () => {
  const m = makeManager();
  const t = prep(m);
  const { task, launch } = await m.run(t.id);
  assert.equal(task.state, 'running');
  assert.equal(task.phase, 'awaiting_start');
  assert.equal(launch.mode, 'assisted');
  assert.ok(launch.steps.some((s) => /Ejecutar todo/.test(s)));
  assert.equal(task.attempts.length, 1);
});

test('prevención de duplicados: run sobre una tarea running se rechaza', async () => {
  const m = makeManager();
  const t = prep(m);
  await m.run(t.id);
  await assert.rejects(m.run(t.id), (e) => e.code === 'EDUP');
  assert.equal(m.get(t.id).attempts.length, 1, 'no se creó un segundo intento');
});

test('prevención de duplicados: dos run simultáneos → solo uno prospera', async () => {
  const m = makeManager();
  const t = prep(m);
  const results = await Promise.allSettled([m.run(t.id), m.run(t.id), m.run(t.id)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(m.get(t.id).attempts.length, 1);
});

test('prevención de duplicados: tarea activa idéntica se rechaza salvo --allow-duplicate', () => {
  const m = makeManager();
  m.add('igual', { config: { steps: 5 } });
  assert.throws(() => m.add('igual', { config: { steps: 5 } }), (e) => e.code === 'EDUP');
  assert.ok(m.add('igual', { config: { steps: 5 }, allowDuplicate: true }).id);
  assert.ok(m.add('igual', { config: { steps: 6 } }).id, 'config distinta no es duplicado');
});

test('límite de ejecuciones concurrentes', async () => {
  const m = makeManager({ overrides: { limits: { maxConcurrent: 1 } } });
  const a = prep(m, 'a', { steps: 1 });
  const b = prep(m, 'b', { steps: 2 });
  await m.run(a.id);
  await assert.rejects(m.run(b.id), (e) => e.code === 'ELIMIT');
  assert.equal(m.get(b.id).state, 'prepared', 'la segunda no quedó a medias');
});

test('run --force sobre una tarea running abandona el intento anterior', async () => {
  const m = makeManager();
  const t = prep(m);
  await m.run(t.id);
  const { task } = await m.run(t.id, { force: true });
  assert.equal(task.attempts.length, 2);
  assert.equal(task.attempts[0].outcome, 'abandoned');
  assert.equal(task.state, 'running');
});

test('retry: solo failed/cancelled, cuenta reintentos y respeta el límite', async () => {
  const m = makeManager({ overrides: { limits: { maxRetries: 2 } } });
  const t = prep(m);
  assert.throws(() => m.retry(t.id), (e) => e.code === 'ESTATE'); // aún prepared
  for (let i = 1; i <= 2; i++) {
    await m.run(t.id);
    m.mark(t.id, 'failed', { note: `fallo ${i}` });
    const r = m.retry(t.id);
    assert.equal(r.retries, i);
    assert.equal(r.state, 'prepared');
    assert.equal(r.notebookMeta.mode, 'fresh');
    assert.equal(r.notebookMeta.attempt, i + 1);
  }
  await m.run(t.id);
  m.mark(t.id, 'failed');
  assert.throws(() => m.retry(t.id), (e) => e.code === 'ELIMIT');
  assert.equal(m.retry(t.id, { force: true }).retries, 3, '--force excede el límite');
});

test('resume exige un punto de recuperación conocido', async () => {
  const m = makeManager();
  const t = prep(m);
  await m.run(t.id);
  m.mark(t.id, 'failed');
  assert.throws(() => m.resume(t.id), (e) => e.code === 'ESTATE' && /punto de recuperación/.test(e.message));
  m.store.update(t.id, (x) => { x.lastCheckpoint = { step: 4, at: '2026-01-01T00:00:00.000Z' }; });
  const r = m.resume(t.id);
  assert.equal(r.notebookMeta.mode, 'resume');
  assert.equal(r.state, 'prepared');
  const ev = m.logs(t.id).entries.find((e) => e.type === 'recovery_attempt');
  assert.equal(ev.action, 'resume');
  assert.equal(ev.fromStep, 4);
});

test('cancel: tarea prepared se cancela; running genera bandera cooperativa; completed no', async () => {
  const m = makeManager();
  const a = prep(m, 'a', { steps: 1 });
  assert.equal((await m.cancel(a.id)).task.state, 'cancelled');
  const b = prep(m, 'b', { steps: 2 });
  await m.run(b.id);
  const r = await m.cancel(b.id);
  assert.equal(r.task.state, 'cancelled');
  assert.ok(r.info.cooperative);
  assert.ok(fs.existsSync(path.join(m.mirror, b.id, 'cancel.flag')));
  const c = prep(m, 'c', { steps: 3 });
  await m.run(c.id);
  m.mark(c.id, 'completed');
  await assert.rejects(m.cancel(c.id), (e) => e.code === 'ESTATE');
});

test('notebook no se regenera durante la ejecución', async () => {
  const m = makeManager();
  const t = prep(m);
  await m.run(t.id);
  assert.throws(() => m.prepareNotebook(t.id), (e) => e.code === 'ESTATE');
});

test('colab-api / colab-enterprise: función NO implementada, se dice claramente y no se simula éxito', async () => {
  for (const provider of ['colab-api', 'colab-enterprise']) {
    const m = makeManager({ overrides: { provider } });
    const t = prep(m);
    await assert.rejects(m.run(t.id), (e) => e.code === 'EUNSUPPORTED' && e.exit === 3 && /no está implementado/.test(e.message));
    const after = m.get(t.id);
    assert.equal(after.state, 'prepared', 'la reserva se deshizo');
    assert.equal(after.attempts.length, 0);
  }
});

test('sin conexión: crear, preparar, ejecutar (modo asistido), cancelar y listar no necesitan red', async () => {
  const m = makeManager(); // sin canal ni red
  const t = prep(m);
  const { launch } = await m.run(t.id);
  assert.ok(launch.steps.length >= 3);
  assert.equal(m.status().channel, null);
  await assert.rejects(m.sync(), (e) => e.code === 'EUNSUPPORTED' && /canal/.test(e.message));
});

test('los registros y errores no exponen secretos', () => {
  const m = makeManager();
  const t = prep(m);
  m.mark(t.id, 'running');
  const secret = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
  m.mark(t.id, 'failed', { note: `fallo con token=${secret} y Authorization: Bearer abcdef1234567890xyz` });
  const task = m.get(t.id);
  const dump = JSON.stringify(task) + fs.readFileSync(m.store.eventsFile(t.id), 'utf8');
  assert.ok(!dump.includes(secret));
  assert.ok(!dump.includes('abcdef1234567890xyz'));
});

test('cadenas con metacaracteres de shell se guardan como datos inertes', () => {
  const m = makeManager();
  const nasty = 'a"; rm -rf / #$(touch /tmp/pwned)`id`';
  const t = m.add(nasty, { type: 'text-batch', config: { items: [nasty], operation: 'sha256' } });
  assert.equal(m.get(t.id).name, nasty);
  const nb = m.prepareNotebook(t.id);
  assert.ok(fs.existsSync(nb.notebookPath));
  assert.ok(!fs.existsSync('/tmp/pwned'));
});

test('estado de la tarea en el resumen y el monitor no rompe sin tareas', async () => {
  const m = makeManager();
  const s = m.status();
  assert.equal(s.total, 0);
  const r = await m.monitor();
  assert.deepEqual(r.results, []);
});
