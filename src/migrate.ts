import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool, type Pool } from './db/pool.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'db', 'migrations');

export async function migrate(pool: Pool): Promise<string[]> {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migration (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const done = new Set((await pool.query('SELECT name FROM schema_migration')).rows.map((r) => r.name));
  const applied: string[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(f)) continue;
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(readFileSync(join(dir, f), 'utf8'));
      await c.query('INSERT INTO schema_migration(name) VALUES ($1)', [f]);
      await c.query('COMMIT');
      applied.push(f);
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }
  return applied;
}

if (process.argv[1] && process.argv[1].endsWith('migrate.ts')) {
  const pool = createPool();
  migrate(pool).then((a) => { console.log('applied:', a.length ? a.join(', ') : 'nothing (up to date)'); return pool.end(); });
}
