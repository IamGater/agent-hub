// @ts-check
import { z } from 'zod';
import { clearCookie, sessionCookie } from './cookie.js';
import { actorOf, authOf, sessionFromCookie } from './guard.js';
import { consumeEnrollCode } from './setup.js';
import {
  addPasskey,
  countPasskeys,
  createSession,
  deleteSession,
  listPasskeys,
  modeOf,
  stepUp,
} from './store.js';
import {
  authenticationOptions,
  authenticationResponse,
  challengeOf,
  registrationOptions,
  registrationResponse,
  verifyAssertion,
  verifyRegistration,
} from './webauthn.js';
import { isRemoteEnabled } from '../db.js';

const codeBody = z.strictObject({ token: z.string().min(1).max(64) });
const registerBody = z.strictObject({
  response: registrationResponse,
  name: z.string().trim().max(40).optional(),
});
const assertionBody = z.strictObject({ response: authenticationResponse });

/**
 * Runs an assertion check against a challenge of the given purpose. Any failure counts toward
 * the lockout, so step-up and dangerous actions cannot be used to brute force either.
 * @param {import('../app.js').Ctx} ctx
 * @param {import('fastify').FastifyRequest} req
 * @param {z.infer<typeof authenticationResponse>} response
 * @param {import('./challenges.js').Purpose} purpose
 * @param {string | null} sid
 * @returns {Promise<{ passkeyId: string, entry: import('./challenges.js').Entry } | null>}
 */
export async function checkAssertion(ctx, req, response, purpose, sid) {
  const challenge = challengeOf(response);
  const entry = challenge ? ctx.challenges.take(challenge, purpose, sid) : null;
  let passkeyId = null;
  if (entry && challenge) {
    try {
      passkeyId = await verifyAssertion(ctx.scope(req), ctx.db, response, challenge, ctx.now());
    } catch (err) {
      req.log.warn({ err: /** @type {Error} */ (err).message }, 'assertion rejected');
    }
  }
  if (!entry || !passkeyId) {
    if (ctx.limiter.fail(req.ip)) {
      ctx.audit('lockout', actorOf(req), { purpose });
      void ctx.notify('Login lockout', 'Too many failed passkey attempts. Sign-in is locked for 15 minutes.');
    }
    return null;
  }
  ctx.limiter.succeed(req.ip);
  return { passkeyId, entry };
}

/**
 * Sign-in routes. They exist for the phone only: the computer itself needs no sign-in.
 * @param {import('fastify').FastifyInstance} app
 * @param {import('../app.js').Ctx} ctx
 * @param {import('fastify').preHandlerAsyncHookHandler} requireAccess
 */
export function authRoutes(app, ctx, requireAccess) {
  const { config, db, challenges, limiter } = ctx;
  const stepupMs = config.stepupMinutes * 60_000;
  const maxAge = config.sessionHours * 3600;

  /** @param {import('fastify').FastifyReply} reply @param {number} waitMs */
  function tooMany(reply, waitMs) {
    reply.header('retry-after', String(Math.ceil(waitMs / 1000)));
    return reply.code(429).send({ error: 'locked' });
  }

  /** @param {import('fastify').FastifyRequest} req @param {import('fastify').FastifyReply} reply */
  function remoteOnly(req, reply) {
    if (ctx.scope(req).name === 'remote') return false;
    reply.code(403).send({ error: 'remote_only' });
    return true;
  }

  /**
   * @param {import('fastify').FastifyRequest} req
   * @param {import('fastify').FastifyReply} reply
   * @param {string} passkeyId
   */
  function openSession(req, reply, passkeyId) {
    const { token } = createSession(db, {
      passkeyId,
      ip: req.ip,
      ua: String(req.headers['user-agent'] ?? ''),
      now: ctx.now(),
    });
    reply.header('set-cookie', sessionCookie(token, maxAge));
  }

  app.get('/api/state', async (req) => {
    const scope = ctx.scope(req);
    const remote = {
      configured: config.scopes.remote !== null,
      enabled: isRemoteEnabled(db),
      origin: config.scopes.remote?.origin ?? null,
    };
    if (scope.name === 'local') {
      return {
        scope: 'local',
        authenticated: true,
        mode: 'control',
        remainingMs: null,
        passkeys: countPasskeys(db),
        remote,
      };
    }
    const s = sessionFromCookie(ctx, req.headers.cookie);
    if (!s) return { scope: 'remote', authenticated: false };
    const { mode, until } = modeOf(s.row, ctx.now(), stepupMs);
    return {
      scope: 'remote',
      authenticated: true,
      mode,
      remainingMs: until === null ? 0 : until - ctx.now(),
      passkeys: countPasskeys(db),
      remote,
    };
  });

  // The phone joins with a one-time code shown on the computer. Its passkey is bound to the remote
  // origin; the code is consumed before the ceremony, so a leaked code is good for one try at most.
  app.post('/api/enroll/options', async (req, reply) => {
    if (remoteOnly(req, reply)) return reply;
    const wait = limiter.blocked(req.ip);
    if (wait) return tooMany(reply, wait);
    const body = codeBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'bad_request' });
    if (!consumeEnrollCode(db, body.data.token, ctx.now())) {
      if (limiter.fail(req.ip)) ctx.audit('lockout', actorOf(req), { purpose: 'enroll' });
      ctx.audit('enroll_failed', actorOf(req));
      return reply.code(403).send({ error: 'bad_token' });
    }
    const options = await registrationOptions(config.rpName, ctx.scope(req), db);
    challenges.add(options.challenge, 'enroll');
    return options;
  });

  app.post('/api/enroll/verify', async (req, reply) => {
    if (remoteOnly(req, reply)) return reply;
    const scope = ctx.scope(req);
    const body = registerBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'bad_request' });
    const challenge = challengeOf(body.data.response);
    if (!challenge || !challenges.take(challenge, 'enroll'))
      return reply.code(400).send({ error: 'bad_challenge' });
    let cred = null;
    try {
      cred = await verifyRegistration(scope, body.data.response, challenge);
    } catch (err) {
      req.log.warn({ err: /** @type {Error} */ (err).message }, 'registration rejected');
    }
    if (!cred) {
      ctx.audit('enroll_failed', actorOf(req));
      return reply.code(400).send({ error: 'verification_failed' });
    }
    const name = body.data.name || 'Телефон';
    addPasskey(db, cred, { name, rpID: scope.rpID, now: ctx.now() });
    openSession(req, reply, cred.id);
    ctx.audit('passkey_added', { ...actorOf(req), passkeyId: cred.id }, { added: cred.id, name });
    void ctx.notify('Device added', `A passkey "${name}" was registered from ${req.ip}.`);
    return { ok: true };
  });

  app.post('/api/login/options', async (req, reply) => {
    if (remoteOnly(req, reply)) return reply;
    const wait = limiter.blocked(req.ip);
    if (wait) return tooMany(reply, wait);
    if (!ctx.budget(`login:${req.ip}`)) return reply.code(429).send({ error: 'slow_down' });
    const options = await authenticationOptions(ctx.scope(req), db, true);
    challenges.add(options.challenge, 'login');
    return options;
  });

  app.post('/api/login/verify', async (req, reply) => {
    if (remoteOnly(req, reply)) return reply;
    const wait = limiter.blocked(req.ip);
    if (wait) return tooMany(reply, wait);
    const body = assertionBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'bad_request' });
    const result = await checkAssertion(ctx, req, body.data.response, 'login', null);
    if (!result) {
      ctx.audit('login_failed', actorOf(req));
      return reply.code(401).send({ error: 'login_failed' });
    }
    openSession(req, reply, result.passkeyId);
    ctx.audit('login', { ...actorOf(req), passkeyId: result.passkeyId });
    void ctx.notify('New login', `Passkey ${result.passkeyId.slice(0, 8)} signed in from ${req.ip}.`);
    return { ok: true };
  });

  app.post('/api/logout', { preHandler: requireAccess }, async (req, reply) => {
    const auth = authOf(req);
    if (auth.local) return reply.code(403).send({ error: 'remote_only' });
    deleteSession(db, auth.hash);
    challenges.dropSession(auth.hash);
    ctx.ws.closeSession(auth.hash);
    ctx.audit('logout', actorOf(req));
    reply.header('set-cookie', clearCookie());
    return { ok: true };
  });

  app.post('/api/stepup/options', { preHandler: requireAccess }, async (req, reply) => {
    const auth = authOf(req);
    if (auth.local) return reply.code(403).send({ error: 'remote_only' });
    const wait = limiter.blocked(req.ip);
    if (wait) return tooMany(reply, wait);
    const options = await authenticationOptions(ctx.scope(req), db, false);
    challenges.add(options.challenge, 'stepup', { sid: auth.hash });
    return options;
  });

  app.post('/api/stepup/verify', { preHandler: requireAccess }, async (req, reply) => {
    const auth = authOf(req);
    if (auth.local) return reply.code(403).send({ error: 'remote_only' });
    const wait = limiter.blocked(req.ip);
    if (wait) return tooMany(reply, wait);
    const body = assertionBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'bad_request' });
    const result = await checkAssertion(ctx, req, body.data.response, 'stepup', auth.hash);
    if (!result) {
      ctx.audit('stepup_failed', actorOf(req));
      return reply.code(401).send({ error: 'stepup_failed' });
    }
    stepUp(db, auth.hash, ctx.now());
    ctx.audit('stepup', { ...actorOf(req), passkeyId: result.passkeyId });
    return { mode: 'control', remainingMs: stepupMs };
  });

  app.get('/api/passkeys', { preHandler: requireAccess }, async (req) => {
    const auth = authOf(req);
    return listPasskeys(db).map((p) => ({
      id: p.id,
      name: p.name,
      createdAt: p.created_at,
      lastUsedAt: p.last_used_at,
      current: !auth.local && p.id === auth.row.passkey_id,
    }));
  });
}
