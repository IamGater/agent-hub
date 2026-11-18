// @ts-check

/**
 * One entry of a chat agent's conversation, already normalized from the agent's own protocol.
 * @typedef {{
 *   id: string,
 *   kind: 'user' | 'assistant' | 'tool' | 'approval' | 'notice',
 *   ts: number,
 *   text?: string,
 *   title?: string,
 *   detail?: string,
 *   output?: string,
 *   status?: 'running' | 'ok' | 'error' | 'declined' | 'pending' | 'allowed' | 'denied' | 'cancelled',
 *   level?: 'info' | 'error',
 *   code?: string,
 *   vars?: Record<string, string>,
 *   paths?: string[],
 *   images?: { id: string, name: string }[],
 *   from?: string,
 * }} ChatItem
 *
 * Server-made texts are English; `code` and `vars` let the client show them in its own language.
 * `paths` (files a tool touched) is only an input from the drivers: the manager turns image paths
 * into opaque `images` ids and drops the field. `from` names the agent a relayed message came from.
 */

const FIELD_MAX = { text: 200_000, detail: 20_000, output: 20_000, title: 300 };

/** @param {string | undefined} v @param {number} max */
function cap(v, max) {
  if (v === undefined || v.length <= max) return v;
  return `${v.slice(0, max)}\n… (truncated, ${v.length - max} characters)`;
}

/** @param {ChatItem} item */
function sizeOf(item) {
  return (item.text?.length ?? 0) + (item.detail?.length ?? 0) + (item.output?.length ?? 0) + 200;
}

/**
 * Bounded, in-memory only, like the terminal buffer: a conversation can hold secrets the agent read,
 * so it never goes to disk. The oldest entries are dropped first.
 * @param {number} limit approximate size in characters
 */
export function createTranscript(limit) {
  /** @type {ChatItem[]} */
  let items = [];
  /** @type {Map<string, ChatItem>} */
  const byId = new Map();
  let total = 0;

  function trim() {
    while (total > limit && items.length > 1) {
      const old = /** @type {ChatItem} */ (items.shift());
      byId.delete(old.id);
      total -= sizeOf(old);
    }
  }

  return {
    /**
     * Inserts or merges by id and returns the stored copy.
     * @param {ChatItem} patch
     */
    upsert(patch) {
      const clean = { ...patch };
      for (const [k, max] of Object.entries(FIELD_MAX)) {
        const key = /** @type {'text' | 'detail' | 'output' | 'title'} */ (k);
        if (clean[key] !== undefined) clean[key] = cap(clean[key], max);
      }
      const prev = byId.get(clean.id);
      if (prev) {
        total -= sizeOf(prev);
        Object.assign(prev, clean);
        total += sizeOf(prev);
        trim();
        return { ...prev };
      }
      items.push(clean);
      byId.set(clean.id, clean);
      total += sizeOf(clean);
      trim();
      return { ...clean };
    },
    /** @param {string} id @param {string} text @returns {boolean} false when the item is unknown */
    appendText(id, text) {
      const item = byId.get(id);
      if (!item) return false;
      const before = item.text ?? '';
      if (before.length >= FIELD_MAX.text) return true;
      item.text = before + text;
      total += text.length;
      trim();
      return true;
    },
    /** @param {string} id */
    get: (id) => {
      const item = byId.get(id);
      return item ? { ...item } : null;
    },
    list: () => items.map((i) => ({ ...i })),
    clear() {
      items = [];
      byId.clear();
      total = 0;
    },
  };
}
