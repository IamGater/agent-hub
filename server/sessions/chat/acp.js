// @ts-check
import path from 'node:path';
import { noticeItem, parseCommand, rpcOnce, startJsonProcess, str } from './process.js';

const MODEL = /^[A-Za-z0-9._:-]{1,64}$/;

/** ACP reports folders as "/C:/a%20b"; compare them as Windows paths. @param {string} p @param {string} cwd */
function samePath(p, cwd) {
  let s = p;
  try {
    s = decodeURIComponent(p);
  } catch {
    // Keep it as it is.
  }
  s = path.normalize(s.replace(/^\/([A-Za-z]:)/, '$1'));
  const a = s.replace(/[\\/]+$/, '');
  const b = path.normalize(cwd).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Past Antigravity sessions in a folder, asked from a short-lived `agy acp`.
 * @param {Omit<import('./process.js').DriverOpts, 'hooks' | 'now'>} opts
 * @returns {Promise<import('./history.js').SessionInfo[]>}
 */
export function listAcpSessions(opts) {
  return rpcOnce({ ...opts, args: ['acp'] }, async (call) => {
    const init = await call('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'agent-hub', title: 'Agent Hub', version: '0.1.0' },
    });
    if (init.error) throw new Error(String(init.error.message));
    const list = await call('session/list', { cwd: opts.cwd });
    if (list.error) throw new Error(String(list.error.message));
    return (Array.isArray(list.result?.sessions) ? list.result.sessions : [])
      .filter(
        (/** @type {any} */ s) => typeof s?.sessionId === 'string' && samePath(String(s.cwd ?? ''), opts.cwd),
      )
      .slice(0, 30)
      .map((/** @type {any} */ s) => ({
        id: s.sessionId,
        title: String(s.title || s.sessionId).slice(0, 120),
        updatedAt: Date.parse(s.updatedAt) || 0,
      }));
  });
}

const TOOL_STATUS = /** @type {Record<string, 'running' | 'ok' | 'error'>} */ ({
  pending: 'running',
  in_progress: 'running',
  completed: 'ok',
  failed: 'error',
});

/** @param {any} call */
function describeCall(call) {
  const parts = [];
  for (const c of Array.isArray(call?.content) ? call.content : []) {
    if (c?.type === 'diff') parts.push(`${c.path ?? ''}\n${c.newText ?? ''}`);
    else if (c?.type === 'content' && c.content?.type === 'text') parts.push(String(c.content.text ?? ''));
  }
  if (!parts.length && call?.rawInput !== undefined) parts.push(str(call.rawInput));
  return parts.join('\n\n');
}

/** @param {any} call */
function callPaths(call) {
  return (Array.isArray(call?.locations) ? call.locations : [])
    .map((/** @type {any} */ l) => String(l?.path ?? '').replace(/^\/([A-Za-z]:)/, '$1'))
    .filter(Boolean);
}

/**
 * Antigravity through the Agent Client Protocol (`agy acp`, JSON-RPC over stdio). The session is
 * switched to mode "default" (ask before edits and commands); if the agent will not confirm that,
 * the session is not used. The client declares no file system or terminal capabilities, so the
 * agent cannot route reads or commands through us.
 * @param {import('./process.js').DriverOpts} opts
 * @returns {import('./process.js').Driver}
 */
export function startAcp(opts) {
  const { hooks, now } = opts;
  let nextId = 1;
  /** @type {Map<number, (msg: any) => void>} */
  const calls = new Map();
  /** @type {Map<string, { rpcId: unknown, allow: string | null, deny: string | null, prompt: string }>} */
  const pending = new Map();
  /** @type {Map<string, any>} merged state of each tool call, since updates carry only changes */
  const tools = new Map();
  /** @type {string | null} */
  let sessionId = null;
  /** @type {string | null} the assistant message being streamed */
  let message = null;
  /** @type {string | null} the owner message being replayed while a past session loads */
  let replayed = null;
  let loading = false;
  let messages = 0;
  /** @type {import('./process.js').Command[]} */
  let agentCommands = [];
  /** @type {import('./process.js').Choice[]} */
  let models = [];

  // ACP has no /model command of its own; it has session/set_model, offered here as one.
  function publishCommands() {
    const own = agentCommands.filter((c) => c.name !== 'model');
    const model = {
      name: 'model',
      description: 'Switch the model for the next messages',
      hint: '<model>',
      ...(models.length ? { options: models } : {}),
    };
    hooks.commands([...own, model]);
  }

  /** @param {string} method @param {unknown} params @returns {Promise<any>} */
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

  /** @param {any} u */
  function onUpdate(u) {
    switch (u?.sessionUpdate) {
      case 'user_message_chunk': {
        // Only shown while a past session replays; a live turn already shows what the owner sent.
        if (!loading || u.content?.type !== 'text' || typeof u.content.text !== 'string') return;
        message = null;
        if (!replayed) {
          replayed = `user:${++messages}:${now()}`;
          hooks.item({ id: replayed, kind: 'user', ts: now(), text: '' });
        }
        hooks.delta(replayed, u.content.text);
        return;
      }
      case 'agent_message_chunk': {
        if (u.content?.type !== 'text' || typeof u.content.text !== 'string') return;
        replayed = null;
        if (!message) {
          message = `msg:${++messages}:${now()}`;
          hooks.item({ id: message, kind: 'assistant', ts: now(), text: '' });
        }
        hooks.delta(message, u.content.text);
        return;
      }
      case 'tool_call':
      case 'tool_call_update': {
        if (!u.toolCallId) return;
        message = null;
        replayed = null;
        const id = String(u.toolCallId);
        const merged = { ...tools.get(id), ...u };
        tools.set(id, merged);
        hooks.item({
          id,
          kind: 'tool',
          ts: now(),
          title: String(merged.title ?? merged.name ?? 'tool').slice(0, 300),
          detail: describeCall(merged),
          output:
            merged.rawOutput && Object.keys(merged.rawOutput).length ? str(merged.rawOutput) : undefined,
          status: TOOL_STATUS[merged.status] ?? 'running',
          paths: callPaths(merged),
        });
        return;
      }
      case 'usage_update':
        if (typeof u.used === 'number' && typeof u.size === 'number')
          hooks.meta({ context: { used: u.used, size: u.size } });
        return;
      case 'available_commands_update':
        agentCommands = (Array.isArray(u.availableCommands) ? u.availableCommands : [])
          .filter((/** @type {any} */ c) => typeof c?.name === 'string')
          .map((/** @type {any} */ c) => ({
            name: c.name.slice(0, 80),
            description: String(c.description ?? '').slice(0, 200),
            hint: String(c.input?.hint ?? '').slice(0, 120),
          }));
        publishCommands();
        return;
    }
  }

  /** @param {any} msg */
  function onServerRequest(msg) {
    if (msg.method !== 'session/request_permission') {
      // File system and terminal requests are not offered in our capabilities; refuse anything else.
      proc.write({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: 'not supported by this client' },
      });
      return;
    }
    const p = msg.params ?? {};
    const options = Array.isArray(p.options) ? p.options : [];
    // Only one-time choices are ever picked: "allow always" options are not offered to the owner.
    const allow = options.find((/** @type {any} */ o) => o?.kind === 'allow_once')?.optionId ?? null;
    const deny = options.find((/** @type {any} */ o) => o?.kind === 'reject_once')?.optionId ?? null;
    const key = `approval:${String(msg.id)}`;
    const title = String(p.toolCall?.title ?? p.toolCall?.name ?? 'Tool call').slice(0, 300);
    const detail = describeCall(p.toolCall);
    pending.set(key, { rpcId: msg.id, allow, deny, prompt: `${title}: ${detail.slice(0, 2000)}` });
    hooks.item({ id: key, kind: 'approval', ts: now(), title, detail, status: 'pending' });
    hooks.waiting(waitingText());
  }

  /** @param {any} msg */
  function onMessage(msg) {
    if (msg.method && msg.id !== undefined) return onServerRequest(msg);
    if (msg.method === 'session/update') return onUpdate(msg.params?.update);
    if (typeof msg.id === 'number' && calls.has(msg.id)) {
      const resolve = /** @type {(m: any) => void} */ (calls.get(msg.id));
      calls.delete(msg.id);
      resolve(msg);
    }
  }

  /** @param {string} key @param {unknown} outcome */
  function settle(key, outcome) {
    const p = pending.get(key);
    if (!p) return;
    pending.delete(key);
    proc.write({ jsonrpc: '2.0', id: p.rpcId, result: { outcome } });
  }

  const proc = startJsonProcess({ ...opts, args: ['acp'] }, onMessage);

  void (async () => {
    const init = await call('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'agent-hub', title: 'Agent Hub', version: '0.1.0' },
    });
    if (init.error) return notice('start_failed', { message: str(init.error.message, 500) });
    // Loading a past session makes the agent replay it as session/update notifications.
    loading = Boolean(opts.resume);
    const created = opts.resume
      ? await call('session/load', { sessionId: opts.resume, cwd: opts.cwd, mcpServers: [] })
      : await call('session/new', { cwd: opts.cwd, mcpServers: [] });
    loading = false;
    message = null;
    replayed = null;
    if (created.error) return notice('session_failed', { message: str(created.error.message, 500) });
    const id = opts.resume ?? String(created.result?.sessionId ?? '');
    const current = created.result?.models?.currentModelId;
    const tier = created.result?._meta?.antigravity?.tier?.name;
    hooks.meta({
      ...(typeof current === 'string' ? { model: current.slice(0, 80) } : {}),
      ...(typeof tier === 'string' ? { plan: tier.slice(0, 80) } : {}),
    });
    models = (
      Array.isArray(created.result?.models?.availableModels) ? created.result.models.availableModels : []
    )
      .filter((/** @type {any} */ m) => typeof m?.modelId === 'string')
      .map((/** @type {any} */ m) => ({
        value: m.modelId.slice(0, 64),
        label: String(m.name ?? m.modelId).slice(0, 80),
      }));
    publishCommands();
    if (!id) return notice('session_failed', { message: 'no session id' });
    // The user's own settings may pick an auto-approving mode; this session always asks.
    if (created.result?.modes?.currentModeId !== 'default') {
      const set = await call('session/set_mode', { sessionId: id, modeId: 'default' });
      if (set.error) return notice('mode_refused');
    }
    if (opts.model) {
      const set = await call('session/set_model', { sessionId: id, modelId: opts.model });
      if (set.error) notice('not_done', { message: str(set.error.message, 500) });
      else hooks.meta({ model: opts.model });
    }
    sessionId = id;
    notice('ready', {}, 'info');
  })();

  return {
    pid: proc.child.pid ?? 0,
    exited: proc.exited.then((code) => {
      pending.clear();
      hooks.busy(false);
      hooks.waiting(null);
      return code;
    }),
    send(text) {
      if (!sessionId) return 'not_ready';
      const cmd = parseCommand(text);
      if (cmd?.name === 'model') {
        if (!MODEL.test(cmd.args)) return 'bad_command';
        const sid = sessionId;
        void call('session/set_model', { sessionId: sid, modelId: cmd.args }).then((r) =>
          r.error
            ? notice('not_done', { message: str(r.error.message, 500) })
            : (hooks.meta({ model: cmd.args }), notice('model_set', { model: cmd.args }, 'info')),
        );
        return null;
      }
      message = null;
      hooks.busy(true);
      // Slash commands are part of the prompt text in ACP; the agent expands them itself.
      void call('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }).then((r) => {
        message = null;
        hooks.busy(false);
        if (r.error) notice('not_done', { message: str(r.error.message, 500) });
        else if (r.result?.stopReason === 'refusal') notice('agent_error', { message: 'refused' });
      });
      return null;
    },
    answer(requestId, allow) {
      const p = pending.get(requestId);
      if (!p) return false;
      const option = allow ? p.allow : p.deny;
      settle(requestId, option ? { outcome: 'selected', optionId: option } : { outcome: 'cancelled' });
      hooks.item({
        id: requestId,
        kind: 'approval',
        ts: now(),
        status: allow && option ? 'allowed' : 'denied',
      });
      hooks.waiting(waitingText());
      return true;
    },
    interrupt() {
      if (!sessionId) return;
      // ACP expects the client to answer open permission requests as cancelled when it cancels.
      for (const key of [...pending.keys()]) {
        settle(key, { outcome: 'cancelled' });
        hooks.item({ id: key, kind: 'approval', ts: now(), status: 'cancelled' });
      }
      hooks.waiting(null);
      proc.write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });
    },
  };
}
