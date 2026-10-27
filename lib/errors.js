'use strict';
// Errores controlados de la aplicación. Cada uno lleva un código estable
// (útil para --json y para la API) y, opcionalmente, una sugerencia ("hint").

class AppError extends Error {
  constructor(code, message, { hint = null, exit = 1 } = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.hint = hint;
    this.exit = exit;
  }
}

const E = {
  invalid: (m, hint) => new AppError('EINVAL', m, { hint, exit: 2 }),
  notFound: (m, hint) => new AppError('ENOTFOUND', m, { hint }),
  state: (m, hint) => new AppError('ESTATE', m, { hint }),
  duplicate: (m, hint) => new AppError('EDUP', m, { hint }),
  limit: (m, hint) => new AppError('ELIMIT', m, { hint }),
  network: (m, hint) => new AppError('ENET', m, { hint }),
  unsupported: (m, hint) => new AppError('EUNSUPPORTED', m, { hint, exit: 3 }),
  corrupt: (m, hint) => new AppError('ECORRUPT', m, { hint }),
  config: (m, hint) => new AppError('ECONFIG', m, { hint, exit: 2 }),
  busy: (m, hint) => new AppError('EBUSY', m, { hint }),
};

module.exports = { AppError, E };
