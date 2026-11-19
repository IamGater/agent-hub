// @ts-check

const TTL_MS = 2 * 60 * 1000;
const MAX = 256;

/**
 * @typedef {'enroll' | 'login' | 'stepup' | 'action' | 'register'} Purpose
 * @typedef {{ purpose: Purpose, sid: string | null, action: unknown, expires: number }} Entry
 */

/**
 * Server-side store of outstanding WebAuthn challenges. Each challenge is bound to a purpose and,
 * when issued to a logged-in user, to that web session. take() always deletes the entry.
 * @param {() => number} now
 */
export function createChallenges(now) {
  /** @type {Map<string, Entry>} */
  const map = new Map();

  function prune() {
    const t = now();
    for (const [k, v] of map) if (v.expires <= t) map.delete(k);
  }

  return {
    /**
     * @param {string} challenge
     * @param {Purpose} purpose
     * @param {{ sid?: string | null, action?: unknown }} [bind]
     */
    add(challenge, purpose, bind = {}) {
      if (map.size >= MAX) prune();
      if (map.size >= MAX) throw new Error('too many pending challenges');
      map.set(challenge, {
        purpose,
        sid: bind.sid ?? null,
        action: bind.action ?? null,
        expires: now() + TTL_MS,
      });
    },
    /**
     * @param {string} challenge
     * @param {Purpose} purpose
     * @param {string | null} [sid]
     * @returns {Entry | null}
     */
    take(challenge, purpose, sid = null) {
      const entry = map.get(challenge);
      map.delete(challenge);
      if (!entry || entry.purpose !== purpose || entry.sid !== sid) return null;
      if (entry.expires <= now()) return null;
      return entry;
    },
    /** @param {string} sid */
    dropSession(sid) {
      for (const [k, v] of map) if (v.sid === sid) map.delete(k);
    },
    clear: () => map.clear(),
    get size() {
      return map.size;
    },
  };
}

/** @typedef {ReturnType<typeof createChallenges>} Challenges */
