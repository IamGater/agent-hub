// @ts-check
import { spawn as nodeSpawn } from 'node:child_process';
import readline from 'node:readline';
import { killTree } from '../../agents/kill.js';

/**
 * @typedef {{
 *   item: (item: import('../transcript.js').ChatItem) => void,
 *   delta: (id: string, text: string) => void,
 *   busy: (busy: boolean) => void,
 *   waiting: (prompt: string | null) => void,
 *   commands: (list: Command[]) => void,
 *   meta: (patch: Meta) => void,
 *   limit: (resetsAt: number | null) => void,
 *   warn: (message: string) => void,
 * }} Hooks
 *
 * `limit`: the answer just ended because the account's plan limit ran out; `resetsAt` (ms) is when
 * it comes back, if the agent said.
 *
 * What the agent reports about itself while it runs: the model in use, how full the context is
 * (tokens), the plan of the account it is signed in with, and the tokens this session has spent so
 * far (`cached`: input read from the prompt cache, counted apart since it costs far less).
 * @typedef {{ input: number, output: number, cached: number }} Tokens
 * `turnTokens`: spent by the answer in progress (or the last one), updated while it runs.
 * `window`: a reading of the account's short limit (percent used), passed on as the agent sees it.
 * @typedef {{
 *   model?: string, context?: { used: number, size: number }, plan?: string, tokens?: Tokens,
 *   turnTokens?: Tokens, window?: { percent: number, resetsAt: number | null },
 * }} Meta
 *
 * Account limits: `percent` used of a window of `windowMins`, resetting at `resetsAt` (ms).
 * @typedef {{ kind: string, windowMins: number | null, percent: number, resetsAt: number | null }} Limit
 * @typedef {{ plan: string | null, limits: Limit[] }} AccountUsage
 *
 * @typedef {{ value: string, label: string, sub?: string }} Choice
 * @typedef {{
 *   name: string, description: string, hint: string,
 *   options?: Choice[], dynamic?: 'sessions',
 * }} Command
 * `options` are values the argument can take (models, for example); `dynamic: 'sessions'` means
 * the client asks the server for the folder's past sessions.
 *
 * @typedef {{
 *   pid: number,
 *   exited: Promise<number | null>,
 *   send: (text: string) => string | null,
 *   answer: (requestId: string, allow: boolean) => boolean,
 *   interrupt: () => void,
 * }} Driver
 *
 * @typedef {{
 *   command: string, args: string[], cwd: string, env: Record<string, string>,
 *   hooks: Hooks, model?: string, spawn?: typeof nodeSpawn, now: () => number,
 *   resume?: string, history?: any[], mcp?: boolean,
 * }} DriverOpts
 * `resume` is the id of a past session to continue; `history` its messages to show (Claude only,
 * the other agents send their history themselves).
 */

// A .cmd shim (npm installs Codex as one) can only be started through cmd.exe. The path comes from
// agents.json and is checked there for characters cmd would interpret; the arguments are constants.
/** @param {string} command @param {string[]} args */
function invocation(command, args) {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    return {
      file: process.env.ComSpec ?? 'cmd.exe',
      argv: ['/d', '/s', '/c', `"${[`"${command}"`, ...args].join(' ')}"`],
      verbatim: true,
    };
  }
  return { file: command, argv: args, verbatim: false };
}

/**
 * Starts the agent with piped stdio and hands every JSON line from stdout to onMessage.
 * @param {DriverOpts} opts
 * @param {(msg: any) => void} onMessage
 */
export function startJsonProcess(opts, onMessage) {
  const { file, argv, verbatim } = invocation(opts.command, opts.args);
  const child = (opts.spawn ?? nodeSpawn)(file, argv, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    windowsVerbatimArguments: verbatim,
  });
  // A dead agent must not crash the server with EPIPE.
  child.stdin?.on('error', () => {});
  // Drained so a chatty agent cannot block on a full pipe; only the tail is kept for diagnostics.
  /** @type {string[]} */
  const stderr = [];
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (d) => {
    stderr.push(String(d));
    if (stderr.length > 20) stderr.shift();
  });
  const lines = readline.createInterface({
    input: /** @type {import('node:stream').Readable} */ (child.stdout),
  });
  lines.on('line', (line) => {
    if (!line.startsWith('{')) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      opts.hooks.warn('agent printed malformed JSON');
      return;
    }
    try {
      onMessage(msg);
    } catch (err) {
      opts.hooks.warn(`agent message not handled: ${/** @type {Error} */ (err).message}`);
    }
  });
  /** @type {Promise<number | null>} */
  const exited = new Promise((resolve) => {
    child.once('exit', (code) => resolve(code));
    child.once('error', (err) => {
      opts.hooks.warn(`agent failed to start: ${err.message}`);
      resolve(null);
    });
  });
  return {
    child,
    exited,
    stderrTail: () => stderr.join('').slice(-2000),
    /** @param {unknown} obj */
    write(obj) {
      if (!child.stdin || child.stdin.destroyed) return false;
      child.stdin.write(`${JSON.stringify(obj)}\n`);
      return true;
    },
  };
}

/**
 * Runs the agent just long enough to ask it something over JSON-RPC (its past sessions), then
 * kills it. Requests from the agent are refused; nothing is sent that would start a turn.
 * @template T
 * @param {{ command: string, args: string[], cwd: string, env: Record<string, string>, spawn?: typeof nodeSpawn }} opts
 * @param {(call: (method: string, params: unknown) => Promise<any>, notify: (method: string) => void) => Promise<T>} fn
 * @param {number} [timeoutMs]
 * @returns {Promise<T>}
 */
export async function rpcOnce(opts, fn, timeoutMs = 20_000) {
  let nextId = 1;
  /** @type {Map<number, (msg: any) => void>} */
  const calls = new Map();
  const hooks = /** @type {Hooks} */ (/** @type {unknown} */ ({ warn: () => {} }));
  const proc = startJsonProcess({ ...opts, hooks }, (msg) => {
    if (msg.method && msg.id !== undefined) {
      proc.write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'not supported' } });
    } else if (typeof msg.id === 'number' && calls.has(msg.id)) {
      /** @type {(m: any) => void} */ (calls.get(msg.id))(msg);
      calls.delete(msg.id);
    }
  });
  /** @param {string} method @param {unknown} params */
  const call = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      calls.set(id, resolve);
      proc.write({ jsonrpc: '2.0', id, method, params });
    });
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  try {
    return await Promise.race([
      fn(call, (method) => proc.write({ jsonrpc: '2.0', method })),
      proc.exited.then(() => {
        throw new Error('agent exited');
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('agent did not answer')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (proc.child.pid) await killTree(proc.child.pid);
  }
}

/** English texts of server-made notices; the client translates them by code. */
export const NOTICES = {
  ready: 'Agent ready.',
  agent_error: 'Agent error: {message}',
  start_failed: 'The agent did not start: {message}',
  session_failed: 'The agent did not open a session: {message}',
  mode_refused: 'The agent did not switch to asking before every action, so the session is not used.',
  not_done: 'Not done: {message}',
  new_thread: 'Started a new conversation.',
  model_set: 'Model for the next messages: {model}.',
  effort_set: 'Reasoning effort: {effort}.',
  compacted: 'Context compacted.',
  review_started: 'Review started.',
  exited: 'The agent exited (code {code}).',
  not_started: 'The agent did not start.',
  relay_on: 'Linked with {agent}: answers go back and forth, at most {hops} more messages.',
  relay_off: 'The link with {agent} ended.',
  relay_failed: 'Could not pass the answer to {agent}: {reason}.',
  limit_wait: 'The usage limit ran out. The agent continues by itself at {at}.',
  limit_continue: 'The limit has reset: continuing.',
  limit_gave_up: 'The limit still has not reset after several tries; continue by hand when it does.',
  limit_cancelled: 'Automatic continue cancelled.',
};

/** What the agent is told when it continues by itself after the limit came back. */
export const CONTINUE_TEXT = 'The usage limit has reset. Continue where you left off.';

/** Plan-limit messages of Claude Code and Codex (not the short "rate limited, retrying" ones). */
export const LIMIT_TEXT =
  /usage limit|limit reached|hit your (?:usage |session |weekly )?limit|out of (?:extra )?usage|usagelimitexceeded/i;

/**
 * @param {keyof typeof NOTICES} code
 * @param {Record<string, string>} vars
 * @param {'info' | 'error'} level
 * @param {number} ts
 * @returns {import('../transcript.js').ChatItem}
 */
export function noticeItem(code, vars, level, ts) {
  const text = NOTICES[code].replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
  return {
    id: `notice:${ts}:${Math.random().toString(36).slice(2, 8)}`,
    kind: 'notice',
    level,
    ts,
    text,
    code,
    vars,
  };
}

/**
 * Splits "/name args" into its parts, or returns null for ordinary text.
 * @param {string} text
 */
export function parseCommand(text) {
  const m = /^\/([A-Za-z0-9][\w:.-]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
  return m ? { name: m[1], args: (m[2] ?? '').trim() } : null;
}

/** @param {unknown} v @param {number} [max] */
export function str(v, max = 20_000) {
  const s = typeof v === 'string' ? v : (JSON.stringify(v, null, 2) ?? '');
  return s.length > max ? `${s.slice(0, max)}\n…` : s;
}
