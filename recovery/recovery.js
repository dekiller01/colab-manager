'use strict';
// Recuperación: (1) del almacén local dañado; (2) de tareas interrumpidas.
const fs = require('fs');
const path = require('path');

// Revisa todos los registros: recupera desde .bak, informa los irrecuperables y
// limpia temporales huérfanos de escrituras interrumpidas.
function scanStore(store) {
  store.recoveries = [];
  const tasks = store.list();
  let tmpRemoved = 0;
  try {
    for (const f of fs.readdirSync(store.dirs.jobs)) {
      if (/\.tmp$/.test(f)) {
        const p = path.join(store.dirs.jobs, f);
        if (Date.now() - fs.statSync(p).mtimeMs > 60000) { fs.unlinkSync(p); tmpRemoved++; }
      }
    }
  } catch { /* directorio inexistente */ }
  return {
    total: tasks.length,
    recovered: store.recoveries.slice(),
    unrecoverable: (store.damaged || []).slice(),
    tmpRemoved,
  };
}

// ¿Qué se puede hacer con una tarea fallida/cancelada?
function planRecovery(task, limits) {
  if (!['failed', 'cancelled'].includes(task.state)) return { action: 'none', reason: `estado ${task.state}` };
  if (task.retries >= limits.maxRetries) {
    return { action: 'blocked', reason: `límite de reintentos alcanzado (${task.retries}/${limits.maxRetries}); use --force para exceder` };
  }
  if (task.lastCheckpoint) return { action: 'resume', reason: `hay punto de recuperación (paso ${task.lastCheckpoint.step})` };
  return { action: 'retry', reason: 'sin punto de recuperación: se reiniciará desde cero' };
}

module.exports = { scanStore, planRecovery };
