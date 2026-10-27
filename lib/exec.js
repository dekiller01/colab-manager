'use strict';
const { spawn } = require('child_process');

const MAX_OUT = 1024 * 1024;

// Ejecuta un programa SIN shell (args como arreglo → sin inyección de comandos).
// Nunca lanza: devuelve { code, stdout, stderr, error }.
function exec(cmd, args = [], { timeoutMs = 120000, env = {}, cwd } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { shell: false, cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      return resolve({ code: -1, stdout: '', stderr: '', error });
    }
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ code: -1, stdout, stderr, error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) });
    }, timeoutMs);
    child.stdout.on('data', (d) => { if (stdout.length < MAX_OUT) stdout += d; });
    child.stderr.on('data', (d) => { if (stderr.length < MAX_OUT) stderr += d; });
    child.on('error', (error) => finish({ code: -1, stdout, stderr, error }));
    child.on('close', (code) => finish({ code, stdout, stderr, error: null }));
  });
}

module.exports = { exec };
