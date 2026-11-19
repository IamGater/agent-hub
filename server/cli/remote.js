// Remote access switch from the computer itself: npm run remote -- on | off | status.
// It writes the database directly; the running server checks the switch on every request.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config/load.js';
import { isRemoteEnabled, openDb, setRemoteEnabled } from '../db.js';
import { audit } from '../audit/log.js';
import { createNotifier } from '../audit/notify.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [cmd = 'status', file] = process.argv.slice(2);
if (!['on', 'off', 'status'].includes(cmd)) {
  console.error('Usage: npm run remote -- on | off | status');
  process.exit(2);
}
const config = loadConfig(file ?? path.join(root, 'config.json'));
if (cmd === 'on' && !config.scopes.remote) {
  console.error('Set "origin" in config.json (https://<name>.<tailnet>.ts.net) first.');
  process.exit(1);
}
const db = openDb(config.dataDir);

if (cmd !== 'status') {
  const revoked = setRemoteEnabled(db, cmd === 'on');
  audit(
    db,
    cmd === 'on' ? 'remote_on' : 'remote_off',
    { ip: 'local', ua: 'cli' },
    { source: 'cli', revoked },
  );
}
const on = isRemoteEnabled(db);
db.close();

console.log(
  `Remote access: ${on ? 'ON' : 'off'}${config.scopes.remote ? ` (${config.scopes.remote.origin})` : ''}`,
);
if (cmd !== 'status') {
  await createNotifier(config.ntfy, console)(
    on ? 'Remote access on' : 'Remote access off',
    `Remote access was turned ${on ? 'on' : 'off'} from the computer.`,
  );
}
