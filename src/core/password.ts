import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

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
/** A comparison against a throwaway hash so unknown usernames cost the same as wrong passwords. */
export async function burnTime(pw: string): Promise<void> { await scryptAsync(pw, Buffer.alloc(16)); }
