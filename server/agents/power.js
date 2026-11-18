// @ts-check
import { execFile } from 'node:child_process';
import path from 'node:path';

export const SHUTDOWN_DELAY_S = 60;

/**
 * Turning the computer off: a fixed program with fixed arguments, nothing from the request.
 * Windows waits SHUTDOWN_DELAY_S seconds and shows its own notice, so a mistake can be cancelled.
 * @typedef {{ shutdown: () => Promise<void>, cancel: () => Promise<boolean> }} Power
 * @returns {Power}
 */
export function createPower() {
  const exe = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'shutdown.exe');
  /** @param {string[]} args @returns {Promise<number>} exit code */
  const run = (args) =>
    new Promise((resolve, reject) => {
      if (process.platform !== 'win32') {
        reject(new Error('only supported on Windows'));
        return;
      }
      execFile(exe, args, { windowsHide: true }, (err) =>
        resolve(err ? Number(/** @type {any} */ (err).code ?? 1) : 0),
      );
    });
  return {
    async shutdown() {
      const code = await run(['/s', '/t', String(SHUTDOWN_DELAY_S), '/c', 'Agent Hub: shutdown requested']);
      // 1190 means a shutdown is already scheduled, which is what was asked for.
      if (code !== 0 && code !== 1190) throw new Error(`shutdown.exe exited with ${code}`);
    },
    // false when there was nothing to cancel.
    cancel: async () => (await run(['/a'])) === 0,
  };
}
