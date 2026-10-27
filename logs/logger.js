'use strict';
const fs = require('fs');
const path = require('path');
const { redact } = require('./redact');

const MAX_BYTES = 1024 * 1024;

// Registro general del administrador (no el de cada tarea). Siempre redactado.
class Logger {
  constructor(home, clock = () => new Date()) {
    this.dir = path.join(home, 'logs');
    this.file = path.join(this.dir, 'colabctl.log');
    this.clock = clock;
  }

  _write(level, msg) {
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      try {
        if (fs.statSync(this.file).size > MAX_BYTES) fs.renameSync(this.file, this.file + '.1');
      } catch { /* aún no existe */ }
      fs.appendFileSync(this.file, `${this.clock().toISOString()} ${level} ${redact(msg)}\n`, { mode: 0o600 });
    } catch {
      // El registro nunca debe romper una operación.
    }
  }

  info(m) { this._write('INFO', m); }
  warn(m) { this._write('WARN', m); }
  error(m) { this._write('ERROR', m); }
}

module.exports = { Logger };
