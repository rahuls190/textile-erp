import type { Ctx } from '../core/command.js';
import type { Db } from '../db/pool.js';
import { badRequest } from '../core/errors.js';

export const PREF_OPTIONS = {
  theme: ['system', 'light', 'dark'],
  accent: ['kalyani', 'forest', 'ocean', 'rose', 'amber', 'slate'],
  layout: ['sidebar', 'topbar'],
  density: ['comfortable', 'compact'],
} as const;
export type Preferences = { [K in keyof typeof PREF_OPTIONS]: (typeof PREF_OPTIONS)[K][number] };
export const DEFAULT_PREFS: Preferences = { theme: 'light', accent: 'kalyani', layout: 'sidebar', density: 'comfortable' };

/** Anyone can read and change only their own settings; unknown or invalid values are ignored on read and refused on write. */
export async function getPreferences(db: Db, userId: string): Promise<Preferences> {
  const raw = (await db.query('SELECT preferences FROM app_user WHERE id=$1', [userId])).rows[0]?.preferences ?? {};
  const out: Record<string, string> = { ...DEFAULT_PREFS };
  for (const k of Object.keys(PREF_OPTIONS) as (keyof Preferences)[]) if ((PREF_OPTIONS[k] as readonly string[]).includes(raw[k])) out[k] = raw[k];
  return out as Preferences;
}

export async function setPreferences(ctx: Ctx, input: Partial<Preferences> | { reset: true }) {
  const current = await getPreferences(ctx.db, ctx.actor.id);
  let next: Preferences = current;
  if ('reset' in input) next = { ...DEFAULT_PREFS };
  else {
    next = { ...current };
    for (const [k, v] of Object.entries(input)) {
      const allowed = PREF_OPTIONS[k as keyof Preferences] as readonly string[] | undefined;
      if (!allowed) throw badRequest(`Unknown setting: ${k}`);
      if (!allowed.includes(v as string)) throw badRequest(`${k} must be one of: ${allowed.join(', ')}`);
      (next as Record<string, string>)[k] = v as string;
    }
  }
  await ctx.db.query('UPDATE app_user SET preferences=$2::jsonb WHERE id=$1', [ctx.actor.id, JSON.stringify(next)]);
  return next;
}
