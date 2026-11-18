// @ts-check

/**
 * Keeps the most recent output up to roughly `max` bytes. Old chunks are dropped whole,
 * so the replay may start mid escape sequence; the client resets the terminal first.
 * @param {number} max
 */
export function createRing(max) {
  /** @type {{ s: string, n: number }[]} */
  let chunks = [];
  let size = 0;

  return {
    /** @param {string} s */
    push(s) {
      if (s.length >= max) s = s.slice(-max);
      const n = Buffer.byteLength(s);
      const last = chunks.at(-1);
      // PTY output arrives in tiny pieces; merging keeps the chunk list short.
      if (last && last.n < 4096) {
        last.s += s;
        last.n += n;
      } else {
        chunks.push({ s, n });
      }
      size += n;
      while (size > max && chunks.length > 1) {
        size -= /** @type {{ n: number }} */ (chunks.shift()).n;
      }
    },
    read() {
      return chunks.map((c) => c.s).join('');
    },
    clear() {
      chunks = [];
      size = 0;
    },
    get size() {
      return size;
    },
  };
}
