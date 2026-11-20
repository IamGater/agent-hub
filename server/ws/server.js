// @ts-check
import { WebSocketServer } from 'ws';
import { findSession, modeOf, touchSession } from '../auth/store.js';
import { hostAllowed, originAllowed, sessionFromCookie, tailnetUserAllowed } from '../auth/guard.js';
import { isRemoteEnabled } from '../db.js';
import { createBudget } from '../auth/ratelimit.js';
import { clientMessage } from './messages.js';

const SWEEP_MS = 10_000;
const MAX_BUFFERED = 8 * 1024 * 1024;

/**
 * @typedef {{
 *   hash: string | null, scope: 'local' | 'remote', passkeyId: string | null, ip: string, ua: string,
 *   subs: Set<string>, alive: boolean, mode: 'view' | 'control', take: (k: string) => boolean,
 * }} Conn
 */

/**
 * @param {import('node:stream').Duplex} socket
 * @param {number} code
 * @param {string} text
 */
function reject(socket, code, text) {
  socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

/** @param {{ mode: 'view' | 'control', until: number | null }} m @param {number} now */
function remaining(m, now) {
  if (m.mode !== 'control') return 0;
  return m.until === null ? null : m.until - now;
}

/** @param {Conn} conn */
function actor(conn) {
  return { passkeyId: conn.passkeyId, ip: conn.ip, ua: conn.ua };
}

/**
 * Returns the upgrade handler; the caller says which listener the request arrived on.
 * @param {import('../app.js').Ctx} ctx
 */
export function attachWs(ctx) {
  const { config, db, manager } = ctx;
  const stepupMs = config.stepupMinutes * 60_000;
  const limits = () => ({
    now: ctx.now(),
    absoluteMs: config.sessionHours * 3600_000,
    idleMs: config.idleMinutes * 60_000,
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024, perMessageDeflate: false });
  /** @type {Map<import('ws').WebSocket, Conn>} */
  const conns = new Map();
  const localChanged = () =>
    ctx.onLocalWindows?.([...conns.values()].filter((c) => c.scope === 'local').length);

  /**
   * The computer itself is always in control. A remote connection re-reads its session, so
   * revocation, timeouts, step-up expiry and the remote switch take effect right away.
   * @param {{ scope: 'local' | 'remote', hash: string | null }} c
   * @returns {{ mode: 'view' | 'control', until: number | null } | null} null when access is gone
   */
  function modeNow(c) {
    if (c.scope === 'local') return { mode: 'control', until: null };
    if (!c.hash || !isRemoteEnabled(db)) return null;
    const row = findSession(db, c.hash, limits());
    return row ? modeOf(row, ctx.now(), stepupMs) : null;
  }

  /** @param {import('ws').WebSocket} ws @param {import('./messages.js').ServerMessage} msg */
  function send(ws, msg) {
    if (ws.readyState !== ws.OPEN) return;
    // A client that cannot keep up gets dropped instead of growing server memory without bound.
    if (ws.bufferedAmount > MAX_BUFFERED) {
      ws.terminate();
      return;
    }
    ws.send(JSON.stringify(msg));
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:stream').Duplex} socket
   * @param {Buffer} head
   * @param {'local' | 'remote'} scopeName
   */
  function upgrade(req, socket, head, scopeName) {
    // Same rule as Fastify trustProxy: X-Forwarded-For only counts when the proxy is on loopback.
    const peer = String(req.socket.remoteAddress);
    const fwd = String(req.headers['x-forwarded-for'] ?? '')
      .split(',')
      .at(-1)
      ?.trim();
    const ip = peer === '127.0.0.1' && fwd ? fwd : peer;
    const actor = { ip, ua: String(req.headers['user-agent'] ?? '').slice(0, 256) };
    const scope = config.scopes[scopeName];
    if (req.url !== '/ws' || !scope) return reject(socket, 404, 'Not Found');
    if (scopeName === 'remote') {
      if (!isRemoteEnabled(db)) return reject(socket, 503, 'Service Unavailable');
      if (!tailnetUserAllowed(config, req.headers)) {
        ctx.audit('ws_rejected', actor, { reason: 'tailnet_user' });
        return reject(socket, 403, 'Forbidden');
      }
    }
    if (!hostAllowed(scope, req.headers.host)) {
      ctx.audit('ws_rejected', actor, { reason: 'host' });
      return reject(socket, 421, 'Misdirected Request');
    }
    if (!originAllowed(scope, req.headers.origin)) {
      ctx.audit('ws_rejected', actor, { reason: 'origin' });
      return reject(socket, 403, 'Forbidden');
    }
    const s = scopeName === 'remote' ? sessionFromCookie(ctx, req.headers.cookie) : null;
    if (scopeName === 'remote' && !s) return reject(socket, 401, 'Unauthorized');
    const hash = s?.hash ?? null;
    const m = modeNow({ scope: scopeName, hash });
    if (!m) return reject(socket, 401, 'Unauthorized');

    wss.handleUpgrade(req, socket, head, (ws) => {
      /** @type {Conn} */
      const conn = {
        hash,
        scope: scopeName,
        passkeyId: s?.row.passkey_id ?? null,
        ...actor,
        subs: new Set(),
        alive: true,
        mode: m.mode,
        take: createBudget({ now: ctx.now, max: 200, windowMs: 10_000 }),
      };
      conns.set(ws, conn);
      if (scopeName === 'local') localChanged();
      ws.on('pong', () => {
        conn.alive = true;
      });
      ws.on('close', () => {
        conns.delete(ws);
        if (scopeName === 'local') localChanged();
      });
      ws.on('error', (err) => ctx.log.warn({ err: err.message }, 'ws error'));
      ws.on('message', (data, isBinary) => onMessage(ws, conn, data, isBinary));
      send(ws, {
        type: 'hello',
        mode: m.mode,
        remainingMs: remaining(m, ctx.now()),
        agents: manager.list(),
      });
    });
  }

  /**
   * @param {import('ws').WebSocket} ws
   * @param {Conn} conn
   * @param {import('ws').RawData} data
   * @param {boolean} isBinary
   */
  function onMessage(ws, conn, data, isBinary) {
    if (isBinary) return ws.close(1003, 'text only');
    if (!conn.take('msg')) return ws.close(1008, 'rate limit');
    const m = modeNow(conn);
    if (!m) return ws.close(4401, 'session expired');

    let raw;
    try {
      raw = JSON.parse(data.toString());
    } catch {
      ctx.log.warn('ws: malformed json');
      return;
    }
    const parsed = clientMessage.safeParse(raw);
    if (!parsed.success) {
      ctx.log.warn(
        { type: typeof raw?.type === 'string' ? raw.type.slice(0, 32) : null },
        'ws: unknown or invalid message',
      );
      return;
    }
    const msg = parsed.data;
    if (conn.hash) touchSession(db, conn.hash, ctx.now());
    const mode = m.mode;
    conn.mode = mode;

    switch (msg.type) {
      case 'mode':
        send(ws, { type: 'mode', mode, remainingMs: remaining(m, ctx.now()) });
        return;
      case 'subscribe':
        if (!manager.has(msg.agentId)) return send(ws, { type: 'error', code: 'unknown_agent' });
        conn.subs.add(msg.agentId);
        if (manager.info(msg.agentId).type === 'terminal') {
          send(ws, { type: 'snapshot', agentId: msg.agentId, data: manager.snapshot(msg.agentId) });
        } else {
          send(ws, { type: 'chat-snapshot', agentId: msg.agentId, items: manager.transcript(msg.agentId) });
          send(ws, { type: 'chat-commands', agentId: msg.agentId, commands: manager.commands(msg.agentId) });
        }
        return;
      case 'unsubscribe':
        conn.subs.delete(msg.agentId);
        return;
      case 'resize':
        if (mode !== 'control' || !manager.has(msg.agentId)) return;
        manager.resize(msg.agentId, msg.cols, msg.rows);
        return;
      case 'input': {
        if (mode !== 'control') return send(ws, { type: 'error', code: 'view_mode' });
        const info = manager.has(msg.agentId) ? manager.info(msg.agentId) : null;
        if (!info || info.pid === null || info.type !== 'terminal') {
          return send(ws, { type: 'error', code: 'not_running' });
        }
        manager.write(msg.agentId, msg.data);
        /** @type {Record<string, unknown>} */
        const detail = { agentId: msg.agentId, length: msg.data.length };
        if (config.logInputText) detail.text = msg.data;
        ctx.audit('input', actor(conn), detail);
        return;
      }
      // Chat input, approvals and interrupts all act on the agent, so like terminal input they
      // need control mode and are audited.
      case 'chat-send':
      case 'chat-answer':
      case 'chat-interrupt':
      case 'chat-unqueue':
      case 'chat-link':
      case 'chat-unlink':
      case 'chat-continue-cancel': {
        if (mode !== 'control') return send(ws, { type: 'error', code: 'view_mode' });
        const info = manager.has(msg.agentId) ? manager.info(msg.agentId) : null;
        if (!info || info.pid === null || info.type === 'terminal') {
          return send(ws, { type: 'error', code: 'not_running' });
        }
        if (msg.type === 'chat-send') {
          const refused = manager.say(msg.agentId, msg.text);
          if (refused) return send(ws, { type: 'error', code: refused });
          /** @type {Record<string, unknown>} */
          const detail = { agentId: msg.agentId, length: msg.text.length };
          if (config.logInputText) detail.text = msg.text;
          ctx.audit('input', actor(conn), detail);
        } else if (msg.type === 'chat-answer') {
          if (!manager.answer(msg.agentId, msg.requestId, msg.allow)) {
            return send(ws, { type: 'error', code: 'approval_gone' });
          }
          ctx.audit('approval', actor(conn), {
            agentId: msg.agentId,
            requestId: msg.requestId,
            allow: msg.allow,
          });
        } else if (msg.type === 'chat-link') {
          // Linking lets one agent's answers prompt another, so it is an owner decision like input.
          const refused = manager.link(msg.agentId, msg.peer, msg.hops);
          if (refused) return send(ws, { type: 'error', code: refused });
          ctx.audit('link', actor(conn), { agentId: msg.agentId, peer: msg.peer, hops: msg.hops });
        } else if (msg.type === 'chat-unqueue') {
          manager.unqueue(msg.agentId, msg.itemId);
        } else if (msg.type === 'chat-continue-cancel') {
          manager.cancelContinue(msg.agentId);
          ctx.audit('continue_cancel', actor(conn), { agentId: msg.agentId });
        } else if (msg.type === 'chat-unlink') {
          manager.unlink(msg.agentId);
          ctx.audit('unlink', actor(conn), { agentId: msg.agentId });
        } else {
          manager.interrupt(msg.agentId);
          ctx.audit('interrupt', actor(conn), { agentId: msg.agentId });
        }
        return;
      }
    }
  }

  manager.events.on('output', ({ id, data }) => {
    for (const [ws, conn] of conns) if (conn.subs.has(id)) send(ws, { type: 'output', agentId: id, data });
  });
  /** @param {string} id @param {import('./messages.js').ServerMessage} msg */
  function toSubscribers(id, msg) {
    for (const [ws, conn] of conns) if (conn.subs.has(id)) send(ws, msg);
  }
  manager.events.on('chat', ({ id, item }) => toSubscribers(id, { type: 'chat-item', agentId: id, item }));
  manager.events.on('chat-delta', ({ id, itemId, text }) =>
    toSubscribers(id, { type: 'chat-delta', agentId: id, itemId, text }),
  );
  manager.events.on('chat-commands', ({ id, commands }) =>
    toSubscribers(id, { type: 'chat-commands', agentId: id, commands }),
  );
  manager.events.on('chat-reset', ({ id }) =>
    toSubscribers(id, { type: 'chat-snapshot', agentId: id, items: [] }),
  );
  manager.events.on('status', (agent) => {
    for (const ws of conns.keys()) send(ws, { type: 'agent', agent });
  });

  const sweep = setInterval(() => {
    for (const [ws, conn] of conns) {
      if (!conn.alive) {
        ws.terminate();
        continue;
      }
      const m = modeNow(conn);
      if (!m) {
        ws.close(4401, 'session expired');
        continue;
      }
      if (m.mode !== conn.mode) {
        conn.mode = m.mode;
        send(ws, { type: 'mode', mode: m.mode, remainingMs: remaining(m, ctx.now()) });
      }
      conn.alive = false;
      ws.ping();
    }
  }, SWEEP_MS);
  sweep.unref();

  ctx.ws = {
    closeAll(code) {
      for (const ws of conns.keys()) ws.close(code, 'revoked');
    },
    shutdown() {
      clearInterval(sweep);
      for (const ws of conns.keys()) ws.terminate();
    },
    closeSession(hash) {
      for (const [ws, conn] of conns) if (conn.hash === hash) ws.close(4401, 'logged out');
    },
    closeScope(scope) {
      for (const [ws, conn] of conns) if (conn.scope === scope) ws.close(4401, 'remote access off');
    },
  };
  return upgrade;
}
