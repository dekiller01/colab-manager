'use strict';
// Verifica los artefactos de entrega: scripts de shell, notebook de ejemplo y ZIP instalable.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const has = (c) => spawnSync(c, ['--version'], { stdio: 'ignore' }).status === 0 || spawnSync('which', [c], { stdio: 'ignore' }).status === 0;
const PY = has('python3');

test('los scripts de shell tienen sintaxis válida', { skip: !has('bash') }, () => {
  for (const f of ['install-termux.sh', 'update.sh', 'build-zip.sh']) {
    const r = spawnSync('bash', ['-n', path.join(ROOT, 'scripts', f)], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `${f}: ${r.stderr}`);
  }
});

test('el notebook de ejemplo se regenera y es JSON/Python válido', { skip: !PY }, () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'make-example-notebook.js')], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const nb = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples', 'ejemplo-colab.ipynb'), 'utf8'));
  assert.strictEqual(nb.nbformat, 4);
  const code = nb.cells.filter((c) => c.cell_type === 'code').map((c) => c.source.join(''));
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-')), 'all.py');
  fs.writeFileSync(f, code.join('\n\n'));
  const py = spawnSync('python3', ['-I', '-c', 'import ast,sys;ast.parse(open(sys.argv[1]).read())', f], { encoding: 'utf8' });
  assert.strictEqual(py.status, 0, py.stderr);
});

test('el script de usuario de ejemplo genera un notebook con sintaxis válida', { skip: !PY }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-home-'));
  const env = { ...process.env, COLABCTL_HOME: home };
  const r = spawnSync(process.execPath, [path.join(ROOT, 'colabctl.js'), 'add', 'ejemplo', '--script', path.join(ROOT, 'examples', 'mi-tarea.py'), '--config', '{"n":5}', '--prepare', '--json'], { env, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  assert.strictEqual(JSON.parse(r.stdout).data.state, 'prepared');
});

test('el ZIP se construye, no incluye datos/secretos y las pruebas pasan desde una copia extraída', { skip: !(has('zip') && has('unzip') && has('bash')) }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-zip-'));
  const zip = path.join(tmp, 'out.zip');
  let r = spawnSync('bash', [path.join(ROOT, 'scripts', 'build-zip.sh'), zip], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  const list = spawnSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
  for (const must of ['colab-manager/colabctl.js', 'colab-manager/README.md', 'colab-manager/.gitignore', 'colab-manager/config/config.example.json', 'colab-manager/templates/runtime.py', 'colab-manager/scripts/install-termux.sh', 'colab-manager/examples/ejemplo-colab.ipynb']) {
    assert.ok(list.includes(must), `falta ${must}`);
  }
  assert.ok(!list.some((n) => /\.zip$|node_modules|__pycache__|\.bak$|config\.json$/.test(n) && !/config\.example\.json$/.test(n)), 'el ZIP contiene archivos no deseados');
  const out = path.join(tmp, 'x');
  fs.mkdirSync(out);
  assert.strictEqual(spawnSync('unzip', ['-q', zip, '-d', out]).status, 0);
  // Evita recursión infinita: la copia extraída corre solo las pruebas que no construyen otro ZIP.
  r = spawnSync(process.execPath, ['--test', ...fs.readdirSync(path.join(out, 'colab-manager', 'tests')).filter((f) => f.endsWith('.test.js') && f !== 'scripts.test.js').map((f) => path.join(out, 'colab-manager', 'tests', f))], { encoding: 'utf8', cwd: path.join(out, 'colab-manager') });
  assert.strictEqual(r.status, 0, r.stdout.slice(-2000));
});
