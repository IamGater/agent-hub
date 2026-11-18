// @ts-check
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS passkeys (
  id TEXT PRIMARY KEY,
  rp_id TEXT NOT NULL,
  public_key BLOB NOT NULL,
  counter INTEGER NOT NULL,
  transports TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE TABLE IF NOT EXISTS web_sessions (
  id_hash TEXT PRIMARY KEY,
  passkey_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  stepup_at INTEGER,
  ip TEXT NOT NULL,
  ua TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  event TEXT NOT NULL,
  passkey_id TEXT,
  ip TEXT,
  ua TEXT,
  detail TEXT
);
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit
  BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit
  BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
CREATE TABLE IF NOT EXISTS agent_pids (
  agent_id TEXT PRIMARY KEY,
  pid INTEGER NOT NULL,
  started_at INTEGER NOT NULL
);
`;

/**
 * Restricts the data directory to the current user only. Files created inside inherit the ACL.
 * @param {string} dir
 */
function lockDown(dir) {
  if (process.platform !== 'win32') {
    fs.chmodSync(dir, 0o700);
    return;
  }
  const domain = process.env.USERDOMAIN;
  const user = domain ? `${domain}\\${os.userInfo().username}` : os.userInfo().username;
  execFileSync(
    'icacls.exe',
    [dir, '/inheritance:r', '/grant:r', `${user}:(OI)(CI)F`, '/remove:g', '*S-1-5-32-545', '/Q'],
    { windowsHide: true, stdio: 'pipe' },
  );
}

/**
 * @param {string | null} dataDir null opens an in-memory database (tests)
 * @returns {import('better-sqlite3').Database}
 */
export function openDb(dataDir) {
  let file = ':memory:';
  if (dataDir) {
    fs.mkdirSync(dataDir, { recursive: true });
    lockDown(dataDir);
    file = path.join(dataDir, 'remote-control.db');
  }
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('secure_delete = ON');
  db.exec(SCHEMA);
  return db;
}

/** @param {import('better-sqlite3').Database} db @param {string} key */
export function getSetting(db, key) {
  const row = /** @type {{ value: string } | undefined} */ (
    db.prepare('SELECT value FROM settings WHERE key = ?').get(key)
  );
  return row?.value ?? null;
}

/** @param {import('better-sqlite3').Database} db @param {string} key @param {string | null} value */
export function setSetting(db, key, value) {
  if (value === null) db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  else db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
}

/** @param {import('better-sqlite3').Database} db */
/**
 * The folder each agent was last started in, so the next start offers it again.
 * @param {import('better-sqlite3').Database} db @returns {Record<string, string>}
 */
export function getLastFolders(db) {
  try {
    const map = JSON.parse(getSetting(db, 'last_folders') ?? '{}');
    return map && typeof map === 'object' && !Array.isArray(map) ? map : {};
  } catch {
    return {};
  }
}

/** @param {import('better-sqlite3').Database} db @param {string} agentId @param {string} cwd */
export function setLastFolder(db, agentId, cwd) {
  setSetting(db, 'last_folders', JSON.stringify({ ...getLastFolders(db), [agentId]: cwd }));
}

/** @param {import('better-sqlite3').Database} db @returns {string[]} */
export function getAutoApprove(db) {
  try {
    const ids = JSON.parse(getSetting(db, 'auto_approve') ?? '[]');
    return Array.isArray(ids) ? ids.filter((i) => typeof i === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Agents whose tool requests the server approves without asking. Empty unless the owner chose it.
 * @param {import('better-sqlite3').Database} db @param {string[]} ids
 */
export function setAutoApprove(db, ids) {
  setSetting(db, 'auto_approve', ids.length ? JSON.stringify(ids) : null);
}

/** @param {import('better-sqlite3').Database} db */
export function isRemoteEnabled(db) {
  return getSetting(db, 'remote_enabled') === '1';
}

/**
 * Turning remote access off also ends every session (all sessions are remote: the computer
 * itself needs none), so nothing keeps working through a connection that was already open.
 * @param {import('better-sqlite3').Database} db
 * @param {boolean} on
 * @returns {number} remote sessions revoked
 */
export function setRemoteEnabled(db, on) {
  return db.transaction(() => {
    setSetting(db, 'remote_enabled', on ? '1' : null);
    if (on) return 0;
    return db.prepare('DELETE FROM web_sessions').run().changes;
  })();
}
