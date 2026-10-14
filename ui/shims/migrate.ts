import sql from '../../src/db/migrations/001_init.sql';
export async function migrate(pool: { query(t: string): Promise<unknown> }): Promise<string[]> {
  await pool.query(sql as string);
  return ['001_init.sql'];
}
