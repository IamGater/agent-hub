// @ts-check

/**
 * How much of the account's short (5-hour) limit a number of tokens takes.
 *
 * Neither agent says how many tokens one percent of the limit is, and it differs by plan and model,
 * so it is learned: the server counts what the agents of one account spend and compares that with
 * how far the limit moved between two readings of the same window. Tokens are weighed by what they
 * cost relative to plain input (cache reads are cheap, cache writes and output dear), which is what
 * the limits follow. Spending outside the hub (the same account used elsewhere) makes the estimate
 * high rather than low, which is the safe side for a warning.
 *
 * @typedef {{ input: number, output: number, cached: number }} Tokens
 * @typedef {{ percent: number, resetsAt: number | null, units: number }} Anchor
 * @typedef {{ samples: number[], anchor: Anchor | null }} AccountRate
 */

const SAMPLES = 9;
/** Limits are reported in whole percents; a sample spans at least this many to be worth keeping. */
const MIN_STEP = 2;

/** Weighted cost of tokens, in "plain input token" units. @param {Tokens} t */
export function unitsOf(t) {
  return t.input + t.cached * 0.1 + t.output * 5;
}

/** What re-reading a conversation of `tokens` costs: a cold cache is written again, a warm one read. */
export function resumeUnits(tokens, warm) {
  return tokens * (warm ? 0.1 : 1.25);
}

/** @param {number[]} list */
function median(list) {
  const s = [...list].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Two readings belong to the same window when they reset at (about) the same time. */
function sameWindow(/** @type {number | null} */ a, /** @type {number | null} */ b) {
  return a === null || b === null || Math.abs(a - b) < 5 * 60_000;
}

/**
 * @param {{ saved?: Record<string, AccountRate>, onSave?: (all: Record<string, AccountRate>) => void }} [opts]
 */
export function createRateBook({ saved = {}, onSave = () => {} } = {}) {
  /** @type {Record<string, AccountRate>} */
  const book = {};
  for (const [k, v] of Object.entries(saved)) {
    if (Array.isArray(v?.samples)) {
      book[k] = {
        samples: v.samples.filter((n) => Number.isFinite(n) && n > 0).slice(-SAMPLES),
        anchor: null,
      };
    }
  }
  /** Units spent per account since the server started; only differences are ever used. */
  /** @type {Record<string, number>} */
  const spent = {};

  /** @param {string} account */
  const entry = (account) => (book[account] ??= { samples: [], anchor: null });

  return {
    /** @param {string} account @param {number} units */
    spend(account, units) {
      if (units > 0) spent[account] = (spent[account] ?? 0) + units;
    },
    /**
     * A reading of the short window: `percent` used, resetting at `resetsAt` (ms).
     * @param {string} account @param {number} percent @param {number | null} resetsAt
     */
    reading(account, percent, resetsAt) {
      if (!Number.isFinite(percent)) return;
      const e = entry(account);
      const units = spent[account] ?? 0;
      const a = e.anchor;
      if (!a || !sameWindow(a.resetsAt, resetsAt) || percent < a.percent) {
        e.anchor = { percent, resetsAt, units };
        return;
      }
      const step = percent - a.percent;
      if (step < MIN_STEP) return;
      const used = units - a.units;
      if (used > 0) {
        e.samples = [...e.samples, used / step].slice(-SAMPLES);
        onSave(
          Object.fromEntries(Object.entries(book).map(([k, v]) => [k, { samples: v.samples, anchor: null }])),
        );
      }
      e.anchor = { percent, resetsAt, units };
    },
    /** Units per percent of the short window, or null while nothing has been learned. @param {string} account */
    perPercent(account) {
      const s = book[account]?.samples;
      return s?.length ? median(s) : null;
    },
    /** @param {string} account @param {number} units @returns {number | null} */
    percentOf(account, units) {
      const per = this.perPercent(account);
      return per ? units / per : null;
    },
  };
}

/** @typedef {ReturnType<typeof createRateBook>} RateBook */
