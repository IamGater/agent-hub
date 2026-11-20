// @ts-check
import { z } from 'zod';
import { actorOf, authOf } from './auth/guard.js';
import { checkAssertion } from './auth/routes.js';
import { issueEnrollCode } from './auth/setup.js';
import { addPasskey, getPasskey, modeOf, removePasskey } from './auth/store.js';
import {
  authenticationOptions,
  authenticationResponse,
  challengeOf,
  registrationOptions,
  registrationResponse,
  verifyRegistration,
} from './auth/webauthn.js';
import { clearCookie } from './auth/cookie.js';
import { listProjects } from './agents/projects.js';
import { readImage } from './agents/images.js';
import { UPLOAD_MAX_BYTES } from './agents/uploads.js';
import { SHUTDOWN_DELAY_S } from './agents/power.js';
import {
  getAutoApprove,
  getOnClose,
  onCloseSchema,
  setAutoApprove as saveAutoApprove,
  setOnClose,
  setRemoteEnabled,
} from './db.js';

const agentId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/);

const action = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('stop'), agentId }),
  z.strictObject({ type: z.literal('restart'), agentId }),
  z.strictObject({ type: z.literal('add-passkey'), name: z.string().trim().min(1).max(40) }),
  z.strictObject({
    type: z.literal('remove-passkey'),
    passkeyId: z.string().regex(/^[A-Za-z0-9_-]{1,1024}$/),
  }),
  z.strictObject({ type: z.literal('remote-on') }),
  z.strictObject({ type: z.literal('auto-approve'), agentId }),
  z.strictObject({ type: z.literal('shutdown') }),
  z.strictObject({ type: z.literal('server-restart') }),
  z.strictObject({ type: z.literal('remote-enroll') }),
]);

/** @typedef {z.infer<typeof action>} Action */

// Opening the computer to the network, or letting a new device in, is only decided at the computer.
const LOCAL_ONLY = new Set(['remote-on', 'remote-enroll']);
// A passkey is created on the device that will use it, which is the phone.
const REMOTE_ONLY = new Set(['add-passkey']);

const startBody = z.strictObject({
  cols: z.int().min(20).max(400).optional(),
  rows: z.int().min(5).max(200).optional(),
  cwd: z.string().min(1).max(1024).optional(),
  resume: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/)
    .optional(),
});

/**
 * @param {import('fastify').FastifyInstance} app
 * @param {import('./app.js').Ctx} ctx
 * @param {import('fastify').preHandlerAsyncHookHandler} requireAccess
 */
export function apiRoutes(app, ctx, requireAccess) {
  const { config, db, manager, challenges } = ctx;
  const stepupMs = config.stepupMinutes * 60_000;

  /** Stores the change and applies it to the running agents. @param {(ids: string[]) => string[]} change */
  function setAutoApprove(change) {
    const ids = change(getAutoApprove(db));
    saveAutoApprove(db, ids);
    for (const a of manager.list()) {
      if (a.type !== 'terminal' && a.autoApprove !== ids.includes(a.id))
        manager.setAutoApprove(a.id, !a.autoApprove);
    }
  }

  /** @param {import('fastify').FastifyRequest} req */
  function inControl(req) {
    const auth = authOf(req);
    return auth.local || modeOf(auth.row, ctx.now(), stepupMs).mode === 'control';
  }

  /**
   * Checks that the action makes sense here and now. Returns an error code or null.
   * @param {Action} a
   * @param {boolean} local
   */
  function refuse(a, local) {
    if ((a.type === 'stop' || a.type === 'restart') && !manager.has(a.agentId)) return 'bad_request';
    if (a.type === 'auto-approve' && (!manager.has(a.agentId) || manager.info(a.agentId).type === 'terminal'))
      return 'bad_request';
    if (a.type === 'remove-passkey' && !getPasskey(db, a.passkeyId)) return 'bad_request';
    if (LOCAL_ONLY.has(a.type)) {
      if (!local) return 'local_only';
      if (!config.scopes.remote) return 'remote_not_configured';
    }
    if (REMOTE_ONLY.has(a.type) && local) return 'remote_only';
    return null;
  }

  /**
   * @param {Action} a
   * @param {import('fastify').FastifyRequest} req
   * @param {import('fastify').FastifyReply} reply
   * @param {import('./audit/log.js').Actor} actor
   */
  async function perform(a, req, reply, actor) {
    const auth = authOf(req);
    switch (a.type) {
      case 'stop':
        await manager.stop(a.agentId);
        ctx.audit('agent_stop', actor, { agentId: a.agentId });
        return { ok: true };
      case 'restart':
        await manager.restart(a.agentId);
        ctx.audit('agent_restart', actor, { agentId: a.agentId });
        return { ok: true };
      case 'remove-passkey': {
        removePasskey(db, a.passkeyId);
        ctx.audit('passkey_removed', actor, { removed: a.passkeyId });
        const self = !auth.local && a.passkeyId === auth.row.passkey_id;
        if (self) reply.header('set-cookie', clearCookie());
        return { ok: true, loggedOut: self };
      }
      case 'add-passkey': {
        if (auth.local) return reply.code(403).send({ error: 'remote_only' });
        const options = await registrationOptions(config.rpName, ctx.scope(req), db);
        challenges.add(options.challenge, 'register', { sid: auth.hash, action: a });
        return { registration: options };
      }
      case 'auto-approve': {
        setAutoApprove((ids) => [...new Set([...ids, a.agentId])]);
        ctx.audit('permissions', actor, { agentId: a.agentId, mode: 'auto' });
        void ctx.notify('Agent permissions', `${manager.info(a.agentId).name} now acts without asking.`);
        return manager.info(a.agentId);
      }
      case 'shutdown':
        await ctx.power.shutdown();
        ctx.audit('shutdown', actor, { delaySeconds: SHUTDOWN_DELAY_S });
        void ctx.notify('Shutdown', `The computer turns off in ${SHUTDOWN_DELAY_S} seconds.`);
        return { ok: true, delaySeconds: SHUTDOWN_DELAY_S };
      case 'server-restart':
        // Stops the agents like closing does, then starts a fresh copy (new code, agents.json).
        if (!ctx.restartServer) return reply.code(501).send({ error: 'not_supported' });
        ctx.audit('server_restart', actor);
        ctx.restartServer();
        return { ok: true };
      case 'remote-on':
        setRemoteEnabled(db, true);
        ctx.audit('remote_on', actor, { source: 'web' });
        void ctx.notify('Remote access on', 'Remote access was turned on from the computer.');
        return { ok: true };
      case 'remote-enroll':
        ctx.audit('enroll_code', actor);
        return { code: issueEnrollCode(db, ctx.now()) };
    }
  }

  app.get('/api/agents', { preHandler: requireAccess }, async () => manager.list());

  app.get('/api/projects', { preHandler: requireAccess }, async () => listProjects(config.allowedRoots));

  // Taking the permission back is always safe, so it needs no passkey; giving it is an action.
  app.post('/api/agents/:id/permissions/ask', { preHandler: requireAccess }, async (req, reply) => {
    const id = agentId.safeParse(/** @type {{ id?: string }} */ (req.params).id);
    if (!id.success || !manager.has(id.data) || manager.info(id.data).type === 'terminal')
      return reply.code(400).send({ error: 'bad_request' });
    if (!inControl(req)) return reply.code(403).send({ error: 'view_mode' });
    setAutoApprove((ids) => ids.filter((i) => i !== id.data));
    ctx.audit('permissions', actorOf(req), { agentId: id.data, mode: 'ask' });
    return manager.info(id.data);
  });

  // Plan limits: asking starts the agent's program for a moment (control mode, like listing sessions);
  // what a running agent reported about itself (model, context) is part of the agent list already.
  app.get('/api/agents/:id/usage', { preHandler: requireAccess }, async (req, reply) => {
    const id = agentId.safeParse(/** @type {{ id?: string }} */ (req.params).id);
    if (!id.success || !manager.has(id.data)) return reply.code(400).send({ error: 'bad_request' });
    const query = /** @type {{ fresh?: string, cached?: string }} */ (req.query);
    // The last known limits start nothing, so any access may read them.
    if (query.cached === '1') {
      const hit = manager.cachedUsage(id.data);
      return { account: hit?.account ?? null, at: hit?.at ?? null };
    }
    if (!inControl(req)) return reply.code(403).send({ error: 'view_mode' });
    try {
      const account = await manager.usage(id.data, query.fresh === '1');
      return { account, at: manager.cachedUsage(id.data)?.at ?? null };
    } catch (err) {
      req.log.warn({ err: /** @type {Error} */ (err).message }, 'usage failed');
      return reply.code(502).send({ error: 'usage_failed' });
    }
  });

  // Listing runs the agent binary briefly (Codex and Antigravity are asked over their protocol),
  // so it needs control mode like starting does.
  app.get('/api/agents/:id/sessions', { preHandler: requireAccess }, async (req, reply) => {
    const id = agentId.safeParse(/** @type {{ id?: string }} */ (req.params).id);
    const cwd = z
      .string()
      .min(1)
      .max(1024)
      .safeParse(/** @type {{ cwd?: string }} */ (req.query).cwd);
    if (!id.success || !cwd.success || !manager.has(id.data))
      return reply.code(400).send({ error: 'bad_request' });
    if (!inControl(req)) return reply.code(403).send({ error: 'view_mode' });
    try {
      return await manager.sessions(id.data, cwd.data);
    } catch (err) {
      req.log.warn({ err: /** @type {Error} */ (err).message }, 'session list failed');
      return reply.code(502).send({ error: 'sessions_failed' });
    }
  });

  // A picture pasted into the message box: stored, and sent with the next message by its id.
  app.post(
    '/api/agents/:id/uploads',
    { preHandler: requireAccess, bodyLimit: UPLOAD_MAX_BYTES },
    async (req, reply) => {
      const id = agentId.safeParse(/** @type {{ id?: string }} */ (req.params).id);
      if (!id.success || !manager.has(id.data) || manager.info(id.data).type === 'terminal')
        return reply.code(400).send({ error: 'bad_request' });
      if (!inControl(req)) return reply.code(403).send({ error: 'view_mode' });
      const upload = Buffer.isBuffer(req.body) ? ctx.uploads.save(req.body) : null;
      if (!upload) return reply.code(400).send({ error: 'bad_image' });
      return { id: upload.id };
    },
  );

  // Images the agent touched, by the opaque id the manager gave them; never by path.
  app.get('/api/agents/:id/images/:image', { preHandler: requireAccess }, async (req, reply) => {
    const params = /** @type {{ id?: string, image?: string }} */ (req.params);
    const id = agentId.safeParse(params.id);
    const image = z
      .string()
      .regex(/^[0-9a-f]{24}$/)
      .safeParse(params.image);
    if (!id.success || !image.success || !manager.has(id.data))
      return reply.code(404).send({ error: 'not_found' });
    const ref = manager.image(id.data, image.data);
    const found = ref ? readImage(ref.file, ref.ran ? null : config.allowedRoots) : null;
    if (!found) return reply.code(404).send({ error: 'not_found' });
    return reply
      .header('content-type', found.mime)
      .header('cache-control', 'private, no-store')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .header('content-disposition', 'inline')
      .send(found.data);
  });

  // Starting only runs a command from agents.json, but it still executes code, so it needs control mode.
  app.post('/api/agents/:id/start', { preHandler: requireAccess }, async (req, reply) => {
    const id = agentId.safeParse(/** @type {{ id?: string }} */ (req.params).id);
    const body = startBody.safeParse(req.body ?? {});
    if (!id.success || !body.success || !manager.has(id.data))
      return reply.code(400).send({ error: 'bad_request' });
    if (!inControl(req)) return reply.code(403).send({ error: 'view_mode' });
    if (manager.info(id.data).pid !== null) return reply.code(409).send({ error: 'already_running' });
    try {
      manager.start(id.data, body.data);
    } catch (err) {
      // A folder outside the allowed roots (or gone) is the client's mistake, not a server error.
      req.log.warn({ err: /** @type {Error} */ (err).message }, 'agent start refused');
      return reply.code(400).send({ error: 'bad_workdir' });
    }
    const info = manager.info(id.data);
    ctx.audit('agent_start', actorOf(req), {
      agentId: id.data,
      cwd: info.cwd,
      ...(body.data.resume ? { resume: body.data.resume } : {}),
    });
    return info;
  });

  // At the computer an action runs right away: the owner is sitting there.
  app.post('/api/action/run', { preHandler: requireAccess }, async (req, reply) => {
    if (!authOf(req).local) return reply.code(403).send({ error: 'local_only' });
    const parsed = z.strictObject({ action }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request' });
    const error = refuse(parsed.data.action, true);
    if (error) return reply.code(error === 'bad_request' ? 400 : 403).send({ error });
    return perform(parsed.data.action, req, reply, actorOf(req));
  });

  // From the phone, dangerous actions need a passkey check minted for that one action and consumed
  // by it, so a check is never reused for anything else and nothing is cached.
  app.post('/api/action/options', { preHandler: requireAccess }, async (req, reply) => {
    const auth = authOf(req);
    if (auth.local) return reply.code(403).send({ error: 'remote_only' });
    const wait = ctx.limiter.blocked(req.ip);
    if (wait) return reply.code(429).send({ error: 'locked' });
    const parsed = z.strictObject({ action }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request' });
    const error = refuse(parsed.data.action, false);
    if (error) return reply.code(error === 'bad_request' ? 400 : 403).send({ error });
    const options = await authenticationOptions(ctx.scope(req), db, false);
    challenges.add(options.challenge, 'action', { sid: auth.hash, action: parsed.data.action });
    return options;
  });

  app.post('/api/action/verify', { preHandler: requireAccess }, async (req, reply) => {
    const auth = authOf(req);
    if (auth.local) return reply.code(403).send({ error: 'remote_only' });
    const wait = ctx.limiter.blocked(req.ip);
    if (wait) return reply.code(429).send({ error: 'locked' });
    const body = z.strictObject({ response: authenticationResponse }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'bad_request' });
    const result = await checkAssertion(ctx, req, body.data.response, 'action', auth.hash);
    if (!result) {
      ctx.audit('action_failed', actorOf(req));
      return reply.code(401).send({ error: 'verification_failed' });
    }
    const a = /** @type {Action} */ (result.entry.action);
    return perform(a, req, reply, { ...actorOf(req), passkeyId: result.passkeyId });
  });

  app.post('/api/passkeys/verify', { preHandler: requireAccess }, async (req, reply) => {
    const auth = authOf(req);
    if (auth.local) return reply.code(403).send({ error: 'remote_only' });
    const scope = ctx.scope(req);
    const body = z.strictObject({ response: registrationResponse }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'bad_request' });
    const challenge = challengeOf(body.data.response);
    const entry = challenge ? challenges.take(challenge, 'register', auth.hash) : null;
    if (!entry || !challenge) return reply.code(400).send({ error: 'bad_challenge' });
    let cred = null;
    try {
      cred = await verifyRegistration(scope, body.data.response, challenge);
    } catch (err) {
      req.log.warn({ err: /** @type {Error} */ (err).message }, 'registration rejected');
    }
    if (!cred) return reply.code(400).send({ error: 'verification_failed' });
    const name = /** @type {{ name: string }} */ (entry.action).name;
    addPasskey(db, cred, { name, rpID: scope.rpID, now: ctx.now() });
    ctx.audit('passkey_added', actorOf(req), { added: cred.id, name });
    void ctx.notify('Passkey added', `A new passkey "${name}" was registered.`);
    return { ok: true };
  });

  // Turning remote access off only moves toward safety, so any access is enough, from either side.
  app.post('/api/remote/off', { preHandler: requireAccess }, async (req) => {
    ctx.remoteOff(actorOf(req), authOf(req).local ? 'web-local' : 'web-remote');
    return { ok: true };
  });

  // What closing the app window does. It is about the window on this computer, so only the
  // computer changes it; the phone can see it.
  app.get('/api/settings/on-close', { preHandler: requireAccess }, async () => getOnClose(db));
  app.post('/api/settings/on-close', { preHandler: requireAccess }, async (req, reply) => {
    if (!authOf(req).local) return reply.code(403).send({ error: 'local_only' });
    const parsed = onCloseSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request' });
    setOnClose(db, parsed.data);
    ctx.audit('settings_on_close', actorOf(req), parsed.data);
    return getOnClose(db);
  });

  // Kill switch only needs access: it moves things toward safety, and it must work fast for an
  // owner who is looking at something going wrong.
  // Stopping a scheduled shutdown can only make things safer, so it needs no passkey.
  app.post('/api/power/cancel', { preHandler: requireAccess }, async (req) => {
    const cancelled = await ctx.power.cancel().catch(() => false);
    if (cancelled) {
      ctx.audit('shutdown_cancel', actorOf(req));
      void ctx.notify('Shutdown cancelled', 'The computer stays on.');
    }
    return { cancelled };
  });

  app.post('/api/killall', { preHandler: requireAccess }, async (req, reply) => {
    await ctx.killAll(actorOf(req), authOf(req).local ? 'web-local' : 'web-remote');
    if (!authOf(req).local) reply.header('set-cookie', clearCookie());
    return { ok: true };
  });
}
