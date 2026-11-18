// @ts-check

const MASK = '[REDACTED]';

// Order matters: multi-line blocks first, then specific token formats, then generic key=value.
const PATTERNS = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
  /\bsk-(proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\b(AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bAIza[A-Za-z0-9_-]{35}\b/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{16,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]+@/gi,
];

// .env style lines and JSON-ish pairs whose key name suggests a secret.
const KEY_VALUE =
  /\b([A-Za-z0-9_.-]*(?:SECRET|TOKEN|PASSWORD|PASSWD|PWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?|AUTH)[A-Za-z0-9_.-]*)(["']?\s*[:=]\s*["']?)([^\s"',;]+)/gi;

/**
 * Masks things that look like secrets. Used before anything goes to the audit log or ntfy.
 * @param {string} text
 */
export function redact(text) {
  let out = text;
  for (const re of PATTERNS) out = out.replace(re, MASK);
  return out.replace(KEY_VALUE, (_, key, sep) => `${key}${sep}${MASK}`);
}

/**
 * Applies redact to every string inside a JSON-compatible value.
 * @param {unknown} value
 * @returns {unknown}
 */
export function redactDeep(value) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)]));
  }
  return value;
}
