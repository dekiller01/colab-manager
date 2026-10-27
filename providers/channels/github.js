'use strict';
// Canal "github": distribuye notebooks a un repositorio (usa SU git ya autenticado;
// colabctl no maneja tokens). Colab abre notebooks de GitHub por URL. Use un repositorio
// PRIVADO: el notebook contiene la configuración de la tarea.
// Este canal NO recoge resultados: combínelo con "results" (folder/rclone) en la configuración.
const fs = require('fs');
const path = require('path');
const { E } = require('../../lib/errors');

class GithubChannel {
  constructor(cfg, { home, exec }) {
    this.cfg = cfg;
    this.name = 'github';
    this.exec = exec;
    this.branch = cfg.branch || 'main';
    this.dir = cfg.dir || 'notebooks';
    this.clone = path.join(home, 'github-clone');
  }
  describe() { return `github (${this.cfg.repo}@${this.branch}/${this.dir})`; }

  async _git(args, opts = {}) {
    const r = await this.exec('git', args, { timeoutMs: 120000, env: { GIT_TERMINAL_PROMPT: '0' }, ...opts });
    if (r.error) {
      if (r.error.code === 'ENOENT') throw E.unsupported('git no está instalado.', 'Instale con: pkg install git');
      throw E.network(`git falló: ${r.error.message}`);
    }
    if (r.code !== 0) {
      const err = (r.stderr || '').trim();
      if (/Could not resolve host|unable to access|Connection (timed out|refused)|Network is unreachable/i.test(err)) throw E.network('Sin conexión a GitHub.', 'Reintente cuando tenga red.');
      if (/Authentication failed|could not read Username|Permission denied|403|404/i.test(err)) throw E.config('GitHub rechazó el acceso.', 'Configure git con sus credenciales (por ejemplo: pkg install gh && gh auth login) y verifique el nombre del repositorio.');
      throw E.network(`git terminó con error: ${err.slice(-300)}`);
    }
    return r;
  }

  async ping() {
    await this._git(['ls-remote', '--heads', `https://github.com/${this.cfg.repo}.git`]);
  }

  async push(mirror) {
    if (!fs.existsSync(path.join(this.clone, '.git'))) {
      await this._git(['clone', '--branch', this.branch, '--single-branch', `https://github.com/${this.cfg.repo}.git`, this.clone]);
    } else {
      await this._git(['pull', '--ff-only', 'origin', this.branch], { cwd: this.clone });
    }
    const src = path.join(mirror, 'notebooks');
    const dst = path.join(this.clone, this.dir);
    fs.mkdirSync(dst, { recursive: true });
    let n = 0;
    for (const f of fs.existsSync(src) ? fs.readdirSync(src) : []) {
      if (!/^t-[0-9a-f]{8}\.ipynb$/.test(f)) continue;
      fs.copyFileSync(path.join(src, f), path.join(dst, f));
      n++;
    }
    await this._git(['add', '--', this.dir], { cwd: this.clone });
    const st = await this._git(['status', '--porcelain', '--', this.dir], { cwd: this.clone });
    if (st.stdout.trim()) {
      await this._git(['commit', '-m', 'colabctl: actualizar notebooks'], { cwd: this.clone });
      await this._git(['push', 'origin', this.branch], { cwd: this.clone });
    }
    return { copied: n, skipped: [] };
  }

  async pull() {
    throw E.unsupported('El canal github no recoge resultados.', 'Añada "results": {"type":"folder"|"rclone", ...} dentro de channel.');
  }

  async colabUrl(task) {
    return `https://colab.research.google.com/github/${this.cfg.repo}/blob/${this.branch}/${this.dir}/${task.id}.ipynb`;
  }
}

module.exports = { GithubChannel };
