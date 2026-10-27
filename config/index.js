'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { E } = require('../lib/errors');
const { readJson } = require('../storage/atomic');

const DEFAULTS = {
  schema: 1,
  provider: 'manual',
  channel: { type: 'none' },
  colab: { storageMode: 'drive', driveFolder: 'ColabManager' },
  limits: {
    maxRetries: 3, maxConcurrent: 1, startTimeoutMin: 30, staleMin: 15, staleFactor: 5,
    maxSilenceMin: 120, concurrentGuardSec: 90, maxConfigBytes: 65536, maxScriptBytes: 204800, apiRatePerMin: 60,
  },
  dekiller: { enabled: false, tokenEnv: 'COLABCTL_API_TOKEN', host: '127.0.0.1', port: 8787 },
};

const PROVIDERS = ['manual', 'colab-api', 'colab-enterprise'];
const CHANNELS = ['none', 'folder', 'rclone', 'github'];
const SECRET_KEY = /(password|passwd|secret|token|apikey|api_key|cookie|credential)/i;

function resolveHome(env = process.env) {
  const h = env.COLABCTL_HOME || path.join(os.homedir(), '.colab-manager');
  if (!path.isAbsolute(h)) throw E.config('COLABCTL_HOME debe ser una ruta absoluta.');
  return path.resolve(h);
}

function merge(base, over) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = merge(base[k], v);
    } else out[k] = v;
  }
  return out;
}

function findSecrets(obj, trail = '') {
  const found = [];
  for (const [k, v] of Object.entries(obj || {})) {
    const p = trail ? `${trail}.${k}` : k;
    if (v && typeof v === 'object') found.push(...findSecrets(v, p));
    else if (SECRET_KEY.test(k) && !/Env$/.test(k) && typeof v === 'string' && v.length > 0) found.push(p);
  }
  return found;
}

const num = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;

function validateChannel(ch, where = 'channel') {
  const errs = [];
  if (!ch || typeof ch !== 'object' || !CHANNELS.includes(ch.type)) {
    return [`${where}.type debe ser uno de: ${CHANNELS.join(', ')}`];
  }
  if (ch.type === 'folder') {
    if (typeof ch.path !== 'string' || !path.isAbsolute(ch.path) || ch.path.includes('\0')) errs.push(`${where}.path debe ser una ruta absoluta`);
  }
  if (ch.type === 'rclone') {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(ch.remote || '')) errs.push(`${where}.remote inválido (letras, números, _ o -)`);
    if (ch.timeoutSec != null && !num(ch.timeoutSec, 5, 3600)) errs.push(`${where}.timeoutSec fuera de rango (5-3600)`);
  }
  if (ch.type === 'github') {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(ch.repo || '')) errs.push(`${where}.repo debe ser usuario/repositorio`);
    if (ch.branch != null && !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,59}$/.test(ch.branch)) errs.push(`${where}.branch inválido`);
    if (ch.dir != null && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(ch.dir)) errs.push(`${where}.dir inválido`);
    if (ch.results) errs.push(...validateChannel(ch.results, `${where}.results`).map((e) => e));
    if (ch.results && ch.results.type === 'github') errs.push(`${where}.results no puede ser github`);
  }
  return errs;
}

function validateConfig(c) {
  const errs = [];
  if (!PROVIDERS.includes(c.provider)) errs.push(`provider debe ser uno de: ${PROVIDERS.join(', ')}`);
  errs.push(...validateChannel(c.channel));
  if (!['drive', 'local'].includes(c.colab.storageMode)) errs.push('colab.storageMode debe ser "drive" o "local"');
  if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,59}$/.test(c.colab.driveFolder || '')) errs.push('colab.driveFolder inválido');
  const L = c.limits;
  const ranges = { maxRetries: [0, 20], maxConcurrent: [1, 5], startTimeoutMin: [1, 1440], staleMin: [1, 1440], staleFactor: [1, 100], maxSilenceMin: [1, 2880], concurrentGuardSec: [0, 3600], maxConfigBytes: [1024, 5e6], maxScriptBytes: [1024, 5e6], apiRatePerMin: [1, 10000] };
  for (const [k, [a, b]] of Object.entries(ranges)) if (!num(L[k], a, b)) errs.push(`limits.${k} fuera de rango (${a}-${b})`);
  if (!num(c.dekiller.port, 1024, 65535)) errs.push('dekiller.port fuera de rango');
  if (!/^[A-Z_][A-Z0-9_]{0,63}$/.test(c.dekiller.tokenEnv || '')) errs.push('dekiller.tokenEnv debe ser un nombre de variable de entorno');
  for (const p of findSecrets(c)) errs.push(`"${p}" parece un secreto. No guarde secretos en config.json: use variables de entorno.`);
  return errs;
}

function configPath(home) { return path.join(home, 'config.json'); }

function loadConfig(home) {
  let user = {};
  const r = readJson(configPath(home), { validate: (d) => (d && typeof d === 'object' && !Array.isArray(d)) });
  if (r) user = r.data;
  const cfg = merge(DEFAULTS, user);
  const errs = validateConfig(cfg);
  if (errs.length) throw E.config(`config.json inválido:\n  - ${errs.join('\n  - ')}`, `Edite ${configPath(home)} o ejecute "colabctl init --force".`);
  return cfg;
}

module.exports = { DEFAULTS, resolveHome, loadConfig, validateConfig, configPath, merge, findSecrets, PROVIDERS, CHANNELS };
