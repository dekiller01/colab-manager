'use strict';
// Núcleo de la aplicación: ciclo de vida de tareas. La CLI y la API (Dekiller AI) usan esta clase.
const fs = require('fs');
const path = require('path');
const { E } = require('../lib/errors');
const { stableStringify, sha256, safeJoin } = require('../lib/util');
const { validateName } = require('../lib/validate');
const { exec: defaultExec } = require('../lib/exec');
const { Store } = require('../storage/store');
const { writeFileAtomic, writeJson, readJsonl } = require('../storage/atomic');
const { Logger } = require('../logs/logger');
const { redact, redactDeep } = require('../logs/redact');
const { STATES, ACTIVE, assertTransition } = require('./states');
const { applyRemote } = require('./ingest');
const { getTemplate, TEMPLATES } = require('../templates');
const { buildNotebook, writeNotebook } = require('../notebooks/builder');
const { getProvider } = require('../providers');
const { createChannel } = require('../providers/channels');
const { evaluate } = require('../monitor/monitor');
const { scanStore, planRecovery } = require('../recovery/recovery');
const { loadConfig, configPath, DEFAULTS } = require('../config');
const pkg = require('../package.json');

const clone = (o) => JSON.parse(JSON.stringify(o));

class Manager {
  constructor({ home, config, exec = defaultExec, clock = () => new Date() }) {
    this.home = home;
    this.config = config;
    this.clock = clock;
    this.exec = exec;
    this.store = new Store(home, { clock });
    this.logger = new Logger(home, clock);
    this.provider = getProvider(config.provider);
    this.channel = createChannel(config.channel, { home, folder: config.colab.driveFolder, exec });
    this.limits = config.limits;
  }

  static open(home, opts = {}) {
    const m = new Manager({ home, config: loadConfig(home), ...opts });
    m.store.init();
    return m;
  }

  iso() { return this.clock().toISOString(); }
  get mirror() { return this.store.dirs.sync; }

  // ---- utilidades internas ------------------------------------------------
  _setState(t, to) { assertTransition(t.state, to); t.state = to; }

  _closeAttempt(t, outcome) {
    const a = t.attempts[t.attempts.length - 1];
    if (a && !a.endedAt) { a.endedAt = this.iso(); a.outcome = outcome; a.status = 'closed'; }
  }

  _event(id, type, data) { try { this.store.appendEvent(id, type, data); } catch (e) { this.logger.warn(`evento no guardado: ${e.message}`); } }

  _generate(t, mode) {
    const attempt = t.attempts.length + 1;
    const generatedAt = this.iso();
    const nb = buildNotebook(t, {
      attempt, resumeMode: mode, generatedAt, limits: this.limits, concurrentGuardSec: this.limits.concurrentGuardSec,
      storage: { mode: this.config.colab.storageMode, driveFolder: this.config.colab.driveFolder },
    });
    const file = safeJoin(this.store.dirs.notebooks, `${t.id}.ipynb`);
    writeNotebook(file, nb);
    if (this.channel) {
      const out = safeJoin(this.mirror, 'notebooks', `${t.id}.ipynb`);
      writeFileAtomic(out, fs.readFileSync(file));
    }
    t.notebookPath = file;
    t.notebookMeta = { attempt, mode, generatedAt, sha256: sha256(fs.readFileSync(file, 'utf8')) };
    return t;
  }

  // ---- comandos -------------------------------------------------------------
  add(name, { type = 'demo-counter', config = {}, allowDuplicate = false } = {}) {
    name = validateName(name);
    const tpl = getTemplate(type);
    const cfg = { ...tpl.defaults, ...config };
    const errs = tpl.validate(cfg);
    if (errs.length) throw E.invalid(`Configuración inválida para "${type}":\n  - ${errs.join('\n  - ')}`);
    if (Buffer.byteLength(JSON.stringify(cfg)) > this.limits.maxConfigBytes) throw E.limit(`La configuración supera ${this.limits.maxConfigBytes} bytes.`);
    if (type === 'script') tpl.source(cfg, this.limits); // falla pronto si el script no sirve
    const fingerprint = sha256(stableStringify({ name, type, cfg }));
    const now = this.iso();
    const task = this.store.transaction((tx) => {
      const dup = tx.list().find((t) => ACTIVE.includes(t.state) && t.fingerprint === fingerprint);
      if (dup && !allowDuplicate) throw E.duplicate(`Ya existe una tarea activa idéntica: ${dup.id} (${dup.state}).`, 'Use --allow-duplicate si realmente quiere otra copia.');
      const t = {
        schemaVersion: 1, id: this.store.newId(), name, type, state: 'pending', phase: null,
        createdAt: now, updatedAt: now, config: cfg, fingerprint, provider: this.provider.name,
        notebookPath: null, notebookMeta: null, resultsPath: null, lastCheckpoint: null,
        error: null, attempts: [], retries: 0, progress: null, lastActivityAt: null, lastCheckedAt: null,
      };
      return tx.write(t);
    });
    this._event(task.id, 'created', { name, taskType: type });
    this.logger.info(`add ${task.id} ${type}`);
    return task;
  }

  list({ state } = {}) {
    if (state && !STATES.includes(state)) throw E.invalid(`Estado inválido: ${state}`, `Estados: ${STATES.join(', ')}`);
    const all = this.store.list();
    return state ? all.filter((t) => t.state === state) : all;
  }

  get(id) { return this.store.get(id); }

  prepareNotebook(id, { mode = 'auto' } = {}) {
    const t = this.store.update(id, (t) => {
      if (!['pending', 'prepared'].includes(t.state)) throw E.state(`No se puede (re)generar el notebook en estado "${t.state}".`, t.state === 'running' ? 'Está en ejecución: no se modifica su notebook.' : 'Use retry o resume.');
      this._generate(t, mode);
      if (t.state === 'pending') this._setState(t, 'prepared');
    });
    this._event(t.id, 'notebook_prepared', { attempt: t.notebookMeta.attempt, mode: t.notebookMeta.mode });
    return t;
  }

  async run(id, { force = false } = {}) {
    const reservedFor = this.store.resolveId(id);
    let abandoned = false;
    const task = this.store.transaction((tx) => {
      const t = tx.get(reservedFor);
      if (t.state === 'running') {
        if (!force) throw E.duplicate(`La tarea ${t.id} ya está en ejecución (intento ${t.attempts.length}).`, 'Si esa sesión ya no existe, use "colabctl run ID --force" (pide confirmación) o "colabctl monitor --fix".');
        this._closeAttempt(t, 'abandoned');
        abandoned = true;
        t.state = 'failed'; // cierre administrativo del intento abandonado (el paso a "prepared" es válido desde failed)
        t.error = { code: 'abandoned', message: 'Intento reemplazado por --force', at: this.iso() };
      } else if (!['pending', 'prepared'].includes(t.state)) {
        throw E.state(`No se puede ejecutar una tarea en estado "${t.state}".`, ['failed', 'cancelled'].includes(t.state) ? 'Use "colabctl retry ID" o "colabctl resume ID".' : null);
      }
      const others = tx.list().filter((x) => x.id !== t.id && x.state === 'running').length;
      if (others >= this.limits.maxConcurrent) throw E.limit(`Ya hay ${others} tarea(s) en ejecución (máximo ${this.limits.maxConcurrent}).`, 'Espere a que termine, o ajuste limits.maxConcurrent. Colab gratuito rara vez admite varias sesiones.');
      if (!t.notebookPath || !t.notebookMeta || t.notebookMeta.attempt !== t.attempts.length + 1 || !fs.existsSync(t.notebookPath)) this._generate(t, 'auto');
      if (t.state === 'pending') this._setState(t, 'prepared');
      if (t.state === 'failed') this._setState(t, 'prepared');
      this._setState(t, 'running');
      t.phase = 'awaiting_start'; t.lastActivityAt = null; t.lastCheckedAt = null; t.progress = null; t.error = null;
      t.attempts.push({ n: t.attempts.length + 1, requestedAt: this.iso(), status: 'awaiting_start', provider: this.provider.name, mode: t.notebookMeta.mode });
      return tx.write(t);
    });
    let launch;
    try {
      launch = await this.provider.launch(task, { channel: this.channel, notebookPath: task.notebookPath });
    } catch (e) {
      // Deshacer la reserva: la solicitud no llegó a realizarse.
      this.store.update(task.id, (t) => { t.state = 'prepared'; t.phase = null; t.attempts.pop(); });
      this._event(task.id, 'run_failed', { error: e.message });
      throw e;
    }
    this._event(task.id, 'run_requested', { attempt: task.attempts.length, provider: this.provider.name, abandonedPrevious: abandoned });
    this.logger.info(`run ${task.id} attempt ${task.attempts.length}`);
    return { task, launch };
  }

  logs(id, { tail = 50 } = {}) {
    const t = this.store.get(id);
    const local = this.store.readEvents(t.id);
    const remote = readJsonl(path.join(this.mirror, t.id, 'events.jsonl'));
    const entries = [...local.records, ...remote.records.map((r) => ({ ...r, src: 'colab' }))]
      .map((r) => redactDeep(r))
      .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    const n = Number.isInteger(tail) && tail > 0 ? tail : 50;
    return { task: t, entries: entries.slice(-n), total: entries.length, badLines: local.bad + remote.bad };
  }

  async cancel(id) {
    const t0 = this.store.get(id);
    if (!ACTIVE.includes(t0.state)) throw E.state(`No se puede cancelar una tarea en estado "${t0.state}".`);
    let info = null;
    if (t0.state === 'running') {
      info = await this.provider.cancel(t0);
      const dir = safeJoin(this.mirror, t0.id);
      writeFileAtomic(path.join(dir, 'cancel.flag'), JSON.stringify({ requestedAt: this.iso() }) + '\n');
      info = { ...info, delivered: false, channel: !!this.channel };
    }
    const t = this.store.update(t0.id, (t) => {
      this._closeAttempt(t, 'cancelled');
      this._setState(t, 'cancelled');
      t.phase = null;
    });
    this._event(t.id, 'cancelled', { cooperative: !!info });
    return { task: t, info };
  }

  _reattempt(id, mode, { force = false } = {}) {
    let fromStep = null;
    const t = this.store.update(id, (t) => {
      if (!['failed', 'cancelled'].includes(t.state)) throw E.state(`Solo se puede ${mode === 'fresh' ? 'reintentar' : 'reanudar'} una tarea "failed" o "cancelled" (actual: "${t.state}").`);
      if (t.retries >= this.limits.maxRetries && !force) throw E.limit(`Límite de reintentos alcanzado (${t.retries}/${this.limits.maxRetries}).`, 'Use --force para exceder el límite o ajuste limits.maxRetries.');
      if (mode === 'resume' && !t.lastCheckpoint) throw E.state('No hay un punto de recuperación conocido.', 'Ejecute "colabctl sync" por si Colab ya guardó uno; si no, use "colabctl retry ID" (empieza desde cero).');
      fromStep = t.lastCheckpoint ? t.lastCheckpoint.step : null;
      t.retries += 1;
      this._generate(t, mode);
      this._setState(t, 'prepared');
      t.error = null; t.phase = null;
    });
    this._event(t.id, 'recovery_attempt', { action: mode === 'fresh' ? 'retry' : 'resume', retries: t.retries, fromStep, nextAttempt: t.notebookMeta.attempt });
    this.logger.info(`${mode} ${t.id}`);
    return t;
  }

  retry(id, opts) { return this._reattempt(id, 'fresh', opts); }
  resume(id, opts) { return this._reattempt(id, 'resume', opts); }

  // Escape manual para cuando no hay canal de sincronización: el usuario informa el estado real.
  mark(id, to, { note = '' } = {}) {
    if (!STATES.includes(to)) throw E.invalid(`Estado inválido: ${to}`, `Estados: ${STATES.join(', ')}`);
    const t = this.store.update(id, (t) => {
      this._setState(t, to);
      if (to === 'running') {
        t.phase = 'active'; t.lastActivityAt = this.iso();
        if (!t.attempts.length || t.attempts[t.attempts.length - 1].endedAt) t.attempts.push({ n: t.attempts.length + 1, requestedAt: this.iso(), status: 'active', provider: 'manual-mark', mode: 'auto' });
      } else {
        t.phase = null;
        if (['completed', 'failed', 'cancelled'].includes(to)) this._closeAttempt(t, to);
        if (to === 'failed') t.error = { code: 'manual', message: redact(note || 'Marcada como fallida manualmente'), at: this.iso() };
        if (to === 'completed') t.error = null;
      }
    });
    this._event(t.id, 'marked', { state: to, note });
    return t;
  }

  async sync() {
    if (!this.channel) throw E.unsupported('No hay canal de sincronización configurado (channel.type = "none").', 'Configure "folder", "rclone" o "github" en config.json (ver README, sección Sincronización).');
    this.store.list();
    await this.channel.ping();
    const pushed = await this.channel.push(this.mirror);
    const pulled = await this.channel.pull(this.mirror);
    const nowIso = this.iso();
    const updated = [];
    for (const t of this.store.list()) {
      const dir = path.join(this.mirror, t.id);
      if (!fs.existsSync(dir)) continue;
      const probe = clone(t);
      const changes = applyRemote(probe, dir, nowIso);
      if (stableStringify(probe) === stableStringify(t)) continue;
      this.store.update(t.id, (x) => { applyRemote(x, dir, nowIso); });
      for (const c of changes) this._event(t.id, 'sync', { change: c });
      updated.push({ id: t.id, name: t.name, changes });
    }
    this.logger.info(`sync ok pushed=${pushed.copied} updated=${updated.length}`);
    return { channel: this.channel.describe(), pushed, pulled, updated };
  }

  async monitor({ fix = false, sync = false } = {}) {
    let syncError = null;
    if (sync) {
      try { await this.sync(); } catch (e) { syncError = { code: e.code, message: e.message, hint: e.hint }; }
    }
    const nowMs = this.clock().getTime();
    const results = [];
    for (const t of this.store.list().filter((x) => x.state === 'running')) {
      const ev = evaluate(t, nowMs, this.limits);
      const r = { id: t.id, name: t.name, ...ev, action: null };
      if (fix && ['stalled', 'start_timeout'].includes(ev.verdict)) {
        const u = this.store.update(t.id, (x) => {
          this._closeAttempt(x, 'interrupted');
          this._setState(x, 'failed');
          x.phase = null;
          x.error = { code: 'interrupted', message: ev.reason, at: this.iso() };
        });
        const plan = planRecovery(u, this.limits);
        this._event(u.id, 'monitor_interrupted', { verdict: ev.verdict, reason: ev.reason, plan: plan.action });
        r.action = `marcada como interrumpida (failed); sugerido: ${plan.action} — ${plan.reason}`;
      }
      results.push(r);
    }
    return { checkedAt: this.iso(), results, syncError };
  }

  delete(id, { force = false } = {}) {
    const t = this.store.get(id);
    if (t.state === 'running' && !force) throw E.state('La tarea está en ejecución.', 'Cancélela primero (colabctl cancel ID) o use --force.');
    const r = this.store.trash(t.id);
    this.logger.info(`delete ${t.id} → trash`);
    return r;
  }

  // ---- diagnóstico ----------------------------------------------------------
  status() {
    const tasks = this.store.list();
    const counts = Object.fromEntries(STATES.map((s) => [s, 0]));
    for (const t of tasks) counts[t.state]++;
    const nowMs = this.clock().getTime();
    const running = tasks.filter((t) => t.state === 'running').map((t) => ({ id: t.id, name: t.name, ...evaluate(t, nowMs, this.limits) }));
    return {
      version: pkg.version, home: this.home, provider: this.provider.name,
      providerCapabilities: this.provider.capabilities,
      channel: this.channel ? this.channel.describe() : null,
      storage: this.config.colab, counts, total: tasks.length, running,
      damaged: this.store.damaged || [], recoveredFromBackup: this.store.recoveries,
      types: Object.keys(TEMPLATES),
    };
  }

  async doctor() {
    const checks = [];
    const add = (name, ok, detail = '') => checks.push({ name, ok, detail });
    add('Node.js ≥ 18', Number(process.versions.node.split('.')[0]) >= 18, process.version);
    try { fs.accessSync(this.home, fs.constants.W_OK); add('Directorio de datos escribible', true, this.home); } catch { add('Directorio de datos escribible', false, this.home); }
    const scan = scanStore(this.store);
    add('Registros de tareas íntegros', scan.unrecoverable.length === 0, `${scan.total} tarea(s); recuperadas desde .bak: ${scan.recovered.length}; irrecuperables: ${scan.unrecoverable.length}; temporales limpiados: ${scan.tmpRemoved}`);
    for (const [cmd, why] of [['tar', 'copias de seguridad'], ['git', 'canal github'], ['rclone', 'canal rclone/Drive'], ['python3', 'solo para pruebas locales opcionales']]) {
      const r = await this.exec(cmd, ['--version'], { timeoutMs: 8000 });
      add(`${cmd} disponible (${why})`, !r.error && r.code === 0, r.error ? 'no encontrado' : r.stdout.split('\n')[0]);
    }
    if (this.channel) {
      try { await this.channel.ping(); add(`Canal ${this.channel.describe()}`, true, 'accesible'); } catch (e) { add(`Canal ${this.channel.describe()}`, false, e.message); }
    } else add('Canal de sincronización', true, 'ninguno configurado (modo manual)');
    return { checks, ok: checks.filter((c) => !c.ok && !/python3|git|rclone/.test(c.name)).length === 0, scan };
  }

  initHome({ force = false } = {}) {
    this.store.init();
    const f = configPath(this.home);
    if (fs.existsSync(f) && !force) return { created: false, file: f };
    writeJson(f, DEFAULTS);
    return { created: true, file: f };
  }
}

module.exports = { Manager };
