'use strict';
// CLI real (proceso hijo): códigos de salida, --json, validación de argumentos y confirmaciones.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmpDir } = require('./helpers/harness');

const BIN = path.join(__dirname, '..', 'colabctl.js');
const mk = () => { const home = tmpDir(); return (...args) => spawnSync('node', [BIN, ...args], { env: { ...process.env, COLABCTL_HOME: home }, encoding: 'utf8', input: '' }); };
const json = (r) => JSON.parse(r.stdout);

test('status, add, list, notebook, run, logs funcionan de punta a punta', () => {
  const c = mk();
  assert.equal(c('status').status, 0);
  const add = c('add', 'tarea cli', '--config', '{"steps":3,"sleepSec":0}', '--json');
  assert.equal(add.status, 0, add.stderr);
  const id = json(add).data.id;
  assert.equal(json(c('list', '--json')).data.length, 1);
  assert.match(c('notebook', id).stdout, /Notebook listo/);
  const run = c('run', id.slice(0, 5));
  assert.equal(run.status, 0);
  assert.match(run.stdout, /Colab NO se ha iniciado/);
  assert.match(c('logs', id).stdout, /run_requested/);
  assert.equal(c('run', id).status, 1, 'duplicado rechazado');
  assert.match(c('run', id).stderr, /ya está en ejecución/);
});

test('códigos de salida: 2 uso/validación, 3 no implementado, 1 error de estado', () => {
  const c = mk();
  assert.equal(c('foo').status, 2);
  assert.equal(c('add').status, 2);
  assert.equal(c('add', 'x', '--opcion-rara').status, 2);
  assert.equal(c('run', '../../etc/passwd').status, 2);
  assert.equal(c('run', 't-00000000').status, 1);
  assert.equal(c('sync').status, 3, 'sin canal: función no disponible, no se simula éxito');
  assert.match(c('sync').stderr, /No hay canal/);
  const j = json(c('sync', '--json'));
  assert.equal(j.ok, false);
  assert.equal(j.error.code, 'EUNSUPPORTED');
});

test('operaciones destructivas exigen confirmación (sin TTY → --yes)', () => {
  const c = mk();
  const id = json(c('add', 't', '--prepare', '--json')).data.id;
  const r = c('cancel', id);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /confirmación/);
  assert.equal(json(c('list', '--json')).data[0].state, 'prepared', 'no cambió nada');
  assert.equal(c('cancel', id, '--yes').status, 0);
  assert.equal(c('delete', id).status, 2);
  assert.equal(c('delete', id, '-y').status, 0);
  assert.equal(json(c('list', '--json')).data.length, 0);
});

test('argumentos con metacaracteres de shell no se interpretan', () => {
  const c = mk();
  const r = c('add', '$(touch /tmp/pwned_cli); `id` ; rm -rf ~', '--json');
  assert.equal(r.status, 0, r.stderr);
  assert.match(json(r).data.name, /pwned_cli/);
  assert.equal(require('fs').existsSync('/tmp/pwned_cli'), false);
});

test('comandos con proveedor no implementado informan y salen con 3', () => {
  const home = tmpDir();
  require('fs').writeFileSync(path.join(home, 'config.json'), JSON.stringify({ provider: 'colab-api' }));
  const c = (...a) => spawnSync('node', [BIN, ...a], { env: { ...process.env, COLABCTL_HOME: home }, encoding: 'utf8' });
  const id = json(c('add', 'x', '--prepare', '--json')).data.id;
  const r = c('run', id);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /no está implementado/);
});

test('config.json con secretos o valores inválidos se rechaza', () => {
  const home = tmpDir();
  const fs = require('fs');
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ channel: { type: 'rclone', remote: 'g', token: 'ya29.abcdefghijklmnopqrstuvwxyz' } }));
  const r = spawnSync('node', [BIN, 'status'], { env: { ...process.env, COLABCTL_HOME: home }, encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /secreto/);
  assert.ok(!r.stderr.includes('ya29.abcdefghijklmnopqrstuvwxyz'));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ limits: { maxRetries: 9999 }, channel: { type: 'rclone', remote: '--evil' } }));
  const r2 = spawnSync('node', [BIN, 'status'], { env: { ...process.env, COLABCTL_HOME: home }, encoding: 'utf8' });
  assert.equal(r2.status, 2);
  assert.match(r2.stderr, /maxRetries/);
  assert.match(r2.stderr, /remote inválido/);
});

test('doctor, templates, backup y help funcionan', () => {
  const c = mk();
  assert.equal(c('doctor').status, 0);
  assert.match(c('templates').stdout, /demo-counter/);
  assert.match(c('help').stdout, /colabctl/);
  assert.equal(c('version').status, 0);
});
