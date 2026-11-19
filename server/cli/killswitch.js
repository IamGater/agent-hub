// Emergency stop from the computer itself. Works even if the server is hung: it kills recorded
// agent process trees directly and revokes sessions in the database, which the server checks
// on every request and WebSocket message.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config/load.js';
import { openDb, setAutoApprove, setRemoteEnabled } from '../db.js';
import { killRecorded } from '../agents/pids.js';
import { deleteAllSessions } from '../auth/store.js';
import { audit } from '../audit/log.js';
import { createNotifier } from '../audit/notify.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const config = loadConfig(process.argv[2] ?? path.join(root, 'config.json'));
const db = openDb(config.dataDir);

setRemoteEnabled(db, false);
setAutoApprove(db, []);
const killed = killRecorded(db);
const revoked = deleteAllSessions(db);
audit(db, 'killswitch', { ip: 'local', ua: 'cli' }, { source: 'cli', killed });
db.close();

console.log(`Agents killed: ${killed.length ? killed.join(', ') : 'none running'}`);
console.log(`Web sessions revoked: ${revoked}`);
console.log('Remote access: off');
console.log('Agent permissions: every agent asks again');
await createNotifier(config.ntfy, console)('Kill switch', 'Triggered from the computer.');
