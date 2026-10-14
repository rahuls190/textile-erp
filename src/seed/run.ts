import { createPool } from '../db/pool.js';
import { buildWorld } from './demo.js';

// Development only: builds a demo company through the real, permission-checked commands.
const password = process.env.SEED_PASSWORD ?? 'Demo-Passw0rd!';
const pool = createPool();
buildWorld(pool, password)
  .then((w) => {
    console.log('Demo world created. Users (all share the SEED_PASSWORD):');
    console.log(Object.keys(w.actors).join(', '));
    console.log('Site id:', w.siteId);
    return pool.end();
  })
  .catch((e) => { console.error(e.message); process.exit(1); });
