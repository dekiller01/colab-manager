'use strict';
// Interfaz HTTP para Dekiller AI (Node/Express). Es un manejador (req, res) estándar de Node:
// funciona con http.createServer y también como middleware de Express:
//     app.use('/colab', createHandler({ manager, token }));
// Seguridad: Bearer obligatorio (comparación en tiempo constante), límite de tamaño de cuerpo,
// límite de peticiones por minuto y nombres de archivo validados. Escuche solo en 127.0.0.1
// (o detrás de su propio proxy con TLS): este módulo NO implementa TLS.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { AppError, E } = require('../../lib/errors');
const { safeJoin } = require('../../lib/util');

const MAX_BODY = 64 * 1024;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();

function send(res, status, body, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', headers['Content-Type'] || 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(text);
}

async function readBody(req) {
  if (req.body !== undefined && req.body !== null && typeof req.body === 'object') return req.body; // express.json()
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new AppError('EBODY', 'Cuerpo demasiado grande.', { exit: 1 });
    chunks.push(c);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw E.invalid('El cuerpo no es JSON válido.'); }
}

const HTTP = { EINVAL: 400, ENOTFOUND: 404, ESTATE: 409, EDUP: 409, ELIMIT: 429, EUNSUPPORTED: 501, EBODY: 413, ENET: 502, EBUSY: 503 };
const publicTask = (t) => ({
  id: t.id, name: t.name, type: t.type, state: t.state, phase: t.phase, createdAt: t.createdAt, updatedAt: t.updatedAt,
  progress: t.progress, lastCheckpoint: t.lastCheckpoint && { step: t.lastCheckpoint.step, at: t.lastCheckpoint.at },
  error: t.error, attempts: t.attempts.length, retries: t.retries, hasResults: !!t.resultsPath,
});

function createHandler({ manager, token, ratePerMin = 60, now = () => Date.now() }) {
  if (typeof token !== 'string' || token.length < 16) throw new Error('El token de la API debe tener al menos 16 caracteres.');
  const want = digest(token);
  let windowStart = now();
  let count = 0;

  return async function handler(req, res) {
    try {
      const auth = String(req.headers.authorization || '');
      const m = /^Bearer (.+)$/.exec(auth);
      if (!m || !crypto.timingSafeEqual(digest(m[1]), want)) return send(res, 401, { error: { code: 'EAUTH', message: 'No autorizado.' } });
      if (now() - windowStart > 60000) { windowStart = now(); count = 0; }
      if (++count > ratePerMin) return send(res, 429, { error: { code: 'ELIMIT', message: 'Demasiadas peticiones; reintente en un minuto.' } });

      const url = new URL(req.url, 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean); // ['v1','tasks',':id',...]
      const method = req.method;
      if (parts[0] !== 'v1') throw E.notFound('Ruta desconocida.');

      if (method === 'GET' && parts[1] === 'status' && parts.length === 2) return send(res, 200, manager.status());
      if (parts[1] === 'tasks') {
        if (parts.length === 2 && method === 'GET') return send(res, 200, { tasks: manager.list({ state: url.searchParams.get('state') || undefined }).map(publicTask) });
        if (parts.length === 2 && method === 'POST') {
          const b = await readBody(req);
          const t = manager.add(b.name, { type: b.type || 'demo-counter', config: b.config && typeof b.config === 'object' ? b.config : {} });
          manager.prepareNotebook(t.id);
          return send(res, 201, { task: publicTask(manager.get(t.id)) });
        }
        const id = manager.store.resolveId(parts[2]);
        if (parts.length === 3 && method === 'GET') return send(res, 200, { task: publicTask(manager.get(id)) });
        if (parts[3] === 'logs' && method === 'GET') {
          const r = manager.logs(id, { tail: Math.min(Number(url.searchParams.get('tail')) || 50, 500) });
          return send(res, 200, { entries: r.entries, total: r.total });
        }
        if (parts[3] === 'run' && method === 'POST') { const r = await manager.run(id); return send(res, 202, { task: publicTask(r.task), launch: r.launch }); }
        if (parts[3] === 'cancel' && method === 'POST') { const r = await manager.cancel(id); return send(res, 200, { task: publicTask(r.task), note: r.info && r.info.note }); }
        if (parts[3] === 'results' && method === 'GET') {
          const t = manager.get(id);
          const dir = safeJoin(manager.store.dirs.sync, id, 'result');
          if (parts.length === 4) {
            const files = fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && NAME_RE.test(e.name)).map((e) => ({ name: e.name, bytes: fs.statSync(path.join(dir, e.name)).size })) : [];
            return send(res, 200, { state: t.state, files });
          }
          if (parts.length === 5 && NAME_RE.test(parts[4])) {
            const f = safeJoin(dir, parts[4]);
            if (!fs.existsSync(f) || !fs.lstatSync(f).isFile()) throw E.notFound('Resultado no encontrado.');
            return send(res, 200, fs.readFileSync(f, 'utf8'), { 'Content-Type': 'text/plain; charset=utf-8' });
          }
        }
      }
      throw E.notFound('Ruta o método no soportado.');
    } catch (e) {
      const known = e instanceof AppError;
      if (!known) manager.logger.error(`api: ${e.stack || e.message}`);
      return send(res, known ? (HTTP[e.code] || 400) : 500, { error: { code: known ? e.code : 'EINTERNAL', message: known ? e.message : 'Error interno.', hint: known ? e.hint : undefined } });
    }
  };
}

module.exports = { createHandler };
