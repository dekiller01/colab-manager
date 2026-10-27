'use strict';
// Genera notebooks .ipynb (nbformat 4) compatibles con Google Colab a partir de plantillas.
const crypto = require('crypto');
const { getTemplate, runtimeSource } = require('../templates');
const { writeFileAtomic } = require('../storage/atomic');

const cellId = () => crypto.randomBytes(4).toString('hex');
const toLines = (text) => {
  const parts = text.replace(/\r\n/g, '\n').split('\n');
  return parts.map((l, i) => (i < parts.length - 1 ? l + '\n' : l)).filter((l, i, a) => !(i === a.length - 1 && l === ''));
};
const md = (text) => ({ cell_type: 'markdown', id: cellId(), metadata: {}, source: toLines(text) });
const code = (text, extra = {}) => ({ cell_type: 'code', id: cellId(), metadata: extra, execution_count: null, outputs: [], source: toLines(text) });

// Un literal de cadena Python válido a partir de texto JSON (JSON.stringify produce escapes compatibles).
const pyStringLiteral = (s) => JSON.stringify(s).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

/**
 * @param task   tarea (id, name, type, config)
 * @param opts   { attempt, resumeMode, storage:{mode,driveFolder}, limits, generatedAt, concurrentGuardSec }
 */
function buildNotebook(task, opts) {
  const tpl = getTemplate(task.type);
  const jobSource = tpl.source(task.config, opts.limits);
  const { checkpointEvery, requirements, allowInstall, ...job } = task.config;
  void checkpointEvery;
  const runtimeCfg = {
    schema: 1,
    taskId: task.id,
    name: task.name,
    type: task.type,
    attempt: opts.attempt,
    resumeMode: opts.resumeMode,
    storage: opts.storage,
    requirements: requirements || [],
    allowInstall: !!allowInstall,
    concurrentGuardSec: opts.concurrentGuardSec ?? 90,
    generatedAt: opts.generatedAt,
    job: { ...job, checkpointEvery: task.config.checkpointEvery },
  };
  const jobHash = crypto.createHash('sha256').update(jobSource).digest('hex').slice(0, 12);

  const intro = [
    `# Colab Manager · ${task.name}`,
    '',
    `**Tarea:** \`${task.id}\` · **tipo:** \`${task.type}\` · **intento:** ${opts.attempt} · **modo:** \`${opts.resumeMode}\``,
    '',
    '**Cómo usar este notebook**',
    '1. Menú *Entorno de ejecución → Ejecutar todo*.',
    opts.storage.mode === 'drive'
      ? '2. Autoriza el montaje de Google Drive cuando Colab lo pida (ahí se guardan estado, puntos de recuperación y resultados).'
      : '2. Almacenamiento **local**: los archivos se pierden al terminar la sesión.',
    '3. En Termux: `colabctl sync` para traer estado y resultados; `colabctl status` para ver el avance.',
    '',
    '- Si la sesión se desconecta, vuelve a abrir este notebook y ejecútalo: detecta la ejecución incompleta y reanuda desde el último punto de recuperación.',
    '- Este notebook **no** descarga modelos ni instala paquetes salvo que la tarea lo haya habilitado explícitamente (`allowInstall`).',
    '- No escribas contraseñas ni tokens en este notebook. Para secretos usa *Secretos* de Colab (🔑).',
  ].join('\n');

  const nb = {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      colab: { name: `${task.id}-${task.name}`.slice(0, 80), provenance: [], toc_visible: true },
      kernelspec: { name: 'python3', display_name: 'Python 3' },
      language_info: { name: 'python' },
      colab_manager: { schema: 1, taskId: task.id, attempt: opts.attempt, generatedAt: opts.generatedAt, jobSha256: jobHash },
    },
    cells: [
      md(intro),
      code(`# 1) Configuración de la tarea (generada; no contiene secretos)\nimport json\nCONFIG = json.loads(${pyStringLiteral(JSON.stringify(runtimeCfg, null, 2))})\nprint('Tarea:', CONFIG['taskId'], '| intento', CONFIG['attempt'], '| modo', CONFIG['resumeMode'])`,
        { cellView: 'form', title: 'Configuración' }),
      code(runtimeSource(), { title: 'Runtime de Colab Manager (no editar)' }),
      code(`# 3) Trabajo (${task.type})\n${jobSource.trimEnd()}\n`, { title: `Trabajo: ${task.type}` }),
      code('# 4) Ejecutar con validación, puntos de recuperación y registro\nestado_final = main(CONFIG, run)\nprint("Estado final:", estado_final)'),
    ],
  };
  return nb;
}

// Validación estructural del notebook generado (sin dependencias).
function validateNotebook(nb) {
  const e = [];
  if (!nb || typeof nb !== 'object') return ['no es un objeto'];
  if (nb.nbformat !== 4) e.push('nbformat debe ser 4');
  if (!Array.isArray(nb.cells) || nb.cells.length < 4) e.push('faltan celdas');
  const ids = new Set();
  for (const [i, c] of (nb.cells || []).entries()) {
    if (!['code', 'markdown'].includes(c.cell_type)) e.push(`celda ${i}: tipo inválido`);
    if (!Array.isArray(c.source) || c.source.some((l) => typeof l !== 'string')) e.push(`celda ${i}: source inválido`);
    if (c.cell_type === 'code' && (!Array.isArray(c.outputs) || !('execution_count' in c))) e.push(`celda ${i}: faltan outputs/execution_count`);
    if (nb.nbformat_minor >= 5) { if (!c.id || ids.has(c.id)) e.push(`celda ${i}: id ausente o repetido`); ids.add(c.id); }
  }
  if (!nb.metadata || !nb.metadata.colab_manager) e.push('falta metadata.colab_manager');
  if (JSON.stringify(nb).match(/(ya29\.[0-9A-Za-z_-]{20,}|AIza[0-9A-Za-z_-]{30,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/)) e.push('el notebook parece contener un secreto');
  return e;
}

function writeNotebook(file, nb) {
  const problems = validateNotebook(nb);
  if (problems.length) throw new Error(`Notebook inválido: ${problems.join('; ')}`);
  writeFileAtomic(file, JSON.stringify(nb, null, 1) + '\n');
}

module.exports = { buildNotebook, validateNotebook, writeNotebook };
