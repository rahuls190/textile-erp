// Exact decimal helpers (4 dp, matching NUMERIC(18,4)). No floating point anywhere near stock or money.
const SCALE = 4;
export function toScaled(v: string | number): bigint {
  const s = typeof v === 'number' ? v.toFixed(SCALE) : v.trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new Error(`Invalid decimal: ${v}`);
  const neg = s.startsWith('-');
  const [i, f = ''] = s.replace('-', '').split('.');
  const frac = (f + '0'.repeat(SCALE)).slice(0, SCALE);
  if (f.length > SCALE && /[1-9]/.test(f.slice(SCALE))) throw new Error(`Too many decimals: ${v}`);
  const n = BigInt(i) * 10n ** BigInt(SCALE) + BigInt(frac);
  return neg ? -n : n;
}
export function fromScaled(n: bigint): string {
  const neg = n < 0n; const a = neg ? -n : n;
  const i = a / 10n ** BigInt(SCALE); const f = (a % 10n ** BigInt(SCALE)).toString().padStart(SCALE, '0');
  return `${neg ? '-' : ''}${i}.${f}`;
}
export const qAdd = (a: string, b: string) => fromScaled(toScaled(a) + toScaled(b));
export const qSub = (a: string, b: string) => fromScaled(toScaled(a) - toScaled(b));
export const qGt = (a: string, b: string) => toScaled(a) > toScaled(b);
export const qLt = (a: string, b: string) => toScaled(a) < toScaled(b);
export const qEq = (a: string, b: string) => toScaled(a) === toScaled(b);
// qty × rate → money with 2 dp, half-up
export function lineAmount(qty: string, rate: string): string {
  const p = toScaled(qty) * toScaled(rate); // scale 8
  const cents = (p + 500000n) / 1000000n;   // scale 8 → scale 2, half-up (amounts here are non-negative)
  return fromScaled(cents * 100n).slice(0, -2);
}

/** Canonical 4-dp string for any decimal (so "0" and "0.0000" never differ at an API boundary). */
export const norm = (v: string | number) => fromScaled(toScaled(v));
