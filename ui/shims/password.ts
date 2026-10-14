// Browser stand-in for src/core/password.ts: same interface, PBKDF2 via WebCrypto instead of node scrypt.
const enc = new TextEncoder();
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16));
async function derive(pw: string, salt: Uint8Array) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: 30000 }, key, 256));
}
export async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${hex(salt)}$${hex(await derive(pw, salt))}`;
}
export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [, s, h] = stored.split('$');
  return hex(await derive(pw, unhex(s))) === h;
}
export async function burnTime(pw: string): Promise<void> { await derive(pw, new Uint8Array(16)); }
