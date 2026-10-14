import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { Pool } from '../db/pool.js';
import { unauthorized } from './errors.js';
import type { Actor } from './command.js';

const scryptAsync = (pw: string, salt: Buffer) =>
  new Promise<Buffer>((res, rej) => scrypt(pw, salt, 64, (e, k) => (e ? rej(e) : res(k))));

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${(await scryptAsync(pw, salt)).toString('hex')}`;
}
export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [, saltHex, hashHex] = stored.split('$');
  const expected = Buffer.from(hashHex, 'hex');
  const got = await scryptAsync(pw, Buffer.from(saltHex, 'hex'));
  return expected.length === got.length && timingSafeEqual(expected, got);
}

export async function login(pool: Pool, username: string, password: string): Promise<{ token: string; actor: Actor }> {
  const u = (await pool.query('SELECT id, username, password_hash, active FROM app_user WHERE username=$1', [username])).rows[0];
  // Always run a hash comparison so unknown users and wrong passwords look alike
  const ok = u ? await verifyPassword(password, u.password_hash) : (await scryptAsync(password, Buffer.alloc(16)), false);
  if (!u || !u.active || !ok) throw unauthorized('Invalid username or password');
  const token = randomBytes(32).toString('base64url');
  await pool.query(`INSERT INTO session(token, user_id, expires_at) VALUES ($1,$2, now() + interval '12 hours')`, [token, u.id]);
  return { token, actor: { id: u.id, username: u.username } };
}

export async function actorFromToken(pool: Pool, token: string | undefined): Promise<Actor> {
  if (!token) throw unauthorized();
  const r = (await pool.query(
    `SELECT u.id, u.username FROM session s JOIN app_user u ON u.id = s.user_id
      WHERE s.token=$1 AND s.expires_at > now() AND u.active`, [token])).rows[0];
  if (!r) throw unauthorized('Session expired or invalid');
  return { id: r.id, username: r.username };
}
