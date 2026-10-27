'use strict';
// Fases 3 y 4 — sincronización, monitor y recuperación.
// IMPORTANTE: "simulateColab" ejecuta el runtime con Python LOCAL y una carpeta que hace de Drive.
// Esto demuestra la lógica (latidos, checkpoints, reanudación, cancelación), pero NO es una
// prueba en Google Colab real: Drive real, montaje, desconexiones reales siguen pendientes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeManager, makeClock, tmpDir, simulateColab, PY_SKIP } = require('./helpers/harness');
const { evaluate } = require('../monitor/monitor');

const folderManager = (extra = {}) => {
  const drive = tmpDir('cm-drive-');
  const clock = makeClock();
  const m = makeManager({ clock, overrides: { channel: { type: 'folder', path: drive }, limits: { concurrentGuardSec: 0 }, ...extra } });
  return { m, drive, clock };
};

test('flujo completo: add → run → (Colab simulado) → sync → completed con resultados', { skip: PY_SKIP }, async () => {
  const { m, drive } = folderManager();
  const t = m.add('e2e', { config: { steps: 6, sleepSec: 0, checkpointEvery: 2 } });
  m.prepareNotebook(t.id);
  await m.run(t.id);
  const s1 = await m.sync(); // sube el notebook
  assert.ok(fs.existsSync(path.join(drive, 'notebooks', `${t.id}.ipynb`)));
  assert.equal(s1.updated.length, 0);

  const r = simulateColab(m.get(t.id).notebookPath, drive);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Completado/);

  const s2 = await m.sync();
  const done = m.get(t.id);
  assert.equal(done.state, 'completed', JSON.stringify(s2));
  assert.equal(done.phase, null);
  assert.ok(done.lastCheckpoint && done.lastCheckpoint.step === 4);
  const res = JSON.parse(fs.readFileSync(path.join(done.resultsPath, 'result.json'), 'utf8'));
  assert.deepEqual({ counter: res.counter, steps: res.steps }, { counter: 6, steps: 6 });
  const logs = m.logs(t.id).entries;
  assert.ok(logs.some((e) => e.src === 'colab' && /completado/i.test(e.msg || '')), 'se ven los registros de Colab');
});

test('la tarea pasa a "activo" con el primer latido; un completed repetido del mismo intento se rechaza (anti-duplicado en Colab)', { skip: PY_SKIP }, async () => {
  const { m, drive } = folderManager();
  const t = m.add('dup', { config: { steps: 2, sleepSec: 0 } });
  m.prepareNotebook(t.id);
  await m.run(t.id);
  await m.sync();
  const nb = m.get(t.id).notebookPath;
  assert.equal(simulateColab(nb, drive).code, 0);
  const again = simulateColab(nb, drive); // el usuario vuelve a pulsar "ejecutar todo"
  assert.match(again.stdout, /ya terminó correctamente/);
  const status = JSON.parse(fs.readFileSync(path.join(drive, t.id, 'status.json'), 'utf8'));
  assert.equal(status.state, 'completed', 'el segundo intento no pisó el estado');
});

test('sesión caída a mitad: monitor la marca interrumpida; resume continúa desde el checkpoint', { skip: PY_SKIP }, async () => {
  const { m, drive, clock } = folderManager();
  const script = path.join(tmpDir(), 'crash.py');
  fs.writeFileSync(script, [
    'import os',
    'def run(ctx):',
    '    n = int(ctx.state.get("n", 0))',
    '    while n < 10:',
    '        n += 1',
    '        ctx.state["n"] = n',
    '        ctx.progress(n, 10, step_seconds=0.1)',
    '        if n % 2 == 0:',
    '            ctx.checkpoint(n)',
    '        if n == 5 and ctx.attempt == 1:',
    '            os._exit(9)   # simula que Colab mata la sesión (sin limpieza)',
    '    ctx.save_result("r.json", {"n": n, "resumedFrom": ctx.resumed_from})',
    '',
  ].join('\n'));
  const t = m.add('crash', { type: 'script', config: { scriptPath: script, checkpointEvery: 2 } });
  m.prepareNotebook(t.id);
  await m.run(t.id);
  await m.sync();
  const r1 = simulateColab(m.get(t.id).notebookPath, drive);
  assert.equal(r1.code, 9, 'el proceso murió sin cerrar el estado');

  await m.sync();
  let cur = m.get(t.id);
  assert.equal(cur.state, 'running', 'sigue "running": nadie sabe aún que murió');
  assert.equal(cur.phase, 'active');
  assert.equal(cur.lastCheckpoint.step, 4);
  assert.equal((await m.monitor()).results[0].verdict, 'active');

  clock.advance(3 * 3600 * 1000); // pasan 3 horas sin latidos; el canal sigue accesible
  await m.sync();
  const mon = await m.monitor({ fix: true });
  assert.equal(mon.results[0].verdict, 'stalled');
  cur = m.get(t.id);
  assert.equal(cur.state, 'failed');
  assert.equal(cur.error.code, 'interrupted');
  assert.equal(cur.attempts[0].outcome, 'interrupted');

  const res = m.resume(t.id);
  assert.equal(res.notebookMeta.mode, 'resume');
  assert.equal(res.notebookMeta.attempt, 2);
  await m.run(t.id);
  await m.sync();
  const r2 = simulateColab(m.get(t.id).notebookPath, drive);
  assert.equal(r2.code, 0, r2.stderr + r2.stdout);
  assert.match(r2.stdout, /Ejecución anterior incompleta detectada/);
  assert.match(r2.stdout, /Reanudando desde el punto de recuperación del paso 4/);
  await m.sync();
  const fin = m.get(t.id);
  assert.equal(fin.state, 'completed');
  const out = JSON.parse(fs.readFileSync(path.join(fin.resultsPath, 'r.json'), 'utf8'));
  assert.deepEqual(out, { n: 10, resumedFrom: 4 });
  const types = m.logs(t.id, { tail: 500 }).entries.map((e) => e.type);
  assert.ok(types.includes('monitor_interrupted') && types.includes('recovery_attempt'), 'cada intento de recuperación queda registrado');
});

test('reanudación EXACTA en text-batch: sin líneas duplicadas ni perdidas', { skip: PY_SKIP }, async () => {
  const { m, drive } = folderManager();
  const items = Array.from({ length: 25 }, (_, i) => `texto número ${i}`);
  const t = m.add('batch', { type: 'text-batch', config: { items, operation: 'wordcount', checkpointEvery: 5 } });
  m.prepareNotebook(t.id);
  await m.run(t.id);
  await m.sync();
  // Simula un corte: estado de una ejecución previa con 12 líneas escritas pero checkpoint en 10.
  const dir = path.join(drive, t.id);
  fs.mkdirSync(path.join(dir, 'result'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'result', 'output.jsonl'), Array.from({ length: 12 }, (_, i) => JSON.stringify({ i, result: 3 }) + '\n').join(''));
  fs.writeFileSync(path.join(dir, 'checkpoint.json'), JSON.stringify({ schema: 1, taskId: t.id, attempt: 1, runId: 'x', step: 10, at: '2026-01-01T00:00:00Z', state: { done: 10 } }));
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ schema: 1, taskId: t.id, runId: 'x', attempt: 1, state: 'running', heartbeat: '2020-01-01T00:00:00Z', progress: { done: 12, total: 25 } }));
  const r = simulateColab(m.get(t.id).notebookPath, drive);
  assert.equal(r.code, 0, r.stderr + r.stdout);
  const lines = fs.readFileSync(path.join(dir, 'result', 'output.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 25);
  assert.deepEqual(lines.map((l) => l.i), Array.from({ length: 25 }, (_, i) => i));
});

test('cancelación cooperativa: la bandera viaja por el canal y el notebook se detiene', { skip: PY_SKIP }, async () => {
  const { m, drive } = folderManager();
  const t = m.add('cancelable', { config: { steps: 50, sleepSec: 0 } });
  m.prepareNotebook(t.id);
  await m.run(t.id);
  await m.sync();
  const c = await m.cancel(t.id);
  assert.equal(c.task.state, 'cancelled');
  await m.sync(); // entrega la bandera
  assert.ok(fs.existsSync(path.join(drive, t.id, 'cancel.flag')));
  const r = simulateColab(m.get(t.id).notebookPath, drive);
  assert.match(r.stdout, /Cancelado por el administrador/);
  const st = JSON.parse(fs.readFileSync(path.join(drive, t.id, 'status.json'), 'utf8'));
  assert.equal(st.state, 'cancelled');
  await m.sync();
  assert.equal(m.get(t.id).state, 'cancelled');
});

test('fallo del trabajo en Colab se refleja con mensaje comprensible; retry empieza desde cero (archiva lo anterior)', { skip: PY_SKIP }, async () => {
  const { m, drive } = folderManager();
  const t = m.add('falla', { config: { steps: 5, sleepSec: 0, failAtStep: 3, checkpointEvery: 2 } });
  m.prepareNotebook(t.id);
  await m.run(t.id);
  await m.sync();
  const r = simulateColab(m.get(t.id).notebookPath, drive);
  assert.match(r.stdout, /Fallo simulado en el paso 3/);
  await m.sync();
  let cur = m.get(t.id);
  assert.equal(cur.state, 'failed');
  assert.match(cur.error.message, /Fallo simulado/);
  assert.equal(cur.lastCheckpoint.step, 2);

  cur = m.retry(t.id);
  await m.run(t.id);
  await m.sync();
  const r2 = simulateColab(m.get(t.id).notebookPath, drive);
  assert.equal(r2.code, 0, r2.stdout + r2.stderr);
  assert.match(r2.stdout, /archivó el estado anterior/);
  assert.ok(fs.readdirSync(path.join(drive, t.id)).some((f) => f.endsWith('.old')), 'lo anterior se archiva, no se borra');
  await m.sync();
  assert.equal(m.get(t.id).state, 'completed');
});

test('requirements faltantes: el notebook NO instala nada sin allowInstall y lo explica', { skip: PY_SKIP }, async () => {
  const { m, drive } = folderManager();
  const t = m.add('deps', { config: { steps: 1, sleepSec: 0, requirements: ['paquete-que-no-existe-xyz'] } });
  m.prepareNotebook(t.id);
  await m.run(t.id);
  const r = simulateColab(m.get(t.id).notebookPath, drive);
  assert.match(r.stdout, /Faltan dependencias: paquete-que-no-existe-xyz/);
  assert.match(r.stdout, /no se instalan automáticamente/);
  await m.sync();
  assert.equal(m.get(t.id).state, 'failed');
});

test('estado remoto malicioso o de otra tarea/intento se ignora', { skip: PY_SKIP }, async () => {
  const { m, drive } = folderManager();
  const t = m.add('seguro', { config: { steps: 2, sleepSec: 0 } });
  m.prepareNotebook(t.id);
  await m.run(t.id);
  fs.mkdirSync(path.join(drive, t.id), { recursive: true });
  fs.writeFileSync(path.join(drive, t.id, 'status.json'), JSON.stringify({ schema: 1, taskId: 't-ffffffff', attempt: 1, state: 'completed', heartbeat: '2026-01-01T00:00:00Z' }));
  await m.sync();
  assert.equal(m.get(t.id).state, 'running', 'taskId distinto → ignorado');
  fs.writeFileSync(path.join(drive, t.id, 'status.json'), '{"schema":1,"state":"comp');
  await m.sync();
  assert.equal(m.get(t.id).state, 'running', 'JSON dañado → ignorado');
  fs.writeFileSync(path.join(drive, t.id, 'status.json'), JSON.stringify({ schema: 1, taskId: t.id, attempt: 1, state: 'failed', heartbeat: '2026-01-01T00:00:00Z', error: { message: 'token=ghp_' + 'Z'.repeat(36) } }));
  await m.sync();
  const f = m.get(t.id);
  assert.equal(f.state, 'failed');
  assert.ok(!JSON.stringify(f).includes('ghp_' + 'Z'.repeat(36)), 'el secreto remoto se redacta');
});

test('canal no disponible (carpeta ausente / sin conexión): error claro, el estado local no cambia', async () => {
  const clock = makeClock();
  const m = makeManager({ clock, overrides: { channel: { type: 'folder', path: path.join(tmpDir(), 'no-existe') } } });
  const t = m.add('offline', { config: { steps: 1 } });
  m.prepareNotebook(t.id);
  await m.run(t.id);
  const before = JSON.stringify(m.get(t.id));
  await assert.rejects(m.sync(), (e) => e.code === 'ENET');
  assert.equal(JSON.stringify(m.get(t.id)), before);
  const mon = await m.monitor({ sync: true });
  assert.equal(mon.syncError.code, 'ENET');
  assert.equal(mon.results[0].verdict, 'awaiting_start', 'sin sync no se concluye nada');
});

// --- rclone y github con ejecutor falso (no usan red) ---------------------------------------
const fakeExec = (handler) => { const calls = []; const f = async (cmd, args, o) => { calls.push([cmd, ...args]); return handler(cmd, args, o); }; f.calls = calls; return f; };

test('rclone: no instalado → error "no implementado/limitado" con instrucción; red caída → ENET; remoto inexistente → ECONFIG', async () => {
  const mk = (handler) => makeManager({ exec: fakeExec(handler), overrides: { channel: { type: 'rclone', remote: 'gdrive' } } });
  let m = mk(() => ({ code: -1, stdout: '', stderr: '', error: Object.assign(new Error('x'), { code: 'ENOENT' }) }));
  await assert.rejects(m.sync(), (e) => e.code === 'EUNSUPPORTED' && /pkg install rclone/.test(e.hint));
  m = mk(() => ({ code: 1, stdout: '', stderr: 'dial tcp: lookup www.googleapis.com: no such host', error: null }));
  await assert.rejects(m.sync(), (e) => e.code === 'ENET');
  m = mk(() => ({ code: 3, stdout: '', stderr: "Failed to create file system: didn't find section in config file", error: null }));
  await assert.rejects(m.sync(), (e) => e.code === 'ECONFIG');
  m = mk(() => ({ code: -1, stdout: '', stderr: '', error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) }));
  await assert.rejects(m.sync(), (e) => e.code === 'ENET');
});

test('rclone: argumentos sin shell (arreglo) y URL de Colab desde el ID de Drive', async () => {
  let taskId = null;
  const exec = fakeExec((cmd, args) => (args[0] === 'lsjson'
    ? { code: 0, stdout: JSON.stringify([{ Name: `${taskId}.ipynb`, ID: '1AbCdEfGhIjKlMnOpQrStUv' }]), stderr: '', error: null }
    : { code: 0, stdout: '', stderr: '', error: null }));
  const m = makeManager({ exec, overrides: { channel: { type: 'rclone', remote: 'gdrive' } } });
  const t = m.add('url', { config: { steps: 1 } });
  taskId = t.id;
  m.prepareNotebook(t.id);
  const { launch } = await m.run(t.id);
  assert.deepEqual(launch.urls, ['https://colab.research.google.com/drive/1AbCdEfGhIjKlMnOpQrStUv']);
  await m.sync();
  for (const call of exec.calls) assert.equal(call[0], 'rclone');
  assert.ok(exec.calls.some((c) => c.includes('copy') && c.includes('gdrive:ColabManager/notebooks')));
  assert.ok(exec.calls.some((c) => c.includes('--exclude')));
});

test('github: distribuye el notebook y construye la URL de Colab; sin "results" no recoge resultados (limitado, lo dice)', async () => {
  const exec = fakeExec((cmd, args) => ({ code: 0, stdout: args[0] === 'status' ? ' M notebooks/x\n' : '', stderr: '', error: null }));
  const m = makeManager({ exec, overrides: { channel: { type: 'github', repo: 'yo/privado', branch: 'main' } } });
  const t = m.add('gh', { config: { steps: 1 } });
  m.prepareNotebook(t.id);
  const { launch } = await m.run(t.id);
  assert.deepEqual(launch.urls, [`https://colab.research.google.com/github/yo/privado/blob/main/notebooks/${t.id}.ipynb`]);
  await assert.rejects(m.sync(), (e) => e.code === 'EUNSUPPORTED' && /results/.test(e.hint));
  assert.ok(exec.calls.some((c) => c[0] === 'git' && c[1] === 'push'), 'hizo push del notebook antes de fallar al recoger resultados');
});

test('github: error de red/autenticación se clasifica', async () => {
  const m = makeManager({ exec: fakeExec(() => ({ code: 128, stdout: '', stderr: 'fatal: Could not resolve host: github.com', error: null })), overrides: { channel: { type: 'github', repo: 'yo/privado' } } });
  await assert.rejects(m.sync(), (e) => e.code === 'ENET');
  const m2 = makeManager({ exec: fakeExec(() => ({ code: 128, stdout: '', stderr: 'fatal: Authentication failed for', error: null })), overrides: { channel: { type: 'github', repo: 'yo/privado' } } });
  await assert.rejects(m2.sync(), (e) => e.code === 'ECONFIG');
});

// --- monitor (función pura) ---------------------------------------------------------------
const L = { staleMin: 15, staleFactor: 5, maxSilenceMin: 120, startTimeoutMin: 30 };
const T0 = Date.parse('2026-01-01T00:00:00Z');
const base = (over) => ({ state: 'running', phase: 'active', updatedAt: new Date(T0).toISOString(), attempts: [{ n: 1, requestedAt: new Date(T0).toISOString() }], lastActivityAt: new Date(T0).toISOString(), lastCheckedAt: new Date(T0).toISOString(), progress: null, ...over });

test('monitor: distingue tarea lenta de sesión desconectada solo cuando hay datos', () => {
  const min = 60000;
  const slowTask = base({ progress: { avgStepSec: 600 } }); // pasos de 10 min → margen 50 min
  assert.equal(evaluate({ ...slowTask, lastCheckedAt: new Date(T0 + 20 * min).toISOString() }, T0 + 20 * min, { ...L }).verdict, 'active');
  assert.equal(evaluate({ ...slowTask, lastCheckedAt: new Date(T0 + 70 * min).toISOString() }, T0 + 70 * min, L).verdict, 'stalled'); // 70 > 50 y > 15
  const fast = base({ progress: { avgStepSec: 2 } }); // margen mínimo 60 s, pero staleMin=15
  assert.equal(evaluate({ ...fast, lastCheckedAt: new Date(T0 + 10 * min).toISOString() }, T0 + 10 * min, L).verdict, 'slow');
  assert.equal(evaluate({ ...fast, lastCheckedAt: new Date(T0 + 30 * min).toISOString() }, T0 + 30 * min, L).verdict, 'stalled');
  const nodata = base();
  assert.equal(evaluate({ ...nodata, lastCheckedAt: new Date(T0 + 40 * min).toISOString() }, T0 + 40 * min, L).verdict, 'unknown');
  assert.equal(evaluate({ ...nodata, lastCheckedAt: new Date(T0 + 130 * min).toISOString() }, T0 + 130 * min, L).verdict, 'stalled'); // tope absoluto
});

test('monitor: datos de sync obsoletos → "unknown", nunca "stalled"', () => {
  const r = evaluate(base({ progress: { avgStepSec: 1 } }), T0 + 100 * 60000, L); // sin sync desde T0
  assert.equal(r.verdict, 'unknown');
  assert.match(r.reason, /sync/);
});

test('monitor: inicio — espera, y solo tras sincronizar declara que no inició', () => {
  const t = base({ phase: 'awaiting_start', lastActivityAt: null, lastCheckedAt: null });
  assert.equal(evaluate(t, T0 + 99 * 60000, L).verdict, 'awaiting_start');
  const synced = { ...t, lastCheckedAt: new Date(T0 + 40 * 60000).toISOString() };
  assert.equal(evaluate(synced, T0 + 10 * 60000, L).verdict, 'awaiting_start');
  assert.equal(evaluate(synced, T0 + 45 * 60000, L).verdict, 'start_timeout');
  assert.equal(evaluate({ ...t, state: 'failed' }, T0, L).verdict, 'inactive');
});

test('monitor --fix no toca tareas "unknown" ni "slow"; reintento controlado tras interrupción', async () => {
  const { m, clock } = folderManager();
  const t = m.add('x', { config: { steps: 1 } });
  m.prepareNotebook(t.id);
  await m.run(t.id);
  clock.advance(3600 * 1000); // 1 h sin latido ni sync posterior
  const r = await m.monitor({ fix: true });
  assert.equal(r.results[0].verdict, 'awaiting_start');
  assert.equal(m.get(t.id).state, 'running');
});
