// @ts-check
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { audit } from './audit/log.js';
import { createChallenges } from './auth/challenges.js';
import {
  hostAllowed,
  markRemote,
  originAllowed,
  scopeOf,
  sessionFromCookie,
  setAuth,
  tailnetUserAllowed,
} from './auth/guard.js';
import { createBudget, createLimiter } from './auth/ratelimit.js';
import { deleteAllSessions, touchSession } from './auth/store.js';
import { authRoutes } from './auth/routes.js';
import { apiRoutes } from './api.js';
import { isRemoteEnabled, setAutoApprove, setRemoteEnabled } from './db.js';
import { createPower } from './agents/power.js';
import { attachWs } from './ws/server.js';

/**
 * @typedef {import('./config/load.js').Scope} Scope
 * @typedef {{
 *   config: import('./config/load.js').RuntimeConfig,
 *   db: import('better-sqlite3').Database,
 *   manager: import('./sessions/manager.js').Manager,
 *   now: () => number,
 *   notify: (title: string, message: string) => Promise<void>,
 *   challenges: import('./auth/challenges.js').Challenges,
 *   limiter: ReturnType<typeof createLimiter>,
 *   budget: (key: string) => boolean,
 *   audit: (event: import('./audit/log.js').AuditEvent, actor: import('./audit/log.js').Actor | null, detail?: Record<string, unknown>) => void,
 *   killAll: (actor: import('./audit/log.js').Actor | null, source: string) => Promise<void>,
 *   remoteOff: (actor: import('./audit/log.js').Actor | null, source: string) => void,
 *   power: import('./agents/power.js').Power,
 *   restartServer?: () => void,
 *   scope: (req: import('fastify').FastifyRequest) => Scope,
 *   log: import('fastify').FastifyBaseLogger,
 *   ws: {
 *     closeAll: (code: number) => void,
 *     closeSession: (hash: string) => void,
 *     closeScope: (scope: Scope['name']) => void,
 *     shutdown: () => void,
 *   },
 *   onLocalWindows?: (count: number) => void,
 * }} Ctx
 */

/** @param {string} origin @param {string | null} nonce */
function csp(origin, nonce) {
  const wss = origin.replace(/^http/, 'ws');
  return [
    "default-src 'self'",
    "script-src 'self'",
    // xterm.js creates <style> elements at runtime; the nonce lets exactly those through.
    nonce ? `style-src 'self' 'nonce-${nonce}'` : "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self' ${wss}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * Builds the app. Fastify's own server is the local listener (browser on this computer);
 * remoteServer is the listener for tailscale serve. index.js decides which ports they bind.
 * @param {{
 *   config: Ctx['config'], db: Ctx['db'], manager: Ctx['manager'],
 *   now?: () => number, notify?: Ctx['notify'], webRoot?: string | null, logger?: boolean | object,
 *   power?: Ctx['power'],
 * }} opts
 */
export async function createApp({
  config,
  db,
  manager,
  now = Date.now,
  notify,
  webRoot = null,
  logger = false,
  power = createPower(),
}) {
  const app = Fastify({
    logger,
    // tailscale serve connects from loopback; only then is X-Forwarded-For trusted for the client IP.
    trustProxy: '127.0.0.1',
    bodyLimit: 64 * 1024,
    return503OnClosing: true,
  });
  // Only JSON bodies. text/plain is a CORS "simple" type, so accepting it would weaken CSRF defenses.
  app.removeContentTypeParser('text/plain');

  /** @type {Ctx} */
  const ctx = {
    config,
    db,
    manager,
    now,
    notify: notify ?? (async () => {}),
    power,
    challenges: createChallenges(now),
    limiter: createLimiter({ now }),
    budget: createBudget({ now, max: 20, windowMs: 60_000 }),
    audit: (event, actor, detail) => audit(db, event, actor, detail, now()),
    log: app.log,
    ws: { closeAll: () => {}, closeSession: () => {}, closeScope: () => {}, shutdown: () => {} },
    scope(req) {
      const s = scopeOf(config, req.raw);
      if (!s) throw new Error('remote request without remote config');
      return s;
    },
    remoteOff(actor, source) {
      const revoked = setRemoteEnabled(db, false);
      ctx.ws.closeScope('remote');
      ctx.audit('remote_off', actor, { source, revoked });
      void ctx.notify('Remote access off', `Remote access was turned off (${source}).`);
    },
    async killAll(actor, source) {
      // Remote access goes off first, so nothing can reconnect while agents are being stopped.
      setRemoteEnabled(db, false);
      // An emergency stop also takes back any permission to act without asking.
      setAutoApprove(db, []);
      for (const id of manager.autoApproved()) manager.setAutoApprove(id, false);
      deleteAllSessions(db);
      ctx.challenges.clear();
      ctx.ws.closeAll(4401);
      await manager.stopAll();
      ctx.audit('killswitch', actor, { source });
      void ctx.notify('Kill switch', `All agents stopped, sessions revoked, remote access off (${source}).`);
    },
  };

  manager.events.on('auto-approved', ({ id, title, detail }) =>
    ctx.audit('auto_approved', null, { agentId: id, title, detail: String(detail).slice(0, 2000) }),
  );

  app.addHook('onRequest', async (req, reply) => {
    const scope = scopeOf(config, req.raw);
    if (!scope) return reply.code(404).send({ error: 'not_found' });
    if (scope.name === 'remote') {
      // Checked on every request, so the switch (or the CLI) takes effect immediately.
      if (!isRemoteEnabled(db)) return reply.code(503).send({ error: 'remote_disabled' });
      if (!tailnetUserAllowed(config, req.headers)) return reply.code(403).send({ error: 'forbidden' });
    }
    if (!hostAllowed(scope, req.headers.host)) return reply.code(421).send({ error: 'bad_host' });
    if (req.method === 'GET' || req.method === 'HEAD') return;
    // Three independent CSRF checks: exact Origin, Fetch Metadata, and a non-simple content type.
    if (!originAllowed(scope, req.headers.origin)) return reply.code(403).send({ error: 'bad_origin' });
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin') return reply.code(403).send({ error: 'bad_origin' });
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
      return reply.code(415).send({ error: 'bad_content_type' });
    }
  });

  app.addHook('onSend', async (req, reply, payload) => {
    const scope = scopeOf(config, req.raw) ?? config.scopes.local;
    if (!reply.hasHeader('content-security-policy'))
      reply.header('content-security-policy', csp(scope.origin, null));
    reply.header('x-frame-options', 'DENY');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('cross-origin-opener-policy', 'same-origin');
    reply.header('cross-origin-resource-policy', 'same-origin');
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    if (scope.origin.startsWith('https:')) reply.header('strict-transport-security', 'max-age=31536000');
    if (req.url.startsWith('/api/') || !reply.hasHeader('cache-control'))
      reply.header('cache-control', 'no-store');
    return payload;
  });

  app.setErrorHandler((err, req, reply) => {
    const status = /** @type {{ statusCode?: number }} */ (err).statusCode ?? 500;
    if (status >= 500) req.log.error(err);
    // Clients get a code, never internals.
    reply
      .code(status >= 400 && status < 500 ? status : 500)
      .send({ error: status < 500 ? 'bad_request' : 'internal' });
  });

  app.setNotFoundHandler((req, reply) => reply.code(404).send({ error: 'not_found' }));

  // The computer itself needs no sign-in: the local listener is loopback only, and Host and Origin
  // checks keep web pages and DNS rebinding out. Only the remote listener has sessions.
  /** @type {import('fastify').preHandlerAsyncHookHandler} */
  async function requireAccess(req, reply) {
    if (ctx.scope(req).name === 'local') {
      setAuth(req, { local: true });
      return;
    }
    const s = sessionFromCookie(ctx, req.headers.cookie);
    if (!s) return reply.code(401).send({ error: 'unauthorized' });
    touchSession(db, s.hash, now());
    setAuth(req, { local: false, ...s });
  }

  authRoutes(app, ctx, requireAccess);
  apiRoutes(app, ctx, requireAccess);

  if (webRoot) {
    const template = fs.readFileSync(path.join(webRoot, 'index.html'), 'utf8');
    app.get('/', async (req, reply) => {
      const nonce = crypto.randomBytes(16).toString('base64');
      reply.header('content-security-policy', csp(ctx.scope(req).origin, nonce));
      reply.header('cache-control', 'no-store');
      reply.type('text/html; charset=utf-8');
      return template.replaceAll('__CSP_NONCE__', nonce);
    });
    await app.register(fastifyStatic, {
      root: webRoot,
      index: false,
      dotfiles: 'deny',
      allowedPath: (p) => p !== '/index.html',
      setHeaders(reply, file) {
        const immutable = file.includes(`${path.sep}assets${path.sep}`);
        reply.header('cache-control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
  }

  const remoteServer = http.createServer((req, res) => {
    markRemote(req);
    app.routing(req, res);
  });
  const upgrade = attachWs(ctx);
  app.server.on('upgrade', (req, socket, head) => upgrade(req, socket, head, 'local'));
  remoteServer.on('upgrade', (req, socket, head) => upgrade(req, socket, head, 'remote'));
  // Upgraded sockets are invisible to Fastify; without this, close() waits for them forever.
  app.addHook('preClose', async () => {
    ctx.ws.shutdown();
    remoteServer.closeAllConnections();
    await new Promise((resolve) => remoteServer.close(() => resolve(undefined)));
  });
  return { app, ctx, remoteServer };
}
