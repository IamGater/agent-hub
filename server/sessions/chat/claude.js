// @ts-check
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { killTree } from '../../agents/kill.js';
import { LIMIT_TEXT, noticeItem, parseCommand, startJsonProcess, str } from './process.js';

// Commands that change settings directly, without a tool call the owner would see as a card:
// "/config" can add permission allow rules, "/auto-mode-setup" configures auto-approval.
const BLOCKED_COMMANDS = new Set(['config', 'auto-mode-setup']);
const MODEL = /^[A-Za-z0-9._:[\]-]{1,64}$/;

/** @param {any} input */
function filePaths(input) {
  const p = input?.file_path ?? input?.notebook_path;
  return typeof p === 'string' ? [p] : [];
}

const WINDOW_MINS = /** @type {Record<string, number>} */ ({ session: 300, weekly: 10080 });

/**
 * Plan limits of the account Claude Code is signed in with. Asked with the get_usage control
 * request of a short-lived process: no message is sent, so nothing is spent.
 * @param {Omit<import('./process.js').DriverOpts, 'hooks' | 'now'>} opts
 * @returns {Promise<import('./process.js').AccountUsage>}
 */
export function claudeUsage(opts) {
  return new Promise((resolve, reject) => {
    const hooks = /** @type {import('./process.js').Hooks} */ (/** @type {unknown} */ ({ warn: () => {} }));
    const proc = startJsonProcess(
      {
        ...opts,
        args: ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose'],
        hooks,
      },
      (msg) => {
        if (msg.type !== 'control_response') return;
        if (msg.response?.request_id === 'init') {
          proc.write({ type: 'control_request', request_id: 'usage', request: { subtype: 'get_usage' } });
          return;
        }
        if (msg.response?.request_id !== 'usage') return;
        const r = msg.response.response ?? {};
        const limits = (Array.isArray(r.rate_limits?.limits) ? r.rate_limits.limits : [])
          .filter((/** @type {any} */ l) => typeof l?.kind === 'string' && typeof l.percent === 'number')
          .map((/** @type {any} */ l) => ({
            kind: String(l.kind).slice(0, 40),
            windowMins: WINDOW_MINS[l.group] ?? null,
            percent: l.percent,
            resetsAt: l.resets_at ? Date.parse(l.resets_at) || null : null,
          }));
        done(null, { plan: typeof r.subscription_type === 'string' ? r.subscription_type : null, limits });
      },
    );
    const timer = setTimeout(() => done(new Error('agent did not answer')), 20_000);
    void proc.exited.then(() => done(new Error('agent exited')));
    /** @param {Error | null} err @param {import('./process.js').AccountUsage} [value] */
    function done(err, value) {
      clearTimeout(timer);
      if (proc.child.pid) void killTree(proc.child.pid);
      if (err) reject(err);
      else resolve(/** @type {import('./process.js').AccountUsage} */ (value));
    }
    proc.write({ type: 'control_request', request_id: 'init', request: { subtype: 'initialize' } });
  });
}

/** Short label for a tool call, shown in the collapsed row. @param {string} name @param {any} input */
export function toolSummary(name, input) {
  if (!input || typeof input !== 'object') return name;
  const pick =
    input.command ?? input.file_path ?? input.notebook_path ?? input.pattern ?? input.url ?? input.query;
  if (typeof pick !== 'string') return name;
  return `${name}: ${pick.split('\n')[0].slice(0, 200)}`;
}

/** What the owner is approving, in full. @param {string} name @param {any} input */
export function describeInput(name, input) {
  if (!input || typeof input !== 'object') return str(input);
  if (typeof input.command === 'string') {
    return [input.command, input.description ? `\n# ${input.description}` : ''].join('');
  }
  if (typeof input.file_path === 'string' && typeof input.content === 'string') {
    return `${input.file_path}\n\n${input.content}`;
  }
  if (typeof input.file_path === 'string' && typeof input.old_string === 'string') {
    return `${input.file_path}\n\n- ${input.old_string.split('\n').join('\n- ')}\n+ ${String(
      input.new_string ?? '',
    )
      .split('\n')
      .join('\n+ ')}`;
  }
  return str(input);
}

/** @param {any} content */
function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c?.type === 'text' ? c.text : c?.type ? `[${c.type}]` : ''))
      .filter(Boolean)
      .join('\n');
  }
  return str(content);
}

/**
 * What a failed result says, without Claude Code's internal "[ede_diagnostic] …" lines, which only
 * describe where its loop ended. Empty when nothing readable is left.
 * @param {any} msg
 */
export function errorText(msg) {
  if (typeof msg.result === 'string' && msg.result.trim()) return str(msg.result, 2000);
  const errors = (Array.isArray(msg.errors) ? msg.errors : [msg.errors])
    .map((e) => (typeof e === 'string' ? e : e ? str(e, 500) : ''))
    .filter((e) => e.trim() && !e.startsWith('[ede_diagnostic]'));
  if (errors.length) return str(errors.join('\n'), 2000);
  if (msg.subtype === 'error_max_turns') return 'too many steps in one answer';
  return '';
}

/**
 * Claude Code in print mode with streaming JSON both ways. Every permission prompt is sent to us as
 * a can_use_tool control request (--permission-prompt-tool stdio) and waits for the owner. The
 * permission mode is pinned to "default" so a bypass set in the user's settings cannot take over.
 * @param {import('./process.js').DriverOpts} opts
 * @returns {import('./process.js').Driver}
 */
export function startClaude(opts) {
  const { hooks, now } = opts;
  /** @type {Map<string, any>} request id -> tool input */
  const pending = new Map();
  const initId = randomUUID();
  /** @type {Map<string, (response: any) => void>} control requests we sent, by id */
  const asked = new Map();

  function waitingText() {
    const first = pending.values().next().value;
    return first ? first.prompt : null;
  }

  /** Tokens spent in this run, summed over the answers. */
  const tokens = { input: 0, output: 0, cached: 0 };
  /** Usage of each model call of the answer in progress, by message id (blocks repeat it). */
  /** @type {Map<string, { input: number, output: number, cached: number }>} */
  let turnCalls = new Map();
  /** While a resumed history is shown: its usage was spent long ago. */
  let replaying = false;
  /** Set during an answer when the plan limit stopped it: when the limit comes back (ms), or null. */
  /** @type {{ resetsAt: number | null } | null} */
  let limited = null;
  /** Set when the owner stopped the answer: its error result is just the stop, not a failure. */
  let interrupted = false;

  const n = (/** @type {unknown} */ v) => (typeof v === 'number' && v > 0 ? v : 0);

  /** @param {any} msg */
  function countCall(msg) {
    const u = msg.message?.usage;
    if (replaying || !u || typeof u !== 'object' || typeof msg.message?.id !== 'string') return;
    turnCalls.set(msg.message.id, {
      input: n(u.input_tokens) + n(u.cache_creation_input_tokens),
      cached: n(u.cache_read_input_tokens),
      output: n(u.output_tokens),
    });
    const sum = { input: 0, output: 0, cached: 0 };
    for (const c of turnCalls.values()) {
      sum.input += c.input;
      sum.cached += c.cached;
      sum.output += c.output;
    }
    hooks.meta({ turnTokens: sum });
  }

  /** "Claude AI usage limit reached|1731600000" carries the reset time in seconds. @param {string} text */
  function limitFrom(text) {
    if (!LIMIT_TEXT.test(text)) return false;
    const at = /\|(\d{9,11})/.exec(text);
    limited = { resetsAt: at ? Number(at[1]) * 1000 : (limited?.resetsAt ?? null) };
    return true;
  }

  /** @param {any} info */
  function onRateLimit(info) {
    if (!info || typeof info !== 'object') return;
    const five = info.unifiedWindows?.five_hour;
    /** @param {unknown} u fraction (0..1) or percent */
    const pct = (u) => (typeof u === 'number' ? (u <= 1 ? u * 100 : u) : null);
    const sec = (/** @type {unknown} */ v) => (typeof v === 'number' && v > 0 ? v * 1000 : null);
    const reading =
      five && pct(five.utilization) !== null
        ? { percent: /** @type {number} */ (pct(five.utilization)), resetsAt: sec(five.resetsAt) }
        : info.rateLimitType === 'five_hour' && pct(info.utilization) !== null
          ? { percent: /** @type {number} */ (pct(info.utilization)), resetsAt: sec(info.resetsAt) }
          : null;
    if (reading && !replaying) hooks.meta({ window: reading });
    if (info.status === 'rejected' && !info.isUsingOverage) limited = { resetsAt: sec(info.resetsAt) };
  }

  /** @param {any} msg */
  function onMessage(msg) {
    switch (msg.type) {
      case 'assistant': {
        const model = msg.message?.model;
        if (typeof model === 'string' && !model.startsWith('<')) hooks.meta({ model: model.slice(0, 80) });
        const blocks = Array.isArray(msg.message?.content) ? msg.message.content : [];
        if (model === '<synthetic>' && !replaying) {
          for (const b of blocks) if (b?.type === 'text' && typeof b.text === 'string') limitFrom(b.text);
        } else {
          countCall(msg);
        }
        blocks.forEach((/** @type {any} */ b, /** @type {number} */ i) => {
          if (b?.type === 'text' && b.text) {
            hooks.item({ id: `${msg.message.id}:${i}`, kind: 'assistant', ts: now(), text: b.text });
          } else if (b?.type === 'tool_use') {
            hooks.item({
              id: String(b.id),
              kind: 'tool',
              ts: now(),
              title: toolSummary(String(b.name), b.input),
              detail: describeInput(String(b.name), b.input),
              status: 'running',
              paths: filePaths(b.input),
            });
          }
        });
        return;
      }
      case 'user': {
        const blocks = Array.isArray(msg.message?.content) ? msg.message.content : [];
        for (const b of blocks) {
          if (b?.type !== 'tool_result') continue;
          hooks.item({
            id: String(b.tool_use_id),
            kind: 'tool',
            ts: now(),
            output: resultText(b.content),
            status: b.is_error ? 'error' : 'ok',
          });
        }
        return;
      }
      case 'rate_limit_event':
        onRateLimit(msg.rate_limit_info);
        return;
      case 'result': {
        if (msg.is_error || (msg.subtype && msg.subtype !== 'success')) {
          limitFrom(str(msg.result ?? msg.errors ?? '', 2000));
        }
        const stop = limited;
        limited = null;
        if (msg.usage && typeof msg.usage === 'object') {
          const u = msg.usage;
          tokens.input += n(u.input_tokens) + n(u.cache_creation_input_tokens);
          tokens.cached += n(u.cache_read_input_tokens);
          tokens.output += n(u.output_tokens);
          hooks.meta({ tokens: { ...tokens } });
        }
        hooks.busy(false);
        proc.write({
          type: 'control_request',
          request_id: `ctx:${randomUUID()}`,
          request: { subtype: 'get_context_usage' },
        });
        const stopped = interrupted;
        interrupted = false;
        if (msg.is_error || (msg.subtype && msg.subtype !== 'success')) {
          const message = errorText(msg);
          if (stopped && !stop) {
            hooks.item(noticeItem('interrupted', {}, 'info', now()));
          } else if (message) {
            hooks.item(noticeItem('agent_error', { message }, 'error', now()));
          } else {
            hooks.item(noticeItem('agent_failed', {}, 'error', now()));
          }
        }
        if (stop) hooks.limit(stop.resetsAt);
        return;
      }
      case 'control_request':
        onControl(msg);
        return;
      case 'control_response': {
        const answered = asked.get(String(msg.response?.request_id));
        if (answered) {
          asked.delete(String(msg.response.request_id));
          answered(msg.response);
          return;
        }
        if (String(msg.response?.request_id).startsWith('ctx:')) {
          const r = msg.response.response ?? {};
          if (typeof r.totalTokens === 'number' && typeof r.maxTokens === 'number')
            hooks.meta({ context: { used: r.totalTokens, size: r.maxTokens } });
          return;
        }
        if (msg.response?.request_id !== initId) return;
        const res = msg.response.response ?? {};
        const models = (Array.isArray(res.models) ? res.models : [])
          .filter((/** @type {any} */ m) => typeof m?.value === 'string')
          .map((/** @type {any} */ m) => ({
            value: m.value.slice(0, 64),
            label: String(m.displayName ?? m.value).slice(0, 80),
            sub: String(m.description ?? '').slice(0, 120),
          }));
        hooks.commands(
          (Array.isArray(res.commands) ? res.commands : [])
            .filter((/** @type {any} */ c) => typeof c?.name === 'string' && !BLOCKED_COMMANDS.has(c.name))
            .map((/** @type {any} */ c) => ({
              name: c.name.slice(0, 80),
              description: String(c.description ?? '').slice(0, 200),
              hint: String(c.argumentHint ?? '').slice(0, 120),
              ...(c.name === 'model' && models.length ? { options: models } : {}),
            })),
        );
        return;
      }
      case 'control_cancel_request': {
        const id = String(msg.request_id);
        if (!pending.delete(id)) return;
        hooks.item({ id, kind: 'approval', ts: now(), status: 'cancelled' });
        hooks.waiting(waitingText());
        return;
      }
    }
  }

  /** @param {any} msg */
  function onControl(msg) {
    const id = String(msg.request_id);
    const req = msg.request ?? {};
    if (req.subtype !== 'can_use_tool') {
      proc.write({
        type: 'control_response',
        response: { subtype: 'error', request_id: id, error: 'not supported' },
      });
      return;
    }
    const name = String(req.tool_name);
    // A multiple-choice question cannot be answered through an allow/deny card; asking in plain text
    // keeps the conversation in the chat, where the owner answers normally.
    if (name === 'AskUserQuestion') {
      reply(id, {
        behavior: 'deny',
        message: 'This client cannot show multiple-choice questions. Ask the question in plain text instead.',
      });
      return;
    }
    const title = `${req.display_name ?? name}${req.description ? `: ${req.description}` : ''}`;
    pending.set(id, {
      input: req.input,
      prompt: `${name}: ${describeInput(name, req.input).slice(0, 2000)}`,
    });
    hooks.item({
      id,
      kind: 'approval',
      ts: now(),
      title,
      detail: describeInput(name, req.input),
      status: 'pending',
    });
    hooks.waiting(waitingText());
  }

  /** @param {string} id @param {Record<string, unknown>} response */
  function reply(id, response) {
    proc.write({ type: 'control_response', response: { subtype: 'success', request_id: id, response } });
  }

  const proc = startJsonProcess(
    {
      ...opts,
      args: [
        '-p',
        '--output-format',
        'stream-json',
        '--input-format',
        'stream-json',
        '--verbose',
        '--permission-mode',
        'default',
        '--permission-prompts',
        'host',
        '--permission-prompt-tool',
        'stdio',
        ...(opts.model ? ['--model', opts.model] : []),
        ...(opts.resume ? ['--resume', opts.resume] : []),
        // Without the owner's MCP servers (each session would start its own copy of every one).
        ...(opts.mcp === false ? ['--strict-mcp-config'] : []),
      ],
    },
    onMessage,
  );
  // A resumed session is shown from Claude's own session file; each line holds one content block.
  replaying = true;
  for (const line of opts.history ?? []) {
    const content = line.message?.content;
    const key = String(line.uuid ?? randomUUID());
    if (
      line.type === 'user' &&
      (typeof content === 'string' || !content?.some?.((/** @type {any} */ b) => b?.type === 'tool_result'))
    ) {
      const text =
        typeof content === 'string'
          ? content
          : content.map((/** @type {any} */ b) => (b?.type === 'text' ? b.text : '')).join('\n');
      if (text && !text.startsWith('<') && !text.startsWith('Caveat:'))
        hooks.item({ id: `h:${key}`, kind: 'user', ts: now(), text });
    } else if (line.type === 'assistant') {
      onMessage({ ...line, message: { ...line.message, id: `h:${key}` } });
    } else {
      onMessage(line);
    }
  }
  replaying = false;

  proc.write({ type: 'control_request', request_id: initId, request: { subtype: 'initialize' } });

  return {
    pid: proc.child.pid ?? 0,
    exited: proc.exited.then((code) => {
      pending.clear();
      hooks.busy(false);
      hooks.waiting(null);
      return code;
    }),
    send(text, images = []) {
      const cmd = images.length ? null : parseCommand(text);
      if (cmd && BLOCKED_COMMANDS.has(cmd.name)) return 'command_blocked';
      // Switched through the protocol rather than as text: the answer names the model at once, so
      // the chat shows it without waiting for the next message. "default" goes back to the default.
      if (cmd?.name === 'model' && cmd.args) {
        if (!MODEL.test(cmd.args)) return 'bad_command';
        const id = `model:${randomUUID()}`;
        asked.set(id, (res) => {
          if (res.subtype === 'success' && typeof res.response?.model === 'string') {
            hooks.meta({ model: res.response.model.slice(0, 80) });
            hooks.item(noticeItem('model_set', { model: res.response.model.slice(0, 80) }, 'info', now()));
          } else {
            hooks.item(noticeItem('not_done', { message: str(res.error ?? 'refused', 500) }, 'error', now()));
          }
        });
        const request =
          cmd.args === 'default' ? { subtype: 'set_model' } : { subtype: 'set_model', model: cmd.args };
        return proc.write({ type: 'control_request', request_id: id, request }) ? null : 'not_running';
      }
      // Slash commands go in as ordinary text: Claude Code recognizes them itself.
      /** @type {any} */
      let content = text;
      if (images.length) {
        try {
          content = [
            ...images.map((img) => ({
              type: 'image',
              source: {
                type: 'base64',
                media_type: img.mime,
                data: fs.readFileSync(img.file).toString('base64'),
              },
            })),
            ...(text ? [{ type: 'text', text }] : []),
          ];
        } catch {
          return 'image_gone';
        }
      }
      const ok = proc.write({
        type: 'user',
        session_id: '',
        parent_tool_use_id: null,
        message: { role: 'user', content },
      });
      if (!ok) return 'not_running';
      turnCalls = new Map();
      limited = null;
      hooks.busy(true);
      return null;
    },
    answer(requestId, allow) {
      const p = pending.get(requestId);
      if (!p) return false;
      pending.delete(requestId);
      // The input is passed back unchanged: the owner approves exactly what was shown.
      reply(
        requestId,
        allow
          ? { behavior: 'allow', updatedInput: p.input }
          : { behavior: 'deny', message: 'The owner denied this action.' },
      );
      hooks.item({ id: requestId, kind: 'approval', ts: now(), status: allow ? 'allowed' : 'denied' });
      hooks.waiting(waitingText());
      return true;
    },
    interrupt() {
      interrupted = true;
      proc.write({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } });
    },
  };
}
