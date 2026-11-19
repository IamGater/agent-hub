// @ts-check
import { z } from 'zod';
import { randomToken, sha256 } from './tokens.js';

// Rows are validated on read too: a tampered or half-migrated database must not turn into
// undefined fields that silently pass a comparison.
const passkeyRow = z.object({
  id: z.string().min(1),
  rp_id: z.string().min(1),
  public_key: z.instanceof(Uint8Array),
  counter: z.int().nonnegative(),
  transports: z.string(),
  name: z.string(),
  created_at: z.int(),
  last_used_at: z.int().nullable(),
});

const sessionRow = z.object({
  id_hash: z.string().length(64),
  passkey_id: z.string().min(1),
  created_at: z.int(),
  last_seen_at: z.int(),
  stepup_at: z.int().nullable(),
  ip: z.string(),
  ua: z.string(),
});

/** @typedef {z.infer<typeof passkeyRow>} PasskeyRow */
/** @typedef {z.infer<typeof sessionRow>} SessionRow */

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} [rpID] only passkeys for this relying party
 */
export function listPasskeys(db, rpID) {
  const rows = rpID
    ? db.prepare('SELECT * FROM passkeys WHERE rp_id = ? ORDER BY created_at').all(rpID)
    : db.prepare('SELECT * FROM passkeys ORDER BY created_at').all();
  return z.array(passkeyRow).parse(rows);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} id
 * @param {string} [rpID] when given, a passkey of another relying party is not found
 */
export function getPasskey(db, id, rpID) {
  const row = db.prepare('SELECT * FROM passkeys WHERE id = ?').get(id);
  const pk = row ? passkeyRow.parse(row) : null;
  return pk && (!rpID || pk.rp_id === rpID) ? pk : null;
}

/** @param {import('better-sqlite3').Database} db */
export function countPasskeys(db) {
  return z.int().parse(db.prepare('SELECT count(*) FROM passkeys').pluck().get());
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ id: string, publicKey: Uint8Array, counter: number, transports?: string[] }} cred
 * @param {{ name: string, rpID: string, now: number }} meta
 */
export function addPasskey(db, cred, { name, rpID, now }) {
  db.prepare(
    'INSERT INTO passkeys (id, rp_id, public_key, counter, transports, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(
    cred.id,
    rpID,
    Buffer.from(cred.publicKey),
    cred.counter,
    JSON.stringify(cred.transports ?? []),
    name,
    now,
  );
}

/** @param {import('better-sqlite3').Database} db @param {string} id @param {number} counter @param {number} now */
export function usePasskey(db, id, counter, now) {
  db.prepare('UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?').run(counter, now, id);
}

/**
 * Any passkey can go, even the last one: the phone can always be connected again from the computer.
 * @param {import('better-sqlite3').Database} db
 * @param {string} id
 */
export function removePasskey(db, id) {
  return db.transaction(() => {
    if (!getPasskey(db, id)) return false;
    db.prepare('DELETE FROM passkeys WHERE id = ?').run(id);
    // Sessions opened with a removed passkey die with it.
    db.prepare('DELETE FROM web_sessions WHERE passkey_id = ?').run(id);
    return true;
  })();
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ passkeyId: string, ip: string, ua: string, now: number }} s
 * @returns {{ token: string, hash: string }}
 */
export function createSession(db, { passkeyId, ip, ua, now }) {
  const token = randomToken();
  const hash = sha256(token);
  db.prepare(
    'INSERT INTO web_sessions (id_hash, passkey_id, created_at, last_seen_at, stepup_at, ip, ua) VALUES (?, ?, ?, ?, NULL, ?, ?)',
  ).run(hash, passkeyId, now, now, ip, ua.slice(0, 256));
  return { token, hash };
}

/**
 * Looks up a session by its hash and enforces absolute and idle limits. Expired rows are deleted.
 * @param {import('better-sqlite3').Database} db
 * @param {string} hash
 * @param {{ now: number, absoluteMs: number, idleMs: number }} limits
 * @returns {SessionRow | null}
 */
export function findSession(db, hash, { now, absoluteMs, idleMs }) {
  const raw = db.prepare('SELECT * FROM web_sessions WHERE id_hash = ?').get(hash);
  if (!raw) return null;
  const row = sessionRow.parse(raw);
  if (now - row.created_at >= absoluteMs || now - row.last_seen_at >= idleMs) {
    db.prepare('DELETE FROM web_sessions WHERE id_hash = ?').run(hash);
    return null;
  }
  return row;
}

/** @param {import('better-sqlite3').Database} db @param {string} hash @param {number} now */
export function touchSession(db, hash, now) {
  db.prepare('UPDATE web_sessions SET last_seen_at = ? WHERE id_hash = ?').run(now, hash);
}

/** @param {import('better-sqlite3').Database} db @param {string} hash @param {number} now */
export function stepUp(db, hash, now) {
  db.prepare('UPDATE web_sessions SET stepup_at = ?, last_seen_at = ? WHERE id_hash = ?').run(now, now, hash);
}

/** @param {import('better-sqlite3').Database} db @param {string} hash */
export function deleteSession(db, hash) {
  db.prepare('DELETE FROM web_sessions WHERE id_hash = ?').run(hash);
}

/** @param {import('better-sqlite3').Database} db */
export function deleteAllSessions(db) {
  return db.prepare('DELETE FROM web_sessions').run().changes;
}

/**
 * @param {SessionRow} s
 * @param {number} now
 * @param {number} stepupMs
 * @returns {{ mode: 'view' | 'control', until: number | null }}
 */
export function modeOf(s, now, stepupMs) {
  if (s.stepup_at !== null && now - s.stepup_at < stepupMs) {
    return { mode: 'control', until: s.stepup_at + stepupMs };
  }
  return { mode: 'view', until: null };
}
