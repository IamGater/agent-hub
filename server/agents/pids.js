// @ts-check
import { execFileSync } from 'node:child_process';
import { z } from 'zod';

const row = z.object({ agent_id: z.string(), pid: z.int().positive(), started_at: z.int() });

/** @param {import('better-sqlite3').Database} db @param {string} agentId @param {number} pid @param {number} startedAt */
export function recordPid(db, agentId, pid, startedAt) {
  db.prepare('INSERT OR REPLACE INTO agent_pids (agent_id, pid, started_at) VALUES (?, ?, ?)').run(
    agentId,
    pid,
    startedAt,
  );
}

/** @param {import('better-sqlite3').Database} db @param {string} agentId */
export function forgetPid(db, agentId) {
  db.prepare('DELETE FROM agent_pids WHERE agent_id = ?').run(agentId);
}

/** @param {number} pid @returns {number | null} start time in ms, null if no such process */
function startTime(pid) {
  try {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', timeout: 15000 },
    );
    const t = Date.parse(out.trim());
    return Number.isNaN(t) ? null : t;
  } catch {
    return null;
  }
}

/**
 * Kills agent process trees recorded by the server. Used by the CLI kill switch, which cannot
 * reach the server's memory, and at startup to clean up after a crash. The start time check
 * keeps us from killing an unrelated process that reused the PID.
 * @param {import('better-sqlite3').Database} db
 * @returns {string[]} ids of agents that were killed
 */
export function killRecorded(db) {
  const rows = z.array(row).parse(db.prepare('SELECT * FROM agent_pids').all());
  const killed = [];
  for (const r of rows) {
    if (process.platform === 'win32') {
      const t = startTime(r.pid);
      if (t !== null && Math.abs(t - r.started_at) < 10_000) {
        execFileSync('taskkill.exe', ['/T', '/F', '/PID', String(r.pid)], {
          windowsHide: true,
          stdio: 'ignore',
        });
        killed.push(r.agent_id);
      }
    } else {
      try {
        process.kill(r.pid, 'SIGKILL');
        killed.push(r.agent_id);
      } catch (err) {
        if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ESRCH') throw err;
      }
    }
    forgetPid(db, r.agent_id);
  }
  return killed;
}
