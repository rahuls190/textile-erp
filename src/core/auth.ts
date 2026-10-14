import type { Pool, Db } from '../db/pool.js';
import { unauthorized, badRequest, AppError } from './errors.js';
import type { Actor } from './command.js';
import { hashPassword, verifyPassword, burnTime } from './password.js';

export { hashPassword } from './password.js';

export const MAX_FAILED_ATTEMPTS = 5;
export const LOCK_MINUTES = 15;
export const MIN_PASSWORD = 10;

const TOKEN_SQL = `replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')`;

export function checkPasswordStrength(pw: string): void {
  if (pw.length < MIN_PASSWORD) throw badRequest(`Password must be at least ${MIN_PASSWORD} characters`);
  if (!/[a-z]/i.test(pw) || !/\d/.test(pw)) throw badRequest('Password must contain letters and at least one digit');
}

async function logEvent(pool: Pool | Db, username: string, userId: string | null, ok: boolean, reason?: string) {
  await pool.query('INSERT INTO login_event(username, user_id, ok, reason) VALUES ($1,$2,$3,$4)', [username, userId, ok, reason ?? null]);
}

export interface LoginResult { token: string; actor: Actor; mustChangePassword: boolean }

export async function login(pool: Pool, username: string, password: string): Promise<LoginResult> {
  const u = (await pool.query(
    `SELECT id, username, password_hash, active, failed_attempts, must_change_password,
            (locked_until IS NOT NULL AND locked_until > now()) AS locked
       FROM app_user WHERE username=$1`, [username])).rows[0];
  if (!u) { await burnTime(password); await logEvent(pool, username, null, false, 'unknown user'); throw unauthorized('Invalid username or password'); }
  if (u.locked) {
    await logEvent(pool, username, u.id, false, 'locked');
    throw new AppError(423, 'ACCOUNT_LOCKED', `Too many failed attempts. Try again in ${LOCK_MINUTES} minutes, or ask an administrator to unlock the account.`);
  }
  const ok = await verifyPassword(password, u.password_hash);
  if (!u.active) { await logEvent(pool, username, u.id, false, 'suspended'); throw unauthorized('Invalid username or password'); }
  if (!ok) {
    const n = u.failed_attempts + 1;
    await pool.query(
      `UPDATE app_user SET failed_attempts=$2::int, locked_until = CASE WHEN $2::int >= $3::int THEN now() + ($4::text || ' minutes')::interval ELSE locked_until END WHERE id=$1`,
      [u.id, n, MAX_FAILED_ATTEMPTS, String(LOCK_MINUTES)]);
    await logEvent(pool, username, u.id, false, n >= MAX_FAILED_ATTEMPTS ? 'wrong password; locked' : 'wrong password');
    throw unauthorized('Invalid username or password');
  }
  await pool.query('UPDATE app_user SET failed_attempts=0, locked_until=NULL, last_login_at=now() WHERE id=$1', [u.id]);
  const tok = (await pool.query(
    `INSERT INTO session(token, user_id, expires_at) VALUES (${TOKEN_SQL}, $1, now() + interval '12 hours') RETURNING token`, [u.id])).rows[0].token as string;
  await logEvent(pool, username, u.id, true);
  return { token: tok, actor: { id: u.id, username: u.username }, mustChangePassword: u.must_change_password };
}

export async function actorFromToken(pool: Pool, token: string | undefined): Promise<Actor> {
  if (!token) throw unauthorized();
  const r = (await pool.query(
    `SELECT u.id, u.username FROM session s JOIN app_user u ON u.id = s.user_id
      WHERE s.token=$1 AND s.expires_at > now() AND u.active`, [token])).rows[0];
  if (!r) throw unauthorized('Session expired or invalid');
  return { id: r.id, username: r.username };
}

export async function logout(pool: Pool, token: string): Promise<void> { await pool.query('DELETE FROM session WHERE token=$1', [token]); }

/** Self-service password change: needs the current password, ends every other session. */
export async function changeOwnPassword(db: Db, userId: string, current: string, next: string, keepToken?: string): Promise<void> {
  const u = (await db.query('SELECT password_hash FROM app_user WHERE id=$1', [userId])).rows[0];
  if (!u || !(await verifyPassword(current, u.password_hash))) throw unauthorized('Current password is wrong');
  checkPasswordStrength(next);
  if (current === next) throw badRequest('Choose a password different from the current one');
  await db.query('UPDATE app_user SET password_hash=$2, must_change_password=false, password_changed_at=now() WHERE id=$1', [userId, await hashPassword(next)]);
  await db.query('DELETE FROM session WHERE user_id=$1 AND token <> COALESCE($2, \'\')', [userId, keepToken ?? null]);
}
