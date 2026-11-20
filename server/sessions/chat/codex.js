// @ts-check
import { LIMIT_TEXT, noticeItem, parseCommand, rpcOnce, startJsonProcess, str } from './process.js';

/** The app-server has no slash commands of its own; these map onto its requests. */
export const CODEX_COMMANDS = [
  { name: 'compact', description: 'Compact the conversation to free up context', hint: '' },
  {
    name: 'review',
    description: 'Review uncommitted changes, or follow your instructions',
    hint: '[instructions]',
  },
  { name: 'new', description: 'Start a new conversation in the same folder', hint: '' },
  { name: 'model', description: 'Switch the model for the next messages', hint: '<model>' },
  { name: 'effort', description: 'Reasoning effort for the next messages', hint: '<low|medium|high|xhigh>' },
];
/**
 * Past Codex threads in a folder, asked from a short-lived app-server.
 * @param {Omit<import('./process.js').DriverOpts, 'hooks' | 'now'>} opts
 * @returns {Promise<import('./history.js').SessionInfo[]>}
 */
export function listCodexThreads(opts) {
  return rpcOnce({ ...opts, args: ['app-server'] }, async (call, notify) => {
    const init = await call('initialize', {
      clientInfo: { name: 'agent-hub', title: 'Agent Hub', version: '0.1.0' },
      capabilities: null,
    });
    if (init.error) throw new Error(String(init.error.message));
    notify('initialized');
    const list = await call('thread/list', { cwd: opts.cwd, limit: 30 });
    if (list.error) throw new Error(String(list.error.message));
    return (Array.isArray(list.result?.data) ? list.result.data : []).map((/** @type {any} */ t) => ({
      id: String(t.id),
      title: String(t.name || t.preview || t.id).slice(0, 120),
      updatedAt: Number(t.updatedAt) * 1000,
    }));
  });
}

/**
 * Plan limits of the ChatGPT account Codex is signed in with, from a short-lived app-server.
 * @param {Omit<import('./process.js').DriverOpts, 'hooks' | 'now'>} opts
 * @returns {Promise<import('./process.js').AccountUsage>}
 */
export function codexUsage(opts) {
  return rpcOnce({ ...opts, args: ['app-server'] }, async (call, notify) => {
    const init = await call('initialize', {
      clientInfo: { name: 'agent-hub', title: 'Agent Hub', version: '0.1.0' },
      capabilities: null,
    });
    if (init.error) throw new Error(String(init.error.message));
    notify('initialized');
    const r = await call('account/rateLimits/read', {});
    if (r.error) throw new Error(String(r.error.message));
    const l = r.result?.rateLimits ?? {};
    const limits = ['primary', 'secondary'].flatMap((key) => {
      const w = l[key];
      if (!w || typeof w.usedPercent !== 'number') return [];
      return [
        {
          kind: key === 'primary' ? 'session' : 'weekly_all',
          windowMins: typeof w.windowDurationMins === 'number' ? w.windowDurationMins : null,
          percent: w.usedPercent,
          resetsAt: typeof w.resetsAt === 'number' ? w.resetsAt * 1000 : null,
        },
      ];
    });
    return { plan: typeof l.planType === 'string' ? l.planType : null, limits };
  });
}

const SAFE_THREAD = { approvalPolicy: 'untrusted', approvalsReviewer: 'user', sandbox: 'workspace-write' };
const MODEL = /^[A-Za-z0-9._:-]{1,64}$/;
const EFFORT = /^[a-z]{2,12}$/;

const ITEM_STATUS = /** @type {Record<string, 'running' | 'ok' | 'error' | 'declined'>} */ ({
  inProgress: 'running',
  completed: 'ok',
  failed: 'error',
  declined: 'declined',
});

/** @param {any} changes */
function describeChanges(changes) {
  if (!Array.isArray(changes)) return '';
  return changes.map((c) => `${c?.kind?.type ?? 'change'} ${c?.path ?? ''}\n${c?.diff ?? ''}`).join('\n\n');
}

/**
 * Codex through its app-server JSON-RPC protocol. The thread is started with approval policy
 * "untrusted" and reviewer "user": anything beyond known-safe reads comes to us as a server request
 * and waits for the owner. These are set per thread, so they override config.toml.
 * @param {import('./process.js').DriverOpts} opts
 * @returns {import('./process.js').Driver}
 */
export function startCodex(opts) {
  const { hooks, now } = opts;
  let nextId = 1;
  /** @type {Map<number, (msg: any) => void>} */
  const calls = new Map();
  /** @type {Map<string, { rpcId: unknown, kind: 'command' | 'file', prompt: string }>} */
  const pending = new Map();
  /** @type {Map<string, any>} file changes by item id, to show the diff on the approval card */
  const changes = new Map();
  /** @type {string | null} */
  let threadId = null;
  /** @type {string | null} */
  let turnId = null;
  /** Picked with /model and /effort and sent with every following turn. */
  /** @type {{ model?: string, effort?: string }} */
  const overrides = {};
  /** Session totals now and when the answer in progress began; the difference is the answer's. */
  let total = { input: 0, output: 0, cached: 0 };
  let turnStart = total;
  /** The plan limit stopped the answer in progress. */
  let limited = false;

  /** @param {any} error */
  const isLimit = (error) => LIMIT_TEXT.test(str(error ?? '', 4000));

  /** @param {string} method @param {unknown} params */
  function call(method, params) {
    const id = nextId++;
    return new Promise((resolve) => {
      calls.set(id, resolve);
      proc.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  function waitingText() {
    const first = pending.values().next().value;
    return first ? first.prompt : null;
  }

  /**
   * @param {keyof typeof import('./process.js').NOTICES} code
   * @param {Record<string, string>} [vars]
   */
  function notice(code, vars = {}, level = /** @type {'info' | 'error'} */ ('error')) {
    hooks.item(noticeItem(code, vars, level, now()));
  }

  /** @param {any} item @param {boolean} [replay] true for items of a resumed history */
  function onItem(item, replay = false) {
    if (!item?.id) return;
    const id = String(item.id);
    const ts = now();
    switch (item.type) {
      case 'agentMessage':
        hooks.item({ id, kind: 'assistant', ts, text: String(item.text ?? '') });
        return;
      case 'commandExecution':
        hooks.item({
          id,
          kind: 'tool',
          ts,
          title: `Shell: ${String(item.command ?? '')
            .split('\n')[0]
            .slice(0, 200)}`,
          detail: `${item.command ?? ''}\n# ${item.cwd ?? ''}`,
          output: item.aggregatedOutput ?? undefined,
          status: ITEM_STATUS[item.status] ?? 'running',
        });
        return;
      case 'fileChange': {
        changes.set(id, item.changes);
        const paths = Array.isArray(item.changes) ? item.changes.map((c) => c?.path).join(', ') : '';
        hooks.item({
          id,
          kind: 'tool',
          ts,
          title: `Edit: ${paths.slice(0, 200)}`,
          detail: describeChanges(item.changes),
          status: ITEM_STATUS[item.status] ?? 'running',
          paths: Array.isArray(item.changes) ? item.changes.map((c) => String(c?.path ?? '')) : [],
        });
        return;
      }
      case 'mcpToolCall':
        hooks.item({
          id,
          kind: 'tool',
          ts,
          title: `${item.server}.${item.tool}`,
          detail: str(item.arguments),
          output: item.result ? str(item.result) : item.error ? str(item.error) : undefined,
          status: ITEM_STATUS[item.status] ?? 'running',
        });
        return;
      case 'enteredReviewMode':
        hooks.item({ ...noticeItem('review_started', {}, 'info', ts), id });
        return;
      case 'exitedReviewMode':
        hooks.item({ id, kind: 'assistant', ts, text: String(item.review ?? '') });
        return;
      case 'contextCompaction':
        hooks.item({ ...noticeItem('compacted', {}, 'info', ts), id });
        return;
      case 'webSearch':
        hooks.item({ id, kind: 'tool', ts, title: `Search: ${item.query ?? ''}`, status: 'ok' });
        return;
      case 'imageView':
        hooks.item({
          id,
          kind: 'tool',
          ts,
          title: `View image: ${item.path ?? ''}`,
          status: 'ok',
          paths: [String(item.path ?? '')],
        });
        return;
      case 'imageGeneration':
        hooks.item({
          id,
          kind: 'tool',
          ts,
          title: `Generate image${item.revisedPrompt ? `: ${String(item.revisedPrompt).slice(0, 200)}` : ''}`,
          status: item.failure ? 'error' : item.savedPath ? 'ok' : 'running',
          paths: item.savedPath ? [String(item.savedPath)] : [],
        });
        return;
      case 'userMessage':
        // Live turns already show the owner's message; only a resumed history needs it from here.
        if (replay) {
          const text = (Array.isArray(item.content) ? item.content : [])
            .filter((/** @type {any} */ c) => c?.type === 'text')
            .map((/** @type {any} */ c) => String(c.text ?? ''))
            .join('\n');
          if (text) hooks.item({ id, kind: 'user', ts, text });
        }
        return;
      case 'reasoning':
      case 'plan':
        return;
      default:
        hooks.item({ id, kind: 'tool', ts, title: String(item.type), status: 'ok' });
    }
  }

  /** @param {any} msg */
  function onNotification(msg) {
    const p = msg.params ?? {};
    switch (msg.method) {
      case 'thread/tokenUsage/updated': {
        const u = p.tokenUsage;
        if (typeof u?.last?.totalTokens === 'number' && typeof u.modelContextWindow === 'number')
          hooks.meta({ context: { used: u.last.totalTokens, size: u.modelContextWindow } });
        const t = u?.total;
        if (typeof t?.inputTokens === 'number' && typeof t.outputTokens === 'number') {
          const cached = typeof t.cachedInputTokens === 'number' ? t.cachedInputTokens : 0;
          total = { input: Math.max(0, t.inputTokens - cached), cached, output: t.outputTokens };
          hooks.meta({
            tokens: total,
            turnTokens: {
              input: Math.max(0, total.input - turnStart.input),
              cached: Math.max(0, total.cached - turnStart.cached),
              output: Math.max(0, total.output - turnStart.output),
            },
          });
        }
        return;
      }
      case 'account/rateLimits/updated': {
        const w = p.rateLimits?.primary;
        if (typeof w?.usedPercent === 'number') {
          hooks.meta({
            window: {
              percent: w.usedPercent,
              resetsAt: typeof w.resetsAt === 'number' ? w.resetsAt * 1000 : null,
            },
          });
        }
        return;
      }
      case 'turn/started':
        turnId = p.turn?.id ?? turnId;
        hooks.busy(true);
        return;
      case 'turn/completed': {
        turnId = null;
        const stop = limited || (p.turn?.status === 'failed' && isLimit(p.turn.error));
        limited = false;
        hooks.busy(false);
        if (p.turn?.status === 'failed' && p.turn.error)
          notice('agent_error', { message: str(p.turn.error.message ?? p.turn.error, 2000) });
        if (stop) hooks.limit(null);
        return;
      }
      case 'item/started':
      case 'item/completed':
        onItem(p.item);
        return;
      case 'item/agentMessage/delta':
        if (p.itemId && typeof p.delta === 'string') hooks.delta(String(p.itemId), p.delta);
        return;
      case 'error':
        if (!p.willRetry && isLimit(p.error)) limited = true;
        if (!p.willRetry) notice('agent_error', { message: str(p.error?.message ?? p.error, 2000) });
        return;
      case 'serverRequest/resolved':
        for (const [key, v] of pending) {
          if (v.rpcId === p.requestId) {
            pending.delete(key);
            hooks.item({ id: key, kind: 'approval', ts: now(), status: 'cancelled' });
            hooks.waiting(waitingText());
          }
        }
        return;
    }
  }

  /** @param {any} msg */
  function onServerRequest(msg) {
    const p = msg.params ?? {};
    const key = `approval:${String(msg.id)}`;
    if (msg.method === 'item/commandExecution/requestApproval') {
      const detail = [
        p.command ?? '(no command given)',
        p.cwd ? `# ${p.cwd}` : '',
        p.reason ? `\n${p.reason}` : '',
      ]
        .filter(Boolean)
        .join('\n');
      pending.set(key, { rpcId: msg.id, kind: 'command', prompt: `Shell: ${detail.slice(0, 2000)}` });
      hooks.item({
        id: key,
        kind: 'approval',
        ts: now(),
        title: 'Run a command',
        code: 'approve_command',
        detail,
        status: 'pending',
      });
      hooks.waiting(waitingText());
      return;
    }
    if (msg.method === 'item/fileChange/requestApproval') {
      const detail = [
        describeChanges(changes.get(String(p.itemId))),
        p.reason ?? '',
        p.grantRoot ? `Write access to ${p.grantRoot}` : '',
      ]
        .filter(Boolean)
        .join('\n\n');
      pending.set(key, { rpcId: msg.id, kind: 'file', prompt: `Edit: ${detail.slice(0, 2000)}` });
      hooks.item({
        id: key,
        kind: 'approval',
        ts: now(),
        title: 'Change files',
        code: 'approve_files',
        detail,
        status: 'pending',
      });
      hooks.waiting(waitingText());
      return;
    }
    // Anything else (extra permissions, questions, auth refresh) is refused rather than guessed at.
    proc.write({
      jsonrpc: '2.0',
      id: msg.id,
      error: { code: -32601, message: 'not supported by this client' },
    });
  }

  /** @param {any} msg */
  function onMessage(msg) {
    if (msg.method && msg.id !== undefined) return onServerRequest(msg);
    if (msg.method) return onNotification(msg);
    if (typeof msg.id === 'number' && calls.has(msg.id)) {
      const resolve = /** @type {(m: any) => void} */ (calls.get(msg.id));
      calls.delete(msg.id);
      resolve(msg);
    }
  }

  const proc = startJsonProcess({ ...opts, args: ['app-server'] }, onMessage);

  /**
   * Starts a thread, or resumes a past one with the same approval settings as a new one: they are
   * per-thread parameters, so the resumed thread asks the owner exactly like a fresh thread does.
   * @param {string} [resume]
   */
  async function openThread(resume) {
    const params = { cwd: opts.cwd, ...SAFE_THREAD, ...(opts.model ? { model: opts.model } : {}) };
    const started = resume
      ? await call('thread/resume', { ...params, threadId: resume })
      : await call('thread/start', params);
    if (started.error) {
      notice('session_failed', { message: str(started.error.message, 500) });
      return false;
    }
    threadId = started.result?.thread?.id ?? null;
    if (typeof started.result?.model === 'string') hooks.meta({ model: started.result.model.slice(0, 80) });
    for (const turn of started.result?.thread?.turns ?? []) {
      for (const item of turn.items ?? []) onItem(item, true);
    }
    return true;
  }

  /** The model list for /model; without it the command still takes a typed name. */
  async function loadModels() {
    const r = await call('model/list', {});
    const models = (Array.isArray(r.result?.data) ? r.result.data : [])
      .filter((/** @type {any} */ m) => typeof m?.model === 'string' && !m.hidden)
      .map((/** @type {any} */ m) => ({
        value: String(m.model).slice(0, 64),
        label: String(m.displayName ?? m.model).slice(0, 80),
        sub: String(m.description ?? '').slice(0, 120),
      }));
    hooks.commands(
      CODEX_COMMANDS.map((c) => (c.name === 'model' && models.length ? { ...c, options: models } : c)),
    );
  }

  /**
   * Sends a request that runs as a turn; turn/completed clears the busy flag.
   * @param {string} method @param {Record<string, unknown>} params
   */
  function turnRequest(method, params) {
    turnStart = total;
    limited = false;
    hooks.busy(true);
    void call(method, params).then((r) => {
      if (r.error) {
        hooks.busy(false);
        notice('not_done', { message: str(r.error.message, 500) });
      } else {
        turnId = r.result?.turn?.id ?? turnId;
      }
    });
  }

  /**
   * @param {{ name: string, args: string }} cmd
   * @returns {string | null | undefined} an error code, null when done, undefined when not a command
   */
  function runCommand(cmd) {
    const id = /** @type {string} */ (threadId);
    switch (cmd.name) {
      case 'compact':
        turnRequest('thread/compact/start', { threadId: id });
        return null;
      case 'review':
        turnRequest('review/start', {
          threadId: id,
          target: cmd.args ? { type: 'custom', instructions: cmd.args } : { type: 'uncommittedChanges' },
          delivery: 'inline',
        });
        return null;
      case 'new':
        hooks.busy(true);
        void openThread().then((ok) => {
          hooks.busy(false);
          if (ok) notice('new_thread', {}, 'info');
        });
        return null;
      case 'model':
        if (!MODEL.test(cmd.args)) return 'bad_command';
        overrides.model = cmd.args;
        hooks.meta({ model: cmd.args });
        queueMicrotask(() => notice('model_set', { model: cmd.args }, 'info'));
        return null;
      case 'effort':
        if (!EFFORT.test(cmd.args)) return 'bad_command';
        overrides.effort = cmd.args;
        queueMicrotask(() => notice('effort_set', { effort: cmd.args }, 'info'));
        return null;
      default:
        return undefined;
    }
  }

  void (async () => {
    const init = await call('initialize', {
      clientInfo: { name: 'agent-hub', title: 'Agent Hub', version: '0.1.0' },
      capabilities: null,
    });
    if (init.error) return notice('start_failed', { message: str(init.error.message, 500) });
    proc.write({ jsonrpc: '2.0', method: 'initialized' });
    hooks.commands(CODEX_COMMANDS);
    if (await openThread(opts.resume)) notice('ready', {}, 'info');
    await loadModels();
  })();

  return {
    pid: proc.child.pid ?? 0,
    exited: proc.exited.then((code) => {
      pending.clear();
      hooks.busy(false);
      hooks.waiting(null);
      return code;
    }),
    send(text, images = []) {
      if (!threadId) return 'not_ready';
      const cmd = images.length ? null : parseCommand(text);
      if (cmd) {
        const result = runCommand(cmd);
        if (result !== undefined) return result;
      }
      // Unknown "/..." goes through as text: it may just as well be a path.
      turnRequest('turn/start', {
        threadId,
        input: [
          ...images.map((img) => ({ type: 'localImage', path: img.file })),
          ...(text ? [{ type: 'text', text, text_elements: [] }] : []),
        ],
        ...overrides,
      });
      return null;
    },
    answer(requestId, allow) {
      const p = pending.get(requestId);
      if (!p) return false;
      pending.delete(requestId);
      // Only a one-time decision: "accept for session" is deliberately never sent.
      proc.write({ jsonrpc: '2.0', id: p.rpcId, result: { decision: allow ? 'accept' : 'decline' } });
      hooks.item({ id: requestId, kind: 'approval', ts: now(), status: allow ? 'allowed' : 'denied' });
      hooks.waiting(waitingText());
      return true;
    },
    interrupt() {
      if (threadId && turnId) void call('turn/interrupt', { threadId, turnId });
    },
  };
}
