'use strict';
// Canal "rclone": sincroniza con Google Drive mediante rclone (código abierto), que el
// usuario autoriza UNA vez con OAuth (rclone config). colabctl nunca ve ni guarda tokens.
const fs = require('fs');
const path = require('path');
const { E } = require('../../lib/errors');
const { ID_RE } = require('../../jobs/schema');

class RcloneChannel {
  constructor(cfg, { folder, exec }) {
    this.cfg = cfg;
    this.name = 'rclone';
    this.exec = exec;
    this.remote = `${cfg.remote}:${folder}`;
    this.timeoutMs = (cfg.timeoutSec || 120) * 1000;
  }
  describe() { return `rclone (${this.remote})`; }

  async _run(args) {
    const r = await this.exec('rclone', args, { timeoutMs: this.timeoutMs });
    if (r.error) {
      if (r.error.code === 'ENOENT') throw E.unsupported('rclone no está instalado.', 'Instale con: pkg install rclone');
      if (r.error.code === 'ETIMEDOUT') throw E.network('rclone tardó demasiado (sin conexión o red lenta).', 'Reintente más tarde.');
      throw E.network(`No se pudo ejecutar rclone: ${r.error.message}`);
    }
    if (r.code !== 0) {
      const err = (r.stderr || '').trim();
      if (/didn't find section|not found in config|no such remote/i.test(err)) throw E.config(`El remoto rclone "${this.cfg.remote}" no existe.`, 'Créelo con: rclone config (tipo "drive").');
      if (/no such host|dial tcp|network is unreachable|timeout|connection refused|i\/o timeout|TLS/i.test(err)) throw E.network('Sin conexión a Google Drive.', 'Revise su red y reintente.');
      if (/invalid_grant|token.*expired|oauth2/i.test(err)) throw E.config('La autorización de Drive caducó.', 'Ejecute: rclone config reconnect ' + this.cfg.remote + ':');
      throw E.network(`rclone terminó con error (${r.code}): ${err.slice(-300)}`);
    }
    return r;
  }

  async ping() { await this._run(['mkdir', this.remote]); }

  async push(mirror) {
    const nb = path.join(mirror, 'notebooks');
    let n = 0;
    if (fs.existsSync(nb)) { await this._run(['copy', nb, `${this.remote}/notebooks`]); n++; }
    for (const d of fs.existsSync(mirror) ? fs.readdirSync(mirror, { withFileTypes: true }) : []) {
      if (!d.isDirectory() || !ID_RE.test(d.name)) continue;
      const flag = path.join(mirror, d.name, 'cancel.flag');
      if (fs.existsSync(flag)) { await this._run(['copyto', flag, `${this.remote}/${d.name}/cancel.flag`]); n++; }
    }
    return { copied: n, skipped: [] };
  }

  async pull(mirror) {
    fs.mkdirSync(mirror, { recursive: true, mode: 0o700 });
    await this._run(['copy', this.remote, mirror, '--exclude', 'notebooks/**', '--max-size', '50M']);
    return { copied: null, skipped: [] };
  }

  async colabUrl(task) {
    try {
      const r = await this._run(['lsjson', `${this.remote}/notebooks`, '--files-only']);
      const list = JSON.parse(r.stdout || '[]');
      const f = list.find((x) => x.Name === `${task.id}.ipynb`);
      if (f && /^[A-Za-z0-9_-]{10,}$/.test(f.ID || '')) return `https://colab.research.google.com/drive/${f.ID}`;
    } catch { /* sin URL: el proveedor mostrará instrucciones manuales */ }
    return null;
  }
}

module.exports = { RcloneChannel };
