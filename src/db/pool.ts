import pg from 'pg';

// Return NUMERIC as exact strings. Never let it become a JS float.
pg.types.setTypeParser(1700, (v) => v);
pg.types.setTypeParser(20, (v) => v);   // bigint
pg.types.setTypeParser(1082, (v) => v); // DATE stays 'YYYY-MM-DD' (no JS Date, no timezone drift)

export const DEFAULT_URL = 'postgres://postgres@localhost:5433/erp';

export function createPool(url = process.env.DATABASE_URL ?? DEFAULT_URL, max = 10): pg.Pool {
  return new pg.Pool({ connectionString: url, max });
}
export type Pool = pg.Pool;
export type Db = pg.PoolClient;
