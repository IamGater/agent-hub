// @ts-check

/**
 * Decides what happens when the app window on this computer is closed, following the owner's
 * settings (db.js `OnClose`, Settings → "When the app is closed").
 *
 * After the last local window disconnects:
 *   1. grace period: a reload or a brief reconnect does not count as closing;
 *   2. if agents may not work with the window closed (and remote access does not keep them, when
 *      the owner chose that), agent links are cut so linked agents stop talking to each other and
 *      the server waits for every chat agent to finish its current answer (an agent waiting for
 *      approval stays busy), at most `waitMinutes`, then stops the agents;
 *   3. if the owner chose so, the server then shuts down (`onExit`).
 * Opening the window again at any point cancels all this. While no window is open the check
 * repeats, so a settings change, remote access going off or an agent started from the phone are
 * all picked up.
 *
 * @param {{
 *   manager: Pick<import('../sessions/manager.js').Manager, 'list' | 'unlink' | 'stopAll'>,
 *   settings: () => import('../db.js').OnClose,
 *   remoteOn: () => boolean,
 *   onExit: () => void | Promise<void>,
 *   log?: { info: (msg: string) => void },
 *   graceMs?: number, bootGraceMs?: number, pollMs?: number,
 * }} opts
 */
export function createAutoClose({
  manager,
  settings,
  remoteOn,
  onExit,
  log = { info: () => {} },
  graceMs = 15_000,
  bootGraceMs = 60_000,
  pollMs = 2_000,
}) {
  let windows = 0;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  /** @type {number | null} when the drain started, null when not draining */
  let drainStart = null;
  let stopping = false;
  let exited = false;

  /** @param {() => void} fn @param {number} ms */
  function schedule(fn, ms) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(fn, ms);
  }

  const running = () => manager.list().filter((a) => a.status === 'running' || a.status === 'waiting');

  /** Agents must stop now: the window is closed and nothing lets them keep working. */
  function mustStop() {
    const s = settings();
    if (s.agents === 'keep') return false;
    return !(s.keepForRemote && remoteOn());
  }

  function idle() {
    if (exited || stopping || windows > 0) return;
    const s = settings();
    if (!mustStop()) return schedule(idle, graceMs);
    const agents = running();
    if (!agents.length) {
      if (s.exit) return void finish();
      return schedule(idle, graceMs);
    }
    log.info('app window closed, waiting for agents to finish their current answers');
    drainStart = Date.now();
    for (const a of agents) if (a.link) manager.unlink(a.id);
    drain();
  }

  function drain() {
    if (exited || stopping || windows > 0 || drainStart === null) return;
    if (!mustStop()) {
      log.info('agents may keep working now, not stopping them');
      drainStart = null;
      return schedule(idle, graceMs);
    }
    const s = settings();
    const busy = running().filter((a) => a.busy);
    const overdue = Date.now() - drainStart >= s.waitMinutes * 60_000;
    if (busy.length && !overdue) return schedule(drain, pollMs);
    if (busy.length) {
      log.info(`still busy after ${s.waitMinutes} min, stopping: ${busy.map((a) => a.id).join(', ')}`);
    }
    void finish();
  }

  async function finish() {
    stopping = true;
    timer = null;
    drainStart = null;
    if (running().length) {
      await manager.stopAll();
      log.info('agents stopped');
    }
    stopping = false;
    // The window may have been opened while the agents were stopping; then the server stays.
    if (windows > 0) return;
    if (settings().exit) {
      exited = true;
      log.info('shutting down');
      await onExit();
      return;
    }
    schedule(idle, graceMs);
  }

  // Nobody may ever connect (the window failed to open); give the launcher time to open it.
  schedule(idle, bootGraceMs);

  return {
    /** Called with the number of open local windows whenever it changes. @param {number} n */
    windows(n) {
      if (exited) return;
      if (n !== windows) log.info(`app windows open: ${n}`);
      windows = n;
      if (n > 0) {
        if (timer) clearTimeout(timer);
        timer = null;
        if (drainStart !== null) log.info('app window opened again, agents keep running');
        drainStart = null;
      } else {
        schedule(idle, graceMs);
      }
    },
    get draining() {
      return drainStart !== null;
    },
  };
}
