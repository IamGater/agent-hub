// @ts-check
import { execFile } from 'node:child_process';

/** @param {number} pid */
export function killTree(pid) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      try {
        process.kill(pid, 'SIGKILL');
      } catch (err) {
        if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ESRCH') throw err;
      }
      resolve(undefined);
      return;
    }
    // Closing the parent does not reliably take down grandchildren (shells, node workers), so kill the tree.
    execFile('taskkill.exe', ['/T', '/F', '/PID', String(pid)], { windowsHide: true }, () =>
      resolve(undefined),
    );
  });
}
