'use strict';
const { FolderChannel } = require('./folder');
const { RcloneChannel } = require('./rclone');
const { GithubChannel } = require('./github');

// Fábrica de canales. Devuelve null si channel.type = "none".
function createChannel(cfg, { home, folder, exec }) {
  const make = (c) => {
    switch (c.type) {
      case 'folder': return new FolderChannel(c);
      case 'rclone': return new RcloneChannel(c, { folder, exec });
      case 'github': return new GithubChannel(c, { home, exec });
      default: return null;
    }
  };
  if (!cfg || cfg.type === 'none') return null;
  if (cfg.type === 'github' && cfg.results) {
    // Compuesto: GitHub distribuye notebooks; el canal "results" transporta estado y resultados.
    const dist = make(cfg);
    const transport = make(cfg.results);
    return {
      name: 'github+' + transport.name,
      describe: () => `${dist.describe()} + ${transport.describe()}`,
      ping: async () => { await dist.ping(); await transport.ping(); },
      push: async (m) => { const a = await dist.push(m); const b = await transport.push(m); return { copied: (a.copied || 0) + (b.copied || 0), skipped: [...a.skipped, ...b.skipped] }; },
      pull: (m) => transport.pull(m),
      colabUrl: (t) => dist.colabUrl(t),
    };
  }
  return make(cfg);
}

module.exports = { createChannel };
