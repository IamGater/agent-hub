import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { loadAgents, loadConfig } from './config/load.js';
import {
  getAutoApprove,
  getLastFolders,
  getModels,
  getOnClose,
  isRemoteEnabled,
  openDb,
  setLastFolder,
  setModel,
} from './db.js';
import { createManager } from './sessions/manager.js';
import { createNotifier } from './audit/notify.js';
import { audit } from './audit/log.js';
import { forgetPid, killRecorded, recordPid } from './agents/pids.js';
import { createAutoClose } from './agents/autoclose.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configFile = process.argv[2] ?? path.join(root, 'config.json');

const config = loadConfig(configFile);
const agents = loadAgents(config);
const db = openDb(config.dataDir);

const leftovers = killRecorded(db);
if (leftovers.length) console.warn(`killed leftover agents from a previous run: ${leftovers.join(', ')}`);

const manager = createManager({
  agents,
  config,
  autoApprove: getAutoApprove(db),
  stillAutoApproved: (id) => getAutoApprove(db).includes(id),
  lastFolders: getLastFolders(db),
  onFolder: (id, cwd) => setLastFolder(db, id, cwd),
  savedModels: getModels(db),
  onModel: (id, model) => setModel(db, id, model),
});
const webRoot = path.join(root, 'web', 'dist');
const hasWeb = fs.existsSync(path.join(webRoot, 'index.html'));
if (!hasWeb) console.warn('web/dist not found, run "npm run build" first; serving API only');

const { app, ctx, remoteServer } = await createApp({
  config,
  db,
  manager,
  webRoot: hasWeb ? webRoot : null,
  notify: createNotifier(config.ntfy, console),
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
});

manager.events.on('spawn', ({ id, pid, startedAt }) => recordPid(db, id, pid, startedAt));
manager.events.on('exit', ({ id, exitCode }) => {
  forgetPid(db, id);
  audit(db, 'agent_exit', null, { agentId: id, exitCode });
  void ctx.notify('Agent finished', `${id} exited with code ${exitCode}.`);
});
manager.events.on(
  'waiting',
  ({ id }) => void ctx.notify('Agent is waiting', `${id} is asking for confirmation.`),
);
manager.events.on('warn', ({ id, message }) => app.log.warn({ agentId: id }, message));

// Both listeners are loopback only. The remote one is reached through tailscale serve; whether it
// answers is decided per request by the remote access switch.
await app.listen({ host: '127.0.0.1', port: config.port });
console.log(`Local UI: ${config.scopes.local.origin}`);
if (config.scopes.remote) {
  await new Promise((resolve, reject) => {
    remoteServer.once('error', reject);
    remoteServer.listen(config.remotePort, '127.0.0.1', () => resolve(undefined));
  });
  const state = isRemoteEnabled(db) ? 'ON' : 'off';
  console.log(
    `Remote: ${config.scopes.remote.origin} -> 127.0.0.1:${config.remotePort} (remote access ${state})`,
  );
}

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await manager.stopAll();
  await app.close();
  db.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// What closing the app window does is the owner's choice (Settings), see agents/autoclose.js.
const autoClose = createAutoClose({
  manager,
  settings: () => getOnClose(db),
  remoteOn: () => isRemoteEnabled(db),
  onExit: shutdown,
  log: { info: (msg) => app.log.info(msg) },
});
ctx.onLocalWindows = (n) => autoClose.windows(n);
