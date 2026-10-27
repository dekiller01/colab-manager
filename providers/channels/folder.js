'use strict';
// Canal "folder": una carpeta local que representa la carpeta de Drive (ColabManager/).
// Sirve para (a) pruebas sin red, (b) cualquier herramienta de sincronización que
// ya tenga el usuario (Syncthing, FolderSync, etc.) apuntando a esa carpeta.
const fs = require('fs');
const path = require('path');
const { E } = require('../../lib/errors');
const { ID_RE } = require('../../jobs/schema');
const { writeFileAtomic } = require('../../storage/atomic');

const MAX_FILE = 50 * 1024 * 1024;
const MAX_FILES = 5000;

function copyTree(srcDir, dstDir, state, filter = () => true) {
  let entries;
  try { entries = fs.readdirSync(srcDir, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    if (ent.isSymbolicLink()) continue; // nunca seguir enlaces simbólicos
    const s = path.join(srcDir, ent.name);
    const d = path.join(dstDir, ent.name);
    if (ent.isDirectory()) { copyTree(s, d, state, filter); continue; }
    if (!ent.isFile() || !filter(s, ent.name)) continue;
    if (++state.count > MAX_FILES) throw E.limit('Demasiados archivos en el canal de sincronización.');
    const st = fs.statSync(s);
    if (st.size > MAX_FILE) { state.skipped.push(ent.name); continue; }
    try {
      const ds = fs.statSync(d);
      if (ds.size === st.size && ds.mtimeMs >= st.mtimeMs) continue; // ya está al día
    } catch { /* no existe */ }
    writeFileAtomic(d, fs.readFileSync(s), 0o600);
    state.copied++;
  }
}

class FolderChannel {
  constructor(cfg) { this.cfg = cfg; this.name = 'folder'; this.root = cfg.path; }
  describe() { return `folder (${this.root})`; }

  async ping() {
    if (!fs.existsSync(this.root) || !fs.statSync(this.root).isDirectory()) {
      throw E.network(`La carpeta del canal no está disponible: ${this.root}`, 'Verifique que existe y que el almacenamiento está montado (termux-setup-storage).');
    }
  }

  // mirror → remoto: notebooks y banderas de cancelación
  async push(mirror) {
    const st = { count: 0, copied: 0, skipped: [] };
    copyTree(path.join(mirror, 'notebooks'), path.join(this.root, 'notebooks'), st);
    for (const ent of safeDirs(mirror)) copyTree(path.join(mirror, ent), path.join(this.root, ent), st, (_s, n) => n === 'cancel.flag');
    return { copied: st.copied, skipped: st.skipped };
  }

  // remoto → mirror: estado/resultados de cada tarea
  async pull(mirror) {
    const st = { count: 0, copied: 0, skipped: [] };
    for (const ent of safeDirs(this.root)) copyTree(path.join(this.root, ent), path.join(mirror, ent), st);
    return { copied: st.copied, skipped: st.skipped };
  }

  async colabUrl() { return null; }
}

const safeDirs = (root) => {
  try { return fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && ID_RE.test(d.name)).map((d) => d.name); } catch { return []; }
};

module.exports = { FolderChannel };
