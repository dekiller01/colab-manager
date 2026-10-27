'use strict';
// Almacén persistente de tareas. Un archivo JSON por tarea (un fallo dañaría
// solo una tarea) + un registro de eventos JSONL por tarea (solo-añadir).
const fs = require('fs');
const path = require('path');
const { E } = require('../lib/errors');
const { randomHex } = require('../lib/util');
const { writeJson, readJson, appendLine, readJsonl } = require('./atomic');
const { withLock } = require('./lock');
const { taskProblems, ID_RE } = require('../jobs/schema');
const { redactDeep } = require('../logs/redact');

class Store {
  constructor(home, { clock = () => new Date() } = {}) {
    this.home = home;
    this.clock = clock;
    this.dirs = {
      jobs: path.join(home, 'jobs'),
      notebooks: path.join(home, 'notebooks'),
      sync: path.join(home, 'sync'),
      logs: path.join(home, 'logs'),
      trash: path.join(home, 'trash'),
      backups: path.join(home, 'backups'),
    };
    this.lockFile = path.join(this.dirs.jobs, '.lock');
    this.recoveries = []; // archivos recuperados desde .bak durante esta ejecución
  }

  init() {
    for (const d of Object.values(this.dirs)) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(this.dirs.sync, 'notebooks'), { recursive: true, mode: 0o700 });
  }

  taskFile(id) { return path.join(this.dirs.jobs, `${id}.json`); }
  eventsFile(id) { return path.join(this.dirs.jobs, `${id}.events.jsonl`); }

  _read(id) {
    const r = readJson(this.taskFile(id), { validate: (d) => taskProblems(d).length === 0, now: this.clock() });
    if (!r) return null;
    if (r.source === 'backup') this.recoveries.push({ id, recoveredFrom: r.recoveredFrom });
    return r.data;
  }

  _write(task) {
    const p = taskProblems(task);
    if (p.length) throw E.invalid(`Registro de tarea inválido (${p.join(', ')}).`);
    writeJson(this.taskFile(task.id), task);
  }

  _ids() {
    try {
      return fs.readdirSync(this.dirs.jobs)
        .map((f) => /^(t-[0-9a-f]{8})\.json$/.exec(f)).filter(Boolean).map((m) => m[1]).sort();
    } catch { return []; }
  }

  resolveId(input) {
    const { exact, prefix } = require('../lib/validate').parseIdInput(input);
    const ids = this._ids();
    if (exact) {
      if (!ids.includes(exact)) throw E.notFound(`No existe la tarea ${exact}.`, 'Use "colabctl list".');
      return exact;
    }
    const m = ids.filter((i) => i.startsWith(prefix));
    if (m.length === 0) throw E.notFound(`No existe ninguna tarea que empiece por ${prefix}.`, 'Use "colabctl list".');
    if (m.length > 1) throw E.invalid(`Prefijo ambiguo (${m.join(', ')}).`, 'Escriba más caracteres del ID.');
    return m[0];
  }

  get(input) {
    const id = this.resolveId(input);
    const t = this._read(id);
    if (!t) throw E.notFound(`No existe la tarea ${id}.`);
    return t;
  }

  list() {
    const out = [];
    const damaged = [];
    for (const id of this._ids()) {
      try { const t = this._read(id); if (t) out.push(t); } catch (e) { damaged.push({ id, message: e.message }); }
    }
    out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    this.damaged = damaged;
    return out;
  }

  // Sección crítica con bloqueo entre procesos.
  transaction(fn) {
    return withLock(this.lockFile, () => fn({
      list: () => this.list(),
      get: (i) => this.get(i),
      write: (t) => { t.updatedAt = this.clock().toISOString(); this._write(t); return t; },
    }));
  }

  insert(task) {
    return this.transaction((tx) => {
      if (fs.existsSync(this.taskFile(task.id))) throw E.invalid('Colisión de ID, reintente.');
      return tx.write(task);
    });
  }

  update(input, fn) {
    return this.transaction((tx) => {
      const t = tx.get(input);
      const copy = JSON.parse(JSON.stringify(t));
      const r = fn(copy);
      return tx.write(r || copy);
    });
  }

  newId() {
    for (let i = 0; i < 20; i++) {
      const id = `t-${randomHex(4)}`;
      if (ID_RE.test(id) && !fs.existsSync(this.taskFile(id))) return id;
    }
    throw E.invalid('No se pudo generar un ID único.');
  }

  appendEvent(id, type, data = {}) {
    appendLine(this.eventsFile(id), redactDeep({ ts: this.clock().toISOString(), src: 'local', type, ...data }));
  }

  readEvents(id) { return readJsonl(this.eventsFile(id)); }

  // "Eliminar" = mover a trash/ (recuperable). Nunca borra datos de forma irreversible.
  trash(input) {
    return this.transaction((tx) => {
      const t = tx.get(input);
      const dest = path.join(this.dirs.trash, `${t.id}-${this.clock().toISOString().replace(/[:.]/g, '-')}`);
      fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
      for (const f of [this.taskFile(t.id), this.taskFile(t.id) + '.bak', this.eventsFile(t.id)]) {
        if (fs.existsSync(f)) fs.renameSync(f, path.join(dest, path.basename(f)));
      }
      return { id: t.id, trashedTo: dest };
    });
  }
}

module.exports = { Store };
