// @ts-check
import crypto from 'node:crypto';

export function randomToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/** @param {string} value */
export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** @param {string} a @param {string} b hex digests of equal length */
export function sameHash(a, b) {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}
