// @ts-check
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import pty from 'node-pty';
import headless from '@xterm/headless';
import { createRing } from './ring.js';
import { createTranscript } from './transcript.js';
import { claudeUsage, startClaude } from './chat/claude.js';
import { codexUsage, listCodexThreads, startCodex } from './chat/codex.js';
import { listAcpSessions, startAcp } from './chat/acp.js';
import { SESSION_ID, claudeConfigDir, claudeHistory, claudeSessions } from './chat/history.js';
import { CONTINUE_TEXT, noticeItem } from './chat/process.js';
import { createRateBook, resumeUnits, unitsOf } from './rate.js';
import { isImagePath } from '../agents/images.js';
import { buildEnv } from '../agents/env.js';
import { killTree } from '../agents/kill.js';
import { resolveWorkdir } from '../agents/workdir.js';

/**
 * @typedef {'stopped' | 'running' | 'waiting' | 'exited'} Status
 * @typedef {{
 *   id: string, name: string, type: 'terminal' | 'claude' | 'codex' | 'antigravity', cwd: string,
 *   command: string, args: string[], status: Status, pid: number | null, exitCode: number | null,
 *   startedAt: number | null, prompt: string | null, busy: boolean,
 *   link: { peer: string, left: number } | null, autoApprove: boolean,
 *   model: string | null, context: { used: number, size: number } | null, plan: string | null,
 *   tokens: import('./chat/process.js').Tokens | null, busySince: number | null,
 *   lastTurnMs: number | null, turnTokens: import('./chat/process.js').Tokens | null,
 *   turnPercent: number | null, continueAt: number | null,
 * }} AgentInfo
 *
 * `turnTokens`: spent by the answer in progress, or by the last one; `turnPercent` the same as an
 * estimated share of the account's 5-hour limit (null until that rate is learned, see rate.js).
 * `continueAt`: the plan limit stopped the agent, and it is told to continue at this time.
 *
 * `autoApprove`: the owner chose to let this agent act without asking. The agent itself still runs
 * in its asking mode; the server answers each request with "allow once", so every action still
 * shows up in the chat and in the audit log, and turning it off takes effect on the next request.
 *
 * Two linked chat agents pass each finished answer to each other, so they can talk. The counter is
 * shared and counts relayed messages; every action either agent takes still asks the owner.
 * @typedef {{ peer: string, counter: { left: number } }} Link
 */

const DRIVERS = { claude: startClaude, codex: startCodex, antigravity: startAcp };
const MAX_IMAGES = 500;

/** Offered for every chat agent: the server restarts the agent on the chosen past session. */
const RESUME_COMMAND = {
  name: 'resume',
  description: 'Resume an earlier conversation in this folder',
  hint: '<session>',
  dynamic: /** @type {const} */ ('sessions'),
};

const COLS = 100;
const ROWS = 30;

/**
 * @param {{
 *   agents: import('../config/schema.js').Agent[],
 *   config: import('../config/load.js').RuntimeConfig,
 *   spawn?: typeof pty.spawn,
 *   spawnChild?: typeof nodeSpawn,
 *   now?: () => number,
 * }} opts
 */
/**
 * @param {{
 *   agents: import('../config/schema.js').Agent[], config: import('../config/schema.js').Config,
 *   spawn?: typeof pty.spawn, spawnChild?: typeof nodeSpawn, now?: () => number, autoApprove?: string[],
 *   stillAutoApproved?: (id: string) => boolean,
 *   lastFolders?: Record<string, string>, onFolder?: (id: string, cwd: string) => void,
 *   savedModels?: Record<string, string>, onModel?: (id: string, model: string | null) => void,
 *   savedUsage?: Record<string, CachedUsage>, onUsage?: (id: string, usage: CachedUsage) => void,
 *   savedRates?: Record<string, import('./rate.js').AccountRate>,
 *   onRates?: (all: Record<string, import('./rate.js').AccountRate>) => void,
 *   backgroundUsage?: boolean, continueMargin?: number,
 * }} opts
 * @typedef {{ at: number, account: import('./chat/process.js').AccountUsage }} CachedUsage
 * `lastFolders` are the folders agents were last started in (offered again if still allowed);
 * `onFolder` is told about each start so they can be stored.
 * `savedModels` are the models the owner picked with /model, used for every later start until
 * changed (`/model default` goes back to the agent's configured one); `onModel` stores a choice.
 * `savedRates`/`onRates`: what was learned about how many tokens a percent of each account's limit
 * is (rate.js). `backgroundUsage`: look at the account's limits now and then after an answer, so
 * that rate is learned without the owner opening the usage panel. `continueMargin`: how long after
 * the limit resets the agent is told to continue (also the shortest wait).
 * `stillAutoApproved` is asked again before each automatic answer: the kill switch run from the
 * command line clears the setting in the database while this process keeps its own copy.
 */
export function createManager({
  agents,
  config,
  spawn = pty.spawn,
  spawnChild = nodeSpawn,
  now = Date.now,
  autoApprove = [],
  stillAutoApproved = () => true,
  lastFolders = {},
  onFolder = () => {},
  savedModels = {},
  onModel = () => {},
  savedUsage = {},
  onUsage = () => {},
  savedRates = {},
  onRates = () => {},
  backgroundUsage = false,
  continueMargin = 90_000,
}) {
  const rates = createRateBook({ saved: savedRates, onSave: onRates });
  /** How long past the reset time the agent is told to continue, and how often before giving up. */
  const CONTINUE_FALLBACK = 30 * 60_000;
  const CONTINUE_TRIES = 5;
  const BACKGROUND_USAGE = 10 * 60_000;
  /** The last plan limits each agent reported, shown while a fresh look is on its way. */
  const lastUsage = { ...savedUsage };
  const models = { ...savedModels };
  /** Messages typed while the agent answers wait here; more than this is refused. */
  const QUEUE_MAX = 20;
  const events = new EventEmitter();
  const patterns = config.prompt.patterns.map((p) => new RegExp(p, 'i'));

  /**
   * @typedef {{
   *   agent: import('../config/schema.js').Agent, proc: import('node-pty').IPty | null,
   *   ring: ReturnType<typeof createRing>, screen: InstanceType<typeof headless.Terminal> | null,
   *   info: AgentInfo, idle: NodeJS.Timeout | null, exited: Promise<void> | null,
   *   dismissed: Set<string>, chat: import('./chat/process.js').Driver | null,
   *   transcript: ReturnType<typeof createTranscript>,
   *   commands: import('./chat/process.js').Command[],
   *   images: Map<string, string>, link: Link | null,
   *   queue: Queued[], modelAsk: string | null,
   *   account: string, turnUnits: number, limitedTurn: boolean,
   *   wait: NodeJS.Timeout | null, limitTries: number,
   * }} Session
   */
  /** @typedef {import('./chat/process.js').Picture} Picture */
  /** @typedef {{ itemId: string, text: string, from?: string, images?: Picture[] }} Queued */
  /** @type {Map<string, Session>} */
  const sessions = new Map();

  /** @param {import('../config/schema.js').Agent} agent */
  function remembered(agent) {
    const last = lastFolders[agent.id];
    if (typeof last !== 'string') return agent.cwd;
    try {
      return resolveWorkdir(last, config.allowedRoots);
    } catch {
      return agent.cwd;
    }
  }

  /**
   * Agents signed in to the same account share its limits; the config folder tells them apart.
   * @param {import('../config/schema.js').Agent} agent
   */
  function accountOf(agent) {
    const env = buildEnv(config.agentEnv, agent.env);
    const dir = agent.type === 'codex' ? env.CODEX_HOME : env.CLAUDE_CONFIG_DIR;
    return `${agent.type}:${(dir ?? '').toLowerCase()}`;
  }

  /**
   * The 5-hour window of an account's limits, the one the rate is learned on.
   * @param {import('./chat/process.js').AccountUsage | null} account
   */
  function shortWindow(account) {
    return (account?.limits ?? []).find((l) => l.windowMins === 300 || l.kind === 'session') ?? null;
  }

  for (const agent of agents) {
    sessions.set(agent.id, {
      agent,
      proc: null,
      ring: createRing(config.bufferBytes),
      screen: null,
      idle: null,
      exited: null,
      dismissed: new Set(),
      chat: null,
      transcript: createTranscript(config.bufferBytes),
      commands: [],
      images: new Map(),
      link: null,
      queue: [],
      modelAsk: null,
      account: accountOf(agent),
      turnUnits: 0,
      limitedTurn: false,
      wait: null,
      limitTries: 0,
      info: {
        id: agent.id,
        name: agent.name,
        type: agent.type,
        cwd: remembered(agent),
        command: agent.command,
        args: agent.args,
        status: 'stopped',
        pid: null,
        exitCode: null,
        startedAt: null,
        prompt: null,
        busy: false,
        link: null,
        autoApprove: agent.type !== 'terminal' && autoApprove.includes(agent.id),
        model: null,
        context: null,
        plan: null,
        tokens: null,
        busySince: null,
        lastTurnMs: null,
        turnTokens: null,
        turnPercent: null,
        continueAt: null,
      },
    });
  }

  /** @param {string} id */
  function get(id) {
    const s = sessions.get(id);
    if (!s) throw new Error('unknown agent');
    return s;
  }

  /** @param {Session} s @param {Partial<AgentInfo>} patch */
  function update(s, patch) {
    Object.assign(s.info, patch);
    events.emit('status', { ...s.info });
  }

  /**
   * Reads the rendered screen around the cursor. Returns the text to show the owner and the
   * logical lines (wrapped rows joined) that match a confirmation pattern, keyed by buffer row.
   * @param {Session} s
   */
  function scan(s) {
    const buf = /** @type {NonNullable<typeof s.screen>} */ (s.screen).buffer.active;
    const end = buf.baseY + buf.cursorY;
    const rows = [];
    for (let i = Math.max(0, end - 24); i <= Math.min(buf.length - 1, end + 6); i++) {
      const line = buf.getLine(i);
      const text = line?.translateToString(true) ?? '';
      const prev = rows.at(-1);
      if (line?.isWrapped && prev) prev.text += text;
      else rows.push({ row: i, text });
    }
    const hits = rows.filter((r) => patterns.some((re) => re.test(r.text))).map((r) => `${r.row}:${r.text}`);
    return {
      text: rows
        .map((r) => r.text)
        .join('\n')
        .trim(),
      hits,
    };
  }

  /**
   * Plain output never clears "waiting": a resize makes ConPTY redraw the whole screen, which
   * would make the status flicker. Only a re-scan or the owner's own input does.
   * @param {Session} s
   */
  function checkPrompt(s) {
    s.idle = null;
    if (!s.proc || !s.screen) return;
    const { text, hits } = scan(s);
    if (!hits.length) s.dismissed.clear();
    const fresh = hits.filter((h) => !s.dismissed.has(h));
    if (fresh.length) {
      const was = s.info.status;
      if (was !== 'waiting' || s.info.prompt !== text) update(s, { status: 'waiting', prompt: text });
      if (was !== 'waiting') events.emit('waiting', { id: s.agent.id });
    } else if (s.info.status === 'waiting') {
      update(s, { status: 'running', prompt: null });
    }
  }

  /** @param {Session} s @param {number} cols @param {number} rows @param {string} cwd */
  function startTerminal(s, cols, rows, cwd) {
    const id = s.agent.id;
    const proc = spawn(s.agent.command, s.agent.args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: buildEnv(config.agentEnv, s.agent.env),
    });
    s.proc = proc;
    s.dismissed.clear();
    s.ring.clear();
    s.screen?.dispose();
    s.screen = new headless.Terminal({ cols, rows, scrollback: 200, allowProposedApi: true });

    proc.onData((data) => {
      s.ring.push(data);
      s.screen?.write(data);
      events.emit('output', { id, data });
      // Debounce while running; while waiting, keep the pending check so steady output after the
      // prompt was answered elsewhere still clears the status.
      if (s.idle && s.info.status === 'waiting') return;
      if (s.idle) clearTimeout(s.idle);
      s.idle = setTimeout(() => checkPrompt(s), config.prompt.idleMs);
    });

    s.exited = new Promise((resolve) => {
      proc.onExit(({ exitCode }) => {
        if (s.idle) clearTimeout(s.idle);
        s.idle = null;
        s.proc = null;
        update(s, { status: 'exited', pid: null, exitCode, prompt: null });
        events.emit('exit', { id, exitCode });
        resolve();
      });
    });

    update(s, { status: 'running', cwd, pid: proc.pid, exitCode: null, startedAt: now(), prompt: null });
    events.emit('spawn', { id, pid: proc.pid, startedAt: s.info.startedAt });
  }

  /**
   * Images get an opaque id: the client asks for that id, never for a path, so it can only fetch
   * files the agent itself touched. The file is checked again when it is served.
   * @param {Session} s @param {string} file
   */
  function imageRef(s, file) {
    for (const [id, p] of s.images) if (p === file) return { id, name: path.basename(file) };
    if (s.images.size >= MAX_IMAGES) s.images.delete(/** @type {string} */ (s.images.keys().next().value));
    const id = randomBytes(12).toString('hex');
    s.images.set(id, file);
    return { id, name: path.basename(file) };
  }

  /** @param {Session} s @param {import('./transcript.js').ChatItem} item */
  function chatItem(s, item) {
    const { paths, ...rest } = item;
    const images = (paths ?? []).filter((p) => path.isAbsolute(p) && isImagePath(p)).slice(0, 8);
    if (images.length) rest.images = images.map((p) => imageRef(s, p));
    const stored = s.transcript.upsert(rest);
    events.emit('chat', { id: s.agent.id, item: stored });
    // The owner's /model choice is kept for later starts once the agent has taken it.
    if (item.kind === 'notice' && item.code === 'model_set' && s.modelAsk !== null) {
      const choice = s.modelAsk === 'default' ? null : s.modelAsk;
      s.modelAsk = null;
      if (choice === null) delete models[s.agent.id];
      else models[s.agent.id] = choice;
      onModel(s.agent.id, choice);
    }
    if (item.kind === 'approval' && item.status === 'pending' && s.info.autoApprove) {
      if (!stillAutoApproved(s.agent.id)) {
        update(s, { autoApprove: false });
        return;
      }
      // After the driver has finished recording the request, as if the owner had tapped Allow.
      queueMicrotask(() => {
        if (s.chat?.answer(item.id, true)) {
          events.emit('auto-approved', {
            id: s.agent.id,
            title: item.title ?? '',
            detail: item.detail ?? '',
          });
        }
      });
    }
  }

  /** @param {Session} s */
  function syncLink(s) {
    update(s, { link: s.link ? { peer: s.link.peer, left: s.link.counter.left } : null });
  }

  /** @param {Session} s */
  function unlink(s) {
    const link = s.link;
    if (!link) return;
    const peer = sessions.get(link.peer);
    s.link = null;
    syncLink(s);
    chatItem(s, noticeItem('relay_off', { agent: peer?.agent.name ?? link.peer }, 'info', now()));
    if (peer?.link) {
      peer.link = null;
      syncLink(peer);
      chatItem(peer, noticeItem('relay_off', { agent: s.agent.name }, 'info', now()));
    }
  }

  /** What the agent said since the last message it received. @param {Session} s */
  function lastAnswer(s) {
    const list = s.transcript.list();
    const from = list.findLastIndex((i) => i.kind === 'user');
    return list
      .slice(from + 1)
      .filter((i) => i.kind === 'assistant' && i.text)
      .map((i) => i.text)
      .join('\n\n')
      .trim();
  }

  /** Called when a linked agent finishes a turn. @param {Session} s */
  function relay(s) {
    const link = /** @type {Link} */ (s.link);
    const peer = sessions.get(link.peer);
    const text = lastAnswer(s);
    if (!peer || !text) return;
    if (link.counter.left <= 0) return unlink(s);
    link.counter.left--;
    const message = `Message from the agent "${s.agent.name}" (your answer will be passed back to it):\n\n${text}`;
    const refused = say(peer.agent.id, message.slice(0, 6000), s.agent.name);
    if (refused) {
      chatItem(s, noticeItem('relay_failed', { agent: peer.agent.name, reason: refused }, 'error', now()));
      return unlink(s);
    }
    syncLink(s);
    syncLink(peer);
  }

  /**
   * @param {string} id @param {string} text @param {string} [from] name of the agent it came from
   * @param {Picture[]} [images] pictures the owner pasted
   * @returns {string | null} an error code, or null when the message was taken
   */
  function say(id, text, from, images = []) {
    const s = get(id);
    if (!s.chat) return 'not_running';
    const itemId = `user:${now()}:${Math.random().toString(36).slice(2, 8)}`;
    // While the agent answers, the message waits and goes in as soon as the answer is done.
    if (s.info.busy || s.queue.length) {
      if (s.queue.length >= QUEUE_MAX) return 'queue_full';
      s.queue.push({ itemId, text, ...(from ? { from } : {}), ...(images.length ? { images } : {}) });
      chatItem(s, {
        id: itemId,
        kind: 'user',
        ts: now(),
        text,
        status: 'pending',
        ...(from ? { from } : {}),
        ...(images.length ? { paths: images.map((i) => i.file) } : {}),
      });
      return null;
    }
    return deliver(s, itemId, text, from, images);
  }

  /**
   * Hands a message to the agent and records it in the chat under `itemId`.
   * @param {Session} s @param {string} itemId @param {string} text @param {string} [from]
   * @param {Picture[]} [images]
   * @returns {string | null} an error code, or null when the agent took it
   */
  function deliver(s, itemId, text, from, images = []) {
    if (!s.chat) return 'not_running';
    const resume = from || images.length ? null : /^\/resume(?:\s+(\S*))?\s*$/.exec(text.trim());
    if (resume) {
      if (!resume[1] || !SESSION_ID.test(resume[1])) return 'bad_command';
      void restartOn(s, resume[1]);
      return null;
    }
    const model = from || images.length ? null : /^\/model\s+(\S+)\s*$/.exec(text.trim());
    const refused = s.chat.send(text, images);
    if (refused) return refused;
    if (model) s.modelAsk = model[1];
    chatItem(s, {
      id: itemId,
      kind: 'user',
      ts: now(),
      text,
      status: undefined,
      ...(from ? { from } : {}),
      ...(images.length ? { paths: images.map((i) => i.file) } : {}),
    });
    return null;
  }

  /** Sends the next waiting message once the agent is free. @param {Session} s */
  function flush(s) {
    while (s.queue.length && s.chat && !s.info.busy) {
      const next = /** @type {Queued} */ (s.queue.shift());
      const refused = deliver(s, next.itemId, next.text, next.from, next.images);
      if (refused) {
        chatItem(s, { id: next.itemId, kind: 'user', ts: now(), status: 'cancelled' });
        chatItem(s, noticeItem('not_done', { message: refused }, 'error', now()));
      }
    }
  }

  /** Drops waiting messages, all of them or one. @param {Session} s @param {string} [itemId] */
  function dropQueued(s, itemId) {
    const dropped = itemId ? s.queue.filter((q) => q.itemId === itemId) : s.queue;
    s.queue = itemId ? s.queue.filter((q) => q.itemId !== itemId) : [];
    for (const q of dropped) chatItem(s, { id: q.itemId, kind: 'user', ts: now(), status: 'cancelled' });
    return dropped.length > 0;
  }

  /** @param {Session} s @param {string} session */
  async function restartOn(s, session) {
    const id = s.agent.id;
    await stop(id);
    try {
      start(id, { cwd: s.info.cwd, resume: session });
    } catch (err) {
      events.emit('warn', { id, message: `resume failed: ${/** @type {Error} */ (err).message}` });
    }
  }

  /** @param {Session} s */
  function clearWait(s) {
    s.limitTries = 0;
    if (!s.wait) return false;
    clearTimeout(s.wait);
    s.wait = null;
    update(s, { continueAt: null });
    return true;
  }

  /**
   * The plan limit ended the answer: wait until it comes back, then tell the agent to go on.
   * Without a reset time from the agent the account's limits are asked; failing that, it tries
   * again in half an hour. After a few continues that run into the limit again it stops.
   * @param {Session} s @param {number | null} resetsAt
   */
  async function limitHit(s, resetsAt) {
    s.limitedTurn = true;
    const chat = s.chat;
    let at = resetsAt;
    if (!at) {
      try {
        const account = await usageOf(s.agent.id, true);
        const full = (account?.limits ?? []).filter((l) => l.percent >= 99 && l.resetsAt);
        at = full.length ? Math.max(...full.map((l) => /** @type {number} */ (l.resetsAt))) : null;
      } catch {
        at = null;
      }
    }
    if (!chat || s.chat !== chat) return;
    if (s.wait) clearTimeout(s.wait);
    s.wait = null;
    if (s.limitTries >= CONTINUE_TRIES) {
      s.limitTries = 0;
      update(s, { continueAt: null });
      chatItem(s, noticeItem('limit_gave_up', {}, 'error', now()));
      if (s.queue.length && !s.info.busy) flush(s);
      return;
    }
    const when = Math.max(at ? at + continueMargin : now() + CONTINUE_FALLBACK, now() + continueMargin);
    // After the computer slept the timer is late, and fires as soon as it wakes.
    s.wait = setTimeout(() => continueAfterLimit(s, chat), Math.min(when - now(), 2 ** 31 - 1));
    update(s, { continueAt: when });
    chatItem(s, noticeItem('limit_wait', { at: new Date(when).toISOString() }, 'info', now()));
  }

  /** @param {Session} s @param {import('./chat/process.js').Driver} chat the run that hit the limit */
  function continueAfterLimit(s, chat) {
    s.wait = null;
    update(s, { continueAt: null });
    // Stopped since, or the owner already took over: nothing to continue.
    if (s.chat !== chat || s.info.busy) return;
    s.limitTries++;
    chatItem(s, noticeItem('limit_continue', {}, 'info', now()));
    // The owner's waiting messages say better what to do next than a plain "continue".
    if (s.queue.length) return flush(s);
    const itemId = `user:${now()}:${Math.random().toString(36).slice(2, 8)}`;
    const refused = deliver(s, itemId, CONTINUE_TEXT);
    if (refused) chatItem(s, noticeItem('not_done', { message: refused }, 'error', now()));
  }

  /** @param {Session} s @param {import('./chat/process.js').Tokens} t */
  function turnPatch(s, t) {
    const units = unitsOf(t);
    rates.spend(s.account, units - s.turnUnits);
    s.turnUnits = units;
    const pct = rates.percentOf(s.account, units);
    return { turnTokens: t, turnPercent: pct === null ? null : Math.round(pct * 10) / 10 };
  }

  /** @param {Session} s @param {string} cwd @param {string} [resume] */
  function startChat(s, cwd, resume) {
    const id = s.agent.id;
    s.transcript.clear();
    s.images.clear();
    events.emit('chat-reset', { id });
    /** @type {import('./chat/process.js').Hooks} */
    const hooks = {
      item: (item) => chatItem(s, item),
      delta(itemId, text) {
        if (s.transcript.appendText(itemId, text)) events.emit('chat-delta', { id, itemId, text });
      },
      busy(busy) {
        if (s.info.busy === busy) return;
        // How long the answer takes: a running clock while busy, the last duration after.
        const since = s.info.busySince;
        if (busy) {
          s.limitedTurn = false;
          s.turnUnits = 0;
        }
        update(s, {
          busy,
          busySince: busy ? now() : null,
          ...(busy ? { turnTokens: { input: 0, output: 0, cached: 0 }, turnPercent: null } : {}),
          ...(!busy && since ? { lastTurnMs: now() - since } : {}),
        });
        if (!busy && s.link) relay(s);
        // After the driver has finished handling the end of the answer: by then it has said
        // whether the limit stopped it. An answer that ended normally starts the count of tries over.
        if (!busy) {
          queueMicrotask(() => {
            if (!s.limitedTurn) {
              s.limitTries = 0;
              refreshInBackground(s);
            }
            // Messages waiting behind an answer the limit stopped go in when it is back.
            if (s.queue.length && !s.limitedTurn) flush(s);
          });
        }
      },
      waiting(prompt) {
        const was = s.info.status;
        if (was !== 'running' && was !== 'waiting') return;
        if (prompt) {
          if (was !== 'waiting' || s.info.prompt !== prompt) update(s, { status: 'waiting', prompt });
          if (was !== 'waiting') events.emit('waiting', { id });
        } else if (was === 'waiting') {
          update(s, { status: 'running', prompt: null });
        }
      },
      meta(patch) {
        const { window, turnTokens, ...rest } = patch;
        if (window) rates.reading(s.account, window.percent, window.resetsAt);
        if (turnTokens) update(s, { ...rest, ...turnPatch(s, turnTokens) });
        else if (Object.keys(rest).length) update(s, rest);
      },
      limit(resetsAt) {
        void limitHit(s, resetsAt);
      },
      commands(list) {
        s.commands = [...list.filter((c) => c.name !== 'resume'), RESUME_COMMAND];
        events.emit('chat-commands', { id, commands: s.commands });
      },
      warn: (message) => events.emit('warn', { id, message }),
    };
    const env = buildEnv(config.agentEnv, s.agent.env);
    const opts = {
      command: s.agent.command,
      args: [],
      cwd,
      env,
      hooks,
      model: models[id] ?? s.agent.model,
      mcp: s.agent.mcp,
      spawn: spawnChild,
      now,
      resume,
      history:
        resume && s.agent.type === 'claude' ? claudeHistory(claudeConfigDir(env), cwd, resume) : undefined,
    };
    const chat = DRIVERS[/** @type {keyof typeof DRIVERS} */ (s.agent.type)](opts);
    s.chat = chat;
    s.turnUnits = 0;
    s.limitedTurn = false;
    update(s, {
      turnTokens: null,
      turnPercent: null,
      continueAt: null,
      status: 'running',
      model: models[id] ?? s.agent.model ?? null,
      context: null,
      tokens: null,
      busySince: null,
      lastTurnMs: null,
      cwd,
      pid: chat.pid,
      exitCode: null,
      startedAt: now(),
      prompt: null,
      busy: false,
    });
    s.exited = chat.exited.then((exitCode) => {
      s.chat = null;
      s.modelAsk = null;
      if (s.wait) clearTimeout(s.wait);
      s.wait = null;
      s.limitTries = 0;
      unlink(s);
      dropQueued(s);
      chatItem(
        s,
        exitCode === null
          ? noticeItem('not_started', {}, 'error', now())
          : noticeItem('exited', { code: String(exitCode) }, exitCode === 0 ? 'info' : 'error', now()),
      );
      update(s, {
        status: 'exited',
        pid: null,
        exitCode,
        prompt: null,
        busy: false,
        busySince: null,
        continueAt: null,
      });
      events.emit('exit', { id, exitCode });
    });
    events.emit('spawn', { id, pid: chat.pid, startedAt: s.info.startedAt });
  }

  /**
   * Starts the agent in the given folder, or in the one it last ran in.
   * @param {string} id
   * @param {{ cols?: number, rows?: number, cwd?: string, resume?: string }} [opts]
   */
  function start(id, opts = {}) {
    const s = get(id);
    if (s.proc || s.chat) throw new Error('already running');
    // Checked at spawn time even for the configured folder: it may have been swapped for a junction.
    const cwd = resolveWorkdir(opts.cwd ?? s.info.cwd, config.allowedRoots);
    if (s.agent.type === 'terminal') startTerminal(s, opts.cols ?? COLS, opts.rows ?? ROWS, cwd);
    else startChat(s, cwd, opts.resume && SESSION_ID.test(opts.resume) ? opts.resume : undefined);
    onFolder(id, cwd);
  }

  /** @type {Map<string, { at: number, value: Promise<import('./chat/process.js').AccountUsage | null> }>} */
  const usageCache = new Map();
  const USAGE_TTL = 60_000;
  const USAGE_MIN = 10_000;

  /**
   * Plan limits of the account a chat agent uses. Asking starts the agent's program for a moment,
   * so answers are reused for a minute, or ten seconds when the owner asks to refresh.
   * Antigravity has no such request: null.
   * @param {string} id @param {boolean} [fresh]
   */
  function usageOf(id, fresh = false) {
    const s = get(id);
    const hit = usageCache.get(id);
    if (hit && now() - hit.at < (fresh ? USAGE_MIN : USAGE_TTL)) return hit.value;
    const env = buildEnv(config.agentEnv, s.agent.env);
    const opts = { command: s.agent.command, args: [], cwd: s.info.cwd, env, spawn: spawnChild };
    /** @type {Promise<import('./chat/process.js').AccountUsage | null>} */
    let value = Promise.resolve(null);
    if (s.agent.type === 'claude') value = claudeUsage(opts);
    else if (s.agent.type === 'codex') value = codexUsage(opts);
    // A failure is not cached, so the next look tries again.
    value.then(
      (account) => {
        if (!account) return;
        const w = shortWindow(account);
        if (w) rates.reading(s.account, w.percent, w.resetsAt);
        lastUsage[id] = { at: now(), account };
        onUsage(id, lastUsage[id]);
      },
      () => usageCache.delete(id),
    );
    usageCache.set(id, { at: now(), value });
    return value;
  }

  /**
   * Looks at the account's limits after an answer when the last look is old, so the rate of tokens
   * per percent is learned while the agents work. Off unless asked for (tests start nothing extra).
   * @param {Session} s
   */
  function refreshInBackground(s) {
    if (!backgroundUsage || (s.agent.type !== 'claude' && s.agent.type !== 'codex')) return;
    if (now() - (lastUsage[s.agent.id]?.at ?? 0) < BACKGROUND_USAGE) return;
    usageOf(s.agent.id).catch(() => {});
  }

  /**
   * Past sessions of a chat agent in a folder, newest first.
   * @param {string} id @param {string} dir
   * @returns {Promise<import('./chat/history.js').SessionInfo[]>}
   */
  async function sessionsOf(id, dir) {
    const s = get(id);
    const cwd = resolveWorkdir(dir, config.allowedRoots);
    const env = buildEnv(config.agentEnv, s.agent.env);
    const opts = { command: s.agent.command, args: [], cwd, env, spawn: spawnChild };
    if (s.agent.type === 'claude') {
      // What resuming costs: the whole conversation goes out again with the next message, written
      // to the prompt cache anew unless it was used minutes ago and the cache is still warm.
      return claudeSessions(claudeConfigDir(env), cwd).map((x) => {
        if (!x.tokens) return x;
        const warm = now() - x.updatedAt < 5 * 60_000;
        const pct = rates.percentOf(s.account, resumeUnits(x.tokens, warm));
        return { ...x, warm, percent: pct === null ? null : Math.round(pct * 10) / 10 };
      });
    }
    if (s.agent.type === 'codex') return listCodexThreads(opts);
    if (s.agent.type === 'antigravity') return listAcpSessions(opts);
    return [];
  }

  /** @param {number} ms */
  const wait = (ms) => new Promise((r) => setTimeout(() => r(false), ms));

  /** @param {string} id */
  async function stop(id) {
    const s = get(id);
    if (s.chat) {
      const { chat, exited } = s;
      await killTree(chat.pid);
      await Promise.race([exited, wait(5000)]);
      return;
    }
    if (!s.proc) return;
    const { proc, exited } = s;
    await killTree(proc.pid);
    // Only fall back to pty.kill() if the tree kill did not end it: killing an already dead
    // ConPTY makes node-pty's helper process crash noisily.
    if (!(await Promise.race([exited?.then(() => true), wait(2000)]))) {
      proc.kill();
      await Promise.race([exited, wait(3000)]);
    }
  }

  return {
    events,
    list: () => [...sessions.values()].map((s) => ({ ...s.info })),
    has: (/** @type {string} */ id) => sessions.has(id),
    /** @param {string} id */
    info: (id) => ({ ...get(id).info }),
    start,
    stop,
    /** @param {string} id */
    async restart(id) {
      await stop(id);
      start(id);
    },
    async stopAll() {
      await Promise.all([...sessions.keys()].map(stop));
    },
    /** @param {string} id @param {string} data */
    write(id, data) {
      const s = get(id);
      if (!s.proc) throw new Error('not running');
      s.proc.write(data);
      // The owner answered: remember this prompt so it does not trigger again while it is still
      // visible. Focus reports from xterm are not answers.
      const focusReport = data === '\x1b[I' || data === '\x1b[O';
      if (s.info.status === 'waiting' && s.screen && !focusReport) {
        for (const h of scan(s).hits) s.dismissed.add(h);
        update(s, { status: 'running', prompt: null });
      }
    },
    /** @param {string} id @param {number} cols @param {number} rows */
    resize(id, cols, rows) {
      const s = get(id);
      if (!s.proc) return;
      s.proc.resize(cols, rows);
      s.screen?.resize(cols, rows);
    },
    /** @param {string} id */
    snapshot: (id) => get(id).ring.read(),
    /** @param {string} id */
    transcript: (id) => get(id).transcript.list(),
    /** @param {string} id */
    commands: (id) => get(id).commands,
    /**
     * Sends a chat message or command from the owner, with any pictures they pasted.
     * @param {string} id @param {string} text @param {Picture[]} [images]
     */
    say: (id, text, images) => say(id, text, undefined, images),
    /**
     * Links two running chat agents so their answers go to each other, at most `hops` messages.
     * @param {string} id @param {string} peerId @param {number} hops
     * @returns {string | null} an error code, or null when linked
     */
    link(id, peerId, hops) {
      const a = get(id);
      const b = sessions.get(peerId);
      if (!b || a === b) return 'bad_link';
      if (!a.chat || !b.chat) return 'not_running';
      if (a.link || b.link) return 'already_linked';
      const counter = { left: hops };
      a.link = { peer: b.agent.id, counter };
      b.link = { peer: a.agent.id, counter };
      syncLink(a);
      syncLink(b);
      const vars = { hops: String(hops) };
      chatItem(a, noticeItem('relay_on', { ...vars, agent: b.agent.name }, 'info', now()));
      chatItem(b, noticeItem('relay_on', { ...vars, agent: a.agent.name }, 'info', now()));
      return null;
    },
    /** @param {string} id */
    unlink: (id) => unlink(get(id)),
    sessions: sessionsOf,
    usage: usageOf,
    /** The last limits seen, without starting anything. @param {string} id @returns {CachedUsage | null} */
    cachedUsage: (id) => (get(id), lastUsage[id] ?? null),
    /** @param {string} id @param {boolean} on */
    setAutoApprove(id, on) {
      const s = get(id);
      if (s.agent.type === 'terminal') throw new Error('terminal agents have no approvals');
      update(s, { autoApprove: on });
    },
    /** @returns {string[]} */
    autoApproved: () => [...sessions.values()].filter((s) => s.info.autoApprove).map((s) => s.agent.id),
    /** @param {string} id @param {string} imageId @returns {{ file: string, ran: boolean } | null} */
    image(id, imageId) {
      const s = get(id);
      const file = s.images.get(imageId);
      if (!file) return null;
      // A tool call that finished means the agent already read the file, with the owner's approval
      // when it was outside the agent's folder; showing it then reveals nothing new.
      const ran = s.transcript.list().some(
        (i) =>
          // The owner's own pictures, or files a finished tool call read.
          (i.kind === 'user' || (i.kind === 'tool' && i.status === 'ok')) &&
          i.images?.some((img) => img.id === imageId),
      );
      return { file, ran };
    },
    /** @param {string} id @param {string} requestId @param {boolean} allow */
    answer(id, requestId, allow) {
      const s = get(id);
      return s.chat ? s.chat.answer(requestId, allow) : false;
    },
    /** Removes one waiting message. @param {string} id @param {string} itemId */
    unqueue: (id, itemId) => dropQueued(get(id), itemId),
    /** The owner does not want the agent to continue by itself after the limit. @param {string} id */
    cancelContinue(id) {
      const s = get(id);
      if (clearWait(s)) chatItem(s, noticeItem('limit_cancelled', {}, 'info', now()));
      // Messages held for the continue go in now: the owner takes over.
      if (s.queue.length && !s.info.busy) flush(s);
    },
    /** @param {string} id */
    interrupt(id) {
      const s = get(id);
      // Stopping one side of a conversation stops the conversation.
      unlink(s);
      if (clearWait(s)) chatItem(s, noticeItem('limit_cancelled', {}, 'info', now()));
      s.chat?.interrupt();
    },
  };
}

/** @typedef {ReturnType<typeof createManager>} Manager */
