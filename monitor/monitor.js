'use strict';
// Evaluación (función pura) del estado de tareas en ejecución.
// Principio: solo se afirma "sesión posiblemente desconectada" cuando hay datos
// suficientes y frescos; si no, el veredicto es "unknown" y no se toma ninguna acción.
const { fmtAge } = require('../lib/util');

/**
 * Veredictos:
 *  inactive        la tarea no está en "running"
 *  awaiting_start  se solicitó la ejecución y aún no llegó el primer latido
 *  start_timeout   tras sincronizar, sigue sin latido pasado startTimeoutMin
 *  active          latidos dentro de lo esperado
 *  slow            más silencio de lo normal para su ritmo, pero dentro del margen
 *  stalled         silencio mayor al margen → probable desconexión/bloqueo
 *  unknown         datos insuficientes u obsoletos (p. ej. sin sync reciente)
 */
function evaluate(task, nowMs, limits) {
  if (task.state !== 'running') return { verdict: 'inactive', reason: `estado ${task.state}` };
  const att = task.attempts[task.attempts.length - 1];
  const checkedAt = task.lastCheckedAt ? Date.parse(task.lastCheckedAt) : null;
  const staleMs = limits.staleMin * 60000;

  if (task.phase === 'awaiting_start' || !task.lastActivityAt) {
    const reqAt = Date.parse(att?.requestedAt || task.updatedAt);
    const age = nowMs - reqAt;
    if (!checkedAt || checkedAt < reqAt) {
      return { verdict: 'awaiting_start', reason: 'esperando el primer latido; aún no se ha sincronizado desde la solicitud', age };
    }
    if (age > limits.startTimeoutMin * 60000) {
      return { verdict: 'start_timeout', reason: `sin latido ${fmtAge(age)} después de solicitar (límite ${limits.startTimeoutMin}min)`, age };
    }
    return { verdict: 'awaiting_start', reason: `esperando que abra el notebook en Colab (${fmtAge(age)})`, age };
  }

  const silence = nowMs - Date.parse(task.lastActivityAt);
  const syncAge = checkedAt ? nowMs - checkedAt : Infinity;
  if (syncAge > staleMs && silence > staleMs) {
    return { verdict: 'unknown', reason: `datos obsoletos: última sincronización hace ${fmtAge(syncAge)}. Ejecute "colabctl sync"`, silence };
  }
  const avg = task.progress && task.progress.avgStepSec;
  const expectedMs = avg ? Math.max(avg * limits.staleFactor * 1000, 60000) : null;
  const hardMs = limits.maxSilenceMin * 60000;

  if (silence > hardMs) return { verdict: 'stalled', reason: `sin actividad hace ${fmtAge(silence)} (máximo ${limits.maxSilenceMin}min)`, silence };
  if (expectedMs) {
    if (silence <= expectedMs) return { verdict: 'active', reason: `último latido hace ${fmtAge(silence)}`, silence };
    if (silence <= Math.max(expectedMs, staleMs)) return { verdict: 'slow', reason: `silencio ${fmtAge(silence)} > ritmo habitual (${Math.round(avg)}s/paso)`, silence };
    return { verdict: 'stalled', reason: `silencio ${fmtAge(silence)} ≫ ritmo habitual (${Math.round(avg)}s/paso): probable desconexión`, silence };
  }
  if (silence <= staleMs) return { verdict: 'active', reason: `último latido hace ${fmtAge(silence)}`, silence };
  return { verdict: 'unknown', reason: `silencio ${fmtAge(silence)} y sin datos de ritmo: no se puede distinguir tarea lenta de sesión desconectada`, silence };
}

module.exports = { evaluate };
