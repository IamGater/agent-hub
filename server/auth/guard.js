// @ts-check
import { readSessionCookie } from './cookie.js';
import { findSession } from './store.js';
import { sha256 } from './tokens.js';

/**
 * @typedef {{
 *   config: import('../config/load.js').RuntimeConfig,
 *   db: import('better-sqlite3').Database,
 *   now: () => number,
 * }} GuardCtx
 * @typedef {import('../config/load.js').Scope} Scope
 */

// Requests that arrived on the remote listener. The scope comes from which socket the request
// used, never from a header, so a client cannot claim to be local.
const remoteRequests = new WeakSet();

/** @param {object} raw the Node request object */
export function markRemote(raw) {
  remoteRequests.add(raw);
}

/**
 * @param {GuardCtx['config']} config
 * @param {object} raw the Node request object
 * @returns {Scope | null} null for the remote listener when remote access is not configured
 */
export function scopeOf(config, raw) {
  return remoteRequests.has(raw) ? config.scopes.remote : config.scopes.local;
}

/** @param {Scope} scope @param {string | undefined} host */
export function hostAllowed(scope, host) {
  return typeof host === 'string' && scope.hosts.includes(host.toLowerCase());
}

/**
 * Exact match only: no suffix matching, no "null", no missing header.
 * @param {Scope} scope
 * @param {string | undefined} origin
 */
export function originAllowed(scope, origin) {
  return origin === scope.origin;
}

/**
 * Optional extra layer: tailscale serve adds Tailscale-User-Login for tailnet users and strips
 * any value the client sent. When configured, requests from other tailnet identities stop here.
 * @param {GuardCtx['config']} config
 * @param {Record<string, string | string[] | undefined>} headers
 */
export function tailnetUserAllowed(config, headers) {
  if (!config.tailscaleUser) return true;
  return headers['tailscale-user-login'] === config.tailscaleUser;
}

/**
 * Sessions exist only on the remote listener; the computer itself needs none.
 * @param {GuardCtx} ctx
 * @param {string | undefined} cookieHeader
 */
export function sessionFromCookie(ctx, cookieHeader) {
  const token = readSessionCookie(cookieHeader);
  if (!token) return null;
  const hash = sha256(token);
  const row = findSession(ctx.db, hash, {
    now: ctx.now(),
    absoluteMs: ctx.config.sessionHours * 3600_000,
    idleMs: ctx.config.idleMinutes * 60_000,
  });
  return row ? { hash, row } : null;
}

/**
 * Who is acting: the owner at the computer (local listener, no session), or a remote session.
 * @typedef {{ local: true } | { local: false, hash: string, row: import('./store.js').SessionRow }} Access
 */

/** @type {WeakMap<object, Access>} */
const authed = new WeakMap();

/** @param {object} req @param {Access} access */
export function setAuth(req, access) {
  authed.set(req, access);
}

/** @param {object} req @returns {Access} */
export function authOf(req) {
  const s = authed.get(req);
  if (!s) throw new Error('route is missing requireAccess');
  return s;
}

/** @param {import('fastify').FastifyRequest} req */
export function actorOf(req) {
  const a = authed.get(req);
  return {
    passkeyId: a && !a.local ? a.row.passkey_id : null,
    ip: req.ip,
    ua: String(req.headers['user-agent'] ?? '').slice(0, 256),
  };
}
