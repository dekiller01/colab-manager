'use strict';
// Incorpora al registro local lo que Colab escribió (status.json, checkpoint.json,
// events.jsonl, result/) y que ya fue copiado al espejo local (<home>/sync/<id>/).
// Todo lo que viene de Colab se trata como DATO NO CONFIABLE: se valida su forma.
const fs = require('fs');
const path = require('path');
const { readJson } = require('../storage/atomic');
const { canTransition } = require('./states');
const { redact } = require('../logs/redact');

const REMOTE_STATES = ['running', 'completed', 'failed', 'cancelled'];
const isIso = (s) => typeof s === 'string' && !Number.isNaN(Date.parse(s));

function validRemoteStatus(s, taskId) {
  return s && typeof s === 'object' && s.schema === 1 && s.taskId === taskId && REMOTE_STATES.includes(s.state)
    && isIso(s.heartbeat) && Number.isInteger(s.attempt) && s.attempt >= 1;
}

function readStatus(dir, taskId) {
  try {
    const r = readJson(path.join(dir, 'status.json'), { validate: (d) => validRemoteStatus(d, taskId) });
    return r && r.data;
  } catch { return null; }
}

function readCheckpointMeta(dir, taskId) {
  for (const f of ['checkpoint.json', 'checkpoint.json.prev']) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (d && d.schema === 1 && d.taskId === taskId && Number.isFinite(d.step) && isIso(d.at)) return { step: d.step, at: d.at, attempt: d.attempt };
    } catch { /* probar el siguiente */ }
  }
  return null;
}

/**
 * Aplica a `task` (mutándolo) lo observado en `dir`. Devuelve lista de cambios (texto).
 * No lanza por datos remotos defectuosos.
 */
function applyRemote(task, dir, nowIso) {
  const changes = [];
  if (!fs.existsSync(dir)) return changes;
  const st = readStatus(dir, task.id);
  const ck = readCheckpointMeta(dir, task.id);
  const cur = task.attempts[task.attempts.length - 1];

  if (task.state === 'running') task.lastCheckedAt = nowIso;

  if (ck && (!task.lastCheckpoint || ck.at > task.lastCheckpoint.at)) {
    task.lastCheckpoint = { step: ck.step, at: ck.at, path: path.join(dir, 'checkpoint.json') };
    changes.push(`punto de recuperación: paso ${ck.step}`);
  }
  if (!st) return changes;

  // Estado de un intento anterior (p. ej. archivo viejo en Drive): se ignora.
  if (cur && st.attempt < cur.n) { changes.push(`estado remoto del intento ${st.attempt} ignorado (actual: ${cur.n})`); return changes; }
  if (task.state !== 'running') {
    // Una tarea cancelada/fallida localmente no cambia por datos remotos, salvo avisar.
    if (st.state !== task.state && task.state !== 'completed') changes.push(`remoto reporta "${st.state}" pero la tarea local está "${task.state}" (sin cambios)`);
    return changes;
  }

  task.lastActivityAt = st.heartbeat;
  task.progress = { ...(st.progress || {}), avgStepSec: st.avgStepSec ?? null };
  if (task.phase === 'awaiting_start') { task.phase = 'active'; if (cur) { cur.status = 'active'; cur.startedAt = st.startedAt || st.heartbeat; } changes.push('la ejecución en Colab comenzó'); }
  if (st.previousRunIncomplete) changes.push('Colab detectó una ejecución previa incompleta y reanudó');

  if (st.state === 'completed' && canTransition('running', 'completed')) {
    task.state = 'completed'; task.phase = null; task.error = null;
    task.resultsPath = path.join(dir, 'result');
    if (cur) { cur.endedAt = st.finishedAt || nowIso; cur.outcome = 'completed'; cur.status = 'closed'; }
    changes.push('completada');
  } else if (st.state === 'failed') {
    task.state = 'failed'; task.phase = null;
    task.error = { code: (st.error && st.error.code) || 'job_error', message: redact((st.error && st.error.message) || 'Error informado por Colab'), at: st.finishedAt || nowIso };
    if (cur) { cur.endedAt = st.finishedAt || nowIso; cur.outcome = 'failed'; cur.status = 'closed'; }
    changes.push(`falló: ${task.error.message.split('\n')[0].slice(0, 120)}`);
  } else if (st.state === 'cancelled') {
    task.state = 'cancelled'; task.phase = null;
    if (cur) { cur.endedAt = st.finishedAt || nowIso; cur.outcome = 'cancelled'; cur.status = 'closed'; }
    changes.push('cancelada por el notebook');
  } else if (st.progress && st.progress.total) {
    changes.push(`avance ${st.progress.done}/${st.progress.total}`);
  }
  return changes;
}

module.exports = { applyRemote, readStatus, readCheckpointMeta, validRemoteStatus };
