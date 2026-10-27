'use strict';
// Fase 2 — generación de notebooks. Pruebas LOCALES (estructura, sintaxis Python, contenido).
// Que Google Colab realmente abra y ejecute el .ipynb es una prueba MANUAL pendiente (ver README).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { buildNotebook, validateNotebook } = require('../notebooks/builder');
const { makeManager, tmpDir, PY_SKIP } = require('./helpers/harness');

const opts = { attempt: 1, resumeMode: 'auto', generatedAt: '2026-01-01T00:00:00.000Z', storage: { mode: 'drive', driveFolder: 'ColabManager' }, limits: { maxScriptBytes: 204800 } };
const task = (over = {}) => ({ id: 't-0a1b2c3d', name: 'Prueba', type: 'demo-counter', config: { steps: 3, sleepSec: 0, checkpointEvery: 2, requirements: [], allowInstall: false }, ...over });

test('preparación: estructura nbformat 4 válida y metadatos de Colab', () => {
  const nb = buildNotebook(task(), opts);
  assert.deepEqual(validateNotebook(nb), []);
  assert.equal(nb.nbformat, 4);
  assert.equal(nb.metadata.colab_manager.taskId, 't-0a1b2c3d');
  assert.ok(nb.metadata.colab && nb.metadata.kernelspec.name === 'python3');
  assert.ok(nb.cells.length >= 5);
});

test('el notebook registra el ID de la tarea y valida/verifica/guarda/reanuda (contenido del runtime)', () => {
  const text = JSON.stringify(buildNotebook(task(), opts));
  for (const frag of ['t-0a1b2c3d', '_validate_config', '_check_requirements', 'checkpoint', 'cancel.flag', 'jecución anterior incompleta', 'save_result', 'drive.mount']) {
    assert.ok(text.includes(frag), `falta: ${frag}`);
  }
});

test('no descarga modelos ni instala paquetes sin configuración explícita', () => {
  const nb = JSON.stringify(buildNotebook(task(), opts));
  assert.ok(nb.includes('"allowInstall\\": false') || nb.includes('allowInstall'));
  const cfgCell = buildNotebook(task(), opts).cells[1].source.join('');
  assert.match(cfgCell, /\\"allowInstall\\": false/);
  assert.ok(!/from_pretrained|snapshot_download|huggingface/i.test(nb), 'sin descargas de modelos');
});

test('sintaxis Python de todas las celdas de código es válida', { skip: PY_SKIP }, () => {
  for (const type of ['demo-counter', 'text-batch']) {
    const cfg = type === 'text-batch' ? { items: ['a'], operation: 'sha256', checkpointEvery: 1 } : { steps: 2, sleepSec: 0 };
    const nb = buildNotebook(task({ type, config: cfg }), opts);
    const src = nb.cells.filter((c) => c.cell_type === 'code').map((c) => c.source.join('')).join('\n\n');
    const f = path.join(tmpDir(), 'nb.py');
    fs.writeFileSync(f, src);
    const r = spawnSync('python3', ['-I', '-c', `import ast,sys;ast.parse(open(sys.argv[1]).read())`, f], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  }
});

test('la configuración incrustada sobrevive al viaje JSON→Python (comillas, saltos, unicode)', { skip: PY_SKIP }, () => {
  const weird = 'línea1\nlínea2 "comillas" \'simples\' \\ barra ✓  ';
  const nb = buildNotebook(task({ type: 'text-batch', config: { items: [weird], operation: 'sha256', checkpointEvery: 1, requirements: [], allowInstall: false } }), opts);
  const cfgSrc = nb.cells[1].source.join('');
  const f = path.join(tmpDir(), 'c.py');
  fs.writeFileSync(f, cfgSrc + '\nprint("@@" + json.dumps(CONFIG["job"]["items"][0]))');
  const r = spawnSync('python3', ['-I', f], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout.split('@@')[1].trim()), weird);
});

test('el notebook no contiene secretos y el validador detecta uno incrustado', () => {
  const nb = buildNotebook(task(), opts);
  assert.deepEqual(validateNotebook(nb), []);
  nb.cells[0].source.push('token ya29.' + 'a'.repeat(40));
  assert.ok(validateNotebook(nb).some((e) => /secreto/.test(e)));
});

test('plantilla "script": incrusta el código del usuario y valida def run(ctx)', () => {
  const dir = tmpDir();
  const good = path.join(dir, 'ok.py');
  fs.writeFileSync(good, 'def run(ctx):\n    ctx.save_result("a.json", {"ok": True})\n');
  const bad = path.join(dir, 'bad.py');
  fs.writeFileSync(bad, 'print("sin run")\n');
  const m = makeManager();
  const t = m.add('mi script', { type: 'script', config: { scriptPath: good } });
  const nb = m.prepareNotebook(t.id);
  assert.match(fs.readFileSync(nb.notebookPath, 'utf8'), /ctx\.save_result/);
  assert.throws(() => m.add('malo', { type: 'script', config: { scriptPath: bad } }), /def run/);
  assert.throws(() => m.add('rel', { type: 'script', config: { scriptPath: 'relativo.py' } }), /absoluta/);
  assert.throws(() => m.add('no', { type: 'script', config: { scriptPath: path.join(dir, 'noexiste.py') } }), /No se encuentra/);
  const big = path.join(dir, 'big.py');
  fs.writeFileSync(big, 'def run(ctx):\n    pass\n#' + 'x'.repeat(300000));
  assert.throws(() => m.add('grande', { type: 'script', config: { scriptPath: big } }), (e) => e.code === 'ELIMIT');
});

test('prepareNotebook escribe el archivo, cambia a prepared y es idempotente', () => {
  const m = makeManager();
  const t = m.add('nb', { config: { steps: 2, sleepSec: 0 } });
  const p1 = m.prepareNotebook(t.id);
  assert.equal(p1.state, 'prepared');
  const nb = JSON.parse(fs.readFileSync(p1.notebookPath, 'utf8'));
  assert.deepEqual(validateNotebook(nb), []);
  const p2 = m.prepareNotebook(t.id);
  assert.equal(p2.state, 'prepared');
  assert.equal(p2.notebookMeta.attempt, 1);
});
