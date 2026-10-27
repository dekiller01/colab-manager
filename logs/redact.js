'use strict';
// Elimina secretos conocidos de cualquier texto antes de escribirlo o mostrarlo.
// No es infalible: es una red de seguridad. La regla principal es no guardar secretos.

const PATTERNS = [
  [/AIza[0-9A-Za-z_-]{20,}/g, 'AIza***'],
  [/github_pat_[A-Za-z0-9_]{20,}/g, 'github_pat_***'],
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, 'gh*_***'],
  [/ya29\.[0-9A-Za-z_-]{20,}/g, 'ya29.***'],
  [/sk-[A-Za-z0-9_-]{20,}/g, 'sk-***'],
  [/(Bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi, '$1***'],
  [/((?:password|passwd|secret|token|api[_-]?key|authorization|cookie)["']?\s*[:=]\s*["']?)[^\s"',;}]{4,}/gi, '$1***'],
];

function redact(text) {
  if (text == null) return text;
  let s = String(text);
  for (const [re, rep] of PATTERNS) s = s.replace(re, rep);
  return s;
}

function redactDeep(v) {
  if (typeof v === 'string') return redact(v);
  if (Array.isArray(v)) return v.map(redactDeep);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = redactDeep(val);
    return out;
  }
  return v;
}

module.exports = { redact, redactDeep };
