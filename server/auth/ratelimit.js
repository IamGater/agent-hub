// @ts-check

/**
 * Failure counter with lockout, applied both per IP and globally. There is a single user, so a
 * global lock is cheap insurance against an attacker rotating addresses or spoofing X-Forwarded-For.
 * The price is that an attacker inside the tailnet can lock the owner out for a while.
 * @param {{ now: () => number, perIp?: number, global?: number, windowMs?: number, lockMs?: number }} opts
 */
export function createLimiter({
  now,
  perIp = 5,
  global = 10,
  windowMs = 15 * 60 * 1000,
  lockMs = 15 * 60 * 1000,
}) {
  /** @type {Map<string, { fails: number[], lockedUntil: number }>} */
  const map = new Map();
  const GLOBAL = '*';
  const globalEntry = { fails: /** @type {number[]} */ ([]), lockedUntil: 0 };

  /** @param {string} key */
  function entry(key) {
    if (key === GLOBAL) return globalEntry;
    let e = map.get(key);
    if (!e) {
      // Bound memory: an attacker with many addresses should not grow this without limit.
      if (map.size > 1000) map.clear();
      e = { fails: [], lockedUntil: 0 };
      map.set(key, e);
    }
    return e;
  }

  return {
    /**
     * @param {string} ip
     * @returns {number} milliseconds until unlocked, 0 if allowed
     */
    blocked(ip) {
      const t = now();
      const wait = Math.max(entry(ip).lockedUntil, entry(GLOBAL).lockedUntil) - t;
      return wait > 0 ? wait : 0;
    },
    /**
     * @param {string} ip
     * @returns {boolean} true if this failure triggered a lockout
     */
    fail(ip) {
      const t = now();
      let locked = false;
      for (const [key, max] of /** @type {const} */ ([
        [ip, perIp],
        [GLOBAL, global],
      ])) {
        const e = entry(key);
        e.fails = e.fails.filter((f) => f > t - windowMs);
        e.fails.push(t);
        if (e.fails.length >= max) {
          e.lockedUntil = t + lockMs;
          e.fails = [];
          locked = true;
        }
      }
      return locked;
    },
    /** @param {string} ip */
    succeed(ip) {
      map.delete(ip);
    },
  };
}

/**
 * Plain request budget per key over a sliding window. Used for unauthenticated endpoints that
 * create server state (challenges) and for WebSocket messages.
 * @param {{ now: () => number, max: number, windowMs: number }} opts
 */
export function createBudget({ now, max, windowMs }) {
  /** @type {Map<string, number[]>} */
  const map = new Map();
  /** @param {string} key */
  return function take(key) {
    const t = now();
    if (map.size > 1000 && !map.has(key)) map.clear();
    const hits = (map.get(key) ?? []).filter((h) => h > t - windowMs);
    if (hits.length >= max) {
      map.set(key, hits);
      return false;
    }
    hits.push(t);
    map.set(key, hits);
    return true;
  };
}
