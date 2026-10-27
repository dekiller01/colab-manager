'use strict';
// Definición de comandos de colabctl. Cada comando devuelve { data, text }:
// "data" se imprime con --json; "text" es la salida legible.
const fs = require('fs');
const path = require('path');
const http = require('http');
const readline = require('readline');
const { E } = require('../lib/errors');
const { intFlag } = require('../lib/args');
const { parseJsonObject } = require('../lib/validate');
const { fmtAge, sleepSync } = require('../lib/util');
const { TEMPLATES } = require('../templates');
const { backup, restore } = require('../storage/backup');
const { createHandler } = require('../integrations/dekiller/handler');
const { STATES } = require('../jobs/states');

async function confirm(question, flags) {
  if (flags.yes) return true;
  if (!process.stdin.isTTY) throw E.invalid('Esta operación requiere confirmación.', 'Ejecute en una terminal interactiva o añada --yes.');
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const ans = await new Promise((r) => rl.question(`${question} [s/N] `, r));
  rl.close();
  return /^(s|si|sí|y|yes)$/i.test(ans.trim());
}

const ago = (iso, now) => (iso ? fmtAge(now - Date.parse(iso)) : '—');
const pad = (s, n) => String(s).padEnd(n);

function taskLine(t, now) {
  return `${pad(t.id, 11)}${pad(t.state + (t.phase ? '*' : ''), 11)}${pad(t.type, 13)}${pad(t.name.slice(0, 32), 33)}${ago(t.updatedAt, now)}`;
}

const VERDICT_ES = {
  inactive: 'inactiva', awaiting_start: 'esperando inicio', start_timeout: 'NO INICIÓ', active: 'activa',
  slow: 'lenta', stalled: 'POSIBLE DESCONEXIÓN', unknown: 'sin datos suficientes',
};

const needId = (pos, cmd) => {
  if (!pos[0]) throw E.invalid(`Uso: colabctl ${cmd} ID`, 'Use "colabctl list" para ver los IDs.');
  return pos[0];
};

const COMMANDS = {
  init: {
    summary: 'Crea el directorio de datos y config.json por defecto',
    flags: { bool: ['force'] },
    async run({ m, flags }) {
      const r = m.initHome({ force: !!flags.force });
      return { data: r, text: r.created ? `Configuración creada: ${r.file}` : `Ya existe ${r.file} (use --force para reemplazarla).` };
    },
  },

  status: {
    summary: 'Estado del administrador',
    flags: {},
    async run({ m }) {
      const s = m.status();
      const now = m.clock().getTime();
      const L = [];
      L.push(`Colab Manager v${s.version}`);
      L.push(`Datos:      ${s.home}`);
      L.push(`Proveedor:  ${s.provider} — modo asistido: prepara notebooks y lee estado sincronizado; NO inicia/consulta sesiones de Colab por sí mismo`);
      L.push(`Canal sync: ${s.channel || 'ninguno (use "colabctl mark" para informar el estado a mano)'}`);
      L.push(`Almacén en Colab: ${s.storage.storageMode}${s.storage.storageMode === 'drive' ? ` → MyDrive/${s.storage.driveFolder}` : ' (se pierde al cerrar la sesión)'}`);
      L.push(`Tareas:     ${s.total} (${STATES.map((k) => `${k} ${s.counts[k]}`).join(', ')})`);
      if (s.running.length) {
        L.push('En ejecución:');
        for (const r of s.running) L.push(`  ${r.id}  ${r.name.slice(0, 30)}  [${VERDICT_ES[r.verdict] || r.verdict}] ${r.reason}`);
      }
      if (s.recoveredFromBackup.length) L.push(`⚠ Se recuperaron ${s.recoveredFromBackup.length} registro(s) desde copia .bak.`);
      if (s.damaged.length) L.push(`⚠ Registros irrecuperables: ${s.damaged.map((d) => d.id).join(', ')} (use "colabctl restore").`);
      void now;
      return { data: s, text: L.join('\n') };
    },
  },

  templates: {
    summary: 'Lista los tipos de tarea disponibles',
    flags: {},
    async run() {
      const data = Object.entries(TEMPLATES).map(([name, t]) => ({ name, description: t.description, defaults: t.defaults }));
      return { data, text: data.map((d) => `${pad(d.name, 14)}${d.description}\n${pad('', 14)}por defecto: ${JSON.stringify(d.defaults)}`).join('\n') };
    },
  },

  add: {
    summary: 'Registra una tarea: colabctl add "nombre" [--type T] [--config JSON | --config-file F] [--script F.py]',
    flags: { str: ['type', 'config', 'config-file', 'script'], bool: ['allow-duplicate', 'prepare'] },
    async run({ m, pos, flags }) {
      if (!pos[0]) throw E.invalid('Uso: colabctl add "nombre" [--type demo-counter|text-batch|script] [--config \'{"steps":10}\']');
      let config = {};
      if (flags.config && flags['config-file']) throw E.invalid('Use --config o --config-file, no ambos.');
      if (flags.config) config = parseJsonObject(flags.config, '--config');
      if (flags['config-file']) {
        const f = path.resolve(flags['config-file']);
        if (!fs.existsSync(f) || fs.statSync(f).size > m.limits.maxConfigBytes) throw E.invalid(`--config-file no existe o es demasiado grande: ${f}`);
        config = parseJsonObject(fs.readFileSync(f, 'utf8'), '--config-file');
      }
      let type = flags.type;
      if (flags.script) { type = type || 'script'; config.scriptPath = path.resolve(flags.script); }
      const t = m.add(pos[0], { type: type || 'demo-counter', config, allowDuplicate: !!flags['allow-duplicate'] });
      let text = `Tarea registrada: ${t.id}  (${t.type}, estado ${t.state})`;
      let task = t;
      if (flags.prepare) { task = m.prepareNotebook(t.id); text += `\nNotebook: ${task.notebookPath}`; } else text += `\nSiguiente paso: colabctl notebook ${t.id}   o   colabctl run ${t.id}`;
      return { data: task, text };
    },
  },

  list: {
    summary: 'Lista las tareas [--state ESTADO]',
    flags: { str: ['state'] },
    async run({ m, flags }) {
      const tasks = m.list({ state: flags.state });
      const now = m.clock().getTime();
      const text = tasks.length
        ? [pad('ID', 11) + pad('ESTADO', 11) + pad('TIPO', 13) + pad('NOMBRE', 33) + 'ACTUALIZADA', ...tasks.map((t) => taskLine(t, now)), '(* = ejecución solicitada/en curso)'].join('\n')
        : 'No hay tareas. Cree una con: colabctl add "mi tarea" --prepare';
      return { data: tasks, text };
    },
  },

  notebook: {
    summary: 'Genera el notebook .ipynb de una tarea',
    flags: {},
    async run({ m, pos }) {
      const id = needId(pos, 'notebook');
      const t0 = m.get(id);
      if (['failed', 'cancelled'].includes(t0.state)) throw E.state(`La tarea está "${t0.state}".`, 'Use "colabctl retry ID" (desde cero) o "colabctl resume ID" (desde el punto de recuperación): ambos regeneran el notebook.');
      const t = m.prepareNotebook(id);
      return { data: t, text: `Notebook listo (${t.state}): ${t.notebookPath}\nSiguiente paso: colabctl run ${t.id}` };
    },
  },

  run: {
    summary: 'Solicita la ejecución (modo asistido: prepara y guía; no inicia Colab) [--force]',
    flags: { bool: ['force'] },
    async run({ m, pos, flags }) {
      const id = needId(pos, 'run');
      if (flags.force && !(await confirm('--force reemplaza la ejecución actual (la sesión anterior debe estar detenida o perdida). ¿Continuar?', flags))) return { data: { aborted: true }, text: 'Cancelado.' };
      const { task, launch } = await m.run(id, { force: !!flags.force });
      const text = [`Ejecución solicitada: ${task.id} (intento ${task.attempts.length}) — estado running, fase "esperando inicio".`,
        'Colab NO se ha iniciado: debe abrir el notebook usted. Pasos:', ...launch.steps.map((s, i) => `  ${i + 1}. ${s}`)].join('\n');
      return { data: { task, launch }, text };
    },
  },

  logs: {
    summary: 'Muestra el registro de una tarea [--tail N]',
    flags: { str: ['tail'] },
    async run({ m, pos, flags }) {
      const id = needId(pos, 'logs');
      const r = m.logs(id, { tail: intFlag(flags.tail, 'tail', 1, 5000, 50) });
      const lines = r.entries.map((e) => {
        const body = e.type === 'log' ? `${e.level || 'info'}: ${e.msg}` : `${e.type}${e.change ? ': ' + e.change : ''}${e.error ? ': ' + e.error : ''}${e.reason ? ': ' + e.reason : ''}${e.action ? ' ' + e.action : ''}`;
        return `${e.ts} [${e.src}] ${body}`;
      });
      let text = lines.length ? lines.join('\n') : 'Sin registros todavía.';
      text += `\n(${r.entries.length} de ${r.total} entradas${r.badLines ? `; ${r.badLines} línea(s) dañada(s) omitida(s)` : ''}; los registros de Colab aparecen tras "colabctl sync")`;
      return { data: r, text };
    },
  },

  cancel: {
    summary: 'Cancela una tarea (en Colab, de forma cooperativa)',
    flags: {},
    async run({ m, pos, flags }) {
      const id = needId(pos, 'cancel');
      const t = m.get(id);
      if (!(await confirm(`¿Cancelar ${t.id} "${t.name}" (${t.state})?`, flags))) return { data: { aborted: true }, text: 'Cancelado por el usuario; nada cambió.' };
      const r = await m.cancel(id);
      return { data: r, text: `Tarea ${r.task.id} marcada como cancelled.${r.info ? '\n' + r.info.note + (r.info.channel ? '\nEjecute ahora: colabctl sync' : '') : ''}` };
    },
  },

  retry: {
    summary: 'Reintenta desde cero una tarea failed/cancelled [--force] [--run]',
    flags: { bool: ['force', 'run'] },
    async run({ m, pos, flags }) {
      const id = needId(pos, 'retry');
      if (flags.force && !(await confirm('--force excede el límite de reintentos. ¿Continuar?', flags))) return { data: { aborted: true }, text: 'Cancelado.' };
      const t = m.retry(id, { force: !!flags.force });
      let text = `Reintento preparado (${t.retries}/${m.limits.maxRetries}). Notebook en modo "fresh" (archiva el estado anterior): ${t.notebookPath}`;
      if (flags.run) { const r = await m.run(t.id); text += '\n' + r.launch.steps.map((s, i) => `  ${i + 1}. ${s}`).join('\n'); } else text += `\nSiguiente paso: colabctl run ${t.id}`;
      return { data: t, text };
    },
  },

  resume: {
    summary: 'Reanuda desde el último punto de recuperación [--force] [--run]',
    flags: { bool: ['force', 'run'] },
    async run({ m, pos, flags }) {
      const id = needId(pos, 'resume');
      if (flags.force && !(await confirm('--force excede el límite de reintentos. ¿Continuar?', flags))) return { data: { aborted: true }, text: 'Cancelado.' };
      const t = m.resume(id, { force: !!flags.force });
      let text = `Reanudación preparada desde el paso ${t.lastCheckpoint.step} (${t.retries}/${m.limits.maxRetries}). Notebook: ${t.notebookPath}`;
      if (flags.run) { const r = await m.run(t.id); text += '\n' + r.launch.steps.map((s, i) => `  ${i + 1}. ${s}`).join('\n'); } else text += `\nSiguiente paso: colabctl run ${t.id}`;
      return { data: t, text };
    },
  },

  sync: {
    summary: 'Sube notebooks/cancelaciones y trae estado y resultados por el canal configurado',
    flags: {},
    async run({ m }) {
      const r = await m.sync();
      const L = [`Canal: ${r.channel}`, `Subidos: ${r.pushed.copied ?? 'ok'} · Descargados: ${r.pulled.copied ?? 'ok'}`];
      if (r.pulled.skipped.length || r.pushed.skipped.length) L.push(`Omitidos por tamaño (>50MB): ${[...r.pulled.skipped, ...r.pushed.skipped].join(', ')}`);
      if (r.updated.length) for (const u of r.updated) L.push(`  ${u.id} ${u.name}: ${u.changes.join('; ') || 'actualizada'}`); else L.push('Sin cambios en las tareas.');
      return { data: r, text: L.join('\n') };
    },
  },

  monitor: {
    summary: 'Evalúa tareas en ejecución [--sync] [--fix] [--watch --interval SEG]',
    flags: { bool: ['sync', 'fix', 'watch'], str: ['interval'] },
    async run({ m, flags, print }) {
      const once = async () => {
        const r = await m.monitor({ fix: !!flags.fix, sync: !!flags.sync });
        const L = [];
        if (r.syncError) L.push(`⚠ Sync falló (${r.syncError.code}): ${r.syncError.message}${r.syncError.hint ? ' — ' + r.syncError.hint : ''}`);
        if (!r.results.length) L.push('Ninguna tarea en ejecución.');
        for (const x of r.results) L.push(`${x.id} ${x.name.slice(0, 28)} → ${VERDICT_ES[x.verdict] || x.verdict}: ${x.reason}${x.action ? '\n   ' + x.action : ''}`);
        return { data: r, text: L.join('\n') };
      };
      if (!flags.watch) return once();
      const every = intFlag(flags.interval, 'interval', 10, 3600, 120);
      if (flags.fix && !(await confirm('--watch --fix marcará tareas como interrumpidas automáticamente. ¿Continuar?', flags))) return { data: { aborted: true }, text: 'Cancelado.' };
      print(`Vigilando cada ${every}s (Ctrl+C para salir). Sugerencia en Termux: termux-wake-lock`);
      let stop = false;
      process.on('SIGINT', () => { stop = true; });
      while (!stop) {
        const r = await once();
        print(`[${new Date().toISOString()}]\n${r.text}`);
        for (let i = 0; i < every && !stop; i++) sleepSync(1000);
      }
      return { data: { stopped: true }, text: 'Vigilancia detenida.' };
    },
  },

  mark: {
    summary: 'Informa el estado real a mano: colabctl mark ID running|completed|failed|cancelled|prepared [--note T]',
    flags: { str: ['note'] },
    async run({ m, pos, flags }) {
      const id = needId(pos, 'mark');
      if (!pos[1]) throw E.invalid('Uso: colabctl mark ID ESTADO', `Estados: ${STATES.join(', ')}`);
      const t = m.mark(id, pos[1], { note: flags.note || '' });
      return { data: t, text: `Tarea ${t.id} → ${t.state}` };
    },
  },

  delete: {
    summary: 'Mueve una tarea a trash/ (recuperable) [--force si está running]',
    flags: { bool: ['force'] },
    async run({ m, pos, flags }) {
      const id = needId(pos, 'delete');
      const t = m.get(id);
      if (!(await confirm(`¿Eliminar ${t.id} "${t.name}"? (se mueve a trash/, no se borra)`, flags))) return { data: { aborted: true }, text: 'Nada cambió.' };
      const r = m.delete(id, { force: !!flags.force });
      return { data: r, text: `Movida a ${r.trashedTo}` };
    },
  },

  doctor: {
    summary: 'Diagnóstico del entorno y reparación de registros',
    flags: {},
    async run({ m }) {
      const r = await m.doctor();
      return { data: r, text: r.checks.map((c) => `${c.ok ? '✔' : '✖'} ${c.name}${c.detail ? ' — ' + c.detail : ''}`).join('\n') };
    },
  },

  backup: {
    summary: 'Copia de seguridad (.tar.gz) [--out RUTA]',
    flags: { str: ['out'] },
    async run({ m, flags }) {
      const r = await backup(m.home, m.exec, { out: flags.out, now: m.clock() });
      return { data: r, text: `Copia creada: ${r.file} (${r.bytes} bytes)\nContiene: ${r.entries.join(', ')} (NO incluye secretos: colabctl no los guarda)` };
    },
  },

  restore: {
    summary: 'Restaura una copia: colabctl restore ARCHIVO.tar.gz',
    flags: {},
    async run({ m, pos, flags }) {
      if (!pos[0]) throw E.invalid('Uso: colabctl restore ARCHIVO.tar.gz');
      if (!(await confirm('Se reemplazarán jobs/, notebooks/, sync/ y config.json (los actuales se conservan como *.pre-restore-*). ¿Continuar?', flags))) return { data: { aborted: true }, text: 'Nada cambió.' };
      const r = await restore(m.home, m.exec, pos[0], { now: m.clock() });
      return { data: r, text: `Restaurado: ${r.restored.join(', ')} (${r.tasks} tarea(s)).` };
    },
  },

  serve: {
    summary: 'API local para Dekiller AI (requiere COLABCTL_API_TOKEN, escucha en 127.0.0.1)',
    flags: { str: ['port'] },
    async run({ m, flags, print }) {
      const token = process.env[m.config.dekiller.tokenEnv];
      if (!token || token.length < 16) throw E.config(`Defina ${m.config.dekiller.tokenEnv} con un secreto de al menos 16 caracteres.`, 'Ejemplo: export COLABCTL_API_TOKEN="$(head -c 24 /dev/urandom | base64)"');
      const port = intFlag(flags.port, 'port', 1024, 65535, m.config.dekiller.port);
      const handler = createHandler({ manager: m, token, ratePerMin: m.limits.apiRatePerMin });
      const server = http.createServer(handler);
      await new Promise((res, rej) => { server.once('error', rej); server.listen(port, '127.0.0.1', res); });
      print(`API escuchando en http://127.0.0.1:${port}/v1/status (Ctrl+C para salir)`);
      await new Promise((res) => process.on('SIGINT', res));
      server.close();
      return { data: { stopped: true }, text: 'API detenida.' };
    },
  },

  config: {
    summary: 'Muestra la configuración efectiva',
    flags: {},
    async run({ m }) { return { data: m.config, text: JSON.stringify(m.config, null, 2) }; },
  },
};

module.exports = { COMMANDS, VERDICT_ES };
