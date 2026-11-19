// @ts-check
import crypto from 'node:crypto';
import { getSetting, setSetting } from '../db.js';
import { sha256, sameHash } from './tokens.js';

const TTL_MS = 10 * 60 * 1000;
const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

/**
 * Issues a one-time code for connecting a phone and returns it in plain text (it is only stored
 * hashed). A new code replaces the previous one. 26 characters from a 30-symbol alphabet is about
 * 127 bits, short enough to type on a phone.
 * @param {import('better-sqlite3').Database} db
 * @param {number} now
 */
export function issueEnrollCode(db, now) {
  let code = '';
  for (let i = 0; i < 26; i++) code += ALPHABET[crypto.randomInt(ALPHABET.length)];
  setSetting(db, 'enroll_token', sha256(code));
  setSetting(db, 'enroll_expires', String(now + TTL_MS));
  return code.match(/.{1,5}/g)?.join('-') ?? code;
}

/** @param {string} code */
function normalize(code) {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Consumes the code. It is deleted on first correct use, before the ceremony even runs, so a
 * leaked code cannot be replayed even if the registration then fails.
 * @param {import('better-sqlite3').Database} db
 * @param {string} code
 * @param {number} now
 */
export function consumeEnrollCode(db, code, now) {
  const hash = getSetting(db, 'enroll_token');
  const expires = Number(getSetting(db, 'enroll_expires'));
  if (!hash || !(expires > now)) return false;
  if (!sameHash(sha256(normalize(code)), hash)) return false;
  setSetting(db, 'enroll_token', null);
  setSetting(db, 'enroll_expires', null);
  return true;
}

/**
 * Local recovery: wipes all phone passkeys and sessions and turns remote access off.
 * @param {import('better-sqlite3').Database} db
 */
export function resetAuth(db) {
  db.transaction(() => {
    db.prepare('DELETE FROM passkeys').run();
    db.prepare('DELETE FROM web_sessions').run();
    setSetting(db, 'remote_enabled', null);
    setSetting(db, 'enroll_token', null);
    setSetting(db, 'enroll_expires', null);
  })();
}
