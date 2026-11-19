// Local recovery. Runs only on the computer itself: it needs direct access to the database file.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config/load.js';
import { openDb } from '../db.js';
import { resetAuth } from '../auth/setup.js';
import { audit } from '../audit/log.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const config = loadConfig(process.argv[2] ?? path.join(root, 'config.json'));
const db = openDb(config.dataDir);

resetAuth(db);
audit(db, 'reset_auth', { ip: 'local', ua: 'cli' });
db.close();

console.log('All phone passkeys and sessions were removed. Remote access is off.');
console.log(`Connect the phone again from ${config.scopes.local.origin} (Passkeys).`);
