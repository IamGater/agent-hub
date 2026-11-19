// @ts-check
import { redact, redactDeep } from './redact.js';

/**
 * @typedef {{ passkeyId?: string | null, ip?: string | null, ua?: string | null }} Actor
 * @typedef {'login' | 'login_failed' | 'logout' | 'stepup' | 'stepup_failed'
 *   | 'passkey_added' | 'passkey_removed' | 'agent_start' | 'agent_stop' | 'agent_restart' | 'agent_exit'
 *   | 'input' | 'killswitch' | 'lockout' | 'ws_rejected' | 'action_failed' | 'reset_auth'
 *   | 'enroll_code' | 'enroll_failed' | 'remote_on' | 'remote_off' | 'approval' | 'interrupt'
 *   | 'link' | 'unlink' | 'permissions' | 'auto_approved' | 'shutdown' | 'shutdown_cancel' | 'settings_on_close' | 'server_restart'} AuditEvent
 */

/**
 * Appends one audit record. The table has triggers that forbid UPDATE and DELETE.
 * @param {import('better-sqlite3').Database} db
 * @param {AuditEvent} event
 * @param {Actor | null} actor
 * @param {Record<string, unknown>} [detail]
 * @param {number} [ts]
 */
export function audit(db, event, actor, detail, ts = Date.now()) {
  db.prepare('INSERT INTO audit (ts, event, passkey_id, ip, ua, detail) VALUES (?, ?, ?, ?, ?, ?)').run(
    ts,
    event,
    actor?.passkeyId ?? null,
    actor?.ip ?? null,
    actor?.ua ? redact(actor.ua).slice(0, 256) : null,
    detail ? JSON.stringify(redactDeep(detail)) : null,
  );
}
