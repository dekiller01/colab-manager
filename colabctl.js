#!/usr/bin/env node
'use strict';
const { parseArgs } = require('./lib/args');
const { AppError, E } = require('./lib/errors');
const { redact } = require('./logs/redact');
const { resolveHome } = require('./config');
const { Manager } = require('./jobs/manager');
const { COMMANDS } = require('./cli/commands');
const pkg = require('./package.json');

function help() {
  const w = Math.max(...Object.keys(COMMANDS).map((k) => k.length)) + 2;
  return [
    `colabctl v${pkg.version} — administrador asistido de tareas de Google Colab (Termux)`,
    '',
    'Uso: colabctl COMANDO [argumentos] [opciones]',
    '',
    ...Object.entries(COMMANDS).map(([k, c]) => `  ${k.padEnd(w)}${c.summary}`),
    '',
    'Opciones globales: --json (salida para scripts)  --yes/-y (confirmar)  --home RUTA  --help',
    'Variables: COLABCTL_HOME (por defecto ~/.colab-manager)',
    'Códigos de salida: 0 ok · 1 error · 2 uso/validación · 3 función no implementada/limitada',
  ].join('\n');
}

async function main(argv) {
  const cmdName = argv[0];
  if (!cmdName || cmdName === 'help' || cmdName === '--help' || cmdName === '-h') { console.log(help()); return 0; }
  if (cmdName === 'version' || cmdName === '--version') { console.log(pkg.version); return 0; }
  const cmd = COMMANDS[cmdName];
  if (!cmd) { console.error(`Comando desconocido: ${cmdName}\n\n${help()}`); return 2; }

  const json = argv.includes('--json');
  try {
    const { pos, flags } = parseArgs(argv.slice(1), cmd.flags || {});
    if (flags.help) { console.log(`colabctl ${cmdName} — ${cmd.summary}`); return 0; }
    const home = flags.home ? require('path').resolve(flags.home) : resolveHome();
    const m = Manager.open(home);
    const print = (s) => { if (!json) console.log(s); };
    const r = await cmd.run({ m, pos, flags, print });
    if (json) console.log(JSON.stringify({ ok: true, data: r.data }, null, 2));
    else console.log(r.text);
    return 0;
  } catch (e) {
    const known = e instanceof AppError;
    const err = known ? e : E.invalid(`Error inesperado: ${e.message}`);
    if (!known) err.code = 'EINTERNAL';
    if (json) console.log(JSON.stringify({ ok: false, error: { code: err.code, message: redact(err.message), hint: err.hint } }, null, 2));
    else {
      console.error(`✖ ${redact(err.message)}`);
      if (err.hint) console.error(`  → ${redact(err.hint)}`);
      if (!known && process.env.COLABCTL_DEBUG) console.error(e.stack);
    }
    return known ? err.exit : 1;
  }
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
