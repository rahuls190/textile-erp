import type { Pool, Db } from '../db/pool.js';
import { AppError, conflict } from './errors.js';

export interface Actor { id: string; username: string }
export interface Ctx { db: Db; actor: Actor; requestId: string; action: string }
export interface CommandResult<T> { result: T; replayed: boolean }

/**
 * One business command = one database transaction (blueprint §04/§05):
 * idempotency check → permission/state/balance checks → ledger changes → audit → outbox.
 * A repeated request_id returns the original committed result and changes nothing.
 */
export async function runCommand<T>(
  pool: Pool,
  meta: { requestId: string; actor: Actor; action: string },
  fn: (ctx: Ctx) => Promise<T>,
): Promise<CommandResult<T>> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const ins = await c.query(
      `INSERT INTO command_log(request_id, actor_id, action, result) VALUES ($1,$2,$3,'null')
       ON CONFLICT (request_id) DO NOTHING RETURNING request_id`,
      [meta.requestId, meta.actor.id, meta.action],
    );
    if (ins.rowCount === 0) {
      const prev = (await c.query('SELECT result, action, actor_id FROM command_log WHERE request_id=$1', [meta.requestId])).rows[0];
      await c.query('COMMIT');
      if (prev.action !== meta.action || prev.actor_id !== meta.actor.id)
        throw conflict('REQUEST_ID_REUSED', 'This request_id was already used for a different command');
      return { result: prev.result as T, replayed: true };
    }
    const result = await fn({ db: c, actor: meta.actor, requestId: meta.requestId, action: meta.action });
    await c.query('UPDATE command_log SET result=$2 WHERE request_id=$1', [meta.requestId, JSON.stringify(result ?? null)]);
    await c.query('COMMIT');
    return { result, replayed: false };
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch { /* connection already gone */ }
    if (e instanceof AppError) throw e;
    // Postgres: raised by our triggers / constraints → surface as a clean 409/400
    const pgErr = e as { code?: string; message?: string; constraint?: string };
    if (pgErr.code === '23505') throw conflict('DUPLICATE', `Duplicate value${pgErr.constraint ? ` (${pgErr.constraint})` : ''}`);
    if (pgErr.code === '23514') throw new AppError(400, 'CONSTRAINT', pgErr.message ?? 'Constraint violated');
    throw e;
  } finally { c.release(); }
}
