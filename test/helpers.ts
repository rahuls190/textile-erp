import pg from 'pg';
import { createPool } from '../src/db/pool.js';
import { buildWorld, type World } from '../src/seed/demo.js';

const ADMIN_URL = process.env.PG_ADMIN_URL ?? 'postgres://postgres@localhost:5433/postgres';

/** A fresh, fully-built database per test file. */
export async function freshWorld(name: string): Promise<World> {
  const db = `erp_test_${name}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${db}`);
  await admin.end();
  const pool = createPool(ADMIN_URL.replace(/\/postgres$/, `/${db}`), 20);
  return buildWorld(pool);
}

export async function rejects(p: Promise<unknown>, code: string, status?: number) {
  try { await p; } catch (e) {
    const err = e as { code?: string; status?: number; message?: string };
    if (err.code !== code) throw new Error(`Expected error ${code} but got ${err.code}: ${err.message}`);
    if (status && err.status !== status) throw new Error(`Expected status ${status} got ${err.status}`);
    return err;
  }
  throw new Error(`Expected error ${code} but the command succeeded`);
}
