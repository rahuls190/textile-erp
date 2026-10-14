// Build step: seed the demo company once, here, and ship it as a ready-made database snapshot.
// Everything that depends on today's date (attendance, leave) is added when the page first opens, so it is never stale.
import { writeFileSync, mkdirSync } from 'node:fs';
import { LitePool } from './lite-pool.js';
import { buildWorld } from '../src/seed/demo.js';
import { hashPassword } from './shims/password.js';

const PASSWORD = 'Demo-Passw0rd!';
const pool = await LitePool.create();
const w = await buildWorld(pool as never, PASSWORD, { recent: false });
// The server hashes with scrypt; the browser demo signs in with WebCrypto, so store hashes it can verify.
for (const u of (await pool.query('SELECT id FROM app_user')).rows)
  await pool.query('UPDATE app_user SET password_hash=$2 WHERE id=$1', [u.id, await hashPassword(PASSWORD)]);
await pool.query('CHECKPOINT');
const blob = await pool.db.dumpDataDir('gzip');
mkdirSync('ui/out/engine', { recursive: true });
writeFileSync('ui/out/engine/demo-seed.ogg', Buffer.from(await blob.arrayBuffer()));
console.log('snapshot', ((blob.size) / 1048576).toFixed(1), 'MB;', Object.keys(w.actors).length, 'users');
await pool.db.close();
