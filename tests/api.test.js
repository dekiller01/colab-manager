'use strict';
// Interfaz para Dekiller AI (Fase 5, parcial). Probada con http de Node; NO probada dentro de Express real.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createHandler } = require('../integrations/dekiller/handler');
const { makeManager } = require('./helpers/harness');

const TOKEN = 'token-de-prueba-0123456789';

async function withServer(manager, opts, fn) {
  const server = http.createServer(createHandler({ manager, token: TOKEN, ...opts }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, { body, auth = `Bearer ${TOKEN}`, raw } = {}) => {
    const res = await fetch(base + p, { method, headers: { ...(auth ? { Authorization: auth } : {}), 'Content-Type': 'application/json' }, body: raw ?? (body ? JSON.stringify(body) : undefined) });
    const text = await res.text();
    let j = null; try { j = JSON.parse(text); } catch { /* texto plano */ }
    return { status: res.status, json: j, text };
  };
  try { await fn(call); } finally { await new Promise((r) => server.close(r)); }
}

test('autenticación: sin token o con token incorrecto → 401', async () => {
  await withServer(makeManager(), {}, async (call) => {
    assert.equal((await call('GET', '/v1/status', { auth: null })).status, 401);
    assert.equal((await call('GET', '/v1/status', { auth: 'Bearer incorrecto' })).status, 401);
    assert.equal((await call('GET', '/v1/status', { auth: 'Basic abc' })).status, 401);
    assert.equal((await call('GET', '/v1/status')).status, 200);
  });
});

test('el handler exige un token de al menos 16 caracteres', () => {
  assert.throws(() => createHandler({ manager: makeManager(), token: 'corto' }));
});

test('flujo: crear → consultar → ejecutar → logs → resultados → cancelar', async () => {
  const m = makeManager();
  await withServer(m, {}, async (call) => {
    const c = await call('POST', '/v1/tasks', { body: { name: 'desde dekiller', type: 'text-batch', config: { items: ['hola mundo'], operation: 'wordcount' } } });
    assert.equal(c.status, 201, c.text);
    const id = c.json.task.id;
    assert.equal(c.json.task.state, 'prepared');
    assert.equal((await call('GET', '/v1/tasks')).json.tasks.length, 1);
    assert.equal((await call('GET', `/v1/tasks/${id}`)).json.task.id, id);
    const run = await call('POST', `/v1/tasks/${id}/run`);
    assert.equal(run.status, 202);
    assert.equal(run.json.task.state, 'running');
    assert.equal((await call('POST', `/v1/tasks/${id}/run`)).status, 409, 'duplicado');
    assert.ok((await call('GET', `/v1/tasks/${id}/logs`)).json.entries.length >= 2);
    fs.mkdirSync(path.join(m.mirror, id, 'result'), { recursive: true });
    fs.writeFileSync(path.join(m.mirror, id, 'result', 'summary.json'), '{"ok":true}');
    const files = await call('GET', `/v1/tasks/${id}/results`);
    assert.deepEqual(files.json.files.map((f) => f.name), ['summary.json']);
    assert.equal((await call('GET', `/v1/tasks/${id}/results/summary.json`)).text, '{"ok":true}');
    assert.equal((await call('GET', `/v1/tasks/${id}/results/..%2F..%2Fjobs`)).status, 404);
    assert.equal((await call('POST', `/v1/tasks/${id}/cancel`)).json.task.state, 'cancelled');
  });
});

test('validación: JSON inválido, tipo desconocido, id inválido, ruta desconocida', async () => {
  await withServer(makeManager(), {}, async (call) => {
    assert.equal((await call('POST', '/v1/tasks', { raw: '{no es json' })).status, 400);
    assert.equal((await call('POST', '/v1/tasks', { body: { name: 'x', type: 'rm -rf' } })).status, 400);
    assert.equal((await call('GET', '/v1/tasks/..%2F..')).status, 400);
    assert.equal((await call('GET', '/v1/tasks/t-ffffffff')).status, 404);
    assert.equal((await call('GET', '/otra/cosa')).status, 404);
  });
});

test('límites: cuerpo demasiado grande → 413; demasiadas peticiones → 429', async () => {
  await withServer(makeManager(), {}, async (call) => {
    assert.equal((await call('POST', '/v1/tasks', { raw: JSON.stringify({ name: 'x', config: { blob: 'y'.repeat(100000) } }) })).status, 413);
  });
  await withServer(makeManager(), { ratePerMin: 3 }, async (call) => {
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await call('GET', '/v1/status')).status);
    assert.deepEqual(codes, [200, 200, 200, 429, 429]);
  });
});
