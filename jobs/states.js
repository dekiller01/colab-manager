'use strict';
const { E } = require('../lib/errors');

const STATES = ['pending', 'prepared', 'running', 'completed', 'failed', 'cancelled'];

// Transiciones válidas. "completed" es terminal (para repetir, cree otra tarea).
const TRANSITIONS = {
  pending: ['prepared', 'cancelled'],
  prepared: ['prepared', 'running', 'cancelled'],
  running: ['completed', 'failed', 'cancelled'],
  failed: ['prepared'],
  cancelled: ['prepared'],
  completed: [],
};

const ACTIVE = ['pending', 'prepared', 'running'];

const canTransition = (from, to) => (TRANSITIONS[from] || []).includes(to);

function assertTransition(from, to) {
  if (!STATES.includes(to)) throw E.invalid(`Estado desconocido: ${to}`);
  if (!canTransition(from, to)) {
    throw E.state(`Transición no permitida: ${from} → ${to}`,
      `Desde "${from}" se permite: ${(TRANSITIONS[from] || []).join(', ') || '(ninguna, estado final)'}`);
  }
}

module.exports = { STATES, TRANSITIONS, ACTIVE, canTransition, assertTransition };
